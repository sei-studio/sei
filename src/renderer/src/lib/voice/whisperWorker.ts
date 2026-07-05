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
 *   in:  { type: 'init' }                         → { type: 'ready' } | { type: 'init-error', message }
 *   in:  { type: 'transcribe', id, audio }        → { type: 'transcript', id, text }
 *        (audio: Float32Array, 16kHz mono)          errors → { type: 'transcript', id, text: '' }
 */

import { pipeline } from '@huggingface/transformers';

const MODEL = 'onnx-community/whisper-tiny.en';

type Asr = (audio: Float32Array) => Promise<{ text: string } | Array<{ text: string }>>;

let asr: Asr | null = null;

async function init(): Promise<void> {
  // WASM on purpose, NOT webgpu: verified live (260705, Electron 37) that
  // webgpu + q8 loads and runs but emits garbage tokens (the known
  // transformers.js webgpu quantization corruption), while wasm + q8
  // transcribes correctly. tiny.en on wasm is fast enough for utterance-sized
  // clips; revisit webgpu with fp32/fp16 dtypes if latency ever matters more.
  asr = (await pipeline('automatic-speech-recognition', MODEL, {
    device: 'wasm',
    dtype: 'q8',
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
