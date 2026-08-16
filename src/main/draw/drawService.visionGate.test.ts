/**
 * china-compat W9 — the Draw! session-start vision hard gate.
 *
 * Every Draw! turn shows the model a canvas snapshot, so a text-only local
 * model (deepseek, qwen-plus, ...) cannot run the surface at all. The renderer
 * gates the picker tile as UX; startDraw is the authoritative backstop, the
 * same split backseat uses (LLM_NO_VISION) and the summon username collision
 * uses.
 *
 * Invariants under test:
 *   1. activeLlmVision 'no' → startDraw rejects, and the DRAW_LLM_NO_VISION
 *      token is in the MESSAGE (error `code` does not survive the IPC
 *      boundary, so the renderer matches the message).
 *   2. 'unknown' is allowed through — a wrong refusal silently hides the
 *      game, a wrong allow fails visibly. BYOK Anthropic before any
 *      capability fetch must not lose Draw!.
 *   3. 'yes' starts normally.
 *   4. The gate refuses BEFORE any session state exists (no half-built game
 *      left behind for the renderer to resume).
 *
 * The heavy chat-side imports are mocked at the module seam; the game logic
 * under test (startDraw → beginTurn 'player' → 'pick' phase) is real, and the
 * pick phase arms no timers, so teardown is just clearing the session map.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/sei-test', isPackaged: true },
}));
vi.mock('../chat/usageLimit', () => ({ raiseUsageLimitPopup: vi.fn() }));
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
vi.mock('../analytics', () => ({ capture: vi.fn() }));

const activeLlmVisionMock = vi.fn(async () => 'yes' as 'yes' | 'no' | 'unknown');
vi.mock('../llm', () => ({
  activeLlmVision: (): Promise<'yes' | 'no' | 'unknown'> => activeLlmVisionMock(),
  buildLlmProvider: vi.fn(async () => {
    throw new Error('no provider in this test');
  }),
}));

import { initDrawService, startDraw, __test } from './drawService';
import { DRAW_ERR_NO_VISION } from '../../shared/drawIpc';

beforeEach(() => {
  activeLlmVisionMock.mockReset();
  activeLlmVisionMock.mockResolvedValue('yes');
  initDrawService({
    pushState: vi.fn(),
    pushAiStroke: vi.fn(),
    pushSnapshotRequest: vi.fn(),
    pushChatMessage: vi.fn(),
    isSummoned: () => false,
  });
});

afterEach(() => {
  // The pick phase arms no timers (startDrawingPhase does), so dropping the
  // sessions is a complete teardown for these tests.
  __test.sessions.clear();
});

describe('startDraw vision gate (W9)', () => {
  it("Test 1: a 'no' verdict rejects with the DRAW_LLM_NO_VISION token in the message", async () => {
    activeLlmVisionMock.mockResolvedValue('no');
    await expect(startDraw('char-1', 3)).rejects.toThrow(DRAW_ERR_NO_VISION);
  });

  it('Test 1b: the refusal names Settings as the fix', async () => {
    activeLlmVisionMock.mockResolvedValue('no');
    await expect(startDraw('char-1', 3)).rejects.toThrow(/vision-capable model in Settings/);
  });

  it("Test 2: 'unknown' is allowed through (never block on unknown)", async () => {
    activeLlmVisionMock.mockResolvedValue('unknown');
    const state = await startDraw('char-2', 3);
    expect(state.phase).toBe('pick');
  });

  it("Test 3: 'yes' starts normally", async () => {
    const state = await startDraw('char-3', 3);
    expect(state.phase).toBe('pick');
    expect(state.round).toBe(1);
  });

  it('Test 4: a refused start leaves no session behind', async () => {
    activeLlmVisionMock.mockResolvedValue('no');
    await expect(startDraw('char-4', 3)).rejects.toThrow(DRAW_ERR_NO_VISION);
    expect(__test.sessions.has('char-4')).toBe(false);
  });
});
