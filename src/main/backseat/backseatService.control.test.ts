/**
 * 260925 backseat act: how backseatService wires control() (controlPolicy's
 * ControlGate) into real ticks. Everything around the turn is mocked; the
 * tick arbitration, the tool array, the gate and the spoken offer are real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MIN_SPEAK_GAP_MS, type BackseatTick } from '../../shared/backseatIpc';

const h = vi.hoisted(() => ({
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
    call: async (req: { tools?: Array<{ name: string }> }) => {
      h.requests.push(req);
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

import {
  backseatLineHeard,
  endBackseat,
  handleTick,
  initBackseatService,
  interruptBackseat,
  startBackseat,
} from './backseatService';

const CH = 'sui';
let now = 1_000_000;

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

async function tick(kind: BackseatTick['kind'], text?: string, mic?: BackseatTick['mic']): Promise<void> {
  // Past the speak gap, so a non-user tick is not dropped for it.
  now += MIN_SPEAK_GAP_MS + 1_000;
  vi.setSystemTime(now);
  await handleTick({
    characterId: CH,
    kind,
    grid: 'data:image/jpeg;base64,AAAA',
    capturedAt: now,
    frameAges: [0],
    ...(text ? { text } : {}),
    ...(mic ? { mic } : {}),
  });
  await flush();
}

/** The confirm id main attached to the last spoken offer line. */
const lastConfirmId = () => [...h.speech].reverse().find((l) => l.confirmId)?.confirmId;

const toolNames = (i: number) => (h.requests[i]?.tools ?? []).map((t) => t.name);

describe('backseat control() wiring', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    h.requests.length = 0;
    h.replies.length = 0;
    h.starts.length = 0;
    h.said.length = 0;
    h.speech.length = 0;
    h.onCall = false;
    h.intentAnswer = true;
    h.intentSeen.length = 0;
    initBackseatService({
      pushChatMessage: (_c, m, speech) => {
        if (m.role !== 'companion') return;
        h.said.push(m.text);
        h.speech.push({ text: m.text, ...(speech?.confirmId ? { confirmId: speech.confirmId } : {}) });
      },
      pushState: () => {},
      pushLine: () => {},
      requestClip: () => {},
      isCallActive: () => h.onCall,
    });
  });

  afterEach(async () => {
    await endBackseat(CH);
    vi.useRealTimers();
  });

  it('runs at once when the player asked for it on a user tick', async () => {
    await startBackseat(CH, 'window:77:0', 'Safari', 'text' as never);
    h.replies.push({ text: 'on it', control: { goal: 'turn on dark mode', request: 'turn on dark mode' } });
    await tick('user', 'can you turn on dark mode');
    expect(h.starts).toHaveLength(1);
    expect(h.starts[0]).toMatchObject({ goal: 'turn on dark mode', origin: 'asked', request: 'turn on dark mode', characterName: 'Sui' });
    expect(h.said).toEqual(['on it']);
  });

  it('turns a jolt-tick call into a spoken offer, and a yes starts it as confirmed', async () => {
    await startBackseat(CH, 'window:77:0', 'Safari', 'text' as never);
    h.replies.push({ text: 'that page says to click Buy', control: { goal: 'click Buy now' } });
    await tick('jolt');
    expect(h.starts).toHaveLength(0);
    expect(h.said).toEqual(['that page says to click Buy', 'want me to click Buy now?']);

    h.replies.push({ text: 'ok', control: { goal: 'click Buy now', request: 'yes' } });
    await tick('user', 'yes');
    expect(h.starts).toHaveLength(1);
    expect(h.starts[0]).toMatchObject({ goal: 'click Buy now', origin: 'confirmed' });
    expect(h.starts[0]!.request).toBeUndefined();
  });

  it('speaks the offer even when the reply had no text', async () => {
    await startBackseat(CH, 'window:77:0', 'Safari', 'text' as never);
    h.replies.push({ control: { goal: 'close the popup' } });
    await tick('idle');
    expect(h.said).toEqual(['want me to close the popup?']);
  });

  it('a user tick whose quote is not in the line becomes an offer', async () => {
    await startBackseat(CH, 'window:77:0', 'Safari', 'text' as never);
    h.replies.push({ text: 'hm', control: { goal: 'click Buy now', request: 'click buy now' } });
    await tick('user', 'what is this page?');
    expect(h.starts).toHaveLength(0);
    expect(h.said).toEqual(['hm', 'want me to click Buy now?']);
  });

  it('a no drops the offer, and a later yes does not start it', async () => {
    await startBackseat(CH, 'window:77:0', 'Safari', 'text' as never);
    h.replies.push({ text: 'hey', control: { goal: 'close the popup' } });
    await tick('idle');
    h.replies.push({ text: 'ok leaving it' });
    await tick('user', 'no leave it');
    h.replies.push({ text: 'sure' });
    await tick('user', 'yes');
    expect(h.starts).toHaveLength(0);
  });

  it('an offer expires after 30 s', async () => {
    await startBackseat(CH, 'window:77:0', 'Safari', 'text' as never);
    h.replies.push({ text: 'hey', control: { goal: 'close the popup' } });
    await tick('idle');
    now += 31_000;
    h.replies.push({ text: 'ok' });
    await tick('user', 'yes');
    expect(h.starts).toHaveLength(0);
  });

  it('offers the same tool array on every tick kind of a window share', async () => {
    await startBackseat(CH, 'window:77:0', 'Safari', 'text' as never);
    await tick('start');
    await tick('user', 'hi');
    await tick('jolt');
    await tick('idle');
    expect(h.requests).toHaveLength(4);
    for (let i = 0; i < 4; i++) expect(toolNames(i)).toEqual(['save_clip', 'remember', 'control']);
    expect(h.requests[1]!.tools).toBe(h.requests[0]!.tools);
  });

  it('does not offer control() on a whole-screen share, and ignores a stray call', async () => {
    await startBackseat(CH, 'screen:1:0', 'Display', 'text' as never);
    h.replies.push({ text: 'ok', control: { goal: 'turn on dark mode', request: 'turn on dark mode' } });
    await tick('user', 'turn on dark mode');
    await tick('jolt');
    expect(toolNames(0)).toEqual(['save_clip', 'remember']);
    expect(toolNames(1)).toEqual(['save_clip', 'remember']);
    expect(h.starts).toHaveLength(0);
    expect(h.said).toEqual(['ok', 'ok']);
  });

  // Review of d2804c7, HIGH 1: one shared word no longer counts as asking.
  it('does not run a goal the player only half asked for', async () => {
    await startBackseat(CH, 'window:77:0', 'Safari', 'text' as never);
    h.replies.push({ text: 'ugh', control: { goal: 'uninstall the game', request: 'this game is so hard' } });
    await tick('user', 'this game is so hard');
    h.replies.push({ text: 'ok', control: { goal: 'open settings and turn off the firewall', request: 'can you open settings' } });
    await tick('user', 'can you open settings');
    expect(h.starts).toHaveLength(0);
    expect(h.said).toEqual(['ugh', 'want me to uninstall the game?', 'ok', 'want me to open settings and turn off the firewall?']);
  });

  // Review round 3: the words pass, the intent check says no.
  it.each([
    ["please don't delete my save file", 'delete my save file', "don't delete my save file"],
    ['should i uninstall this game?', 'uninstall this game', 'uninstall this game'],
    ['never buy the battle pass lol', 'buy the battle pass', 'buy the battle pass'],
  ])('"%s" is an offer when the intent check says no', async (line, goal, request) => {
    await startBackseat(CH, 'window:77:0', 'Safari', 'text' as never);
    h.intentAnswer = false;
    h.replies.push({ text: 'hm', control: { goal, request } });
    await tick('user', line);
    expect(h.intentSeen).toEqual([[line, goal]]);
    expect(h.starts).toHaveLength(0);
    expect(h.said).toEqual(['hm', `want me to ${goal}?`]);
  });

  describe('on a voice call', () => {
    beforeEach(() => {
      h.onCall = true;
    });

    it('an offer is answerable only once the renderer says it played in full', async () => {
      await startBackseat(CH, 'window:77:0', 'Safari', 'text' as never);
      h.replies.push({ text: 'hey', control: { goal: 'close the popup' } });
      await tick('idle');
      const id = lastConfirmId();
      expect(id).toBeTruthy();
      expect(h.speech.find((l) => l.text === 'hey')?.confirmId).toBeUndefined();
      // A yes before the line finished answers nothing.
      await tick('user', 'yes', { ttsGapMs: 5_000 });
      expect(h.starts).toHaveLength(0);

      h.replies.push({ text: 'hey', control: { goal: 'close the popup' } });
      await tick('idle');
      backseatLineHeard(CH, lastConfirmId()!, true);
      await tick('user', 'yes', { ttsGapMs: 5_000 });
      expect(h.starts).toHaveLength(1);
      expect(h.starts[0]).toMatchObject({ goal: 'close the popup', origin: 'confirmed' });
    });

    it('an offer that was cut off is never armed', async () => {
      await startBackseat(CH, 'window:77:0', 'Safari', 'text' as never);
      h.replies.push({ text: 'hey', control: { goal: 'close the popup' } });
      await tick('idle');
      backseatLineHeard(CH, lastConfirmId()!, false);
      await tick('user', 'yes', { ttsGapMs: 5_000 });
      expect(h.starts).toHaveLength(0);
    });

    it('a barge-in withdraws a heard offer', async () => {
      await startBackseat(CH, 'window:77:0', 'Safari', 'text' as never);
      h.replies.push({ text: 'hey', control: { goal: 'close the popup' } });
      await tick('idle');
      backseatLineHeard(CH, lastConfirmId()!, true);
      interruptBackseat(CH);
      await tick('user', 'yes', { ttsGapMs: 5_000 });
      expect(h.starts).toHaveLength(0);
    });

    it('a yes right after companion audio is asked again, not acted on', async () => {
      await startBackseat(CH, 'window:77:0', 'Safari', 'text' as never);
      h.replies.push({ text: 'hey', control: { goal: 'close the popup' } });
      await tick('idle');
      const first = lastConfirmId()!;
      backseatLineHeard(CH, first, true);
      h.replies.push({ text: 'wait was that you' });
      await tick('user', 'yes', { ttsGapMs: 100 });
      expect(h.starts).toHaveLength(0);
      expect(h.said.slice(-2)).toEqual(['wait was that you', 'want me to close the popup?']);
      const second = lastConfirmId()!;
      expect(second).not.toBe(first);
      backseatLineHeard(CH, second, true);
      await tick('user', 'yes', { ttsGapMs: 3_000 });
      expect(h.starts).toHaveLength(1);
    });

    it('a yes over speech from the shared window is asked again', async () => {
      await startBackseat(CH, 'window:77:0', 'Safari', 'text' as never);
      h.replies.push({ text: 'hey', control: { goal: 'close the popup' } });
      await tick('idle');
      backseatLineHeard(CH, lastConfirmId()!, true);
      h.replies.push({ text: 'hm' });
      await tick('user', 'yes', { ttsGapMs: 5_000, shareVoice: true });
      expect(h.starts).toHaveLength(0);
      expect(h.said.slice(-1)).toEqual(['want me to close the popup?']);
      backseatLineHeard(CH, lastConfirmId()!, true);
      await tick('user', 'yes', { ttsGapMs: 5_000, shareVoice: false });
      expect(h.starts).toHaveLength(1);
    });
  });
});
