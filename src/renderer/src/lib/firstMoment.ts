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
  /** What the companion invites to, and the accent button. */
  primary: FirstMomentGame;
  /** Whether the card offers Minecraft at all. */
  minecraft: boolean;
  /** Whether the card offers Backseat (a screen share) at all. */
  backseat: boolean;
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
 * Which games the card offers (261023).
 *
 * Backseat leads for everyone except a player who already has a Minecraft LAN
 * world open. It needs no install and works over any game, and it is what most
 * new players came for: on fresh 0.6.8 installs (10-10 to 10-22) it was the
 * first activity for 80 people against 27 for Minecraft and 15 for chess, the
 * site page they downloaded from most after the home page is
 * /ai-backseat-gamer, and the old chess lead was tapped by 13 of the 258
 * people who saw it. Backseat is left out only when the model cannot see
 * images (a confident 'no' from the vision probe), and then chess leads, since
 * it also needs no install. The Minecraft button only shows when it can go
 * somewhere: a world is open, or a Minecraft install was found on this machine
 * (the launch panel then walks them through setup). Someone with no Minecraft
 * never sees it.
 */
export function planFirstMoment(env: {
  lanOpen: boolean;
  mcInstalled: boolean;
  backseatOk: boolean;
}): FirstMomentPlan {
  return {
    primary: env.lanOpen ? 'minecraft' : env.backseatOk ? 'backseat' : 'chess',
    minecraft: env.lanOpen || env.mcInstalled,
    backseat: env.backseatOk,
  };
}

/** The card's buttons in display order: the primary first, then the other
 *  offered options in a fixed order (Backseat, Minecraft, chess), then the
 *  call. Chess and the call are always offered. */
export function firstMomentButtons(plan: FirstMomentPlan): Array<Exclude<FirstMomentAction, 'dismiss'>> {
  const offered: FirstMomentGame[] = [
    ...(plan.backseat ? (['backseat'] as const) : []),
    ...(plan.minecraft ? (['minecraft'] as const) : []),
    'chess',
  ];
  const rest = offered.filter((g) => g !== plan.primary);
  return [plan.primary, ...rest, 'call'];
}




