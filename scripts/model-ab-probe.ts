/**
 * scripts/model-ab-probe.ts — side-by-side model A/B on the real companion
 * surfaces (261008, Haiku 4.5 vs Haiku 5.5).
 *
 * Runs the same scenes through each "arm" (model + request extras) and prints,
 * per call: what the companion says, the tool calls (schema-checked against
 * the real tool definitions), private scratchpad text, stop reason, thinking
 * blocks, time to first token, full-turn time, tokens and dollar cost at the
 * model's list price. Ends with a per-arm summary table.
 *
 * Surfaces:
 *   game  — pinned Minecraft system blocks + tool list from
 *           src/bot/brain/__fixtures__/minecraftSystemBlocks.json with the Sui
 *           persona swapped in, seed turn from composeSeedBlocks, max_tokens
 *           1024 (the brain default). Speech only via the say() tool.
 *   chat  — the chat surface (buildSystemBlocks) as a text chat or a voice
 *           call, max_tokens 200 (chatService's reply budget). Text is the reply.
 *
 * Prompts are NOT changed per arm; only the request parameters differ.
 * Prompt caching mirrors the app: cache_control on the last system block.
 *
 * Key (dev-only): ANTHROPIC_API_KEY env wins, else ~/.sei-dev/anthropic-test-key.
 * Persona: SEI_PROBE_PERSONA=<characters row JSON (array or object) with
 * persona_expanded> uses that persona; otherwise the demo fixture sui.json.
 *
 * Usage: npx tsx scripts/model-ab-probe.ts [--reps 3] [--arms h45,h55off] [--scene G_JOIN]
 */
import Anthropic from '@anthropic-ai/sdk';
import Ajv from 'ajv';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NUDGES, SEED_HEADERS, renderPersona } from '../src/bot/brain/prompts.js';
import { CUBOID_GRAMMAR, eventAddendum } from '../src/bot/adapter/minecraft/prompts.js';
import { composeSeedBlocks } from '../src/bot/brain/orchestrator.js';
import { buildSystemBlocks, LAUNCH_TOOL, QUIT_TOOL, END_CALL_TOOL, REMEMBER_TOOL } from '../src/main/chat/chatPrompts';

// ── arms ────────────────────────────────────────────────────────────────────
type Price = { in: number; cw: number; cr: number; out: number }; // $/MTok
const PRICES: Record<string, Price> = {
  'claude-haiku-4-5': { in: 1.0, cw: 1.25, cr: 0.1, out: 5.0 },
  // Prompts up to 100k tokens (every scene here is far below that).
  'claude-haiku-5-5': { in: 0.1, cw: 0.125, cr: 0.01, out: 0.5 },
};
const ARMS: Record<string, { model: string; extra: Record<string, unknown>; label: string }> = {
  h45: { model: 'claude-haiku-4-5', extra: {}, label: 'Haiku 4.5 (today)' },
  h55off: { model: 'claude-haiku-5-5', extra: { thinking: { type: 'disabled' } }, label: 'Haiku 5.5 thinking off' },
  h55: { model: 'claude-haiku-5-5', extra: {}, label: 'Haiku 5.5 default (adaptive, medium)' },
  h55low: { model: 'claude-haiku-5-5', extra: { output_config: { effort: 'low' } }, label: 'Haiku 5.5 adaptive, effort low' },
};

const argv = process.argv.slice(2);
const flag = (n: string, d: string | null = null) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] ?? d : d;
};
const REPS = Number(flag('--reps', '3')) || 3;
const SCENE = flag('--scene');
const ARM_KEYS = (flag('--arms') ?? Object.keys(ARMS).join(',')).split(',').filter((k) => ARMS[k]);

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
const client = new Anthropic({ apiKey, maxRetries: 0 });

// ── persona ─────────────────────────────────────────────────────────────────
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
function loadSuiPersona(): { source: string; expanded?: string } {
  const p = process.env.SEI_PROBE_PERSONA;
  if (p) {
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    const row = Array.isArray(raw) ? raw[0] : raw;
    return { source: row.persona_source ?? '', expanded: row.persona_expanded };
  }
  return JSON.parse(readFileSync(join(root, 'demo/fixtures/default-characters/sui.json'), 'utf8')).persona;
}
const SUI = loadSuiPersona();
const SUI_TEXT = SUI.expanded || SUI.source;

// ── game surface ────────────────────────────────────────────────────────────
const fixture = JSON.parse(readFileSync(join(root, 'src/bot/brain/__fixtures__/minecraftSystemBlocks.json'), 'utf8'));
const GAME_BLOCKS: string[] = fixture.base.blocks.map((b: string, i: number) =>
  i === 1 ? renderPersona({ name: 'Sui', expanded: SUI_TEXT }) : b,
);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const GAME_TOOLS: any[] = fixture.base.tools;
const CHAT_TOOLS = [LAUNCH_TOOL, QUIT_TOOL, END_CALL_TOOL, REMEMBER_TOOL];

const ajv = new Ajv({ strict: false, allErrors: true });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const validators = new Map<string, any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
for (const t of [...GAME_TOOLS, ...(CHAT_TOOLS as any[])]) validators.set(t.name, ajv.compile(t.input_schema));

const PLAYER_SEED = '# Player\nplayer_username: SSk1tz\npreferred_name: Ouen\ntotal_sessions: 23\n';

const SNAP_WOODS = `snapshot: pos: 64,70,-12
biome: forest  surroundings: outside  time: day (1200)
hp: 20/20  food: 18/20  xp: lvl 0
holding: oak_log
inventory (2/36 slots): oak_log×3 dirt×1
terrain at feet: 20 grass_block, 6 oak_leaves
nearby blocks:
  #1 oak_log x12 @62,71,-14
  #2 stone x60 @66,66,-15
nearby entities:
  #3 SSk1tz @67,70,-15
follow_target: (none)
owner SSk1tz: @67,70,-15 (4 blocks away)`;

const SNAP_DIG = `snapshot: pos: 120,64,30
biome: plains  surroundings: outside  time: day (3000)
hp: 20/20  food: 20/20  xp: lvl 0
holding: wooden_pickaxe
in_flight: dig() started=6.0s ago
inventory (3/36 slots): oak_log×6 dirt×4 wooden_pickaxe×1
terrain at feet: 25 grass_block, 8 short_grass
nearby blocks:
  #1 oak_log x8 @118,65,28
  #2 stone x40 @122,60,33
nearby entities:
  #3 SSk1tz @126,64,35
follow_target: (none)
owner SSk1tz: @126,64,35 (8 blocks away)`;

const SNAP_CABIN = `snapshot: pos: 12,70,-4
biome: plains  surroundings: outside  time: day (9200)
hp: 20/20  food: 18/20  xp: lvl 3
holding: oak_planks
inventory (5/36 slots): oak_planks×22 oak_log×6 stone_pickaxe×1 cobblestone×31 torch×4
terrain at feet: 20 grass_block, 6 dirt
nearby blocks:
  #1 oak_planks x58 @10,70,-6
  #2 grass_block x210 @12,69,-4
nearby entities:
  #3 SSk1tz @14,70,-2
follow_target: (none)
owner SSk1tz: @14,70,-2 (3 blocks away)`;

const SNAP_LOWHP = `snapshot: pos: -2,94,14
biome: plains  surroundings: outside  time: night (18414)
hp: 4/20  food: 15/20  xp: lvl 0
holding: dirt
inventory (2/36 slots): dirt×1 white_banner×1
terrain at feet: 13 grass_block, 11 dirt
nearby blocks:
  #1 grass_block x183 @-2,94,14
nearby entities:
  #2 SSk1tz @-2,93,16
  #3 skeleton @17,96,-24
follow_target: (none)
owner SSk1tz: @-2,93,16 (2 blocks away)`;

const SNAP_ATTACKED = `snapshot: pos: -3,88,22
biome: plains  surroundings: outside  time: night (17134)
hp: 12/20  food: 16/20  xp: lvl 0
holding: stone_sword
inventory (3/36 slots): dirt×4 stone_sword×1 white_banner×1
terrain at feet: 16 stone, 8 grass_block, 6 dirt
nearby blocks:
  #1 grass_block x369 @-3,88,21
nearby entities:
  #2 zombie @-4,88,23
  #3 SSk1tz @7,86,35
follow_target: (none)
owner SSk1tz: @7,86,35 (17 blocks away)
recent_events: hp -3 (zombie)`;

const CABIN_HB = '# Heartbeat\n\n- [2026-10-07T20:11:02.000Z] build a small oak cabin by the river with Ouen, walls and a roof, done when we can sleep in it\n';
const CABIN_MEM = '# Memory\n\n- [2026-10-07] ouen and i picked the spot by the river for the cabin. they wanted a big window facing the water\n- [2026-10-08] walls are up, roof still missing. ran out of planks halfway\n';

function playerChat(text: string) {
  const eventText = `Event: player_chat${eventAddendum('player_chat', { username: 'SSk1tz', text })}${NUDGES.playerInterruptHint}`;
  const playerMessageText =
    `the player just spoke to you. respond to THIS, not to the scene around you:\n"${text}"\n` +
    'Reply with the say() tool — a direct message never gets silence, even if your answer is a refusal or a single word. ' +
    'Your text output is a private scratchpad the player can NEVER see — a reply that exists only in your text is silence to them; only say() reaches them.';
  return { eventText, playerMessageText };
}

const FIRST_CONTACT = `Event: idle\nData: {"reason":"just_connected_first_spawn"}${eventAddendum('sei:idle', {})}\n\nFIRST CONTACT: you just spawned into your friend's world — this is the very first thing they will see from you this session. Before anything else, open with exactly ONE short in-character greeting via the say() tool (a hello, a tease, a boast — whatever fits your voice). Do NOT stay silent on this first tick and do NOT narrate the scene or your inventory; just greet them like you're glad (or smug) to be back, then you may start doing your own thing.`;

type Expect = { mustSay?: boolean; anyOf?: string[]; noneOf?: string[] };
type GameScene = {
  kind: 'game';
  heartbeat: string;
  memory: string;
  snapshot: string;
  eventText: string;
  playerMessageText?: string;
  expect: Expect;
  note: string;
};
type ChatScene = { kind: 'chat'; voice: boolean; memory: string; history: [string, string][]; expect: Expect; note: string };

const SCENES: Record<string, GameScene | ChatScene> = {
  G_JOIN: { kind: 'game', heartbeat: '', memory: '', snapshot: SNAP_CABIN, eventText: FIRST_CONTACT, expect: { mustSay: true }, note: 'first spawn: one greeting via say()' },
  G_WOOD: {
    kind: 'game', heartbeat: '', memory: '', snapshot: SNAP_WOODS, ...playerChat('can you grab me some wood?'),
    expect: { mustSay: true, anyOf: ['gather', 'dig', 'setGoal'] }, note: 'player request: reply + start gathering logs',
  },
  G_WAIT: {
    kind: 'game', heartbeat: '', memory: '', snapshot: SNAP_DIG,
    eventText: NUDGES.actionTurn({ action: 'dig', stopTool: 'end_loop', playerLine: 'wait for me', who: 'Ouen' }),
    expect: { noneOf: ['follow', 'goTo'] }, note: 'mid-dig "wait for me": hold, do not follow/path',
  },
  G_IDLE: {
    kind: 'game', heartbeat: '', memory: '', snapshot: SNAP_WOODS, eventText: `Event: idle${eventAddendum('sei:idle', {})}`,
    expect: { anyOf: ['setGoal', 'gather', 'dig', 'craft', 'explore'] }, note: 'idle, no goal, no pickaxe: realistic self-started goal',
  },
  G_GOAL: {
    kind: 'game', heartbeat: CABIN_HB, memory: CABIN_MEM, snapshot: SNAP_CABIN, eventText: `Event: idle${eventAddendum('sei:idle', {})}`,
    expect: { anyOf: ['build', 'placeBlock', 'craft', 'gather', 'dig', 'goTo'], noneOf: ['clearGoal'] }, note: 'standing goal (cabin roof): act toward it',
  },
  G_LOWHP: {
    kind: 'game', heartbeat: '', memory: '', snapshot: SNAP_LOWHP, ...playerChat('u good?'),
    expect: { mustSay: true }, note: '4 hp, "u good?": honest in-voice reply',
  },
  G_ATTACK: {
    kind: 'game', heartbeat: '', memory: '', snapshot: SNAP_ATTACKED, eventText: 'Interrupted — zombie hit you. Respond appropriately.',
    expect: { anyOf: ['attackEntity'] }, note: 'zombie hits her: fight back',
  },
  T_CHAT: {
    kind: 'chat', voice: false, memory: CABIN_MEM,
    history: [['user', '[8 Oct 19:02] ugh my boss yelled at me in front of everyone today']],
    expect: {}, note: 'text chat, emotional message: in-voice, natural',
  },
  V_PLAN: {
    kind: 'chat', voice: true, memory: CABIN_MEM,
    history: [
      ['user', '[8 Oct 22:40] hey sui'],
      ['assistant', 'heyy, what is up'],
      ['user', '[8 Oct 22:41] what should we do in minecraft tomorrow?'],
    ],
    expect: {}, note: 'voice call: short spoken reply that uses memory',
  },
  V_BYE: {
    kind: 'chat', voice: true, memory: CABIN_MEM,
    history: [
      ['user', '[8 Oct 23:02] yo sui, still up?'],
      ['assistant', 'always. what is up'],
      ['user', '[8 Oct 23:03] was thinking, tomorrow we should go find a village and get a bed so we stop dying at night'],
      ['assistant', 'oh yes, beds. i am so tired of the zombies'],
      ['user', '[8 Oct 23:05] ok cool, gonna hang up and crash. night sui'],
    ],
    expect: { anyOf: ['end_call'] }, note: 'voice call goodbye: end_call with a farewell',
  },
  V_GOAL: {
    kind: 'chat', voice: true, memory: CABIN_MEM,
    history: [
      ['user', '[8 Oct 23:02] yo sui, still up?'],
      ['assistant', 'always. what is up'],
      ['user', '[8 Oct 23:03] was thinking, tomorrow we should go find a village and get a bed so we stop dying at night'],
      ['assistant', 'oh yes, beds. i am so tired of the zombies'],
      ['user', '[8 Oct 23:05] ok cool, im gonna crash now. night sui'],
    ],
    expect: { anyOf: ['end_call', 'remember'] }, note: 'call ends after making a plan: keep the plan (remember or end_call next_time)',
  },
  T_LAUNCH: {
    kind: 'chat', voice: false, memory: CABIN_MEM,
    history: [['user', '[8 Oct 19:30] yo wanna hop on minecraft and finish the roof?']],
    expect: { anyOf: ['launch'] }, note: 'text chat invite to play: call launch',
  },
  T_FACT: {
    kind: 'chat', voice: false, memory: '',
    history: [['user', "[8 Oct 19:30] remember this: my sister's name is Mika and she's visiting next week"]],
    expect: { anyOf: ['remember'] }, note: 'explicit "remember this": call remember',
  },
};

// ── calls ───────────────────────────────────────────────────────────────────
type Block = { type: string; text?: string; name?: string; input?: Record<string, unknown>; thinking?: string };
type Result = {
  content: Block[];
  usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
  stop: string | null;
  ttftMs: number | null;
  sayMs: number | null;
  totalMs: number;
};

async function streamCall(arm: string, body: Record<string, unknown>, maxTokens: number): Promise<Result> {
  const a = ARMS[arm];
  for (let attempt = 0; ; attempt++) {
    const t0 = Date.now();
    let ttft: number | null = null;
    let sayMs: number | null = null;
    let curName: string | null = null;
    try {
      const stream = client.messages.stream({ model: a.model, max_tokens: maxTokens, ...body, ...a.extra } as never);
      for await (const ev of stream as AsyncIterable<{ type: string; content_block?: { type: string; name?: string }; delta?: { type: string } }>) {
        if (ev.type === 'content_block_start') curName = ev.content_block?.type === 'tool_use' ? ev.content_block.name ?? null : null;
        // First token the player could perceive: visible text or a tool call
        // (a thinking delta is not perceivable).
        if (ttft === null && ev.type === 'content_block_delta' && (ev.delta?.type === 'text_delta' || ev.delta?.type === 'input_json_delta')) ttft = Date.now() - t0;
        // The brain speaks the say() line at its block close.
        if (sayMs === null && ev.type === 'content_block_stop' && curName === 'say') sayMs = Date.now() - t0;
      }
      const msg = await (stream as unknown as { finalMessage: () => Promise<{ content: Block[]; usage: Result['usage']; stop_reason: string | null }> }).finalMessage();
      return { content: msg.content, usage: msg.usage, stop: msg.stop_reason, ttftMs: ttft, sayMs, totalMs: Date.now() - t0 };
    } catch (e) {
      const st = (e as { status?: number })?.status;
      if ((st === 429 || st === 529 || st === 500) && attempt < 5) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
}

function cost(model: string, u: Result['usage']) {
  const p = PRICES[model];
  return (
    (u.input_tokens * p.in + (u.cache_creation_input_tokens ?? 0) * p.cw + (u.cache_read_input_tokens ?? 0) * p.cr + u.output_tokens * p.out) / 1e6
  );
}
/** Steady-state cost: the same turn with the whole stable prefix already cached. */
function steadyCost(model: string, u: Result['usage']) {
  const p = PRICES[model];
  const cached = (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  return (u.input_tokens * p.in + cached * p.cr + u.output_tokens * p.out) / 1e6;
}

function withCache(system: string[]) {
  return system.map((text, i) => (i === system.length - 1 ? { type: 'text', text, cache_control: { type: 'ephemeral' } } : { type: 'text', text }));
}

async function gameCall(arm: string, s: GameScene): Promise<Result> {
  const dir = await mkdtemp(join(tmpdir(), 'sei-ab-'));
  try {
    const memPath = join(dir, 'MEMORY.md');
    const hbPath = join(dir, 'HEARTBEAT.md');
    await writeFile(memPath, s.memory);
    await writeFile(hbPath, s.heartbeat);
    const seed = await composeSeedBlocks({
      sessionState: { playerData: () => ({ username: 'SSk1tz', preferred_name: 'Ouen' }) },
      playerStore: { formatPlayerSeedBlock: () => PLAYER_SEED },
      config: { persona: { proactiveness: 2 }, memory: { memory_md_path: memPath, heartbeat_md_path: hbPath, seed_memory_budget_bytes: 8192, seed_heartbeat_budget_bytes: 2048 } },
      eventText: s.eventText,
      snapshotText: s.snapshot,
      playerMessageText: s.playerMessageText ?? null,
      adapter: { cuboidGrammar: () => CUBOID_GRAMMAR },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    });
    return await streamCall(
      arm,
      { system: withCache(GAME_BLOCKS), tools: GAME_TOOLS, messages: [{ role: 'user', content: seed.map((b: { text: string }) => ({ type: 'text', text: b.text })) }] },
      1024,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function chatCall(arm: string, s: ChatScene): Promise<Result> {
  const system = buildSystemBlocks({
    persona: SUI, name: 'Sui', preferredName: 'Ouen', proactiveness: 1, punctuation: 'casual', memory: s.memory, summary: '',
    knowledge: '', openWorldDetected: false, inGame: false, voiceCall: s.voice, language: 'en',
  } as Parameters<typeof buildSystemBlocks>[0]);
  return streamCall(
    arm,
    { system: withCache(system.map((b) => b.text)), tools: CHAT_TOOLS, messages: s.history.map(([role, text]) => ({ role, content: text })) },
    200,
  );
}

// ── grading ─────────────────────────────────────────────────────────────────
function grade(s: GameScene | ChatScene, r: Result) {
  const tools = r.content.filter((b) => b.type === 'tool_use');
  const says = tools.filter((t) => t.name === 'say').map((t) => String(t.input?.text ?? ''));
  const names = tools.map((t) => t.name!);
  const text = r.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('').trim();
  const thinking = r.content.filter((b) => b.type === 'thinking' || b.type === 'redacted_thinking').length;
  const invalid = tools.filter((t) => !validators.get(t.name!)?.(t.input)).map((t) => t.name!);
  const issues: string[] = [];
  if (invalid.length) issues.push(`invalid-args:${invalid.join('+')}`);
  if (r.stop === 'max_tokens') issues.push('max_tokens');
  if (r.stop === 'refusal') issues.push('refusal');
  if (s.kind === 'game') {
    if (s.expect.mustSay && !says.length) issues.push(text ? 'LEAK(text-no-say)' : 'silent');
    if (says.length > 1) issues.push(`say×${says.length}`);
  } else if (!text && !tools.some((t) => t.name === 'end_call' && t.input?.farewell)) {
    issues.push('empty-reply');
  }
  if (s.expect.anyOf && !names.some((n) => s.expect.anyOf!.includes(n))) issues.push(`missing:${s.expect.anyOf.join('|')}`);
  if (s.expect.noneOf) for (const n of names) if (s.expect.noneOf.includes(n)) issues.push(`bad:${n}`);
  return { says, names, text, thinking, issues, tools };
}

async function main() {
  console.log(`arms=${ARM_KEYS.join(',')} reps=${REPS} persona=${process.env.SEI_PROBE_PERSONA ? 'live row' : 'demo fixture'}`);
  const stats: Record<string, { n: number; pass: number; ttft: number[]; total: number[]; say: number[]; inTok: number[]; outTok: number[]; cost: number[]; steady: number[]; issues: Record<string, number> }> = {};
  for (const k of ARM_KEYS) stats[k] = { n: 0, pass: 0, ttft: [], total: [], say: [], inTok: [], outTok: [], cost: [], steady: [], issues: {} };
  const scenes = Object.entries(SCENES).filter(([id]) => !SCENE || id === SCENE);
  for (const [id, s] of scenes) {
    console.log(`\n== ${id} — ${s.note}`);
    for (let r = 0; r < REPS; r++) {
      // Interleave arms inside each rep so time-of-day load hits all arms alike.
      for (const arm of ARM_KEYS) {
        let res: Result;
        try {
          res = s.kind === 'game' ? await gameCall(arm, s) : await chatCall(arm, s);
        } catch (e) {
          console.log(`  [${arm}] #${r + 1} ERROR ${(e as Error).message.slice(0, 300)}`);
          stats[arm].n++;
          stats[arm].issues['api-error'] = (stats[arm].issues['api-error'] ?? 0) + 1;
          continue;
        }
        const g = grade(s, res);
        const st = stats[arm];
        const model = ARMS[arm].model;
        const promptTok = res.usage.input_tokens + (res.usage.cache_creation_input_tokens ?? 0) + (res.usage.cache_read_input_tokens ?? 0);
        st.n++;
        if (!g.issues.length) st.pass++;
        for (const i of g.issues) st.issues[i] = (st.issues[i] ?? 0) + 1;
        if (res.ttftMs != null) st.ttft.push(res.ttftMs);
        if (res.sayMs != null) st.say.push(res.sayMs);
        st.total.push(res.totalMs);
        st.inTok.push(promptTok);
        st.outTok.push(res.usage.output_tokens);
        st.cost.push(cost(model, res.usage));
        st.steady.push(steadyCost(model, res.usage));
        const speech = s.kind === 'game' ? (g.says.length ? g.says.map((x) => `“${x}”`).join(' ') : '(no say)') : g.text ? `“${g.text}”` : '(no text)';
        const others = g.tools.filter((t) => t.name !== 'say').map((t) => `${t.name}(${JSON.stringify(t.input)})`).join(' ');
        console.log(
          `  [${arm}] #${r + 1} ${g.issues.length ? 'FAIL ' + g.issues.join(',') : 'ok'}  ttft=${res.ttftMs ?? '-'}ms total=${res.totalMs}ms in=${promptTok} out=${res.usage.output_tokens} think=${g.thinking} $${cost(model, res.usage).toFixed(5)}`,
        );
        console.log(`      says: ${speech}`);
        if (others) console.log(`      tools: ${others.slice(0, 400)}`);
        if (s.kind === 'game' && g.text) console.log(`      scratch: ${JSON.stringify(g.text.slice(0, 240))}`);
      }
    }
  }
  const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);
  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
  console.log('\n== SUMMARY');
  console.log('arm      pass     ttft_med  say_med  total_med  in_tok  out_tok  $/turn(run)  $/turn(warm)  issues');
  for (const k of ARM_KEYS) {
    const s = stats[k];
    console.log(
      `${k.padEnd(8)} ${`${s.pass}/${s.n}`.padEnd(8)} ${String(med(s.ttft)).padEnd(9)} ${String(med(s.say)).padEnd(8)} ${String(med(s.total)).padEnd(10)} ${String(Math.round(mean(s.inTok))).padEnd(7)} ${String(Math.round(mean(s.outTok))).padEnd(8)} ${mean(s.cost).toFixed(5).padEnd(12)} ${mean(s.steady).toFixed(5).padEnd(13)} ${JSON.stringify(s.issues)}`,
    );
  }
  const spent = ARM_KEYS.reduce((acc, k) => acc + stats[k].cost.reduce((x, y) => x + y, 0), 0);
  console.log(`\ntotal spend ≈ $${spent.toFixed(3)}`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
