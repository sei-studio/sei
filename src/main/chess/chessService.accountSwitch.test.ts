/**
 * Chess on an account switch (260926). endAllChess ends every game through
 * endSession, the same choke point as every other exit: chess_game_ended
 * carries duration_ms and reason 'account_switch' (the game's own result stays
 * 'abandoned'), the play row is registered with the scope write barrier so the
 * switch can wait for it, the end is silent (no reaction turn under the
 * incoming account's JWT), and the session is dropped so a late renderer
 * chess:end is a no-op. Harness from chessCreditWall.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Chess } from 'chess.js';
import { _setUserDataOverride, paths } from '../paths';

const { createSpy, getCharacterSpy, captureSpy } = vi.hoisted(() => ({
  createSpy: vi.fn(),
  getCharacterSpy: vi.fn(),
  captureSpy: vi.fn(),
}));
vi.mock('../chat/sdk', () => ({
  CHAT_TIMEOUT_MS: 30_000,
  buildChatSdk: vi.fn(async () => ({ client: { messages: { create: createSpy } }, model: 'test-model' })),
}));
vi.mock('../characterStore', () => ({
  getCharacter: getCharacterSpy,
  patchCharacter: vi.fn(async () => ({})),
}));
vi.mock('../configStore', () => ({
  loadConfig: vi.fn(async () => ({ preferred_name: 'Player' })),
}));
vi.mock('./modelStore', () => ({
  ensureModel: vi.fn(async () => '/fake/model.onnx'),
  modelReady: vi.fn(async () => true),
}));
vi.mock('./chessProfile', () => ({
  getOrCreateChessProfile: vi.fn(async () => ({ elo: 900, styleNote: 'testy', source: 'auto' })),
}));
vi.mock('../analytics', () => ({
  capture: captureSpy,
  captureSurfaceError: vi.fn(),
  surfaceErrorClass: () => 'unknown',
}));
vi.mock('cce-1', () => ({
  CharacterChessEngine: {
    create: vi.fn(async () => ({
      candidateSet: vi.fn(async (fen: string) => {
        const chess = new Chess(fen);
        const legal = chess.moves({ verbose: true }).slice(0, 4);
        return {
          macro: { text: 'Material is even.' },
          candidates: legal.map((m) => ({
            uci: m.from + m.to + (m.promotion ?? ''),
            san: m.san,
            sentence: `You move ${m.san}.`,
            tags: [],
            line: null,
          })),
        };
      }),
      dispose: vi.fn(),
    })),
  },
}));

import {
  initChessService,
  startChess,
  playerMove,
  endChess,
  endAllChess,
  getChessState,
  shutdownChess,
  CHESS_TIMING,
} from './chessService';
import { drainScopedWrites, pendingScopedWrites, _resetScopeBarrierForTests } from '../profile/scopeBarrier';

const CHAR = '66666666-6666-4666-8666-666666666666';
let dir: string;

const events = (name: string): unknown[][] => captureSpy.mock.calls.filter((c) => c[0] === name);

async function waitFor<T>(fn: () => T | undefined, ms = 4000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function transcriptRows(): Promise<Array<{ role: string; event?: { kind: string; game?: string } }>> {
  try {
    const raw = await readFile(path.join(paths.memoryDir(CHAR), 'chat.jsonl'), 'utf8');
    return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'sei-chess-switch-'));
  _setUserDataOverride(dir);
  _resetScopeBarrierForTests();
  initChessService({
    pushState: () => {},
    pushDownload: () => {},
    pushChatMessage: () => {},
    isSummoned: () => false,
    creditsSnapshot: async () => null,
  });
  getCharacterSpy.mockImplementation(async () => ({
    id: CHAR,
    name: 'Marv',
    persona: { source: 'grumpy robot', expanded: 'PERSONA' },
    metadata: {},
  }));
  captureSpy.mockReset();
  createSpy.mockReset();
  // The move turn never answers until it is aborted: the switch lands
  // mid-turn, the common case.
  createSpy.mockImplementation(
    (_params: unknown, opts?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }),
  );
  CHESS_TIMING.idleMinMs = 120_000;
  CHESS_TIMING.idleMaxMs = 120_000;
});

afterEach(async () => {
  await endChess(CHAR);
  await shutdownChess();
  _setUserDataOverride(null);
  for (let i = 0; ; i++) {
    try {
      await rm(dir, { recursive: true, force: true });
      break;
    } catch (err) {
      if (i >= 20) throw err;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
});

describe('chess on an account switch', () => {
  it('ends the live game with reason account_switch, silently, and tracks the play row', async () => {
    await startChess(CHAR, { playerColor: 'w' });
    await playerMove(CHAR, 'e2e4');
    await waitFor(() => (createSpy.mock.calls.length > 0 ? true : undefined));
    const callsBefore = createSpy.mock.calls.length;

    endAllChess('account_switch');
    // Dropped at once: a late chess:end from the renderer finds nothing.
    expect(getChessState(CHAR)).toBeNull();
    expect(pendingScopedWrites()).toBeGreaterThan(0);
    expect(await drainScopedWrites(4000)).toBe(true);

    // The play row landed (in the scope that was active, i.e. before any switch).
    const rows = await transcriptRows();
    expect(rows.filter((r) => r.event?.kind === 'play')).toHaveLength(1);

    const ended = await waitFor(() => (events('chess_game_ended').length ? events('chess_game_ended') : undefined));
    expect(ended).toHaveLength(1);
    expect(ended[0][1]).toMatchObject({ character_id: CHAR, reason: 'account_switch' });
    expect(typeof (ended[0][1] as { duration_ms: unknown }).duration_ms).toBe('number');

    // Silent: no reaction turn ran after the end.
    await new Promise((r) => setTimeout(r, 50));
    expect(createSpy.mock.calls.length).toBe(callsBefore);

    await endChess(CHAR);
    await new Promise((r) => setTimeout(r, 20));
    expect(events('chess_game_ended')).toHaveLength(1);
  });

  it('with no game open it does nothing', () => {
    endAllChess('account_switch');
    expect(pendingScopedWrites()).toBe(0);
    expect(events('chess_game_ended')).toHaveLength(0);
  });
});
