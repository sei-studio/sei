/**
 * Whisper STT worker (260705) â€” dictation transcription off the UI thread.
 *
 * Loads a small open-source Whisper model (Apache-2.0) via transformers.js:
 * fully local inference (WebGPU when available, WASM otherwise), no audio
 * ever leaves the machine. The model downloads from the Hugging Face hub on
 * first use and is cached by the browser Cache API, so later calls start
 * offline-fast.
 *
 * Conversation language (260709): English keeps the tuned English-only build
 * (whisper-tiny.en, ~40MB â€” zero change for existing users). Any other
 * conversation language loads the MULTILINGUAL whisper-base (~80MB q8)
 * instead â€” tiny's multilingual variant is too weak on zh/ja/ko to hold a
 * live call â€” and pins the decode language, since auto-detect on 1-3s VAD
 * utterances is unreliable.
 *
 * Protocol (postMessage):
 *   in:  { type: 'init', language? }               â†’ { type: 'progress', pct }* then
 *                                                    { type: 'ready' } | { type: 'init-error', message }
 *   in:  { type: 'transcribe', id, audio }         â†’ { type: 'transcript', id, text }
 *        (audio: Float32Array, 16kHz mono)           errors â†’ { type: 'transcript', id, text: '' }
 */

import { pipeline, env } from '@huggingface/transformers';

const MODEL_EN = 'onnx-community/whisper-tiny.en';
const MODEL_MULTILINGUAL = 'onnx-community/whisper-base';

/** Whisper decode-language pin. Codes mirror src/shared/chatLanguage.ts (a
 * worker cannot import main/shared modules across the bundle boundary,
 * keep in sync). */
const KNOWN_LANGUAGES = new Set(['en', 'zh', 'ja', 'ko', 'fr', 'es', 'ru', 'pt', 'it']);

// Multi-threaded WASM when SharedArrayBuffer is available (main enables the
// Chromium feature flag â€” see src/main/index.ts). Cuts utterance
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
  /* env shape changed â€” single-threaded is still correct */
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

/**
 * Model download hosts, tried in order (260816, china-compat). Hugging Face
 * is hard-blocked in mainland China, so the same q8 file set is mirrored at
 * dl.sei.gg/hf in transformers.js's own {model}/resolve/{revision} layout
 * (scripts/mirror-assets.mjs) and callers pass mirrorFirst=true when the
 * region check says HF is unreachable. Once files are in the browser Cache
 * API the host never matters again.
 */
const HOST_HF = 'https://huggingface.co';
const HOST_MIRROR = 'https://dl.sei.gg/hf';

async function init(language: string, mirrorFirst: boolean): Promise<void> {
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
  // which would let the raw ratio jump backward (e.g. 88% â†’ 40%) and read as
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
  const hosts = mirrorFirst ? [HOST_MIRROR, HOST_HF] : [HOST_HF, HOST_MIRROR];
  let lastErr: unknown = null;
  for (const host of hosts) {
    env.remoteHost = host;
    try {
      asr = (await pipeline('automatic-speech-recognition', model, {
        device: 'wasm',
        dtype: 'q8',
        progress_callback: reportProgress,
      })) as unknown as Asr;
      return;
    } catch (err) {
      lastErr = err;
      // Reset the aggregate so the second host's progress starts honest.
      files.clear();
      lastPct = 0;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Whisper hallucinates fillers on silence/noise; drop the well-known ones.
 * The non-English entries are Whisper's notorious dataset-watermark
 * hallucinations (video-outro phrases and subtitle credits it emits on
 * silence in that decode language) â€” without them, quiet stretches on a call
 * produce phantom turns.
 */
const NOISE_TRANSCRIPTS = new Set([
  // English
  '', 'you', 'thank you.', 'thanks for watching!', 'thank you for watching!',
  '.', 'bye.', 'so', 'the',
  // Chinese
  'è°¢è°¢è§‚çœ‹', 'è°¢è°¢å¤§å®¶', 'è°¢è°¢', 'å­—å¹•ç”±amara.orgç¤¾åŒºæä¾›', 'è¯·è®¢é˜…',
  // Japanese
  'ã”è¦–è´ã‚ã‚ŠãŒã¨ã†ã”ã–ã„ã¾ã—ãŸ', 'ã‚ã‚ŠãŒã¨ã†ã”ã–ã„ã¾ã—ãŸ', 'ãŠã‚„ã™ã¿ãªã•ã„',
  'ã‚“', 'ãƒãƒ£ãƒ³ãƒãƒ«ç™»éŒ²ã‚’ãŠé¡˜ã„ã—ã¾ã™',
  // Korean
  'ì‹œì²­í•´ì£¼ì…”ì„œ ê°ì‚¬í•©ë‹ˆë‹¤', 'ê°ì‚¬í•©ë‹ˆë‹¤', 'êµ¬ë…ê³¼ ì¢‹ì•„ìš” ë¶€íƒë“œë¦½ë‹ˆë‹¤',
  // French
  'merci', "merci d'avoir regardÃ©", "sous-titres rÃ©alisÃ©s par la communautÃ© d'amara.org",
  'Ã  bientÃ´t',
  // Spanish
  'gracias', 'gracias por ver el video', 'subtÃ­tulos realizados por la comunidad de amara.org',
  'Â¡gracias!',
  // Russian, Portuguese, Italian (261116)
  'ÑÐ¿Ð°ÑÐ¸Ð±Ð¾', 'ÑÐ¿Ð°ÑÐ¸Ð±Ð¾ Ð·Ð° Ð¿Ñ€Ð¾ÑÐ¼Ð¾Ñ‚Ñ€', 'Ð¿Ñ€Ð¾Ð´Ð¾Ð»Ð¶ÐµÐ½Ð¸Ðµ ÑÐ»ÐµÐ´ÑƒÐµÑ‚...', 'ÑÑƒÐ±Ñ‚Ð¸Ñ‚Ñ€Ñ‹ ÑÐ´ÐµÐ»Ð°Ð» dimatorzok',
  'obrigado', 'obrigado por assistir', 'legendas pela comunidade amara.org',
  'grazie', 'grazie per la visione', 'sottotitoli creati dalla comunitÃ  amara.org',
]);

function cleanTranscript(raw: string): string {
  // Whisper annotates non-speech as bracketed/parenthesized tags â€” observed
  // live: keyboard sounds â†’ "[clicking]". Strip every such group; if nothing
  // spoken remains, the utterance was noise, not words.
  const text = raw
    .replace(/\[[^\]]*\]|\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const norm = text.toLowerCase();
  // CJK output ends in full-width punctuation ("è°¢è°¢è§‚çœ‹ã€‚") â€” compare with the
  // trailing punctuation stripped too, so the noise list stays short.
  const bare = norm.replace(/[.ã€‚ï¼Ž!ï¼?ï¼Ÿã€,ï¼Œ\s]+$/u, '');
  return NOISE_TRANSCRIPTS.has(norm) || NOISE_TRANSCRIPTS.has(bare) ? '' : text;
}

self.onmessage = (e: MessageEvent) => {
  const msg = e.data as {
    type: string;
    id?: number;
    audio?: Float32Array;
    language?: string;
    mirrorFirst?: boolean;
  };
  if (msg.type === 'init') {
    const language =
      typeof msg.language === 'string' && KNOWN_LANGUAGES.has(msg.language) ? msg.language : 'en';
    void init(language, msg.mirrorFirst === true)
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




