/**
 * Which companion line a voice barge-in cut off (261112).
 *
 * A confirmed barge-in stops the audio in the renderer, and the player's words
 * then reach the companion as an ordinary line. An in-game companion never
 * learned it had been cut off, so "stop" or "wait" said over her line read as
 * an order to drop what she was doing (mid-chase she stopped following and
 * went quiet for two minutes; product call 261112, free user report).
 *
 * The tracker remembers the line that was audible when the barge-in was
 * confirmed, and hands it to the player's utterance that caused it, so that
 * utterance can be sent to that one companion marked as an interruption. Pure
 * and synchronous so the pairing rules are testable without a call.
 */

/** A cut that no utterance claimed within this window is dropped. The words
 * that confirm a barge-in arrive within a few seconds (dictation commits them
 * right after onBargeIn); anything later is a new turn, not the cut-in. */
export const CUT_LINE_MAX_AGE_MS = 20_000;

/** Longest cut line carried to the companion (it only needs to recognise it). */
export const CUT_LINE_MAX_CHARS = 300;

export interface CutLine {
  /** The companion whose line was audible when the player cut in. */
  speakerId: string;
  /** What she was saying (the audible clip's text), possibly empty. */
  line: string;
  /** Wall clock of the confirmed barge-in. */
  at: number;
}

export interface CutTracker {
  /** A voice barge-in was confirmed while `speakerId` was audibly speaking. */
  note(speakerId: string | null | undefined, line: string | null | undefined, at: number): void;
  /**
   * The player's next utterance arrived. Returns the cut it caused, or null.
   * Consumes the pending cut either way: only the first utterance after a
   * cut can be the words that made it. `span` is the utterance's wall-clock
   * audio window; an utterance that began after the cut is not the cut-in.
   */
  take(now: number, span?: { t0: number; t1: number }): CutLine | null;
  clear(): void;
}

export function createCutTracker(): CutTracker {
  let pending: CutLine | null = null;
  return {
    note(speakerId, line, at) {
      if (!speakerId) {
        pending = null;
        return;
      }
      pending = { speakerId, line: String(line ?? '').trim().slice(0, CUT_LINE_MAX_CHARS), at };
    },
    take(now, span) {
      const p = pending;
      pending = null;
      if (!p) return null;
      if (now - p.at > CUT_LINE_MAX_AGE_MS) return null;
      if (span && Number.isFinite(span.t0) && span.t0 > p.at) return null;
      return p;
    },
    clear() {
      pending = null;
    },
  };
}
