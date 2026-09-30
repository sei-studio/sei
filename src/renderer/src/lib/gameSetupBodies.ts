/**
 * GAME_SETUP_BODIES — per-game bodies for the generic setup modal (game
 * adapters M2, 260908). GameSetupModal keeps the contract (pending summon,
 * auto-resume when the world opens, Try again / Close) and renders a game's
 * registered body between the title and the footer in place of its generic
 * two paragraphs. A game agent registers from its own module; unregistered
 * games keep the generic copy.
 */
import type React from 'react';
import type { GameId } from '@shared/gameIpc';

const bodies: Partial<Record<GameId, React.ComponentType>> = {};

export function registerGameSetupBody(game: GameId, Body: React.ComponentType): void {
  bodies[game] = Body;
}

export function getGameSetupBody(game: GameId | string | null | undefined): React.ComponentType | null {
  return (game && bodies[game as GameId]) || null;
}
