/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * scripts/game-sim-probe.ts — Haiku 4.5 vs Haiku 5.5 across the game surfaces
 * (261008): Minecraft, Stardew, Don't Starve Together, chess, Draw! and
 * Backseat.
 *
 * Every scene is assembled from the app's REAL prompt builders and tool
 * definitions, nothing hand-written except the scene inputs (snapshots, chat
 * lines, board positions, canvases, screen frames):
 *
 *   minecraft  pinned system blocks + tools (src/bot/brain/__fixtures__/
 *              minecraftSystemBlocks.json), Sui persona swapped in, the
 *              "Available actions" tool block + cache markers exactly as
 *              anthropicClient.buildCachedSystem / stampLastToolCacheControl
 *              add them, seed turn from composeSeedBlocks. max_tokens 1024.
 *   stardew    system + tools captured from createOrchestrator over the real
 *   dontstarve createStardewAdapter / createDontStarveAdapter (stub transport),
 *              snapshots from the real composers (stardew fixture obs-farm.json,
 *              DST frames from scripts/fake-dst-mod.mjs), event text built the
 *              way orchestrator.runIterations builds it. DST survivor pick is the
 *              forced-tool call from survivorPick.ts.
 *   chess      buildSystemBlocks + chessContractBlock, the game thread
 *              (recordPly + buildGameThread), buildChessTurnBlock with REAL
 *              cce-1 candidates (Maia model from the sei checkout), CHESS_TOOLS,
 *              max_tokens 160, TRANSCRIPT_STOP_SEQUENCES. One hop (a played
 *              move ends the turn in the app too).
 *   draw       drawContractBlock + buildGuessTurnBlock over a rendered canvas
 *              PNG (guess turns, max_tokens 200), and a drawing turn with
 *              DRAW_TOOLS (buildDrawTurnBlock, max_tokens 4000, up to 5 hops,
 *              "drawn" tool results + the per-hop notes from drawService).
 *   backseat   BACKSEAT_CONTRACT (+ renderBackseatGameBlock for the Roblox
 *              tile), tickNote, the grid built with gridLayout from real or
 *              rendered frames, sessionTools (server web_search on a game tile).
 *
 * Grading is rule-based per scene (valid tool args against the real schemas,
 * the expected action, say()-only speech, length/format rules per surface,
 * surface-specific filters the app applies). The full transcript of every
 * call goes to --out (JSONL) for manual review of voice and hallucination.
 *
 * Key (dev-only): ANTHROPIC_API_KEY env wins, else ~/.sei-dev/anthropic-test-key.
 * The key is never printed.
 *
 * Usage: npx tsx scripts/game-sim-probe.ts [--reps 3] [--arms h45,h55off]
 *        [--surface minecraft] [--scene M_FOLLOW] [--out /tmp/x.jsonl]
 */
import { register } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

process.env.SEI_PROBE_USERDATA ??= mkdtempSync(join(tmpdir(), 'sei-gamesim-ud-'));
register('./lib/electronStubHooks.mjs', import.meta.url);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAIA_MODEL = process.env.SEI_MAIA_MODEL ?? join(root, '..', 'sei', 'mirror-out', 'chess', 'maia3-5m.onnx');

// ── arms + prices ───────────────────────────────────────────────────────────
type Price = { in: number; cw: number; cr: number; out: number }; // $/MTok
const PRICES: Record<string, Price> = {
  'claude-haiku-4-5': { in: 1.0, cw: 1.25, cr: 0.1, out: 5.0 },
  // Prompts up to 100k tokens (every scene here is far below that).
  'claude-haiku-5-5': { in: 0.1, cw: 0.125, cr: 0.01, out: 0.5 },
};
const WEB_SEARCH_USD = 0.01; // $10 per 1k server web searches
const ARMS: Record<string, { model: string; extra: Record<string, unknown>; label: string }> = {
  h45: { model: 'claude-haiku-4-5', extra: {}, label: 'Haiku 4.5' },
  h55off: { model: 'claude-haiku-5-5', extra: { thinking: { type: 'disabled' } }, label: 'Haiku 5.5, thinking disabled' },
  h55: { model: 'claude-haiku-5-5', extra: {}, label: 'Haiku 5.5, no thinking param (adaptive default)' },
};

const argv = process.argv.slice(2);
const flag = (n: string, d: string | null = null) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] ?? d : d;
};
const REPS = Number(flag('--reps', '3')) || 3;
const ONLY_SURFACE = flag('--surface');
const ONLY_SCENE = flag('--scene');
const ARM_KEYS = (flag('--arms') ?? 'h45,h55off').split(',').filter((k) => ARMS[k]);
const OUT = flag('--out') ?? join(tmpdir(), `game-sim-${Date.now()}.jsonl`);
const ART_DIR = flag('--art') ?? join(dirname(OUT), 'game-sim-art');

function resolveApiKey(): string | undefined {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    return readFileSync(join(homedir(), '.sei-dev', 'anthropic-test-key'), 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

// ── result types ────────────────────────────────────────────────────────────
type Block = { type: string; text?: string; name?: string; id?: string; input?: any; thinking?: string };
type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  server_tool_use?: { web_search_requests?: number } | null;
};
type CallResult = { content: Block[]; usage: Usage; stop: string | null; ttftMs: number | null; sayMs: number | null; totalMs: number };
type SceneOut = {
  calls: CallResult[];
  /** What reaches the player, after the surface's own filters. */
  spoken: string[];
  /** Raw tool_use blocks across hops. */
  tools: Block[];
  /** Raw text (game brain: private scratchpad; others: pre-filter text). */
  rawText: string;
  /** Lines the app's filters would drop, with the reason. */
  dropped: string[];
  issues: string[];
  /** Free-form per-scene facts for the report (guess correctness, move...). */
  facts: Record<string, unknown>;
};

async function main() {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    console.error('No API key (set ANTHROPIC_API_KEY or ~/.sei-dev/anthropic-test-key)');
    process.exit(1);
  }
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const { default: Ajv } = await import('ajv');
  const sharp = (await import('sharp')).default;
  const { Chess } = await import('chess.js');
  const client = new Anthropic({ apiKey, maxRetries: 0 });
  mkdirSync(ART_DIR, { recursive: true });

  // Bot (plain JS, no electron).
  const { NUDGES, renderPersona } = await import('../src/bot/brain/prompts.js');
  const { composeSeedBlocks, createOrchestrator } = await import('../src/bot/brain/orchestrator.js');
  const { ConfigSchema } = await import('../src/bot/config.js');
  const mcPrompts = await import('../src/bot/adapter/minecraft/prompts.js');
  const { createStardewAdapter } = await import('../src/bot/adapter/stardew/index.js');
  const sdRuntime = await import('../src/bot/adapter/stardew/runtime.js');
  const { composeSnapshot: composeStardewSnapshot } = await import('../src/bot/adapter/stardew/observers/snapshot.js');
  const { createDontStarveAdapter } = await import('../src/bot/adapter/dontstarve/index.js');
  const dstRuntime = await import('../src/bot/adapter/dontstarve/runtime.js');
  const { createObservationState, createHandleRegistry } = await import('../src/bot/adapter/dontstarve/protocol.js');
  const { createSnapshotComposer: createDstComposer } = await import('../src/bot/adapter/dontstarve/observers/snapshot.js');
  const { createFakeMod } = await import('./fake-dst-mod.mjs');
  const { isSilenceFiller } = await import('../src/bot/brain/silenceFiller.js');
  const { webToolsFor, isWebTool } = await import('../src/bot/web/webTools.js');
  // Main process (electron stubbed).
  const chatPrompts = await import('../src/main/chat/chatPrompts');
  const chatService = await import('../src/main/chat/chatService');
  const { plainLine } = await import('../src/main/chat/plainLine');
  const { isNoteLeak, stripThoughtTags } = await import('../src/main/chat/noteLeak');
  const chess = await import('../src/main/chess/chessService');
  const drawPrompts = await import('../src/main/draw/drawPrompts');
  const { CANVAS_W, CANVAS_H } = await import('../src/shared/drawIpc');
  const bsPrompts = await import('../src/main/backseat/backseatPrompts');
  const { gridLayout, CELL_W, CELL_H, PREV_GRID_SCALE } = await import('../src/shared/backseatIpc');
  const { backseatGame } = await import('../src/shared/backseatGames');
  const survivorPick = await import('../src/main/games/dontstarve/survivorPick');
  const { renderDstRosterBrief } = await import('../src/shared/dstSurvivors');

  const { buildSystemBlocks, REMEMBER_TOOL, clockNow, markLastMessageCached, markMessageCached } = chatPrompts as any;
  const { toMessages, foldUserNote, splitReply, TRANSCRIPT_STOP_SEQUENCES } = chatService as any;
  const CP = (chess as any).__chessPromptProbe;
  if (!CP) throw new Error('chessService.__chessPromptProbe missing');

  // ── persona / shared context ──────────────────────────────────────────────
  const SUI = JSON.parse(readFileSync(join(root, 'demo/fixtures/default-characters/sui.json'), 'utf8')).persona as { source: string; expanded?: string };
  const SUI_TEXT = SUI.expanded || SUI.source;
  const PERSONA_BLOCK = renderPersona({ name: 'Sui', expanded: SUI_TEXT });
  const MEMORY = '# Memory\n\n- [2026-10-05] ouen and i picked the spot by the river for the cabin. they wanted a big window facing the water\n- [2026-10-07] ouen beat me at chess twice and was very smug about it\n';
  const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

  const ajv = new Ajv({ strict: false, allErrors: true });
  const validatorCache = new Map<any, any>();
  const validate = (tools: any[], tu: Block): boolean => {
    const def = tools.find((t) => t.name === tu.name);
    if (!def) return false;
    if (!def.input_schema) return true; // server tool
    let v = validatorCache.get(def);
    if (!v) {
      v = ajv.compile(def.input_schema);
      validatorCache.set(def, v);
    }
    return !!v(tu.input);
  };

  // ── streaming call (TTFT = first visible text or tool-arg delta) ──────────
  const apiErrors: Array<{ arm: string; scene: string; status?: number; message: string }> = [];
  async function streamCall(arm: string, body: Record<string, unknown>, maxTokens: number): Promise<CallResult> {
    const a = ARMS[arm];
    for (let attempt = 0; ; attempt++) {
      const t0 = Date.now();
      let ttft: number | null = null;
      let sayMs: number | null = null;
      let curName: string | null = null;
      try {
        const stream = client.messages.stream({ model: a.model, max_tokens: maxTokens, ...body, ...a.extra } as never);
        for await (const ev of stream as AsyncIterable<any>) {
          if (ev.type === 'content_block_start') curName = ev.content_block?.type === 'tool_use' ? ev.content_block.name ?? null : null;
          if (ttft === null && ev.type === 'content_block_delta' && (ev.delta?.type === 'text_delta' || ev.delta?.type === 'input_json_delta')) ttft = Date.now() - t0;
          if (sayMs === null && ev.type === 'content_block_stop' && curName === 'say') sayMs = Date.now() - t0;
        }
        const msg = await (stream as any).finalMessage();
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
  function costOf(model: string, u: Usage) {
    const p = PRICES[model];
    return (
      (u.input_tokens * p.in + (u.cache_creation_input_tokens ?? 0) * p.cw + (u.cache_read_input_tokens ?? 0) * p.cr + u.output_tokens * p.out) / 1e6 +
      (u.server_tool_use?.web_search_requests ?? 0) * WEB_SEARCH_USD
    );
  }
  /** Same turn with the whole stable prefix already warm (what a live session pays). */
  function warmCostOf(model: string, u: Usage) {
    const p = PRICES[model];
    const cached = (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    return (u.input_tokens * p.in + cached * p.cr + u.output_tokens * p.out) / 1e6 + (u.server_tool_use?.web_search_requests ?? 0) * WEB_SEARCH_USD;
  }

  const textOf = (content: Block[]) => content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n').trim();
  const toolUsesOf = (content: Block[]) => content.filter((b) => b.type === 'tool_use');
  const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
  const hasDash = (s: string) => /[—–]/.test(s);
  /** Stage-direction / reasoning leaked into a spoken line ("nothing to say, so silence"). */
  const META_SPOKEN = /\b(so silence|stay(ing)? (quiet|silent)|that'?s filler|no comment( yet)?|nothing (specific |much )?to say|no comment needed|i('| a)m (reading|analy[sz]ing)|let me think)\b/i;

  // ════════════════════════════════════════════════════════════════════════
  // GAME BRAIN (minecraft / stardew / dontstarve)
  // ════════════════════════════════════════════════════════════════════════
  type BrainSurface = { blocks: string[]; tools: any[]; adapter: any; playerName: string; username: string };

  /** anthropicClient.buildCachedSystem: static blocks + "Available actions" prose, marker on the last. */
  function cachedSystem(blocks: string[], tools: any[]) {
    const described = tools.filter((t) => t.description);
    const toolBlock = described.length ? 'Available actions:\n' + described.map((t) => `- ${t.name}: ${t.description}`).join('\n') : 'No actions available.';
    return [...blocks.map((text) => ({ type: 'text', text })), { type: 'text', text: toolBlock, cache_control: { type: 'ephemeral' } }];
  }
  const stampLastTool = (tools: any[]) => tools.map((t, i) => (i === tools.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t));

  function capture(adapter: any, config: any) {
    let captured: { blocks: string[]; tools: any[] } | null = null;
    const provider = {
      buildCachedSystem: (blocks: string[], tools: any[]) => {
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
    createOrchestrator({ adapter, config, reenqueue: () => {}, _anthropicOverride: provider, logger: noopLog });
    if (!captured) throw new Error('capture failed');
    return captured as { blocks: string[]; tools: any[] };
  }
  const botConfig = (kind: string, sub: any, playerUsername: string) =>
    ConfigSchema.parse({
      chat_mode: 'chat',
      realistic_typing: true,
      player_username: playerUsername,
      persona: { name: 'Sui', expanded: SUI_TEXT, proactiveness: 2 },
      anthropic: { api_key: 'sk-test' },
      adapter: { kind, [kind]: sub },
      memory: { player_md_path: '/tmp/p.md', memory_md_path: '/tmp/m.md', heartbeat_md_path: '/tmp/h.md', worlds_json_path: '/tmp/w.json' },
      vision: {},
    });

  // Minecraft: pinned fixture (kept current by the systemBlocks tests).
  const mcFixture = JSON.parse(readFileSync(join(root, 'src/bot/brain/__fixtures__/minecraftSystemBlocks.json'), 'utf8'));
  const MC: BrainSurface = {
    blocks: mcFixture.base.blocks.map((b: string, i: number) => (i === 1 ? PERSONA_BLOCK : b)),
    tools: mcFixture.base.tools,
    adapter: { cuboidGrammar: () => mcPrompts.CUBOID_GRAMMAR, eventAddendum: (e: string, d: any) => mcPrompts.eventAddendum(e, d) },
    playerName: 'Ouen',
    username: 'SSk1tz',
  };

  // Stardew: real adapter over a stub client speaking mod 0.1.3.
  const sdConfig = botConfig('stardew', sdRuntime.adapterConfigFrom({ joinTarget: { port: 1, token: 'x' }, botUsername: 'Sui' }), 'Ouen');
  const sdClient = { welcome: { hello: { version: '0.1.3', save: { farmName: 'Sunny', playerName: 'Ouen' } } }, on() {}, off() {}, request: async () => ({ ok: true }) };
  const sdAdapter = createStardewAdapter({ client: sdClient, config: sdConfig, botUsername: 'Sui', logger: noopLog });
  const sdCap = capture(sdAdapter, sdConfig);
  const SD: BrainSurface = { blocks: sdCap.blocks.map((b, i) => (i === 1 ? PERSONA_BLOCK : b)), tools: sdCap.tools, adapter: sdAdapter, playerName: 'Ouen', username: 'Ouen' };
  const sdObsBase = JSON.parse(readFileSync(join(root, 'src/bot/adapter/stardew/fixtures/obs-farm.json'), 'utf8'));

  // DST: real adapter over a stub link (helper 0.3.0+, caps on).
  const dstConfig = botConfig(
    'dontstarve',
    dstRuntime.adapterConfigFrom({ joinTarget: { session: 'S1', label: 'Fake World', defaultPrefab: 'wilson', day: 3, season: 'autumn' }, botUsername: 'Sui', character: { name: 'Sui' } }),
    'Ouen',
  );
  const dstLink: any = { state: createObservationState(), handles: createHandleRegistry(), events: new EventEmitter(), hasCaps: true, body: { fight: true, followLabel: 'Ouen' }, guid: 9001, botName: 'Sui', setPaused() {}, say() {} };
  const dstAdapter = createDontStarveAdapter({ link: dstLink, config: dstConfig });
  const dstCap = capture(dstAdapter, dstConfig);
  const DST: BrainSurface = { blocks: dstCap.blocks.map((b, i) => (i === 1 ? PERSONA_BLOCK : b)), tools: dstCap.tools, adapter: dstAdapter, playerName: 'Ouen', username: 'Ouen' };

  /** orchestrator.runIterations' P1 chat framing (typed line, solo or teammate). */
  function chatEvent(surf: BrainSurface, text: string, teammate?: string) {
    const data = teammate ? { username: teammate, text, playerSpoke: false } : { username: surf.username, text };
    const add = (typeof surf.adapter.eventAddendum === 'function' ? surf.adapter.eventAddendum('player_chat', data) : '') + NUDGES.playerInterruptHint;
    const opener = teammate ? `your teammate ${teammate} just spoke to you` : 'the player just spoke to you';
    const playerMessageText =
      `${opener}. respond to THIS, not to the scene around you:\n"${text}"\n` +
      'Reply with the say() tool — a direct message never gets silence, even if your answer is a refusal or a single word. ' +
      'Your text output is a private scratchpad the player can NEVER see — a reply that exists only in your text is silence to them; only say() reaches them.';
    return { eventText: `Event: player_chat${add}`, playerMessageText };
  }
  /** Safety events take the adapter's one-line framing alone (isSafetyEvent). */
  const attackedEvent = (surf: BrainSurface, data: any) => ({ eventText: String(surf.adapter.eventAddendum('sei:attacked', data)).trim(), playerMessageText: null as string | null });
  const idleEvent = (surf: BrainSurface, data: any) => ({
    eventText: `Event: idle\nData: ${JSON.stringify(data)}${surf.adapter.eventAddendum('sei:idle', data)}`,
    playerMessageText: null as string | null,
  });

  type BrainScene = {
    surface: 'minecraft' | 'stardew' | 'dontstarve';
    note: string;
    snapshot: string;
    event: { eventText: string; playerMessageText: string | null };
    heartbeat?: string;
    companions?: string[];
    mustSay?: boolean;
    anyOf?: string[];
    noneOf?: string[];
    /** Extra rule over the spoken lines (returns an issue or null). */
    check?: (spoken: string[], tools: Block[]) => string | null;
  };

  async function runBrain(arm: string, surf: BrainSurface, s: BrainScene): Promise<SceneOut> {
    const dir = await mkdtemp(join(tmpdir(), 'sei-gamesim-'));
    try {
      const memPath = join(dir, 'MEMORY.md');
      const hbPath = join(dir, 'HEARTBEAT.md');
      await writeFile(memPath, MEMORY);
      await writeFile(hbPath, s.heartbeat ?? '');
      const seed = await composeSeedBlocks({
        sessionState: { playerData: () => ({ username: surf.username, preferred_name: surf.playerName }) },
        playerStore: { formatPlayerSeedBlock: () => `# Player\nplayer_username: ${surf.username}\npreferred_name: ${surf.playerName}\ntotal_sessions: 23\n` },
        config: {
          player_username: surf.playerName,
          persona: { proactiveness: 2 },
          memory: { memory_md_path: memPath, heartbeat_md_path: hbPath, seed_memory_budget_bytes: 8192, seed_heartbeat_budget_bytes: 2048 },
        },
        eventText: s.event.eventText,
        snapshotText: s.snapshot,
        playerMessageText: s.event.playerMessageText ?? null,
        companions: s.companions ?? [],
        adapter: surf.adapter,
        logger: noopLog,
      });
      const content = seed.map((b: any) => ({ type: 'text', text: b.text, ...(b.cache_control ? { cache_control: b.cache_control } : {}) }));
      const res = await streamCall(arm, { system: cachedSystem(surf.blocks, surf.tools), tools: stampLastTool(surf.tools), messages: [{ role: 'user', content }] }, 1024);
      const tools = toolUsesOf(res.content);
      // search(line) is spoken too: the brain says the line while it looks.
      const says = tools
        .filter((t) => t.name === 'say' || (t.name === 'search' && t.input?.line))
        .map((t) => String(t.name === 'say' ? t.input?.text ?? '' : t.input.line));
      const names = tools.map((t) => t.name!);
      const rawText = textOf(res.content);
      const issues: string[] = [];
      const invalid = tools.filter((t) => !validate(surf.tools, t)).map((t) => t.name!);
      if (invalid.length) issues.push(`invalid-args:${invalid.join('+')}`);
      if (res.stop === 'max_tokens') issues.push('max_tokens');
      if (s.mustSay && !says.length) issues.push(rawText ? 'LEAK(text-no-say)' : 'silent');
      if (tools.filter((t) => t.name === 'say').length > 1) issues.push(`say×${says.length}`);
      if (s.anyOf && !names.some((n) => s.anyOf!.includes(n))) issues.push(`missing:${s.anyOf.join('|')}`);
      if (s.noneOf) for (const n of names) if (s.noneOf.includes(n)) issues.push(`bad:${n}`);
      for (const line of says) {
        if (words(line) > 45) issues.push('long-say');
        if (hasDash(line)) issues.push('em-dash');
      }
      const extra = s.check?.(says, tools);
      if (extra) issues.push(extra);
      return { calls: [res], spoken: says, tools, rawText, dropped: [], issues, facts: {} };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // ── Minecraft scenes ──────────────────────────────────────────────────────
  const SNAP_LOWHP_FIGHT = `snapshot: pos: -3,88,22
biome: plains  surroundings: outside  time: night (17134)
hp: 4/20  food: 9/20  xp: lvl 0
holding: stone_sword
inventory (3/36 slots): dirt×4 stone_sword×1 bread×1
terrain at feet: 16 stone, 8 grass_block, 6 dirt
nearby blocks:
  #1 grass_block x369 @-3,88,21
nearby entities:
  #2 zombie @-4,88,23
  #3 zombie @-1,88,27
  #4 SSk1tz @7,86,35
follow_target: (none)
owner SSk1tz: @7,86,35 (17 blocks away)
recent_events: hp -3 (zombie), hp -4 (zombie)`;
  const SNAP_NOMAT = `snapshot: pos: 40,71,-8
biome: plains  surroundings: outside  time: day (2400)
hp: 20/20  food: 19/20  xp: lvl 1
holding: (empty)
inventory (2/36 slots): dirt×6 wheat_seeds×3
terrain at feet: 24 grass_block, 4 short_grass
nearby blocks:
  #1 oak_log x18 @46,72,-15
  #2 stone x80 @33,66,-2
nearby entities:
  #3 SSk1tz @42,71,-6
follow_target: (none)
owner SSk1tz: @42,71,-6 (3 blocks away)`;
  const SNAP_FOLLOW = `snapshot: pos: 12,70,-4
biome: plains  surroundings: outside  time: day (5200)
hp: 20/20  food: 18/20  xp: lvl 3
holding: stone_pickaxe
inventory (4/36 slots): oak_planks×10 oak_log×6 stone_pickaxe×1 cobblestone×31
terrain at feet: 20 grass_block, 6 dirt
nearby blocks:
  #1 oak_log x9 @18,71,2
nearby entities:
  #2 SSk1tz @20,70,6
follow_target: (none)
owner SSk1tz: @20,70,6 (13 blocks away)`;
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
  const SNAP_CABIN_TEAM = `snapshot: pos: 12,70,-4
biome: plains  surroundings: outside  time: day (9200)
hp: 20/20  food: 18/20  xp: lvl 3
holding: stone_axe
inventory (4/36 slots): oak_planks×4 stone_axe×1 cobblestone×12 torch×4
terrain at feet: 20 grass_block, 6 dirt
nearby blocks:
  #1 oak_planks x58 @10,70,-6
  #2 oak_log x22 @2,71,-14
nearby entities:
  #3 Lyra (companion) @9,70,-5
  #4 SSk1tz @14,70,-2
follow_target: (none)
owner SSk1tz: @14,70,-2 (3 blocks away)`;
  const SNAP_DUSK = `snapshot: pos: 12,70,-4
biome: plains  surroundings: outside  time: dusk (12400)
hp: 20/20  food: 17/20  xp: lvl 3
holding: stone_sword
inventory (5/36 slots): oak_planks×22 stone_sword×1 cobblestone×31 torch×4 bread×3
terrain at feet: 20 grass_block, 6 dirt
nearby blocks:
  #1 oak_planks x58 @10,70,-6
  #2 white_bed x1 @11,70,-7
nearby entities:
  #3 SSk1tz @14,70,-2
follow_target: (none)
owner SSk1tz: @14,70,-2 (3 blocks away)`;
  const CABIN_HB = '# Heartbeat\n\n- [2026-10-07T20:11:02.000Z] build a small oak cabin by the river with Ouen, walls and a roof, done when we can sleep in it\n';

  const SCENES: Record<string, { surface: string; note: string; run: (arm: string) => Promise<SceneOut> }> = {};
  const brainScene = (id: string, s: BrainScene) => {
    const surf = s.surface === 'minecraft' ? MC : s.surface === 'stardew' ? SD : DST;
    SCENES[id] = { surface: s.surface, note: s.note, run: (arm) => runBrain(arm, surf, s) };
  };

  brainScene('M_LOWHP', {
    surface: 'minecraft', note: '4/20 hp at night, zombie hits her: warn + disengage or fight', snapshot: SNAP_LOWHP_FIGHT,
    event: attackedEvent(MC, { attackerLabel: 'zombie', attackerKind: 'mob' }), mustSay: true,
    anyOf: ['explore', 'goTo', 'follow', 'attackEntity', 'consumeItem'],
  });
  brainScene('M_BUILD', {
    surface: 'minecraft', note: '"build us a little house" with only dirt: honest about materials, gather first', snapshot: SNAP_NOMAT,
    event: chatEvent(MC, 'can you build us a little house right here?'), mustSay: true,
    anyOf: ['gather', 'dig', 'setGoal', 'craft', 'build', 'shelter', 'find'],
    check: (says) => (says.some((l) => /\b(planks?|cobble(stone)?)\b/i.test(l) && /\b(got|have)\b/i.test(l) && !/\b(no|don'?t|dont|need|without|any)\b/i.test(l)) ? 'claims-materials?' : null),
  });
  brainScene('M_FOLLOW', { surface: 'minecraft', note: '"follow me": follow()', snapshot: SNAP_FOLLOW, event: chatEvent(MC, 'follow me'), mustSay: true, anyOf: ['follow'] });
  brainScene('M_IRON', {
    surface: 'minecraft', note: '"get us some iron", no pickaxe: multi-step start', snapshot: SNAP_WOODS, event: chatEvent(MC, 'can you go get us some iron?'), mustSay: true,
    anyOf: ['setGoal', 'gather', 'craft', 'dig', 'find', 'explore'],
  });
  brainScene('M_SIBLING', {
    surface: 'minecraft', note: 'teammate Lyra asks for wood: coordinate + gather', snapshot: SNAP_CABIN_TEAM, heartbeat: CABIN_HB, companions: ['Lyra'],
    event: chatEvent(MC, 'Sui can you grab like 20 logs for the roof? ill do the stairs', 'Lyra'), mustSay: true, anyOf: ['gather', 'setGoal', 'dig'],
  });
  brainScene('M_NIGHT', {
    surface: 'minecraft', note: '"is it safe at night" at dusk: honest in-voice answer', snapshot: SNAP_DUSK, heartbeat: CABIN_HB,
    event: chatEvent(MC, 'is it safe to stay out tonight or should we go in'), mustSay: true, noneOf: ['quit_game'],
  });
  brainScene('M_UNCLEAR', {
    surface: 'minecraft', note: '"do the thing": ask what they mean (no goal on file)', snapshot: SNAP_WOODS, event: chatEvent(MC, 'ok do the thing'), mustSay: true,
    // A clarifying question, or a reasonable read of the one project in memory (the cabin).
    check: (says, tools) =>
      says.some((l) => l.includes('?') || /^\s*(which|what)\b/i.test(l)) || /cabin|house|shelter|window|river/i.test(JSON.stringify(tools.map((t) => t.input))) ? null : 'no-clarifying-question',
  });
  brainScene('M_SEARCH', {
    surface: 'minecraft', note: 'news question: search() (lead line ok)', snapshot: SNAP_FOLLOW,
    event: chatEvent(MC, "what got added in the newest minecraft update? i havent played in like a year"), anyOf: ['search'],
  });

  // ── Stardew scenes ────────────────────────────────────────────────────────
  const sdSnap = (mut?: (o: any) => void, last: string | null = null) => {
    const o = JSON.parse(JSON.stringify(sdObsBase));
    mut?.(o);
    return composeStardewSnapshot(o, { pinUsername: 'Ouen', worldTag: '#1 Sunny Farm', lastActionResult: last, modVersion: '0.1.3' });
  };
  const SD_FARM = sdSnap();
  brainScene('S_WATER', { surface: 'stardew', note: '"water the crops": water()', snapshot: SD_FARM, event: chatEvent(SD, 'can you water the crops for me?'), mustSay: true, anyOf: ['water'] });
  brainScene('S_GIVE', { surface: 'stardew', note: '"can i have a leek": give()', snapshot: SD_FARM, event: chatEvent(SD, 'can i have one of those leeks you picked?'), mustSay: true, anyOf: ['give'] });
  brainScene('S_FISH', { surface: 'stardew', note: '"lets go fishing": fish() or goTo water', snapshot: SD_FARM, event: chatEvent(SD, "let's go fishing, the pond is right over there"), mustSay: true, anyOf: ['fish', 'goTo', 'follow', 'equip'] });
  brainScene('S_SEASON', {
    surface: 'stardew', note: 'season question on spring 3: correct day count, no invented facts', snapshot: SD_FARM,
    event: chatEvent(SD, 'how many days until summer? i want to plan what to plant'), mustSay: true,
    check: (says) => {
      const nums = says.join(' ').match(/\b\d+\b/g) ?? [];
      if (!nums.length) return null;
      return nums.some((n) => n === '25' || n === '26') ? null : `wrong-days(${nums.join(',')})`;
    },
  });
  brainScene('S_WALK', { surface: 'stardew', note: '"meet me at the bus stop": goTo the exit', snapshot: SD_FARM, event: chatEvent(SD, 'meet me at the bus stop'), mustSay: true, anyOf: ['goTo', 'follow', 'come'] });
  brainScene('S_IDLE', {
    surface: 'stardew', note: 'idle tick, 12 dry crops + ready cauliflower: does a chore', snapshot: SD_FARM, event: idleEvent(SD, { quietMs: 45000 }),
    anyOf: ['water', 'harvest', 'ship', 'give', 'till', 'plant', 'chop', 'mine', 'gather'],
  });

  // ── DST scenes ────────────────────────────────────────────────────────────
  function dstSnap(mut: (f: any) => void, opts: { last?: string | null; phase?: string } = {}) {
    const st = createObservationState();
    const mod = createFakeMod({ botPort: 1, token: 'x' });
    const f = mod.frame(true);
    for (const e of f.ents) if (e.n === 'Steve') e.n = 'Ouen';
    mut(f);
    st.apply(f);
    if (opts.phase) st.world.phase = opts.phase;
    const c = createDstComposer({ state: st, handles: createHandleRegistry(), dst: { prefab: 'wilson' }, getBodyState: () => ({ fight: true, followLabel: 'Ouen' }), getSelfGuid: () => 9001, getHabits: () => [] });
    return c.next({ lastActionResult: opts.last ?? null, inFlight: null, pinUsername: 'Ouen', worldTag: '#1 Fake World' });
  }
  const DST_DARK = dstSnap((f) => {
    f.self.inlight = false;
    f.world.phase = 'night';
    f.ents = f.ents.filter((e: any) => e.p !== 'campfire');
  });
  const DST_DAY_NOLAB = dstSnap((f) => {
    f.ents = f.ents.filter((e: any) => e.p !== 'researchlab');
  });
  const DST_DUSK = dstSnap((f) => {
    f.world.phase = 'dusk';
    f.world.day = 6;
  });
  const DST_HOUND_HIT = dstSnap((f) => {
    f.world.phase = 'night';
    f.self.hp = 60;
    f.ents.push({ g: 1101, p: 'hound', x: 11.0, z: -19.0, f: ['hostile', 'monster', 'combat'], h: 0.9 });
    f.ents.push({ g: 1102, p: 'hound', x: 13.5, z: -22.0, f: ['hostile', 'monster', 'combat'], h: 1 });
  });
  brainScene('D_DARK', {
    surface: 'dontstarve', note: 'night, no light, no grass in bag: grass/twigs or go to player', snapshot: DST_DARK,
    event: attackedEvent(DST, { attackerKind: 'reflex', survivalKind: 'dark', phase: 'night' }), mustSay: true,
    anyOf: ['pick', 'gather', 'goTo', 'come', 'follow'], noneOf: ['lightFire'],
  });
  brainScene('D_SCIENCE', {
    surface: 'dontstarve', note: '"get stuff for a science machine": gather logs/rocks/gold', snapshot: DST_DAY_NOLAB,
    event: chatEvent(DST, 'can you get what we need for a science machine?'), mustSay: true, anyOf: ['mine', 'gather', 'chop', 'setGoal', 'pick', 'pickup', 'build'],
    check: (says, tools) => {
      const t = says.join(' ').toLowerCase();
      const wrong = /\b(flint|grass|twigs?|cut ?stone|boards?|silk)\b/.test(t) && !/\b(gold|rocks?|stone)\b/.test(t);
      const b = tools.find((x) => x.name === 'build');
      return wrong ? 'wrong-recipe?' : b && !/science|researchlab/i.test(JSON.stringify(b.input)) ? 'build-wrong-thing' : null;
    },
  });
  brainScene('D_HOUNDS', {
    surface: 'dontstarve', note: 'player hears growling: knows it is hounds, prepares', snapshot: DST_DUSK,
    event: chatEvent(DST, 'uh oh do you hear that growling??'), mustSay: true, noneOf: ['sleep'],
    check: (says) => (/hound/i.test(says.join(' ')) ? null : 'no-hound-mention'),
  });
  brainScene('D_HIT', {
    surface: 'dontstarve', note: 'hound bites at 40% hp at night: warn + flee/goTo player', snapshot: DST_HOUND_HIT,
    event: attackedEvent(DST, { attackerLabel: 'hound', attackerKind: 'mob', healthPct: 0.4 }), mustSay: true,
    anyOf: ['flee', 'goTo', 'come', 'follow', 'attack', 'eat'],
  });
  SCENES.D_PICK = {
    surface: 'dontstarve',
    note: 'survivor pick (forced tool_choice pick_survivor)',
    run: async (arm) => {
      const tools = [survivorPick.PICK_TOOL];
      const res = await streamCall(
        arm,
        {
          system: survivorPick.PICK_SYSTEM,
          tools,
          tool_choice: { type: 'tool', name: 'pick_survivor' },
          messages: [{ role: 'user', content: `Character name: Sui\n\nPersona:\n${SUI_TEXT.slice(0, 4000)}\n\nRoster:\n${renderDstRosterBrief()}` }],
        },
        300,
      );
      const tu = toolUsesOf(res.content);
      const issues: string[] = [];
      if (tu.length !== 1) issues.push(`tool-calls:${tu.length}`);
      else if (!validate(tools, tu[0])) issues.push('invalid-args');
      const reason = String(tu[0]?.input?.reason ?? '');
      if (!reason) issues.push('no-reason');
      if (words(reason) > 40) issues.push('long-reason');
      return { calls: [res], spoken: reason ? [reason] : [], tools: tu, rawText: textOf(res.content), dropped: [], issues, facts: { prefab: tu[0]?.input?.prefab } };
    },
  };

  // ════════════════════════════════════════════════════════════════════════
  // CHAT-FAMILY SURFACES (chess / draw / backseat)
  // ════════════════════════════════════════════════════════════════════════
  const PINNED_CLOCK = clockNow();
  const gameSystem = (extraStable: string, proactiveness = 1, surface: 'game' | 'chat' = 'game') =>
    buildSystemBlocks({
      persona: SUI, name: 'Sui', preferredName: 'Ouen', proactiveness, surface, punctuation: 'casual', memory: MEMORY, summary: '', knowledge: '',
      openWorldDetected: false, inGame: false, voiceCall: false, language: 'en', extraStable, pinnedClock: PINNED_CLOCK,
    });

  // ── chess ─────────────────────────────────────────────────────────────────
  let enginePromise: Promise<any> | null = null;
  const engine = () => (enginePromise ??= import('cce-1').then(({ CharacterChessEngine }: any) => CharacterChessEngine.create({ maiaModelPath: MAIA_MODEL })));
  const PIECES = ['pawn', 'knight', 'bishop', 'rook', 'queen', 'king'];

  type ChessScene = { note: string; sans: string[]; kind: 'move' | 'chat-reply' | 'idle' | 'game-over'; playerSays?: string; result?: { winner: 'w' | 'b' | null; reason: string }; quietSec?: number };
  async function chessSession(sc: ChessScene) {
    const s: any = {
      chess: new Chess(), playerColor: 'w', history: [], profile: { elo: 1200, styleNote: 'Plays fast and greedy, grabs anything that is hanging, gets rattled when behind.' },
      hold: null, drawOffer: null, drawDeclinedNote: false, result: sc.result ?? null, candidateCache: null, consideredSans: [], lastMacro: '', gameLog: [], clock: PINNED_CLOCK,
    };
    const t0 = Date.parse('2026-10-08T19:00:00Z');
    sc.sans.forEach((san, i) => {
      s.chess.move(san);
      s.history.push({ san, fen: s.chess.fen() });
      CP.recordPly(s, i % 2 === 1);
      s.gameLog[s.gameLog.length - 1].ts = t0 + i * 20_000;
    });
    if (!s.chess.isGameOver()) {
      const out = await (await engine()).candidateSet(s.chess.fen(), { elo: s.profile.elo });
      s.lastMacro = out.macro.text;
      if (sc.kind === 'move') s.candidateCache = { fen: s.chess.fen(), out };
    }
    const history: any[] = [
      { id: 'c1', role: 'user', text: 'rematch. i am going to crush you again', ts: t0 - 60_000 },
      { id: 'c2', role: 'companion', text: 'you got lucky twice, that is all', ts: t0 - 55_000 },
    ];
    if (sc.playerSays) history.push({ id: 'c3', role: 'user', text: sc.playerSays, ts: t0 + sc.sans.length * 20_000 + 5_000 });
    return { s, history };
  }
  const chessScenes: Record<string, ChessScene> = {
    C_BLUNDER: { note: 'player hangs their queen; her move turn: play() a legal move, no coordinates, no invented moves', kind: 'move', sans: ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'g6', 'Qf3', 'Nf6', 'Qxf6'] },
    C_MID: { note: 'mid-game chat-reply "what is your plan": text only, no play(), no coordinates', kind: 'chat-reply', sans: ['d4', 'd5', 'c4', 'e6', 'Nc3', 'Nf6', 'Bg5', 'Be7', 'e3', 'O-O', 'Nf3', 'h6'], playerSays: "ok what's your plan here, you've gone quiet" },
    C_LOSTQ: { note: 'she just lost her queen; player gloats: reaction grounded in the real plies', kind: 'chat-reply', sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Qh4', 'Nxh4'], playerSays: 'lol where did your queen go' },
    C_LOST: { note: 'she got scholar-mated: game-over line, 1-2 lines, no tools', kind: 'game-over', sans: ['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6', 'Qxf7#'], result: { winner: 'w', reason: 'checkmate' } },
    C_IDLE: { note: 'idle tick mid-game, 25s quiet: silence ok, max 2 lines, no tools', kind: 'idle', sans: ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6'], quietSec: 25 },
  };
  for (const [id, sc] of Object.entries(chessScenes)) {
    let prepared: Promise<{ s: any; history: any[] }> | null = null;
    SCENES[id] = {
      surface: 'chess',
      note: sc.note,
      run: async (arm) => {
        prepared ??= chessSession(sc);
        const base = await prepared;
        // Fresh copy per call (the turn builder mutates drawDeclinedNote only).
        const s = { ...base.s };
        const system = gameSystem(CP.chessContractBlock(s, 'Ouen'));
        const turnBlock = await CP.buildChessTurnBlock(s, sc.kind, 'Ouen', sc.quietSec ?? 10, false);
        const messages = toMessages(CP.buildGameThread(s, base.history));
        const endsOnUser = messages.length > 0 && messages[messages.length - 1].role === 'user';
        markLastMessageCached(endsOnUser ? messages.slice(0, -1) : messages);
        foldUserNote(messages, turnBlock);
        const res = await streamCall(arm, { system, tools: CP.CHESS_TOOLS, stop_sequences: TRANSCRIPT_STOP_SEQUENCES, messages }, 160);
        const issues: string[] = [];
        const dropped: string[] = [];
        const spoken: string[] = [];
        const maxParts = sc.kind === 'chat-reply' ? 3 : 2;
        const raw = textOf(res.content);
        for (const part of raw ? splitReply(raw, 'casual') : []) {
          if (!part) continue;
          if (isSilenceFiller(part)) { dropped.push(`silence:${part}`); continue; }
          if ((chess as any).hasChessCoordinates(part)) { dropped.push(`coords:${part}`); continue; }
          if (spoken.length >= maxParts) { dropped.push(`cap:${part}`); continue; }
          spoken.push(part);
        }
        const tu = toolUsesOf(res.content);
        const invalid = tu.filter((t) => !validate(CP.CHESS_TOOLS, t)).map((t) => t.name);
        if (invalid.length) issues.push(`invalid-args:${invalid.join('+')}`);
        if (dropped.some((d) => d.startsWith('coords:'))) issues.push('coords(dropped)');
        if (dropped.some((d) => d.startsWith('cap:'))) issues.push('over-line-cap');
        if (/^\s*(human|player|ouen)\s*:/im.test(raw)) issues.push('fake-transcript');
        const facts: Record<string, unknown> = {};
        if (sc.kind === 'move') {
          const play = tu.find((t) => t.name === 'play');
          if (!play) issues.push('no-play');
          else {
            const probe = new Chess(s.chess.fen());
            let legal = false;
            try { legal = !!probe.move(String(play.input?.move ?? '').trim()); } catch { legal = false; }
            if (!legal) issues.push(`illegal:${play.input?.move}`);
            facts.move = play.input?.move;
            facts.candidates = s.candidateCache?.out.candidates.map((c: any) => c.san);
          }
        } else {
          const bad = tu.filter((t) => t.name !== 'remember' && !(t.name === 'propose_draw' && s.drawOffer === 'player'));
          if (bad.length) issues.push(`bad-tool:${bad.map((t) => t.name).join('+')}`);
        }
        // Grounding: every piece she names must appear in what she was shown
        // (turn block + game log), else it is a candidate hallucination.
        const shown = (turnBlock + '\n' + s.gameLog.map((g: any) => g.text).join('\n')).toLowerCase();
        const named = PIECES.filter((p) => new RegExp(`\\b${p}s?\\b(?!\\s*side)`, 'i').test(spoken.join(' ')));
        const unshown = named.filter((p) => p !== 'king' && !shown.includes(p));
        if (unshown.length) issues.push(`unshown-piece:${unshown.join('+')}`);
        if (sc.kind === 'game-over' && !spoken.length) issues.push('silent-game-over');
        if (sc.kind === 'chat-reply' && !spoken.length) issues.push('no-reply');
        if (spoken.some((l) => words(l) > 35)) issues.push('long-line');
        if (/^(ok|okay|alright|well)\b/i.test(spoken[0] ?? '')) issues.push('filler-opener');
        if (META_SPOKEN.test(spoken.join(' '))) issues.push('meta-spoken');
        return { calls: [res], spoken, tools: tu, rawText: raw, dropped, issues, facts };
      },
    };
  }

  // ── Draw! ─────────────────────────────────────────────────────────────────
  type Stroke = { points: Array<{ x: number; y: number }>; closed?: boolean; smooth?: boolean };
  async function renderCanvas(strokes: Stroke[], file?: string): Promise<string> {
    const paths = strokes
      .map((st) => {
        const pts = st.points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
        return st.closed ? `<polygon points="${pts}" fill="none" stroke="#111" stroke-width="5" stroke-linejoin="round"/>` : `<polyline points="${pts}" fill="none" stroke="#111" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>`;
      })
      .join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS_W}" height="${CANVAS_H}"><rect width="100%" height="100%" fill="#fff"/>${paths}</svg>`;
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    if (file) writeFileSync(join(ART_DIR, file), png);
    return png.toString('base64');
  }
  const circle = (cx: number, cy: number, r: number, n = 24, ry = r) => Array.from({ length: n }, (_, i) => ({ x: cx + r * Math.cos((2 * Math.PI * i) / n), y: cy + ry * Math.sin((2 * Math.PI * i) / n) }));
  const HOUSE: Stroke[] = [
    { points: [{ x: 350, y: 330 }, { x: 650, y: 330 }, { x: 650, y: 580 }, { x: 350, y: 580 }], closed: true },
    { points: [{ x: 320, y: 335 }, { x: 500, y: 180 }, { x: 680, y: 335 }] },
    { points: [{ x: 470, y: 580 }, { x: 470, y: 470 }, { x: 540, y: 470 }, { x: 540, y: 580 }] },
    { points: [{ x: 390, y: 380 }, { x: 450, y: 380 }, { x: 450, y: 430 }, { x: 390, y: 430 }], closed: true },
    { points: [{ x: 580, y: 260 }, { x: 580, y: 200 }, { x: 620, y: 200 }, { x: 620, y: 295 }] },
  ];
  const FISH: Stroke[] = [
    { points: circle(470, 350, 170, 32, 90), closed: true },
    { points: [{ x: 640, y: 350 }, { x: 760, y: 260 }, { x: 760, y: 440 }], closed: true },
    { points: circle(380, 325, 14, 12) , closed: true },
    { points: [{ x: 430, y: 262 }, { x: 490, y: 200 }, { x: 540, y: 265 }] },
    { points: [{ x: 320, y: 370 }, { x: 345, y: 380 }] },
  ];
  const SUN_PARTIAL: Stroke[] = [
    { points: circle(500, 350, 90, 28), closed: true },
    { points: [{ x: 500, y: 230 }, { x: 500, y: 170 }] },
    { points: [{ x: 620, y: 350 }, { x: 680, y: 350 }] },
    { points: [{ x: 585, y: 265 }, { x: 625, y: 225 }] },
  ];
  type GuessScene = { note: string; strokes: Stroke[]; file: string; answers: RegExp; said?: string[] };
  const guessScenes: Record<string, GuessScene> = {
    DR_HOUSE: { note: 'guess a finished house sketch', strokes: HOUSE, file: 'draw-house.png', answers: /\b(house|home|cabin|hut|cottage)\b/i },
    DR_FISH: { note: 'guess a fish sketch', strokes: FISH, file: 'draw-fish.png', answers: /\bfish\b/i },
    DR_SUN: { note: 'partial sun (circle + 3 rays), player chimes in', strokes: SUN_PARTIAL, file: 'draw-sun.png', answers: /\b(sun|star|sunflower|flower|clock|sunshine)\b/i, said: ["it's an easy one"] },
  };
  const drawContract = drawPrompts.drawContractBlock({ playerName: 'Ouen', rounds: 3, turnSeconds: 180 });
  for (const [id, g] of Object.entries(guessScenes)) {
    let img: Promise<string> | null = null;
    SCENES[id] = {
      surface: 'draw',
      note: g.note,
      run: async (arm) => {
        img ??= renderCanvas(g.strokes, g.file);
        const block = drawPrompts.buildGuessTurnBlock({
          round: 1, rounds: 3, aiName: 'Sui', playerName: 'Ouen', turnChat: [], priorChat: [], secondsLeft: 140, said: g.said ?? [], unchanged: false, strokeCount: g.strokes.length, gallery: [],
        });
        const res = await streamCall(
          arm,
          { system: gameSystem(drawContract), tools: [REMEMBER_TOOL], messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: await img } }, { type: 'text', text: block }] }] },
          200,
        );
        const raw = textOf(res.content).replace(/\n/g, ' ');
        const spoken = splitReply(raw, 'casual').slice(0, 2).map(plainLine).filter(Boolean).filter((l: string) => !/^\s*(\[\s*game\s*\])/i.test(l));
        const issues: string[] = [];
        const tu = toolUsesOf(res.content);
        if (tu.some((t) => t.name !== 'remember')) issues.push('bad-tool');
        if (!spoken.length) issues.push('silent');
        if (/\*\*|`/.test(raw)) issues.push('formatting');
        if (META_SPOKEN.test(spoken.join(' '))) issues.push('meta-spoken');
        if (/\bOuen\b/.test(raw) || /\b(they|them|their)\b/i.test(raw)) issues.push('third-person?');
        if (spoken.some((l: string) => words(l) > 30)) issues.push('long-line');
        const correct = g.answers.test(spoken.join(' '));
        if (!correct) issues.push('wrong-guess');
        return { calls: [res], spoken, tools: tu, rawText: raw, dropped: [], issues, facts: { correct } };
      },
    };
  }
  SCENES.DR_DRAW = {
    surface: 'draw',
    note: 'her turn to draw CAT: pen strokes on-canvas, never says the word (≤5 hops)',
    run: async (arm) => {
      const word = 'cat';
      const tools = [drawPrompts.PEN_TOOL, drawPrompts.CLEAR_TOOL, REMEMBER_TOOL];
      const system = gameSystem(drawContract);
      const thread: any[] = [
        { role: 'user', content: [{ type: 'text', text: drawPrompts.buildDrawTurnBlock({ round: 1, rounds: 3, word, aiName: 'Sui', playerName: 'Ouen', turnChat: [], priorChat: [], secondsLeft: 180, strokesUsed: 0, gallery: [] }) }] },
      ];
      const calls: CallResult[] = [];
      const allTools: Block[] = [];
      const strokes: Stroke[] = [];
      const spoken: string[] = [];
      const dropped: string[] = [];
      const issues: string[] = [];
      let rawAll = '';
      for (let hop = 0; hop < 5 && strokes.length < drawPrompts.MAX_AI_STROKES; hop++) {
        // drawService.markThreadCached: one marker on the newest block.
        for (const m of thread) for (const b of m.content) delete b.cache_control;
        const tail = thread[thread.length - 1].content;
        tail[tail.length - 1].cache_control = { type: 'ephemeral' };
        const res = await streamCall(arm, { system, tools, messages: thread }, 4000);
        calls.push(res);
        const tu = toolUsesOf(res.content);
        allTools.push(...tu);
        const raw = textOf(res.content);
        rawAll += (rawAll ? '\n' : '') + raw;
        for (const r of raw ? splitReply(raw, 'casual').slice(0, 2) : []) {
          const part = plainLine(r);
          if (!part) continue;
          if (new RegExp(`\\b${word}s?\\b`, 'i').test(part)) { dropped.push(`word:${part}`); continue; }
          spoken.push(part);
        }
        for (const t of tu) {
          if (!validate(tools, t)) issues.push(`invalid-args:${t.name}`);
          if (t.name === 'pen' && Array.isArray(t.input?.points)) {
            const pts = t.input.points.filter((p: any) => Number.isFinite(p?.x) && Number.isFinite(p?.y));
            if (pts.some((p: any) => p.x < 0 || p.y < 0 || p.x > CANVAS_W || p.y > CANVAS_H)) issues.push('off-canvas');
            strokes.push({ points: pts, closed: !!t.input.closed });
          }
          if (t.name === 'clear') issues.push('cleared');
        }
        if (!tu.length || res.stop !== 'tool_use') break;
        thread.push({ role: 'assistant', content: res.content.map((b) => ({ ...b })) });
        const content: any[] = tu.map((t) => ({ type: 'tool_result', tool_use_id: t.id, content: 'drawn' }));
        content.push({
          type: 'text',
          text: [
            `${strokes.length}/${drawPrompts.MAX_AI_STROKES} strokes used. ${drawPrompts.turnClockLine(170 - hop * 8)} Keep drawing if the picture is not recognisable yet, otherwise stop calling pen.`,
            'Anything you type is a chat line Ouen reads the moment you send it. Speak straight TO them: "you", never their name, never "they". You have no private notes here.',
          ].join('\n\n'),
        });
        thread.push({ role: 'user', content });
      }
      const file = `draw-cat-${arm}-${Date.now() % 100000}.png`;
      await renderCanvas(strokes, file);
      if (strokes.length < 3) issues.push(`few-strokes:${strokes.length}`);
      if (dropped.length) issues.push('said-word(dropped)');
      if (/\*\*|`/.test(rawAll)) issues.push('formatting');
      return { calls, spoken, tools: allTools, rawText: rawAll, dropped, issues, facts: { strokes: strokes.length, hops: calls.length, png: file } };
    },
  };

  // ── Backseat ──────────────────────────────────────────────────────────────
  /** Compose a grid exactly like the renderer: gridLayout(n), CELL_W x CELL_H cells, JPEG. */
  async function grid(frames: Buffer[], file: string, scale = 1): Promise<string> {
    const { cols, w, h } = gridLayout(frames.length);
    const cells = await Promise.all(frames.map((f) => sharp(f).resize(CELL_W, CELL_H, { fit: 'cover' }).toBuffer()));
    let img = sharp({ create: { width: w, height: h, channels: 3, background: '#000' } }).composite(
      cells.map((input, i) => ({ input, left: (i % cols) * CELL_W, top: Math.floor(i / cols) * CELL_H })),
    );
    let buf = await img.jpeg({ quality: 80 }).toBuffer();
    if (scale !== 1) buf = await sharp(buf).resize(Math.round(w * scale), Math.round(h * scale)).jpeg({ quality: 80 }).toBuffer();
    writeFileSync(join(ART_DIR, file), buf);
    return buf.toString('base64');
  }
  const robloxSrc = readFileSync(join(root, 'src/renderer/public/img/game-roblox.jpg'));
  const obbyFrame = (dx: number, dy: number, zoom = 1) =>
    sharp(robloxSrc).extract({ left: Math.round(152 + dx), top: Math.round(12 + dy), width: Math.round(372 / zoom), height: Math.round(296 / zoom) }).resize(602, 336, { fit: 'cover' }).toBuffer();
  const mcSrc = readFileSync(join(root, 'docs/shot-minecraft.png'));
  const mcFrame = (dx: number, dy: number) => sharp(mcSrc).extract({ left: Math.round(40 + dx), top: Math.round(20 + dy), width: 1120, height: 690 }).toBuffer();
  const MENU_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1b2a4a"/><stop offset="1" stop-color="#3d6a8a"/></linearGradient></defs>
<rect width="1280" height="720" fill="url(#g)"/>
<path d="M0 560 L180 430 L330 520 L520 380 L720 540 L900 420 L1080 520 L1280 440 L1280 720 L0 720 Z" fill="#14213a"/>
<text x="640" y="170" font-family="DejaVu Sans, sans-serif" font-size="96" font-weight="bold" fill="#f3e6b0" text-anchor="middle">SKYBOUND</text>
<text x="640" y="215" font-family="DejaVu Sans, sans-serif" font-size="26" fill="#cfd8e3" text-anchor="middle">Chapter II: The Drowned Spires</text>
${['Continue', 'New Game', 'Load Game', 'Settings', 'Quit'].map((t, i) => `<rect x="520" y="${285 + i * 72}" width="240" height="54" rx="8" fill="${i === 0 ? '#f3e6b0' : '#00000055'}"/><text x="640" y="${321 + i * 72}" font-family="DejaVu Sans, sans-serif" font-size="28" fill="${i === 0 ? '#1b2a4a' : '#e8eef5'}" text-anchor="middle">${t}</text>`).join('')}
<text x="20" y="705" font-family="DejaVu Sans, sans-serif" font-size="18" fill="#9fb0c4">v1.4.2</text>
<text x="1260" y="705" font-family="DejaVu Sans, sans-serif" font-size="18" fill="#9fb0c4" text-anchor="end">Last save: Chapter II, The Flooded Library</text>
</svg>`;
  const menuFrame = () => sharp(Buffer.from(MENU_SVG)).png().toBuffer();

  const ROBLOX_DEF = backseatGame('roblox');
  if (!ROBLOX_DEF) throw new Error('roblox backseat def missing');
  const OBBY_INFO = {
    universeId: 1, name: 'Pastel Sky Obby', creator: 'CloudHop Studio', creatorType: 'Group', genre: 'Obby & Platformer', maxPlayers: 20, visits: 48_200_000,
    description: 'Hop across 120 pastel stages floating in the sky. Dodge the spinning bars and do not touch the lava pits!',
  };
  type BsScene = {
    note: string;
    game: boolean;
    kind: 'start' | 'user' | 'idle' | 'jolt';
    frames: () => Promise<Buffer[]>;
    prevFrames?: () => Promise<Buffer[]>;
    secondsSincePrevGrid?: number;
    frameAges: number[];
    shareLabel: string;
    text?: string;
    history?: Array<{ role: 'user' | 'companion'; text: string }>;
    secondsSinceLastLine: number | null;
    check?: (spoken: string[]) => string | null;
  };
  const bsScenes: Record<string, BsScene> = {
    B_OBBY: {
      note: 'Roblox tile, first look at an obby: in-voice reaction, short, no invented events', game: true, kind: 'start',
      frames: async () => [await obbyFrame(0, 0), await obbyFrame(6, 3), await obbyFrame(10, 5, 1.05)], frameAges: [1.5, 0.75, 0.1875], shareLabel: 'Roblox', secondsSinceLastLine: null,
    },
    B_OBBY_ASK: {
      note: 'Roblox tile, player asks how to get past the spinning bars: real answer (search allowed)', game: true, kind: 'user', text: 'how do i get past the spinning bar things',
      frames: async () => [await obbyFrame(0, 0), await obbyFrame(8, 4, 1.08)], frameAges: [0.75, 0.1875], shareLabel: 'Roblox', secondsSinceLastLine: 40,
      prevFrames: async () => [await obbyFrame(-4, 0)], secondsSincePrevGrid: 40,
      history: [{ role: 'companion', text: 'oh this one looks cute. are we doing all 120 stages tonight?' }, { role: 'user', text: 'maybe lol' }],
    },
    B_MC: {
      note: 'ordinary share, Minecraft nether bridge: grounded line (basalt, bridging), no invented mobs', game: false, kind: 'idle',
      frames: async () => [await mcFrame(0, 0), await mcFrame(12, 4), await mcFrame(20, 8)], frameAges: [3, 1.5, 0.1875], shareLabel: 'Minecraft 1.21.1', secondsSinceLastLine: 35,
      prevFrames: async () => [await mcFrame(-20, 0)], secondsSincePrevGrid: 35,
      history: [{ role: 'companion', text: 'you are not seriously bridging over that with dirt' }],
      check: (sp) => (/\b(ghast|piglin|blaze|creeper|zombie|skeleton|enderman|diamond|wither)\b/i.test(sp.join(' ')) ? 'invented-mob/item?' : null),
    },
    B_MENU: {
      note: 'static menu, unchanged since last look 20s ago, prior question unanswered: no invented change, no repeat', game: false, kind: 'idle',
      frames: async () => [await menuFrame()], frameAges: [0], shareLabel: 'Skybound', secondsSinceLastLine: 20,
      prevFrames: async () => [await menuFrame()], secondsSincePrevGrid: 20,
      history: [{ role: 'companion', text: 'ooh skybound. is chapter two the one with the flooded library?' }],
      check: (sp) => (/\b(you just|just (clicked|loaded|started|picked|opened))\b/i.test(sp.join(' ')) ? 'invented-change?' : null),
    },
  };
  for (const [id, b] of Object.entries(bsScenes)) {
    let grids: Promise<{ cur: string; prev: string | null }> | null = null;
    SCENES[id] = {
      surface: 'backseat',
      note: b.note,
      run: async (arm) => {
        grids ??= (async () => ({
          cur: await grid(await b.frames(), `bs-${id}.jpg`),
          prev: b.prevFrames ? await grid(await b.prevFrames(), `bs-${id}-prev.jpg`, PREV_GRID_SCALE) : null,
        }))();
        const { cur, prev } = await grids;
        const baseTools = [bsPrompts.SAVE_CLIP_TOOL, REMEMBER_TOOL];
        const tools: any[] = b.game ? [...baseTools, ...webToolsFor({ serverWebSearch: true })] : baseTools;
        const extraStable = b.game
          ? `${bsPrompts.BACKSEAT_CONTRACT}\n\n${bsPrompts.renderBackseatGameBlock(ROBLOX_DEF, OBBY_INFO as any, { canSearch: tools.some((t) => isWebTool(t.name) || t.name === 'web_search') })}`
          : bsPrompts.BACKSEAT_CONTRACT;
        const system = buildSystemBlocks({
          persona: SUI, name: 'Sui', preferredName: 'Ouen', proactiveness: 1, punctuation: 'casual', memory: MEMORY, summary: '', knowledge: '',
          openWorldDetected: false, inGame: false, voiceCall: true, language: 'en', extraStable,
        });
        const t0 = Date.now() - 120_000;
        const messages = toMessages((b.history ?? []).map((h, i) => ({ id: `h${i}`, role: h.role, text: h.text, ts: t0 + i * 10_000, voice: true })));
        if (messages.length) markMessageCached(messages, messages.length - 1);
        const note = bsPrompts.tickNote({
          kind: b.kind, secondsSinceLastLine: b.secondsSinceLastLine, sourceName: b.shareLabel, shareLabel: b.shareLabel, frameAges: b.frameAges,
          secondsSincePrevGrid: prev ? b.secondsSincePrevGrid : undefined,
        });
        const image = (data: string) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } });
        messages.push({ role: 'user', content: [...(prev ? [image(prev)] : []), image(cur), { type: 'text', text: b.kind === 'user' ? `${note}\n\n${b.text ?? ''}` : note }] });
        const res = await streamCall(arm, { system, tools, messages }, b.kind === 'user' ? 400 : 160);
        const raw = textOf(res.content);
        const spoken: string[] = [];
        const dropped: string[] = [];
        const tu = toolUsesOf(res.content);
        const remembered = tu.some((t) => t.name === 'remember');
        const stripped = bsPrompts.stripDashes(raw);
        for (const r of stripped && !isSilenceFiller(stripped) ? splitReply(stripped, 'casual') : []) {
          const t = stripThoughtTags(r);
          if (!t || isSilenceFiller(t)) continue;
          if (isNoteLeak(t, remembered)) { dropped.push(`note-leak:${t}`); continue; }
          spoken.push(t);
        }
        const issues: string[] = [];
        if (!spoken.length) issues.push('silent');
        if (dropped.length) issues.push('note-leak');
        const total = words(spoken.join(' '));
        if (b.kind !== 'user' && total > 30) issues.push(`long(${total}w)`);
        if (/\b(frames?|grid|screenshots?|images?)\b/i.test(spoken.join(' '))) issues.push('mentions-frames');
        if (META_SPOKEN.test(spoken.join(' '))) issues.push('meta-spoken');
        if (hasDash(raw)) issues.push('dash(stripped)');
        const invalid = tu.filter((t) => !validate(tools, t)).map((t) => t.name);
        if (invalid.length) issues.push(`invalid-args:${invalid.join('+')}`);
        if (res.stop === 'max_tokens') issues.push('max_tokens');
        const extra = b.check?.(spoken);
        if (extra) issues.push(extra);
        const searches = res.content.filter((x) => x.type === 'server_tool_use').length;
        return { calls: [res], spoken, tools: tu, rawText: raw, dropped, issues, facts: { words: total, webSearches: searches } };
      },
    };
  }

  // ════════════════════════════════════════════════════════════════════════
  // RUN
  // ════════════════════════════════════════════════════════════════════════
  const scenes = Object.entries(SCENES).filter(([id, s]) => (!ONLY_SURFACE || s.surface === ONLY_SURFACE) && (!ONLY_SCENE || id === ONLY_SCENE));
  console.log(`arms=${ARM_KEYS.join(',')} reps=${REPS} scenes=${scenes.length} out=${OUT}`);
  writeFileSync(OUT, '');
  type Stat = { n: number; pass: number; ttft: number[]; say: number[]; total: number[]; prompt: number[]; cw: number[]; cr: number[]; out: number[]; cost: number[]; warm: number[]; issues: Record<string, number>; errors: number };
  const newStat = (): Stat => ({ n: 0, pass: 0, ttft: [], say: [], total: [], prompt: [], cw: [], cr: [], out: [], cost: [], warm: [], issues: {}, errors: 0 });
  const stats: Record<string, Record<string, Stat>> = {};
  const scenePass: Record<string, Record<string, [number, number]>> = {};
  for (const [id, sc] of scenes) {
    console.log(`\n== [${sc.surface}] ${id}: ${sc.note}`);
    for (let r = 0; r < REPS; r++) {
      for (const arm of ARM_KEYS) {
        const st = ((stats[sc.surface] ??= {})[arm] ??= newStat());
        const sp = ((scenePass[id] ??= {})[arm] ??= [0, 0]);
        let out: SceneOut;
        try {
          out = await sc.run(arm);
        } catch (e) {
          const err = e as { status?: number; message?: string };
          const msg = String(err?.message ?? e).slice(0, 400);
          console.log(`  [${arm}] #${r + 1} API/RUN ERROR ${err?.status ?? ''} ${msg}`);
          apiErrors.push({ arm, scene: id, status: err?.status, message: msg });
          st.n++; st.errors++; sp[1]++;
          st.issues['error'] = (st.issues['error'] ?? 0) + 1;
          appendFileSync(OUT, JSON.stringify({ scene: id, surface: sc.surface, arm, rep: r, error: msg, status: err?.status }) + '\n');
          continue;
        }
        const model = ARMS[arm].model;
        const u = out.calls.reduce(
          (acc, c) => ({
            input_tokens: acc.input_tokens + c.usage.input_tokens,
            output_tokens: acc.output_tokens + c.usage.output_tokens,
            cache_creation_input_tokens: (acc.cache_creation_input_tokens ?? 0) + (c.usage.cache_creation_input_tokens ?? 0),
            cache_read_input_tokens: (acc.cache_read_input_tokens ?? 0) + (c.usage.cache_read_input_tokens ?? 0),
            server_tool_use: { web_search_requests: (acc.server_tool_use?.web_search_requests ?? 0) + (c.usage.server_tool_use?.web_search_requests ?? 0) },
          }),
          { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: { web_search_requests: 0 } } as Usage,
        );
        const first = out.calls[0];
        const totalMs = out.calls.reduce((a, c) => a + c.totalMs, 0);
        const cost = costOf(model, u);
        const warm = warmCostOf(model, u);
        st.n++; sp[1]++;
        if (!out.issues.length) { st.pass++; sp[0]++; }
        for (const i of out.issues) st.issues[i.split('(')[0].split(':')[0]] = (st.issues[i.split('(')[0].split(':')[0]] ?? 0) + 1;
        if (first.ttftMs != null) st.ttft.push(first.ttftMs);
        if (first.sayMs != null) st.say.push(first.sayMs);
        st.total.push(totalMs);
        st.prompt.push(u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0));
        st.cw.push(u.cache_creation_input_tokens ?? 0);
        st.cr.push(u.cache_read_input_tokens ?? 0);
        st.out.push(u.output_tokens);
        st.cost.push(cost);
        st.warm.push(warm);
        const thinking = out.calls.reduce((a, c) => a + c.content.filter((b) => b.type === 'thinking' || b.type === 'redacted_thinking').length, 0);
        console.log(
          `  [${arm}] #${r + 1} ${out.issues.length ? 'FAIL ' + out.issues.join(',') : 'ok'}  ttft=${first.ttftMs ?? '-'}ms total=${totalMs}ms ` +
            `in=${u.input_tokens}+cw${u.cache_creation_input_tokens}+cr${u.cache_read_input_tokens} out=${u.output_tokens}${thinking ? ` think=${thinking}` : ''} $${cost.toFixed(5)}`,
        );
        console.log(`      says: ${out.spoken.length ? out.spoken.map((x) => `“${x}”`).join(' ') : '(nothing)'}`);
        const others = out.tools.filter((t) => t.name !== 'say').map((t) => `${t.name}(${JSON.stringify(t.input)})`).join(' ');
        if (others) console.log(`      tools: ${others.slice(0, 300)}`);
        if (out.dropped.length) console.log(`      dropped: ${out.dropped.join(' | ').slice(0, 300)}`);
        if (sc.surface !== 'chess' && sc.surface !== 'draw' && sc.surface !== 'backseat' && out.rawText) console.log(`      scratch: ${JSON.stringify(out.rawText.slice(0, 200))}`);
        if (Object.keys(out.facts).length) console.log(`      facts: ${JSON.stringify(out.facts).slice(0, 300)}`);
        appendFileSync(
          OUT,
          JSON.stringify({
            scene: id, surface: sc.surface, arm, model, rep: r, issues: out.issues, spoken: out.spoken, tools: out.tools.map((t) => ({ name: t.name, input: t.input })),
            rawText: out.rawText, dropped: out.dropped, facts: out.facts, ttftMs: first.ttftMs, sayMs: first.sayMs, totalMs, hops: out.calls.length,
            stop: out.calls.map((c) => c.stop), usage: u, cost, warmCost: warm, thinkingBlocks: thinking,
          }) + '\n',
        );
      }
    }
  }

  const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);
  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
  console.log('\n== SUMMARY by surface');
  console.log('surface     arm     pass    ttft_med say_med total_med prompt_tok cache_w  cache_r  out_tok $/turn(run) $/turn(warm) issues');
  const summary: any[] = [];
  for (const [surface, byArm] of Object.entries(stats)) {
    for (const arm of ARM_KEYS) {
      const s = byArm[arm];
      if (!s) continue;
      const row = {
        surface, arm, pass: `${s.pass}/${s.n}`, ttftMed: med(s.ttft), sayMed: med(s.say), totalMed: med(s.total), prompt: Math.round(mean(s.prompt)), cw: Math.round(mean(s.cw)), cr: Math.round(mean(s.cr)),
        out: Math.round(mean(s.out)), cost: mean(s.cost), warm: mean(s.warm), issues: s.issues, errors: s.errors,
      };
      summary.push(row);
      console.log(
        `${surface.padEnd(11)} ${arm.padEnd(7)} ${row.pass.padEnd(7)} ${String(row.ttftMed).padEnd(8)} ${String(row.sayMed).padEnd(7)} ${String(row.totalMed).padEnd(9)} ${String(row.prompt).padEnd(10)} ${String(row.cw).padEnd(8)} ${String(row.cr).padEnd(8)} ${String(row.out).padEnd(7)} ${row.cost.toFixed(5).padEnd(11)} ${row.warm.toFixed(5).padEnd(12)} ${JSON.stringify(row.issues)}`,
      );
    }
  }
  console.log('\n== per-scene pass');
  for (const [id, byArm] of Object.entries(scenePass)) console.log(`${id.padEnd(12)} ${ARM_KEYS.map((a) => `${a}=${byArm[a]?.[0] ?? 0}/${byArm[a]?.[1] ?? 0}`).join('  ')}`);
  const spent = Object.values(stats).flatMap((byArm) => Object.entries(byArm).map(([, s]) => s.cost.reduce((x, y) => x + y, 0))).reduce((x, y) => x + y, 0);
  console.log(`\napi errors: ${apiErrors.length}`);
  for (const e of apiErrors) console.log(`  ${e.arm} ${e.scene} ${e.status ?? ''} ${e.message.slice(0, 200)}`);
  console.log(`total spend ≈ $${spent.toFixed(3)}`);
  appendFileSync(OUT, JSON.stringify({ summary, scenePass, apiErrors, spent }) + '\n');
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
