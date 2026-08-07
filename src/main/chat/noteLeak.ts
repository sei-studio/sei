/**
 * The note-leak gate (260807).
 *
 * On chat-family surfaces the model's text output IS the spoken line — there
 * is no say() split like the Minecraft bot's, so there is no legitimate place
 * for the model to think out loud. That contract holds on tool-free turns and
 * breaks specifically on turns that CALL remember(): filing a memory puts
 * Haiku in "working" mode and its text block slips into scratchpad register.
 * Live capture (backseat, 260807): the remember() tool input was correct and
 * honored, and the SPOKEN line was "character note: sei's curious, wants me to
 * narrate... i'll stay in character but actually look", then two turns later
 * "remember sei's into watching other people play...". Both went through TTS
 * and persisted as chat rows.
 *
 * Same family as stripDashes and isSilenceFiller: the tool description asks
 * for the right thing ("call it alongside your normal reply") and the model
 * violates it anyway, so the fix is mechanical, after the fact, where it
 * cannot fail. The cost of a catch is one silent turn, which the next tick
 * repairs seconds later; the cost of a miss is the companion reading its
 * private notes aloud.
 *
 * Two tiers, deliberately asymmetric:
 * - "character note:" / "note to self" openers are NEVER a line a person says
 *   to someone, so they drop unconditionally.
 * - A "remember ..." opener is only condemned when a remember() call actually
 *   rode the same turn (the caller passes that), and only when what follows is
 *   not addressed to the player — "remember when we...", "remember, you
 *   gotta..." are real spoken lines and stay. Without the tool-call context
 *   the remember tier never fires, so a streamed sentence (where tool_use may
 *   not have arrived yet) is only ever checked against the first tier.
 */

const NOTE_RE = /^[\s("'“‘]*((character|internal|mental|memory|private)\s+note|note to self)\b/i;

/**
 * Words after "remember" that mark speech TO the player rather than a note
 * about them. Anything else in that slot (a name, he/she/they) while a memory
 * was being filed reads as the note register.
 */
const REMEMBER_SPEECH_NEXT = new Set([
  'when', 'that', 'this', 'those', 'these', 'what', 'how', 'why', 'where', 'who',
  'you', "you're", 'your', 'yours', 'we', "we're", 'us', 'our', 'the', 'it', "it's",
  'if', 'to', 'i', "i'm", 'me', 'back', 'last', 'earlier', 'all', 'not', 'no',
]);

/**
 * True when a reply part is the model's private note rather than a line to the
 * player. `rememberCalled` = a remember tool_use was present on this turn.
 */
export function isNoteLeak(part: string, rememberCalled: boolean): boolean {
  const t = part.trim();
  if (!t) return false;
  if (NOTE_RE.test(t)) return true;
  if (!rememberCalled) return false;
  const m = /^[\s("'“‘]*remember\b[,:]?\s+(\S+)/i.exec(t);
  if (!m) return false;
  const next = m[1].toLowerCase().replace(/[^a-z']/g, '');
  return next.length > 0 && !REMEMBER_SPEECH_NEXT.has(next);
}
