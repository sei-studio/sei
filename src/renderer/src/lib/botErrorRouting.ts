/**
 * botErrorRouting — which modal (if any) a terminal BotStatus error opens
 * (game adapters M0, 260908). Keyed by (game, errorClass).
 *
 * Minecraft's table is the pre-M0 routing from useDataStore.wireIpc, moved
 * here unchanged: UNSUPPORTED_MC_VERSION, LAN_NOT_OPEN and MODDED_HOST_REJECTED
 * have dedicated modals, and everything else that died MID-SESSION opens the
 * crash popup. The generic table covers the game-neutral GAME_* classes with
 * one GameErrorModal carrying ERROR_COPY, and any other game's mid-session
 * death gets the same crash popup.
 *
 * Pure so it can be tested without the store.
 */
import type { BotStatus } from '@shared/ipc';
import type { ErrorClass } from '@shared/errorClasses';
import type { GameId } from '@shared/gameIpc';
import type { Modal } from './stores/useUiStore';

type ErrorStatus = Extract<BotStatus, { kind: 'error' }>;
type Route = (status: ErrorStatus, game: GameId) => Modal;

const MINECRAFT_ROUTES: Partial<Record<ErrorClass, Route>> = {
  // 260709 — unsupported world version gets a popup, not just a model-row
  // status: the Play flow otherwise fails with no visible feedback.
  UNSUPPORTED_MC_VERSION: (s) => ({ kind: 'unsupported-version', characterId: s.characterId, message: s.message }),
  // 260720 — LAN_NOT_OPEN failures open the popup with numbered "open to
  // LAN" steps instead of only the model-row line.
  LAN_NOT_OPEN: (s) => ({ kind: 'lan-not-open', characterId: s.characterId }),
  // 260806 — a Forge/NeoForge world that requires its mods client-side
  // needs its own surface: the resolution is a different world.
  MODDED_HOST_REJECTED: (s) => ({ kind: 'modded-host', characterId: s.characterId }),
};

const genericRoute: Route = (s, game) => ({
  kind: 'game-error',
  game,
  characterId: s.characterId,
  error: s.error,
  message: s.message,
});

const GENERIC_ROUTES: Partial<Record<ErrorClass, Route>> = {
  GAME_WORLD_NOT_OPEN: genericRoute,
  GAME_NOT_INSTALLED: genericRoute,
  GAME_INSTALL_FAILED: genericRoute,
  GAME_NOT_ANSWERING: genericRoute,
  GAME_VERSION_UNSUPPORTED: genericRoute,
  GAME_PACK_DOWNLOAD_FAILED: genericRoute,
};

/** Per-game dedicated routes; Minecraft's table is unchanged from pre-M0. */
export const BOT_ERROR_ROUTES: Record<GameId, Partial<Record<ErrorClass, Route>>> = {
  minecraft: MINECRAFT_ROUTES,
  stardew: GENERIC_ROUTES,
  dontstarve: GENERIC_ROUTES,
};

/**
 * The modal for a bot status, or null for none. Dedicated (game, class)
 * routes fire on every terminal error; the crash popup fires only for a
 * mid-session death with no dedicated surface (user stops, clean session
 * ends and pre-summon failures never carry `midSession`).
 */
export function modalForBotStatus(status: BotStatus): Modal | null {
  if (status.kind !== 'error') return null;
  const game: GameId = status.game ?? 'minecraft';
  const route = BOT_ERROR_ROUTES[game]?.[status.error] ?? GENERIC_ROUTES[status.error];
  if (route) return route(status, game);
  if (status.midSession === true) return { kind: 'bot-crash', characterId: status.characterId };
  return null;
}
