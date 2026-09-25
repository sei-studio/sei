/**
 * Draw! on the credit wall (260926). A depleted allowance pauses the game
 * with pausedReason 'depleted' (the renderer's card then shows the free-play
 * reset date and an "End game" button), fires `credit_wall_degraded` once,
 * and draw:finish ends the game into the gallery with the interrupted drawing
 * kept, recorded as reason 'credit_wall' rather than 'abandoned'.
 *
 * Same module seams as drawService.visionGate.test.ts. The guess turn is real
 * up to the model call: the snapshot round-trip is answered by the test, and
 * the call itself fails (no character in the mocked store), which the mocked
 * usage-limit classifier reports as the depleted wall.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { popupSpy, captureSpy } = vi.hoisted(() => ({ popupSpy: vi.fn(), captureSpy: vi.fn() }));

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/sei-test', isPackaged: true },
}));
vi.mock('../chat/usageLimit', () => ({ raiseUsageLimitPopup: popupSpy }));
vi.mock('../voice/callState', () => ({ isCallActive: () => false }));
vi.mock('../configStore', () => ({ loadConfig: vi.fn(async () => ({})) }));
vi.mock('../characterStore', () => ({ getCharacter: vi.fn(async () => null) }));
vi.mock('../chat/sdk', () => ({ CHAT_TIMEOUT_MS: 20_000 }));
vi.mock('../chat/chatPrompts', () => ({
  buildSystemBlocks: vi.fn(() => []),
  clockNow: () => 'clock',
  REMEMBER_TOOL: { name: 'remember' },
}));
vi.mock('../chat/continuity', () => ({
  readChatContext: vi.fn(async () => ({ summary: '', history: [] })),
  foldIfDue: vi.fn(async () => {}),
}));
vi.mock('../chat/playSummary', () => ({ playSummaryText: vi.fn(() => 'played') }));
vi.mock('../knowledge/knowledgeStore', () => ({ readKnowledgeForPrompt: vi.fn(async () => '') }));
vi.mock('../chat/chatService', () => ({ splitReply: (text: string) => [text] }));
vi.mock('../chat/chatStore', () => ({ appendMessage: vi.fn(async () => {}) }));
vi.mock('../../bot/brain/memory/memoryLog.js', () => ({
  appendMemory: vi.fn(async () => 0),
  humanizeMemoryStamps: (s: string) => s,
}));
vi.mock('../analytics', () => ({
  capture: captureSpy,
  captureSurfaceError: vi.fn(),
  surfaceErrorClass: () => 'payment_required',
}));
vi.mock('../llm', () => ({
  activeLlmVision: vi.fn(async () => 'yes'),
  buildLlmProvider: vi.fn(async () => {
    throw new Error('no provider in this test');
  }),
}));

import {
  initDrawService,
  startDraw,
  pickDrawWord,
  playerStroke,
  resumeDraw,
  finishDrawEarly,
  receiveSnapshot,
  endDraw,
  __test,
} from './drawService';
import type { DrawGameState } from '../../shared/drawIpc';

const CHAR = 'char-wall';
let pushed: DrawGameState[];
let snapSeq = 0;

async function waitFor<T>(fn: () => T | undefined, ms = 3000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const events = (name: string): unknown[][] => captureSpy.mock.calls.filter((c) => c[0] === name);

/** Start a game and get to the player's live drawing turn with one stroke down. */
async function toLiveTurn(): Promise<void> {
  const start = await startDraw(CHAR, 3);
  pickDrawWord(CHAR, start.wordChoices[0]);
  playerStroke(CHAR, {
    id: 's1',
    points: [
      { x: 10, y: 10 },
      { x: 50, y: 50 },
    ],
  });
}

/** One guess dispatch whose model call hits the wall. */
async function hitWall(): Promise<void> {
  const s = __test.sessions.get(CHAR)!;
  await __test.dispatchGuess(s as Parameters<typeof __test.dispatchGuess>[0]);
}

beforeEach(() => {
  pushed = [];
  popupSpy.mockReset();
  captureSpy.mockReset();
  popupSpy.mockResolvedValue('depleted');
  initDrawService({
    pushState: (st: DrawGameState) => pushed.push(st),
    pushAiStroke: vi.fn(),
    pushSnapshotRequest: ({ requestId }: { requestId: string }) => {
      // Answer the canvas snapshot like the renderer would.
      // A fresh picture each time, so the unchanged-canvas skip never fires.
      snapSeq += 1;
      queueMicrotask(() => receiveSnapshot(requestId, `data:image/png;base64,AAAA${snapSeq}`));
    },
    pushChatMessage: vi.fn(),
    isSummoned: () => false,
  });
});

afterEach(async () => {
  await endDraw(CHAR);
  __test.sessions.clear();
});

describe('Draw! on the credit wall', () => {
  it('pauses with the depleted reason and reports the degrade once', async () => {
    await toLiveTurn();
    await hitWall();

    const last = pushed[pushed.length - 1];
    expect(last.paused).toBe(true);
    expect(last.pausedReason).toBe('depleted');
    expect(popupSpy).toHaveBeenCalledTimes(1);

    const degraded = await waitFor(() => (events('credit_wall_degraded').length ? events('credit_wall_degraded') : undefined));
    expect(degraded).toHaveLength(1);
    expect(degraded[0][1]).toMatchObject({ surface: 'draw', character_id: CHAR, mode: 'paused' });

    // A hopeful Resume that hits the wall again pauses again, but the event
    // stays at one per game.
    resumeDraw(CHAR);
    expect(pushed[pushed.length - 1].paused).toBeUndefined();
    await hitWall();
    expect(pushed[pushed.length - 1].pausedReason).toBe('depleted');
    await new Promise((r) => setTimeout(r, 20));
    expect(events('credit_wall_degraded')).toHaveLength(1);
  });

  it('a rate limit pauses without the credit-wall reason or event', async () => {
    popupSpy.mockResolvedValue('rate_limited');
    await toLiveTurn();
    await hitWall();
    const last = pushed[pushed.length - 1];
    expect(last.paused).toBe(true);
    expect(last.pausedReason).toBe('rate_limited');
    await new Promise((r) => setTimeout(r, 20));
    expect(events('credit_wall_degraded')).toHaveLength(0);
  });

  it('End game goes to the gallery with the interrupted drawing kept', async () => {
    await toLiveTurn();
    await hitWall();

    const state = finishDrawEarly(CHAR)!;
    expect(state.phase).toBe('gallery');
    expect(state.paused).toBeUndefined();
    expect(state.gallery).toHaveLength(1);
    expect(state.gallery[0]).toMatchObject({ round: 1, drawer: 'player', guessed: false });
    expect(state.gallery[0].strokes).toHaveLength(1);

    const ended = await waitFor(() => (events('draw_game_ended').length ? events('draw_game_ended') : undefined));
    expect(ended[0][1]).toMatchObject({ reason: 'credit_wall', turns_played: 1 });

    // Closing the gallery afterwards must not record the game a second time.
    await endDraw(CHAR);
    await new Promise((r) => setTimeout(r, 20));
    expect(events('draw_game_ended')).toHaveLength(1);
  });
});
