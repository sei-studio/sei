/**
 * Voice reply latency harness (261123, O5). OFF by default: run it with
 *
 *   SEI_LATENCY_HARNESS=1 npx vitest run src/main/chat/voiceLatency.harness.test.ts
 *
 * A mid-call voice turn through the REAL main pipeline (sendChatMessage with
 * the real config, character and transcript stores on disk, the real
 * Anthropic SDK client, then voiceTtsStream for the first line), pointed at a
 * local stand-in for api.sei.gg that answers with FIXED delays: the LLM's time
 * to first token, its token pace, and TTS time to first byte. Everything the
 * fixed delays do not explain is the client's own work, which is what this
 * measures:
 *   - send -> LLM request at the proxy      (prep: transcript write, prompt build, provider)
 *   - first token -> first line emitted     (sentence split, persist, push)
 *   - TTS call -> TTS request at the proxy  (per-line voice/route lookups)
 *   - TTS response -> first chunk at sink
 * The Supabase session read is stubbed with a file read (the real one also
 * decrypts); HARNESS_SESSION_MS adds a fixed delay to it, a stand-in for a
 * slower provider build (keychain decrypt, an antivirus-scanned disk, a busy
 * main loop, the ChatGPT plan's model lookup). No network beyond 127.0.0.1, no vendor calls, no cost.
 * A second case (261127, T563) times the call GREETING the same way
 * (sendVoiceGreetingTurn, not streamed), the main-side share of the connect.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ENABLED = process.env.SEI_LATENCY_HARNESS === '1';
const LLM_TTFT_MS = Number(process.env.HARNESS_LLM_TTFT_MS ?? 400);
const TOKEN_GAP_MS = Number(process.env.HARNESS_TOKEN_GAP_MS ?? 15);
const TTS_TTFB_MS = Number(process.env.HARNESS_TTS_TTFB_MS ?? 250);
const RUNS = Number(process.env.HARNESS_RUNS ?? 25);

const { port, sessionFile } = vi.hoisted(() => {
  const p = 41000 + (process.pid % 2000);
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
        const extra = Number(process.env.HARNESS_SESSION_MS ?? 0);
        if (extra > 0) await new Promise((r) => setTimeout(r, extra));
        const raw = await readFile(sessionFile.path, 'utf8');
        return { data: { session: JSON.parse(raw) }, error: null };
      },
    },
  }),
}));
vi.mock('../auth/authState', () => ({
  getCurrentAuthState: () => ({ kind: 'signed_in', user: { id: '11111111-1111-4111-8111-111111111111' } }),
}));

import { VOICES } from 'soulcaster';
import { _setUserDataOverride, paths } from '../paths';
import { drainScopedWrites } from '../profile/scopeBarrier';
import { setCallActive } from '../voice/callState';
import { sendChatMessage, sendVoiceGreetingTurn, type ChatDeps } from './chatService';
import { voiceTtsStream } from '../voice/tts';

const CHAR = '66666666-6666-4666-8666-666666666666';
const REPLY = ['Hey, good to hear you again.', ' So what are we building today?', ' I was thinking about that castle.'];

/** Server-side arrival times (Date.now) of the last request per route.
 * `anyLlm` also counts non-streamed requests (the call greeting). */
const arrivals: { llm: number; anyLlm: number; tts: number } = { llm: 0, anyLlm: 0, tts: 0 };

function sse(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const at = Date.now();
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { stream?: boolean };
  if (req.url?.startsWith('/v1/messages')) {
    if (body.stream) arrivals.llm = at;
    arrivals.anyLlm = at;
    await sleep(LLM_TTFT_MS);
    const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'x', content: [{ type: 'text', text: 'none' }], stop_reason: 'end_turn', usage }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    sse(res, 'message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [], stop_reason: null, usage } });
    sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    // Word-sized deltas at a fixed pace, like a real stream.
    const tokens = REPLY.join('').split(/(?=\s)/);
    for (const tok of tokens) {
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: tok } });
      await sleep(TOKEN_GAP_MS);
    }
    sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
    sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } });
    sse(res, 'message_stop', { type: 'message_stop' });
    res.end();
    return;
  }
  if (req.url?.startsWith('/tts/speech')) {
    arrivals.tts = at;
    await sleep(TTS_TTFB_MS);
    res.writeHead(200, { 'content-type': 'audio/mpeg' });
    for (let i = 0; i < 4; i++) {
      res.write(Buffer.alloc(2048, 7));
      await sleep(20);
    }
    res.end();
    return;
  }
  // prewarm HEAD and anything else
  res.writeHead(200);
  res.end();
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function p90(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.9))];
}

describe.skipIf(!ENABLED)('voice reply latency harness', () => {
  let server: http.Server;
  let dir: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => void handle(req, res).catch(() => res.destroy()));
    await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
    expect((server.address() as AddressInfo).port).toBe(port);
    dir = await mkdtemp(path.join(tmpdir(), 'sei-latency-harness-'));
    _setUserDataOverride(dir);
    sessionFile.path = path.join(dir, 'session-stub.json');
    await writeFile(sessionFile.path, JSON.stringify({ access_token: 'jwt-' + 'x'.repeat(900), refresh_token: 'r', expires_at: 4e9 }));
    // A realistic profile: config, a character with a full persona, a long
    // transcript and a memory file.
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
        metadata: { voiceId: VOICES[0].id },
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
    setCallActive(CHAR, true);
  });

  afterAll(async () => {
    setCallActive(CHAR, false);
    await drainScopedWrites();
    _setUserDataOverride(null);
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  });

  it('measures the client-side share of a voice turn', async () => {
    const prep: number[] = [];
    const tokenToLine: number[] = [];
    const lineOut: number[] = [];
    const ttsPrep: number[] = [];
    const ttsChunk: number[] = [];
    const firstAudioBytes: number[] = [];

    for (let run = 0; run < RUNS + 2; run++) {
      let lineAt = 0;
      let timing: { llmStartAt?: number; firstTokenAt?: number } | undefined;
      let ttsCall = 0;
      let chunkAt = 0;
      let ttsDone: Promise<void> = Promise.resolve();
      const deps: ChatDeps = {
        getLanState: () => ({ kind: 'closed' }),
        summon: async () => undefined,
        leaveGame: () => {},
        emitReply: (_id, msg, speech) => {
          if (lineAt) return;
          lineAt = Date.now();
          timing = speech?.replyTiming;
          // TTS for the first line starts as soon as it is out, the way the
          // renderer asks for it (the push and the invoke are ~1ms of IPC).
          ttsCall = Date.now();
          ttsDone = new Promise<void>((resolve) => {
            void voiceTtsStream({ characterId: CHAR, text: msg.text }, (ev) => {
              if ('chunk' in ev && !chunkAt) chunkAt = Date.now();
              if ('done' in ev || 'error' in ev) resolve();
            }).catch(() => resolve());
          });
        },
      };
      const t0 = Date.now();
      await sendChatMessage({ characterId: CHAR, text: `hey sui, run ${run}`, voiceCall: true }, deps);
      await ttsDone;
      if (run < 2) continue; // warm-up (module imports, first file opens)
      prep.push(arrivals.llm - t0);
      tokenToLine.push(lineAt - (timing?.firstTokenAt ?? lineAt));
      lineOut.push(lineAt - t0);
      ttsPrep.push(arrivals.tts - ttsCall);
      ttsChunk.push(chunkAt - arrivals.tts - TTS_TTFB_MS);
      firstAudioBytes.push(chunkAt - t0);
    }
    const row = (name: string, xs: number[]) => `${name.padEnd(44)} p50 ${String(median(xs)).padStart(5)}ms  p90 ${String(p90(xs)).padStart(5)}ms`;
    console.log(
      [
        `[harness] ${RUNS} runs, LLM TTFT ${LLM_TTFT_MS}ms, token gap ${TOKEN_GAP_MS}ms, TTS TTFB ${TTS_TTFB_MS}ms`,
        row('send -> LLM request at proxy (client prep)', prep),
        row('first token -> first line emitted', tokenToLine),
        row('send -> first line emitted', lineOut),
        row('TTS call -> TTS request at proxy', ttsPrep),
        row('TTS response -> first chunk (minus TTFB)', ttsChunk),
        row('(sequential total to first audio bytes)', firstAudioBytes),
      ].join('\n'),
    );
    expect(prep.every((x) => x >= 0)).toBe(true);
  }, 120_000);

  // 261127 (T563): the call greeting runs while the phone rings, and the call
  // connects only once its first line is back (or the 5s cap). This is the
  // client's share of voice_call_ended connect_greet_request_ms /
  // connect_greet_ready_ms: everything except the model's own time.
  it('measures the client-side share of a call greeting', async () => {
    const prep: number[] = [];
    const stampLag: number[] = [];
    const after: number[] = [];
    const total: number[] = [];
    for (let run = 0; run < RUNS + 2; run++) {
      const timing: { llmStartAt?: number } = {};
      const t0 = Date.now();
      const replies = await sendVoiceGreetingTurn(CHAR, [], { plan: null, timing });
      const done = Date.now();
      expect(replies.length).toBeGreaterThan(0);
      if (run < 2) continue; // warm-up
      prep.push(arrivals.anyLlm - t0);
      stampLag.push(arrivals.anyLlm - (timing.llmStartAt ?? arrivals.anyLlm));
      after.push(done - arrivals.anyLlm - LLM_TTFT_MS);
      total.push(done - t0);
    }
    const row = (name: string, xs: number[]) => `${name.padEnd(44)} p50 ${String(median(xs)).padStart(5)}ms  p90 ${String(p90(xs)).padStart(5)}ms`;
    console.log(
      [
        `[harness] greeting, ${RUNS} runs, LLM response after ${LLM_TTFT_MS}ms (not streamed)`,
        row('greet -> LLM request at proxy (client prep)', prep),
        row('llmStartAt stamp -> request at proxy', stampLag),
        row('LLM response -> replies back (persist)', after),
        row('greet -> replies back (total)', total),
      ].join('\n'),
    );
    expect(prep.every((x) => x >= 0)).toBe(true);
  }, 120_000);
});
