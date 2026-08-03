/**
 * Games catalog (Phase 18/19) — the tiles shown in the chat "Play together"
 * picker. Minecraft and chess are live; the coming-soon tiles preview what is
 * next, and the "Suggest a game" tile opens the feedback form (same submit
 * path as the Playtime screen's form).
 *
 * `description` is the body of the hover info popup on each picker tile
 * (companion-name aware, 1-2 sentences). Setup instructions live with each
 * game's own surface (e.g. the Minecraft setup window), not here.
 */

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
      `${name} joins your Minecraft world as a real player, walking beside you, ` +
      `mining, building, and talking as you explore together.`,
  },
  {
    id: 'chess',
    name: 'Chess',
    available: true,
    image: './img/chess-launch.png',
    description: (name) =>
      `A classic game of chess against ${name}, right inside your chat. ` +
      `Untimed, so take as long as you like.`,
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
      `Take turns sketching and guessing with ${name}. ` +
      `Whoever is guessing types in the chat, and any sentence with the word in it counts.`,
  },
  // 260803: the "Backseat" tile is gone. Sharing your screen is not a game and
  // it does not belong in a grid beside chess: it is something you do on a
  // call, so it moved to the call controls' share button (CallControls.tsx),
  // where it works the way Discord's does. The session type still exists
  // everywhere else, including the cross-launch gate.
  {
    id: 'focus',
    name: 'Focus',
    available: false,
    soon: true,
    image: './img/game-focus.jpg',
    description: (name) =>
      `A quiet co-working session. ${name} keeps you company while you get things done.`,
  },
  {
    id: 'suggest',
    name: 'Suggest a game',
    available: true,
    description: () =>
      'Tell us what you want to play together. Suggestions go straight to the team.',
  },
];
