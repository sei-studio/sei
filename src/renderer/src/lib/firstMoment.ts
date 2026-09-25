/**
 * The guided first moment (260926): pure decisions, no stores.
 *
 * When a NEW player finishes onboarding, their first stop after Sui's tour is
 * a live exchange with their companion instead of the Home screen: the chat
 * opens, the companion greets first (the normal first-meeting greeting, told
 * to end on an offer to play), and a small card under the greeting offers the
 * next step as buttons. Analytics (260926) showed 24% of new installs never
 * used any surface and none of them came back, with a median 9 minutes from
 * launch to first use.
 *
 * Kept pure so the trigger rules are unit-tested without React or IPC; the
 * state machine lives in lib/stores/useFirstMomentStore.ts and the card in
 * components/FirstMomentCard.tsx.
 */
import type { FirstMomentGame } from '@shared/ipc';

/** What the player can click on the card. `dismiss` is the "Not now" link. */
export type FirstMomentAction = FirstMomentGame | 'call' | 'dismiss';

export interface FirstMomentPlan {
  /** The game the companion invites to, and the accent button. */
  primary: FirstMomentGame;
  /** Whether the card offers Minecraft at all. */
  minecraft: boolean;
}

/**
 * Which companion the first moment is with, or null for none.
 *
 * Only the NEW-user completion of the Sui scene gets one, which is exactly the
 * completion that arms the tutorial (`tutorial: true`). A returning sign-in
 * completes with `tutorial: false` (whether it came from the sign-in panel or
 * from the new branch landing on an existing account), so it never does. A
 * generated companion is the natural partner; when generation was skipped or
 * failed, Sui (seeded into every fresh profile) stands in.
 */
export function firstMomentCompanion(
  res: { tutorial: boolean; characterId: string | null },
  fallbackId: string,
): string | null {
  if (!res.tutorial) return null;
  return res.characterId ?? fallbackId;
}

/**
 * Which games the card offers. Chess needs no install, so it leads for
 * everyone except a player who already has a Minecraft LAN world open. The
 * Minecraft button only shows when it can go somewhere: a world is open, or a
 * Minecraft install was found on this machine (the launch panel then walks
 * them through setup). Someone with no Minecraft never sees it.
 */
export function planFirstMoment(env: { lanOpen: boolean; mcInstalled: boolean }): FirstMomentPlan {
  return {
    primary: env.lanOpen ? 'minecraft' : 'chess',
    minecraft: env.lanOpen || env.mcInstalled,
  };
}

/** The card's buttons in display order: primary game first, then the other
 *  game when offered, then the call. */
export function firstMomentButtons(plan: FirstMomentPlan): Array<Exclude<FirstMomentAction, 'dismiss'>> {
  const games: FirstMomentGame[] =
    plan.primary === 'minecraft' ? ['minecraft', 'chess'] : plan.minecraft ? ['chess', 'minecraft'] : ['chess'];
  return [...games, 'call'];
}
