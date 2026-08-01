/**
 * Chess service end-to-end: the REAL cce-1 engine (Maia-3 ONNX +
 * Stockfish WASM) under the real service, with only the Anthropic SDK,
 * character/config stores, and profile derivation mocked. Skipped when the
 * dev model copy (~/.sei-dev/cce/maia3-5m.onnx) is absent, so CI
 * without the 21 MB model stays green.
 *
 * The mocked "LLM" plays like the adapter instructs a real one to: it reads
 * the candidate list out of the chess system block and calls play() with the
 * first candidate's SAN.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { _setUserDataOverride } from '../paths';
import type { ChessGameState } from '../../shared/chessIpc';

const DEV_MODEL = path.join(homedir(), '.sei-dev', 'cce', 'maia3-5m.onnx');
const hasModel = existsSync(DEV_MODEL);

const { createSpy, getCharacterSpy, patchCharacterSpy } = vi.hoisted(() => ({
  createSpy: vi.fn(),
  getCharacterSpy: vi.fn(),
  patchCharacterSpy: vi.fn(),
}));
vi.mock('../chat/sdk', () => ({
  CHAT_TIMEOUT_MS: 30_000,
  buildChatSdk: vi.fn(async () => ({ client: { messages: { create: createSpy } }, model: 'test-model' })),
}));
vi.mock('../characterStore', () => ({
  getCharacter: getCharacterSpy,
  patchCharacter: patchCharacterSpy,
}));
vi.mock('../configStore', () => ({
  loadConfig: vi.fn(async () => ({ preferred_name: 'Player' })),
}));
vi.mock('./chessProfile', () => ({
  getOrCreateChessProfile: vi.fn(async () => ({ elo: 700, styleNote: 'reckless', source: 'auto' })),
}));
// modelStore is REAL: it prefers the ~/.sei-dev copy, so no download happens.
// electron.app is only touched on the download path; stub it for safety.
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/sei-e2e-userdata-unused' },
}));

import {
  initChessService,
  startChess,
  playerMove,
  ackReveal,
  endChess,
  shutdownChess,
  CHESS_TIMING,
} from './chessService';

const CHAR = '77777777-7777-4777-8777-777777777777';
let dir: string;
let pushed: ChessGameState[];

/**
 * The per-game session log (chessLog) closes asynchronously and endChess only
 * fires it off, so a write can still be in flight when the temp dir is removed
 * — an ENOTEMPTY that has nothing to do with the code under test. Retry briefly.
 */
async function rmTemp(target: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch (err) {
      if (i >= 20) throw err;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

interface PromptParams {
  system?: { text: string }[];
  messages?: unknown[];
  tools?: Array<{ name: string }>;
}

/** The whole prompt: cached system blocks PLUS the volatile messages tail. */
function promptText(params: PromptParams): string {
  const sys = (params.system ?? []).map((b) => b.text).join('\n');
  const msgs = (params.messages ?? [])
    .map((m) => {
      const content = (m as { content?: unknown }).content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        return content.map((b) => (b as { text?: string }).text ?? '').join('\n');
      }
      return '';
    })
    .join('\n');
  return `${sys}\n${msgs}`;
}

async function waitFor<T>(fn: () => T | undefined, ms = 60_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe.skipIf(!hasModel)('chess e2e with the real CCE engine', () => {
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sei-chess-e2e-'));
    _setUserDataOverride(dir);
    pushed = [];
    // Keep idle ticks out of the run (decisions present instantly since
    // 260729 — the prethink delay is gone from the service).
    CHESS_TIMING.idleMinMs = 300_000;
    CHESS_TIMING.idleMaxMs = 300_000;
    initChessService({
      pushState: (s) => pushed.push(s),
      pushDownload: () => {},
      pushChatMessage: () => {},
      isSummoned: () => false,
    });
    getCharacterSpy.mockImplementation(async () => ({
      id: CHAR,
      name: 'Sui',
      persona: { source: 'chaos gremlin', expanded: 'PERSONA' },
      metadata: {},
    }));
    patchCharacterSpy.mockImplementation(async () => ({}));
    // "LLM": grab the first numbered candidate SAN out of the chess block and
    // play it, with one line of table talk.
    createSpy.mockReset();
    createSpy.mockImplementation(
      async (params: PromptParams) => {
        const block = promptText(params);
        if (block.includes('The moves you are considering')) {
          const m = block.match(/^1\. (\S+):/m);
          if (!m) throw new Error('no candidates found in chess turn block');
          return {
            content: [
              { type: 'text', text: 'hehe watch this' },
              { type: 'tool_use', id: 'tu1', name: 'play', input: { move: m[1] } },
            ],
            usage: {},
          };
        }
        return { content: [{ type: 'text', text: 'gg' }], usage: {} };
      },
    );
  });

  afterEach(async () => {
    await endChess(CHAR);
    await shutdownChess();
    _setUserDataOverride(null);
    await rmTemp(dir);
  });

  it('plays four full plies against the real engine', { timeout: 120_000 }, async () => {
    const start = await startChess(CHAR, { playerColor: 'w' });
    expect(start.status).toBe('active');

    // Two player moves, each answered by a real CCE-candidate AI move.
    for (const uci of ['e2e4', 'd2d4']) {
      const before = pushed.length;
      const res = await playerMove(CHAR, uci);
      expect(res.ok).toBe(true);
      const pending = await waitFor(() =>
        pushed.slice(before).find((s) => s.pendingAiMove !== null),
      );
      const acked = await ackReveal(CHAR, pending.pendingAiMove!.uci);
      expect(acked.aiThinking).toBe(false);
      expect(acked.turn).toBe('w');
    }

    const final = pushed[pushed.length - 1];
    expect(final.history).toHaveLength(4);
    expect(final.status).toBe('active');
    // The turn block fed to the LLM carried real translated candidates. It
    // lives in the messages tail now, not in `system` — see the cache-ordering
    // note in chessService (anything volatile in `system` sits above every
    // message in the cache prefix and makes the whole transcript uncacheable).
    const block = promptText(createSpy.mock.calls.at(-1)?.[0] as PromptParams);
    expect(block).toMatch(/The moves you are considering/);
    expect(block).toMatch(/winning chances|cannot tell who is winning/);
  });
});
