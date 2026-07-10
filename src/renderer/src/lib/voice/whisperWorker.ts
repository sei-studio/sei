/**
 * Whisper STT worker (260705) — dictation transcription off the UI thread.
 *
 * Loads a small open-source Whisper model (Apache-2.0) via transformers.js:
 * fully local inference (WebGPU when available, WASM otherwise), no audio
 * ever leaves the machine. The model downloads from the Hugging Face hub on
 * first use and is cached by the browser Cache API, so later calls start
 * offline-fast.
 *
 * Conversation language (260709): English keeps the tuned English-only build
 * (whisper-tiny.en, ~40MB — zero change for existing users). Any other
 * conversation language loads the MULTILINGUAL whisper-base (~80MB q8)
 * instead — tiny's multilingual variant is too weak on zh/ja/ko to hold a
 * live call — and pins the decode language, since auto-detect on 1-3s VAD
 * utterances is unreliable.
 *
 * Protocol (postMessage):
 *   in:  { type: 'init', language? }               → { type: 'progress', pct }* then
 *                                                    { type: 'ready' } | { type: 'init-error', message }
 *   in:  { type: 'transcribe', id, audio }         → { type: 'transcript', id, text }
 *        (audio: Float32Array, 16kHz mono)           errors → { type: 'transcript', id, text: '' }
 */

import { pipeline, env } from '@huggingface/transformers';

const MODEL_EN = 'onnx-community/whisper-tiny.en';
const MODEL_MULTILINGUAL = 'onnx-community/whisper-base';

/** Whisper decode-language pin. Codes mirror src/shared/chatLanguage.ts (a
 * worker cannot import main/shared modules across the bundle boundary,
 * keep in sync). */
const KNOWN_LANGUAGES = new Set(['en', 'zh', 'ja', 'ko', 'fr', 'es']);

// Multi-threaded WASM when SharedArrayBuffer is available (main enables the
// Chromium feature flag — see src/main/index.ts). Cuts utterance
// transcription time by roughly the thread count; falls back to 1 thread
// (the old behavior) when SAB is absent (older builds / flag removed).
try {
  if (typeof SharedArrayBuffer !== 'undefined' && env?.backends?.onnx?.wasm) {
    env.backends.onnx.wasm.numThreads = Math.min(
      4,
      Math.max(1, navigator.hardwareConcurrency || 1),
    );
  }
} catch {
  /* env shape changed — single-threaded is still correct */
}

type AsrOptions = { language?: string; task?: 'transcribe' };
type Asr = (
  audio: Float32Array,
  options?: AsrOptions,
) => Promise<{ text: string } | Array<{ text: string }>>;

let asr: Asr | null = null;
/** Decode options for the loaded model: {} for tiny.en (its tokenizer has no
 * language tokens), a language pin for the multilingual model. */
let asrOptions: AsrOptions = {};

async function init(language: string): Promise<void> {
  const multilingual = language !== 'en';
  const model = multilingual ? MODEL_MULTILINGUAL : MODEL_EN;
  asrOptions = multilingual ? { language, task: 'transcribe' } : {};

  // Aggregate download progress across the model's files so the UI can show a
  // real percentage during the first-run fetch (after that the browser
  // cache makes this instant). transformers.js fires progress_callback per
  // file with { status: 'progress', file, loaded, total }.
  const files = new Map<string, { loaded: number; total: number }>();
  // Only weight-class files (the .onnx blobs) count toward the percentage.
  // The KB-sized JSON configs download first and complete instantly; when they
  // were included, the aggregate hit ~100% before any real weight file had
  // registered, and the monotonic clamp below then pinned the bar at 99% for
  // the entire multi-MB download (the "jumps to 99% and sits there" bug,
  // 260709). The encoder/decoder onnx sessions are fetched concurrently
  // (Promise.all inside transformers.js), so both totals register within the
  // first moments of the real download and the ratio stays honest.
  const WEIGHT_FILE_MIN_BYTES = 1_000_000;
  // Reported percentage is clamped monotonic: `total` can still grow if a
  // weight file registers late (its full size lands before its bytes do),
  // which would let the raw ratio jump backward (e.g. 88% → 40%) and read as
  // a stall. Never report a lower number than we already have.
  let lastPct = 0;
  const reportProgress = (info: { status?: string; file?: string; loaded?: number; total?: number }): void => {
    if (info.status !== 'progress' || !info.file || !info.total) return;
    if (info.total < WEIGHT_FILE_MIN_BYTES) return;
    files.set(info.file, { loaded: info.loaded ?? 0, total: info.total });
    let loaded = 0;
    let total = 0;
    for (const f of files.values()) {
      loaded += f.loaded;
      total += f.total;
    }
    if (total > 0) {
      const pct = Math.round((100 * loaded) / total);
      if (pct > lastPct) lastPct = pct;
      self.postMessage({ type: 'progress', pct: lastPct });
    }
  };

  // WASM on purpose, NOT webgpu: verified live (260705, Electron 37) that
  // webgpu + q8 loads and runs but emits garbage tokens (the known
  // transformers.js webgpu quantization corruption), while wasm + q8
  // transcribes correctly. tiny.en/base on wasm are fast enough for
  // utterance-sized clips; revisit webgpu with fp32/fp16 dtypes if latency
  // ever matters more.
  asr = (await pipeline('automatic-speech-recognition', model, {
    device: 'wasm',
    dtype: 'q8',
    progress_callback: reportProgress,
  })) as unknown as Asr;
}

/**
 * Whisper hallucinates fillers on silence/noise; drop the well-known ones.
 * The non-English entries are Whisper's notorious dataset-watermark
 * hallucinations (video-outro phrases and subtitle credits it emits on
 * silence in that decode language) — without them, quiet stretches on a call
 * produce phantom turns.
 */
const NOISE_TRANSCRIPTS = new Set([
  // English
  '', 'you', 'thank you.', 'thanks for watching!', 'thank you for watching!',
  '.', 'bye.', 'so', 'the',
  // Chinese
  '谢谢观看', '谢谢大家', '谢谢', '字幕由amara.org社区提供', '请订阅',
  // Japanese
  'ご視聴ありがとうございました', 'ありがとうございました', 'おやすみなさい',
  'ん', 'チャンネル登録をお願いします',
  // Korean
  '시청해주셔서 감사합니다', '감사합니다', '구독과 좋아요 부탁드립니다',
  // French
  'merci', "merci d'avoir regardé", "sous-titres réalisés par la communauté d'amara.org",
  'à bientôt',
  // Spanish
  'gracias', 'gracias por ver el video', 'subtítulos realizados por la comunidad de amara.org',
  '¡gracias!',
]);

function cleanTranscript(raw: string): string {
  // Whisper annotates non-speech as bracketed/parenthesized tags — observed
  // live: keyboard sounds → "[clicking]". Strip every such group; if nothing
  // spoken remains, the utterance was noise, not words.
  const text = raw
    .replace(/\[[^\]]*\]|\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const norm = text.toLowerCase();
  // CJK output ends in full-width punctuation ("谢谢观看。") — compare with the
  // trailing punctuation stripped too, so the noise list stays short.
  const bare = norm.replace(/[.。．!！?？、,，\s]+$/u, '');
  return NOISE_TRANSCRIPTS.has(norm) || NOISE_TRANSCRIPTS.has(bare) ? '' : text;
}

self.onmessage = (e: MessageEvent) => {
  const msg = e.data as { type: string; id?: number; audio?: Float32Array; language?: string };
  if (msg.type === 'init') {
    const language =
      typeof msg.language === 'string' && KNOWN_LANGUAGES.has(msg.language) ? msg.language : 'en';
    void init(language)
      .then(() => self.postMessage({ type: 'ready' }))
      .catch((err: unknown) =>
        self.postMessage({ type: 'init-error', message: (err as Error)?.message ?? String(err) }),
      );
    return;
  }
  if (msg.type === 'transcribe' && msg.audio && typeof msg.id === 'number') {
    const id = msg.id;
    if (!asr) {
      self.postMessage({ type: 'transcript', id, text: '' });
      return;
    }
    void asr(msg.audio, asrOptions)
      .then((out) => {
        const text = Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text;
        self.postMessage({ type: 'transcript', id, text: cleanTranscript(text ?? '') });
      })
      .catch(() => self.postMessage({ type: 'transcript', id, text: '' }));
  }
};
