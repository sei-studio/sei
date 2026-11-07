/**
 * The Home "up next" card (261013, retention O2 / T119): which card to show,
 * what its button does, and its two analytics events.
 *
 * Main answers each Home character's saved "Plan for next time" (or newest
 * active goal) through `home:next-steps` (src/main/homeNextStep.ts). The card
 * shows ONE of them: the first character in Home order (most recent
 * interaction first) that has a plan, else the first that has a goal. A
 * character already in a game or a call with the player is skipped; the card
 * is about coming back, not about the session running now.
 *
 * The button reuses the launch paths the Home tiles already use, so nothing
 * past the click is card specific and the session's own greeting picks the
 * plan up the way it always does:
 *   - a bot game: the cross-launch gate + openGame (the games picker tile path,
 *     which opens that game's launch panel in the chat);
 *   - a backseat game (Roblox): the same gate + its game modal;
 *   - a call (or a plain screen share, which starts from a call): the top
 *     bar's phone button path, startOrOpenCall;
 *   - not recorded: the games picker, the Home panel's Play button.
 *
 * Events are shape only, never the plan text:
 *   home_next_step_shown   {character_id, source, age_hours, surface, game?}
 *   home_next_step_clicked {same}
 * `shown` fires once per card per app session (a return to Home does not
 * count it again), so shown vs clicked and D1 can be compared per card.
 */
import type { HomeNextStep } from '@shared/homeNextStep';
import type { GameId } from '@shared/gameIpc';
import { backseatGame, isBackseatGameId } from '@shared/backseatGames';
import { botGameName, isBotGame, openGame, requestGameLaunch } from './gameLaunch';
import { startOrOpenCall } from './callLaunch';
import { useUiStore } from './stores/useUiStore';
import { sei } from './ipcClient';
import { t } from './i18n';

export type NextStepTarget =
  | { kind: 'game'; game: GameId }
  | { kind: 'backseat'; gameId: string }
  | { kind: 'call' }
  | { kind: 'chat' }
  | { kind: 'picker' };

/** What the card's button opens for this step. */
export function nextStepTarget(step: HomeNextStep): NextStepTarget {
  if (step.surface === 'game' && isBotGame(step.game)) return { kind: 'game', game: step.game };
  if (step.surface === 'backseat') {
    if (isBackseatGameId(step.game)) return { kind: 'backseat', gameId: step.game as string };
    return { kind: 'call' };
  }
  if (step.surface === 'call') return { kind: 'call' };
  // 261107: a plan from a text chat (not about a game) opens that chat.
  if (step.surface === 'chat') return { kind: 'chat' };
  return { kind: 'picker' };
}

export { nameInSentence } from '@shared/homeNextStep';

/** The button label for a target ("Play Minecraft", "Call Sui", "Play"). */
export function nextStepButtonLabel(
  target: NextStepTarget,
  name: string,
  t: (en: string, params?: Record<string, string | number>) => string,
): string {
  if (target.kind === 'game') return t('Play {game}', { game: botGameName(target.game) });
  if (target.kind === 'backseat') return t('Play {game}', { game: t(backseatGame(target.gameId)?.name ?? target.gameId) });
  if (target.kind === 'call') return t('Call {name}', { name });
  if (target.kind === 'chat') return t('Message {name}', { name });
  return t('Play');
}

/**
 * The one card to show: the first id (Home order) with a plan, else the
 * first with a goal. `busy` ids (in a session with the player) are skipped.
 */
export function chooseHomeNextStep(
  orderedIds: readonly string[],
  steps: Readonly<Record<string, HomeNextStep>>,
  busy: (id: string) => boolean = () => false,
  dismissed: ReadonlySet<string> = new Set(),
): HomeNextStep | null {
  const usable = orderedIds
    .map((id) => steps[id])
    .filter((s): s is HomeNextStep => !!s && !busy(s.characterId) && !dismissed.has(nextStepKey(s)));
  return usable.find((s) => s.source === 'plan') ?? usable.find((s) => s.source === 'goal') ?? null;
}

/** Identity of one card: a new plan or goal is a new card. */
export function nextStepKey(step: HomeNextStep): string {
  return `${step.characterId}:${step.source}:${step.at}`;
}

export type NextStepEventProps = Record<string, string | number> & {
  character_id: string;
  source: 'plan' | 'goal';
  age_hours: number;
  surface: string;
};

export function nextStepEventProps(step: HomeNextStep, now: number = Date.now()): NextStepEventProps {
  const ageHours = Math.max(0, Math.round(((now - step.at) / 3_600_000) * 10) / 10);
  return {
    character_id: step.characterId,
    source: step.source,
    age_hours: ageHours,
    surface: step.surface ?? 'unknown',
    ...(step.game ? { game: step.game } : {}),
  };
}

function track(event: string, props: Record<string, string | number>): void {
  try {
    sei.track(event, props);
  } catch {
    /* analytics must never disrupt the flow */
  }
}

const shownKeys = new Set<string>();

/** The card rendered. Fires home_next_step_shown once per card per app session. */
export function trackNextStepShown(step: HomeNextStep, now: number = Date.now()): boolean {
  const key = nextStepKey(step);
  if (shownKeys.has(key)) return false;
  shownKeys.add(key);
  track('home_next_step_shown', nextStepEventProps(step, now));
  return true;
}

/** Account switch and tests: forget which cards were already counted. */
export function resetNextStepShown(): void {
  shownKeys.clear();
}

/** The card's button: count the click, then open the step's surface. */
export function launchHomeNextStep(step: HomeNextStep, now: number = Date.now()): void {
  track('home_next_step_clicked', nextStepEventProps(step, now));
  const id = step.characterId;
  const target = nextStepTarget(step);
  if (target.kind === 'game') {
    const game = target.game;
    requestGameLaunch(id, { id: game, name: botGameName(game) }, () => openGame(id, game));
  } else if (target.kind === 'backseat') {
    const gameId = target.gameId;
    requestGameLaunch(id, { id: 'backseat', name: t(backseatGame(gameId)?.name ?? gameId) }, () =>
      useUiStore.getState().openModal({ kind: 'backseat-game', characterId: id, gameId }),
    );
  } else if (target.kind === 'call') {
    startOrOpenCall(id);
  } else if (target.kind === 'chat') {
    useUiStore.getState().navigate({ kind: 'chat', characterId: id });
  } else {
    useUiStore.getState().openModal({ kind: 'games-picker', characterId: id });
  }
}
