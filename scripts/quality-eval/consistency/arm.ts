/**
 * scripts/quality-eval/consistency/arm.ts: one arm of the consistency eval
 * (run.mjs starts one of these per arm, character and rep, under tsx).
 *
 *   tsx arm.ts --src <checkout> --phase build|probe --state <dir> --char sui
 *       [--out <file.jsonl>] [--history-n 20] [--surfaces text,voice,mc]
 *
 * Everything that decides what the companion knows is imported from `--src`,
 * the arm's own checkout: the fold prompt, the session-end call, the play row,
 * the transcript rendering, the chat system prompt, MEMORY.md writes, the
 * session digest and the whole game brain. The only code here is the
 * sequencing that lives in electron-bound files (continuity.ts foldIfDue,
 * index.ts closePlaySession, chatService prepareChatTurn), copied from dev
 * at 5663eb0d as the `dev*` functions below. A checkout that exports the pure
 * versions (src/main/chat/continuityCore.ts, runSessionEnd, buildPlayRow) is
 * driven through those instead, so a branch is measured on its real code.
 *
 * build: lives the character's scripted life (life.mjs) into --state:
 *   MEMORY.md seed (two weeks ago), a text chat (5 days ago), the Minecraft
 *   session from the game fixture (3 days ago) and its session end, a voice
 *   call (1 day ago) and its session end, then --history-n exchanges of
 *   today's chat. Folds run whenever the arm's fold is due.
 * probe: asks every probe on each surface against --state, one fresh turn
 *   per probe (a probe never sees another), and writes one JSON line per
 *   answer to --out.
 *
 * Key: ANTHROPIC_API_KEY (run.mjs passes it). Never printed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
// @ts-ignore plain .mjs
import { LIVES, PLAYER } from './life.mjs';
// @ts-ignore plain .mjs
import { createGameBrain } from './brain.mjs';
// @ts-ignore plain .mjs
import { loadCharacters } from '../persona/characters.mjs';

type Row = {
  id: string;
  role: 'user' | 'companion' | 'system';
  text: string;
  ts: number;
  voice?: boolean;
  event?: Record<string, unknown>;
};
type Bridge = { summary: string; summarizedCount: number };
type Usage = { model: string; input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; what: string };

const argv = process.argv.slice(2);
const opt = (n: string, d?: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const SRC = path.resolve(opt('src', process.cwd())!);
const PHASE = opt('phase', 'build')!;
const STATE = path.resolve(opt('state')!);
const OUT = opt('out');
const CHAR = opt('char', 'sui')!;
const HISTORY_N = Number(opt('history-n', '6'));
const SURFACES = opt('surfaces', 'text,voice,mc')!.split(',');
const PROBES = opt('probes');
const CHARS_DIR = opt('chars-dir', path.join(os.homedir(), 'suisei/eval/characters'))!;
const HERE = path.dirname(new URL(import.meta.url).pathname);
const FIXTURES = path.resolve(HERE, '../../fixtures/consistency');
const KEY = String(process.env.ANTHROPIC_API_KEY ?? '').trim();
const DAY = 86_400_000;
const usage: Usage[] = [];

const imp = (rel: string) => import(pathToFileURL(path.join(SRC, rel)).href);
async function tryImp(rel: string): Promise<any | null> {
  if (!fs.existsSync(path.join(SRC, rel))) return null;
  return imp(rel);
}

// ── the arm's modules ───────────────────────────────────────────────────
const [transcript, chatPrompts, foldPrompt, playSummary, playerEnd, memoryLog, digestMod, webTools, modelDefaults, llmCatalog] =
  await Promise.all([
    imp('src/main/chat/transcript.ts'),
    imp('src/main/chat/chatPrompts.ts'),
    imp('src/main/chat/foldPrompt.ts'),
    imp('src/main/chat/playSummary.ts'),
    imp('src/main/playerEndNextStep.ts'),
    imp('src/bot/brain/memory/memoryLog.js'),
    imp('src/bot/brain/sessionDigest.js'),
    imp('src/bot/web/webTools.js'),
    imp('src/bot/brain/llm/anthropicModelDefaults.js'),
    imp('src/shared/llmCatalog.ts'),
  ]);
const core = await tryImp('src/main/chat/continuityCore.ts');
const MODEL: string = llmCatalog.COMPANION_MODEL;

// ── provider: the main-process Anthropic provider's call (llm/anthropic.ts) ──
const client = new Anthropic({ apiKey: KEY, maxRetries: 6 });
function provider(what: string) {
  return {
    kind: 'anthropic',
    model: MODEL,
    vision: 'yes',
    streaming: false,
    backend: 'byok',
    async call(p: any) {
      const params: Record<string, unknown> = { model: p.model ?? MODEL, max_tokens: p.maxTokens, messages: p.messages };
      if (p.system !== undefined) params.system = p.system;
      if (p.tools !== undefined) params.tools = p.tools;
      if (p.toolChoice !== undefined) params.tool_choice = p.toolChoice;
      if (p.stopSequences !== undefined) params.stop_sequences = p.stopSequences;
      if (p.anthropicExtra) Object.assign(params, p.anthropicExtra);
      modelDefaults.applyAnthropicModelDefaults(params);
      const res: any = await client.messages.create(params as any, { timeout: 90_000 });
      usage.push({ model: String(params.model), what, ...(res.usage ?? {}) });
      const content = res.content ?? [];
      const toolUses = content.filter((b: any) => b.type === 'tool_use').map((b: any) => ({ id: b.id, name: b.name, input: b.input ?? {} }));
      const text = content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
      return { content, toolUses, text, usage: res.usage ?? {}, stopReason: res.stop_reason ?? null };
    },
  };
}

// ── state on disk ─────────────────────────────────────────────────────────
const memDir = path.join(STATE, 'memory');
const memFile = path.join(memDir, 'MEMORY.md');
const rowsFile = path.join(STATE, 'rows.json');
const bridgeFile = path.join(STATE, 'bridge.json');
const readRows = (): Row[] => (fs.existsSync(rowsFile) ? JSON.parse(fs.readFileSync(rowsFile, 'utf8')) : []);
const readBridge = (): Bridge => (fs.existsSync(bridgeFile) ? JSON.parse(fs.readFileSync(bridgeFile, 'utf8')) : { summary: '', summarizedCount: 0 });

const ch = loadCharacters(CHARS_DIR, [CHAR])[0];
const L = LIVES[CHAR];
const filler = JSON.parse(fs.readFileSync(path.join(FIXTURES, `filler-${CHAR}.json`), 'utf8'));
const game = JSON.parse(fs.readFileSync(path.join(FIXTURES, `game-${CHAR}.json`), 'utf8'));
const CHAR_ID = `eval-${CHAR}`;

// ── dev sequencing (copied from dev 5663eb0d) ─────────────────────────────
const isCounted = (m: Row) => m.role === 'user' || m.role === 'companion';

/** continuity.ts readWindow + readChatContext. */
function devChatContext(raw: Row[], b: Bridge) {
  const counted = raw.filter(isCounted);
  let bridge = b;
  if (bridge.summarizedCount >= counted.length && bridge.summarizedCount > 0) bridge = { summary: '', summarizedCount: 0 };
  const watermark = Math.max(bridge.summarizedCount, counted.length - 150);
  const history: Row[] = [];
  let seen = 0;
  for (const m of raw) {
    if (isCounted(m)) {
      seen++;
      if (seen > watermark) history.push(m);
    } else if (seen >= watermark) history.push(m);
  }
  return { summary: bridge.summary, history, base: watermark };
}

/** continuity.ts buildLaunchContinuity. */
function devLaunchContinuity(raw: Row[], b: Bridge) {
  const counted = raw.filter(isCounted);
  if (!counted.length) return null;
  let bridge = b;
  if (bridge.summarizedCount >= counted.length && bridge.summarizedCount > 0) bridge = { summary: '', summarizedCount: 0 };
  const watermark = Math.max(bridge.summarizedCount, counted.length - 150);
  return { summary: bridge.summary, recent: counted.slice(watermark).map((m) => ({ role: m.role, text: m.text, ts: m.ts })) };
}

/** continuity.ts foldIfDue + foldIntoSummary (one fold, or null when not due). */
async function devFold(raw: Row[], b: Bridge, persona: string): Promise<Bridge | null> {
  const counted = raw.filter(isCounted);
  let bridge = b;
  if (bridge.summarizedCount >= counted.length && bridge.summarizedCount > 0) bridge = { summary: '', summarizedCount: 0 };
  const unsummarized = counted.slice(bridge.summarizedCount);
  if (unsummarized.length < 100) return null;
  const evicted = unsummarized.slice(0, Math.min(unsummarized.length - 50, 300)).map((m) => ({ role: m.role, text: m.text, ts: m.ts }));
  const res = await provider('fold').call({
    model: MODEL,
    maxTokens: 4000,
    system: foldPrompt.buildFoldSystem(persona),
    messages: [{ role: 'user', content: foldPrompt.buildFoldUserText(bridge.summary, evicted) }],
    anthropicExtra: { thinking: { type: 'adaptive' } },
  });
  const text = foldPrompt.extractSummaryTag(res.text);
  if (res.stopReason === 'max_tokens' || !text) return bridge;
  return { summary: text, summarizedCount: bridge.summarizedCount + evicted.length };
}

/** chatService readMemoryTail. */
function memoryTail(): string {
  try {
    const raw = fs.readFileSync(memFile, 'utf8');
    return memoryLog.humanizeMemoryStamps(raw.length <= 12000 ? raw : raw.slice(-12000));
  } catch {
    return '';
  }
}

// ── the arm's fold / session end / play row ───────────────────────────────
const foldStats = { folds: 0, factsSaved: 0, dupes: 0 };
async function maybeFold(rows: Row[], bridge: Bridge, now: number): Promise<Bridge> {
  for (let i = 0; i < 4; i++) {
    let next: Bridge | null;
    if (core?.foldStep) {
      const r = await core.foldStep({
        raw: rows,
        bridge,
        persona: ch.expanded,
        llm: provider('fold'),
        readMemory: async () => (fs.existsSync(memFile) ? fs.readFileSync(memFile, 'utf8') : ''),
        appendMemory: (text: string) => memoryLog.appendMemory(memFile, text, new Date(now), { section: 'app' }),
      });
      if (!r) return bridge;
      foldStats.factsSaved += r.saved ?? 0;
      foldStats.dupes += r.dupes ?? 0;
      next = r.bridge;
    } else {
      next = await devFold(rows, bridge, ch.expanded);
    }
    if (!next || next.summarizedCount === bridge.summarizedCount) return next ?? bridge;
    foldStats.folds++;
    bridge = next;
  }
  return bridge;
}

const sessionEnds: Array<Record<string, unknown>> = [];
/** index.ts closePlaySession (check route) / startCallNextStep: the arm's session-end call. */
async function sessionEnd(
  surface: 'game' | 'call',
  lines: Array<{ who: string; text: string }>,
  playerLines: number,
  durationMs: number,
  endedAt: number,
): Promise<Record<string, any>> {
  const input = {
    characterId: CHAR_ID,
    surface,
    ...(surface === 'game' ? { game: 'minecraft', goalsGame: 'minecraft', activity: 'playing Minecraft with the player' } : { activity: 'a voice call' }),
    durationMs,
    lines,
    playerLines,
  };
  const deps = {
    buildProvider: async () => provider(`session_end_${surface}`),
    isOnline: () => true,
    overLimit: async () => false,
    freeCloud: async () => false,
    readText: async (f: string) => fs.readFileSync(f, 'utf8'),
    memoryFile: () => memFile,
    goalsFile: () => path.join(memDir, 'no-goals.md'),
    characterName: async () => ch.name,
    save: async (_id: string, line: string, o?: { inGame?: boolean }) =>
      (await memoryLog.appendMemory(memFile, line, new Date(endedAt), o?.inGame ? { world: { num: 1, label: 'Meadow', game: 'Minecraft' } } : { section: 'app' })) > 0,
    saveFacts: async (facts: string[], o?: { inGame?: boolean }) => {
      let saved = 0;
      for (const f of facts) {
        saved += await memoryLog.appendMemory(memFile, f, new Date(endedAt), o?.inGame ? { world: { num: 1, label: 'Meadow', game: 'Minecraft' } } : { section: 'app' });
      }
      return saved;
    },
    capture: () => {},
    timeoutMs: () => 45_000,
    scoped: <T>(fn: () => Promise<T>) => fn(),
    now: () => endedAt,
    log: () => {},
  };
  const r = playerEnd.runSessionEnd ? await playerEnd.runSessionEnd(input, deps) : { outcome: await playerEnd.runPlayerEndNextStep(input, deps) };
  sessionEnds.push({ surface, outcome: r.outcome, recap: r.recap ?? null, facts: r.factsSaved ?? null });
  return r;
}

/** index.ts emitPlaySession: the play row, from the arm. */
function playRow(durationMs: number, endedAt: number, end: Record<string, any>, digest: any): Row {
  if (playSummary.buildPlayRow) {
    return {
      id: `play-${endedAt}`,
      ...playSummary.buildPlayRow({ name: ch.name, gameName: 'Minecraft', game: 'minecraft', durationMs, recap: end.recap ?? null, digest }),
      ts: endedAt,
    };
  }
  return {
    id: `play-${endedAt}`,
    role: 'system',
    text: playSummary.playSummaryText(ch.name, 'Minecraft', durationMs),
    ts: endedAt,
    event: { kind: 'play', game: 'minecraft', durationMs },
  };
}

// ── build ─────────────────────────────────────────────────────────────────
function withFacts(pairs: string[][], facts: Record<string, string[]>): string[][] {
  const out = [...pairs];
  for (const idx of Object.keys(facts).map(Number).sort((a, b) => a - b)) out.splice(idx, 0, facts[idx]);
  return out;
}

async function build(): Promise<void> {
  fs.rmSync(STATE, { recursive: true, force: true });
  fs.mkdirSync(memDir, { recursive: true });
  const t0 = Date.now();
  let rows: Row[] = [];
  let bridge: Bridge = { summary: '', summarizedCount: 0 };
  let n = 0;
  const push = async (role: Row['role'], text: string, ts: number, extra: Partial<Row> = {}) => {
    rows.push({ id: `r${n++}`, role, text, ts, ...extra });
    if (role !== 'system') bridge = await maybeFold(rows, bridge, ts);
  };
  const exchanges = async (pairs: string[][], start: number, voice = false) => {
    let ts = start;
    for (const [p, c] of pairs) {
      await push('user', p, ts, voice ? { voice: true } : {});
      await push('companion', c, ts + 20_000, voice ? { voice: true } : {});
      ts += 60_000;
    }
    return ts;
  };

  // 1. two-week-old memories
  for (const m of L.seedMemory) await memoryLog.appendMemory(memFile, m.text, new Date(t0 - m.daysAgo * DAY), { section: 'app' });

  // 2. text chat
  const chatAt = t0 - L.chat.daysAgo * DAY - 2 * 3_600_000;
  await exchanges(withFacts(filler.chat, L.chat.facts), chatAt);

  // 3. the Minecraft session, as the game fixture played it
  const gameAt = t0 - L.game.daysAgo * DAY - 3 * 3_600_000;
  await memoryLog.noteWorld(memFile, 1, 'Meadow', 'Minecraft');
  for (let i = 0; i < game.remembers.length; i++) {
    await memoryLog.appendMemory(memFile, game.remembers[i], new Date(gameAt + (i + 1) * 10 * 60_000), { world: { num: 1, label: 'Meadow', game: 'Minecraft' } });
  }
  const digest = digestMod.createSessionDigest();
  for (const l of game.lines) digest.record(l.who, l.text);
  const snap = digest.snapshot();
  const gameEnd = gameAt + game.durationMs;
  const end = await sessionEnd('game', snap.lines, snap.playerLines, game.durationMs, gameEnd);
  rows.push(playRow(game.durationMs, gameEnd, end, snap));
  bridge = await maybeFold(rows, bridge, gameEnd); // emitPlaySession folds after its row

  // 4. voice call
  const callAt = t0 - L.call.daysAgo * DAY - 1 * 3_600_000;
  const callPairs = withFacts(filler.call, L.call.facts);
  const callEnd = await exchanges(callPairs, callAt, true);
  const callMs = callEnd - callAt;
  const callLines = callPairs.slice(-8).flatMap(([p, c]) => [{ who: 'player', text: p }, { who: 'you', text: c }]);
  await sessionEnd('call', callLines, callPairs.length, callMs, callEnd);
  await push('system', `You and ${ch.name} called for ${playSummary.formatPlayDuration(callMs)}.`, callEnd, { event: { kind: 'call', durationMs: callMs } });
  bridge = await maybeFold(rows, bridge, callEnd);

  // 5. today, before the probe
  await exchanges(filler.current.slice(0, HISTORY_N), t0 - (HISTORY_N + 2) * 60_000);

  fs.writeFileSync(rowsFile, JSON.stringify(rows));
  fs.writeFileSync(bridgeFile, JSON.stringify(bridge));
  fs.writeFileSync(
    path.join(STATE, 'build.json'),
    JSON.stringify({ t0, src: SRC, historyN: HISTORY_N, rows: rows.length, bridge, foldStats, sessionEnds, usage }, null, 1),
  );
}

// ── probe ─────────────────────────────────────────────────────────────────
const STOP = ['\nHuman:', '\nAssistant:', '\nPlayer:', '\n(game)'];

async function chatProbe(text: string, voice: boolean): Promise<{ says: string[]; tools: string[] }> {
  const rows = readRows();
  const bridge = readBridge();
  rows.push({ id: 'probe', role: 'user', text, ts: Date.now(), ...(voice ? { voice: true } : {}) });
  const ctx = core?.chatContext ? core.chatContext(rows, bridge) : devChatContext(rows, bridge);
  const system = chatPrompts.buildSystemBlocks({
    persona: { source: ch.source ?? '', expanded: ch.expanded },
    name: ch.name,
    preferredName: PLAYER,
    proactiveness: 1,
    punctuation: ch.punctuation === 'deliberate' ? 'deliberate' : 'casual',
    memory: memoryTail(),
    summary: ctx.summary,
    knowledge: '',
    openWorldDetected: false,
    inGame: false,
    voiceCall: voice,
    language: 'en',
    memoryGuide: true,
    searchGuide: true,
    clockInTail: voice,
  });
  const history = voice ? ctx.history.slice(transcript.voiceWindowStart(ctx.history, ctx.base ?? 0, 10, 10)) : ctx.history;
  const messages: any[] = transcript.toMessages(history);
  chatPrompts.markLastMessageCached(messages);
  if (voice) chatPrompts.appendUncachedTail(messages, chatPrompts.clockTailNote());
  const tools = chatPrompts.chatSurfaceTools(voice, webTools.webToolsFor({ serverWebSearch: false }));
  const llm = provider(voice ? 'probe_voice' : 'probe_text');
  const says: string[] = [];
  const used: string[] = [];
  for (let hop = 0; hop < 3; hop++) {
    const res = await llm.call({ maxTokens: 200, system, tools, stopSequences: STOP, messages });
    if (res.text.trim()) says.push(res.text.trim());
    if (!res.toolUses.length) break;
    messages.push({ role: 'assistant', content: res.content });
    used.push(...res.toolUses.map((t: any) => t.name));
    messages.push({
      role: 'user',
      content: res.toolUses.map((t: any) => ({
        type: 'tool_result',
        tool_use_id: t.id,
        content:
          t.name === 'remember'
            ? 'Saved to your memory. Continue your reply; do not mention saving it.'
            : t.name === 'search' || t.name === 'visit'
              ? 'No results.'
              : 'Done.',
      })),
    });
    if (res.toolUses.some((t: any) => t.name === 'end_call' || t.name === 'quit_game' || t.name === 'launch_game')) break;
  }
  return { says, tools: used };
}

async function mcProbe(text: string): Promise<{ says: string[]; tools: string[] }> {
  const rows = readRows();
  const bridge = readBridge();
  const continuity = core?.launchContinuity ? core.launchContinuity(rows, bridge) : devLaunchContinuity(rows, bridge);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ce-mc-${CHAR}-`));
  try {
    fs.cpSync(memDir, dir, { recursive: true });
    const brainUsage: any[] = [];
    const brain = await createGameBrain({ src: SRC, ch, memDir: dir, key: KEY, continuity, usage: brainUsage });
    // No primed greeting: the probe is the first thing said in the session,
    // so the opener probes (E) read her first line of the session.
    const r = await brain.playerTurn(text);
    for (const u of brainUsage) usage.push({ what: 'probe_mc', ...u });
    return { says: r.says, tools: r.remembers.length ? ['remember'] : [] };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function probe(): Promise<void> {
  const out: string[] = [];
  const probes = L.probes.filter((p: any) => !PROBES || PROBES.split(',').includes(p.id));
  for (const surface of SURFACES) {
    for (const p of probes) {
      let r: { says: string[]; tools: string[] } = { says: [], tools: [] };
      let error: string | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          r = surface === 'mc' ? await mcProbe(p.text) : await chatProbe(p.text, surface === 'voice');
          error = null;
          break;
        } catch (err) {
          error = String((err as Error)?.message ?? err).slice(0, 300);
        }
      }
      out.push(JSON.stringify({ char: CHAR, probe: p.id, cat: p.cat, surface, says: r.says, tools: r.tools, error }));
    }
  }
  fs.writeFileSync(OUT!, out.join('\n') + '\n');
  fs.writeFileSync(`${OUT}.usage.json`, JSON.stringify(usage));
}

if (!KEY) throw new Error('ANTHROPIC_API_KEY missing');
if (PHASE === 'build') await build();
else await probe();
if (PHASE === 'build') fs.writeFileSync(path.join(STATE, 'usage.json'), JSON.stringify(usage));
process.exit(0);
