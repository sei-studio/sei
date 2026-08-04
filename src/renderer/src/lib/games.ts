/**
 * Games catalog (Phase 18/19) — the tiles shown in the chat "Play together"
 * picker. Minecraft, chess and Draw! are live; the coming-soon tiles preview
 * what is next, and the "Suggest a game" tile opens the feedback form (same
 * submit path as the Playtime screen's form).
 *
 * WHICH games exist, their names and whether they are playable now come from
 * the shared catalog (src/shared/games.ts), because the character's prompt is
 * built from the same rows (260730) and the two must not drift. This file adds
 * what only the picker needs: tile art and the long localized description.
 *
 * `description` is the body of the hover info popup on each picker tile
 * (companion-name aware, 1-2 sentences). Setup instructions live with each
 * game's own surface (e.g. the Minecraft setup window), not here.
 *
 * i18n: descriptions call the bare t() so they evaluate at render time (the
 * picker subscribes via useT). Game NAMES stay the proper English names here;
 * caption-like names ('Suggest a game') are translated at the display site.
 */

import { GAME_CATALOG } from '@shared/games';
import { t } from './i18n';

export interface GameDef {
  id: string;
  name: string;
  available: boolean;
  /** Coming-soon placeholder: dimmed, unclickable, "Coming soon" caption. */
  soon?: boolean;
  /** Optional tile background art (renderer-relative path served from public/). */
  image?: string;
  /** Brief description for the hover info popup (companion-name aware). */
  description: (companionName: string) => string;
}

/** Picker-only trimmings, keyed by the shared catalog's id. */
const TILES: Record<string, { image?: string; description: (companionName: string) => string }> = {
  minecraft: {
    image: './img/game-minecraft.webp',
    description: (name) =>
      t(
        '{name} joins your Minecraft world as a real player, walking beside you, mining, building, and talking as you explore together.',
        { name },
      ),
  },
  chess: {
    image: './img/chess-launch.png',
    description: (name) =>
      t(
        'A classic game of chess against {name}, right inside your chat. Untimed, so take as long as you like.',
        { name },
      ),
  },
  draw: {
    // The start page's own wordmark and drawings, rendered through the real
    // Architects Daughter face and captured to PNG, so the tile is literally
    // what the game looks like. Text is a raster here on purpose: an SVG used
    // as a CSS background-image cannot reach the app's @font-face, so a text
    // element in one would silently fall back to a system serif.
    image: './img/game-draw.png',
    description: (name) =>
      t(
        'Take turns sketching and guessing with {name}. Whoever is guessing types in the chat, and any sentence with the word in it counts.',
        { name },
      ),
  },
  // No `backseat` tile (260803): the shared catalog dropped it for the reason
  // written there, and its art now lives on as the header button's icon.
  stardew: {
    image: './img/game-stardew.jpg',
    description: (name) =>
      t(
        'Farm side by side in Pelican Town. {name} joins your co-op farm to plant, mine, and chat through the seasons with you.',
        { name },
      ),
  },
  dontstarve: {
    image: './img/game-dontstarve.jpg',
    description: (name) =>
      t(
        'Survive the Constant together. {name} gathers, fights, and keeps the fire going with you through the night.',
        { name },
      ),
  },
  focus: {
    image: './img/game-focus.jpg',
    description: (name) =>
      t('A quiet co-working session. {name} keeps you company while you get things done.', {
        name,
      }),
  },
};

export const GAMES: GameDef[] = [
  ...GAME_CATALOG.map((g) => {
    // A game added to the shared catalog without tile copy here still renders
    // (an empty info popup), rather than crashing the picker on a missing
    // description.
    const tile = TILES[g.id] ?? { description: () => '' };
    return {
      id: g.id,
      name: g.name,
      available: g.available,
      ...(g.available ? {} : { soon: true }),
      ...tile,
    };
  }),
  // Not a game, so it is not in the shared catalog: the last tile opens the
  // feedback form, and the character must never offer to "play Suggest a game".
  {
    id: 'suggest',
    name: 'Suggest a game',
    available: true,
    description: () =>
      t('Tell us what you want to play together. Suggestions go straight to the team.'),
  },
];
