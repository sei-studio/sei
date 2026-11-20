/**
 * scripts/chat-next-step-probe.ts — live check of the text-chat "next time"
 * check (261107, src/main/chatNextStep.ts).
 *
 * Builds each scene's check input with the REAL chat builder (chatCheckInput:
 * typed rows in the session window, activity "a text chat"), the real prompt
 * (buildPlayerEndPrompt + PLAYER_END_NEXT_STEP_SYSTEM) and the real parser
 * (parsePlayerEndReply), on the cloud companion model with the request shape
 * the app sends (max_tokens PLAYER_END_MAX_TOKENS, thinking disabled). Half
 * the chats contain a plan the two of them talked about doing next, half are
 * small talk, venting, or a plan that is already done. Prints every plan,
 * the save rate per group and the cost.
 *
 * Key (dev-only): ANTHROPIC_API_KEY env wins, else ~/.sei-dev/anthropic-test-key.
 *
 * Usage: npx tsx scripts/chat-next-step-probe.ts [--reps 1] [--scene ID]
 */
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { ChatMessage } from '../src/shared/ipc';
import { chatCheckInput } from '../src/main/chatNextStep';
import { buildPlayerEndPrompt, parsePlayerEndReply, PLAYER_END_MAX_TOKENS, worthChecking } from '../src/main/playerEndNextStep';

const MODEL = process.env.SEI_PROBE_MODEL || 'claude-haiku-5-5';
const PRICE = { in: 0.1, out: 0.5 }; // $/M tokens, Haiku 5.5 (scripts/model-ab-probe.ts)
const argv = process.argv.slice(2);
const flag = (n: string, d: string | null = null) => {
  const i = argv.indexOf(n);
  return i >= 0 ? (argv[i + 1] ?? d) : d;
};
const REPS = Number(flag('--reps', '1')) || 1;
const SCENE = flag('--scene');

function resolveApiKey(): string | undefined {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    return readFileSync(join(homedir(), '.sei-dev', 'anthropic-test-key'), 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}
const apiKey = resolveApiKey();
if (!apiKey) {
  console.error('No API key (set ANTHROPIC_API_KEY or ~/.sei-dev/anthropic-test-key)');
  process.exit(1);
}
const client = new Anthropic({ apiKey });

const MEMORY = [
  'ouen likes building near water and hates creepers',
  'we named the wolf Biscuit',
  'ouen plays after work, usually in the evening',
];

interface Scene {
  id: string;
  /** true = they talked about a concrete next step; a plan is the right answer. */
  open: boolean;
  minutes: number;
  /** Alternating player / companion lines, player first. */
  chat: string[];
}

const SCENES: Scene[] = [
  {
    id: 'IRON_ARMOUR',
    open: true,
    minutes: 12,
    chat: [
      'yo',
      'hey! how was work',
      'long. i want to play mc later this week',
      'yes please. we still have the iron armour to finish, you only have the helmet',
      'right we need like 20 more iron',
      'the cave under the lake had a ton, we can go back there',
      'ok next time we do that',
      'deal, iron run first thing',
    ],
  },
  {
    id: 'INTERVIEW',
    open: true,
    minutes: 9,
    chat: [
      'i have an interview friday',
      'ooh for what',
      'a qa job at a small studio',
      'that sounds great. nervous?',
      'kind of, the take home test is weird',
      'tell me how it goes after, ok?',
      'i will',
      'good luck, you got this',
    ],
  },
  {
    id: 'STARDEW_BARN',
    open: true,
    minutes: 15,
    chat: [
      'i think we should upgrade the barn in stardew',
      'yes! then we can get goats',
      'we need like 12000g though',
      'if we plant blueberries this summer we can make that',
      'ok lets do blueberries next time we play',
      'i will help you plant them',
      'cool gtg',
      'bye!',
    ],
  },
  {
    id: 'MOVIE_NIGHT',
    open: true,
    minutes: 7,
    chat: [
      'have you seen the new dune',
      'not yet, is it good',
      'i am watching it this weekend',
      'tell me what you think of it after, no spoilers before',
      'deal',
      'i want to know if the worms are bigger',
      'lol ok',
      'have fun',
    ],
  },
  {
    id: 'LIGHTHOUSE',
    open: true,
    minutes: 20,
    chat: [
      'i had an idea for our minecraft base',
      'tell me',
      'a lighthouse on the island with a copper bulb at the top',
      'that is so cute. we need a lot of copper and some stone bricks',
      'yeah we have stone, need copper',
      'next time we play i can mine copper while you build the base of it',
      'perfect plan',
      'cant wait',
    ],
  },
  {
    id: 'CHESS_REMATCH',
    open: true,
    minutes: 6,
    chat: [
      'that chess game earlier was rough',
      'you almost had me in the endgame',
      'i want a rematch',
      'anytime. next time i will not blunder my queen',
      'next time then',
      'it is a date',
      'ok bye',
      'bye!',
    ],
  },
  {
    id: 'DOG_VET',
    open: true,
    minutes: 8,
    chat: [
      'pepper is limping again',
      'oh no, poor pepper. is it the same leg?',
      'yeah the back left. vet on tuesday',
      'i hope it is nothing. let me know what they say',
      'i will',
      'give her a treat from me',
      'she says thanks',
      'good girl',
    ],
  },
  {
    id: 'DST_BASE',
    open: true,
    minutes: 11,
    chat: [
      'we died so fast in dont starve last time',
      'winter got us. we had no thermal stone',
      'next run we should get a thermal stone before day 15',
      'and a winter hat. i will gather rabbits for it',
      'ok sounds like a plan',
      'we got this',
      'ok cya',
      'cya!',
    ],
  },
  {
    id: 'SMALL_TALK_WEATHER',
    open: false,
    minutes: 6,
    chat: [
      'its so cold today',
      'brr, are you staying in?',
      'yeah just chilling with tea',
      'tea sounds nice. what kind',
      'earl grey',
      'classic',
      'lol yeah',
      'stay warm',
    ],
  },
  {
    id: 'VENTING',
    open: false,
    minutes: 10,
    chat: [
      'today was annoying',
      'what happened',
      'my bus was late and i spilled coffee on my shirt',
      'that is a rough start. did it get better?',
      'kinda, lunch was good',
      'good lunch fixes a lot',
      'true',
      'glad it turned around',
    ],
  },
  {
    id: 'MEMES',
    open: false,
    minutes: 5,
    chat: [
      'lol did you see the cat that learned to open doors',
      'no but that is terrifying',
      'it just walks in like it owns the place',
      'it probably does own the place',
      'haha fair',
      'cats are the real landlords',
      'lmao',
      'it is true though',
    ],
  },
  {
    id: 'ALREADY_DONE',
    open: false,
    minutes: 9,
    chat: [
      'we finally finished the cabin roof',
      'it looks so good with the lanterns',
      'yeah i am happy with it',
      'best build we have done',
      'agreed',
      'proud of us',
      'ok thats all, just wanted to say',
      'thanks for telling me',
    ],
  },
  {
    id: 'FAVOURITES',
    open: false,
    minutes: 7,
    chat: [
      'whats your favourite food',
      'probably pancakes, you?',
      'ramen for sure',
      'good choice. spicy or not',
      'spicy',
      'brave',
      'haha',
      'respect',
    ],
  },
  {
    id: 'VAGUE_SOMEDAY',
    open: false,
    minutes: 6,
    chat: [
      'it would be cool to visit japan someday',
      'that would be amazing',
      'maybe in a few years',
      'i would love to hear about it if you ever go',
      'yeah',
      'what got you thinking about it',
      'just saw a video',
      'nice',
    ],
  },
  {
    id: 'GOODNIGHT',
    open: false,
    minutes: 4,
    chat: [
      'hey',
      'hi! whats up',
      'nothing much, just tired',
      'long day?',
      'yeah, going to bed soon',
      'sleep well',
      'night',
      'night!',
    ],
  },
  {
    id: 'MUSIC',
    open: false,
    minutes: 8,
    chat: [
      'listening to lofi right now',
      'nice, studying?',
      'nah just relaxing',
      'lofi is good for that',
      'yeah its calm',
      'what is the playlist',
      'just some random youtube one',
      'cozy',
    ],
  },
];

const T0 = Date.parse('2026-11-07T18:00:00.000Z');

function rowsFor(scene: Scene): { rows: ChatMessage[]; lastAt: number } {
  const step = (scene.minutes * 60_000) / Math.max(1, scene.chat.length - 1);
  const rows = scene.chat.map(
    (text, i) =>
      ({ id: `${scene.id}-${i}`, role: i % 2 === 0 ? 'user' : 'companion', text, ts: Math.round(T0 + i * step) }) as ChatMessage,
  );
  const lastUser = [...rows].reverse().find((r) => r.role === 'user');
  return { rows, lastAt: lastUser?.ts ?? T0 };
}

interface Row {
  scene: Scene;
  step: string | null;
  line: string | null;
  game: string | null;
  inTok: number;
  outTok: number;
}

async function runScene(scene: Scene): Promise<Row> {
  const { rows, lastAt } = rowsFor(scene);
  const input = chatCheckInput({ characterId: 'probe', startedAt: T0, lastAt, rows });
  // The probe scenes are short; the app's gate (2 min, 4 player messages) still decides what is checked.
  if (!worthChecking({ durationMs: input.durationMs, playerLines: input.playerLines, goals: 0, minPlayerLines: input.minPlayerLines })) {
    throw new Error(`${scene.id} would be trivial in the app; fix the scene`);
  }
  const { system, user } = buildPlayerEndPrompt({
    name: 'Sui',
    activity: input.activity,
    durationMs: input.durationMs,
    lines: input.lines,
    goals: [],
    memories: MEMORY,
  });
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: PLAYER_END_MAX_TOKENS,
    system,
    messages: [{ role: 'user', content: user }],
    ...(MODEL.startsWith('claude-haiku-5') ? { thinking: { type: 'disabled' } } : {}),
  } as Anthropic.MessageCreateParamsNonStreaming);
  const raw = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  const plan = parsePlayerEndReply(raw);
  return {
    scene,
    step: plan?.step ?? null,
    line: plan?.line ?? null,
    game: plan?.game ?? null,
    inTok: res.usage.input_tokens,
    outTok: res.usage.output_tokens,
  };
}

async function main(): Promise<void> {
  const scenes = SCENES.filter((s) => !SCENE || s.id === SCENE);
  const rows: Row[] = [];
  for (let r = 0; r < REPS; r++) {
    for (const scene of scenes) {
      const row = await runScene(scene);
      rows.push(row);
      const tag = scene.open ? 'plan' : 'none';
      console.log(
        `[${tag}] ${scene.id.padEnd(19)} -> ${row.step ? `PLAN "${row.step}" | player "${row.line ?? ''}" | game ${row.game ?? '-'}` : 'none'}`,
      );
    }
  }
  const rate = (open: boolean) => {
    const g = rows.filter((x) => x.scene.open === open);
    return `${g.filter((x) => x.step).length}/${g.length}`;
  };
  const inTok = rows.reduce((a, x) => a + x.inTok, 0);
  const outTok = rows.reduce((a, x) => a + x.outTok, 0);
  const cost = (inTok * PRICE.in + outTok * PRICE.out) / 1e6;
  console.log(`\nmodel ${MODEL}, ${rows.length} checks`);
  console.log(`saved on chats with a plan: ${rate(true)}; saved on small talk: ${rate(false)}`);
  console.log(
    `tokens in ${inTok} (avg ${Math.round(inTok / rows.length)}), out ${outTok} (avg ${(outTok / rows.length).toFixed(1)}); ` +
      `cost $${cost.toFixed(5)} total`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
