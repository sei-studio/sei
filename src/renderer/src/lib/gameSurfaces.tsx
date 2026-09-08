/**
 * GAME_SURFACES — the per-game chat-aside panels (game adapters M0, 260908).
 *
 * ChatScreen mounts a bot-backed game through this registry instead of
 * naming Minecraft's components: `LaunchPanel` shows while the bot is offline
 * and the picker opened the game (useMcDashboardStore.launch[id] === game);
 * `DashboardPanel` shows whenever the bot is online (BotStatus.game). Both
 * receive `{ characterId }`.
 *
 * Registering a game: `registerGameSurface('stardew', { LaunchPanel,
 * DashboardPanel })` from the game's own module; until then a game resolves
 * to the placeholders below so an unregistered game never crashes the chat
 * screen. Minecraft registers McLaunchPanel / McDashboardPanel here.
 */
import React from 'react';
import type { GameId } from '@shared/gameIpc';
import { McLaunchPanel } from '../components/mcdash/McLaunchPanel';
import { McDashboardPanel } from '../components/mcdash/McDashboardPanel';
import { GenericGameLaunchPanel, GenericGameDashboardPanel } from '../components/games/GenericGamePanels';

export interface GameSurfaceProps {
  characterId: string;
}

export interface GameSurface {
  LaunchPanel: React.ComponentType<GameSurfaceProps>;
  DashboardPanel: React.ComponentType<GameSurfaceProps>;
}

const withGame = (game: GameId): GameSurface => ({
  LaunchPanel: (p) => <GenericGameLaunchPanel game={game} characterId={p.characterId} />,
  DashboardPanel: (p) => <GenericGameDashboardPanel game={game} characterId={p.characterId} />,
});

export const GAME_SURFACES: Record<GameId, GameSurface> = {
  minecraft: { LaunchPanel: McLaunchPanel, DashboardPanel: McDashboardPanel },
  stardew: withGame('stardew'),
  dontstarve: withGame('dontstarve'),
};

export function registerGameSurface(game: GameId, surface: GameSurface): void {
  GAME_SURFACES[game] = surface;
}

export function getGameSurface(game: GameId | string | null | undefined): GameSurface {
  return GAME_SURFACES[(game as GameId) ?? 'minecraft'] ?? GAME_SURFACES.minecraft;
}
