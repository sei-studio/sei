/**
 * 261010: a user tick claims the turn BEFORE it awaits the player's chat-row
 * write. In the 261009 live replay a jolt that landed during that await saw
 * no turn in flight and started a second, concurrent one (4 of 18 runs): a
 * paid call the user turn then discarded, or a screen line spoken ahead of
 * the answer. Everything around the turn is mocked; the tick arbitration is
 * real, and the chat-row write is held open so the window can be hit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MIN_SPEAK_GAP_MS, type BackseatTick } from '../../shared/backseatIpc';

const h = vi.hoisted(() => ({
  calls: [] as string[],
  said: [] as string[],
  appendGate: null as null | { promise: Promise<void>; release: () => void },
  appended: [] as string[],
}));

vi.mock('electron', () => ({ app: { isPackaged: true, getPath: () => '/tmp' } }));
vi.mock('../analytics', () => ({ capture: () => {}, captureSurfaceError: () => {}, surfaceErrorClass: () => 'x' }));
vi.mock('../paths', () => ({ paths: { memoryDir: () => '/nonexistent/sei-test-memory' } }));
vi.mock('../configStore', () => ({ loadConfig: async () => ({}) }));
vi.mock('../characterStore', () => ({
  getCharacter: async () => ({ name: 'Sui', persona: { expanded: 'Sui persona' }, metadata: {} }),
}));
vi.mock('../chat/sdk', () => ({ CHAT_TIMEOUT_MS: 1000 }));
vi.mock('../llm', () => ({
  activeLlmVision: async () => 'yes',
  buildLlmProvider: async () => ({
    kind: 'anthropic',
    model: 'test',
    call: async (req: { messages: Array<{ content: Array<{ type: string; text?: string }> }> }) => {
      const last = req.messages[req.messages.length - 1];
      const text = last.content.find((b) => b.type === 'text')?.text ?? '';
      const kind = /saying this/.test(text) ? 'user' : 'screen';
      h.calls.push(kind);
      return { content: [{ type: 'text', text: `${kind} line` }], usage: {}, stopReason: 'end_turn' };
    },
  }),
}));
vi.mock('../chat/chatPrompts', () => ({
  buildSystemBlocks: () => [],
  markMessageCached: () => {},
  REMEMBER_TOOL: { name: 'remember', description: '', input_schema: { type: 'object', properties: {} } },
}));
vi.mock('../chat/chatService', () => ({
  toMessages: () => [],
  isSilenceFiller: (t: string) => t.trim() === '(silence)',
  splitReply: (t: string) => [t],
}));
vi.mock('../chat/noteLeak', () => ({ isNoteLeak: () => false, stripThoughtTags: (t: string) => t }));
vi.mock('../chat/continuity', () => ({ readChatContext: async () => ({ summary: '', history: [] }), foldIfDue: async () => {} }));
vi.mock('../chat/playSummary', () => ({ playSummaryText: () => '' }));
vi.mock('../knowledge/knowledgeStore', () => ({ readKnowledgeForPrompt: async () => '' }));
vi.mock('../../bot/brain/memory/memoryLog.js', () => ({ appendMemory: async () => {}, humanizeMemoryStamps: (t: string) => t }));
vi.mock('../chat/chatStore', () => ({
  appendMessage: async (_id: string, m: { role: string; text: string }) => {
    // Only the player's row is held: that is the await the jolt slipped into.
    if (m.role === 'user' && h.appendGate) await h.appendGate.promise;
    h.appended.push(`${m.role}:${m.text}`);
  },
}));
vi.mock('./backseatLog', () => ({
  createBackseatLog: async () => ({ line: () => {}, close: async () => {} }),
  NULL_BACKSEAT_LOG: { line: () => {}, close: async () => {} },
}));

import { endBackseat, handleTick, initBackseatService, interruptBackseat, startBackseat } from './backseatService';

const CH = 'sui';
let now = 2_000_000;

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

function tick(kind: BackseatTick['kind'], text?: string): Promise<void> {
  return handleTick({
    characterId: CH,
    kind,
    grid: 'data:image/jpeg;base64,AAAA',
    capturedAt: now,
    frameAges: [0],
    ...(text ? { text } : {}),
  });
}

function hold(): void {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  h.appendGate = { promise, release };
}

describe('backseat turn claim (261010)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // Past the speak gap, so the jolt is judged on the in-flight turn alone.
    now += MIN_SPEAK_GAP_MS * 10;
    vi.setSystemTime(now);
    h.calls.length = 0;
    h.said.length = 0;
    h.appended.length = 0;
    h.appendGate = null;
    initBackseatService({
      pushChatMessage: (_c, m) => {
        if (m.role === 'companion') h.said.push(m.text);
      },
      pushState: () => {},
      pushLine: () => {},
      requestClip: () => {},
      isCallActive: () => true,
    });
  });

  afterEach(async () => {
    await endBackseat(CH);
    vi.useRealTimers();
  });

  it('drops a jolt that lands while the player line is still being saved', async () => {
    await startBackseat(CH, 'window:1:0', 'Game', 'voice');
    hold();
    const user = tick('user', 'aren\'t my dogs so cute');
    await flush();
    // The user turn is parked on its chat-row write. A jolt arrives now.
    await tick('jolt');
    expect(h.calls).toEqual([]);
    h.appendGate!.release();
    await user;
    await flush();
    expect(h.calls).toEqual(['user']);
    expect(h.said).toEqual(['user line']);
  });

  it('drops an idle look in the same window too', async () => {
    await startBackseat(CH, 'window:1:0', 'Game', 'voice');
    hold();
    const user = tick('user', 'what should I build');
    await flush();
    await tick('idle');
    h.appendGate!.release();
    await user;
    await flush();
    expect(h.calls).toEqual(['user']);
  });

  it('a barge-in during the save cancels the turn without a model call, and frees the slot', async () => {
    await startBackseat(CH, 'window:1:0', 'Game', 'voice');
    hold();
    const user = tick('user', 'hold on');
    await flush();
    interruptBackseat(CH);
    h.appendGate!.release();
    await user;
    await flush();
    expect(h.calls).toEqual([]);
    // The player's line is still in the thread for the next turn to read.
    expect(h.appended).toContain('user:hold on');
    // And the slot is free again: the next look runs.
    await tick('jolt');
    await flush();
    expect(h.calls).toEqual(['screen']);
  });

  it('still lets a jolt run once the user turn has finished', async () => {
    await startBackseat(CH, 'window:1:0', 'Game', 'voice');
    await tick('user', 'hi');
    await flush();
    now += MIN_SPEAK_GAP_MS + 1_000;
    vi.setSystemTime(now);
    await tick('jolt');
    await flush();
    expect(h.calls).toEqual(['user', 'screen']);
  });
});
