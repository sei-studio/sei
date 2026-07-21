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
    id: 'chess',
    name: 'Chess',
    available: true,
    image: './img/game-chess.svg',
    studio: 'Sei Studio',
    description: (name) =>
      `A classic game of chess against ${name}, right inside your chat. ` +
      `${name} thinks about every move, reacts to yours, and keeps the conversation ` +
      `going while you play. Untimed, so take as long as you like.`,
    setup: [
      'Pick who plays white, or leave it to chance.',
      'Make your moves right on the board. No timer, no pressure.',
      'Your companion talks while you play. Chat back anytime.',
    ],
    blurb: (name) => `Challenge ${name} to a friendly game of chess.`,
  },
  {
    id: 'connect4',
    name: 'Connect 4',
    available: true,
    image: './img/game-connect4.svg',
    studio: 'Sei Studio',
    description: (name) =>
      `Drop discs and race ${name} to four in a row, right inside your chat. ` +
      `${name} watches every column, talks while you play, and does not always ` +
      `see the trap coming. Untimed, so take as long as you like.`,
    setup: [
      'Pick who drops first, or leave it to chance.',
      'Click a column to drop your disc. No timer, no pressure.',
      'Your companion talks while you play. Chat back anytime.',
    ],
    blurb: (name) => `Race ${name} to four in a row.`,
  },
  {
    id: 'twentyq',
    name: '20 Questions',
    available: true,
    image: './img/game-twentyq.svg',
    studio: 'Sei Studio',
    description: (name) =>
      `The classic guessing game, played right in your chat. Think of something and ` +
      `${name} gets 20 yes/no questions to work it out, or flip it and dig the secret ` +
      `out of ${name} instead. Rounds are quick and the score carries across them.`,
    setup: [
      'Pick who thinks of something, you or your companion.',
      'Ask and answer in chat. The panel tracks questions, guesses, and score.',
      'Play as many rounds as you like.',
    ],
    blurb: (name) => `${name} gets 20 questions to read your mind.`,
  },
  {
    id: 'watch',
    name: 'Screen share',
    available: true,
    image: './img/game-watch.svg',
    studio: 'Sei Studio',
    description: (name) =>
      `${name} watches your screen while you play something else and reacts in the chat, ` +
      `like a friend on the couch. You pick exactly which window ${name} can see, ` +
      `and you can stop sharing at any time with one click.`,
    setup: [
      'Open the game or app you want to share.',
      'Pick the window from the list. Only that window is shared.',
      'Click Start watching. A Watching pill with a Stop button stays visible the whole time.',
    ],
    blurb: (name) => `${name} watches your screen and reacts while you play.`,
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
