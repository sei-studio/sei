/**
 * Backseat game lookups (260929): the main-side half of the registry in
 * src/shared/backseatGames.ts. A game with `lookup` set gets a "pick your
 * game" step; this maps that kind to its provider. A new provider implements
 * BackseatGameLookup and is added to PROVIDERS; nothing else changes.
 */

import {
  backseatGame,
  type BackseatGameDef,
  type BackseatGameInfo,
  type BackseatGameLookupKind,
  type BackseatGameResolveResult,
  type BackseatGameSelection,
} from '../../../shared/backseatGames';
import { robloxClient } from './robloxClient';

export interface BackseatGameLookup {
  resolve(input: string): Promise<BackseatGameResolveResult>;
  popular(): Promise<BackseatGameInfo[]>;
  details(id: number): Promise<BackseatGameInfo | null>;
}

const PROVIDERS: Record<BackseatGameLookupKind, () => BackseatGameLookup> = {
  roblox: robloxClient,
};

/** The lookup behind a backseat game id, or null when it has none. */
export function lookupFor(gameId: string): BackseatGameLookup | null {
  const def = backseatGame(gameId);
  return def?.lookup ? PROVIDERS[def.lookup]() : null;
}

/** How long session start waits for a picked game's details. The pick step
 *  already fetched them, so this is normally a cache hit; on a miss the share
 *  must not hang behind Roblox's API, and the session runs without them. */
const START_DETAILS_BUDGET_MS = 4_000;

/**
 * What a session started from a backseat game tile knows about its game: the
 * registry entry, plus the picked experience's details when one was picked
 * and they could be read. Null for an ordinary share (or an unknown id).
 */
export async function resolveGameContext(
  sel: BackseatGameSelection | undefined,
): Promise<{ def: BackseatGameDef; game: BackseatGameInfo | null } | null> {
  const def = backseatGame(sel?.gameId);
  if (!def || !sel) return null;
  const lookup = lookupFor(def.id);
  if (!lookup || !sel.universeId) return { def, game: null };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), START_DETAILS_BUDGET_MS);
  });
  try {
    const game = await Promise.race([lookup.details(sel.universeId).catch(() => null), budget]);
    return { def, game };
  } finally {
    clearTimeout(timer);
  }
}
