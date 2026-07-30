/**
 * Games catalog (Phase 18/19) — the tiles shown in the chat "Play together"
 * picker. Minecraft and chess are live; the coming-soon tiles preview what is
 * next, and the "Suggest a game" tile opens the feedback form (same submit
 * path as the Playtime screen's form).
 *
 * `description` is the body of the hover info popup on each picker tile
 * (companion-name aware, 1-2 sentences). Setup instructions live with each
 * game's own surface (e.g. the Minecraft setup window), not here.
 *
 * i18n: descriptions call the bare t() so they evaluate at render time (the
 * picker subscribes via useT). Game NAMES stay the proper English names here;
 * caption-like names ('Suggest a game') are translated at the display site.
 */

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

export const GAMES: GameDef[] = [
  {
    id: 'minecraft',
    name: 'Minecraft',
    available: true,
    image: './img/game-minecraft.webp',
    description: (name) =>
      t(
        '{name} joins your Minecraft world as a real player, walking beside you, mining, building, and talking as you explore together.',
        { name },
      ),
  },
  {
    id: 'chess',
    name: 'Chess',
    available: true,
    image: './img/chess-launch.png',
    description: (name) =>
      t(
        'A classic game of chess against {name}, right inside your chat. Untimed, so take as long as you like.',
        { name },
      ),
  },
  {
    id: 'draw',
    name: 'Draw!',
    available: true,
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
  {
    // Preview of the feature living on v0.5-backseat; the tile ships ahead of
    // the code so the picker says what is coming next.
    id: 'backseat',
    name: 'Backseat',
    available: false,
    soon: true,
    image: './img/game-backseat.svg',
    description: (name) =>
      t(
        'Share a window and {name} watches you play, reacting as it happens and saying what they want to see you try next. Works with any game.',
        { name },
      ),
  },
  {
    id: 'stardew',
    name: 'Stardew Valley',
    available: false,
    soon: true,
    image: './img/game-stardew.jpg',
    description: (name) =>
      t(
        'Farm side by side in Pelican Town. {name} joins your co-op farm to plant, mine, and chat through the seasons with you.',
        { name },
      ),
  },
  {
    id: 'dontstarve',
    name: "Don't Starve Together",
    available: false,
    soon: true,
    image: './img/game-dontstarve.jpg',
    description: (name) =>
      t(
        'Survive the Constant together. {name} gathers, fights, and keeps the fire going with you through the night.',
        { name },
      ),
  },
  {
    id: 'focus',
    name: 'Focus',
    available: false,
    soon: true,
    image: './img/game-focus.jpg',
    description: (name) =>
      t('A quiet co-working session. {name} keeps you company while you get things done.', {
        name,
      }),
  },
  {
    id: 'suggest',
    name: 'Suggest a game',
    available: true,
    description: () =>
      t('Tell us what you want to play together. Suggestions go straight to the team.'),
  },
];
