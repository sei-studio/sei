/**
 * Backseat on the credit wall (260926). Before this a spent allowance made
 * every screen tick 402 silently: the companion just stopped talking mid-share
 * and nothing said why. Now the first 402 raises the usage-limit popup and
 * fires `credit_wall_degraded` once, screen ticks rest for a minute instead
 * of 402ing every few seconds, and the player's own line still gets a turn
 * (and the popup again), so a top up brings the companion straight back.
 * Harness copied from backseatService.control.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MIN_SPEAK_GAP_MS, type BackseatTick } from '../../shared/backseatIpc';

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
  getCharacter: async () => ({ name: 'Sui', persona: { expanded: 'Sui persona' }, metadata: {} }),
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
vi.mock('../chat/chatStore', () => ({ appendMessage: async () => {} }));
vi.mock('./backseatLog', () => ({ createBackseatLog: async () => ({ line: () => {}, close: async () => {} }), NULL_BACKSEAT_LOG: { line: () => {}, close: async () => {} } }));
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

import { endBackseat, handleTick, initBackseatService, startBackseat } from './backseatService';

const CH = 'sui';
let now = 2_000_000;

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

async function tick(kind: BackseatTick['kind'], text?: string, advanceMs = MIN_SPEAK_GAP_MS + 1_000): Promise<void> {
  now += advanceMs;
  vi.setSystemTime(now);
  await handleTick({
    characterId: CH,
    kind,
    grid: 'data:image/jpeg;base64,AAAA',
    capturedAt: now,
    frameAges: [0],
    ...(text ? { text } : {}),
  });
  await flush();
}

const degraded = () => h.captures.filter(([e]) => e === 'credit_wall_degraded');

describe('backseat on the credit wall', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    h.wall = true;
    h.popups = 0;
    h.captures.length = 0;
    h.requests.length = 0;
    h.replies.length = 0;
    h.said.length = 0;
    initBackseatService({
      pushChatMessage: (_c, m) => {
        if (m.role === 'companion') h.said.push(m.text);
      },
      pushState: () => {},
      pushLine: () => {},
      requestClip: () => {},
      isCallActive: () => false,
    });
  });

  afterEach(async () => {
    await endBackseat(CH);
    vi.useRealTimers();
  });

  it('raises the popup and reports once, then rests screen ticks', async () => {
    await startBackseat(CH, 'screen:1:0', 'Screen', 'text' as never);
    await tick('jolt');
    expect(h.requests).toHaveLength(1);
    expect(h.popups).toBe(1);
    expect(degraded()).toHaveLength(1);
    expect(degraded()[0][1]).toMatchObject({ surface: 'backseat', character_id: CH });

    // Screen ticks inside the backoff never reach the model.
    await tick('jolt');
    await tick('idle');
    expect(h.requests).toHaveLength(1);
    expect(h.popups).toBe(1);
  });

  it("the player's own line still gets a turn and re-raises the popup, but not the event", async () => {
    await startBackseat(CH, 'screen:1:0', 'Screen', 'text' as never);
    await tick('jolt');
    await tick('user', 'hello?');
    expect(h.requests).toHaveLength(2);
    expect(h.popups).toBe(2);
    expect(degraded()).toHaveLength(1);
  });

  it('after the backoff a screen tick tries again, and a topped-up account talks', async () => {
    await startBackseat(CH, 'screen:1:0', 'Screen', 'text' as never);
    await tick('jolt');
    h.wall = false;
    h.replies.push({ text: 'back again' });
    await tick('jolt', undefined, 61_000);
    expect(h.requests).toHaveLength(2);
    expect(h.said).toEqual(['back again']);
    expect(degraded()).toHaveLength(1);
  });
});
