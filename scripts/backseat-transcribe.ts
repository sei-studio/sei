/**
 * Offline STT for the render script (260801).
 *
 * Runs the SAME model the app packages (onnx-community/whisper-tiny.en, see
 * src/renderer/src/lib/voice/whisperWorker.ts) over the 16 kHz mono PCM that
 * scripts/backseat-sim.ts already extracted into <out>/prep/audio.f32, and
 * writes timestamped chunks to <out>/transcript.json.
 *
 * This is for the review video only. The sim run itself did not feed a
 * transcript to the model, so the panel that displays this is labelled as
 * offline.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const OUT = path.resolve(positional[0] ?? '.backseat-sim/valorant-clips');
const DEST = path.join(OUT, 'transcript.json');

/**
 * whisper-tiny loops on gunfire: one 6 s window came back as "I'm coming"
 * repeated 110 times. Collapse any phrase that repeats back to back.
 */
function collapse(text: string): string {
  const words = text.split(/\s+/);
  const out: string[] = [];
  for (const w of words) {
    for (let n = 1; n <= 6; n++) {
      if (out.length < n * 2) continue;
      const a = out.slice(-n).join(' ').toLowerCase();
      const b = out.slice(-n * 2, -n).join(' ').toLowerCase();
      if (a === b) out.splice(-n);
    }
    out.push(w);
  }
  return out.join(' ');
}

async function main(): Promise<void> {
  if (existsSync(DEST) && !process.argv.includes('--force')) {
    console.log(`[stt] ${DEST} exists, nothing to do (pass --force to redo)`);
    return;
  }
  const buf = readFileSync(path.join(OUT, 'prep', 'audio.f32'));
  const pcm = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
  console.log(`[stt] ${(pcm.length / 16000).toFixed(1)}s of audio`);

  const { pipeline } = await import('@huggingface/transformers');
  const asr = await pipeline('automatic-speech-recognition', 'onnx-community/whisper-tiny.en', {
    dtype: 'q8',
  });

  // Two things did not work and are worth recording so nobody retries them:
  // handing the pipeline the whole 187 s array with chunk_length_s came back
  // with empty text, and `return_timestamps: true` came back with an empty
  // `chunks` array on every window. So the windowing is done here and the
  // window IS the timestamp, which is also closer to what the app does: it
  // transcribes short segments off a ring rather than a whole file.
  const RATE = 16_000;
  const WIN = 6;
  const chunks: Array<{ from: number; to: number; text: string }> = [];
  for (let start = 0; start * RATE < pcm.length; start += WIN) {
    const seg = pcm.subarray(start * RATE, (start + WIN) * RATE);
    if (seg.length < RATE) break;
    const res = (await asr(seg)) as { text: string };
    const text = collapse(res.text.trim());
    // whisper-tiny writes these over game audio with no speech in it.
    const junk = !text || /^[\[\(]|^you$|^thanks? for watching/i.test(text);
    if (!junk) chunks.push({ from: start * 1000, to: (start + WIN) * 1000, text });
    console.log(`[stt] ${String(start).padStart(3)}s  ${junk ? '-' : text}`);
  }
  writeFileSync(
    DEST,
    JSON.stringify({ text: chunks.map((c) => c.text).join(' '), chunks }, null, 1),
  );
  console.log(`[stt] ${chunks.length} chunks -> ${DEST}`);
  for (const c of chunks.slice(0, 12)) console.log(`  ${(c.from / 1000).toFixed(1)}s  ${c.text}`);
}

void main();
