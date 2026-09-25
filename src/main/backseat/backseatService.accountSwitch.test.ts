/**
 * Backseat on an account switch (260926). endAllBackseat ends every share
 * through endBackseat, the one end choke point: backseat_ended carries
 * duration_ms and reason 'account_switch', the play row is written, and the
 * whole end is registered with the scope write barrier so the switch waits for
 * the row before it re-points the profile scope. An ordinary stop sends no
 * reason. Mocks copied from backseatService.creditWall.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  wall: true,
  popups: 0,
  captures: [] as Array<[string, Record<string, unknown> | undefined]>,
  requests: [] as Array<{ tools?: Array<{ name: string }> }>,
  replies: [] as Array<{ text?: string; control?: { goal: string; request?: string } }>,
  starts: [] as Array<Record<string, unknown>>,
  said: [] as string[],
  speech: [] as Array<{ text: string; confirmId?: string }>,
  onCall: false,
  intentAnswer: true as boolean,
  intentSeen: [] as Array<[string, string]>,
  rows: 0,
  /** Runs inside startBackseat's character load (a switch landing mid-start). */
  onGetCharacter: null as null | (() => void),
  logsClosed: 0,
}));

vi.mock('electron', () => ({ app: { isPackaged: true, getPath: () => '/tmp' } }));
vi.mock('../analytics', () => ({
  capture: (e: string, p?: Record<string, unknown>) => h.captures.push([e, p]),
  captureSurfaceError: () => {},
  surfaceErrorClass: () => 'payment_required',
}));
vi.mock('../chat/usageLimit', async (orig) => ({
  ...(await orig<typeof import('../chat/usageLimit')>()),
  raiseUsageLimitPopup: async (err: { status?: number }) => {
    if (err?.status !== 402) return null;
    h.popups += 1;
    return 'depleted';
  },
}));
vi.mock('../paths', () => ({ paths: { memoryDir: () => '/nonexistent/sei-test-memory' } }));
vi.mock('../configStore', () => ({ loadConfig: async () => ({}) }));
vi.mock('../characterStore', () => ({
  getCharacter: async () => {
    const hook = h.onGetCharacter;
    h.onGetCharacter = null;
    hook?.();
    return { name: 'Sui', persona: { expanded: 'Sui persona' }, metadata: {} };
  },
}));
vi.mock('../chat/sdk', () => ({ CHAT_TIMEOUT_MS: 1000 }));
vi.mock('../llm', () => ({
  activeLlmVision: async () => 'yes',
  buildLlmProvider: async () => ({
    kind: 'anthropic',
    model: 'test',
    call: async (req: { tools?: Array<{ name: string }> }) => {
      h.requests.push(req);
      if (h.wall) throw Object.assign(new Error('402 payment_required'), { status: 402 });
      const r = h.replies.shift() ?? { text: 'ok' };
      const content: unknown[] = [];
      if (r.text) content.push({ type: 'text', text: r.text });
      if (r.control) content.push({ type: 'tool_use', id: 't1', name: 'control', input: r.control });
      return { content, usage: {} };
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
  appendMessage: async () => {
    await new Promise((r) => setTimeout(r, 20));
    h.rows += 1;
  },
}));
vi.mock('./backseatLog', () => ({ createBackseatLog: async () => ({ line: () => {}, close: async () => { h.logsClosed++; } }), NULL_BACKSEAT_LOG: { line: () => {}, close: async () => {} } }));
vi.mock('../computerUse/controlTool', async (orig) => ({
  ...(await orig<typeof import('../computerUse/controlTool')>()),
  actFlagFromEnv: () => true,
}));
vi.mock('../computerUse/actSession', () => ({
  controlAvailability: (sourceId: string) => (sourceId.startsWith('window:') ? { ok: true } : { ok: false, why: 'not_window' }),
  isActing: () => false,
  startControl: async (o: Record<string, unknown>) => {
    h.starts.push(o);
    return { ok: true };
  },
  stopAct: () => {},
  checkControlIntent: async (u: string, g: string) => {
    h.intentSeen.push([u, g]);
    return h.intentAnswer;
  },
  ACT_CANCELLED: 'ACT_CANCELLED',
}));

import { endAllBackseat, endBackseat, initBackseatService, startBackseat } from './backseatService';
import {
  pendingScopedWrites,
  beginScopeSwitch,
  noteScopeChanged,
  ACCOUNT_SWITCHING,
  _resetScopeBarrierForTests,
} from '../profile/scopeBarrier';

const ended = () => h.captures.filter(([e]) => e === 'backseat_ended');

describe('backseat on an account switch', () => {
  beforeEach(() => {
    h.captures.length = 0;
    h.rows = 0;
    _resetScopeBarrierForTests();
    initBackseatService({
      pushChatMessage: () => {},
      pushState: () => {},
      pushLine: () => {},
      requestClip: () => {},
      isCallActive: () => false,
    });
  });

  afterEach(async () => {
    await endBackseat('sui');
    await endBackseat('lyra');
  });

  it('ends every share with reason account_switch and waits for the rows', async () => {
    await startBackseat('sui', 'screen:1:0', 'Screen', 'text' as never);
    await startBackseat('lyra', 'window:2:0', 'Game', 'text' as never);

    const ending = endAllBackseat('account_switch');
    expect(pendingScopedWrites()).toBe(2);
    await ending;
    expect(h.rows).toBe(2);
    await new Promise((r) => setTimeout(r, 10));
    expect(ended()).toHaveLength(2);
    for (const [, props] of ended()) {
      expect(props).toMatchObject({ reason: 'account_switch' });
      expect(typeof props?.duration_ms).toBe('number');
    }
    expect(ended().map(([, p]) => p?.character_id).sort()).toEqual(['lyra', 'sui']);

    // The renderer's late backseat:end finds the session gone.
    await endBackseat('sui');
    await new Promise((r) => setTimeout(r, 10));
    expect(ended()).toHaveLength(2);
    expect(h.rows).toBe(2);
  });

  it('an ordinary stop sends no reason', async () => {
    await startBackseat('sui', 'screen:1:0', 'Screen', 'text' as never);
    await endBackseat('sui');
    await new Promise((r) => setTimeout(r, 10));
    expect(ended()).toHaveLength(1);
    expect(ended()[0][1]).not.toHaveProperty('reason');
  });
});

describe('backseat starts across an account switch', () => {
  beforeEach(() => {
    h.captures.length = 0;
    h.logsClosed = 0;
    _resetScopeBarrierForTests();
    initBackseatService({
      pushChatMessage: () => {},
      pushState: () => {},
      pushLine: () => {},
      requestClip: () => {},
      isCallActive: () => false,
    });
  });
  afterEach(async () => {
    await endBackseat('sui');
  });

  it('a start while a switch is pending is refused', async () => {
    const release = beginScopeSwitch();
    await expect(startBackseat('sui', 'screen:1:0', 'Screen', 'text' as never)).rejects.toMatchObject({
      code: ACCOUNT_SWITCHING,
    });
    release();
    await endBackseat('sui');
    // Nothing was open, so nothing ends.
    expect(ended()).toHaveLength(0);
  });

  it('a start the switch lands in the middle of is unwound: log closed, no session', async () => {
    h.onGetCharacter = () => {
      const release = beginScopeSwitch();
      noteScopeChanged();
      release();
    };
    await expect(startBackseat('sui', 'screen:1:0', 'Screen', 'text' as never)).rejects.toMatchObject({
      code: ACCOUNT_SWITCHING,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(h.logsClosed).toBe(1);
    expect(h.captures.filter(([e]) => e === 'backseat_started')).toHaveLength(0);
    // No session to end: an end reports nothing.
    await endBackseat('sui');
    expect(ended()).toHaveLength(0);
  });
});
