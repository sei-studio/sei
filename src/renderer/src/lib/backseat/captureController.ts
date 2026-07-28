/**
 * Backseat capture controller (260728) — the renderer half of the session.
 *
 * Owns the shared MediaStream and everything downstream of it: the worker that
 * keeps the ring buffer and composites grids, the audio meter that drives frame
 * selection, the rolling recorders that back clip export, and the two triggers
 * the renderer raises locally (the every-6s salience gate, and the jolt).
 *
 * It decides only WHEN to hand main a grid. Whether that grid becomes a spoken
 * line is entirely main's call — see src/main/backseat/backseatService.ts.
 */

import { sei } from '../ipcClient';
import {
  BUFFER_MS,
  CAPTURE_FPS,
  CAPTURE_H,
  CAPTURE_W,
  GATE_INTERVAL_MS,
  type BackseatTickKind,
} from '../../../../shared/backseatIpc';

/**
 * How long a grid captured at the player's first word stays usable. Someone can
 * start a sentence and take half a minute to finish it (or start typing, get
 * distracted, and come back); past this the held grid no longer shows what they
 * are talking about, so the send recomposites instead of shipping stale pixels.
 */
const USER_GRID_MAX_AGE_MS = 30_000;

/**
 * Rolling-recorder geometry. A WebM segment is only decodable from its own
 * header, so "the last 15 seconds" cannot be assembled by keeping the tail of a
 * chunk list. Two recorders staggered by half a period solve it: at any instant
 * the older-running one has been recording for between STAGGER and PERIOD, so
 * stopping it always yields ONE complete, playable file that contains the whole
 * requested window. The cost is that a saved clip runs 15-30 s rather than
 * exactly 15 — it always covers the moment asked for, sometimes with more lead
 * in. That is the right way to be wrong here.
 */
const CLIP_PERIOD_MS = BUFFER_MS * 2;
const CLIP_STAGGER_MS = BUFFER_MS;

interface Rolling {
  recorder: MediaRecorder;
  chunks: Blob[];
  startedAt: number;
}

export interface CaptureHandle {
  stop: () => void;
  setPaused: (paused: boolean) => void;
  /** Latch a grid ending now, to ride along with the message being composed. */
  armUserGrid: () => void;
  /** Send the player's finished line with the latched (or a fresh) grid. */
  sendUserTick: (text: string) => Promise<void>;
}

let active: CaptureHandle | null = null;

/** RMS of the analyser's time-domain window, in dBFS (-100..0). */
function meter(analyser: AnalyserNode, buf: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  const rms = Math.sqrt(sum / buf.length);
  return rms > 0 ? Math.max(-100, 20 * Math.log10(rms)) : -100;
}

/**
 * Open the shared stream. Audio is requested but never required: on macOS,
 * loopback capture of another app's sound needs a virtual audio device, so the
 * constraint fails there and we fall back to video only. Losing audio costs the
 * loudest-frame heuristic and the gain arm of the jolt trigger; the colour arm
 * and the salience gate carry on unchanged, and the worker's frame selection
 * degrades to "the last frame of each second", which is a sane default.
 */
async function openStream(sourceId: string): Promise<{ stream: MediaStream; hasAudio: boolean }> {
  const video = {
    mandatory: {
      chromeMediaSource: 'desktop',
      chromeMediaSourceId: sourceId,
      maxWidth: CAPTURE_W,
      maxHeight: CAPTURE_H,
      maxFrameRate: CAPTURE_FPS,
    },
  } as unknown as MediaTrackConstraints;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'desktop' } } as unknown as MediaTrackConstraints,
      video,
    });
    return { stream, hasAudio: stream.getAudioTracks().length > 0 };
  } catch {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video });
    return { stream, hasAudio: false };
  }
}

export async function startCapture(
  characterId: string,
  sourceId: string,
): Promise<CaptureHandle> {
  stopCapture();
  const { stream, hasAudio } = await openStream(sourceId);
  const videoTrack = stream.getVideoTracks()[0];
  if (!videoTrack) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error('The shared window produced no video.');
  }

  const worker = new Worker(new URL('./captureWorker.ts', import.meta.url), { type: 'module' });

  // MediaStreamTrackProcessor hands the worker a transferable stream of frames,
  // which is what keeps capture alive while the player is in a fullscreen game
  // and Sei is behind it. rAF-based capture stalls the moment the window hides.
  const processor = new (window as unknown as {
    MediaStreamTrackProcessor: new (o: { track: MediaStreamTrack }) => {
      readable: ReadableStream<VideoFrame>;
    };
  }).MediaStreamTrackProcessor({ track: videoTrack });
  worker.postMessage({ type: 'start', readable: processor.readable }, [
    processor.readable as unknown as Transferable,
  ]);

  // ── Audio meter ─────────────────────────────────────────────────────────
  let audioCtx: AudioContext | null = null;
  let meterTimer: number | null = null;
  if (hasAudio) {
    audioCtx = new AudioContext();
    const src = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    // 1024 samples is ~21 ms at 48 kHz: short enough to resolve a single
    // gunshot, long enough that the RMS is not dominated by one sample.
    analyser.fftSize = 1024;
    src.connect(analyser);
    const buf = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));
    // Sampled just above capture rate so every frame the worker sees has a
    // loudness reading no older than one frame interval.
    meterTimer = window.setInterval(() => {
      worker.postMessage({ type: 'gain', db: meter(analyser, buf) });
    }, 1000 / CAPTURE_FPS);
  }

  // ── Rolling recorders (clip export) ─────────────────────────────────────
  const rollers: Array<Rolling | null> = [null, null];
  const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? 'video/webm;codecs=vp9'
    : 'video/webm';
  const cycle = (slot: number): void => {
    const prev = rollers[slot];
    if (prev && prev.recorder.state !== 'inactive') prev.recorder.stop();
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2_500_000 });
    } catch {
      rollers[slot] = null;
      return;
    }
    const entry: Rolling = { recorder: rec, chunks: [], startedAt: Date.now() };
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size) entry.chunks.push(e.data);
    };
    rollers[slot] = entry;
    rec.start(1000);
  };
  const cycleTimers: number[] = [];
  cycle(0);
  cycleTimers.push(window.setInterval(() => cycle(0), CLIP_PERIOD_MS));
  const staggerTimer = window.setTimeout(() => {
    cycle(1);
    cycleTimers.push(window.setInterval(() => cycle(1), CLIP_PERIOD_MS));
  }, CLIP_STAGGER_MS);

  /** The complete segment that best covers the last BUFFER_MS. */
  const harvestClip = async (): Promise<string | null> => {
    const candidates = rollers.filter((r): r is Rolling => !!r && r.chunks.length > 0);
    if (!candidates.length) return null;
    // Longest-running recorder = the one whose segment reaches furthest back.
    const pick = candidates.sort((a, b) => a.startedAt - b.startedAt)[0];
    // Flush whatever has not hit a timeslice boundary yet, so the clip runs all
    // the way to the moment the model asked for it rather than up to a second
    // short of it.
    await new Promise<void>((resolve) => {
      if (pick.recorder.state !== 'recording') return resolve();
      const done = (): void => resolve();
      pick.recorder.addEventListener('dataavailable', done, { once: true });
      try {
        pick.recorder.requestData();
      } catch {
        resolve();
      }
      window.setTimeout(done, 400);
    });
    const blob = new Blob(pick.chunks, { type: mime });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    const CH = 0x8000;
    for (let i = 0; i < buf.length; i += CH) {
      bin += String.fromCharCode(...buf.subarray(i, i + CH));
    }
    return btoa(bin);
  };

  // ── Grid requests ───────────────────────────────────────────────────────
  let seq = 0;
  const pendingGrids = new Map<string, (g: { dataUrl: string; capturedAt: number } | null) => void>();
  const composite = (): Promise<{ dataUrl: string; capturedAt: number } | null> => {
    const requestId = `g${++seq}`;
    return new Promise((resolve) => {
      pendingGrids.set(requestId, resolve);
      worker.postMessage({ type: 'composite', requestId });
      // The worker decodes six JPEGs per grid; if it ever wedges, the session
      // must not wedge with it.
      window.setTimeout(() => {
        if (pendingGrids.delete(requestId)) resolve(null);
      }, 4000);
    });
  };

  let paused = false;
  let stopped = false;
  /** Grid latched when the player began speaking or typing. */
  let held: { dataUrl: string; capturedAt: number } | null = null;
  /** Single-flight guard so a burst of keystrokes composites once, not once
   *  per character — the "avoid overloading" case. */
  let arming = false;

  const sendTick = async (
    kind: BackseatTickKind,
    grid: { dataUrl: string; capturedAt: number },
    extra: { text?: string; joltReason?: 'gain' | 'color' } = {},
  ): Promise<void> => {
    if (stopped) return;
    try {
      await sei.backseatTick({
        characterId,
        kind,
        grid: grid.dataUrl,
        capturedAt: grid.capturedAt,
        ...extra,
      });
    } catch {
      /* a dropped tick is a missed comment, never a broken session */
    }
  };

  worker.onmessage = (e: MessageEvent): void => {
    const msg = e.data as
      | { type: 'grid'; requestId: string; grid: { dataUrl: string; capturedAt: number } | null }
      | { type: 'jolt'; reason: 'gain' | 'color'; at: number };
    if (msg.type === 'grid') {
      const resolve = pendingGrids.get(msg.requestId);
      if (resolve) {
        pendingGrids.delete(msg.requestId);
        resolve(msg.grid);
      }
      return;
    }
    if (msg.type === 'jolt') {
      if (paused || stopped) return;
      void (async () => {
        const grid = await composite();
        if (grid) await sendTick('jolt', grid, { joltReason: msg.reason });
      })();
    }
  };

  // ── The salience gate ───────────────────────────────────────────────────
  // Every GATE_INTERVAL_MS a fresh grid goes to the small VLM in main, and a
  // yes becomes a tick. Single-flight: if the gate call is still out when the
  // next interval fires, that interval is skipped rather than queued, so a slow
  // gate makes the companion quieter instead of building a backlog of stale
  // grids that all land at once.
  let gateBusy = false;
  const gateTimer = window.setInterval(() => {
    if (paused || stopped || gateBusy) return;
    gateBusy = true;
    void (async () => {
      try {
        const grid = await composite();
        if (!grid || paused || stopped) return;
        const interesting = await sei.backseatGate(characterId, grid.dataUrl);
        if (interesting && !paused && !stopped) await sendTick('gate', grid);
      } catch {
        /* gate outage degrades to quiet */
      } finally {
        gateBusy = false;
      }
    })();
  }, GATE_INTERVAL_MS);

  // ── Clip requests from main ─────────────────────────────────────────────
  const offClip = sei.onBackseatClipRequest(({ characterId: id, requestId }) => {
    if (id !== characterId || stopped) return;
    void (async () => {
      try {
        const b64 = await harvestClip();
        await sei.backseatSaveClip(characterId, requestId, b64);
      } catch {
        try {
          await sei.backseatSaveClip(characterId, requestId, null);
        } catch {
          /* main will time the request out */
        }
      }
    })();
  });

  // Sharing can also be revoked from the OS ("Stop sharing"), which just ends
  // the track. Treat it as the player ending the session.
  videoTrack.addEventListener('ended', () => {
    void sei.backseatEnd(characterId).catch(() => {});
    stopCapture();
  });

  const handle: CaptureHandle = {
    stop: () => {
      if (stopped) return;
      stopped = true;
      window.clearInterval(gateTimer);
      if (meterTimer !== null) window.clearInterval(meterTimer);
      window.clearTimeout(staggerTimer);
      cycleTimers.forEach((t) => window.clearInterval(t));
      offClip();
      rollers.forEach((r) => {
        if (r && r.recorder.state !== 'inactive') {
          try {
            r.recorder.stop();
          } catch {
            /* already stopping */
          }
        }
      });
      worker.postMessage({ type: 'stop' });
      // Give the worker a beat to close its bitmaps before the thread dies.
      window.setTimeout(() => worker.terminate(), 250);
      stream.getTracks().forEach((t) => t.stop());
      void audioCtx?.close().catch(() => {});
      if (active === handle) active = null;
    },
    setPaused: (p: boolean) => {
      paused = p;
      // A grid latched before the pause describes a moment the player has since
      // stepped away from; dropping it means unpausing starts clean.
      if (p) held = null;
    },
    armUserGrid: () => {
      if (paused || stopped || arming) return;
      // Already holding something recent enough to still be about this moment.
      if (held && Date.now() - held.capturedAt < USER_GRID_MAX_AGE_MS) return;
      arming = true;
      void (async () => {
        try {
          const grid = await composite();
          if (grid) held = grid;
        } finally {
          arming = false;
        }
      })();
    },
    sendUserTick: async (text: string) => {
      if (stopped) return;
      // The latch is best-effort. If it never armed (the player pasted a whole
      // message, or typed faster than one composite), or it armed so long ago
      // that it no longer shows what they mean, compose one now.
      let grid = held;
      held = null;
      if (!grid || Date.now() - grid.capturedAt > USER_GRID_MAX_AGE_MS) {
        grid = await composite();
      }
      if (!grid) return;
      await sendTick('user', grid, { text });
    },
  };

  active = handle;
  return handle;
}

export function stopCapture(): void {
  active?.stop();
  active = null;
}
