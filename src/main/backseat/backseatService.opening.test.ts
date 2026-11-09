/**
 * 261023: the opening look. A failed first turn used to leave the share in
 * silence for up to a minute (30 s budget, retried once by the SDK), and its
 * line could be dropped by the staleness gate on the slow first call. Pinned
 * here: the opening look's budget, the outcome handleTick reports (which the
 * renderer uses to take a failed or empty look again), that the opening line
 * is never stale-gated, and the backseat_ended shape fields.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { START_LOOK_TIMEOUT_MS, type BackseatTick } from '../../shared/backseatIpc';

const h = vi.hoisted(() => ({
  reqs: [] as Array<{ timeoutMs?: number; maxRetries?: number }>,
  reply: 'a line' as string | Error,
  speech: [] as Array<{ text: string; ambientCapturedAt?: number }>,
  captures: [] as Array<[string, Record<string, unknown>]>,
  notes: [] as string[],
  maxTokens: [] as Array<number | undefined>,
  stop: 'end_turn' as string,
  tail: null as null | { type: string; name: string; input: unknown },
}));

vi.mock('electron', () => ({ app: { isPackaged: true, getPath: () => '/tmp' } }));
vi.mock('../lazyAnalytics', () => ({
  loadAnalytics: async () => ({
    capture: (e: string, p: Record<string, unknown>) => h.captures.push([e, p]),
    captureSurfaceError: () => {},
    surfaceErrorClass: () => 'timeout',
  }),
}));
vi.mock('../paths', () => ({ paths: { memoryDir: () => '/nonexistent/sei-test-memory', profileRoot: () => '/tmp' } }));
vi.mock('../configStore', () => ({ loadConfig: async () => ({}) }));
vi.mock('../characterStore', () => ({
  getCharacter: async () => ({ name: 'Sui', persona: { expanded: 'Sui persona' }, metadata: {} }),
}));
vi.mock('../chat/sdk', () => ({ CHAT_TIMEOUT_MS: 30_000 }));
vi.mock('../llm', () => ({
  activeLlmVision: async () => 'yes',
  buildLlmProvider: async () => ({
    kind: 'anthropic',
    model: 'test',
    call: async (req: { timeoutMs?: number; maxRetries?: number; maxTokens?: number; messages?: Array<{ content: unknown }> }) => {
      h.reqs.push({ timeoutMs: req.timeoutMs, maxRetries: req.maxRetries });
      h.maxTokens.push(req.maxTokens);
      const last = req.messages?.[req.messages.length - 1]?.content;
      const text = Array.isArray(last) ? last.find((b: { type?: string }) => b.type === 'text') : null;
      h.notes.push((text as { text?: string } | null)?.text ?? '');
      if (h.reply instanceof Error) throw h.reply;
      const content: unknown[] = h.reply ? [{ type: 'text', text: h.reply }] : [];
      if (h.tail) content.push(h.tail);
      return { content, usage: {}, stopReason: h.stop };
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
vi.mock('../chat/usageLimit', () => ({ classifyUsageLimit: () => null, raiseUsageLimitPopup: async () => null }));
vi.mock('../knowledge/knowledgeStore', () => ({ readKnowledgeForPrompt: async () => '' }));
vi.mock('../../bot/brain/memory/memoryLog.js', () => ({ appendMemory: async () => {}, humanizeMemoryStamps: (t: string) => t }));
vi.mock('../chat/chatStore', () => ({ appendMessage: async () => {} }));
vi.mock('../playerEndNextStep', () => ({ startPlayerEndNextStep: async () => {}, reportNextStepNotRun: () => {} }));
vi.mock('./backseatLog', () => ({
  createBackseatLog: async () => ({ line: () => {}, close: async () => {} }),
  NULL_BACKSEAT_LOG: { line: () => {}, close: async () => {} },
}));

import {
  endBackseat,
  handleTick,
  initBackseatService,
  RESUME_WINDOW_MS,
  resumedAfterMs,
  startBackseat,
} from './backseatService';

const CH = 'sui';
const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

function tick(kind: BackseatTick['kind']) {
  return handleTick({ characterId: CH, kind, grid: 'data:image/jpeg;base64,AAAA', capturedAt: Date.now() - 9_000, frameAges: [0] });
}

describe('backseat opening look (261023)', () => {
  beforeEach(async () => {
    await endBackseat(CH);
    h.reqs.length = 0;
    h.speech.length = 0;
    h.captures.length = 0;
    h.notes.length = 0;
    h.maxTokens.length = 0;
    h.reply = 'a line';
    h.stop = 'end_turn';
    h.tail = null;
    initBackseatService({
      pushChatMessage: (_c, m, speech) => {
        if (m.role === 'companion') h.speech.push({ text: m.text, ambientCapturedAt: speech?.ambientCapturedAt });
      },
      pushState: () => {},
      pushLine: () => {},
      requestClip: () => {},
      isCallActive: () => true,
    });
    await startBackseat(CH, 'window:1:0', 'Game', 'voice');
  });

  it('runs on the short budget with no SDK retry, and reports that it spoke', async () => {
    await expect(tick('start')).resolves.toBe('spoke');
    expect(h.reqs).toEqual([{ timeoutMs: START_LOOK_TIMEOUT_MS, maxRetries: 0 }]);
  });

  it('is never stale-gated: the opening line carries no frame time', async () => {
    await tick('start');
    expect(h.speech).toEqual([{ text: 'a line', ambientCapturedAt: undefined }]);
  });

  it('other looks keep the normal budget and their frame time', async () => {
    await tick('idle');
    expect(h.reqs).toEqual([{ timeoutMs: 30_000, maxRetries: undefined }]);
    expect(h.maxTokens).toEqual([45]);
    expect(h.speech[0].ambientCapturedAt).toBeTypeOf('number');
  });

  it('a failed call reports failed, an empty one silent', async () => {
    h.reply = Object.assign(new Error('LLM_TIMEOUT: no answer'), { code: 'LLM_TIMEOUT' });
    await expect(tick('start')).resolves.toBe('failed');
    h.reply = '';
    await expect(tick('start')).resolves.toBe('silent');
  });

  it('runs the opening look on its own, larger token cap', async () => {
    await tick('start');
    expect(h.maxTokens).toEqual([80]);
  });

  // 261023: never speak a half sentence.
  it('a line cut mid-sentence with nothing finished before it is not spoken', async () => {
    h.reply = 'hey ouen, that double jump thing you';
    h.stop = 'max_tokens';
    await expect(tick('start')).resolves.toBe('silent');
    expect(h.speech).toEqual([]);
  });

  it('a cut line ends at its last finished sentence', async () => {
    h.reply = 'Hey Ouen! That double jump thing you';
    h.stop = 'max_tokens';
    await expect(tick('start')).resolves.toBe('spoke');
    expect(h.speech.map((x) => x.text)).toEqual(['Hey Ouen!']);
  });

  it('a cut inside a tool call after the line leaves the line whole', async () => {
    h.reply = 'hey ouen that castle is huge';
    h.stop = 'max_tokens';
    h.tail = { type: 'tool_use', name: 'remember', input: {} };
    await expect(tick('start')).resolves.toBe('spoke');
    expect(h.speech.map((x) => x.text)).toEqual(['hey ouen that castle is huge']);
  });

  it('a look with no session is dropped', async () => {
    await endBackseat(CH, 'user_stop');
    await expect(tick('start')).resolves.toBe('dropped');
  });

  it('backseat_ended carries the reason, first-line time and failed turns', async () => {
    h.reply = new Error('boom');
    await tick('start');
    h.reply = 'a line';
    await tick('start');
    await endBackseat(CH, 'capture_lost');
    await flush();
    const ended = h.captures.filter(([e]) => e === 'backseat_ended');
    expect(ended).toHaveLength(1);
    expect(ended[0][1]).toMatchObject({ reason: 'capture_lost', failed_turns: 1, last_error_class: 'timeout' });
    expect(ended[0][1].first_line_ms).toBeTypeOf('number');
  });
});

describe('resumed share (261023)', () => {
  it('resumes only a share she spoke in, inside the window', () => {
    const now = 1_000_000;
    expect(resumedAfterMs(undefined, now)).toBeNull();
    expect(resumedAfterMs({ at: now - 5_000, spoke: false }, now)).toBeNull();
    expect(resumedAfterMs({ at: now - 5_000, spoke: true }, now)).toBe(5_000);
    expect(resumedAfterMs({ at: now - RESUME_WINDOW_MS - 1, spoke: true }, now)).toBeNull();
  });

  it('a share restarted right after one she spoke in opens without a hello', async () => {
    initBackseatService({
      pushChatMessage: () => {},
      pushState: () => {},
      pushLine: () => {},
      requestClip: () => {},
      isCallActive: () => true,
    });
    await endBackseat(CH);
    h.reply = 'a line';
    await startBackseat(CH, 'window:1:0', 'Game', 'voice');
    await tick('start');
    await endBackseat(CH, 'capture_lost');
    h.notes.length = 0;
    await startBackseat(CH, 'window:2:0', 'Game', 'voice');
    await tick('start');
    expect(h.notes[0]).toContain('came back');
    expect(h.notes[0]).not.toContain('just shared their screen');
  });

  it('a share whose predecessor never spoke still gets the hello', async () => {
    await endBackseat(CH);
    // Step past the window the previous test's spoken share left open.
    const realNow = Date.now.bind(Date);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + RESUME_WINDOW_MS + 60_000);
    h.reply = '';
    await startBackseat(CH, 'window:1:0', 'Game', 'voice');
    await tick('start');
    await endBackseat(CH, 'capture_lost');
    h.notes.length = 0;
    h.reply = 'a line';
    await startBackseat(CH, 'window:2:0', 'Game', 'voice');
    await tick('start');
    expect(h.notes[0]).toContain('just shared their screen');
    clock.mockRestore();
  });
});
