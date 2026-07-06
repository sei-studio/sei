/**
 * Whisper STT worker (260705) — dictation transcription off the UI thread.
 *
 * Loads a small open-source Whisper model (whisper-tiny.en, Apache-2.0) via
 * transformers.js: fully local inference (WebGPU when available, WASM
 * otherwise), no audio ever leaves the machine. The model (~40MB quantized)
 * downloads from the Hugging Face hub on first use and is cached by the
 * browser Cache API, so later calls start offline-fast.
 *
 * Protocol (postMessage):
 *   in:  { type: 'init' }                         → { type: 'progress', pct }* then
 *                                                   { type: 'ready' } | { type: 'init-error', message }
 *   in:  { type: 'transcribe', id, audio }        → { type: 'transcript', id, text }
 *        (audio: Float32Array, 16kHz mono)          errors → { type: 'transcript', id, text: '' }
 */

import { pipeline, env } from '@huggingface/transformers';

const MODEL = 'onnx-community/whisper-tiny.en';

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

type Asr = (audio: Float32Array) => Promise<{ text: string } | Array<{ text: string }>>;

let asr: Asr | null = null;

async function init(): Promise<void> {
  // Aggregate download progress across the model's files so the UI can show a
  // real percentage during the ~40MB first-run fetch (after that the browser
  // cache makes this instant). transformers.js fires progress_callback per
  // file with { status: 'progress', file, loaded, total }.
  const files = new Map<string, { loaded: number; total: number }>();
  const reportProgress = (info: { status?: string; file?: string; loaded?: number; total?: number }): void => {
    if (info.status !== 'progress' || !info.file || !info.total) return;
    files.set(info.file, { loaded: info.loaded ?? 0, total: info.total });
    let loaded = 0;
    let total = 0;
    for (const f of files.values()) {
      loaded += f.loaded;
      total += f.total;
    }
    if (total > 0) self.postMessage({ type: 'progress', pct: Math.round((100 * loaded) / total) });
  };

  // WASM on purpose, NOT webgpu: verified live (260705, Electron 37) that
  // webgpu + q8 loads and runs but emits garbage tokens (the known
  // transformers.js webgpu quantization corruption), while wasm + q8
  // transcribes correctly. tiny.en on wasm is fast enough for utterance-sized
  // clips; revisit webgpu with fp32/fp16 dtypes if latency ever matters more.
  asr = (await pipeline('automatic-speech-recognition', MODEL, {
    device: 'wasm',
    dtype: 'q8',
    progress_callback: reportProgress,
  })) as unknown as Asr;
}

/** Whisper hallucinates fillers on silence/noise; drop the well-known ones. */
const NOISE_TRANSCRIPTS = new Set([
  '', 'you', 'thank you.', 'thanks for watching!', 'thank you for watching!',
  '.', 'bye.', 'so', 'the',
]);

function cleanTranscript(raw: string): string {
  // Whisper annotates non-speech as bracketed/parenthesized tags — observed
  // live: keyboard sounds → "[clicking]". Strip every such group; if nothing
  // spoken remains, the utterance was noise, not words.
  const text = raw
    .replace(/\[[^\]]*\]|\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return NOISE_TRANSCRIPTS.has(text.toLowerCase()) ? '' : text;
}

self.onmessage = (e: MessageEvent) => {
  const msg = e.data as { type: string; id?: number; audio?: Float32Array };
  if (msg.type === 'init') {
    void init()
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
    void asr(msg.audio)
      .then((out) => {
        const text = Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text;
        self.postMessage({ type: 'transcript', id, text: cleanTranscript(text ?? '') });
      })
      .catch(() => self.postMessage({ type: 'transcript', id, text: '' }));
  }
};
