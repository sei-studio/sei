/**
 * Microphone settings (261127, in-app feedback: "no microphone settings, mic
 * settings would be AMAZING").
 *
 * Settings > Microphone stores two choices on the account's config
 * (UserConfig, so they follow the account like the other voice settings):
 *
 *   mic_device_id    the input device. Absent (or '') is the system default.
 *   mic_sensitivity  0..100, default 50. Maps onto the energy VAD's open
 *                    threshold (dictation.ts): higher means quieter sounds
 *                    start a turn, lower means only clear speech does. 50 is
 *                    exactly the threshold every build before this one used.
 *
 * Every capture of the PLAYER'S voice opens the mic through openMicStream
 * (today that is the call dictation; backseat's getUserMedia calls capture
 * the screen and desktop audio, not the mic). A saved device that is gone
 * (unplugged, renamed by the OS) falls back to the system default and says
 * so once, instead of failing the call.
 *
 * Pure helpers plus one injectable opener, so the fallback rule is testable
 * without a browser.
 */

export const MIC_SENSITIVITY_DEFAULT = 50;
export const MIC_SENSITIVITY_MIN = 0;
export const MIC_SENSITIVITY_MAX = 100;

export interface MicPrefs {
  mic_device_id?: string;
  mic_sensitivity?: number;
}

/** A sensitivity value as stored: an integer in range, else the default. */
export function micSensitivityOf(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return MIC_SENSITIVITY_DEFAULT;
  return Math.round(Math.min(MIC_SENSITIVITY_MAX, Math.max(MIC_SENSITIVITY_MIN, v)));
}

/**
 * The multiplier on the VAD's speech-open threshold. 50 → 1 (unchanged),
 * 0 → 2 (a sound must be twice as loud, about +6 dB), 100 → 0.5. Log-scaled
 * so each step of the slider is the same loudness change.
 */
export function micGateScale(sensitivity: unknown): number {
  const s = micSensitivityOf(sensitivity);
  return Math.pow(2, (MIC_SENSITIVITY_DEFAULT - s) / 50);
}

/** The bucket a sensitivity value is reported as (analytics: no raw values). */
export function micSensitivityBucket(sensitivity: unknown): 'low' | 'default' | 'high' {
  const s = micSensitivityOf(sensitivity);
  if (s === MIC_SENSITIVITY_DEFAULT) return 'default';
  return s < MIC_SENSITIVITY_DEFAULT ? 'low' : 'high';
}

/** The saved device id, or undefined for the system default. 'default' is
 * Chromium's own id for the system default, so it counts as none. */
export function micDeviceIdOf(v: unknown): string | undefined {
  return typeof v === 'string' && v && v !== 'default' ? v : undefined;
}

/**
 * The getUserMedia audio constraints every player-mic capture uses. The
 * processing flags are the call's (dictation.ts explains each): echo
 * cancellation is load-bearing for barge-in, AGC stays off for the energy
 * VAD. `deviceId` is exact so a missing device fails loudly (and falls back,
 * see openMicStream) instead of silently opening another one.
 */
export function micAudioConstraints(deviceId?: string): MediaTrackConstraints {
  return {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: false,
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  };
}

/** A getUserMedia failure that means "that device is not here", as opposed
 * to a refusal or a device held by another app. */
export function isMissingDevice(err: unknown): boolean {
  const name = (err as { name?: string })?.name ?? '';
  return name === 'OverconstrainedError' || name === 'NotFoundError';
}

export type GetUserMedia = (c: MediaStreamConstraints) => Promise<MediaStream>;

/**
 * Open the player's mic. With a saved device, try it first; if it is missing,
 * open the system default and report `fellBack`. Any other failure (a
 * refusal, a busy device) is thrown as it is, for the caller's existing
 * handling. A missing device with no default either rethrows the default's
 * error.
 */
export async function openMicStream(
  deviceId: string | undefined,
  getUserMedia: GetUserMedia = (c) => navigator.mediaDevices.getUserMedia(c),
): Promise<{ stream: MediaStream; fellBack: boolean }> {
  const id = micDeviceIdOf(deviceId);
  if (id) {
    try {
      return { stream: await getUserMedia({ audio: micAudioConstraints(id) }), fellBack: false };
    } catch (err) {
      if (!isMissingDevice(err)) throw err;
    }
    return { stream: await getUserMedia({ audio: micAudioConstraints() }), fellBack: true };
  }
  return { stream: await getUserMedia({ audio: micAudioConstraints() }), fellBack: false };
}

export interface MicDevice {
  deviceId: string;
  /** Empty until the app has mic permission (a browser rule). */
  label: string;
}

/**
 * The audio inputs worth listing: no duplicate of the system default
 * ('default', and Windows' 'communications' alias), each id once.
 */
export function listMicDevices(
  devices: ReadonlyArray<{ kind?: string; deviceId: string; label: string }>,
): MicDevice[] {
  const out: MicDevice[] = [];
  const seen = new Set<string>();
  for (const d of devices) {
    if (d.kind !== undefined && d.kind !== 'audioinput') continue;
    if (!d.deviceId || d.deviceId === 'default' || d.deviceId === 'communications') continue;
    if (seen.has(d.deviceId)) continue;
    seen.add(d.deviceId);
    out.push({ deviceId: d.deviceId, label: d.label ?? '' });
  }
  return out;
}
