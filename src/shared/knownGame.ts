/**
 * "Already works in Sei" lookup for the Suggest-a-game form (261109, T379).
 *
 * Players kept typing "roblox" into Suggest a game while the Roblox tile sat
 * one row above it. The form now checks what was typed against OUR catalog
 * (GAME_CATALOG, which already carries BACKSEAT_GAMES) and offers the game
 * we have. This is a lookup of catalog names and aliases, nothing more: it
 * never reads chat and never decides what a companion says.
 *
 * Matching is case, accent, apostrophe and spacing insensitive, on whole
 * words: "ROBLOX", "stardewvalley", "Mine craft" and "dont starve" all match,
 * "drawing" does not match "Draw!". Aliases in a script without spaces
 * (Chinese, Japanese) match anywhere in the text. When several games are
 * named, the one named first wins.
 *
 * A backseat game with a lookup (Roblox) also hands back what is left of the
 * text as `query`, so "Roblox Forsaken" opens the Roblox pick step searching
 * for "Forsaken". Any Roblox experience counts as Roblox, so only the word
 * "Roblox" (or an alias) is needed.
 */

import { GAME_CATALOG } from './games';
import { backseatGame } from './backseatGames';

export interface KnownGameMatch {
  /** Catalog id ('roblox', 'minecraft'): what the hint opens and analytics send. */
  gameId: string;
  /** Proper name for the hint line ("Roblox", not "Roblox (Backseat)"). */
  name: string;
  backseat: boolean;
  /** The rest of the text, as typed, for a backseat game with a search. */
  query?: string;
}

/**
 * Names that start with one of ours but are a different game: "Minecraft
 * Dungeons" is not the Minecraft we join, and Bedrock / Pocket Edition is the
 * version Sei cannot join (LAN Java only). Keyed by game id; each entry is
 * the normalized word that follows the match.
 */
const DIFFERENT_GAME_AFTER: Record<string, readonly string[]> = {
  minecraft: ['dungeons', 'legends', 'story', 'earth', 'bedrock', 'pe', 'pocket', 'education'],
  // A separate co-op game; Backseat would still watch it, but the knowledge
  // block is about the main game.
  eldenring: ['nightreign'],
};

/** Words around an experience name that are not part of it ("forsaken ON roblox"). */
const FILLER = new Set([
  'a', 'an', 'and', 'by', 'experience', 'for', 'from', 'game', 'games', 'in', 'of', 'on',
  'play', 'playing', 'please', 'the', 'with',
]);

/** Longest remainder still treated as an experience name, in words. */
const MAX_QUERY_WORDS = 6;

/** Lowercase, accents and apostrophes off: the comparison form of one word. */
function normWord(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/['’]/g, '')
    .toLowerCase();
}

/** Every word with its place in the original text. */
function words(text: string): Array<{ w: string; start: number; end: number }> {
  const out: Array<{ w: string; start: number; end: number }> = [];
  for (const m of text.matchAll(/[\p{L}\p{N}'’]+/gu)) {
    const w = normWord(m[0]);
    if (w) out.push({ w, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** The comparison form of a whole name: its words run together. */
function compact(name: string): string {
  return words(name)
    .map((t) => t.w)
    .join('');
}

/** Scripts written without spaces between words. */
const NO_SPACES = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

interface Key {
  gameId: string;
  compact: string;
  noSpaces: boolean;
}

let KEYS: Key[] | null = null;

function keys(): Key[] {
  if (KEYS) return KEYS;
  KEYS = [];
  for (const g of GAME_CATALOG) {
    if (!g.available) continue;
    for (const n of [g.name, ...(g.aliases ?? [])]) {
      const c = compact(n);
      if (c) KEYS.push({ gameId: g.id, compact: c, noSpaces: NO_SPACES.test(n) });
    }
  }
  return KEYS;
}

/**
 * The catalog game the text names, or null. `text` is the form's free text;
 * nothing here leaves the renderer.
 */
export function matchKnownGame(text: string): KnownGameMatch | null {
  if (!text.trim()) return null;
  const toks = words(text);
  const joined = toks.map((t) => t.w).join('');
  let best: { gameId: string; from: number; to: number; at: number } | null = null;
  const better = (gameId: string, from: number, to: number, at: number): void => {
    if (!best || at < best.at || (at === best.at && to - from > best.to - best.from)) {
      best = { gameId, from, to, at };
    }
  };

  for (const k of keys()) {
    if (k.noSpaces) {
      const i = joined.indexOf(k.compact);
      // No word span to cut out of a run of hanzi or kana, so no query.
      if (i >= 0) better(k.gameId, -1, -1, i);
      continue;
    }
    let offset = 0;
    for (let i = 0; i < toks.length; i++) {
      // Run words together until they spell the key or stop being a prefix
      // of it: "mine craft" -> "minecraft", but "drawing" never equals "draw".
      let acc = '';
      for (let j = i; j < toks.length; j++) {
        acc += toks[j].w;
        if (!k.compact.startsWith(acc)) break;
        if (acc === k.compact) {
          const next = toks[j + 1]?.w;
          if (!next || !DIFFERENT_GAME_AFTER[k.gameId]?.includes(next)) better(k.gameId, i, j, offset);
          break;
        }
      }
      offset += toks[i].w.length;
    }
  }

  if (!best) return null;
  const hit: { gameId: string; from: number; to: number } = best;
  const entry = GAME_CATALOG.find((g) => g.id === hit.gameId);
  if (!entry) return null;
  const bs = entry.backseat ? backseatGame(entry.id) : undefined;
  const match: KnownGameMatch = {
    gameId: entry.id,
    name: bs?.name ?? entry.name,
    backseat: !!entry.backseat,
  };
  if (bs?.lookup && hit.from >= 0) {
    const query = experienceQuery(text, toks, hit.from, hit.to);
    if (query) match.query = query;
  }
  return match;
}

/**
 * What is left once the game's own name is cut out: the words on the longer
 * side of it, filler trimmed from both ends, as the player typed them
 * ("Roblox: Grow a Garden" -> "Grow a Garden"). Nothing when it is empty or
 * reads like a sentence rather than a name.
 */
function experienceQuery(
  text: string,
  toks: Array<{ w: string; start: number; end: number }>,
  from: number,
  to: number,
): string | undefined {
  const before = toks.slice(0, from);
  const after = toks.slice(to + 1);
  let side = after.length >= before.length ? after : before;
  while (side.length && FILLER.has(side[0].w)) side = side.slice(1);
  while (side.length && FILLER.has(side[side.length - 1].w)) side = side.slice(0, -1);
  if (!side.length || side.length > MAX_QUERY_WORDS) return undefined;
  return text.slice(side[0].start, side[side.length - 1].end);
}
