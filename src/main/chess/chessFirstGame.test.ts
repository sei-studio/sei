/**
 * 260929 chess first-game friction (UX review item 4), service level:
 *   - a failed engine warm-up keeps the game in 'preparing' with a friendly
 *     error code and a working retry, instead of silently ending 'abandoned';
 *   - chess_game_ended carries the stage the game ended in;
 *   - an idle player at the start of their turn gets ONE in-character nudge;
 *   - a player loss lowers the next game's Elo for that character.
 * LLM, engine, model store, profile, config and analytics are mocked; the
 * board, the session queue and the timers are real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Chess } from 'chess.js';
import { _setUserDataOverride } from '../paths';
import type { ChatMessage } from '../../shared/ipc';
import type { ChessDownloadProgress, ChessGameState } from '../../shared/chessIpc';

const { createSpy, getCharacterSpy, captureSpy, surfaceErrSpy, ensureModelSpy, cfg } = vi.hoisted(() => ({
  createSpy: vi.fn(),
  getCharacterSpy: vi.fn(),
  captureSpy: vi.fn(),
  surfaceErrSpy: vi.fn(),
  ensureModelSpy: vi.fn(),
  cfg: { current: { preferred_name: 'Player' } as Record<string, unknown> },
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
  loadConfig: vi.fn(async () => cfg.current),
  updateConfig: vi.fn(async (mutate: (c: Record<string, unknown>) => Record<string, unknown>) => {
    cfg.current = mutate(cfg.current);
    return cfg.current;
  }),
}));
vi.mock('./modelStore', () => ({
  ensureModel: ensureModelSpy,
  modelReady: vi.fn(async () => false),
}));
vi.mock('./chessProfile', () => ({
  getOrCreateChessProfile: vi.fn(async () => ({ elo: 900, styleNote: '', source: 'auto' })),
}));
vi.mock('../analytics', () => ({
  capture: captureSpy,
  captureSurfaceError: surfaceErrSpy,
  surfaceErrorClass: () => 'other',
}));
vi.mock('cce-1', () => ({
  CharacterChessEngine: {
    create: vi.fn(async () => ({
      candidateSet: vi.fn(async (fen: string) => {
        const legal = new Chess(fen).moves({ verbose: true }).slice(0, 4);
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
  ackReveal,
  resign,
  endChess,
  shutdownChess,
  CHESS_TIMING,
} from './chessService';

const CHAR = '88888888-8888-4888-8888-888888888888';
let dir: string;
let pushed: ChessGameState[];
let downloads: ChessDownloadProgress[];
let chatPushed: ChatMessage[];

function promptText(params: { system?: { text: string }[]; messages?: unknown[] }): string {
  const sys = (params.system ?? []).map((b) => b.text).join('\n');
  const msgs = (params.messages ?? [])
    .map((m) => {
      const content = (m as { content?: unknown }).content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) return content.map((b) => (b as { text?: string }).text ?? '').join('\n');
      return '';
    })
    .join('\n');
  return `${sys}\n${msgs}`;
}

async function waitFor<T>(fn: () => T | undefined | null | false, ms = 4000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== null && v !== false) return v as T;
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const endedEvents = (): Record<string, unknown>[] =>
  captureSpy.mock.calls.filter((c) => c[0] === 'chess_game_ended').map((c) => c[1] as Record<string, unknown>);

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'sei-chess-first-'));
  _setUserDataOverride(dir);
  pushed = [];
  downloads = [];
  chatPushed = [];
  cfg.current = { preferred_name: 'Player' };
  initChessService({
    pushState: (s) => pushed.push(s),
    pushDownload: (p) => downloads.push(p),
    pushChatMessage: (_id, msg) => chatPushed.push(msg),
    isSummoned: () => false,
  });
  getCharacterSpy.mockImplementation(async () => ({
    id: CHAR,
    name: 'Marv',
    persona: { source: 'grumpy robot', expanded: 'PERSONA' },
    metadata: {},
  }));
  ensureModelSpy.mockReset();
  ensureModelSpy.mockImplementation(async () => '/fake/model.onnx');
  createSpy.mockReset();
  createSpy.mockResolvedValue({ content: [], usage: {} });
  captureSpy.mockReset();
  surfaceErrSpy.mockReset();
  CHESS_TIMING.idleMinMs = 120_000;
  CHESS_TIMING.idleMaxMs = 120_000;
  CHESS_TIMING.nudgeFirstMoveMs = 120_000;
  CHESS_TIMING.nudgeMoveMs = 120_000;
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

describe('failed model download (260929)', () => {
  it('stays in preparing with a friendly code, retries on Try again, and reports the stage on close', async () => {
    ensureModelSpy.mockImplementationOnce(async () => {
      throw Object.assign(new Error('download stalled after 30000ms'), { kind: 'timeout' });
    });
    const start = await startChess(CHAR, { playerColor: 'w' });
    expect(start.status).toBe('preparing');

    const failed = await waitFor(() => downloads.find((d) => d.pct === -1));
    expect(failed.error).toBe('download_failed'); // a code, never the raw message
    // Not ended: the panel keeps the launch layout with the error + retry.
    expect(pushed[pushed.length - 1].status).toBe('preparing');
    await waitFor(() => surfaceErrSpy.mock.calls.length > 0);
    expect(surfaceErrSpy).toHaveBeenCalledWith('chess', 'model_download_timeout', CHAR);
    expect(endedEvents()).toHaveLength(0);

    // Try again: chessStart on the same game re-runs the warm-up.
    await startChess(CHAR, { playerColor: 'w' });
    await waitFor(() => pushed.find((s) => s.status === 'active'));
    expect(downloads.some((d, i) => i > downloads.indexOf(failed) && d.pct === 0)).toBe(true);
    expect(ensureModelSpy).toHaveBeenCalledTimes(3); // warm-up, retry, getEngine
  });

  it('closing after a failure is download_failed, not a plain player quit', async () => {
    ensureModelSpy.mockImplementation(async () => {
      throw Object.assign(new Error('HTTP 503'), { kind: 'http' });
    });
    await startChess(CHAR, { playerColor: 'w' });
    await waitFor(() => downloads.find((d) => d.pct === -1));
    await endChess(CHAR);
    const ev = await waitFor(() => endedEvents()[0]);
    expect(ev.reason).toBe('abandoned');
    expect(ev.stage).toBe('download_failed');
  });

  it('closing while it still downloads is stage downloading', async () => {
    ensureModelSpy.mockImplementation(() => new Promise(() => {}));
    await startChess(CHAR, { playerColor: 'w' });
    await endChess(CHAR);
    const ev = await waitFor(() => endedEvents()[0]);
    expect(ev.stage).toBe('downloading');
  });

  it('closing before the first move is waiting_first_move, after it midgame', async () => {
    await startChess(CHAR, { playerColor: 'w' });
    await waitFor(() => pushed.find((s) => s.status === 'active'));
    await endChess(CHAR);
    expect((await waitFor(() => endedEvents()[0])).stage).toBe('waiting_first_move');

    captureSpy.mockReset();
    await startChess(CHAR, { playerColor: 'w' });
    await waitFor(() => pushed.filter((s) => s.status === 'active').length >= 2);
    await playerMove(CHAR, 'e2e4');
    await endChess(CHAR);
    const ev = await waitFor(() => endedEvents()[0]);
    expect(ev.stage).toBe('midgame');
    expect(ev.player_moves).toBe(1);
  });
});

describe('"your move" nudge (260929)', () => {
  it('nudges once, in character, when the player sits idle on the first move', async () => {
    CHESS_TIMING.nudgeFirstMoveMs = 60;
    let nudgeTurns = 0;
    let lastPrompt = '';
    createSpy.mockImplementation(async (params: { system?: { text: string }[]; messages?: unknown[] }) => {
      const text = promptText(params);
      if (text.includes("It is Player's move")) {
        nudgeTurns++;
        lastPrompt = text;
        return { content: [{ type: 'text', text: 'your move, white goes first' }], usage: {} };
      }
      return { content: [], usage: {} };
    });

    await startChess(CHAR, { playerColor: 'w' });
    await waitFor(() => nudgeTurns >= 1);
    // Well past several more thresholds: still exactly one nudge this turn.
    await new Promise((r) => setTimeout(r, 300));
    expect(nudgeTurns).toBe(1);
    expect(lastPrompt).toContain('so they move first');
    expect(chatPushed.filter((m) => m.role === 'companion').map((m) => m.text)).toEqual([
      'your move, white goes first',
    ]);
    await endChess(CHAR);
    expect((await waitFor(() => endedEvents()[0])).nudges).toBe(1);
  });

  it('a move before the threshold cancels the nudge', async () => {
    CHESS_TIMING.nudgeFirstMoveMs = 150;
    let nudgeTurns = 0;
    createSpy.mockImplementation(async (params: { tools?: { name: string }[]; system?: { text: string }[]; messages?: unknown[] }) => {
      if (promptText(params).includes("It is Player's move")) nudgeTurns++;
      return { content: [], usage: {} };
    });
    await startChess(CHAR, { playerColor: 'w' });
    await waitFor(() => pushed.find((s) => s.status === 'active'));
    await playerMove(CHAR, 'e2e4');
    await new Promise((r) => setTimeout(r, 300));
    expect(nudgeTurns).toBe(0);
  });
});

describe('adaptive strength (260929)', () => {
  it('a player loss lowers the next game by a step; a win raises it by less', async () => {
    createSpy.mockImplementation(async (params: { tools?: { name: string }[] }) => {
      if (params.tools?.some((t) => t.name === 'play')) {
        return { content: [{ type: 'tool_use', id: 'tu1', name: 'play', input: { move: 'e5' } }], usage: {} };
      }
      return { content: [], usage: {} };
    });

    const g1 = await startChess(CHAR, { playerColor: 'w' });
    expect(g1.aiElo).toBe(900);
    await waitFor(() => pushed.find((s) => s.status === 'active'));
    await playerMove(CHAR, 'e2e4');
    const pending = await waitFor(() => pushed.find((s) => s.pendingAiMove?.san === 'e5'));
    await ackReveal(CHAR, pending.pendingAiMove!.uci);
    await resign(CHAR); // a player loss
    await waitFor(() => (cfg.current.chess_elo_offsets as Record<string, number> | undefined)?.[CHAR] === -100);
    await endChess(CHAR);

    const g2 = await startChess(CHAR, { playerColor: 'w' });
    expect(g2.aiElo).toBe(800);
    const started = captureSpy.mock.calls.filter((c) => c[0] === 'chess_game_started').pop()![1];
    expect(started).toMatchObject({ ai_elo: 800, ai_elo_base: 900, elo_offset: -100 });
  });

  it('an abandoned game leaves the strength alone', async () => {
    await startChess(CHAR, { playerColor: 'w' });
    await waitFor(() => pushed.find((s) => s.status === 'active'));
    await endChess(CHAR);
    await new Promise((r) => setTimeout(r, 50));
    expect(cfg.current.chess_elo_offsets).toBeUndefined();
  });
});
