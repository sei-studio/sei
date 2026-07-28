/**
 * gameLaunch — the ONE cross-launch gate for every game entry point (260721).
 *
 * Launching a game while ANOTHER game is active for the same companion must
 * always go through the same confirm popup ("X is still running. End it and
 * start Y?"), whether the launch comes from the games picker tile or from a
 * surface's own Launch/Start button. This module owns:
 *
 *   - activeGameFor()      which game (chess / Minecraft) is live for a
 *                          character, mirroring the IconRail activity-badge
 *                          definition;
 *   - endActiveGame()      each game's normal end path (chess writes its
 *                          unfinished history row via the store's end());
 *   - openGame()           the picker's open-a-surface routing (navigate to
 *                          chat + mount the right panel), clearing the other
 *                          surface's stale open-intent so the aside swaps;
 *   - requestGameLaunch()  the gate: runs the launch directly when nothing
 *                          else is active, otherwise parks the launch thunk
 *                          and opens the cross-launch confirm modal
 *                          (CrossLaunchConfirmModal calls back into
 *                          confirmCrossLaunch / cancelCrossLaunch).
 *
 * The pending launch is a module-level thunk (not modal payload) so the
 * useUiStore Modal union stays plain data.
 */

import { useUiStore } from './stores/useUiStore';
import { useDataStore } from './stores/useDataStore';
import { useChessStore } from './stores/useChessStore';
import { useDrawStore } from './stores/useDrawStore';
import { useBackseatStore } from './stores/useBackseatStore';
import { useMcDashboardStore } from './stores/useMcDashboardStore';
import { useWizardStore } from './stores/useWizardStore';
import { attemptSummon } from './summonFlow';
import { sei } from './ipcClient';

/** The launchable games (the picker's coming-soon tiles are never active). */
export type LaunchGameId = 'chess' | 'minecraft' | 'draw' | 'backseat';

export interface ActiveGameInfo {
  id: LaunchGameId;
  /** User-facing name for the confirm copy ("Chess", "Minecraft"). */
  name: string;
}

/**
 * Which game is currently ACTIVE for this character, if any. Matches the
 * IconRail badge semantics: a not-ended chess game (preparing or active) or a
 * live/connecting Minecraft summon. Open panels without a session (chess
 * launch card) do not count.
 */
export function activeGameFor(characterId: string): ActiveGameInfo | null {
  const chess = useChessStore.getState().games[characterId];
  if (chess && chess.status !== 'ended') return { id: 'chess', name: 'Chess' };
  const draw = useDrawStore.getState().games[characterId];
  // A game sitting on the setup screen is not yet active; the gallery is over.
  if (draw && draw.phase !== 'gallery' && draw.phase !== 'setup') {
    return { id: 'draw', name: 'Draw!' };
  }
  // Backseat has no panel of its own in the app: the session IS the overlay
  // window, so "active" is simply whether main reports a live session.
  if (useBackseatStore.getState().active[characterId]) {
    return { id: 'backseat', name: 'Backseat' };
  }
  const summon = useDataStore.getState().summons[characterId]?.kind;
  if (summon === 'online' || summon === 'connecting') {
    return { id: 'minecraft', name: 'Minecraft' };
  }
  return null;
}

/**
 * End a game through its normal end path, so side effects (chess's
 * unfinished-game history row, the bot stop) all still happen.
 */
export async function endActiveGame(characterId: string, id: LaunchGameId): Promise<void> {
  if (id === 'chess') {
    await useChessStore.getState().end(characterId);
    return;
  }
  if (id === 'draw') {
    await useDrawStore.getState().end(characterId);
    return;
  }
  if (id === 'backseat') {
    await useBackseatStore.getState().end(characterId);
    return;
  }
  // Minecraft: same instant-disconnect path the chat panel uses.
  useDataStore.getState().setStatus({ kind: 'idle', characterId });
  useMcDashboardStore.getState().setLaunch(characterId, false);
  try {
    await sei.stop(characterId);
  } catch {
    /* already stopped */
  }
}

/**
 * First-open Minecraft skin setup (260725). Game setup happens when a game is
 * FIRST opened, not during onboarding (the post-onboarding activity picker +
 * skin-setup page were removed). The first time this account opens the
 * Minecraft surface having never run skin setup, open the setup wizard over
 * the launch panel — the welcome step carries "Set up later", so it informs
 * rather than blocks, and it stays re-runnable from Settings. Gated by the
 * same profile-scoped wizardPromptShown flag the old first-summon nudge used,
 * so it shows at most once per account (users already nudged before this
 * change are not re-prompted).
 */
async function maybeOfferSkinSetup(): Promise<void> {
  try {
    const { shown } = await sei.wizardPromptShown('get');
    if (shown) return;
    const wiz = await sei.getWizardState();
    if (wiz.hasRunOnce) return;
    await sei.wizardPromptShown('set');
    useWizardStore.getState().openWizard(false);
  } catch {
    // Best-effort — never let setup bookkeeping block opening the game.
  }
}

/**
 * Open a game's surface in the chat game area (the picker tile action).
 * Clears the OTHER surfaces' open-intent first so the single aside swaps to
 * the requested game instead of staying on a stale panel (chess has top
 * precedence in ChatScreen's ordering). Never clears a LIVE session — the
 * cross-launch confirm has already ended it by the time this runs.
 */
export function openGame(characterId: string, gameId: LaunchGameId): void {
  // Backseat opens no surface here at all. Its entry point is the share picker
  // inside the games popup, and once started its only UI is the always-on-top
  // overlay window, so there is nothing to mount in the app.
  if (gameId === 'backseat') return;

  // Draw! is a full-page route of its own rather than a panel in the chat
  // game area, so it navigates instead of mounting an aside. Any stale chess
  // panel intent is dropped first so returning to chat later is clean.
  if (gameId === 'draw') {
    const chess = useChessStore.getState();
    const g = chess.games[characterId];
    if (!g || g.status === 'ended') void chess.end(characterId);
    useMcDashboardStore.getState().setLaunch(characterId, false);
    useUiStore.getState().navigate({ kind: 'draw', characterId });
    return;
  }

  useUiStore.getState().navigate({ kind: 'chat', characterId });
  const chess = useChessStore.getState();
  const dash = useMcDashboardStore.getState();

  if (gameId !== 'chess') {
    // Drop a gameless chess panel (launch card) or a finished game's result
    // screen; an ACTIVE game never reaches here un-ended.
    const g = chess.games[characterId];
    if (!g || g.status === 'ended') void chess.end(characterId);
  }
  if (gameId !== 'minecraft') dash.setLaunch(characterId, false);

  if (gameId === 'chess') {
    chess.openPanel(characterId);
  } else {
    if (useDataStore.getState().summons[characterId]?.kind !== 'online') {
      // Minecraft with a live bot needs no flag: the dashboard is always open
      // while the bot is online (no hide/minimize). Offline, open the launch
      // panel.
      dash.setLaunch(characterId, true);
    }
    // First Minecraft open for a never-set-up account → skin-setup wizard
    // over the launch panel (async, best-effort).
    void maybeOfferSkinSetup();
  }
}

/** The launch parked while the cross-launch confirm is up. */
let pendingLaunch: (() => void) | null = null;

/**
 * Gate a game launch on the cross-launch confirm. Runs `launch` directly when
 * no OTHER game is active for this character (re-launching the same game is
 * always direct); otherwise parks it and opens the confirm modal.
 */
export function requestGameLaunch(
  characterId: string,
  to: ActiveGameInfo,
  launch: () => void,
): void {
  const active = activeGameFor(characterId);
  if (!active || active.id === to.id) {
    launch();
    return;
  }
  pendingLaunch = launch;
  useUiStore.getState().openModal({
    kind: 'cross-launch',
    characterId,
    fromId: active.id,
    fromName: active.name,
    toName: to.name,
  });
}

/** Confirm: end the previous game via its normal path, then run the launch. */
export async function confirmCrossLaunch(
  characterId: string,
  fromId: LaunchGameId,
): Promise<void> {
  const launch = pendingLaunch;
  pendingLaunch = null;
  await endActiveGame(characterId, fromId);
  useUiStore.getState().closeModal();
  launch?.();
}

/** Cancel: drop the parked launch and close the confirm. */
export function cancelCrossLaunch(): void {
  pendingLaunch = null;
  useUiStore.getState().closeModal();
}
