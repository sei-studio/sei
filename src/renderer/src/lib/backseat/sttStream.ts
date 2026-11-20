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
import { whisperMirrorFirst } from '../voice/mirrorPref';
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

/** A job slower than this stops holding up the tick that flushed it (the
 *  tick goes with what the ring already has). The job itself keeps running
 *  and still owns the stream until it answers; see dispatch(). */
const STT_SLOW_JOB_MS = 15_000;

/** A single job running past this is a wedged worker, not a slow one: the
 *  1-core harness that reproduced the pile-up answered within 24 s once jobs
 *  ran one at a time. See failWorker(). */
const STT_JOB_CEILING_MS = 90_000;
/** Worker replacements per session before the stream gives up for good. */
const STT_MAX_RESPAWNS = 2;

export interface SttStream {
  /** Feed normalized PCM: mono Float32 at STT_SAMPLE_RATE. */
  push(pcm: Float32Array): void;
  /** Bounded flush, then the transcript window a tick should carry.
   *  Resolves '' when there is no audio, no speech, or no model yet. */
  tickTranscript(): Promise<string>;
  /** Echo gate (260807): every segment overlapping [t0, t1], joined. Reads
   *  what has been chewed so far — no flush, no cap; the gate compares words,
   *  it does not ship them to a model. */
  textAround(t0: number, t1: number): string;
  /**
   * 260925 act: wall-clock ms up to which the share audio has been JUDGED
   * (transcribed, or found silent). Past it the ring's silence means nothing
   * yet: the audio was not transcribed (no model, a wedged worker, a flush
   * that timed out). 0 before anything was judged.
   */
  judgedThrough(): number;
  stop(): void;
}

export function createSttStream(opts: { language?: string } = {}): SttStream {
  const segments: TranscriptSegment[] = [];

  let worker: Worker | null = null;
  let ready = false;
  let dead = false;
  let nextId = 1;
  const waiters = new Map<number, (text: string) => void>();

  /** Workers replaced after a crash or a job past STT_JOB_CEILING_MS. */
  let respawns = 0;

  function spawn(): void {
    ready = false;
    let w: Worker;
    try {
      w = new Worker(new URL('../voice/whisperWorker.ts', import.meta.url), {
        type: 'module',
      });
    } catch {
      dead = true;
      worker = null;
      return;
    }
    worker = w;
    w.onmessage = (e: MessageEvent) => {
      if (worker !== w) return; // a replaced worker's late message
      const msg = e.data as { type: string; id?: number; text?: string; message?: string };
      if (msg.type === 'ready') {
        ready = true;
        return;
      }
      if (msg.type === 'init-error') {
        // No model, no transcripts — the session stays fully functional.
        console.warn(`[sei] backseat stt unavailable: ${msg.message}`);
        failWorker('init-error', false);
        return;
      }
      if (msg.type === 'transcript' && typeof msg.id === 'number') {
        waiters.get(msg.id)?.(msg.text ?? '');
        waiters.delete(msg.id);
      }
    };
    // 261121: with one job in flight, a worker that dies without answering
    // would hold the stream forever. A crash (an uncaught error, a WASM
    // abort, an undeserializable message) fails the job and replaces the
    // worker, so a session keeps its transcript.
    w.onerror = (e: ErrorEvent) => {
      e.preventDefault?.();
      if (worker === w) failWorker(`worker error: ${e.message ?? 'unknown'}`, true);
    };
    w.onmessageerror = () => {
      if (worker === w) failWorker('worker messageerror', true);
    };
    w.postMessage({ type: 'init', language: opts.language ?? 'en', mirrorFirst: whisperMirrorFirst() });
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
  /** See SttStream.judgedThrough. */
  let judgedUntil = 0;
  const judged = (t: number): void => {
    if (t > judgedUntil) judgedUntil = t;
  };

  /** The in-flight job's slow-tick and ceiling timers. */
  let jobTimers: ReturnType<typeof setTimeout>[] = [];

  /**
   * The worker crashed, failed to load, or sat on a job past the ceiling.
   * Fail the in-flight job (its audio is gone, the stream is free again),
   * release any waiting tick, and either replace the worker (up to
   * STT_MAX_RESPAWNS per session, same language and mirror options) or mark
   * the stream dead. A replacement is not ready until its model loads; audio
   * meanwhile is dropped exactly as during the first-run download.
   */
  function failWorker(reason: string, respawn: boolean): void {
    const old = worker;
    worker = null;
    ready = false;
    old?.terminate();
    for (const t of jobTimers) clearTimeout(t);
    jobTimers = [];
    waiters.clear();
    busy = false;
    flushArmed = false;
    if (respawn && !dead && respawns < STT_MAX_RESPAWNS) {
      respawns++;
      console.warn(`[sei] backseat stt worker replaced (${reason}), ${respawns}/${STT_MAX_RESPAWNS}`);
      spawn();
    } else {
      if (!dead) console.warn(`[sei] backseat stt stopped (${reason})`);
      dead = true;
      pending = [];
      pendingSamples = 0;
    }
    settle();
  }

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
      // Silence is a judgement; audio with no model to hear it is not.
      if (samples && rmsDb(audio) < ENERGY_FLOOR_DB) judged(t1);
      settle();
      return;
    }

    busy = true;
    const id = nextId++;
    // 261121: a slow job releases the tick waiting on it, NOT the stream.
    // This used to clear `busy` here too, so a Whisper that ran slower than
    // real time (a CPU-starved machine: a game, two 720p60 clip encoders and
    // the call's own Whisper all at once) was handed a new job every 15 s on
    // top of the ones it had not finished. The worker runs every message it
    // gets concurrently, so the backlog grew without bound, each job holding
    // its own inference buffers: measured on a 1-core quota, 5+ jobs in
    // flight at 30-60 s each and renderer malloc climbing past 1.4 GB, which
    // is the v0.7.0 backseat renderer OOM. Now there is exactly one job in
    // flight; audio that arrives meanwhile stays capped at MAX_PENDING_MS,
    // so a late answer is followed by the newest audio, not a queue of old.
    const timeout = setTimeout(() => {
      if (waiters.has(id)) settle();
    }, STT_SLOW_JOB_MS);
    // Past the ceiling the worker is taken for wedged, not slow: it is
    // terminated (which frees whatever the job holds) and replaced.
    const ceiling = setTimeout(() => {
      if (waiters.has(id)) failWorker(`job ${id} past ${STT_JOB_CEILING_MS} ms`, true);
    }, STT_JOB_CEILING_MS);
    jobTimers = [timeout, ceiling];
    waiters.set(id, (text) => {
      clearTimeout(timeout);
      clearTimeout(ceiling);
      jobTimers = [];
      busy = false;
      if (text) pushSegment(segments, { t0, t1, text }, Date.now(), TRANSCRIPT_KEEP_MS);
      judged(t1);
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

  spawn();

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
        const waiter = (): void => {
          clearTimeout(timer);
          resolve();
        };
        // On timeout the waiter leaves the list too: with one job allowed in
        // flight, a slow Whisper can hold the list open for a long time.
        const timer = setTimeout(() => {
          settleWaiters = settleWaiters.filter((w) => w !== waiter);
          resolve();
        }, STT_FLUSH_WAIT_MS);
        settleWaiters.push(waiter);
        maybeDispatch(true);
      });
      return windowText(segments, Date.now(), TICK_TRANSCRIPT_MS, TICK_TRANSCRIPT_MAX_CHARS);
    },

    judgedThrough(): number {
      return judgedUntil;
    },

    textAround(t0: number, t1: number): string {
      return segments
        .filter((s) => s.t1 >= t0 && s.t0 <= t1)
        .map((s) => s.text.trim())
        .filter(Boolean)
        .join(' ');
    },

    stop(): void {
      dead = true;
      worker?.terminate();
      worker = null;
      for (const t of jobTimers) clearTimeout(t);
      jobTimers = [];
      waiters.clear();
      pending = [];
      pendingSamples = 0;
      settle();
      segments.length = 0;
    },
  };
}
