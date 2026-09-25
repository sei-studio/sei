/**
 * Draw! on an account switch (260926). endAllDraw ends every game through the
 * same choke point as a player closing it (finishGame): draw_game_ended with
 * duration_ms and reason 'account_switch', the play row, and the session is
 * dropped so nothing in flight can act on it. The row write is registered with
 * the scope write barrier, so the switch can wait for it before it re-points
 * the profile scope, and endAllDraw itself resolves only once it has landed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { captureSpy, appendSpy } = vi.hoisted(() => ({ captureSpy: vi.fn(), appendSpy: vi.fn() }));

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/sei-test', isPackaged: true },
}));
vi.mock('../chat/usageLimit', () => ({ raiseUsageLimitPopup: vi.fn(async () => null) }));
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
vi.mock('../chat/chatStore', () => ({ appendMessage: appendSpy }));
vi.mock('../../bot/brain/memory/memoryLog.js', () => ({
  appendMemory: vi.fn(async () => 0),
  humanizeMemoryStamps: (s: string) => s,
}));
vi.mock('../analytics', () => ({
  capture: captureSpy,
  captureSurfaceError: vi.fn(),
  surfaceErrorClass: () => 'unknown',
}));
vi.mock('../llm', () => ({
  activeLlmVision: vi.fn(async () => 'yes'),
  buildLlmProvider: vi.fn(async () => {
    throw new Error('no provider in this test');
  }),
}));

import { initDrawService, startDraw, pickDrawWord, endDraw, endAllDraw, __test } from './drawService';
import {
  pendingScopedWrites,
  beginScopeSwitch,
  noteScopeChanged,
  ACCOUNT_SWITCHING,
  _resetScopeBarrierForTests,
} from '../profile/scopeBarrier';
import { getCharacter } from '../characterStore';

const CHAR = 'char-switch';

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

beforeEach(() => {
  captureSpy.mockReset();
  appendSpy.mockReset();
  _resetScopeBarrierForTests();
  initDrawService({
    pushState: vi.fn(),
    pushAiStroke: vi.fn(),
    pushSnapshotRequest: vi.fn(),
    pushChatMessage: vi.fn(),
    isSummoned: () => false,
  });
});

afterEach(async () => {
  await endDraw(CHAR);
  __test.sessions.clear();
});

describe('Draw! on an account switch', () => {
  it('ends a live game with reason account_switch and waits for its play row', async () => {
    const start = await startDraw(CHAR, 3);
    pickDrawWord(CHAR, start.wordChoices[0]);
    // One finished turn, so the game leaves a play row.
    const s = __test.sessions.get(CHAR)!;
    (s as unknown as { gallery: unknown[] }).gallery.push({ round: 1, drawer: 'player', word: 'cat', strokes: [], guessed: true });

    let rowLanded = false;
    appendSpy.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      rowLanded = true;
    });

    const ending = endAllDraw('account_switch');
    // The session is gone at once: a late renderer call cannot reach it.
    expect(__test.sessions.has(CHAR)).toBe(false);
    // The row write is registered with the scope barrier.
    expect(pendingScopedWrites()).toBeGreaterThan(0);
    await ending;
    expect(rowLanded).toBe(true);
    expect(appendSpy).toHaveBeenCalledTimes(1);

    const ended = await waitFor(() => (events('draw_game_ended').length ? events('draw_game_ended') : undefined));
    expect(ended).toHaveLength(1);
    expect(ended[0][1]).toMatchObject({ character_id: CHAR, reason: 'account_switch', turns_played: 1 });
    expect(typeof (ended[0][1] as { duration_ms: unknown }).duration_ms).toBe('number');

    // A late draw:end from the renderer finds nothing: no second event or row.
    await endDraw(CHAR);
    await new Promise((r) => setTimeout(r, 20));
    expect(events('draw_game_ended')).toHaveLength(1);
    expect(appendSpy).toHaveBeenCalledTimes(1);
  });

  it('with no game open it resolves and records nothing', async () => {
    await endAllDraw('account_switch');
    expect(events('draw_game_ended')).toHaveLength(0);
  });
});

describe('Draw! starts across an account switch', () => {
  it('a start while a switch is pending is refused and opens nothing', async () => {
    const release = beginScopeSwitch();
    await expect(startDraw(CHAR, 3)).rejects.toMatchObject({ code: ACCOUNT_SWITCHING });
    expect(__test.sessions.has(CHAR)).toBe(false);
    release();
    await expect(startDraw(CHAR, 3)).resolves.toBeTruthy();
    expect(__test.sessions.has(CHAR)).toBe(true);
  });

  it('a start the switch lands in the middle of is unwound: no session, no event', async () => {
    vi.mocked(getCharacter).mockImplementationOnce(async () => {
      // The account changes while the start is loading the character.
      const release = beginScopeSwitch();
      noteScopeChanged();
      release();
      return null;
    });
    await expect(startDraw(CHAR, 3)).rejects.toMatchObject({ code: ACCOUNT_SWITCHING });
    expect(__test.sessions.has(CHAR)).toBe(false);
    expect(events('draw_game_started')).toHaveLength(0);
  });
});
