/**
 * 261124 (in-app feedback, Backseat): "the chat doesn't show messages typed
 * by me". On a call every Backseat row was flagged `voice` and hidden, the
 * player's own TYPED line included. A typed line (no `mic`) now also carries
 * `typed`, keeps the renderer's bubble id (lineId), and the answer to it is
 * stamped `typed` too, so the chat shows the exchange. A spoken line and her
 * own screen commentary stay hidden. Mocks as in the quiet/inflight tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackseatTick, BackseatTickOutcome } from '../../shared/backseatIpc';
import { chatRowHidden, type ChatMessage } from '../../shared/ipc';

const h = vi.hoisted(() => ({
  calls: [] as string[],
  rows: [] as ChatMessage[],
  pushed: [] as ChatMessage[],
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
  appendMessage: async (_id: string, m: ChatMessage) => {
    h.rows.push(m);
  },
}));
vi.mock('./backseatLog', () => ({
  createBackseatLog: async () => ({ line: () => {}, close: async () => {} }),
  NULL_BACKSEAT_LOG: { line: () => {}, close: async () => {} },
}));

import { endBackseat, handleTick, initBackseatService, startBackseat } from './backseatService';

const CH = 'sui';
const LINE_ID = '3f2b8c1e-9a4d-4e6f-8b2a-1c0d9e8f7a6b';
let now = 5_000_000;

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

function tick(extra: Partial<BackseatTick> & Pick<BackseatTick, 'kind'>): Promise<BackseatTickOutcome> {
  return handleTick({
    characterId: CH,
    grid: 'data:image/jpeg;base64,AAAA',
    capturedAt: now,
    frameAges: [0],
    ...extra,
  });
}

describe('backseat rows for a line the player typed on the call (261124)', () => {
  let onCall = true;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    now += 10 * 60_000;
    vi.setSystemTime(now);
    h.calls.length = 0;
    h.rows.length = 0;
    h.pushed.length = 0;
    onCall = true;
    initBackseatService({
      pushChatMessage: (_c, m) => {
        h.pushed.push(m);
      },
      pushState: () => {},
      pushLine: () => {},
      requestClip: () => {},
      isCallActive: () => onCall,
    });
  });

  afterEach(async () => {
    await endBackseat(CH);
    vi.useRealTimers();
  });

  it('a typed line and its answer are call rows the chat still shows; the line keeps its bubble id', async () => {
    await startBackseat(CH, 'window:1:0', 'Game', 'voice');
    expect(await tick({ kind: 'user', text: 'is that the warden', lineId: LINE_ID })).toBe('spoke');
    await flush();
    const player = h.rows.find((r) => r.role === 'user');
    expect(player).toMatchObject({ id: LINE_ID, text: 'is that the warden', voice: true, typed: true });
    expect(h.pushed.find((r) => r.role === 'user')?.id).toBe(LINE_ID);
    const answer = h.rows.filter((r) => r.role === 'companion');
    expect(answer.length).toBeGreaterThan(0);
    for (const r of answer) expect(r).toMatchObject({ voice: true, typed: true });
    expect(h.rows.every((r) => !chatRowHidden(r))).toBe(true);
  });

  it('a spoken (mic) line, its answer and her own screen lines stay hidden', async () => {
    await startBackseat(CH, 'window:1:0', 'Game', 'voice');
    expect(await tick({ kind: 'user', text: 'what is that', lineId: LINE_ID, mic: { ttsGapMs: null } })).toBe('spoke');
    await flush();
    const player = h.rows.find((r) => r.role === 'user');
    expect(player?.id).not.toBe(LINE_ID);
    expect(player?.typed).toBeUndefined();
    now += 60_000;
    vi.setSystemTime(now);
    expect(await tick({ kind: 'idle' })).toBe('spoke');
    await flush();
    expect(h.rows.length).toBeGreaterThan(2);
    expect(h.rows.every((r) => r.voice === true && chatRowHidden(r))).toBe(true);
  });

  it('off a call a typed line is a plain chat row', async () => {
    onCall = false;
    await startBackseat(CH, 'window:1:0', 'Game', 'voice');
    expect(await tick({ kind: 'user', text: 'hi', lineId: LINE_ID })).toBe('spoke');
    await flush();
    const player = h.rows.find((r) => r.role === 'user');
    expect(player?.voice).toBeUndefined();
    expect(player?.typed).toBeUndefined();
  });
});
