/**
 * Chess on the credit wall (260926): a 402 on the cloud allowance must not
 * end or stall the game. The engine plays every AI move from then on (the top
 * sampled candidate), no further LLM turn runs (no 402 and no popup per move),
 * ONE system notice explains the quiet with the reset date, and
 * `credit_wall_degraded` fires once. A later snapshot that shows the wall
 * gone brings the character back.
 *
 * Same harness as chessService.test.ts: LLM, engine, model store and profile
 * mocked; the board, FSM queue and hold are real. The usage-limit popup and
 * analytics are mocked so the test can count them.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Chess } from 'chess.js';
import { _setUserDataOverride } from '../paths';
import type { ChatMessage } from '../../shared/ipc';
import type { ChessGameState } from '../../shared/chessIpc';

const { createSpy, getCharacterSpy, patchCharacterSpy, popupSpy, captureSpy } = vi.hoisted(() => ({
  createSpy: vi.fn(),
  getCharacterSpy: vi.fn(),
  patchCharacterSpy: vi.fn(),
  popupSpy: vi.fn(),
  captureSpy: vi.fn(),
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
vi.mock('./modelStore', () => ({
  ensureModel: vi.fn(async () => '/fake/model.onnx'),
  modelReady: vi.fn(async () => true),
}));
vi.mock('./chessProfile', () => ({
  getOrCreateChessProfile: vi.fn(async () => ({ elo: 900, styleNote: 'testy', source: 'auto' })),
}));
vi.mock('../chat/usageLimit', () => ({
  raiseUsageLimitPopup: popupSpy,
  classifyUsageLimit: (err: { status?: number }) =>
    err?.status === 402 ? 'depleted' : err?.status === 429 ? 'rate_limited' : null,
}));
vi.mock('../analytics', () => ({
  capture: captureSpy,
  captureSurfaceError: vi.fn(),
  surfaceErrorClass: () => 'payment_required',
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
  ackReveal,
  handlePlayerChat,
  endChess,
  resign,
  rematch,
  creditWallLifted,
  shutdownChess,
  CHESS_TIMING,
  type ChessCreditsSnapshot,
} from './chessService';

const CHAR = '77777777-7777-4777-8777-777777777777';
let dir: string;
let pushed: ChessGameState[];
let chatPushed: ChatMessage[];
let snapshot: ChessCreditsSnapshot | null;
/** > 0 makes the credits read hang that long (the hung-network case). */
let snapshotDelayMs = 0;

function paymentRequired(): Error {
  const e = new Error('402 {"type":"error","error":{"type":"payment_required"}}') as Error & { status: number };
  e.status = 402;
  return e;
}

async function waitFor<T>(fn: () => T | undefined, ms = 4000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Wait for the AI's pending move after `after` pushes, then ack it. */
async function ackNextAiMove(after: number): Promise<ChessGameState> {
  const pending = await waitFor(() => pushed.slice(after).find((s) => s.pendingAiMove !== null));
  return ackReveal(CHAR, pending.pendingAiMove!.uci);
}

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

const quietNotices = (): ChatMessage[] =>
  chatPushed.filter((m) => m.role === 'system' && /keep playing quietly/.test(m.text));
const degradedEvents = (): unknown[][] => captureSpy.mock.calls.filter((c) => c[0] === 'credit_wall_degraded');

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'sei-chess-wall-'));
  _setUserDataOverride(dir);
  pushed = [];
  chatPushed = [];
  // Wednesday, a few days out: the notice must carry a dated reset line.
  snapshot = {
    plan: 'free',
    over_limit: true,
    usage_pct: 100,
    extra_credits_total: 0,
    resets_at: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    ai_backend_kind: 'cloud-proxy',
  };
  snapshotDelayMs = 0;
  initChessService({
    pushState: (s) => pushed.push(s),
    pushDownload: () => {},
    pushChatMessage: (_id, msg) => chatPushed.push(msg),
    isSummoned: () => false,
    creditsSnapshot: async () => {
      if (snapshotDelayMs > 0) await new Promise((r) => setTimeout(r, snapshotDelayMs));
      return snapshot;
    },
  });
  getCharacterSpy.mockImplementation(async () => ({
    id: CHAR,
    name: 'Marv',
    persona: { source: 'grumpy robot', expanded: 'PERSONA' },
    metadata: {},
  }));
  patchCharacterSpy.mockImplementation(async () => ({}));
  createSpy.mockReset();
  popupSpy.mockReset();
  captureSpy.mockReset();
  // Every LLM call hits the wall.
  createSpy.mockRejectedValue(paymentRequired());
  popupSpy.mockImplementation(async (err: { status?: number }) => (err?.status === 402 ? 'depleted' : null));
  CHESS_TIMING.idleMinMs = 120_000;
  CHESS_TIMING.idleMaxMs = 120_000;
  CHESS_TIMING.capMs = 45_000;
  CHESS_TIMING.capReplyCycles = 4;
  CHESS_TIMING.creditProbeMs = 60_000;
  CHESS_TIMING.creditReadTimeoutMs = 4_000;
});

afterEach(async () => {
  await endChess(CHAR);
  await shutdownChess();
  _setUserDataOverride(null);
  await rmTemp(dir);
});

describe('chess on the credit wall', () => {
  it('keeps playing on engine moves with one notice, one popup and one analytics event', async () => {
    await startChess(CHAR, { playerColor: 'w' });

    // Move 1: the LLM turn 402s, the engine plays instead.
    await playerMove(CHAR, 'e2e4');
    let state = await ackNextAiMove(0);
    expect(state.status).toBe('active');
    expect(state.history).toHaveLength(2);
    const llmCallsAfterWall = createSpy.mock.calls.length;
    expect(llmCallsAfterWall).toBe(1);

    // Moves 2 and 3: no LLM call at all, the engine keeps moving.
    let mark = pushed.length;
    await playerMove(CHAR, 'd2d4');
    state = await ackNextAiMove(mark);
    mark = pushed.length;
    await playerMove(CHAR, 'g1f3');
    state = await ackNextAiMove(mark);
    expect(state.status).toBe('active');
    expect(state.history).toHaveLength(6);
    expect(createSpy.mock.calls.length).toBe(llmCallsAfterWall);

    // Chat gets no reply and costs no call while quiet.
    const res = await handlePlayerChat({ characterId: CHAR, text: 'you there?' });
    expect(res?.replies ?? []).toEqual([]);
    expect(createSpy.mock.calls.length).toBe(llmCallsAfterWall);

    // Exactly one popup, one notice (dated), one analytics event.
    expect(popupSpy).toHaveBeenCalledTimes(1);
    const notices = await waitFor(() => (quietNotices().length ? quietNotices() : undefined));
    expect(notices).toHaveLength(1);
    expect(notices[0].text).toContain('Marv');
    expect(notices[0].text).toMatch(/Free play resets in 3 days \(\w+, \w+ \d+\)\./);
    expect(notices[0].text).not.toContain('—');
    await waitFor(() => (degradedEvents().length ? true : undefined));
    expect(degradedEvents()).toHaveLength(1);
    expect(degradedEvents()[0][1]).toMatchObject({ surface: 'chess', character_id: CHAR, mode: 'engine_only' });
  });

  it('the notice degrades to no date when the reset time is unknown', async () => {
    snapshot = null;
    await startChess(CHAR, { playerColor: 'w' });
    await playerMove(CHAR, 'e2e4');
    await ackNextAiMove(0);
    const notices = await waitFor(() => (quietNotices().length ? quietNotices() : undefined));
    expect(notices[0].text).not.toMatch(/resets/);
    expect(notices[0].text).toContain('Top up or upgrade');
  });

  it('a snapshot showing the wall gone brings the character back', async () => {
    CHESS_TIMING.creditProbeMs = 0;
    await startChess(CHAR, { playerColor: 'w' });
    await playerMove(CHAR, 'e2e4');
    await ackNextAiMove(0);
    expect(createSpy).toHaveBeenCalledTimes(1);

    // Topped up (more extra credits than at the wall): the next move turn
    // talks again.
    snapshot = { ...snapshot!, over_limit: false, extra_credits_total: 500 };
    createSpy.mockReset();
    createSpy.mockImplementation(async (params: { tools?: { name: string }[] }) => {
      if (params.tools?.some((t) => t.name === 'play')) {
        return {
          content: [
            { type: 'text', text: 'back in business' },
            { type: 'tool_use', id: 'tu1', name: 'play', input: { move: 'h6' } },
          ],
          usage: {},
        };
      }
      return { content: [{ type: 'text', text: 'gg' }], usage: {} };
    });
    const mark = pushed.length;
    await playerMove(CHAR, 'g1f3');
    const pending = await waitFor(() => pushed.slice(mark).find((s) => s.pendingAiMove !== null));
    expect(pending.pendingAiMove!.san).toBe('h6');
    expect(createSpy).toHaveBeenCalled();
  });

  it('a non-credit failure still falls back without going quiet', async () => {
    popupSpy.mockImplementation(async () => null);
    createSpy.mockRejectedValue(new Error('500 server error'));
    await startChess(CHAR, { playerColor: 'w' });
    await playerMove(CHAR, 'e2e4');
    await ackNextAiMove(0);
    const calls = createSpy.mock.calls.length;
    const mark = pushed.length;
    await playerMove(CHAR, 'd2d4');
    await ackNextAiMove(mark);
    // The next turn tried the LLM again.
    expect(createSpy.mock.calls.length).toBeGreaterThan(calls);
    expect(quietNotices()).toHaveLength(0);
    expect(degradedEvents()).toHaveLength(0);
  });

  it('over_limit:false alone does not lift the quiet (a few extra credits left still 402)', async () => {
    CHESS_TIMING.creditProbeMs = 0;
    await startChess(CHAR, { playerColor: 'w' });
    await playerMove(CHAR, 'e2e4');
    await ackNextAiMove(0);
    expect(createSpy).toHaveBeenCalledTimes(1);
    // my_plan says not over the limit, but nothing actually changed.
    snapshot = { ...snapshot!, over_limit: false };
    const mark = pushed.length;
    await playerMove(CHAR, 'd2d4');
    await ackNextAiMove(mark);
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it('a lift that proves premature goes quiet again with no second popup, notice or event', async () => {
    CHESS_TIMING.creditProbeMs = 0;
    await startChess(CHAR, { playerColor: 'w' });
    await playerMove(CHAR, 'e2e4');
    await ackNextAiMove(0);
    expect(popupSpy).toHaveBeenCalledTimes(1);
    // Wait for the background baseline read before the top up lands.
    await new Promise((r) => setTimeout(r, 20));
    // Topped up a little: the snapshot changed, so quiet lifts, but the
    // proxy's worst-case reservation still 402s the turn.
    snapshot = { ...snapshot!, over_limit: false, extra_credits_total: 3 };
    let mark = pushed.length;
    await playerMove(CHAR, 'd2d4');
    await ackNextAiMove(mark);
    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(popupSpy).toHaveBeenCalledTimes(1);
    // Quiet again: the next move costs no call.
    mark = pushed.length;
    await playerMove(CHAR, 'g1f3');
    await ackNextAiMove(mark);
    expect(createSpy).toHaveBeenCalledTimes(2);
    await waitFor(() => (quietNotices().length ? true : undefined));
    await new Promise((r) => setTimeout(r, 20));
    expect(quietNotices()).toHaveLength(1);
    expect(degradedEvents()).toHaveLength(1);
  });

  it('a hung credits read does not stall the move (times out as unknown, stays quiet)', async () => {
    CHESS_TIMING.creditProbeMs = 0;
    CHESS_TIMING.creditReadTimeoutMs = 50;
    await startChess(CHAR, { playerColor: 'w' });
    await playerMove(CHAR, 'e2e4');
    await ackNextAiMove(0);
    snapshotDelayMs = 60_000;
    const t0 = Date.now();
    const mark = pushed.length;
    await playerMove(CHAR, 'd2d4');
    await ackNextAiMove(mark);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it('a rematch on the wall starts quiet: no second popup, notice or event', async () => {
    await startChess(CHAR, { playerColor: 'w' });
    await playerMove(CHAR, 'e2e4');
    await ackNextAiMove(0);
    await waitFor(() => (degradedEvents().length ? true : undefined));
    await resign(CHAR);
    const mark = pushed.length;
    // The player takes black, so the engine opens for the character at once.
    const next = await rematch(CHAR);
    expect(next.playerColor).toBe('b');
    await waitFor(() => pushed.slice(mark).find((st) => st.pendingAiMove !== null));
    await new Promise((r) => setTimeout(r, 20));
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(popupSpy).toHaveBeenCalledTimes(1);
    expect(quietNotices()).toHaveLength(1);
    expect(degradedEvents()).toHaveLength(1);
  });
});

describe('creditWallLifted', () => {
  const wall: ChessCreditsSnapshot = {
    plan: 'free',
    over_limit: true,
    usage_pct: 100,
    extra_credits_total: 3,
    resets_at: '2026-09-30T00:00:00.000Z',
    ai_backend_kind: 'cloud-proxy',
  };
  it('does not lift on over_limit:false alone', () => {
    expect(creditWallLifted(wall, { ...wall, over_limit: false })).toBe(false);
  });
  it('lifts on a real change', () => {
    expect(creditWallLifted(wall, { ...wall, extra_credits_total: 1000 })).toBe(true);
    expect(creditWallLifted(wall, { ...wall, resets_at: '2026-10-07T00:00:00.000Z' })).toBe(true);
    expect(creditWallLifted(wall, { ...wall, usage_pct: 0 })).toBe(true);
    expect(creditWallLifted(wall, { ...wall, plan: 'quest' })).toBe(true);
    expect(creditWallLifted(wall, { ...wall, ai_backend_kind: 'local' })).toBe(true);
  });
  it('unknown stays quiet; with no baseline only unambiguous signals count', () => {
    expect(creditWallLifted(wall, null)).toBe(false);
    expect(creditWallLifted(null, { ...wall, over_limit: false, extra_credits_total: 1000 })).toBe(false);
    expect(creditWallLifted(null, { ...wall, usage_pct: 10 })).toBe(true);
  });
});
