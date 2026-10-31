/**
 * Interrupt diagnostics for `voice_call_ended` (261030).
 *
 * The 0.6.10 "It doesnt let me interrupt it" report could not be answered
 * from analytics: nothing said whether the player had tried at all, whether
 * the mic ever ducked her, or whether the echo gate threw the attempt away.
 * These four counts, per companion and per call, are that answer. Counts
 * only: no text, no timings, no audio levels.
 *
 *   ducks          stage one fired (playback ducked on a mic level spike)
 *   cuts           a voice barge-in was confirmed and cut the line
 *   echo_rejected  a duck was retracted because the echo gate traced the
 *                  confirming words to the speakers (her TTS or the share)
 *   manual         the player pressed the interrupt control or its shortcut
 *   no_voice       (261031) a duck was retracted because nothing that sounded
 *                  like a voice followed it (no transcription was run)
 *   no_word        (261031) a duck was retracted because the confirming
 *                  transcription found no word
 */
export interface CallInterruptCounts {
  ducks: number;
  cuts: number;
  echo_rejected: number;
  manual: number;
  no_voice: number;
  no_word: number;
}

export const CALL_INTERRUPT_KEYS = ['ducks', 'cuts', 'echo_rejected', 'manual', 'no_voice', 'no_word'] as const;

export function zeroInterruptCounts(): CallInterruptCounts {
  return { ducks: 0, cuts: 0, echo_rejected: 0, manual: 0, no_voice: 0, no_word: 0 };
}

/** The `voice_call_ended` props, prefixed so they group in the dashboard. */
export function callInterruptProps(c: CallInterruptCounts): {
  interrupt_ducks: number;
  interrupt_cuts: number;
  interrupt_echo_rejected: number;
  interrupt_manual: number;
  interrupt_no_voice: number;
  interrupt_no_word: number;
} {
  return {
    interrupt_ducks: c.ducks,
    interrupt_cuts: c.cuts,
    interrupt_echo_rejected: c.echo_rejected,
    interrupt_manual: c.manual,
    interrupt_no_voice: c.no_voice,
    interrupt_no_word: c.no_word,
  };
}
