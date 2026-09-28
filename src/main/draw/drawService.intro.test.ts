/**
 * Draw! intro game + turn analytics (260929, UX review item 5).
 *
 * 12 of 18 games were abandoned, 4 at 0 turns about 70s in: the player always
 * drew first, on the spot. Now a player's first game is one round with the
 * character drawing first, a returning player gets the normal game, and every
 * turn (including the one a player quits in) emits `draw_turn_ended` with who
 * drew and how long it ran.
 *
 * Same module seams as drawService.creditWall.test.ts; the character's model
 * calls fail fast (no provider), which the game survives by design.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { captureSpy, cfg } = vi.hoisted(() => ({
  captureSpy: vi.fn(),
  cfg: { current: {} as Record<string, unknown> },
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/sei-test', isPackaged: true },
}));
vi.mock('../chat/usageLimit', () => ({ raiseUsageLimitPopup: vi.fn(async () => null) }));
vi.mock('../voice/callState', () => ({ isCallActive: () => false }));
vi.mock('../configStore', () => ({
  loadConfig: vi.fn(async () => cfg.current),
  updateConfig: vi.fn(async (mutate: (c: Record<string, unknown>) => Record<string, unknown>) => {
    cfg.current = mutate(cfg.current);
    return cfg.current;
  }),
}));
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
  surfaceErrorClass: () => 'other',
}));
vi.mock('../llm', () => ({
  activeLlmVision: vi.fn(async () => 'yes'),
  buildLlmProvider: vi.fn(async () => {
    throw new Error('no provider in this test');
  }),
}));

import {
  initDrawService,
  openDraw,
  startDraw,
  newDrawGame,
  pickDrawWord,
  playerChat,
  receiveSnapshot,
  endDraw,
  __test,
} from './drawService';
import { INTRO_ROUNDS, TURN_MS, type DrawGameState } from '../../shared/drawIpc';

const CHAR = 'char-intro';
let pushed: DrawGameState[];

const events = (name: string): Record<string, unknown>[] =>
  captureSpy.mock.calls.filter((c) => c[0] === name).map((c) => c[1] as Record<string, unknown>);

const last = (): DrawGameState => pushed[pushed.length - 1];

/** Let the fire-and-forget analytics imports settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(1);
}

beforeEach(() => {
  vi.useFakeTimers();
  pushed = [];
  cfg.current = {};
  captureSpy.mockReset();
  let snap = 0;
  initDrawService({
    pushState: (st: DrawGameState) => pushed.push(st),
    pushAiStroke: vi.fn(),
    pushSnapshotRequest: ({ requestId }: { requestId: string }) => {
      snap += 1;
      queueMicrotask(() => receiveSnapshot(requestId, `data:image/png;base64,AAAA${snap}`));
    },
    pushChatMessage: vi.fn(),
    isSummoned: () => false,
  });
});

afterEach(async () => {
  await endDraw(CHAR);
  __test.sessions.clear();
  vi.useRealTimers();
});

describe('the intro game (first Draw! game)', () => {
  it('says so on the setup screen before Start', async () => {
    const setup = await openDraw(CHAR);
    expect(setup.phase).toBe('setup');
    expect(setup.intro).toBe(true);
    expect(setup.rounds).toBe(INTRO_ROUNDS);
  });

  it('is one round, the character draws first, and the player is told what to do', async () => {
    await openDraw(CHAR);
    const start = await startDraw(CHAR, 3); // the renderer always asks for 3
    expect(start.rounds).toBe(INTRO_ROUNDS);
    expect(start.phase).toBe('drawing');
    expect(start.drawer).toBe('ai');
    expect(start.word).toBeNull(); // the guesser never sees the answer

    const intro = start.chat.find((m) => m.system && /draws first/.test(m.text));
    expect(intro?.text).toContain('Type your guesses in the chat.');
    // Second person for the player, third person for the model.
    expect(intro?.modelText).toMatch(/first game of Draw!, so you draw first/);

    await settle();
    expect(events('draw_game_started')[0]).toMatchObject({ intro: true, first_drawer: 'ai', rounds: 1 });
  });

  it('plays character turn -> player turn -> gallery, logs each turn, and marks the intro done', async () => {
    await startDraw(CHAR, 3);
    const word = __test.sessions.get(CHAR)!.word;
    await vi.advanceTimersByTimeAsync(12_000);
    await playerChat(CHAR, `is it a ${word}?`);
    expect(last().phase).toBe('turn-end');
    await settle();
    const t1 = events('draw_turn_ended')[0];
    expect(t1).toMatchObject({ drawer: 'ai', outcome: 'guessed', turn_number: 1, phase: 'drawing', intro: true });
    expect(t1.turn_ms).toBeGreaterThanOrEqual(12_000);
    expect(t1.guesser_lines).toBe(1);

    // The gap, then the player's own turn in the same round.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(last()).toMatchObject({ phase: 'pick', drawer: 'player', round: 1 });
    pickDrawWord(CHAR, last().wordChoices[0]);
    expect(last()).toMatchObject({ phase: 'drawing', drawer: 'player' });

    // Nobody guesses it: time runs out, and that was the last turn.
    await vi.advanceTimersByTimeAsync(TURN_MS + 10);
    await settle();
    const t2 = events('draw_turn_ended')[1];
    expect(t2).toMatchObject({ drawer: 'player', outcome: 'timeout', turn_number: 2 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(last().phase).toBe('gallery');
    expect(last().gallery.map((g) => g.drawer)).toEqual(['ai', 'player']);
    await settle();
    expect(events('draw_game_ended')[0]).toMatchObject({ reason: 'completed', intro: true, first_drawer: 'ai' });
    expect(cfg.current.draw_intro_done).toBe(true);

    // Play again: a normal game, even before the config would be re-read.
    const again = await newDrawGame(CHAR);
    expect(again.intro).toBeUndefined();
    expect(again.rounds).toBe(3);
  });

  it('quitting the intro keeps the next game an intro', async () => {
    await startDraw(CHAR, 3);
    await endDraw(CHAR);
    expect(cfg.current.draw_intro_done).toBeUndefined();
    const next = await openDraw(CHAR);
    expect(next.intro).toBe(true);
  });
});

describe('a returning player', () => {
  it('gets the normal game: three rounds, the player picks and draws first', async () => {
    cfg.current = { draw_intro_done: true };
    const setup = await openDraw(CHAR);
    expect(setup.intro).toBeUndefined();
    const start = await startDraw(CHAR, 3);
    expect(start.rounds).toBe(3);
    expect(start).toMatchObject({ phase: 'pick', drawer: 'player', round: 1 });
    expect(start.chat.some((m) => /draws first/.test(m.text))).toBe(false);
  });
});

describe('draw_turn_ended on a quit', () => {
  it('records the live drawing turn a player walks away from', async () => {
    await startDraw(CHAR, 3);
    await vi.advanceTimersByTimeAsync(70_000);
    await endDraw(CHAR);
    await settle();
    expect(events('draw_turn_ended')).toEqual([
      expect.objectContaining({ drawer: 'ai', phase: 'drawing', outcome: 'abandoned', turn_number: 1 }),
    ]);
    expect(events('draw_turn_ended')[0].turn_ms).toBeGreaterThanOrEqual(70_000);
    expect(events('draw_game_ended')[0]).toMatchObject({ reason: 'abandoned', phase: 'drawing', turns_played: 0 });
  });

  it('records a player stuck on the word choice as a pick-phase turn', async () => {
    cfg.current = { draw_intro_done: true };
    await startDraw(CHAR, 3);
    await vi.advanceTimersByTimeAsync(30_000);
    await endDraw(CHAR);
    await settle();
    expect(events('draw_turn_ended')[0]).toMatchObject({
      drawer: 'player',
      phase: 'pick',
      outcome: 'abandoned',
      strokes: 0,
    });
    expect(events('draw_turn_ended')[0].turn_ms).toBeGreaterThanOrEqual(30_000);
  });
});
