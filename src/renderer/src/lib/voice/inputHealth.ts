/**
 * Why a call did not hear the player (261118), for `voice_call_input_check`.
 *
 * PostHog, 21 days to 261118: 17% of Windows Sei Cloud callers (87 of 511,
 * calls over 20 s) never had ONE transcription request reach the proxy, on
 * any call, against 1 of 23 on Mac. Their cloud TTS worked (same JWT, same
 * network), and their calls show no barge-in ducks at all while heard users
 * duck on two calls in three. So the client never cut an utterance: the VAD
 * saw silence or no audio. The proxy and the encoder are not the problem.
 *
 * The mic-picker work (voice_call_ended input_peak_heard / stt_requests)
 * says WHETHER a call heard anything. This says WHY NOT, from counters the
 * dictation keeps (Dictation.inputHealth):
 *
 *   no_frames            the capture worklet delivered nothing: the
 *                        AudioContext clock is not running (suspended, or
 *                        stalled when the output device changed)
 *   muted                every frame arrived while the player was muted
 *   digital_silence      frames are exact zeros: Windows "Let desktop apps
 *                        access your microphone" off, or a disabled or
 *                        virtual default device with nothing behind it
 *   quiet                audio, but never loud enough to open speech (a quiet
 *                        or wrong mic; AGC is off on calls)
 *   speech_no_utterance  speech opened but no utterance came out (every
 *                        transcript empty, junk, or failed)
 *   heard                at least one utterance reached the call
 *
 * Shape only: no levels beyond a coarse dB bucket, no device labels or ids.
 */

/** Running counters from the dictation (never reset during a call). */
export interface DictationInputHealth {
  /** Worklet frames received, muted or not. */
  frames: number;
  /** Frames received while not muted. */
  unmutedFrames: number;
  /** Unmuted frames that were (near) exact digital zero. */
  zeroFrames: number;
  /** Loudest unmuted frame RMS. */
  peakRms: number;
  /** Times the VAD opened speech (outside companion playback). */
  speechOpens: number;
  /** The capture track: 'live' | 'ended', and whether the OS muted it. */
  trackState: string;
  trackMuted: boolean;
  /** The capture AudioContext's state and rate. */
  ctxState: string;
  sampleRate: number;
  /** The capture track's label. Read ONLY by looksVirtualInput here; never
   *  sent anywhere. */
  trackLabel: string;
}

export type InputState =
  | 'no_frames'
  | 'muted'
  | 'digital_silence'
  | 'quiet'
  | 'speech_no_utterance'
  | 'heard';

/** A frame at or below this RMS is digital silence (a live mic's own noise
 * floor sits around 1e-4 even in a quiet room). */
export const ZERO_FRAME_RMS = 1e-5;
/** The VAD's floor for opening speech (dictation START_RMS_FLOOR). */
const SPEECH_FLOOR_RMS = 0.012;

export function classifyInputHealth(h: DictationInputHealth, utterances: number): InputState {
  if (utterances > 0) return 'heard';
  if (h.frames === 0) return 'no_frames';
  if (h.unmutedFrames === 0) return 'muted';
  if (h.zeroFrames >= h.unmutedFrames * 0.98) return 'digital_silence';
  if (h.speechOpens === 0 || h.peakRms < SPEECH_FLOOR_RMS) return 'quiet';
  return 'speech_no_utterance';
}

/** Peak level as a coarse dBFS bucket (10 dB steps, floor -100). */
export function peakDbBucket(rms: number): number {
  if (!(rms > 0)) return -100;
  const db = 20 * Math.log10(rms);
  return Math.max(-100, Math.min(0, Math.floor(db / 10) * 10));
}

/** Labels of devices that are often the Windows default with nothing behind
 * them (virtual mixers, streaming and voice-effect drivers, disabled stereo
 * mix). Matched on the label only to set a boolean; the label never leaves. */
const VIRTUAL_INPUT =
  /steam streaming|voicemeeter|vb-audio|cable output|virtual|nvidia broadcast|krisp|voicemod|stereo mix|\bobs\b|wave link|droidcam|\bcamo\b/i;

export function looksVirtualInput(label: string | undefined | null): boolean {
  return !!label && VIRTUAL_INPUT.test(label);
}

/** The analytics props for one check. */
export function inputCheckProps(input: {
  health: DictationInputHealth;
  utterances: number;
  liveMs: number;
  inputDevices: number;
  cloudSttOff: string | null;
}): Record<string, string | number | boolean> {
  const { health: h } = input;
  return {
    input_state: classifyInputHealth(h, input.utterances),
    live_s: Math.round(input.liveMs / 1000),
    frames_per_s: input.liveMs > 0 ? Math.round((h.frames / input.liveMs) * 1000 * 10) / 10 : 0,
    zero_share: h.unmutedFrames > 0 ? Math.round((h.zeroFrames / h.unmutedFrames) * 100) / 100 : 0,
    peak_db: peakDbBucket(h.peakRms),
    speech_opens: h.speechOpens,
    utterances: input.utterances,
    track_state: h.trackState,
    track_muted: h.trackMuted,
    ctx_state: h.ctxState,
    sample_rate: h.sampleRate,
    virtual_input: looksVirtualInput(h.trackLabel),
    input_devices: input.inputDevices,
    cloud_stt_off: input.cloudSttOff ?? 'none',
  };
}
