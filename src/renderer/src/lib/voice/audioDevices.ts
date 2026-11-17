/**
 * Microphone and speaker choice (261118, feat/mic-picker).
 *
 * Calls used to open whatever the OS calls the default input, and companion
 * speech played on the default output. A Windows player whose default input
 * was a dead or wrong device (a webcam mic in another room, an unplugged
 * headset still marked default) heard the companion but was never heard, and
 * had nowhere to change it. Settings > Microphone and speakers now picks both,
 * stored as UserConfig.audio_input_device / audio_output_device (null or absent
 * = "System default").
 *
 * This module is the pure half: device lists, constraints, the open-with-
 * fallback rule, and the current output sink. It has no window or IPC access
 * at import time, so the audio queue and dictation can import it under tests.
 * The persisted choice lives in useAudioDeviceStore, which pushes the output
 * id here (setOutputDeviceId) and is told when a device has gone.
 *
 * Fallback rule, both directions: a saved device that is no longer there
 * (unplugged, renamed id after a driver update) never breaks a call. The
 * capture or playback falls back to the system default and the setting is
 * quietly reset, so the next call does not try the missing device again.
 */

export type AudioDeviceKind = 'audioinput' | 'audiooutput';

export interface DeviceOption {
  id: string;
  label: string;
}

/** Chromium's pseudo entry for the OS default. "System default" (null) stands
 *  for it, so it is never listed as a device of its own. */
const CHROMIUM_DEFAULT_ID = 'default';

/**
 * The devices of one kind to offer, in the order the OS lists them. Drops the
 * `default` pseudo entry and duplicates. A device with no label (labels are
 * empty until media permission is granted) gets `unnamed(n)`, so the list never
 * shows blank rows. Windows also lists a `communications` entry; it is a real
 * choice there (the default communications device) and stays.
 */
export function deviceOptions(
  devices: readonly Pick<MediaDeviceInfo, 'deviceId' | 'kind' | 'label'>[],
  kind: AudioDeviceKind,
  unnamed: (n: number) => string,
): DeviceOption[] {
  const out: DeviceOption[] = [];
  const seen = new Set<string>();
  for (const d of devices) {
    if (d.kind !== kind || !d.deviceId || d.deviceId === CHROMIUM_DEFAULT_ID) continue;
    if (seen.has(d.deviceId)) continue;
    seen.add(d.deviceId);
    out.push({ id: d.deviceId, label: d.label.trim() || unnamed(out.length + 1) });
  }
  return out;
}

/** The capture constraints for a saved input: the base set plus an exact
 *  deviceId, or the base set alone for the system default. */
export function micConstraints(
  base: MediaTrackConstraints,
  deviceId: string | null | undefined,
): MediaTrackConstraints {
  return deviceId ? { ...base, deviceId: { exact: deviceId } } : { ...base };
}

/**
 * A capture or sink failure that means "that device is not here", as opposed
 * to a refusal or a busy device. An `exact` deviceId that matches nothing is
 * an OverconstrainedError in Chromium; NotFoundError covers setSinkId and
 * older capture paths.
 */
export function isDeviceGone(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name ?? '';
  return name === 'OverconstrainedError' || name === 'NotFoundError';
}

export interface OpenMicDeps {
  getUserMedia: (c: MediaStreamConstraints) => Promise<MediaStream>;
  /** The saved device is gone; the caller resets the setting. */
  onDeviceGone?: () => void;
}

/**
 * Open the mic on the saved device, or on the system default when none is
 * saved. A saved device that is gone falls back to the default once and calls
 * onDeviceGone; every other failure (refusal, busy, no mic at all) is thrown
 * unchanged so the caller's error handling still sees the real reason.
 */
export async function openMic(
  base: MediaTrackConstraints,
  deviceId: string | null | undefined,
  deps: OpenMicDeps,
): Promise<{ stream: MediaStream; fellBack: boolean }> {
  if (!deviceId) {
    return { stream: await deps.getUserMedia({ audio: { ...base }, video: false }), fellBack: false };
  }
  try {
    const stream = await deps.getUserMedia({ audio: micConstraints(base, deviceId), video: false });
    return { stream, fellBack: false };
  } catch (err) {
    if (!isDeviceGone(err)) throw err;
    deps.onDeviceGone?.();
    return { stream: await deps.getUserMedia({ audio: { ...base }, video: false }), fellBack: true };
  }
}

// ── Output sink ─────────────────────────────────────────────────────────────

/** Anything with Chromium's setSinkId: HTMLMediaElement and AudioContext. */
export interface SinkTarget {
  setSinkId?: (id: string) => Promise<void>;
  sinkId?: unknown;
}

let outputDeviceId: string | null = null;
let onOutputGone: (() => void) | null = null;
const outputListeners = new Set<(id: string | null) => void>();

/** The saved speaker, or null for the system default. */
export function getOutputDeviceId(): string | null {
  return outputDeviceId;
}

/** Set by useAudioDeviceStore on hydrate and on every change. Long-lived
 *  targets (the call's shared AudioContext) re-apply through the listeners. */
export function setOutputDeviceId(id: string | null): void {
  const next = id || null;
  if (next === outputDeviceId) return;
  outputDeviceId = next;
  for (const fn of outputListeners) {
    try {
      fn(next);
    } catch {
      /* one bad listener must not stop the rest */
    }
  }
}

export function onOutputDeviceChange(fn: (id: string | null) => void): () => void {
  outputListeners.add(fn);
  return () => outputListeners.delete(fn);
}

/** Called once when a saved speaker turns out to be gone. */
export function setOutputGoneHandler(fn: (() => void) | null): void {
  onOutputGone = fn;
}

/**
 * Point a player at a speaker (`id`, default: the saved one). The system
 * default is the empty sink id. A saved device that is gone falls back to the
 * default and reports it once; anything else (no setSinkId on this build, a
 * transient failure) leaves the target on whatever it was playing to, which
 * is never worse than before this feature existed. Never rejects.
 */
export async function applyOutputSink(
  target: SinkTarget | null | undefined,
  id: string | null = outputDeviceId,
): Promise<void> {
  if (!target || typeof target.setSinkId !== 'function') return;
  const sink = id ?? '';
  // AudioContext.sinkId is '' or an id string; an element's is a string.
  if (typeof target.sinkId === 'string' && target.sinkId === sink) return;
  try {
    await target.setSinkId(sink);
  } catch (err) {
    if (!sink || !isDeviceGone(err)) return;
    try {
      await target.setSinkId('');
    } catch {
      /* stays where it was */
    }
    if (id === outputDeviceId) onOutputGone?.();
  }
}

/** Test seam: back to a fresh module. */
export function _resetAudioDevicesForTests(): void {
  outputDeviceId = null;
  onOutputGone = null;
  outputListeners.clear();
}
