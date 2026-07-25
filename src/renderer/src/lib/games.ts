/**
 * Games catalog (Phase 18/19) — the tiles shown in the chat "Play together"
 * picker. Minecraft is live; a single "More games" placeholder stands in for
 * everything still coming.
 *
 * `description` is the body of the hover info popup on each picker tile
 * (companion-name aware, 1-2 sentences). Setup instructions live with each
 * game's own surface (e.g. the Minecraft setup window), not here.
 */

export interface GameDef {
  id: string;
  name: string;
  available: boolean;
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
    id: 'watch',
    name: 'Screen share',
    available: true,
    image: './img/game-watch.svg',
    description: (name) =>
      `${name} watches your screen while you play something else and reacts in the chat, ` +
      `like a friend on the couch. You pick which window ${name} can see.`,
  },
  {
    id: 'more',
    name: 'More coming soon!',
    available: false,
    description: () =>
      'More ways to play together are on the way. New games will show up here as they land.',
  },
];
