/**
 * Search QA, desktop text chat (261020).
 *
 *   SEI_QA_CHAR=/path/sui.json npx vitest run --config scripts/search-qa/vitest.config.ts chat
 *
 * Sends single factual questions through the REAL typed-chat turn
 * (sendChatMessage: real buildSystemBlocks + CHAT_BASELINE, real chat tool
 * list, real hop loop, real main-side Anthropic provider with the server
 * web_search). Only storage and identity are swapped: a fresh temp userData
 * dir per question, a character read from SEI_QA_CHAR (a character JSON
 * {id,name,persona,metadata}), and the dev test key in place of the cloud
 * proxy (the proxy forwards the body verbatim).
 *
 * It exists for the 261020 report: after a search the answer started in the
 * companion's casual voice and slid into capitalized sentences lifted from the
 * pages. Output per question: the lead line pushed before the search, the
 * reply bubbles, and the raw text blocks (with their citation flag) in
 * SEI_QA_OUT/chat-<id>-<run>.json, plus a one-line summary on stdout.
 *
 * Env: SEI_QA_RUNS (default 1), SEI_QA_ONLY (question id), SEI_QA_MODEL
 * (default the companion model), SEI_QA_VOICE=1 runs the turn as a voice call.
 */
import { describe, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';

const H = vi.hoisted(() => ({
  responses: [] as Array<{ ms: number; content: unknown[]; stop: string | null; usage: unknown }>,
}));

vi.mock('../../src/main/analytics', () => ({ capture: () => {}, captureSurfaceError: () => {}, surfaceErrorClass: () => 'x' }));
vi.mock('../../src/main/lazyAnalytics', () => ({
  loadAnalytics: async () => ({ capture: () => {}, captureSurfaceError: () => {}, surfaceErrorClass: () => 'x' }),
}));
vi.mock('../../src/main/chat/sdk', async () => {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const { COMPANION_MODEL } = await import('../../src/shared/llmCatalog');
  const key =
    process.env.ANTHROPIC_API_KEY ||
    readFileSync(path.join(homedir(), '.sei-dev', 'anthropic-test-key'), 'utf8').trim();
  const model = process.env.SEI_QA_MODEL || COMPANION_MODEL;
  return {
    CHAT_TIMEOUT_MS: 60_000,
    CHAT_MODEL: model,
    LOCAL_NO_API_KEY: 'LOCAL_NO_API_KEY',
    buildChatSdk: async () => ({ client: new Anthropic({ apiKey: key, maxRetries: 2 }), model }),
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
vi.mock('../../src/main/llm', async (orig) => {
  const real = await orig<typeof import('../../src/main/llm')>();
  return {
    ...real,
    buildLlmProvider: async () => {
      const p = await real.buildLlmProvider();
      return {
        ...p,
        call: async (args: Parameters<typeof p.call>[0]) => {
          const t0 = Date.now();
          const r = await p.call(args);
          H.responses.push({ ms: Date.now() - t0, content: r.content as unknown[], stop: r.stopReason ?? null, usage: r.usage });
          return r;
        },
      };
    },
  };
});

import { _setUserDataOverride, paths } from '../../src/main/paths';
import { sendChatMessage } from '../../src/main/chat/chatService';
import { setCallActive } from '../../src/main/voice/callState';

const QUESTIONS: Array<{ id: string; text: string }> = [
  { id: 'mc-week', text: 'hey sui, quick one: did anything new come out for minecraft this week? like a snapshot or update' },
  { id: 'stardew', text: 'whats in the newest stardew valley update' },
  { id: 'fox', text: 'how do you tame a fox in minecraft again' },
  { id: 'valorant', text: 'who won valorant champions this year' },
];

const OUT = process.env.SEI_QA_OUT || path.join(tmpdir(), 'sei-search-qa');
const RUNS = Number(process.env.SEI_QA_RUNS || 1);
const ONLY = process.env.SEI_QA_ONLY || '';
const VOICE = process.env.SEI_QA_VOICE === '1';

describe('search QA: desktop chat', () => {
  it('answers factual questions after a search', async () => {
    await mkdir(OUT, { recursive: true });
    const char = JSON.parse(await readFile(process.env.SEI_QA_CHAR!, 'utf8')) as { id: string };
    for (const q of QUESTIONS.filter((x) => !ONLY || x.id === ONLY)) {
      for (let run = 1; run <= RUNS; run++) {
        _setUserDataOverride(await mkdtemp(path.join(tmpdir(), 'sei-qa-userdata-')));
        await mkdir(paths.memoryDir(char.id), { recursive: true });
        H.responses.length = 0;
        const pushed: string[] = [];
        if (VOICE) setCallActive(char.id, true);
        const res = await sendChatMessage(
          { characterId: char.id, text: q.text, ...(VOICE ? { voiceCall: true } : {}) },
          {
            getLanState: () => ({ kind: 'closed' }),
            summon: async () => undefined,
            leaveGame: () => {},
            emitReply: (_id, m) => { pushed.push(m.text); },
          },
        );
        if (VOICE) setCallActive(char.id, false);
        const replies = res.replies.map((r) => r.text);
        const blocks = H.responses.flatMap((r) =>
          (r.content as Array<{ type: string; text?: string; citations?: unknown[]; name?: string; input?: { query?: string } }>)
            .filter((b) => b.type === 'text' || b.type === 'server_tool_use')
            .map((b) => (b.type === 'text' ? { text: b.text, cited: Array.isArray(b.citations) && b.citations.length > 0 } : { search: b.input?.query })),
        );
        await writeFile(path.join(OUT, `chat-${q.id}-${run}.json`), JSON.stringify({ q, pushed, replies, blocks }, null, 2));
        process.stdout.write(`\n[${q.id}#${run}] pushed=${JSON.stringify(pushed)}\n  replies=${JSON.stringify(replies)}\n`);
      }
    }
  });
});




