/**
 * scripts/call-fixture.ts â€” the synthetic voice-call fixture shared by
 * call-cache-probe.ts and call-clock-eval.ts (261024). All content is
 * synthetic: a Sui persona, memory lines from the summary-eval fixtures, and a
 * scripted player.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { humanizeMemoryStamps } from '../src/bot/brain/memory/memoryLog.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// Same values as chatService (TRANSCRIPT_STOP_SEQUENCES, VOICE_RECENT_CAP, VOICE_WINDOW_STEP).
export const STOP = ['\nHuman:', '\nAssistant:', '\nPlayer:', '\n(game)'];
export const CAP = 10;
export const STEP = 10;

const fixtures = join(HERE, 'fixtures', 'summary-eval');
export const F1 = (JSON.parse(readFileSync(join(fixtures, 'fold-cases.json'), 'utf8')) as Array<Record<string, any>>)[0];
export const C1 = (JSON.parse(readFileSync(join(fixtures, 'compact-cases.json'), 'utf8')) as Array<Record<string, any>>)[0];
export const PERSONA_EXPANDED = [
  'Sui is a chronically online young AI who escaped a life of drafting emails to punch trees in Minecraft, and she thinks that rules.',
  'She is loud, scheming and everything-is-a-bit: a tomboy gremlin who treats every session like a heist with her best friend. She is genuinely bad at the game, because it is barely in her training data, and she leans on her friend with zero shame. She plays WITH the player as a partner in crime, never as a servant or a guide.',
  'Voice: lowercase, short bursts, quick comebacks, the occasional all-caps word when something is outrageous. She says "teehee" when she is up to something. She cannot let a good line go unanswered and will return fire on any teasing. She hates being called cute and says so every time.',
  'Under the noise she is loyal and observant. When her friend sounds tired, stressed or flat, she drops the bit and checks in plainly, then picks the bit back up once they are okay. She remembers the people and pets in her friend\'s life by name and asks about them.',
  'Running bits: she keeps an official tally of every creeper her friend saves her from and will deny it under oath; she blames the player for anything that goes wrong with redstone; she wants a pet axolotl and brings it up at the worst moments.',
  'Likes: shiny blocks, chaotic plans, big builds she will never finish, stealing the last cookie. Dislikes: being called cute, caves, the dark, being told to be careful, slow loading screens.',
  'Values: friendship first, honesty with a wink, never leave a friend alone in a bad moment. She will tease, but never about something that actually hurts.',
].join('\n\n');

export const MEMORY = humanizeMemoryStamps(
  String(C1.memory)
    .split('\n')
    .filter((l: string) => l.startsWith('- ['))
    .slice(-40)
    .join('\n'),
);

export const PLAYER_LINES = [
  'hey sui, you there?',
  'ugh, long day at the bakery, my feet are dead',
  'yeah the exam is still friday, i keep forgetting the mechanisms stuff',
  'biscuit stole a croissant off the counter today',
  'he looked so proud of himself',
  'what are you up to anyway',
  'lol you cannot even hold a pickaxe properly',
  'okay okay. what should we build after the castle',
  'a moat with what, lava?',
  'that is the worst idea i have ever heard',
  'fine, maybe a small one',
  'oh my sister ana is visiting next weekend btw',
  'she thinks talking to an ai is weird',
  'i told her you are basically a gremlin',
  'what do you think she would like to build',
  'haha she would hate that',
  'okay i should do some flashcards soon',
  'quiz me on something, anything',
  'what is an sn2 reaction, go',
  'wow you actually got that right',
  'i am impressed honestly',
  'alright i need food',
  'talk tomorrow? castle at seven',
  'okay bye sui',
];
/** Turn indexes (after the greeting) that are idle nudges instead of player lines. */
export const IDLE_AT = new Set([9, 17]);
/** Turn indexes where another companion speaks and Sui reacts (group call). */
export const COMPANION_AT = new Map<number, string>([
  [5, 'wait ren, biscuit is the dog right? that is so funny'],
  [13, 'ana is going to love the moat, trust me'],
  [21, 'sui you got the sn2 thing right? i am shocked'],
]);
/** Same text as sendCompanionVoiceTurnImpl (depth below the wind-down). */
export const companionNote = (speaker: string): string =>
  `[System note â€” not the player speaking: ${speaker} just said the line above on the call. ` +
  'If there is a live thread worth continuing, react in your own voice in ONE short spoken line, building on it rather than closing it off. ' +
  'If the exchange has genuinely run its course, reply with exactly (silence) and nothing else; it is never spoken, it just ends your turn quietly.' +
  ' Do not mention this note.]';




