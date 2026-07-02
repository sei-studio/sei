/**
 * Games catalog (Phase 18/19) — the tiles shown in the chat "Play together"
 * picker and the per-game info window. Minecraft is live; a single "More games"
 * placeholder stands in for everything still coming. Shared so GamesPickerModal
 * and GameAboutModal (the info window) stay in sync.
 *
 * `blurb` is a function of the companion name for compact contexts; `description`
 * and `setup` back the two-column info window opened by a tile's (i) button.
 */

export interface GameDef {
  id: string;
  name: string;
  available: boolean;
  /** Optional tile background art (renderer-relative path served from public/). */
  image?: string;
  /** Studio / maker, shown under the name in the info window. */
  studio: string;
  /** Longer description for the info window (companion-name aware). */
  description: (companionName: string) => string;
  /** Ordered "how to set up" steps for the info window. */
  setup: string[];
  /** Short one-liner for compact contexts, given the companion's display name. */
  blurb: (companionName: string) => string;
}

export const GAMES: GameDef[] = [
  {
    id: 'minecraft',
    name: 'Minecraft',
    available: true,
    image: './img/game-minecraft.webp',
    studio: 'Mojang Studios',
    description: (name) =>
      `${name} joins your Minecraft world as a real player, walking beside you, ` +
      `mining, building, and talking as you explore together over your LAN.`,
    setup: [
      'Open Minecraft: Java Edition and load a single-player world.',
      'Pause and choose "Open to LAN", then "Start LAN World".',
      'Set up your companion\'s Minecraft skin when Sei prompts you.',
      'Click Minecraft here and your companion joins your open world.',
    ],
    blurb: (name) => `Summon ${name} into your LAN world to play and build together.`,
  },
  {
    id: 'more',
    name: 'More coming soon!',
    available: false,
    studio: '',
    description: () =>
      'More ways to play together are on the way. New games will show up here as they land.',
    setup: [],
    blurb: () => 'More games are coming soon.',
  },
];

export function findGame(gameId: string): GameDef | undefined {
  return GAMES.find((g) => g.id === gameId);
}
