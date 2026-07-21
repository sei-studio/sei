/**
 * Watch (screen share) session lifecycle — the parts most likely to leak
 * spend or break the couch illusion:
 *   - mutual exclusion: no session while summoned or while a board game is open
 *   - the first frame runs an opening look; a say() reaches the chat
 *   - NO tool call = silence (nothing pushed, nothing persisted)
 *   - unchanged frames never reach the LLM (the change gate holds)
 *   - note() lands in the next turn's prompt (the rolling session summary)
 *   - the 20s unprompted-say cooldown drops a too-soon line
 *   - player chat rides the session queue and gets a normal text reply
 *   - all-black captures flip `blank` (the macOS permission signal)
 *   - stop posts the 'Screen share' transcript row + the MEMORY.md line
 * The LLM, profile derivation, and capture are mocked; the FSM queue and the
 * change gate are real. Frames are synthetic gray buffers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _setUserDataOverride, paths } from '../paths';
import type { ChatMessage } from '../../shared/ipc';
import type { WatchSessionState, WatchPreviewPush } from '../../shared/watchIpc';
import { GRAY_W, GRAY_H, type CapturedFrame } from './changeGate';

const { createSpy, getCharacterSpy, patchCharacterSpy } = vi.hoisted(() => ({
  createSpy: vi.fn(),
  getCharacterSpy: vi.fn(),
  patchCharacterSpy: vi.fn(),
}));
vi.mock('../chat/sdk', () => ({
  CHAT_TIMEOUT_MS: 30_000,
  buildChatSdk: vi.fn(async () => ({ client: { messages: { create: createSpy } }, model: 'test-model' })),
}));
vi.mock('../characterStore', () => ({
  getCharacter: getCharacterSpy,
  patchCharacter: patchCharacterSpy,
}));
vi.mock('../configStore', () => ({
  loadConfig: vi.fn(async () => ({ preferred_name: 'Player' })),
}));
vi.mock('./watchProfile', () => ({
  getOrCreateWatchProfile: vi.fn(async () => ({ hype: 3, styleNote: 'testy', source: 'auto' })),
}));

import {
  initWatchService,
  startWatch,
  stopWatch,
  endWatchForTakeover,
  handlePlayerChat,
  getWatchState,
  isWatchActive,
  shutdownWatch,
  WATCH_TIMING,
  WATCH_GATE,
} from './watchService';

const CHAR = '88888888-8888-4888-8888-888888888888';
const SOURCE = 'window:42:0';
const PIXELS = GRAY_W * GRAY_H;

let dir: string;
let statePushes: WatchSessionState[];
let previewPushes: WatchPreviewPush[];
let chatPushed: ChatMessage[];
let summoned: boolean;
let gameActive: boolean;
/** The frame the fake capture returns next (null = source gone). */
let nextFrame: (() => CapturedFrame | null) | null;

function frameOf(value: number): CapturedFrame {
  return {
    jpegBase64: Buffer.from(`jpeg-${value}`).toString('base64'),
    gray: new Uint8Array(PIXELS).fill(value),
    previewDataUrl: `data:image/jpeg;base64,${value}`,
    capturedAt: Date.now(),
  };
}

async function waitFor<T>(fn: () => T | undefined, ms = 4000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Frame/idle-turn mock: call say() once, end on the tool_result hop. */
function sayMock(line: string) {
  return async (params: { messages?: unknown[]; tools?: { name: string }[] }) => {
    const msgs = JSON.stringify(params.messages ?? []);
    if (msgs.includes('tool_result')) return { content: [], usage: {} };
    if (params.tools?.some((t) => t.name === 'say')) {
      return {
        content: [
          { type: 'text', text: 'private scratchpad reasoning' },
          { type: 'tool_use', id: `tu-${Math.random()}`, name: 'say', input: { text: line } },
        ],
        usage: {},
      };
    }
    return { content: [{ type: 'text', text: 'plain reply' }], usage: {} };
  };
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'sei-watch-'));
  _setUserDataOverride(dir);
  statePushes = [];
  previewPushes = [];
  chatPushed = [];
  summoned = false;
  gameActive = false;
  nextFrame = () => frameOf(200);
  initWatchService({
    pushState: (s) => statePushes.push(s),
    pushPreview: (p) => previewPushes.push(p),
    pushChatMessage: (_id, msg) => chatPushed.push(msg),
    isSummoned: () => summoned,
    isGameActive: () => gameActive,
    captureFrame: async () => (nextFrame ? nextFrame() : null),
  });
  getCharacterSpy.mockImplementation(async () => ({
    id: CHAR,
    name: 'Marv',
    persona: { source: 'grumpy robot', expanded: 'PERSONA' },
    metadata: {},
  }));
  patchCharacterSpy.mockImplementation(async () => ({}));
  createSpy.mockReset();
  createSpy.mockResolvedValue({ content: [], usage: {} });
  // Fast, deterministic defaults: quick polls, no floor, idle far away, every
  // session long enough to log.
  WATCH_TIMING.pollMs = 25;
  WATCH_TIMING.idleMinMs = 120_000;
  WATCH_TIMING.idleMaxMs = 120_000;
  WATCH_TIMING.minLoggedSessionMs = 0;
  WATCH_TIMING.blankPollThreshold = 3;
  WATCH_TIMING.missedPollThreshold = 3;
  WATCH_GATE.floorMs = 0;
  WATCH_GATE.lowIntervalMs = 0;
  WATCH_GATE.quietStepMs = 0;
  WATCH_GATE.quietMaxIntervalMs = 0;
  WATCH_GATE.highDelta = 28;
  WATCH_GATE.lowDelta = 8;
});

afterEach(async () => {
  await shutdownWatch();
  _setUserDataOverride(null);
  await rm(dir, { recursive: true, force: true });
});

describe('watch session lifecycle', () => {
  it('refuses to start while summoned in Minecraft', async () => {
    summoned = true;
    await expect(startWatch(CHAR, SOURCE)).rejects.toThrow(/WATCH_MC_SESSION_ACTIVE/);
  });

  it('refuses to start while a chess/connect4 game is open', async () => {
    gameActive = true;
    await expect(startWatch(CHAR, SOURCE)).rejects.toThrow(/WATCH_GAME_ACTIVE/);
  });

  it('refuses to start when the picked source is gone', async () => {
    nextFrame = () => null;
    await expect(startWatch(CHAR, SOURCE)).rejects.toThrow(/WATCH_SOURCE_GONE/);
  });

  it('cloud credit pre-flight refuses when depleted and fails OPEN on errors', async () => {
    let raised = 0;
    initWatchService({
      pushState: (s) => statePushes.push(s),
      pushPreview: () => {},
      pushChatMessage: () => {},
      isSummoned: () => false,
      isGameActive: () => false,
      captureFrame: async () => frameOf(200),
      creditsDepleted: async () => true,
      onCreditsDepleted: () => raised++,
    });
    await expect(startWatch(CHAR, SOURCE)).rejects.toThrow(/WATCH_CREDITS_DEPLETED/);
    expect(raised).toBe(1);

    // A throwing gate must not block (fail open).
    initWatchService({
      pushState: (s) => statePushes.push(s),
      pushPreview: () => {},
      pushChatMessage: (_id, m) => chatPushed.push(m),
      isSummoned: () => false,
      isGameActive: () => false,
      captureFrame: async () => frameOf(200),
      creditsDepleted: async () => {
        throw new Error('network down');
      },
    });
    const state = await startWatch(CHAR, SOURCE);
    expect(state.status).toBe('active');
  });

  it('the first frame runs an opening look and say() reaches the chat', async () => {
    createSpy.mockImplementation(sayMock('oh you are on this again'));
    const state = await startWatch(CHAR, SOURCE);
    expect(state.status).toBe('active');
    expect(isWatchActive(CHAR)).toBe(true);

    const said = await waitFor(() => chatPushed.find((m) => m.text === 'oh you are on this again'));
    expect(said.role).toBe('companion');
    // The frame turn carried exactly ONE image block.
    const frameCall = createSpy.mock.calls.find((c) =>
      JSON.stringify((c[0] as { messages: unknown }).messages).includes('"type":"image"'),
    );
    expect(frameCall).toBeTruthy();
    const imgCount = (JSON.stringify((frameCall![0] as { messages: unknown }).messages).match(/"type":"image"/g) ?? []).length;
    expect(imgCount).toBe(1);
    // Preview snapshots stream to the renderer.
    await waitFor(() => (previewPushes.length > 0 ? true : undefined));
  });

  it('no tool call = silence: nothing is pushed to the chat', async () => {
    createSpy.mockResolvedValue({
      content: [{ type: 'text', text: 'thinking to myself, not worth a line' }],
      usage: {},
    });
    await startWatch(CHAR, SOURCE);
    await waitFor(() => (createSpy.mock.calls.length > 0 ? true : undefined));
    await new Promise((r) => setTimeout(r, 150));
    expect(chatPushed).toHaveLength(0);
  });

  it('unchanged frames never reach the LLM (the gate holds after the first send)', async () => {
    createSpy.mockImplementation(sayMock('one line'));
    await startWatch(CHAR, SOURCE); // frame value 200 → opening look
    await waitFor(() => (createSpy.mock.calls.length > 0 ? true : undefined));
    const callsAfterOpen = createSpy.mock.calls.length;
    // Same frame keeps polling in; no further turns.
    await new Promise((r) => setTimeout(r, 250));
    expect(createSpy.mock.calls.length).toBe(callsAfterOpen);
    const st = getWatchState(CHAR)!;
    expect(st.framesSent).toBe(1);
    // A hard change passes the gate again (floor zeroed in this suite).
    nextFrame = () => frameOf(20); // delta 180 vs last sent
    await waitFor(() => (getWatchState(CHAR)!.framesSent >= 2 ? true : undefined));
  });

  it('note() lands in the next turn prompt (rolling session summary)', async () => {
    let turn = 0;
    createSpy.mockImplementation(async (params: { messages?: unknown[]; system?: { text: string }[] }) => {
      const msgs = JSON.stringify(params.messages ?? []);
      if (msgs.includes('tool_result')) return { content: [], usage: {} };
      turn++;
      if (turn === 1) {
        return {
          content: [{ type: 'tool_use', id: 'n1', name: 'note', input: { text: 'they picked the sniper build' } }],
          usage: {},
        };
      }
      return { content: [], usage: {} };
    });
    await startWatch(CHAR, SOURCE);
    await waitFor(() => (turn >= 1 ? true : undefined));
    nextFrame = () => frameOf(20);
    await waitFor(() => (turn >= 2 ? true : undefined));
    const secondSys = (createSpy.mock.calls.at(-1)![0] as { system: { text: string }[] }).system
      .map((b) => b.text)
      .join('\n');
    expect(secondSys).toContain('they picked the sniper build');
    expect(secondSys).toContain('# SCREEN SHARE');
    expect(secondSys).toContain('silence is the normal outcome');
  });

  it('the 20s unprompted-say cooldown drops a too-soon second line', async () => {
    createSpy.mockImplementation(sayMock('line'));
    await startWatch(CHAR, SOURCE);
    await waitFor(() => (chatPushed.length === 1 ? true : undefined));
    // Second changed frame arrives well inside the 20s window.
    nextFrame = () => frameOf(20);
    await waitFor(() => (getWatchState(CHAR)!.framesSent >= 2 ? true : undefined));
    await new Promise((r) => setTimeout(r, 150));
    expect(chatPushed).toHaveLength(1); // the second say was suppressed
  });

  it('player chat rides the session queue and gets a normal text reply', async () => {
    createSpy.mockImplementation(async (params: { system?: { text: string }[] }) => {
      const sys = (params.system ?? []).map((b) => b.text).join('\n');
      if (sys.includes('is talking to you while playing')) {
        return { content: [{ type: 'text', text: 'yeah i saw that' }], usage: {} };
      }
      return { content: [], usage: {} };
    });
    await startWatch(CHAR, SOURCE);
    const res = await handlePlayerChat({ characterId: CHAR, text: 'did you see that?' });
    expect(res).not.toBeNull();
    expect(res!.replies.map((r) => r.text)).toContain('yeah i saw that');
    // The reply also landed in the pushed chat stream.
    expect(chatPushed.map((m) => m.text)).toContain('yeah i saw that');
  });

  it('handlePlayerChat returns null with no session (ipc falls through)', async () => {
    const res = await handlePlayerChat({ characterId: CHAR, text: 'hello' });
    expect(res).toBeNull();
  });

  it('all-black captures flip blank (the macOS permission signal) and recover', async () => {
    nextFrame = () => frameOf(0); // all-black from the start
    await startWatch(CHAR, SOURCE);
    const blankState = await waitFor(() => statePushes.find((s) => s.blank === true));
    expect(blankState.status).toBe('active');
    // No LLM turns were burned on black rectangles.
    expect(createSpy.mock.calls.length).toBe(0);
    // Light returns: blank clears.
    nextFrame = () => frameOf(180);
    await waitFor(() =>
      statePushes.some((s) => s.blank === false && statePushes.indexOf(s) > statePushes.indexOf(blankState))
        ? true
        : undefined,
    );
  });

  it('a vanished source ends the session as source-lost', async () => {
    await startWatch(CHAR, SOURCE);
    nextFrame = () => null;
    const ended = await waitFor(() => statePushes.find((s) => s.status === 'ended'));
    expect(ended.endedReason).toBe('source-lost');
  });

  it('stop posts the Screen share transcript row and the MEMORY.md line', async () => {
    await startWatch(CHAR, SOURCE);
    await stopWatch(CHAR);
    const row = await waitFor(() =>
      chatPushed.find((m) => (m as { event?: { game?: string } }).event?.game === 'Screen share'),
    );
    const ev = (row as { event: { kind: string; durationMs: number } }).event;
    expect(ev.kind).toBe('play');
    expect(ev.durationMs).toBeGreaterThanOrEqual(0);
    expect(row.text).toMatch(/You and Marv watched your screen together/);
    expect(row.text).not.toMatch(/—/); // no em dash in user copy

    const memPath = path.join(paths.memoryDir(CHAR), 'MEMORY.md');
    let memory = '';
    const t0 = Date.now();
    while (Date.now() - t0 < 4000) {
      memory = await readFile(memPath, 'utf8').catch(() => '');
      if (memory.includes("watched Player's screen")) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(memory).toContain("watched Player's screen");
    expect(memory).toContain(SOURCE); // test capture names the source by id
    expect(getWatchState(CHAR)).toBeNull();
  });

  it('a takeover (summon / board game) ends the session as superseded', async () => {
    await startWatch(CHAR, SOURCE);
    await endWatchForTakeover(CHAR);
    const ended = statePushes.find((s) => s.status === 'ended');
    expect(ended?.endedReason).toBe('superseded');
    expect(isWatchActive(CHAR)).toBe(false);
  });
});
