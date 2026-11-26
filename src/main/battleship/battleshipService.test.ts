/**
 * Battleship AI turn regression (261125).
 *
 * The AI's shot record is the PLAYER's grid; the AI's own board view must never
 * be read from aiVisibleGrid (that is the player's view of the AI fleet). When
 * it was, every AI turn accepted a cell it had already bombed, the board never
 * changed and the companion looked like it was not playing at all.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../llm', () => ({
  buildLlmProvider: async () => ({
    kind: 'anthropic',
    call: async (params: {
      messages: Array<{ role: string; content: string }>;
      toolChoice?: { type: string; name: string };
    }) => {
      lastCall = params;
      if (mode === 'hang') return new Promise(() => {}) as never;
      if (mode === 'boom') {
        const e = new Error('502 {"error_code":502,"error_name":"origin_bad_gateway"} status=502');
        throw e;
      }
      if (mode === 'yap') return { content: [{ type: 'text', text: 'Hmm, where to fire?' }] };
      if (mode === 'chatter') {
        return {
          content: [
            { type: 'text', text: 'You are not getting away this time.' },
            { type: 'tool_use', name: 'fire', input: { row: 5, col: 5 } },
          ],
        };
      }
      // A real call: always aim at (5,5) like a lazy model would.
      return { content: [{ type: 'tool_use', name: 'fire', input: { row: 5, col: 5 } }] };
    },
  }),
}));
vi.mock('../lazyAnalytics', () => ({ loadAnalytics: async () => ({ capture: () => {} }) }));
vi.mock('../characterStore', () => ({
  getCharacter: async () => ({ id: 'c1', name: 'Uzi' }),
}));
vi.mock('../configStore', () => ({ loadConfig: async () => ({}) }));
vi.mock('../profile/scopeBarrier', () => ({
  accountSwitchingError: () => new Error('switching'),
  beginSessionStart: () => ({ stillValid: () => true }),
  trackScopedWrite: (p: Promise<unknown>) => p,
}));
vi.mock('../paths', () => ({ paths: { memoryDir: () => '.' } }));
vi.mock('../voice/callState', () => ({ isCallActive: () => false }));
vi.mock('../chat/continuity', () => ({
  foldIfDue: async () => {},
  readChatContext: async () => ({ history: [] }),
}));
vi.mock('../chat/transcript', () => ({ toMessages: () => [] }));
vi.mock('../chat/chatPrompts', () => ({ REMEMBER_TOOL: { name: 'remember', input_schema: {} } }));
vi.mock('../chat/chatStore', () => ({ appendMessage: async () => {} }));
vi.mock('../companionLanguage', () => ({
  companionLanguageFor: () => ({ language: 'en', adopted: false }),
}));
vi.mock('../../bot/brain/promptLibrary.js', () => ({
  renderLanguageDirective: () => '',
  renderAdoptedLanguageNote: () => '',
}));
vi.mock('../../bot/brain/memory/memoryLog.js', () => ({ appendMemory: async () => 1 }));

let mode: 'yap' | 'fire' | 'boom' | 'hang' | 'chatter' = 'yap';
let lastCall: { toolChoice?: { type: string; name: string } } | null = null;
const pushed: Array<{ role: string; text: string }> = [];

const {
  initBATTLESHIPService,
  startBATTLESHIP,
  placeFleet,
  playerMove,
  getBATTLESHIPState,
  endBATTLESHIP,
} = await import('./battleshipService');
const { randomFleetPlacement } = await import('../../shared/battleshipIpc');

/** Cells of the player's own grid the AI has already fired at. */
function aiShotsFired(): number {
  const grid = getBATTLESHIPState('c1')!.playerGrid;
  let n = 0;
  for (const row of grid.cells) {
    for (const cell of row) {
      if (cell === 'hit' || cell === 'miss' || cell === 'sunk') n++;
    }
  }
  return n;
}

async function nextPlayerTurn(): Promise<void> {
  // Let the enqueued AI turn settle.
  for (let i = 0; i < 40 && getBATTLESHIPState('c1')!.turn !== 'player'; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  await new Promise((r) => setTimeout(r, 20));
}

async function playerFiresSomewhere(): Promise<void> {
  const st = getBATTLESHIPState('c1')!;
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 10; c++) {
      if (st.aiVisibleGrid.cells[r][c] === 'empty') {
        await playerMove('c1', r, c);
        return;
      }
    }
  }
}

describe('Battleship AI turn', () => {
  beforeEach(async () => {
    await endBATTLESHIP('c1');
    initBATTLESHIPService({
      pushState: () => {},
      pushChatMessage: (_id: string, msg: { role: string; text: string }) => {
        pushed.push(msg);
      },
      isSummoned: () => false,
    });
    await startBATTLESHIP('c1');
    await placeFleet('c1', randomFleetPlacement());
  });

  it('fires a NEW cell of the player grid every turn when the model only yaps', async () => {
    mode = 'yap';
    for (const expected of [1, 2, 3]) {
      await playerFiresSomewhere();
      await nextPlayerTurn();
      expect(getBATTLESHIPState('c1')!.turn).toBe('player');
      expect(aiShotsFired()).toBe(expected);
    }
  });

  it('never lets the model re-fire a cell it already hit', async () => {
    mode = 'fire';
    await playerFiresSomewhere();
    await nextPlayerTurn();
    expect(aiShotsFired()).toBe(1);
    // No forced tool_choice: the cloud proxy hangs/502s on it, so the tools are
    // offered and the model decides. A prose answer falls back to hunt/target.
    expect(lastCall?.toolChoice).toBeUndefined();

    await playerFiresSomewhere();
    await nextPlayerTurn();
    expect(aiShotsFired()).toBe(2);
  });

  it('still fires when the LLM call fails (proxy 502)', async () => {
    mode = 'boom';
    await playerFiresSomewhere();
    await nextPlayerTurn();
    expect(getBATTLESHIPState('c1')!.turn).toBe('player');
    expect(aiShotsFired()).toBe(1);
  });

  it('still fires when the provider call never settles (hung turn)', async () => {
    mode = 'hang';
    vi.useFakeTimers();
    try {
      await playerFiresSomewhere();
      await vi.advanceTimersByTimeAsync(31_000);
      const st = getBATTLESHIPState('c1')!;
      expect(st.turn).toBe('player');
      expect(st.aiThinking).toBe(false);
      expect(aiShotsFired()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says exactly one line per turn, before the shot lands', async () => {
    mode = 'chatter';
    pushed.length = 0;
    await playerFiresSomewhere();
    await nextPlayerTurn();
    expect(aiShotsFired()).toBe(1);
    const said = pushed.filter((m) => m.role === 'companion');
    expect(said).toHaveLength(1);
    expect(said[0].text).toBe('You are not getting away this time.');
  });
});
