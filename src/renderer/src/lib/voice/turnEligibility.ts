/**
 * Which companions on a call the voice director may hand a turn of its own
 * (261023, pulled out of useVoiceStore so the rule is pinned by a test).
 *
 * Two kinds of companion already have a brain driving them on the call, and a
 * director-made turn would run a second, blind one alongside it:
 *   - one in a live game session (260708): its game brain hears the call and
 *     speaks through say();
 *   - the one watching the player's screen (261023): backseat is her loop,
 *     with the screen in view. A screenless idle nudge or reaction turn made
 *     her talk over her own commentary about something unrelated to the game,
 *     and the idle nudge's end_call could hang up the call mid-share.
 * CLAUDE.md: anything that gives a companion a turn checks sharingFor first.
 */

/** The summon kinds that mean a live game session drives the companion. */
const IN_GAME = new Set(['online', 'connecting']);

export function directorMayDrive(
  id: string,
  summons: Record<string, { kind?: string } | undefined>,
  sharingFor: string | null,
): boolean {
  if (id === sharingFor) return false;
  return !IN_GAME.has(summons[id]?.kind ?? '');
}

/** Companions the idle starter may ask to break a quiet stretch. */
export function idleNudgeEligible(
  participants: string[],
  summons: Record<string, { kind?: string } | undefined>,
  sharingFor: string | null,
): string[] {
  return participants.filter((id) => directorMayDrive(id, summons, sharingFor));
}

/**
 * The pool decideReaction picks the next reactor from. The speaker stays in
 * it (decideReaction excludes the speaker itself and needs it to see the
 * room's size); everyone else must be director-drivable.
 */
export function reactorPool(
  participants: string[],
  speakerId: string,
  summons: Record<string, { kind?: string } | undefined>,
  sharingFor: string | null,
): string[] {
  return participants.filter((id) => id === speakerId || directorMayDrive(id, summons, sharingFor));
}




