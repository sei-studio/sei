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
    // Present decisions instantly; keep idle ticks out of the run.
    CHESS_TIMING.prethinkFloorMs = 0;
    CHESS_TIMING.prethinkCapMs = 0;
    CHESS_TIMING.obviousExtraMs = 0;
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
      async (params: { tools?: { name: string }[]; system?: { text: string }[] }) => {
        if (params.tools?.some((t) => t.name === 'play')) {
          const block = (params.system ?? []).map((b) => b.text).join('\n');
          const m = block.match(/^1\. (\S+):/m);
          if (!m) throw new Error('no candidates found in chess block');
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
    await rm(dir, { recursive: true, force: true });
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
    // The chess block fed to the LLM carried real translated candidates.
    const block = (createSpy.mock.calls.at(-1)?.[0].system as { text: string }[])
      .map((b) => b.text)
      .join('\n');
    expect(block).toMatch(/The moves you are considering/);
    expect(block).toMatch(/winning chances|cannot tell who is winning/);
  });
});
