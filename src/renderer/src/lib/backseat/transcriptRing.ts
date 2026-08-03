/**
 * Backseat transcript ring (260728) — pure policy, no workers, no clocks.
 *
 * The transcript is ALWAYS STREAMING: Whisper transcribes the game audio in
 * small rolling chunks for the whole session, and the results live here as
 * timed segments. A tick then just reads the window it cares about. The
 * alternative — transcribing the grid's 6 seconds on demand when a tick fires
 * — would put one to two seconds of Whisper latency in front of every tick;
 * with the ring, a tick waits only for a bounded flush of the in-progress
 * tail (STT_FLUSH_WAIT_MS).
 *
 * The glue that owns the worker is sttStream.ts; everything here is the part
 * worth testing: segment retention, window selection, the char cap, and the
 * dispatch policy.
 */

export interface TranscriptSegment {
  /** Wall-clock bounds of the audio this text came from. */
  t0: number;
  t1: number;
  text: string;
}

/**
 * Append a segment and prune everything older than keepMs. Mutates and
 * returns `segments`. Empty text is the caller's job to skip; keeping the
 * function total makes the tests simpler.
 */
export function pushSegment(
  segments: TranscriptSegment[],
  seg: TranscriptSegment,
  now: number,
  keepMs: number,
): TranscriptSegment[] {
  segments.push(seg);
  while (segments.length && now - segments[0].t1 > keepMs) segments.shift();
  return segments;
}

/**
 * The text a tick ships: every segment that OVERLAPS [now - spanMs, now],
 * oldest first, joined with spaces. Overlap (not containment) is deliberate —
 * a sentence that started just before the window opened is still what the
 * player is hearing during it.
 *
 * The char cap drops the OLDEST text first: the tail of the window is closest
 * to the moment the tick is about, so it is the part worth keeping when a
 * dialogue-heavy video overflows the budget.
 */
export function windowText(
  segments: TranscriptSegment[],
  now: number,
  spanMs: number,
  maxChars: number,
): string {
  const from = now - spanMs;
  const parts = segments.filter((s) => s.t1 >= from && s.t0 <= now).map((s) => s.text.trim());
  let joined = parts.filter(Boolean).join(' ');
  if (joined.length > maxChars) {
    joined = joined.slice(joined.length - maxChars);
    // Do not ship half a word at the seam.
    const firstSpace = joined.indexOf(' ');
    if (firstSpace > 0 && firstSpace < 40) joined = joined.slice(firstSpace + 1);
  }
  return joined;
}

/**
 * When to hand the accumulated audio to Whisper. Steady state waits for a
 * full chunk; a flush (a tick wants the transcript NOW) takes any tail long
 * enough to plausibly contain a word — shorter than minFlushMs only feeds
 * Whisper's hallucinations. Single flight: never dispatch over a running job;
 * audio keeps accumulating and the next dispatch carries it all.
 */
export function wantDispatch(args: {
  pendingMs: number;
  busy: boolean;
  flush: boolean;
  chunkMs: number;
  minFlushMs: number;
}): boolean {
  if (args.busy) return false;
  if (args.flush) return args.pendingMs >= args.minFlushMs;
  return args.pendingMs >= args.chunkMs;
}
