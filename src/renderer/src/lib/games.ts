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
    id: 'movie',
    name: 'Watch a movie',
    available: false,
    soon: true,
    description: (name) =>
      `Movie night with ${name}: watch something together and talk about it as it plays.`,
  },
  {
    id: 'focus',
    name: 'Focus together',
    available: false,
    soon: true,
    description: (name) =>
      `A quiet co-working session. ${name} keeps you company while you get things done.`,
  },
  {
    id: 'backseat',
    name: 'Backseat my game',
    available: false,
    soon: true,
    description: (name) =>
      `${name} watches you play any game and reacts like a friend on the couch.`,
  },
  {
    id: 'suggest',
    name: 'Suggest a game',
    available: true,
    description: () =>
      'Tell us what you want to play together. Suggestions go straight to the team.',
  },
];
