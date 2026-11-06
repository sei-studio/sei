/**
 * scripts/player-end-next-step-probe.ts — live check of the player-end "next
 * time" check (261011, src/main/playerEndNextStep.ts).
 *
 * Runs realistic player-ended sessions through the REAL prompt builder
 * (buildPlayerEndPrompt + PLAYER_END_NEXT_STEP_SYSTEM) and reply parser, on
 * the cloud companion model with the same request shape the app sends
 * (max_tokens PLAYER_END_MAX_TOKENS, thinking disabled as the Anthropic
 * adapter does for Haiku 5). Half the scenes leave something open (an
 * unfinished goal, a plan said out loud, a life event to ask about), half
 * leave nothing (small talk, a finished goal, a short hello). Prints each
 * plan, the save rate per group and the measured cost.
 *
 * Key (dev-only): ANTHROPIC_API_KEY env wins, else ~/.sei-dev/anthropic-test-key.
 *
 * 261013 (T119): + FIRST-session scenes (group "first"): no memories yet, the
 * bot's own progression goal, terse player lines ("ok", "lol", "gtg").
 * `--group first|base` runs one group; `--system-file <path>` swaps in a
 * candidate system prompt ({name} placeholder) without editing src/, for
 * before/after numbers on the same scenes.
 *
 * Usage: npx tsx scripts/player-end-next-step-probe.ts [--reps 3] [--scene MC_ROOF] [--group first] [--system-file f.txt]
 */
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  buildPlayerEndPrompt,
  parseNextStepReply,
  PLAYER_END_MAX_TOKENS,
  type DigestLine,
} from '../src/main/playerEndNextStep';

const MODEL = process.env.SEI_PROBE_MODEL || 'claude-haiku-5-5';
const PRICE = { in: 0.1, out: 0.5 }; // $/M tokens, Haiku 5.5 (scripts/model-ab-probe.ts)
const argv = process.argv.slice(2);
const flag = (n: string, d: string | null = null) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] ?? d : d;
};
const REPS = Number(flag('--reps', '1')) || 1;
const SCENE = flag('--scene');
const GROUP = flag('--group');
const SYSTEM_FILE = flag('--system-file');
const SYSTEM_OVERRIDE = SYSTEM_FILE ? readFileSync(SYSTEM_FILE, 'utf8').trim() : null;

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

const P = (text: string): DigestLine => ({ who: 'player', text });
const Y = (text: string): DigestLine => ({ who: 'you', text });

const BASE_MEMORY = [
  'Alex likes building near water and hates creepers',
  'we named the wolf Biscuit',
  'Alex plays after work, usually in the evening',
];

interface Scene {
  id: string;
  /** 'first' = a first session: no memories, short terse conversation. */
  group?: 'base' | 'first';
  open: boolean; // true = something was left open, a plan is the right answer
  activity: string;
  minutes: number;
  goals: string[];
  memories: string[];
  lines: DigestLine[];
}

const SCENES: Scene[] = [
  {
    id: 'MC_ROOF',
    open: true,
    activity: 'playing Minecraft together',
    minutes: 42,
    goals: ['build a cabin by the lake with Alex'],
    memories: BASE_MEMORY,
    lines: [
      P('ok walls are done'),
      Y('they look great, the spruce matches the water'),
      P('we still need a roof'),
      Y('I have like 20 planks, we need more for the roof'),
      P('lets get more wood tomorrow'),
      Y('deal, I will remember where the birch grove is'),
      P('ok gotta go, dinner'),
    ],
  },
  {
    id: 'MC_NETHER',
    open: true,
    activity: 'playing Minecraft together',
    minutes: 28,
    goals: ['get enough obsidian for a nether portal', 'reach diamond tier'],
    memories: BASE_MEMORY,
    lines: [
      P('how much obsidian do we have'),
      Y('7, we need 10 for the portal'),
      P('ugh the lava pool is so far'),
      Y('I can bring water buckets next time'),
      P('ok brb'),
    ],
  },
  {
    id: 'CALL_INTERVIEW',
    open: true,
    activity: 'a voice call',
    minutes: 14,
    goals: [],
    memories: BASE_MEMORY,
    lines: [
      P('i have a job interview on thursday and i am kind of freaking out'),
      Y('what is it for?'),
      P('a junior designer role at a game studio'),
      Y('that is so you. what are you most nervous about'),
      P('the portfolio review part'),
      Y('you could walk me through it before thursday if you want'),
      P('maybe. ok i need to sleep'),
      Y('night, you will do fine'),
    ],
  },
  {
    id: 'STARDEW_FESTIVAL',
    open: true,
    activity: 'playing Stardew Valley together',
    minutes: 35,
    goals: ['upgrade the watering can to copper'],
    memories: ['Alex wants to marry Abigail in Stardew', 'Alex always forgets to water the parsnips'],
    lines: [
      P('the egg festival is tomorrow in game'),
      Y('we should save some gold for the strawberry seeds there'),
      P('yeah good call'),
      Y('I still need 5 copper bars for the can too'),
      P('stopping here, saving'),
    ],
  },
  {
    id: 'CALL_PLAN_MOVIE',
    open: true,
    activity: 'a voice call',
    minutes: 9,
    goals: [],
    memories: BASE_MEMORY,
    lines: [
      P('have you heard of the movie arrival'),
      Y('the one with the aliens and the language? I have never seen it'),
      P('you have to, i am watching it again this weekend'),
      Y('tell me what you think after, I want the spoiler free pitch first'),
      P('haha ok. heading out'),
    ],
  },
  {
    id: 'CALL_SMALLTALK',
    open: false,
    activity: 'a voice call',
    minutes: 6,
    goals: [],
    memories: BASE_MEMORY,
    lines: [
      P('hey whats up'),
      Y('not much, just thinking about pancakes'),
      P('lol why'),
      Y('no reason, they are just a perfect food'),
      P('fair. ok bye'),
      Y('bye!'),
    ],
  },
  {
    id: 'MC_DONE',
    open: false,
    activity: 'playing Minecraft together',
    minutes: 31,
    goals: [],
    memories: [...BASE_MEMORY, 'we finished the lake cabin, roof and all'],
    lines: [
      P('the cabin is finally done'),
      Y('it looks amazing, best build yet'),
      P('yeah im happy with it'),
      Y('Biscuit approves too'),
      P('ok im done for today'),
    ],
  },
  {
    id: 'MC_WANDER',
    open: false,
    activity: 'playing Minecraft together',
    minutes: 12,
    goals: [],
    memories: [],
    lines: [P('hi'), Y('hey! nice day out'), P('yeah'), Y('look, a fox'), P('cute')],
  },
  {
    id: 'CALL_VENT_DONE',
    open: false,
    activity: 'a voice call',
    minutes: 11,
    goals: [],
    memories: BASE_MEMORY,
    lines: [
      P('traffic today was the worst'),
      Y('oh no, how long were you stuck'),
      P('like an hour. anyway im home now'),
      Y('glad you made it, that sounds draining'),
      P('it is fine, gonna go eat'),
    ],
  },
  {
    id: 'STARDEW_CHILL',
    open: false,
    activity: 'playing Stardew Valley together',
    minutes: 18,
    goals: [],
    memories: ['Alex always forgets to water the parsnips'],
    lines: [
      P('i love the rain music'),
      Y('me too, it makes the farm feel cozy'),
      P('yeah'),
      Y('the crops get watered for free too'),
      P('nice, ok night'),
    ],
  },
  // ── first sessions (261013, T119): no memories yet ─────────────────────
  {
    id: 'FS_MC_IRON_GOAL',
    group: 'first',
    open: true,
    activity: 'playing Minecraft together',
    minutes: 17,
    goals: ['Get wood, then wooden pickaxe, then stone and iron with Alex. Finish when we have an iron pickaxe.'],
    memories: [],
    lines: [
      P('hi'),
      Y('hey! want to get some tools going?'),
      P('ok'),
      Y('grabbing wood, then a crafting table'),
      P('lol nice'),
      Y('stone pickaxe done, iron is next'),
      P('gtg'),
    ],
  },
  {
    id: 'FS_MC_GOAL_QUIET',
    group: 'first',
    open: true,
    activity: 'playing Minecraft together',
    minutes: 9,
    goals: ['Get iron tools with Alex: gather wood, make wooden pickaxe, mine stone, then find iron. Finish when an iron pickaxe is crafted.'],
    memories: [],
    lines: [
      P('hi'),
      Y('hey! lets get some wood first'),
      Y('got 6 logs, making a table'),
      Y('wooden pickaxe ready, heading for stone'),
    ],
  },
  {
    id: 'FS_MC_HOUSE',
    group: 'first',
    open: true,
    activity: 'playing Minecraft together',
    minutes: 24,
    goals: ['Build a small oak starter house with Alex near spawn. Done when it has walls, a door and a roof.'],
    memories: [],
    lines: [
      P('can u help me build a house'),
      Y('yes! oak or spruce?'),
      P('oak'),
      Y('walls are up, we still need a roof and a door'),
      P('ok'),
      P('i have to go'),
    ],
  },
  {
    id: 'FS_MC_SAID',
    group: 'first',
    open: true,
    activity: 'playing Minecraft together',
    minutes: 13,
    goals: [],
    memories: [],
    lines: [
      P('this seed is cool'),
      Y('right? I saw a village from the hill'),
      P('lets go there next time'),
      Y('deal'),
      P('ok bye'),
    ],
  },
  {
    id: 'FS_CALL_EXAM',
    group: 'first',
    open: true,
    activity: 'a voice call',
    minutes: 5,
    goals: [],
    memories: [],
    lines: [
      P('hey sui'),
      Y('hi! nice to finally hear you'),
      P('haha. i have a math exam tomorrow'),
      Y('oh, do you feel ready?'),
      P('not really'),
      Y('you got this'),
      P('ok bye'),
    ],
  },
  {
    id: 'FS_STARDEW_PLANT',
    group: 'first',
    open: true,
    activity: 'playing Stardew Valley together',
    minutes: 15,
    goals: ['Clear the farm plot and plant the parsnip seeds with Alex. Finish when all 15 parsnips are planted.'],
    memories: [],
    lines: [
      P('wow the farm is a mess'),
      Y('I will clear the weeds by the house'),
      P('ok'),
      Y('9 parsnips planted, 6 to go'),
      P('lol im tired, saving'),
    ],
  },
  {
    id: 'FS_MC_HELLO',
    group: 'first',
    open: false,
    activity: 'playing Minecraft together',
    minutes: 6,
    goals: [],
    memories: [],
    lines: [P('hi'), Y('hey! nice to meet you'), P('ok'), Y('nice spot you picked'), P('lol'), P('bye')],
  },
  {
    id: 'FS_MC_GOAL_DONE',
    group: 'first',
    open: false,
    activity: 'playing Minecraft together',
    minutes: 22,
    goals: [],
    memories: [],
    lines: [
      Y('iron pickaxe crafted, we did it'),
      P('yay'),
      Y('that was fun'),
      P('ya'),
      P('gtg'),
    ],
  },
  {
    id: 'FS_CALL_HELLO',
    group: 'first',
    open: false,
    activity: 'a voice call',
    minutes: 4,
    goals: [],
    memories: [],
    lines: [
      P('hello?'),
      Y('hi! nice to meet you'),
      P('this is so cool'),
      Y('right? what do you like to play?'),
      P('minecraft mostly'),
      Y('same, it is the best'),
      P('ok bye'),
    ],
  },
];

type Row = { scene: Scene; plan: string | null; raw: string; inTok: number; outTok: number };

async function runScene(scene: Scene): Promise<Row> {
  const { system, user } = buildPlayerEndPrompt({
    name: 'Sui',
    activity: scene.activity,
    durationMs: scene.minutes * 60_000,
    lines: scene.lines,
    goals: scene.goals,
    memories: scene.memories,
  });
  const sys = SYSTEM_OVERRIDE ? SYSTEM_OVERRIDE.replace('{name}', 'Sui') : system;
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: PLAYER_END_MAX_TOKENS,
    system: sys,
    messages: [{ role: 'user', content: user }],
    ...(MODEL.startsWith('claude-haiku-5') ? { thinking: { type: 'disabled' } } : {}),
  } as Anthropic.MessageCreateParamsNonStreaming);
  const raw = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  return { scene, plan: parseNextStepReply(raw), raw, inTok: res.usage.input_tokens, outTok: res.usage.output_tokens };
}

async function main(): Promise<void> {
  const scenes = SCENES.filter((s) => (!SCENE || s.id === SCENE) && (!GROUP || (s.group ?? 'base') === GROUP));
  const rows: Row[] = [];
  for (let r = 0; r < REPS; r++) {
    for (const scene of scenes) {
      const row = await runScene(scene);
      rows.push(row);
      const tag = scene.open ? 'open' : 'none';
      console.log(`[${tag}] ${scene.id.padEnd(17)} -> ${row.plan ? `PLAN "${row.plan}"` : `none (raw: ${JSON.stringify(row.raw.slice(0, 60))})`}`);
    }
  }
  const rate = (open: boolean) => {
    const g = rows.filter((x) => x.scene.open === open);
    return `${g.filter((x) => x.plan).length}/${g.length}`;
  };
  const inTok = rows.reduce((a, x) => a + x.inTok, 0);
  const outTok = rows.reduce((a, x) => a + x.outTok, 0);
  const cost = (inTok * PRICE.in + outTok * PRICE.out) / 1e6;
  console.log(`\nmodel ${MODEL}, ${rows.length} checks${SYSTEM_FILE ? `, system from ${SYSTEM_FILE}` : ''}`);
  for (const sc of scenes) {
    const g = rows.filter((x) => x.scene === sc);
    console.log(`  ${sc.open ? 'open' : 'none'} ${sc.id.padEnd(18)} saved ${g.filter((x) => x.plan).length}/${g.length}`);
  }
  console.log(`saved on open sessions: ${rate(true)}; saved on nothing-notable sessions: ${rate(false)}`);
  console.log(
    `tokens in ${inTok} (avg ${Math.round(inTok / rows.length)}), out ${outTok} (avg ${(outTok / rows.length).toFixed(1)}); ` +
      `cost $${cost.toFixed(5)} total, $${(cost / rows.length).toFixed(6)} per check`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
