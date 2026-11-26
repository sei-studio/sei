/**
 * Typed chat reply latency harness (261125, O5). OFF by default: run it with
 *
 *   SEI_LATENCY_HARNESS=1 npx vitest run src/main/chat/chatLatency.harness.test.ts
 *
 * The typed-chat twin of voiceLatency.harness.test.ts: a typed turn through
 * the REAL main pipeline (sendChatMessage with the real config, character and
 * transcript stores on disk and the real Anthropic SDK client), pointed at a
 * local stand-in for api.sei.gg that answers the (non-streaming) typed-chat
 * request after a FIXED delay. Everything the fixed delay does not explain is
 * the client's own work:
 *   - send -> LLM request at the proxy   (lan check, transcript write, prompt build, provider)
 *   - LLM response -> reply returned     (split, persist, last_chatted stamp)
 * `chat:send` awaits a fresh world-detection pass (lsof/netstat + loopback
 * pings, ~60-100ms on a healthy Mac) before the prompt; HARNESS_LAN_MS stands
 * in for it, run both ways: `serial` (pre-261125: the pass, then the turn)
 * and `overlapped` (deps.lanReady, as ipc.ts drives it now). The real pass
 * also used to hold 700 ms on a ping timeout whenever no world was open
 * (mcPing.ts now fails fast on a closed socket; see mcPing.test.ts).
 * A second case counts TCP connections: turns spaced past fetch's 4s
 * keep-alive window, with and without the typing prewarm.
 * No network beyond 127.0.0.1, no vendor calls, no cost.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ENABLED = process.env.SEI_LATENCY_HARNESS === '1';
const LLM_MS = Number(process.env.HARNESS_LLM_MS ?? 600);
const LAN_MS = Number(process.env.HARNESS_LAN_MS ?? 80);
const RUNS = Number(process.env.HARNESS_RUNS ?? 25);

const { port, sessionFile } = vi.hoisted(() => {
  const p = 43000 + (process.pid % 2000);
  process.env.SEI_PROXY_URL = `http://127.0.0.1:${p}`;
  return { port: p, sessionFile: { path: '' } };
});

vi.mock('../analytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../analytics')>()),
  capture: () => {},
}));
vi.mock('../auth/supabaseClient', () => ({
  getClient: () => ({
    auth: {
      getSession: async () => {
        const raw = await readFile(sessionFile.path, 'utf8');
        return { data: { session: JSON.parse(raw) }, error: null };
      },
    },
  }),
}));
vi.mock('../auth/authState', () => ({
  getCurrentAuthState: () => ({ kind: 'signed_in', user: { id: '11111111-1111-4111-8111-111111111111' } }),
}));

import { _setUserDataOverride, paths } from '../paths';
import { drainScopedWrites } from '../profile/scopeBarrier';
import { sendChatMessage, type ChatDeps } from './chatService';
import { startChatReplyClock, type ReplyLatencySample } from '../replyLatency';

const CHAR = '77777777-7777-4777-8777-777777777777';
const REPLY = 'hey, good to see you again\n\nwhat are we building today';

/** Server-side arrival / response times (Date.now) of the last LLM request. */
const marks = { llmIn: 0, llmOut: 0 };
let connections = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const at = Date.now();
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (req.url?.startsWith('/v1/messages')) {
    marks.llmIn = at;
    await sleep(LLM_MS);
    const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    marks.llmOut = Date.now();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'x', content: [{ type: 'text', text: REPLY }], stop_reason: 'end_turn', usage }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{"status":"ok"}');
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function p90(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.9))];
}
const row = (name: string, xs: number[]) => `${name.padEnd(46)} p50 ${String(median(xs)).padStart(5)}ms  p90 ${String(p90(xs)).padStart(5)}ms`;

/** The chat:send handler's world-detection pass, stood in by a fixed delay. */
const lanPass = (): Promise<void> => sleep(LAN_MS).then(() => undefined);

function baseDeps(): ChatDeps {
  return {
    getLanState: () => ({ kind: 'closed' }),
    summon: async () => undefined,
    leaveGame: () => {},
  };
}

describe.skipIf(!ENABLED)('typed chat reply latency harness', () => {
  let server: http.Server;
  let dir: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => void handle(req, res).catch(() => res.destroy()));
    server.on('connection', () => {
      connections += 1;
    });
    await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
    expect((server.address() as AddressInfo).port).toBe(port);
    dir = await mkdtemp(path.join(tmpdir(), 'sei-chat-latency-harness-'));
    _setUserDataOverride(dir);
    sessionFile.path = path.join(dir, 'session-stub.json');
    await writeFile(sessionFile.path, JSON.stringify({ access_token: 'jwt-' + 'x'.repeat(900), refresh_token: 'r', expires_at: 4e9 }));
    await mkdir(path.dirname(paths.configPath()), { recursive: true });
    await writeFile(
      paths.configPath(),
      JSON.stringify({ ai_backend_kind: 'cloud-proxy', ai_backend_kind_source: 'user', preferred_name: 'Player', chat_language: 'en' }),
    );
    const persona = 'She is warm, quick and teasing, and loves building things. '.repeat(100);
    await mkdir(path.dirname(paths.characterPath(CHAR)), { recursive: true });
    await writeFile(
      paths.characterPath(CHAR),
      JSON.stringify({
        id: CHAR,
        name: 'Sui',
        persona: { source: 'warm builder', expanded: persona },
        created: new Date().toISOString(),
      }),
    );
    const rows: string[] = [];
    for (let i = 0; i < 300; i++) {
      rows.push(
        JSON.stringify({
          id: `r${i}`,
          role: i % 2 ? 'companion' : 'user',
          text: `line ${i} about mining iron and building the castle wall near the river`,
          ts: Date.now() - (300 - i) * 60_000,
        }),
      );
    }
    await mkdir(paths.memoryDir(CHAR), { recursive: true });
    await writeFile(path.join(paths.memoryDir(CHAR), 'chat.jsonl'), rows.join('\n') + '\n');
    await writeFile(path.join(paths.memoryDir(CHAR), 'MEMORY.md'), '- likes castles\n'.repeat(500));
  });

  afterAll(async () => {
    await drainScopedWrites();
    _setUserDataOverride(null);
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  });

  async function turn(run: number, mode: 'serial' | 'overlapped'): Promise<{ t0: number; done: number; phases: Record<string, number> }> {
    const samples: ReplyLatencySample[] = [];
    const t0 = Date.now();
    const clock = startChatReplyClock({ turn: 1, startedAt: t0, record: (x) => samples.push(x) });
    const deps: ChatDeps = { ...baseDeps(), markPhase: clock.mark };
    if (mode === 'serial') await lanPass(); // pre-261125 chat:send: the pass, THEN the turn
    else deps.lanReady = lanPass(); // 261125: started by the handler, awaited inside the turn
    const r = await sendChatMessage({ characterId: CHAR, text: `hey sui, run ${run}` }, deps);
    clock.settle(r);
    expect(r.replies.length).toBeGreaterThan(0);
    return { t0, done: Date.now(), phases: (samples[0]?.phases ?? {}) as Record<string, number> };
  }

  for (const mode of ['serial', 'overlapped'] as const) {
    it(`measures the client-side share of a typed chat turn (${mode} LAN pass)`, async () => {
      const prep: number[] = [];
      const post: number[] = [];
      const total: number[] = [];
      const promptBuilt: number[] = [];
      const providerReady: number[] = [];
      for (let run = 0; run < RUNS + 2; run++) {
        const { t0, done, phases } = await turn(run, mode);
        if (run < 2) continue; // warm-up (module imports, first file opens)
        prep.push(marks.llmIn - t0);
        post.push(done - marks.llmOut);
        total.push(done - t0);
        promptBuilt.push(phases.prompt_built_ms ?? -1);
        providerReady.push(phases.provider_ready_ms ?? -1);
      }
      console.log(
        [
          `[chat harness] ${mode}: ${RUNS} runs, LLM ${LLM_MS}ms (non-streaming), lan pass ${LAN_MS}ms`,
          row('send -> LLM request at proxy (client prep)', prep),
          row('  of which prompt_built_ms', promptBuilt),
          row('  of which provider_ready_ms', providerReady),
          row('LLM response -> reply returned (post)', post),
          row('send -> reply returned (chat ms)', total),
          row('client share (chat ms - LLM)', total.map((x) => x - LLM_MS)),
        ].join('\n'),
      );
      expect(prep.every((x) => x >= 0)).toBe(true);
    }, 120_000);
  }

  // Connection reuse: turns spaced past fetch's 4s keep-alive, the way a
  // player types between messages. Off unless HARNESS_KEEPALIVE=1 (slow).
  it.skipIf(process.env.HARNESS_KEEPALIVE !== '1')('counts new connections per turn, with and without the typing prewarm', async () => {
    const { prewarmProxyConnection, _resetProxyPrewarm } = await import('../proxyPrewarm');
    const result: Record<string, number[]> = { cold: [], prewarmed: [] };
    for (const mode of ['cold', 'prewarmed'] as const) {
      for (let i = 0; i < 3; i++) {
        await sleep(4_500);
        if (mode === 'prewarmed') {
          // The composer's keystrokes: a prewarm ~1s before Enter.
          _resetProxyPrewarm();
          prewarmProxyConnection();
          await sleep(1_000);
        }
        const before = connections;
        await turn(100 + i, 'overlapped');
        result[mode].push(connections - before);
      }
    }
    console.log(`[chat harness] new TCP connections opened by the turn itself: cold ${result.cold.join(',')}  prewarmed ${result.prewarmed.join(',')}`);
    expect(result.prewarmed.every((n) => n === 0)).toBe(true);
  }, 120_000);
});
