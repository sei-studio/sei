/**
 * Was the player heard on this call? (261118), for `voice_call_ended`.
 *
 * Before this, "the companion talks but never hears me" could only be
 * estimated by joining cloud calls to the proxy's hourly STT cost rows, which
 * says nothing about local or BYOK calls. These four props answer it on every
 * path. Shape only: counts, a boolean and a fixed path token. No transcript
 * text, no audio levels, no device ids or labels.
 *
 *   player_utterances  the player's finished transcripts the call accepted as
 *                      a turn (after the echo gate and the junk filter)
 *   stt_requests       transcription passes started, on any engine: one per
 *                      utterance plus provisional and barge-in passes
 *   input_peak_heard   some unmuted mic frame reached the speech floor
 *                      (dictation INPUT_SIGNAL_RMS); false = the mic delivered
 *                      silence or a faint hiss the whole time
 *   stt_path           who transcribed: 'cloud' (Sei's STT through the proxy),
 *                      'byok' (the player's own ElevenLabs key), 'local'
 *                      (Whisper or SenseVoice on this machine only)
 *
 * The mic is shared by everyone on a group call; like the interrupt counts,
 * each companion's row carries the slice since that companion went live.
 */
import { z } from 'zod';

export const STT_PATHS = ['cloud', 'byok', 'local'] as const;
export type SttPath = (typeof STT_PATHS)[number];

export interface CallHearing {
  player_utterances: number;
  stt_requests: number;
  input_peak_heard: boolean;
  stt_path: SttPath;
}

/** The IPC shape main accepts. Unknown keys are dropped, so nothing but these
 *  four fields can ride along into analytics. */
export const CallHearingSchema = z.object({
  player_utterances: z.number().int().nonnegative(),
  stt_requests: z.number().int().nonnegative(),
  input_peak_heard: z.boolean(),
  stt_path: z.enum(STT_PATHS),
});

/** The `voice_call_ended` props. A call main closed itself (quit, account
 *  switch) has no renderer report and leaves them out rather than send zeros,
 *  which would read as "never heard". */
export function callHearingProps(h: CallHearing | undefined): Partial<CallHearing> {
  if (!h) return {};
  return {
    player_utterances: h.player_utterances,
    stt_requests: h.stt_requests,
    input_peak_heard: h.input_peak_heard,
    stt_path: h.stt_path,
  };
}
