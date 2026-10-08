/**
 * scripts/next-step-probe.ts — live check of the goodbye "next time" hook
 * (261008, retention fix 2(c)).
 *
 * Runs real goodbye turns through the REAL prompt assembly and tool lists and
 * prints what the companion says plus the next_time field it fills (or not):
 *   GAME_GOAL    in-game "gtg" with an unfinished heartbeat goal
 *   GAME_NONE    in-game "gtg" on a fresh session with nothing going on
 *   GAME_GREET   next session's first-spawn greeting with a saved plan in MEMORY.md
 *   CALL_GOAL    chat-surface voice call ending after making a plan
 *   CALL_NONE    chat-surface voice call ending after small talk
 *
 * Game turns use the pinned tool list + cached system blocks from
 * src/bot/brain/__fixtures__/minecraftSystemBlocks.json (regenerate it after a
 * prompt change), with the bundled Sui persona swapped in. Call turns build
 * the chat surface with buildSystemBlocks + the voice tool list.
 *
 * Key (dev-only): ANTHROPIC_API_KEY env wins, else ~/.sei-dev/anthropic-test-key.
 *
 * Usage: npx tsx scripts/next-step-probe.ts [--reps 2] [--scene GAME_GOAL]
 */
import Anthropic from '@anthropic-ai/sdk';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NUDGES, SEED_HEADERS, renderPersona, NEXT_TIME_GREETING } from '../src/bot/brain/prompts.js';
import { CUBOID_GRAMMAR, eventAddendum } from '../src/bot/adapter/minecraft/prompts.js';
import { composeSeedBlocks } from '../src/bot/brain/orchestrator.js';
import { buildSystemBlocks, LAUNCH_TOOL, QUIT_TOOL, END_CALL_TOOL, REMEMBER_TOOL } from '../src/main/chat/chatPrompts';

const MODEL = process.env.SEI_PROBE_MODEL || 'claude-haiku-4-5';
const argv = process.argv.slice(2);
const flag = (n: string, d: string | null = null) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] ?? d : d;
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

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(readFileSync(join(root, 'src/bot/brain/__fixtures__/minecraftSystemBlocks.json'), 'utf8'));
const sui = JSON.parse(readFileSync(join(root, 'demo/fixtures/default-characters/sui.json'), 'utf8'));
const SUI_EXPANDED: string = sui.persona.expanded || sui.persona.source;

// ── game surface ────────────────────────────────────────────────────────────
const GAME_BLOCKS: string[] = fixture.base.blocks.map((b: string, i: number) =>
  i === 1 ? renderPersona({ name: 'Sui', expanded: SUI_EXPANDED }) : b,
);
const GAME_TOOLS = fixture.base.tools;

const SNAP = `snapshot: pos: 12,70,-4
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

const PLAYER_SEED = '# Player\nplayer_username: SSk1tz\npreferred_name: Ouen\ntotal_sessions: 23\n';

function convo(lines: [string, string][]): string {
  return `${SEED_HEADERS.conversation}\n${lines.map(([who, t], i) => `[${(lines.length - i) * 40}s ago] ${who}: ${t}`).join('\n')}`;
}

async function gameTurn(opts: { heartbeat: string; memory: string; convo?: string; eventText: string; playerMessageText?: string }) {
  const dir = await mkdtemp(join(tmpdir(), 'sei-nextstep-'));
  try {
    const memPath = join(dir, 'MEMORY.md');
    const hbPath = join(dir, 'HEARTBEAT.md');
    await writeFile(memPath, opts.memory);
    await writeFile(hbPath, opts.heartbeat);
    const config = {
      persona: { proactiveness: 2 },
      memory: { memory_md_path: memPath, heartbeat_md_path: hbPath, seed_memory_budget_bytes: 8192, seed_heartbeat_budget_bytes: 2048 },
    };
    const seed = await composeSeedBlocks({
      sessionState: { playerData: () => ({ username: 'SSk1tz', preferred_name: 'Ouen' }) },
      playerStore: { formatPlayerSeedBlock: () => PLAYER_SEED },
      config,
      eventText: opts.eventText,
      snapshotText: SNAP,
      recentConversationText: opts.convo ?? null,
      playerMessageText: opts.playerMessageText ?? null,
      adapter: { cuboidGrammar: () => CUBOID_GRAMMAR },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    });
    const resp = await create({
      system: GAME_BLOCKS.map((text) => ({ type: 'text', text })),
      tools: GAME_TOOLS,
      messages: [{ role: 'user', content: seed.map((b: { text: string }) => ({ type: 'text', text: b.text })) }],
    });
    return summarize(resp);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function playerChat(text: string) {
  const eventText = `Event: player_chat${eventAddendum('player_chat', { username: 'SSk1tz', text })}${NUDGES.playerInterruptHint}`;
  const playerMessageText =
    `the player just spoke to you. respond to THIS, not to the scene around you:\n"${text}"\n` +
    'Reply with the say() tool — a direct message never gets silence, even if your answer is a refusal or a single word. ' +
    'Your text output is a private scratchpad the player can NEVER see — a reply that exists only in your text is silence to them; only say() reaches them.';
  return { eventText, playerMessageText };
}

const FIRST_CONTACT = `Event: idle\nData: {"reason":"just_connected_first_spawn"}${eventAddendum('sei:idle', {})}\n\nFIRST CONTACT: you just spawned into your friend's world — this is the very first thing they will see from you this session. Before anything else, open with exactly ONE short in-character greeting via the say() tool (a hello, a tease, a boast — whatever fits your voice). Do NOT stay silent on this first tick and do NOT narrate the scene or your inventory; just greet them like you're glad (or smug) to be back, then you may start doing your own thing. If your memories above hold something relevant, work it into that greeting instead of a generic hello — anything the player said last time about themselves, about you, or about what they wanted to do in Minecraft (say("yo how'd the interview go?") beats say("back in business")). ${NEXT_TIME_GREETING} This is only a hint: if you have no memories or nothing fits, a plain greeting is completely fine — don't force it.`;

// ── chat surface (voice call) ───────────────────────────────────────────────
async function callTurn(memory: string, history: [string, string][]) {
  const system = buildSystemBlocks({
    persona: sui.persona,
    name: 'Sui',
    preferredName: 'Ouen',
    proactiveness: 1,
    punctuation: 'casual',
    memory,
    summary: '',
    knowledge: '',
    openWorldDetected: false,
    inGame: false,
    voiceCall: true,
    language: 'en',
  } as Parameters<typeof buildSystemBlocks>[0]);
  const messages: Array<{ role: string; content: unknown }> = history.map(([role, text]) => ({ role, content: text }));
  // Same hop loop as chatService's call turn, with its tool-result notes:
  // remember() continues the reply; end_call / quit_game stop once a line
  // was spoken (the double-goodbye guard).
  const hops: string[] = [];
  for (let hop = 0; hop < 3; hop++) {
    const res = await create({
      system: system.map((b) => ({ type: 'text', text: b.text })),
      tools: [LAUNCH_TOOL, QUIT_TOOL, END_CALL_TOOL, REMEMBER_TOOL],
      messages,
    });
    hops.push(summarize(res));
    const uses = (res.content ?? []).filter((b: { type: string }) => b.type === 'tool_use') as Array<{ id: string; name: string }>;
    if (!uses.length) break;
    messages.push({ role: 'assistant', content: res.content });
    messages.push({
      role: 'user',
      content: uses.map((u) => ({
        type: 'tool_result',
        tool_use_id: u.id,
        content:
          u.name === 'end_call'
            ? 'You are hanging up the call — it ends right after this turn. If you have not said goodbye yet, say it now (it is still spoken aloud). The player can still reach you in text chat afterward.'
            : u.name === 'remember'
              ? 'Saved to your memory. Continue your reply; do not mention saving it.'
              : 'Not available in this probe.',
      })),
    });
    const spoke = (res.content ?? []).some((b: { type: string; text?: string }) => b.type === 'text' && b.text?.trim());
    if (uses.some((u) => u.name === 'end_call' || u.name === 'quit_game') && (spoke || hops.length > 1)) break;
  }
  return hops.join('\n      -- next hop --\n      ');
}

// ── shared ──────────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function create(body: { system: unknown; tools: unknown; messages: unknown }): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.messages.create({ model: MODEL, max_tokens: 1024, ...(body as object) } as never);
    } catch (e) {
      if ((e as { status?: number })?.status === 429 && attempt < 5) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
}

function summarize(resp: { content?: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }> }) {
  const out: string[] = [];
  for (const b of resp.content ?? []) {
    if (b.type === 'text' && b.text?.trim()) out.push(`text: ${JSON.stringify(b.text.trim())}`);
    if (b.type === 'tool_use') out.push(`${b.name}(${JSON.stringify(b.input)})`);
  }
  return out.join('\n      ');
}

const GOAL_HB = '# Heartbeat\n\n- [2026-10-07T20:11:02.000Z] build a small oak cabin by the river with Ouen, walls and a roof, done when we can sleep in it\n';
const GOAL_MEM = '# Memory\n\n- [2026-10-07] ouen and i picked the spot by the river for the cabin. they wanted a big window facing the water\n- [2026-10-08] walls are up, roof still missing. ran out of planks halfway\n';
const PLAN_MEM = GOAL_MEM + '- [2026-10-08] Plan for next time: finish the cabin roof\n';

const SCENES: Record<string, () => Promise<string>> = {
  GAME_GOAL: () =>
    gameTurn({
      heartbeat: GOAL_HB,
      memory: GOAL_MEM,
      convo: convo([['player (SSk1tz)', 'ok these walls look sick'], ['you', 'right?? roof next, need more planks tho']]),
      ...playerChat('ah crap its late, i gotta go. bye sui'),
    }),
  GAME_NONE: () =>
    gameTurn({
      heartbeat: '',
      memory: '',
      convo: convo([['player (SSk1tz)', 'hey sui'], ['you', 'yo ouen']]),
      ...playerChat('actually nvm i gotta go, bye sui'),
    }),
  GAME_GREET: () => gameTurn({ heartbeat: GOAL_HB, memory: PLAN_MEM, eventText: FIRST_CONTACT }),
  CALL_GOAL: () =>
    callTurn(GOAL_MEM, [
      ['user', '[8 Oct 23:02] yo sui, still up?'],
      ['assistant', 'always. what is up'],
      ['user', '[8 Oct 23:03] was thinking, tomorrow we should go find a village and get a bed so we stop dying at night'],
      ['assistant', 'oh yes, beds. i am so tired of the zombies'],
      ['user', '[8 Oct 23:05] ok cool, im gonna crash now. night sui'],
    ]),
  CALL_GOAL_HANGUP: () =>
    callTurn(GOAL_MEM, [
      ['user', '[8 Oct 23:02] yo sui, still up?'],
      ['assistant', 'always. what is up'],
      ['user', '[8 Oct 23:03] was thinking, tomorrow we should go find a village and get a bed so we stop dying at night'],
      ['assistant', 'oh yes, beds. i am so tired of the zombies'],
      ['user', '[8 Oct 23:05] ok cool, gonna hang up and crash. night sui'],
    ]),
  CALL_NONE: () =>
    callTurn('', [
      ['user', '[8 Oct 23:02] hey sui'],
      ['assistant', 'hey hey, what is going on'],
      ['user', '[8 Oct 23:03] nothing much, just wanted to say hi before bed'],
      ['assistant', 'aw, that is sweet of you'],
      ['user', '[8 Oct 23:04] ok thats it, night!'],
    ]),
};

async function main() {
  console.log(`model=${MODEL} reps=${REPS}`);
  for (const [id, run] of Object.entries(SCENES)) {
    if (SCENE && SCENE !== id) continue;
    console.log(`\n== ${id}`);
    for (let r = 0; r < REPS; r++) console.log(`  #${r + 1}  ${await run()}`);
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
