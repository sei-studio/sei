/**
 * Backseat streaming STT (260728) — the glue between the normalized PCM feed
 * and the transcript ring.
 *
 * Reuses the EXACT Whisper worker voice calls ship (voice/whisperWorker.ts):
 * same model, same browser-cache download, same noise-hallucination filter. If
 * the player has ever made a voice call, the model is already on disk and this
 * costs nothing to start; if not, the first backseat session downloads ~40MB
 * once, in the background, and transcripts simply begin when it is ready —
 * a session is fully functional (video + gain) before and without STT.
 *
 * Policy lives in transcriptRing.ts (tested); this file owns the worker, the
 * accumulation buffer, and the clocks:
 *
 *   push()            accumulate 16 kHz mono PCM. When a full STT_CHUNK_MS is
 *                     pending and the worker is idle, transcribe it. Chunks
 *                     whose energy sits at the noise floor skip the worker
 *                     entirely — most game audio without speech costs nothing.
 *   tickTranscript()  what a tick calls: flush the in-progress tail through
 *                     Whisper (bounded by STT_FLUSH_WAIT_MS, the spec's "wait
 *                     a few milliseconds for the stt to catch up"), then
 *                     return the window's text.
 */

import {
  STT_CHUNK_MS,
  STT_FLUSH_WAIT_MS,
  STT_MIN_FLUSH_MS,
  STT_SAMPLE_RATE,
  TICK_TRANSCRIPT_MAX_CHARS,
  TICK_TRANSCRIPT_MS,
  TRANSCRIPT_KEEP_MS,
} from '../../../../shared/backseatIpc';
import { rmsDb } from './pcm';
import {
  pushSegment,
  wantDispatch,
  windowText,
  type TranscriptSegment,
} from './transcriptRing';

/** Below this the chunk is treated as silence and never reaches the worker.
 *  Well under quiet dialogue (~-40 dBFS) but above the -100 floor, so muted
 *  and near-muted games skip Whisper entirely. */
const ENERGY_FLOOR_DB = -60;

/** Accumulation cap while the model is still downloading: keep only the most
 *  recent audio, because transcribing minutes-old sound when the model lands
 *  would backfill segments no tick will ever read. */
const MAX_PENDING_MS = 10_000;

export interface SttStream {
  /** Feed normalized PCM: mono Float32 at STT_SAMPLE_RATE. */
  push(pcm: Float32Array): void;
  /** Bounded flush, then the transcript window a tick should carry.
   *  Resolves '' when there is no audio, no speech, or no model yet. */
  tickTranscript(): Promise<string>;
  stop(): void;
}

export function createSttStream(opts: { language?: string } = {}): SttStream {
  const segments: TranscriptSegment[] = [];

  let worker: Worker | null = null;
  let ready = false;
  let dead = false;
  let nextId = 1;
  const waiters = new Map<number, (text: string) => void>();

  try {
    worker = new Worker(new URL('../voice/whisperWorker.ts', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data as { type: string; id?: number; text?: string; message?: string };
      if (msg.type === 'ready') {
        ready = true;
        return;
      }
      if (msg.type === 'init-error') {
        // No model, no transcripts — the session stays fully functional.
        console.warn(`[sei] backseat stt unavailable: ${msg.message}`);
        dead = true;
        worker?.terminate();
        worker = null;
        return;
      }
      if (msg.type === 'transcript' && typeof msg.id === 'number') {
        waiters.get(msg.id)?.(msg.text ?? '');
        waiters.delete(msg.id);
      }
    };
    worker.postMessage({ type: 'init', language: opts.language ?? 'en' });
  } catch {
    dead = true;
    worker = null;
  }

  /** Accumulated PCM since the last dispatch, plus when its audio began. */
  let pending: Float32Array[] = [];
  let pendingSamples = 0;
  let pendingStartedAt = 0;
  let busy = false;
  /** A flush arrived while a job was in flight: transcribe the tail too when
   *  it completes, before settling (all inside the tick's bounded wait). */
  let flushArmed = false;
  /** Resolvers waiting on the CURRENT dispatch (the flush path). */
  let settleWaiters: Array<() => void> = [];

  const pendingMs = (): number => (pendingSamples / STT_SAMPLE_RATE) * 1000;

  function settle(): void {
    const w = settleWaiters;
    settleWaiters = [];
    for (const resolve of w) resolve();
  }

  function dispatch(): void {
    const frames = pending;
    const samples = pendingSamples;
    const t0 = pendingStartedAt;
    const t1 = Date.now();
    pending = [];
    pendingSamples = 0;

    const audio = new Float32Array(samples);
    let off = 0;
    for (const f of frames) {
      audio.set(f, off);
      off += f.length;
    }

    // Silence never reaches the worker; the empty segment is simply not added.
    if (!worker || !ready || rmsDb(audio) < ENERGY_FLOOR_DB) {
      settle();
      return;
    }

    busy = true;
    const id = nextId++;
    const timeout = setTimeout(() => {
      // A wedged worker must not silence the rest of the session.
      if (waiters.delete(id)) {
        busy = false;
        settle();
      }
    }, 15_000);
    waiters.set(id, (text) => {
      clearTimeout(timeout);
      busy = false;
      if (text) pushSegment(segments, { t0, t1, text }, Date.now(), TRANSCRIPT_KEEP_MS);
      if (flushArmed) {
        // A tick is waiting on the tail that piled up behind this job.
        flushArmed = false;
        maybeDispatch(true);
        return;
      }
      settle();
      // Audio kept arriving while we transcribed; if a whole chunk piled up,
      // keep the pipeline hot rather than waiting for the next push().
      maybeDispatch(false);
    });
    worker.postMessage({ type: 'transcribe', id, audio }, [audio.buffer]);
  }

  function maybeDispatch(flush: boolean): void {
    if (dead) {
      pending = [];
      pendingSamples = 0;
      settle();
      return;
    }
    if (
      wantDispatch({
        pendingMs: pendingMs(),
        busy,
        flush,
        chunkMs: STT_CHUNK_MS,
        minFlushMs: STT_MIN_FLUSH_MS,
      })
    ) {
      dispatch();
    } else if (flush && busy) {
      // The in-flight job's completion will re-run the flush for the tail.
      flushArmed = true;
    } else if (flush) {
      // Nothing worth transcribing: the flush is already settled.
      settle();
    }
  }

  return {
    push(pcm: Float32Array): void {
      if (dead || !pcm.length) return;
      if (pendingSamples === 0) {
        // The chunk's audio ends now and began (chunk length) ago.
        pendingStartedAt = Date.now() - (pcm.length / STT_SAMPLE_RATE) * 1000;
      }
      pending.push(pcm);
      pendingSamples += pcm.length;
      // Model still downloading: retain only the tail (see MAX_PENDING_MS).
      while (pendingMs() > MAX_PENDING_MS && pending.length > 1) {
        const droppedFrame = pending.shift()!;
        pendingSamples -= droppedFrame.length;
        pendingStartedAt += (droppedFrame.length / STT_SAMPLE_RATE) * 1000;
      }
      maybeDispatch(false);
    },

    async tickTranscript(): Promise<string> {
      // Bounded wait: let the current job finish and the tail go through, but
      // never hold a tick longer than STT_FLUSH_WAIT_MS past its trigger.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, STT_FLUSH_WAIT_MS);
        settleWaiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
        maybeDispatch(true);
      });
      return windowText(segments, Date.now(), TICK_TRANSCRIPT_MS, TICK_TRANSCRIPT_MAX_CHARS);
    },

    stop(): void {
      dead = true;
      worker?.terminate();
      worker = null;
      waiters.clear();
      pending = [];
      pendingSamples = 0;
      settle();
      segments.length = 0;
    },
  };
}
