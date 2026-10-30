/**
 * Avatar mouth-level tap (260804).
 *
 * While a companion's TTS clip plays in THIS (main) window, sample its output
 * level and relay it to the always-on-top avatar overlay window (via main,
 * `avatar:overlay-level`) so a Live2D tile can lip-sync to the actual audio.
 * ~25 Hz, tiny payloads, fire-and-forget.
 *
 * OFF unless armed: the tap is enabled by the overlay pusher only while a
 * shown participant actually has a Live2D model, because the no-pitch path
 * has a real cost — an element with no WebAudio routing must be given a
 * MediaElementSourceNode (rerouting its output through the shared context)
 * just to be observable. The pitch-shifted path (pitchBus) already made that
 * source node; we reuse it there (an element can only ever have ONE).
 *
 * When the tap cannot run (context missing/suspended, source creation threw),
 * it returns null and the Live2D tile falls back to its pseudo-envelope — the
 * mouth moves, just not to the real waveform.
 */
import type { RendererApi } from '@shared/ipc';
import { sharedContext } from './voiceAudio';
import { pitchSourceFor } from './pitchBus';
import type { LevelSample } from '../facepack/animation';
import { levelFromTimeDomain, sampleAnalyser } from '../facepack/levelBands';

/** Lazy bridge access: audioQueue's tests import this module in a bare node
 * env where `window` (and window.sei) does not exist — ipcClient's module-
 * scope `window.sei` read would crash the whole import chain there. */
function seiApi(): RendererApi | undefined {
  return typeof window === 'undefined' ? undefined : (window as { sei?: RendererApi }).sei;
}

const SAMPLE_MS = 40; // ~25 Hz

let enabled = false;

/** Armed by the overlay pusher while any shown participant is Live2D. */
export function setAvatarLevelTapEnabled(on: boolean): void {
  enabled = on;
}

/**
 * In-window level + band listeners (261028, facepack pilot): a FacepackView
 * in THIS window picks mouth shapes from them. Empty unless the facepack dev
 * flag mounted one, so with no listener the tap behaves exactly as before.
 */
type LocalSink = (characterId: string, sample: LevelSample | null) => void;
const localSinks = new Set<LocalSink>();

/** Subscribe to clip samples ({level, low, high}; null = the clip ended). */
export function subscribeClipLevels(fn: LocalSink): () => void {
  localSinks.add(fn);
  return () => localSinks.delete(fn);
}

/**
 * Start sampling `el`'s output as `characterId`'s mouth level. Returns a
 * teardown to run with the clip's other cleanup, or null when tapping is
 * disabled or impossible (callers need no fallback — the overlay tile
 * pseudo-envelopes on its own).
 */
export function tapClipLevel(el: HTMLAudioElement, characterId: string): (() => void) | null {
  if (!enabled && localSinks.size === 0) return null;
  const ctx = sharedContext();
  // A suspended context would SILENCE any element we route through it; only
  // tap when audio is genuinely flowing through this context already (calls).
  if (!ctx || ctx.state !== 'running') return null;

  let src = pitchSourceFor(el);
  let ownSource: MediaElementAudioSourceNode | null = null;
  if (!src) {
    try {
      ownSource = ctx.createMediaElementSource(el);
    } catch {
      return null;
    }
    // Rerouted through the graph, the element only stays audible connected out.
    ownSource.connect(ctx.destination);
    src = ownSource;
  }

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.5;
  try {
    src.connect(analyser);
  } catch {
    return null;
  }

  const data = new Float32Array(analyser.fftSize);
  const freq = new Float32Array(analyser.frequencyBinCount);
  const timer = setInterval(() => {
    // Same shape as the lipsync fork's envelope: sqrt(meanSquare * 20),
    // which lands speech in a usable 0..1 band without a noise gate.
    let level: number;
    if (localSinks.size > 0) {
      const sample = sampleAnalyser(analyser, { time: data, freq });
      level = sample.level;
      for (const fn of localSinks) fn(characterId, sample);
    } else {
      analyser.getFloatTimeDomainData(data);
      level = levelFromTimeDomain(data);
    }
    if (enabled) void seiApi()?.avatarOverlayLevel?.(characterId, level).catch(() => {});
  }, SAMPLE_MS);

  return () => {
    clearInterval(timer);
    try {
      src.disconnect(analyser);
    } catch {
      /* context torn down under us */
    }
    try {
      ownSource?.disconnect();
    } catch {
      /* ditto */
    }
    // Leave the mouth closed rather than frozen on the last sample.
    if (enabled) void seiApi()?.avatarOverlayLevel?.(characterId, 0).catch(() => {});
    for (const fn of localSinks) fn(characterId, null);
  };
}
