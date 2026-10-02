/**
 * Search QA, Minecraft in-world bot (261003).
 *
 *   npx vitest run --config scripts/search-qa/vitest.config.ts minecraft
 *
 * Plays the scripted Minecraft conversation through the REAL game brain:
 * createOrchestrator with the real Minecraft adapter's prompt surface (world
 * primer, action rules, action schemas), real ConfigSchema defaults, the real
 * Anthropic provider (dev test key as a BYOK key) and the real web session.
 * Only the world is faked: a fixed snapshot, actions resolve "done", and
 * say() lines are captured instead of going to Minecraft chat.
 *
 * SEI_QA_KIND=client hides Anthropic's server web_search so the bot gets our
 * client search()/visit() chain (what a non-Anthropic BYOK user gets), with
 * Node fetch since this runs outside Electron.
 */
import { describe, it } from 'vitest';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
// @ts-expect-error untyped JS module
import { ConfigSchema } from '../../src/bot/config.js';
// @ts-expect-error untyped JS module
import { createMinecraftAdapter } from '../../src/bot/adapter/minecraft/index.js';
// @ts-expect-error untyped JS module
import { createOrchestrator, _setTickIntervalForTests } from '../../src/bot/brain/orchestrator.js';
// @ts-expect-error untyped JS module
import { createLlmProvider } from '../../src/bot/brain/llm/index.js';
import { CONVERSATIONS } from './conversations';

const OUT = process.env.SEI_QA_OUT || path.join(tmpdir(), 'sei-search-qa');
const RUNS = Number(process.env.SEI_QA_RUNS || 1);
const KIND = process.env.SEI_QA_KIND || 'anthropic';
const PLAYER = 'Kai';

const SNAPSHOT = `snapshot: pos: 212,71,-140
biome: forest  surroundings: outside  time: day (4210)
hp: 20/20  food: 18/20  xp: lvl 14
holding: iron_pickaxe
inventory (11/36 slots): iron_pickaxe cobblestone×64 oak_log×12 torch×23 bread×6 iron_ingot×9 coal×17 raw_iron×4 oak_planks×20 string×3 bone×2
terrain at feet: 22 grass_block, 9 short_grass
nearby blocks:
  #1 oak_log x14 @209,72,-143
  #2 water x60 @218,62,-136
  #3 stone x200 @212,66,-140
nearby entities:
  #4 ${PLAYER} @214,71,-138
  #5 sheep @205,71,-150
follow_target: ${PLAYER}
owner ${PLAYER}: @214,71,-138 (3 blocks away)`;

function testKey(): string {
  return process.env.ANTHROPIC_API_KEY || readFileSync(path.join(homedir(), '.sei-dev', 'anthropic-test-key'), 'utf8').trim();
}

type Block = { type: string; name?: string; input?: { query?: string; ref?: string; text?: string }; text?: string; citations?: unknown[] };

async function runOnce(run: number, char: { name: string; persona: { expanded: string } }): Promise<unknown> {
  const memDir = await mkdtemp(path.join(tmpdir(), 'sei-qa-mc-'));
  const config = ConfigSchema.parse({
    chat_mode: 'chat',
    realistic_typing: false,
    player_username: PLAYER,
    player_display_name: PLAYER,
    preferred_name: PLAYER,
    lan_motd: null,
    persona: { name: char.name, expanded: char.persona.expanded, proactiveness: 1 },
    anthropic: { api_key: testKey(), model: process.env.SEI_QA_MODEL || 'claude-haiku-4-5' },
    llm: { provider: 'anthropic' },
    adapter: {
      kind: 'minecraft',
      minecraft: { host: '127.0.0.1', port: 25565, auth: 'offline', username: char.name, version: 'auto' },
    },
    memory: {
      player_md_path: `${memDir}/PLAYER.md`,
      memory_md_path: `${memDir}/MEMORY.md`,
      heartbeat_md_path: `${memDir}/HEARTBEAT.md`,
      worlds_json_path: `${memDir}/worlds.json`,
    },
    vision: { mode: 'off' },
  });

  const said: string[] = [];
  const logs: string[] = [];
  const responses: Array<{ ms: number; content: Block[]; stop: string | null }> = [];
  const bot = { chat() {}, username: char.name, players: {}, on() {}, off() {}, removeListener() {}, once() {} };
  const real = createMinecraftAdapter({ bot, config, visionEnabled: false });
  const adapter = {
    ...real,
    createSnapshotComposer: () => ({ next: () => SNAPSHOT }),
    executeAction: async () => 'done',
    chat: (msg: string) => { said.push(msg); },
    closeAnySessions: async () => {},
  };
  const p = createLlmProvider(config);
  const provider = {
    call: async (args: unknown) => {
      const t0 = Date.now();
      const r = await p.call(args);
      responses.push({ ms: Date.now() - t0, content: (r.content ?? []) as Block[], stop: r.stopReason ?? null });
      return r;
    },
    buildCachedSystem: p.buildCachedSystem,
    setAuthToken: p.setAuthToken,
    setBackend: p.setBackend,
    model: p.model,
    kind: p.kind,
    capabilities: KIND === 'client' ? { ...p.capabilities, serverWebSearch: false } : p.capabilities,
  };
  const push = (lvl: string) => (...a: unknown[]) => { const s = a.map(String).join(' '); if (/web|search|visit|\[sei\/orch\]/.test(s)) logs.push(`${lvl} ${s}`); };
  const logger = { info: push('I'), warn: push('W'), error: push('E'), debug: () => {} };
  _setTickIntervalForTests(10_000_000);
  const orch = createOrchestrator({ adapter, config, logger, reenqueue: () => {}, _anthropicOverride: provider });

  const convo = CONVERSATIONS.find((c) => c.id === 'MC')!;
  const turns: unknown[] = [];
  for (const t of convo.turns) {
    responses.length = 0;
    said.length = 0;
    logs.length = 0;
    const t0 = Date.now();
    await orch.handleDispatch('sei:chat_received', { text: t.text, username: PLAYER, playerSpoke: true, ts: Date.now() });
    const ms = Date.now() - t0;
    // A say() with several sentences goes out as staggered chat lines (550 ms
    // apart); wait for the tail so it is counted on this turn, not the next.
    await new Promise((r) => setTimeout(r, 2_000));
    const all = responses.flatMap((r) => r.content);
    const queries = all
      .filter((b) => (b.type === 'server_tool_use' && b.name === 'web_search') || (b.type === 'tool_use' && b.name === 'search'))
      .map((b) => String(b.input?.query ?? ''));
    // A web_search the API actually ran has a result block; one written after
    // a say() in the same response has none.
    const ran = all.filter((b) => b.type === 'web_search_tool_result').length + all.filter((b) => b.type === 'tool_use' && b.name === 'search').length;
    const visits = all.filter((b) => b.type === 'tool_use' && b.name === 'visit').map((b) => String(b.input?.ref ?? ''));
    const tools = all.filter((b) => b.type === 'tool_use').map((b) => b.name);
    turns.push({
      player: t.text, label: t.label, qid: t.qid ?? null,
      searched: ran > 0, asked: queries.length, ran, queries, visits, tools,
      calls: responses.length, stops: responses.map((r) => r.stop), ms,
      said: [...said],
      scratch: all.filter((b) => b.type === 'text').map((b) => b.text).join(' | ').slice(0, 600),
      logs: [...logs].slice(0, 20),
    });
    process.stdout.write(`[MC#${run}] ${t.label.padEnd(6)} ${queries.length ? 'SEARCH ' + JSON.stringify(queries) : '-'} ${ms}ms\n   > ${t.text}\n   < ${said.join(' / ')}\n`);
  }
  try { await orch.dispose?.(); } catch { /* ignore */ }
  return { convo: 'MC', game: 'Minecraft', run, character: char.name, kind: KIND, turns };
}

describe('search QA: minecraft bot', () => {
  it('runs the conversation', async () => {
    const char = JSON.parse(await readFile(process.env.SEI_QA_CHAR!, 'utf8'));
    await mkdir(OUT, { recursive: true });
    const results: unknown[] = [];
    for (let r = 1; r <= RUNS; r++) results.push(await runOnce(r, char));
    await writeFile(path.join(OUT, `minecraft-${process.env.SEI_QA_TAG || 'run'}.json`), JSON.stringify(results, null, 2));
  }, 3_600_000);
});
