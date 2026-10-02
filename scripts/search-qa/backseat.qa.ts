/**
 * Search QA, Backseat game sessions (261003).
 *
 *   npx vitest run --config scripts/search-qa/vitest.config.ts backseat
 *
 * Plays scripted multi-turn conversations through the REAL backseat turn:
 * startBackseat -> handleTick -> runTurn (real buildSystemBlocks, real
 * BACKSEAT_CONTRACT + Roblox game block, real sessionTools, real
 * followUpWebLookup, real main-side Anthropic provider). Only storage and
 * identity are swapped: a temp userData dir, a character read from
 * SEI_QA_CHAR (a JSON file {id,name,persona,metadata}), and the dev test key
 * in place of the cloud proxy (the proxy forwards the body verbatim).
 *
 * The screen is a real 6-cell grid of the game's own Roblox screenshots
 * (SEI_QA_GRIDS dir, <grid>.jpg, not in the repo: any six screenshots of the
 * game tiled 3x2). Output: one JSON per run in SEI_QA_OUT.
 *
 * SEI_QA_KIND=openai keeps the same model but reports the provider kind as
 * non-Anthropic, so the session gets our client search()/visit() (the BYOK
 * path) instead of Anthropic's server web_search.
 */
import { describe, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';

const H = vi.hoisted(() => ({
  responses: [] as Array<{ at: number; ms: number; content: unknown[]; stop: string | null; usage: unknown }>,
  said: [] as string[],
  logs: [] as string[],
}));

// The Roblox game details come over electron's net.fetch in the app; plain
// fetch here, or the session runs without the game block.
vi.mock('electron', async (orig) => ({
  ...((await orig()) as object),
  net: { fetch: (...a: Parameters<typeof fetch>) => fetch(...a) },
}));
vi.mock('../../src/main/analytics', () => ({ capture: () => {}, captureSurfaceError: () => {}, surfaceErrorClass: () => 'x' }));
vi.mock('../../src/main/lazyAnalytics', () => ({
  loadAnalytics: async () => ({ capture: () => {}, captureSurfaceError: () => {}, surfaceErrorClass: () => 'x' }),
}));
vi.mock('../../src/main/chat/sdk', async () => {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const key =
    process.env.ANTHROPIC_API_KEY ||
    readFileSync(path.join(homedir(), '.sei-dev', 'anthropic-test-key'), 'utf8').trim();
  return {
    CHAT_TIMEOUT_MS: 60_000,
    CHAT_MODEL: 'claude-haiku-4-5',
    LOCAL_NO_API_KEY: 'LOCAL_NO_API_KEY',
    buildChatSdk: async () => ({ client: new Anthropic({ apiKey: key, maxRetries: 2 }), model: process.env.SEI_QA_MODEL || 'claude-haiku-4-5' }),
  };
});
vi.mock('../../src/main/apiKeyStore', () => ({
  getAiBackendKind: async () => 'cloud-proxy',
  hasApiKey: async () => true,
  loadApiKey: async () => '',
}));
vi.mock('../../src/main/configStore', () => ({ loadConfig: async () => ({ preferred_name: 'Kai' }) }));
vi.mock('../../src/main/characterStore', () => ({
  getCharacter: async () => JSON.parse(readFileSync(process.env.SEI_QA_CHAR!, 'utf8')),
  patchCharacter: async () => {},
}));
vi.mock('../../src/main/chat/continuity', async (orig) => ({
  ...(await orig<typeof import('../../src/main/chat/continuity')>()),
  foldIfDue: async () => {},
}));
vi.mock('../../src/main/backseat/backseatLog', () => {
  const log = { line: (m: string) => H.logs.push(m), close: async () => {} };
  return { createBackseatLog: async () => log, NULL_BACKSEAT_LOG: log };
});
vi.mock('../../src/main/llm', async (orig) => {
  const real = await orig<typeof import('../../src/main/llm')>();
  return {
    ...real,
    activeLlmVision: async () => 'yes',
    buildLlmProvider: async () => {
      const p = await real.buildLlmProvider();
      const kind = process.env.SEI_QA_KIND || p.kind;
      return {
        ...p,
        kind,
        call: async (args: Parameters<typeof p.call>[0]) => {
          const t0 = Date.now();
          const r = await p.call(args);
          H.responses.push({ at: t0, ms: Date.now() - t0, content: r.content as unknown[], stop: r.stopReason ?? null, usage: r.usage });
          return r;
        },
      };
    },
  };
});

import { _setUserDataOverride, paths } from '../../src/main/paths';
import { endBackseat, handleTick, initBackseatService, startBackseat } from '../../src/main/backseat/backseatService';
import { CONVERSATIONS, type Convo } from './conversations';

const OUT = process.env.SEI_QA_OUT || path.join(tmpdir(), 'sei-search-qa');
const GRIDS = process.env.SEI_QA_GRIDS || '';
const RUNS = Number(process.env.SEI_QA_RUNS || 1);
const ONLY = process.env.SEI_QA_ONLY || '';

function summarize(content: unknown[]): { searches: string[]; visits: string[]; text: string } {
  const searches: string[] = [];
  const visits: string[] = [];
  const texts: string[] = [];
  for (const b of content as Array<{ type: string; name?: string; input?: { query?: string; ref?: string }; text?: string }>) {
    if (b.type === 'server_tool_use' && b.name === 'web_search') searches.push(String(b.input?.query ?? ''));
    if (b.type === 'tool_use' && b.name === 'search') searches.push(String(b.input?.query ?? ''));
    if (b.type === 'tool_use' && b.name === 'visit') visits.push(String(b.input?.ref ?? ''));
    if (b.type === 'text' && b.text) texts.push(b.text);
  }
  return { searches, visits, text: texts.join(' ').trim() };
}

async function runConvo(c: Convo, run: number): Promise<unknown> {
  const char = JSON.parse(await readFile(process.env.SEI_QA_CHAR!, 'utf8')) as { id: string; name: string };
  const grid = `data:image/jpeg;base64,${(await readFile(path.join(GRIDS, `${c.grid}.jpg`))).toString('base64')}`;
  let now = Date.now();
  const turns: unknown[] = [];
  // Fresh storage per conversation: no chat history carried over from the
  // previous run (run 2 would otherwise repeat run 1's looked-up answer), and
  // the memory dir exists so remember() works as in the app.
  _setUserDataOverride(await mkdtemp(path.join(tmpdir(), 'sei-qa-userdata-')));
  await mkdir(paths.memoryDir(char.id), { recursive: true });
  H.logs.length = 0;
  await startBackseat(char.id, 'window:1:0', 'Roblox', 'voice' as never, { gameId: 'roblox', universeId: c.universeId });
  const gameLine = H.logs.find((l) => l.startsWith('game:')) ?? null;
  process.stdout.write(`[${c.id}#${run}] ${gameLine}\n`);
  for (const t of [{ text: '', label: 'start' as const, kind: 'start' as const }, ...c.turns.map((x) => ({ ...x, kind: 'user' as const }))]) {
    H.responses.length = 0;
    H.said.length = 0;
    H.logs.length = 0;
    now = Date.now();
    const t0 = Date.now();
    await handleTick({
      characterId: char.id,
      kind: t.kind,
      grid,
      capturedAt: now,
      frameAges: [6, 5, 4, 3, 2, 0],
      ...(t.kind === 'user' ? { text: t.text, mic: { ttsGapMs: null } } : {}),
    });
    const ms = Date.now() - t0;
    const all = H.responses.flatMap((r) => r.content);
    const s = summarize(all);
    turns.push({
      player: t.text,
      label: t.label,
      qid: (t as { qid?: string }).qid ?? null,
      searched: s.searches.length > 0,
      queries: s.searches,
      visits: s.visits,
      calls: H.responses.length,
      stops: H.responses.map((r) => r.stop),
      ms,
      said: [...H.said],
      logs: H.logs.filter((l) => /web|search|visit|NO LINE|failed|game:/i.test(l)),
      blocks: all.map((b) => {
        const x = b as { type: string; text?: string; citations?: unknown[] };
        return x.type === 'text' ? { t: 'text', text: x.text, cited: !!x.citations?.length } : { t: x.type };
      }),
    });
    process.stdout.write(`[${c.id}#${run}] ${t.label.padEnd(6)} ${s.searches.length ? 'SEARCH ' + JSON.stringify(s.searches) : '-'} ${ms}ms\n   > ${t.text}\n   < ${H.said.join(' / ')}\n`);
  }
  await endBackseat(char.id);
  return { convo: c.id, game: c.game, gameLine, run, character: char.name, kind: process.env.SEI_QA_KIND || 'anthropic', turns };
}

describe('search QA: backseat', () => {
  it('runs the conversations', async () => {
    initBackseatService({
      pushChatMessage: (_c, m) => {
        if (m.role === 'companion') H.said.push(m.text);
      },
      pushState: () => {},
      pushLine: () => {},
      requestClip: () => {},
      isCallActive: () => true,
    });
    await mkdir(OUT, { recursive: true });
    const tag = process.env.SEI_QA_TAG || 'run';
    const results: unknown[] = [];
    for (const c of CONVERSATIONS.filter((x) => x.surface === 'backseat' && (!ONLY || ONLY.split(',').includes(x.id)))) {
      for (let r = 1; r <= RUNS; r++) results.push(await runConvo(c, r));
    }
    await writeFile(path.join(OUT, `backseat-${tag}.json`), JSON.stringify(results, null, 2));
  }, 3_600_000);
});
