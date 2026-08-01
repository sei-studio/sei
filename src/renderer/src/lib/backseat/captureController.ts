/**
 * Backseat capture controller (260728) — the renderer half of the session.
 *
 * Owns the shared MediaStream and everything downstream of it: the worker that
 * keeps the ring buffer and composites grids, the normalized PCM pipeline that
 * feeds the gain signal AND the streaming transcript, the rolling recorders
 * that back clip export, and the wakes the renderer raises locally (the
 * scheduled idle look, and the jolt).
 *
 * Audio (260728): the model never hears sound. Screen audio exists for two
 * local consumers only — the GAIN signal (the jolt trigger's gain arm) and the
 * STT TRANSCRIPT (sttStream.ts, the packaged Whisper model). Whatever the
 * platform source, audio is normalized to mono Float32 at STT_SAMPLE_RATE
 * before either consumer sees it, so the pipeline below the source line is
 * identical everywhere. 260801: audio no longer influences WHICH frames the
 * grid uses — the offset table does, unconditionally.
 *
 * It decides only WHEN to hand main a grid. Whether that grid becomes a spoken
 * line is entirely main's call — see src/main/backseat/backseatService.ts.
 */

import { sei } from '../ipcClient';
import {
  CLIP_MS,
  CLIPS_ENABLED,
  CAPTURE_FPS,
  CAPTURE_H,
  CAPTURE_W,
  JOLT_COLOR_DELTA,
  JOLT_GAIN_DB,
  nextIdleDelayMs,
  STT_SAMPLE_RATE,
  type BackseatTickKind,
} from '../../../../shared/backseatIpc';
import { downmixInterleaved, resampleMono, rmsDb } from './pcm';
import { createSttStream, type SttStream } from './sttStream';

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
const CLIP_PERIOD_MS = CLIP_MS * 2;
const CLIP_STAGGER_MS = CLIP_MS;

interface Rolling {
  recorder: MediaRecorder;
  chunks: Blob[];
  startedAt: number;
}

/** A composited grid as the worker returns it. */
interface Grid {
  dataUrl: string;
  /** Capture time of the NEWEST cell, not of the composite. */
  capturedAt: number;
  /** Achieved offsets per cell, seconds before capturedAt; null = black cell. */
  offsets: Array<number | null>;
}

export interface CaptureHandle {
  stop: () => void;
  setPaused: (paused: boolean) => void;
  /** Latch a grid ending now, to ride along with the message being composed. */
  armUserGrid: () => void;
  /** Send the player's finished line with the latched (or a fresh) grid. */
  sendUserTick: (text: string) => Promise<void>;
  /**
   * The companion just said something. Push the scheduled look back a full
   * fresh interval: main already spoke about these seconds, and an idle tick
   * arriving right behind a jolt reply is two lines about one moment.
   */
  noteSpoke: () => void;
}

let active: CaptureHandle | null = null;

/**
 * Where the session's audio comes from. Everything downstream is identical;
 * only the source differs per platform:
 *
 *   'track'  a real MediaStreamTrack (Windows desktop loopback, or a virtual
 *            output device), read via MediaStreamTrackProcessor exactly like
 *            the video track.
 *   'tap'    the bundled macOS ScreenCaptureKit helper: main spawns it and
 *            relays interleaved Float32 PCM over backseat:pcm.
 *   'none'   video-only. The grid is unaffected (frame choice is purely
 *            temporal), but the gain jolt arm never fires and there is no
 *            transcript.
 */
type AudioSource =
  | { kind: 'track'; track: MediaStreamTrack }
  | { kind: 'tap'; sampleRate: number; channels: number }
  | { kind: 'none' };

/** Gain metering window: ~32 ms at 16 kHz, close to the old analyser's. */
const GAIN_WINDOW_SAMPLES = 512;

/**
 * Find a virtual loopback input device (BlackHole, Loopback, Soundflower, VB
 * Cable). This is the ONLY way to hear another app's audio on macOS today, so
 * when the player has one installed and set as their output, backseat can hear
 * their game and their videos. Returns null when none is present.
 */
async function findLoopbackDevice(): Promise<string | null> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const hit = devices.find(
      (d) =>
        d.kind === 'audioinput' &&
        /blackhole|loopback|soundflower|vb-?cable|virtual/i.test(d.label),
    );
    return hit ? hit.deviceId : null;
  } catch {
    return null;
  }
}

/**
 * Open the shared stream. Audio is wanted but NEVER required.
 *
 * 260728, measured on macOS 26.4 / Electron 42 / Chromium 148: system-audio
 * loopback does not work on macOS at all. With
 * `MacSckSystemAudioLoopbackOverride` and `MacLoopbackAudioForScreenShare` both
 * enabled and verified applied, `audio: 'loopback'` produces a track labelled
 * "System audio" that carries digital silence, in every request shape tried:
 * combined with video, split into a second request, and audio-only with no
 * video at all. Electron documents `loopback` as Windows-only, and that matches
 * what the machine actually does.
 *
 * So the source order is:
 *   Windows   inline desktop loopback (works, documented).
 *   macOS     the bundled ScreenCaptureKit tap, spawned by main — the same
 *             OS facility OBS records desktop audio with, verified live
 *             (probe 260728: silence reads -inf, a tone reads ~-28 dB). No
 *             install, no extra permission (it rides Screen Recording, which
 *             the picker already required), and it EXCLUDES Sei's own audio
 *             so the companion cannot transcribe its own TTS voice.
 *   fallback  a virtual output device the player installed (BlackHole et al.)
 *   else      video-only: frame selection falls back to "last frame of each
 *             second", the gain jolt arm never fires (the colour arm still
 *             does), and there is no transcript. The grid and the gate are
 *             unaffected, both purely visual by design.
 */
async function openStream(
  sourceId: string,
): Promise<{ stream: MediaStream; audioSource: AudioSource }> {
  const video = {
    mandatory: {
      chromeMediaSource: 'desktop',
      chromeMediaSourceId: sourceId,
      maxWidth: CAPTURE_W,
      maxHeight: CAPTURE_H,
      maxFrameRate: CAPTURE_FPS,
    },
  } as unknown as MediaTrackConstraints;
  // Windows: desktop loopback works, so ask for it inline.
  if (navigator.userAgent.includes('Windows')) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'desktop' } } as unknown as MediaTrackConstraints,
        video,
      });
      const track = stream.getAudioTracks()[0];
      if (track) return { stream, audioSource: { kind: 'track', track } };
      stream.getTracks().forEach((t) => t.stop());
    } catch {
      /* fall through to video-only */
    }
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video });

  // macOS: the bundled tap. Main answers null anywhere it cannot run (not
  // macOS, binary missing, pre-13, TCC refused), which just falls through.
  if (navigator.userAgent.includes('Mac')) {
    try {
      const fmt = await sei.backseatAudioStart();
      if (fmt) return { stream, audioSource: { kind: 'tap', ...fmt } };
    } catch {
      /* fall through */
    }
  }

  // A virtual output device, if the player has one. Added as a real track on
  // the same stream so clips record it for free.
  const deviceId = await findLoopbackDevice();
  if (deviceId) {
    try {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: deviceId } },
        video: false,
      });
      const track = mic.getAudioTracks()[0];
      if (track) {
        stream.addTrack(track);
        return { stream, audioSource: { kind: 'track', track } };
      }
    } catch {
      /* device vanished or is in use; video-only is still a working session */
    }
  }
  return { stream, audioSource: { kind: 'none' } };
}

/**
 * Normalize an audio source into 16 kHz mono PCM and fan it out to the two
 * consumers (gain + STT). For the macOS tap it also regenerates a REAL audio
 * track (MediaStreamTrackGenerator) and adds it to the stream, so clip
 * recordings keep sound on macOS too — the loopback/virtual paths already
 * carry a real track.
 *
 * Returns a stop() that tears down whichever source was in use.
 */
function startAudioPipeline(
  source: AudioSource,
  stream: MediaStream,
  onPcm16k: (pcm: Float32Array) => void,
): { stop: () => void } {
  if (source.kind === 'none') return { stop: () => {} };

  if (source.kind === 'track') {
    // Same pattern as the video: MediaStreamTrackProcessor is throttle-immune
    // and hands AudioData off the realtime thread. Reading it does not steal
    // the track from MediaRecorder; a track feeds any number of sinks.
    let running = true;
    const processor = new (window as unknown as {
      MediaStreamTrackProcessor: new (o: { track: MediaStreamTrack }) => {
        readable: ReadableStream<AudioData>;
      };
    }).MediaStreamTrackProcessor({ track: source.track });
    const reader = processor.readable.getReader();
    void (async () => {
      while (running) {
        const { done, value } = await reader.read().catch(() => ({ done: true, value: null }));
        if (done || !value) break;
        try {
          const frames = value.numberOfFrames;
          const chans = Math.min(2, value.numberOfChannels) || 1;
          const planes: Float32Array[] = [];
          for (let c = 0; c < chans; c++) {
            const buf = new Float32Array(frames);
            value.copyTo(buf, { planeIndex: c, format: 'f32-planar' });
            planes.push(buf);
          }
          let mono = planes[0];
          if (planes.length === 2) {
            mono = new Float32Array(frames);
            for (let i = 0; i < frames; i++) mono[i] = (planes[0][i] + planes[1][i]) / 2;
          }
          onPcm16k(resampleMono(mono, value.sampleRate, STT_SAMPLE_RATE));
        } catch {
          /* one bad AudioData never kills the pipeline */
        } finally {
          value.close();
        }
      }
      try {
        reader.releaseLock();
      } catch {
        /* already released */
      }
    })();
    return {
      stop: () => {
        running = false;
        void reader.cancel().catch(() => {});
      },
    };
  }

  // The tap: PCM arrives over IPC as interleaved Float32 at the tap's rate.
  const { sampleRate, channels } = source;
  // Rebuild a real track for the clip recorders (16 kHz clips would sound like
  // a phone call; the generator carries the tap's full rate).
  let writer: { write: (d: unknown) => Promise<void>; close: () => Promise<void> } | null = null;
  let tsSamples = 0;
  const baseUs = performance.now() * 1000;
  const Gen = (window as unknown as {
    MediaStreamTrackGenerator?: new (o: { kind: 'audio' }) => MediaStreamTrack & {
      writable: WritableStream;
    };
  }).MediaStreamTrackGenerator;
  if (CLIPS_ENABLED && Gen) {
    try {
      const gen = new Gen({ kind: 'audio' });
      writer = gen.writable.getWriter();
      stream.addTrack(gen);
    } catch {
      writer = null;
    }
  }

  const off = sei.onBackseatPcm((chunk: ArrayBuffer) => {
    const interleaved = new Float32Array(chunk);
    const frames = Math.floor(interleaved.length / channels);
    if (!frames) return;
    if (writer) {
      try {
        const AD = (window as unknown as { AudioData: new (init: unknown) => unknown }).AudioData;
        void writer
          .write(
            new AD({
              format: 'f32',
              sampleRate,
              numberOfFrames: frames,
              numberOfChannels: channels,
              timestamp: baseUs + (tsSamples / sampleRate) * 1_000_000,
              data: interleaved,
            }),
          )
          .catch(() => {});
        tsSamples += frames;
      } catch {
        /* clip audio is best-effort */
      }
    }
    onPcm16k(resampleMono(downmixInterleaved(interleaved, channels), sampleRate, STT_SAMPLE_RATE));
  });

  return {
    stop: () => {
      off();
      void writer?.close().catch(() => {});
      void sei.backseatAudioStop().catch(() => {});
    },
  };
}

export async function startCapture(
  characterId: string,
  sourceId: string,
): Promise<CaptureHandle> {
  stopCapture();
  const { stream, audioSource } = await openStream(sourceId);
  const videoTrack = stream.getVideoTracks()[0];
  if (!videoTrack) {
    stream.getTracks().forEach((t) => t.stop());
    if (audioSource.kind === 'tap') void sei.backseatAudioStop().catch(() => {});
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

  // ── Audio: gain + transcript, one normalized feed ───────────────────────
  // The transcript ring runs for the whole session; the same 16 kHz mono PCM
  // drives the gain signal in ~32 ms windows, so every frame the worker sees
  // has a loudness reading about as fresh as the old analyser gave it.
  let language = 'en';
  try {
    const cfg = (await sei.getConfig()) as { chat_language?: string } | null;
    if (cfg?.chat_language) language = cfg.chat_language;
  } catch {
    /* English is the right default */
  }
  const stt: SttStream = createSttStream({ language });
  const pipeline = startAudioPipeline(audioSource, stream, (pcm) => {
    stt.push(pcm);
    for (let i = 0; i < pcm.length; i += GAIN_WINDOW_SAMPLES) {
      const win = pcm.subarray(i, Math.min(pcm.length, i + GAIN_WINDOW_SAMPLES));
      worker.postMessage({ type: 'gain', db: rmsDb(win) });
    }
  });
  /** The transcript a tick carries: bounded flush, then the window's text.
   *  Undefined (field omitted) when silent, so the prompt says nothing. */
  const tickTranscript = async (): Promise<string | undefined> => {
    try {
      const text = await stt.tickTranscript();
      return text || undefined;
    } catch {
      return undefined;
    }
  };

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
  let staggerTimer = 0;
  // Continuously encoding 720p60 for a whole session is by far the most
  // expensive thing here, and it exists only so a rare save_clip has something
  // to harvest. With clipping off, none of it runs.
  if (CLIPS_ENABLED) {
    cycle(0);
    cycleTimers.push(window.setInterval(() => cycle(0), CLIP_PERIOD_MS));
    staggerTimer = window.setTimeout(() => {
      cycle(1);
      cycleTimers.push(window.setInterval(() => cycle(1), CLIP_PERIOD_MS));
    }, CLIP_STAGGER_MS);
  }

  /** The complete segment that best covers the last BUFFER_MS. */
  const harvestClip = async (): Promise<string | null> => {
    if (!CLIPS_ENABLED) return null;
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
  // `offsets` is what the worker ACTUALLY achieved per cell, in seconds before
  // capturedAt (null = the cell was left black). Diagnostics only: it is logged
  // so a session can be checked for whether the log spacing held, and nothing
  // downstream reads it.
  let seq = 0;
  const pendingGrids = new Map<string, (g: Grid | null) => void>();
  const composite = (): Promise<Grid | null> => {
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
  let held: Grid | null = null;
  /** Single-flight guard so a burst of keystrokes composites once, not once
   *  per character — the "avoid overloading" case. */
  let arming = false;

  const sendTick = async (
    kind: BackseatTickKind,
    grid: Grid,
    extra: { text?: string; joltReason?: 'gain' | 'color'; transcript?: string } = {},
  ): Promise<void> => {
    if (stopped) return;
    console.log(
      `[backseat] tick ${kind}: cells at -${grid.offsets.map((o) => (o === null ? 'x' : o.toFixed(2))).join('/')}s`,
    );
    try {
      await sei.backseatTick({
        characterId,
        kind,
        grid: grid.dataUrl,
        capturedAt: grid.capturedAt,
        ...extra,
      });
    } catch (err) {
      /* a dropped tick is a missed comment, never a broken session */
      console.warn(`[backseat] tick send failed: ${(err as Error)?.message}`);
    }
  };

  worker.onmessage = (e: MessageEvent): void => {
    const msg = e.data as
      | { type: 'grid'; requestId: string; grid: Grid | null }
      | {
          type: 'jolt';
          reason: 'gain' | 'color';
          at: number;
          gainDb: number;
          baseDb: number;
          colorDelta: number | null;
        }
      | {
          type: 'stats';
          fps: number | null;
          eps: number | null;
          gainDb: number;
          baseDb: number;
          colorDelta: number | null;
          samples: number;
        };
    if (msg.type === 'grid') {
      const resolve = pendingGrids.get(msg.requestId);
      if (resolve) {
        pendingGrids.delete(msg.requestId);
        resolve(msg.grid);
      }
      return;
    }
    if (msg.type === 'stats') {
      // Every 10 s, so "are the signals alive" is answerable from the console
      // (forwarded to the terminal in dev by backseatOverlay.ts). gain vs base
      // is what the gain jolt arms on; colorDelta is what the colour arm sees.
      console.log(
        `[backseat] signals: ${msg.fps ?? '?'}fps, ${msg.eps ?? '?'} encodes/s, ${msg.samples} samples, ` +
          `gain ${msg.gainDb}dB vs base ${msg.baseDb}dB (jolt at +${JOLT_GAIN_DB}), ` +
          `colorDelta ${msg.colorDelta ?? 'n/a'} (jolt at ${JOLT_COLOR_DELTA})`,
      );
      return;
    }
    if (msg.type === 'jolt') {
      console.log(
        `[backseat] JOLT ${msg.reason}: gain ${msg.gainDb}dB vs base ${msg.baseDb}dB, ` +
          `colorDelta ${msg.colorDelta ?? 'n/a'}`,
      );
      if (paused || stopped) return;
      void (async () => {
        const grid = await composite();
        if (!grid) {
          console.warn('[backseat] jolt tick dropped: no grid from worker');
          return;
        }
        // On a gain jolt the transcript is literally what the loud thing said.
        const transcript = await tickTranscript();
        await sendTick('jolt', grid, { joltReason: msg.reason, transcript });
      })();
    }
  };

  // ── The scheduled look ──────────────────────────────────────────────────
  // The steady-state wake, and the only one with no opinion about the screen:
  // a randomised timer (nextIdleDelayMs) composites a grid and hands it up. All
  // of the "was that worth saying anything about" judgement happens in the
  // model, prompted by tickNote's 'idle' branch.
  //
  // 260801: this replaces a 6 s poll of a small VLM asked whether the grid was
  // interesting. Measured, that model said yes far too readily and the
  // narration-novelty scheme meant to replace it carried almost no signal, so
  // the gate is gone rather than retuned (.planning/backseat-v2-260801.md).
  //
  // A setTimeout chain rather than setInterval: the delay is redrawn every
  // time, and it also has to be resettable from outside (noteSpoke) so an idle
  // look never lands seconds after a jolt already produced a line about the
  // same moment.
  let idleTimer = 0;
  let idleBusy = false;
  const scheduleIdle = (): void => {
    if (stopped) return;
    window.clearTimeout(idleTimer);
    const delay = nextIdleDelayMs();
    idleTimer = window.setTimeout(() => {
      scheduleIdle();
      if (paused || stopped || idleBusy) return;
      idleBusy = true;
      void (async () => {
        try {
          const grid = await composite();
          if (!grid) {
            // Capture is not producing frames; there is nothing to look at.
            console.warn('[backseat] idle look skipped: no grid from worker (ring empty?)');
            return;
          }
          if (paused || stopped) return;
          // The grid and the transcript describe the same window: composite
          // first, then the bounded STT flush (the spec's "wait a few
          // milliseconds longer for the stt to catch up").
          const transcript = await tickTranscript();
          if (paused || stopped) return;
          await sendTick('idle', grid, { transcript });
        } catch {
          /* a missed look is a missed comment, never a broken session */
        } finally {
          idleBusy = false;
        }
      })();
    }, delay);
    console.log(`[backseat] next idle look in ${(delay / 1000).toFixed(1)}s`);
  };
  scheduleIdle();

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
      window.clearTimeout(idleTimer);
      pipeline.stop();
      stt.stop();
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
      // What the game said around the moment they reacted to — the flush
      // window reaches back far enough to cover a held grid's span.
      const transcript = await tickTranscript();
      await sendTick('user', grid, { text, transcript });
    },
    noteSpoke: () => {
      if (!stopped) scheduleIdle();
    },
  };

  active = handle;
  return handle;
}

export function stopCapture(): void {
  active?.stop();
  active = null;
}
