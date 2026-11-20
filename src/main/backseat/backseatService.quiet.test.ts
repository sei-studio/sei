/**
 * 261103: the backoff while nobody answers her. A free user (Valheim) quit
 * after 15 minutes of chatter: every look speaks, so the floor between her
 * own lines grows with the run of lines the player has not answered
 * (quietExtraMs), and the player saying anything resets it. The arbitration
 * is real; the model, stores and prompts are mocked as in the inflight test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MIN_SPEAK_GAP_MS,
  QUIET_MAX_EXTRA_MS,
  QUIET_STEP_MS,
  quietExtraMs,
  type BackseatTick,
  type BackseatTickOutcome,
} from '../../shared/backseatIpc';

const h = vi.hoisted(() => ({
  calls: [] as string[],
  said: [] as string[],
  appendGate: null as null | { promise: Promise<void>; release: () => void },
  appended: [] as string[],
  speech: [] as Array<{ text: string; ambientCapturedAt?: number }>,
  prewarms: 0,
  lines: [] as Array<{ text: string; quietExtraMs?: number }>,
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
  clockTailNote: () => '[now: test]',
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

import { endBackseat, handleTick, initBackseatService, startBackseat } from './backseatService';

const CH = 'sui';
let now = 5_000_000;

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

function advance(ms: number): void {
  now += ms;
  vi.setSystemTime(now);
}

function tick(kind: BackseatTick['kind'], text?: string): Promise<BackseatTickOutcome> {
  return handleTick({
    characterId: CH,
    kind,
    grid: 'data:image/jpeg;base64,AAAA',
    capturedAt: now,
    frameAges: [0],
    ...(text ? { text } : {}),
  });
}

/** One ambient line, said just past whatever gap is in force. */
async function ambientLine(kind: BackseatTick['kind'] = 'idle'): Promise<BackseatTickOutcome> {
  const r = await tick(kind);
  await flush();
  return r;
}

describe('backseat backoff while nobody answers (261103)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    advance(10 * 60_000);
    h.calls.length = 0;
    h.said.length = 0;
    h.lines.length = 0;
    h.appendGate = null;
    initBackseatService({
      pushChatMessage: (_c, m) => {
        if (m.role === 'companion') h.said.push(m.text);
      },
      pushState: () => {},
      pushLine: (_c, l) => {
        if (!l.who) h.lines.push({ text: l.text, ...(l.quietExtraMs !== undefined ? { quietExtraMs: l.quietExtraMs } : {}) });
      },
      requestClip: () => {},
      isCallActive: () => true,
    });
  });

  afterEach(async () => {
    await endBackseat(CH);
    vi.useRealTimers();
  });

  it('keeps the normal gap for the first lines, then drops a jolt inside the grown gap', async () => {
    await startBackseat(CH, 'window:1:0', 'Game', 'voice');
    expect(await ambientLine('start')).toBe('spoke');
    advance(MIN_SPEAK_GAP_MS + 1_000);
    expect(await ambientLine()).toBe('spoke');
    advance(MIN_SPEAK_GAP_MS + 1_000);
    // Third unanswered line: from here the floor has grown by one step.
    expect(await ambientLine('jolt')).toBe('spoke');
    advance(MIN_SPEAK_GAP_MS + 1_000);
    expect(await ambientLine('jolt')).toBe('dropped');
    advance(QUIET_STEP_MS);
    expect(await ambientLine('jolt')).toBe('spoke');
    expect(h.calls).toEqual(['screen', 'screen', 'screen', 'screen']);
  });

  it('tells the renderer the backoff on each line, growing to the cap', async () => {
    await startBackseat(CH, 'window:1:0', 'Game', 'voice');
    for (let i = 0; i < 10; i++) {
      advance(MIN_SPEAK_GAP_MS + QUIET_MAX_EXTRA_MS + 1_000);
      expect(await ambientLine(i === 0 ? 'start' : 'idle')).toBe('spoke');
    }
    expect(h.lines.map((l) => l.quietExtraMs ?? 0)).toEqual(
      Array.from({ length: 10 }, (_, i) => quietExtraMs(i + 1)),
    );
    expect(h.lines[9].quietExtraMs).toBe(QUIET_MAX_EXTRA_MS);
  });

  it('resets the moment the player speaks, and a reply carries no backoff', async () => {
    await startBackseat(CH, 'window:1:0', 'Game', 'voice');
    for (let i = 0; i < 6; i++) {
      advance(MIN_SPEAK_GAP_MS + QUIET_MAX_EXTRA_MS + 1_000);
      await ambientLine(i === 0 ? 'start' : 'idle');
    }
    expect(h.lines[h.lines.length - 1].quietExtraMs).toBe(quietExtraMs(6));
    // The player answers, inside the grown gap: always answered.
    advance(MIN_SPEAK_GAP_MS + 1_000);
    expect(await tick('user', 'haha ok')).toBe('spoke');
    await flush();
    expect(h.lines[h.lines.length - 1]).toEqual({ text: 'user line' });
    // And the next jolt is back on the plain 8 s gap.
    advance(MIN_SPEAK_GAP_MS + 1_000);
    expect(await ambientLine('jolt')).toBe('spoke');
    expect(h.lines[h.lines.length - 1].quietExtraMs).toBeUndefined();
  });

  it('carries the run over a share that comes straight back', async () => {
    await startBackseat(CH, 'window:1:0', 'Game', 'voice');
    for (let i = 0; i < 5; i++) {
      advance(MIN_SPEAK_GAP_MS + QUIET_MAX_EXTRA_MS + 1_000);
      await ambientLine(i === 0 ? 'start' : 'idle');
    }
    await endBackseat(CH);
    advance(5_000);
    await startBackseat(CH, 'window:1:0', 'Game', 'voice');
    expect(await ambientLine('start')).toBe('spoke');
    // Five before the gap, the resumed opening line is the sixth.
    expect(h.lines[h.lines.length - 1].quietExtraMs).toBe(quietExtraMs(6));
  });
});
