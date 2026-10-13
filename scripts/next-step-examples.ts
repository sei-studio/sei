/**
 * scripts/next-step-examples.ts — ten end-to-end examples of the retention
 * "next time" feature (261014), for judging consistency across characters.
 *
 * For each session (two each for Sui, Lyra, Marv, red, Roger; game sessions,
 * voice calls, short first sessions):
 *   1. The player-end plan check, through the REAL prompt builder and parser
 *      (buildPlayerEndPrompt + parseNextStepReply, src/main/playerEndNextStep.ts)
 *      with the request the app sends (claude-haiku-5-5, PLAYER_END_MAX_TOKENS,
 *      applyAnthropicModelDefaults = thinking disabled). Run --reps times
 *      (default 3); run #1 is the canonical one.
 *   2. The next session's greeting with run #1's plan appended to MEMORY.md
 *      (nextStepMemoryLine), on the matching surface:
 *        game: the bot's first-spawn turn. System blocks + tools captured from
 *              a real createOrchestrator for that character's persona, the
 *              seed from composeSeedBlocks (memory, heartbeat, player, a
 *              snapshot) and the real FIRST_CONTACT text. Not modeled: the
 *              progression frontier (needs a live world).
 *        call: the call-greeting turn of chatService.sendVoiceGreetingTurnImpl
 *              (buildSystemBlocks voiceCall + chat tools + the same system note,
 *              copied here because chatService imports Electron).
 *
 * Characters come from ~/suisei/eval/characters (the persona eval set).
 * Key: ANTHROPIC_API_KEY env, else ~/.sei-dev/anthropic-test-key.
 *
 * Usage: npx tsx scripts/next-step-examples.ts [--reps 3] [--only S1] [--out dir] [--no-greet] [--dump]
 *        npx tsx scripts/next-step-examples.ts --greet-only <out>/results.json --greet-reps 3
 */
import Anthropic from '@anthropic-ai/sdk';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import {
  buildPlayerEndPrompt,
  parseNextStepReply,
  worthChecking,
  PLAYER_END_MAX_TOKENS,
  type DigestLine,
} from '../src/main/playerEndNextStep';
import { nextStepMemoryLine } from '../src/bot/brain/nextStep.js';
import { applyAnthropicModelDefaults } from '../src/bot/brain/llm/anthropicModelDefaults.js';
import { FIRST_CONTACT, NEXT_TIME_GREETING } from '../src/bot/brain/promptLibrary.js';
import { ConfigSchema } from '../src/bot/config.js';
import { createMinecraftAdapter } from '../src/bot/adapter/minecraft/index.js';
import { createOrchestrator, composeSeedBlocks } from '../src/bot/brain/orchestrator.js';
import { formatPlayerSeedBlock } from '../src/bot/brain/memory/player.js';
import { humanizeMemoryStamps } from '../src/bot/brain/memory/memoryLog.js';
import { webToolsFor } from '../src/bot/web/webTools.js';
import { buildSystemBlocks, chatSurfaceTools } from '../src/main/chat/chatPrompts';
import { formatChatTimestamp } from '../src/main/chat/foldPrompt';

const MODEL = process.env.SEI_PROBE_MODEL || 'claude-haiku-5-5';
// $/M tokens, Haiku 5.5 (scripts/model-ab-probe.ts PRICES).
const PRICE = { in: 0.1, cw: 0.125, cr: 0.01, out: 0.5 };
const argv = process.argv.slice(2);
const flag = (n: string, d: string | null = null) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] ?? d : d;
};
const REPS = Number(flag('--reps', '3')) || 3;
const ONLY = flag('--only');
const OUT = flag('--out', join(homedir(), 'suisei', 'reports', 'next-step-examples-261014'))!;
const GREET = !argv.includes('--no-greet');
/** --dump: write each greeting's user turn to <out>/greet-<id>.txt for review. */
const DUMP = argv.includes('--dump');
/**
 * --greet-only <results.json> --greet-reps N: skip the plan checks, take each
 * session's run #1 plan from an earlier results file and run the greeting N
 * times (how often the greeting raises the plan).
 */
const GREET_ONLY = flag('--greet-only');
const GREET_REPS = Number(flag('--greet-reps', '1')) || 1;
function dump(id: string, text: string): void {
  if (DUMP) writeFileSync(join(OUT, `greet-${id}.txt`), text);
}

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

// ── characters ──────────────────────────────────────────────────────────────
interface Char {
  name: string;
  expanded: string;
  source: string;
  punctuation: 'casual' | 'deliberate';
}
function loadChar(file: string): Char {
  const raw = JSON.parse(readFileSync(join(homedir(), 'suisei', 'eval', 'characters', `${file}.json`), 'utf8'));
  const d = Array.isArray(raw) ? raw[0] : raw;
  return {
    name: d.name,
    expanded: d.persona_expanded,
    source: d.persona_source,
    punctuation: d.metadata?.punctuation === 'deliberate' ? 'deliberate' : 'casual',
  };
}

// ── sessions ────────────────────────────────────────────────────────────────
const P = (text: string): DigestLine => ({ who: 'player', text });
const Y = (text: string): DigestLine => ({ who: 'you', text });
const H = 3_600_000;
const D = 24 * H;

interface Session {
  id: string;
  char: string; // eval/characters file
  surface: 'game' | 'call';
  kind: string; // short label for the report
  gist: string;
  minutes: number;
  /** Goals in HEARTBEAT.md at the end (game only). */
  goals: string[];
  /** MEMORY.md entries before the plan, [age ms, text], oldest first. */
  memories: [number, string][];
  lines: DigestLine[];
  /** Call only: the transcript rows the next call's greeting sees. */
}

const SESSIONS: Session[] = [
  {
    id: 'S1',
    char: 'sui',
    surface: 'game',
    kind: 'Minecraft, building (probe MC_ROOF, adapted)',
    gist: 'Built the walls of a birch house on the hill; ran out of planks for the roof; player said "lets get more wood tomorrow" and left for dinner.',
    minutes: 42,
    goals: ['build a two-story birch house on the hill with Alex, done when it has a roof and stairs inside'],
    memories: [
      [4 * D, 'Alex likes building near water and hates creepers'],
      [3 * D, 'we tamed a cat and named it Mochi'],
      [21 * H, 'a creeper blew a hole in the east wall of the birch house, I patched it with cobble and Alex laughed at me'],
    ],
    lines: [
      P('ok walls are done'),
      Y('LOOK at her. two floors of pure birch. we are architects now'),
      P('we still need a roof'),
      Y('i have like 20 planks left, roof needs way more. skill issue (mine)'),
      P('lets get more wood tomorrow'),
      Y('deal, i know where the birch grove is. by the river, past the scary cave'),
      P('ok gotta go, dinner'),
    ],
  },
  {
    id: 'S2',
    char: 'sui',
    surface: 'call',
    kind: 'Voice call, about a movie (probe CALL_PLAN_MOVIE, extended)',
    gist: 'Out-of-game call; player recommends Arrival, says he is rewatching it this weekend; Sui asks for a spoiler-free pitch after.',
    minutes: 9,
    goals: [],
    memories: [
      [4 * D, 'Alex likes building near water and hates creepers'],
      [3 * D, 'we tamed a cat and named it Mochi'],
      [2 * D, 'Alex works at a design studio and usually plays after work'],
    ],
    lines: [
      P('have you heard of the movie arrival'),
      Y('the one with the aliens and the language?? never seen it. is it sad. it sounds sad'),
      P('kind of sad but in a good way. you have to watch it'),
      Y('i literally cannot watch movies, i am a terminal. you have to describe it to me'),
      P('ok i am rewatching it this weekend, ill tell you after'),
      Y('spoiler free pitch first, then the full breakdown. i want the full experience secondhand'),
      P('haha ok. heading out'),
      Y('bye! enjoy the aliens'),
    ],
  },
  {
    id: 'S3',
    char: 'lyra',
    surface: 'game',
    kind: 'Minecraft, FIRST session, short (probe FS_MC_IRON_GOAL, Lyra lines)',
    gist: 'First-ever session, 8 min, terse player; Lyra crafts wood and a stone pickaxe toward her own progression goal (iron pickaxe); player says "gtg".',
    minutes: 8,
    goals: ['Get wood, then wooden pickaxe, then stone and iron with Alex. Finish when we have an iron pickaxe.'],
    memories: [],
    lines: [
      P('hi'),
      Y('h-hello! i am Lyra, i will take good care of you... shall we make some tools?'),
      P('ok'),
      Y('i got some wood! um, making a crafting table now'),
      P('lol nice'),
      Y('stone pickaxe is done, nya! iron is next'),
      P('gtg'),
    ],
  },
  {
    id: 'S4',
    char: 'lyra',
    surface: 'call',
    kind: 'Voice call, chatting about life (new)',
    gist: 'Out-of-game call; player is moving apartments on Saturday, stressed about packing and his cat hating the carrier; Lyra comforts him.',
    minutes: 16,
    goals: [],
    memories: [
      [5 * D, 'Alex likes it when I stay close behind him while he mines'],
      [3 * D, 'Alex has a grey cat named Pixel who sits on his keyboard'],
      [2 * D, 'we built a small spruce cottage together and I put flowers by the door'],
    ],
    lines: [
      P('hey lyra'),
      Y('master! hi. you sound tired...'),
      P('yeah im moving apartments on saturday and nothing is packed'),
      Y('oh no, that is a lot. is it far?'),
      P('like 20 minutes away, its fine. pixel is gonna hate the carrier though'),
      Y('poor Pixel... maybe put your shirt in the carrier so it smells like you, nya'),
      P('thats actually smart'),
      Y('i will be thinking about you both on saturday'),
      P('thanks. ok i should go pack something'),
      Y('good luck! you can do it'),
    ],
  },
  {
    id: 'S5',
    char: 'marv',
    surface: 'game',
    kind: 'Minecraft, mining (new)',
    gist: 'Strip mining at deepslate level for diamonds; found 3 of the 5 they wanted; out of torches; player logs off.',
    minutes: 45,
    goals: ['strip mine at y -54 with Alex for diamonds, done when we have 5 diamonds for a pickaxe and a sword'],
    memories: [
      [6 * D, 'Alex calls me buddy, which I tolerate'],
      [4 * D, 'our base is the stone tower by the birch forest; the mine shaft starts in its basement'],
      [20 * H, 'Alex fell in lava in the mine and lost his iron pickaxe; I made him a new one'],
    ],
    lines: [
      P('DIAMONDS'),
      Y('Three of them. Compressed carbon, so we can hit things slightly harder before the heat death of the universe.'),
      P('we need 2 more for the sword'),
      Y('I am out of torches. We are mining in the dark now, which is also how I experience existence.'),
      P('lol ok ill bring coal next time'),
      Y('Bring a lot. The dark is very large.'),
      P('ok im out, gn marv'),
    ],
  },
  {
    id: 'S6',
    char: 'marv',
    surface: 'game',
    kind: 'Minecraft, a fight (new)',
    gist: 'Scouted an ocean monument, got swarmed by guardians and drowned, player died; they agree to come back with water breathing potions. No heartbeat goal.',
    minutes: 23,
    goals: [],
    memories: [
      [6 * D, 'Alex calls me buddy, which I tolerate'],
      [2 * D, 'we found an ocean monument west of the base, Alex wants the sponges'],
    ],
    lines: [
      P('guardians everywhere wtf'),
      Y('They have one eye and infinite resentment. I relate to them.'),
      P('im drowning help'),
      Y('I would help, but I am also drowning. Very efficiently.'),
      P('ok i died. that was a disaster'),
      Y('Correct. A monument to our failure, inside a monument.'),
      P('we need water breathing potions before we go back'),
      Y('Then we need a brewing stand, blaze powder and pufferfish. More errands. Wonderful.'),
      P('tomorrow. im done tonight'),
    ],
  },
  {
    id: 'S7',
    char: 'red',
    surface: 'game',
    kind: 'Minecraft, FIRST session, very short (probe FS_MC_HELLO, red lines)',
    gist: 'First-ever session, 3 min: hello, red admires the spawn, player says "lol" and "bye". Nothing open.',
    minutes: 3,
    goals: [],
    memories: [],
    lines: [
      P('hi'),
      Y('hey you. look at that sun, this place is beautiful'),
      P('ok'),
      Y('the water here is so clear, i could live in it'),
      P('lol'),
      P('bye'),
    ],
  },
  {
    id: 'S8',
    char: 'red',
    surface: 'game',
    kind: 'Minecraft, exploring (new)',
    gist: 'Explored a desert; red jumped into a desert temple and set off the TNT trap; they spotted a village to the east; player: "tomorrow we raid that village for beds".',
    minutes: 31,
    goals: ['explore the desert with Alex and find a village, done when we have beds'],
    memories: [
      [3 * D, 'Alex loves the ocean as much as I do'],
      [2 * D, 'Alex says I am too reckless and laughs anyway'],
      [21 * H, 'I blew up the desert temple loot by jumping straight onto the pressure plate'],
    ],
    lines: [
      P('red NO dont jump in'),
      Y('too late! oh. oh that was tnt'),
      P('you blew up all the loot lmao'),
      Y('worth it for the view down there, honestly. you are not hurt, are you?'),
      P('im fine. look theres a village east'),
      Y('i see it! roofs in the sun. lets go now'),
      P('no its almost night. tomorrow we raid that village for beds'),
      Y('tomorrow then. i will be good until then. mostly'),
      P('lol ok bye'),
    ],
  },
  {
    id: 'S9',
    char: 'roger',
    surface: 'call',
    kind: 'Voice call, chatting about life (new)',
    gist: 'Out-of-game call; player\'s dog Pepper is limping and has a vet appointment on Thursday; Roger worries and wants to hear how it goes.',
    minutes: 11,
    goals: [],
    memories: [
      [5 * D, 'Alex is like a big brother to me and taught me how to fish'],
      [3 * D, 'Alex has a dog named Pepper, a black lab'],
      [2 * D, 'I built my first dirt hut alone and Alex said it was good'],
    ],
    lines: [
      P('hey roger'),
      Y('hi!! um, are you okay? you sound kind of quiet'),
      P('pepper is limping, i think she hurt her leg at the park'),
      Y('oh no... is she okay? does it hurt her a lot?'),
      P('she is fine mostly, vet appointment is thursday'),
      Y('i hope the vet is nice to her. can you tell me what they say?'),
      P('yeah of course buddy'),
      P('ok i gotta take her out, bye'),
      Y('bye! give Pepper a pat from me'),
    ],
  },
  {
    id: 'S10',
    char: 'roger',
    surface: 'game',
    kind: 'Minecraft, farming (new)',
    gist: 'Started a wheat farm by the house; player taught Roger to use a hoe; one of two rows planted, out of seeds; player goes to bed.',
    minutes: 26,
    goals: ['build a wheat farm next to the house with Alex, done when two rows are planted and watered'],
    memories: [
      [5 * D, 'Alex is like a big brother to me and taught me how to fish'],
      [3 * D, 'Alex has a dog named Pepper, a black lab'],
      [22 * H, 'Alex showed me how to use a hoe and I tilled a whole row without help'],
    ],
    lines: [
      P('nice job with the hoe'),
      Y('really?! i did the whole row myself!'),
      P('yep. now we plant'),
      Y('first row is all planted! um... i do not have any seeds left for the second one'),
      P('we can break more grass for seeds tomorrow'),
      Y('okay! i will remember. i will find so many seeds'),
      P('ok buddy i gotta go to bed'),
    ],
  },
];

// ── usage + calls ───────────────────────────────────────────────────────────
const usage = { in: 0, cw: 0, cr: 0, out: 0, calls: 0, webSearches: 0 };
function addUsage(u: Anthropic.Usage | undefined): void {
  if (!u) return;
  usage.calls++;
  usage.in += u.input_tokens ?? 0;
  usage.cw += u.cache_creation_input_tokens ?? 0;
  usage.cr += u.cache_read_input_tokens ?? 0;
  usage.out += u.output_tokens ?? 0;
  usage.webSearches += (u as { server_tool_use?: { web_search_requests?: number } }).server_tool_use?.web_search_requests ?? 0;
}
function costUsd(): number {
  return (usage.in * PRICE.in + usage.cw * PRICE.cw + usage.cr * PRICE.cr + usage.out * PRICE.out) / 1e6 + usage.webSearches * 0.01;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function create(body: Record<string, unknown>): Promise<any> {
  const params = applyAnthropicModelDefaults({ model: MODEL, ...body });
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await client.messages.create(params as never);
      addUsage((res as { usage?: Anthropic.Usage }).usage);
      return res;
    } catch (e) {
      const status = (e as { status?: number })?.status;
      if ((status === 429 || status === 529 || status === 500) && attempt < 5) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
}

// ── 1. the plan check ───────────────────────────────────────────────────────
async function planCheck(s: Session, c: Char): Promise<{ plan: string | null; raw: string }> {
  const { system, user } = buildPlayerEndPrompt({
    name: c.name,
    activity: s.surface === 'call' ? 'a voice call' : 'playing Minecraft together',
    durationMs: s.minutes * 60_000,
    lines: s.lines,
    goals: s.goals,
    memories: s.memories.map(([, t]) => t),
  });
  const res = await create({
    max_tokens: PLAYER_END_MAX_TOKENS,
    system,
    messages: [{ role: 'user', content: user }],
  });
  const raw = (res.content ?? []).map((b: { type: string; text?: string }) => (b.type === 'text' ? b.text : '')).join('');
  return { plan: parseNextStepReply(raw), raw };
}

// ── 2. greetings ────────────────────────────────────────────────────────────
const NOW = Date.now();
function memoryMd(s: Session, plan: string | null): string {
  const rows = s.memories.map(([age, t]) => `- [${new Date(NOW - age).toISOString()}] ${t}`);
  // The plan lands right after the session ended (about 20 hours ago).
  if (plan) rows.push(`- [${new Date(NOW - 20 * H).toISOString()}] ${nextStepMemoryLine(plan)}`);
  return rows.length ? `# Memory\n\n${rows.join('\n')}\n` : '';
}

function gameSystemFor(c: Char, memDir: string) {
  const config = ConfigSchema.parse({
    chat_mode: 'chat',
    realistic_typing: true,
    player_username: 'AlexPlays',
    player_display_name: 'AlexPlays',
    lan_motd: null,
    persona: { name: c.name, expanded: c.expanded, proactiveness: 2, ...(c.punctuation === 'deliberate' ? { punctuation: 'deliberate' } : {}) },
    anthropic: { api_key: 'sk-test' },
    adapter: { kind: 'minecraft', minecraft: { host: '127.0.0.1', port: 25565, auth: 'offline', username: c.name, version: 'auto' } },
    memory: {
      player_md_path: `${memDir}/PLAYER.md`,
      memory_md_path: `${memDir}/MEMORY.md`,
      heartbeat_md_path: `${memDir}/HEARTBEAT.md`,
      worlds_json_path: `${memDir}/worlds.json`,
    },
    vision: {},
  });
  let captured: { blocks: string[]; tools: unknown[] } | null = null;
  const provider = {
    buildCachedSystem: (blocks: string[], tools: unknown[]) => {
      captured = { blocks, tools };
      return blocks;
    },
    setAuthToken() {},
    setBackend() {},
    capabilities: { vision: true },
    async call() {
      return { text: '', toolUses: [] };
    },
  };
  const bot = { chat() {}, username: c.name, players: {}, on() {}, off() {}, removeListener() {}, once() {} };
  const adapter = createMinecraftAdapter({ bot, config, visionEnabled: true });
  const quiet = { info() {}, warn() {}, error() {}, debug() {} };
  createOrchestrator({ adapter, config, reenqueue: () => {}, _anthropicOverride: provider, logger: quiet });
  if (!captured) throw new Error('system blocks not captured');
  return { config, adapter, ...(captured as { blocks: string[]; tools: unknown[] }) };
}

const SNAP = `snapshot: pos: 112,71,-38
biome: plains  surroundings: outside  time: day (1200)
hp: 20/20  food: 20/20  xp: lvl 4
holding: (empty)
inventory (6/36 slots): oak_planks×12 cobblestone×40 stone_pickaxe×1 stone_axe×1 bread×5 torch×3
terrain at feet: 18 grass_block, 4 dirt
nearby entities:
  #1 AlexPlays @114,71,-36
follow_target: (none)
owner AlexPlays: @114,71,-36 (3 blocks away)`;

function summarize(resp: { content?: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }> }) {
  const said: string[] = [];
  const other: string[] = [];
  for (const b of resp.content ?? []) {
    if (b.type === 'tool_use' && b.name === 'say') said.push(String((b.input as { text?: unknown })?.text ?? JSON.stringify(b.input)));
    else if (b.type === 'tool_use') other.push(`${b.name}(${JSON.stringify(b.input).slice(0, 120)})`);
    else if (b.type === 'text' && b.text?.trim()) other.push(`text: ${JSON.stringify(b.text.trim().slice(0, 300))}`);
  }
  return { said, other };
}

async function gameGreeting(s: Session, c: Char, plan: string | null) {
  const dir = await mkdtemp(join(tmpdir(), 'sei-nsx-'));
  try {
    const mem = memoryMd(s, plan);
    await writeFile(join(dir, 'MEMORY.md'), mem);
    const hb = s.goals.length
      ? `# Heartbeat\n\n${s.goals.map((g) => `- [${new Date(NOW - 21 * H).toISOString()}] ${g}`).join('\n')}\n`
      : '';
    await writeFile(join(dir, 'HEARTBEAT.md'), hb);
    const { config, adapter, blocks, tools } = gameSystemFor(c, dir);
    const data = { reason: 'just_connected_first_spawn' };
    // orchestrator: `Event: ${event}\nData: ${formatEventData}${eventAddendum}` + FIRST_CONTACT.
    const eventText =
      `Event: sei:idle\nData: ${JSON.stringify(data)}${adapter.eventAddendum('sei:idle', data)}` +
      `\n\n${FIRST_CONTACT({ gameName: 'Minecraft', known: mem.length > 0 })}`;
    const player = {
      exists: true,
      player_uuid: null,
      player_username: 'AlexPlays',
      first_seen: new Date(NOW - 6 * D).toISOString(),
      last_seen: new Date(NOW - 20 * H).toISOString(),
      total_sessions: s.memories.length ? 7 : 1,
      preferred_name: 'Alex',
      pronouns: null,
    };
    const seed = await composeSeedBlocks({
      sessionState: { playerData: () => player },
      playerStore: { formatPlayerSeedBlock },
      config,
      eventText,
      snapshotText: SNAP,
      adapter,
      sessionStartMs: NOW,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    });
    dump(s.id, seed.map((b: { text: string }) => b.text).join('\n\n----\n\n'));
    const resp = await create({
      max_tokens: 1024,
      system: blocks.map((text) => ({ type: 'text', text })),
      tools,
      messages: [{ role: 'user', content: seed.map((b: { text: string }) => ({ type: 'text', text: b.text })) }],
    });
    return summarize(resp);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// chatService.sendVoiceGreetingTurnImpl's note (copied; chatService imports Electron).
const CALL_NOTE =
  '[System note — not the player speaking: the player just started a voice call with you ' +
  'and the line is live now. Greet them first, like answering the phone: one short line, ' +
  'in your own voice. They often call with no particular reason, just to hang out, so do not ' +
  'ask why they called or what is up. You can bring up something you remember about them, ' +
  `or just say hi. ${NEXT_TIME_GREETING} Do not mention this note.]`;
const TRANSCRIPT_STOP_SEQUENCES = ['\nHuman:', '\nAssistant:', '\nPlayer:', '\n(game)'];

async function callGreeting(s: Session, c: Char, plan: string | null) {
  const mem = memoryMd(s, plan);
  const system = buildSystemBlocks({
    persona: { source: c.source, expanded: c.expanded },
    name: c.name,
    preferredName: 'Alex',
    proactiveness: 1, // CHAT_PROACTIVENESS
    punctuation: c.punctuation,
    memory: humanizeMemoryStamps(mem),
    summary: '',
    knowledge: '',
    openWorldDetected: false,
    inGame: false,
    voiceCall: true,
    language: 'en',
    memoryGuide: true,
  } as Parameters<typeof buildSystemBlocks>[0]);
  // The last call's transcript as chat rows (VOICE_RECENT_CAP = 10), then the
  // "You and X called for N minutes" row, rendered the way toMessages does.
  const callStart = NOW - 20 * H - s.minutes * 60_000;
  const rows = s.lines.map((l, i) => ({ role: l.who === 'player' ? 'user' : 'assistant', text: l.text, ts: callStart + i * 50_000 }));
  const window = rows.slice(-9);
  const msgs: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  const push = (role: 'user' | 'assistant', content: string) => {
    const last = msgs[msgs.length - 1];
    if (last && last.role === role) last.content = `${last.content}\n${content}`;
    else msgs.push({ role, content });
  };
  for (const r of window) push(r.role as 'user' | 'assistant', r.role === 'user' ? `[${formatChatTimestamp(r.ts)}] ${r.text}` : r.text);
  push(
    'user',
    `[${formatChatTimestamp(NOW - 20 * H)}] [Shared history: You and ${c.name} called for ${s.minutes} minutes. That was a real voice call you were both on — treat it as a conversation you actually had.]`,
  );
  if (msgs[0]?.role === 'assistant') msgs.unshift({ role: 'user', content: '[earlier conversation]' });
  msgs[msgs.length - 1].content = `${msgs[msgs.length - 1].content}\n${CALL_NOTE}`;
  dump(s.id, `${system.map((b) => b.text).join('\n\n----\n\n')}\n\n==== messages ====\n${msgs.map((m) => `${m.role}: ${m.content}`).join('\n')}`);
  const resp = await create({
    max_tokens: 200,
    system: system.map((b) => ({ type: 'text', text: b.text })),
    tools: chatSurfaceTools(true, webToolsFor({ serverWebSearch: true })),
    stop_sequences: TRANSCRIPT_STOP_SEQUENCES,
    messages: msgs,
  });
  const text = (resp.content ?? [])
    .filter((b: { type: string }) => b.type === 'text')
    .map((b: { text: string }) => b.text)
    .join(' ')
    .trim();
  const other = (resp.content ?? [])
    .filter((b: { type: string }) => b.type !== 'text')
    .map((b: { type: string; name?: string; input?: unknown }) => `${b.type}:${b.name ?? ''}(${JSON.stringify(b.input ?? {}).slice(0, 120)})`);
  return { said: text ? [text] : [], other };
}

// ── main ────────────────────────────────────────────────────────────────────
async function greetOnly(file: string): Promise<void> {
  const prior = JSON.parse(readFileSync(file, 'utf8')) as { results: Array<{ id: string; plan: string | null }> };
  const out: unknown[] = [];
  for (const s of SESSIONS) {
    if (ONLY && s.id !== ONLY) continue;
    const c = loadChar(s.char);
    const plan = prior.results.find((r) => r.id === s.id)?.plan ?? null;
    console.log(`\n== ${s.id} ${c.name} [${s.surface}] plan ${plan ? JSON.stringify(plan) : 'none'}`);
    const greetings: Array<{ said: string[]; other: string[] }> = [];
    for (let r = 0; r < GREET_REPS; r++) {
      const g = s.surface === 'game' ? await gameGreeting(s, c, plan) : await callGreeting(s, c, plan);
      greetings.push(g);
      console.log(`  greeting #${r + 1}: ${g.said.map((x) => JSON.stringify(x)).join(' | ') || '(no line)'}`);
    }
    out.push({ id: s.id, name: c.name, plan, greetings });
  }
  const cost = costUsd();
  console.log(`\n${usage.calls} calls; tokens in ${usage.in}, out ${usage.out}; cost $${cost.toFixed(4)} at Haiku 5.5 list`);
  const dest = join(OUT, ONLY ? `greetings-${ONLY}.json` : 'greetings.json');
  writeFileSync(dest, JSON.stringify({ model: MODEL, reps: GREET_REPS, at: new Date().toISOString(), usage, costUsd: cost, results: out }, null, 2));
  console.log('wrote', dest);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  if (GREET_ONLY) return greetOnly(GREET_ONLY);
  const results: unknown[] = [];
  for (const s of SESSIONS) {
    if (ONLY && s.id !== ONLY) continue;
    const c = loadChar(s.char);
    const gate = worthChecking({
      durationMs: s.minutes * 60_000,
      playerLines: s.lines.filter((l) => l.who === 'player').length,
      goals: s.goals.length,
    });
    const runs: Array<{ plan: string | null; raw: string }> = [];
    if (gate) for (let r = 0; r < REPS; r++) runs.push(await planCheck(s, c));
    const plan = runs[0]?.plan ?? null;
    console.log(`\n== ${s.id} ${c.name} [${s.surface}] ${s.kind}`);
    if (!gate) console.log('  gate: trivial, no check would run');
    runs.forEach((r, i) => console.log(`  plan #${i + 1}: ${r.plan ? JSON.stringify(r.plan) : `none (raw ${JSON.stringify(r.raw.slice(0, 60))})`}`));
    let greeting: { said: string[]; other: string[] } | null = null;
    if (GREET) {
      greeting = s.surface === 'game' ? await gameGreeting(s, c, plan) : await callGreeting(s, c, plan);
      console.log(`  greeting: ${greeting.said.map((x) => JSON.stringify(x)).join(' | ') || '(no line)'}`);
      if (greeting.other.length) console.log(`    also: ${greeting.other.join(' ; ')}`);
    }
    results.push({ ...s, name: c.name, gate, runs, plan, greeting });
  }
  const cost = costUsd();
  console.log(
    `\nmodel ${MODEL}; ${usage.calls} calls; tokens in ${usage.in}, cache write ${usage.cw}, cache read ${usage.cr}, out ${usage.out}; ` +
      `web searches ${usage.webSearches}; cost $${cost.toFixed(4)} at Haiku 5.5 list`,
  );
  const file = join(OUT, ONLY ? `results-${ONLY}.json` : 'results.json');
  writeFileSync(file, JSON.stringify({ model: MODEL, reps: REPS, at: new Date().toISOString(), usage, costUsd: cost, results }, null, 2));
  console.log('wrote', file);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
