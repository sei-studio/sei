/**
 * Opener TTS during the pickup beat (261128, O5 speed, T571): a dial through
 * the REAL useVoiceStore.startCall with a stubbed TTS of realistic latency
 * and a small fake audio queue (slots in order, a slot is heard once it is at
 * the playhead and has audio). The ring floor and the 1s pickup beat stay
 * exactly as they were; what changes is that the buffered opener's TTS is
 * requested when the call goes live, so it is ready when the beat ends.
 *
 * Fake clocks: every number here is the store's own fixed waits plus the stub
 * delays below. The `[T571]` console lines are the before/after measurement.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type Push = { streamId: string; chunk?: ArrayBuffer; done?: boolean; error?: string };
type Slot = {
  cid: string;
  text?: string;
  chunks: number;
  ended: boolean;
  failed: boolean;
  heard: boolean;
  onDone?: (completed: boolean) => void;
};

const h = vi.hoisted(() => ({
  onAudible: null as null | ((cid: string, text?: string) => void),
  slots: [] as Slot[],
  stopped: false,
  heard: [] as Array<{ text?: string; at: number }>,
  ttsListener: null as null | ((p: Push) => void),
}));

/** Any method, any depth: the dictation surface the store pokes. */
function anything(): unknown {
  const fn = (): unknown => anything();
  return new Proxy(fn, {
    get: (_t, k) => (k === 'then' ? undefined : anything()),
    apply: () => anything(),
  });
}

/** The head slot is heard once it has audio; a failed or empty head moves on. */
function advanceFakeQueue(): void {
  for (;;) {
    const head = h.slots[0];
    if (!head || h.stopped) return;
    if (!head.heard && head.chunks > 0) {
      head.heard = true;
      h.heard.push({ text: head.text, at: performance.now() });
      h.onAudible?.(head.cid, head.text);
    }
    if (head.ended || head.failed) {
      h.slots.shift();
      head.onDone?.(head.heard && head.ended);
      continue;
    }
    return;
  }
}

vi.mock('../voice/audioQueue', () => ({
  createAudioQueue: (_onSpeaking: unknown, onAudible: (cid: string, text?: string) => void) => {
    h.onAudible = onAudible;
    h.slots = [];
    h.stopped = false;
    return {
      enqueue: () => {},
      enqueueStream: (cid: string, text?: string, _rate?: number, opts?: { onDone?: (c: boolean) => void }) => {
        const slot: Slot = { cid, text, chunks: 0, ended: false, failed: false, heard: false, onDone: opts?.onDone };
        if (h.stopped) {
          opts?.onDone?.(false);
          return { push: () => {}, end: () => {}, fail: () => {} };
        }
        h.slots.push(slot);
        advanceFakeQueue();
        return {
          push: () => {
            if (slot.ended || slot.failed) return;
            slot.chunks += 1;
            advanceFakeQueue();
          },
          end: () => {
            slot.ended = true;
            advanceFakeQueue();
          },
          fail: () => {
            slot.failed = true;
            advanceFakeQueue();
          },
        };
      },
      speaking: () => h.slots.length > 0,
      clear: () => {
        h.slots = [];
      },
      duck: () => {},
      setOutputMuted: () => {},
      stop: () => {
        h.stopped = true;
        h.slots = [];
      },
    };
  },
}));
vi.mock('../voice/callTones', () => ({
  startRingtone: () => () => {},
  startAmbience: () => () => {},
  playConnectedChime: () => {},
  playHangupChime: () => {},
  playMuteClick: () => {},
}));
vi.mock('../voice/pitchBus', () => ({ warm: () => {} }));
vi.mock('../voice/modelPrefetch', () => ({ prefetchVoiceModel: () => {} }));
vi.mock('../voice/dictation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../voice/dictation')>()),
  createDictation: async (opts: { onMicReady?: () => void }) => {
    await new Promise((r) => setTimeout(r, 300));
    opts.onMicReady?.();
    await new Promise((r) => setTimeout(r, 50));
    return anything();
  },
}));

const DIAL_WALL = 1_800_000_000_000;
/** A line long enough to stream (STREAM_MIN_CHARS is 24). */
const LONG = 'oh hey, you actually called me, what is up?';
const SHORT = 'hey.';

let callState: ReturnType<typeof vi.fn>;
let ttsRequests: Array<{ kind: 'stream' | 'clip'; text: string; at: number }>;
let cfg: Record<string, unknown>;
/** Stream: upstream 200 (resolves) after this, first chunk 50ms later. */
let streamTtfbMs: number;
let clipMs: number;
let streamFails: boolean;
let streamSeq: number;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({
    now: DIAL_WALL,
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
  });
  h.onAudible = null;
  h.slots = [];
  h.heard = [];
  h.stopped = false;
  h.ttsListener = null;
  ttsRequests = [];
  cfg = { ai_backend_kind: 'cloud-proxy' };
  streamTtfbMs = 600;
  clipMs = 500;
  streamFails = false;
  streamSeq = 0;
  callState = vi.fn(async () => {});
  const sei = new Proxy(
    {
      platform: 'linux',
      voiceCallSetActive: callState,
      voiceGreet: vi.fn(async () => {}),
      getConfig: vi.fn(async () => cfg),
      voiceElevenKeyStatus: vi.fn(async () => ({ present: false })),
      speechPackStatus: vi.fn(async () => ({ packs: {} })),
      track: vi.fn(),
      onChatMessage: () => () => {},
      onVoiceTtsChunk: (cb: (p: Push) => void) => {
        h.ttsListener = cb;
        return () => {};
      },
      voiceTtsStream: vi.fn(async (args: { text: string }) => {
        ttsRequests.push({ kind: 'stream', text: args.text, at: performance.now() });
        const streamId = `s${++streamSeq}`;
        await new Promise((r) => setTimeout(r, streamTtfbMs));
        if (streamFails) throw new Error('network down');
        setTimeout(() => h.ttsListener?.({ streamId, chunk: new ArrayBuffer(8) }), 50);
        setTimeout(() => h.ttsListener?.({ streamId, chunk: new ArrayBuffer(8) }), 250);
        setTimeout(() => h.ttsListener?.({ streamId, done: true }), 400);
        return { streamId };
      }),
      voiceTts: vi.fn(async (args: { text: string }) => {
        ttsRequests.push({ kind: 'clip', text: args.text, at: performance.now() });
        await new Promise((r) => setTimeout(r, clipMs));
        return new ArrayBuffer(16);
      }),
    } as Record<string | symbol, unknown>,
    { get: (t, k) => (k in t ? t[k] : vi.fn(async () => undefined)) },
  );
  (globalThis as unknown as { window: unknown }).window = {
    sei,
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    setInterval: (fn: () => void, ms?: number) => setInterval(fn, ms),
    clearInterval: (id: ReturnType<typeof setInterval>) => clearInterval(id),
  };
});

afterEach(() => {
  vi.useRealTimers();
});

function connectTiming(): Record<string, number | string> {
  const calls = callState.mock.calls.map((c) => c[0] as Record<string, unknown>);
  const report = calls.find((a) => a.characterId === 'sui' && a.active === false);
  return (report?.connect ?? {}) as Record<string, number | string>;
}

/** Dial, land the greeting during the ring, go live, let it play out, hang up. */
async function dialWithGreeting(text: string | string[], label: string): Promise<Record<string, number | string>> {
  const { useVoiceStore } = await import('./useVoiceStore');
  const { notifyCompanionText } = await import('../voice/voiceBridge');
  const dial = useVoiceStore.getState().startCall('sui');
  await vi.advanceTimersByTimeAsync(900);
  for (const line of Array.isArray(text) ? text : [text]) notifyCompanionText('sui', line, {});
  await vi.advanceTimersByTimeAsync(5000);
  await dial;
  useVoiceStore.getState().endCall('user_hangup');
  const c = connectTiming();
  console.log(
    `[T571] ${label}: first_line_ms=${c.first_line_ms} connect_ms=${c.connect_ms} ` +
      `opener_tts_ms=${c.opener_tts_ms} opener_queued_ms=${c.opener_queued_ms} ` +
      `(after connect: ${(c.first_line_ms as number) - (c.connect_ms as number)}ms)`,
  );
  return c;
}

describe('opener TTS during the pickup beat (261128, T571)', () => {
  it('streamed opener (600ms to first byte): requested at connect, heard as the beat ends', async () => {
    const c = await dialWithGreeting(LONG, 'stream ttfb 600');
    const connect = c.connect_ms as number;
    // The beat itself is unchanged: handed to the queue exactly 1s after connect.
    expect((c.opener_queued_ms as number) - connect).toBe(1000);
    // TTS asked for at connect (not after the beat), once.
    expect(ttsRequests).toHaveLength(1);
    expect(c.opener_tts_ms).toBe(connect);
    // Its first chunk (650ms) landed inside the 1s beat, so it plays the moment
    // the beat ends instead of 650ms after it.
    expect(c.first_line_ms).toBe(connect + 1000);
  });

  it('a TTS slower than the beat still saves the whole beat', async () => {
    streamTtfbMs = 1500;
    const c = await dialWithGreeting(LONG, 'stream ttfb 1500');
    expect(c.first_line_ms).toBe((c.connect_ms as number) + 1550);
  });

  it('short opener (whole clip, 500ms): same', async () => {
    const c = await dialWithGreeting(SHORT, 'clip 500');
    expect(ttsRequests.map((r) => r.kind)).toEqual(['clip']);
    expect(c.opener_tts_ms).toBe(c.connect_ms);
    expect(c.first_line_ms).toBe((c.connect_ms as number) + 1000);
  });

  it('a multi-line greeting keeps its order and synthesizes each line once', async () => {
    await dialWithGreeting([SHORT, LONG, 'and a third line that also streams.'], 'three lines');
    expect(ttsRequests.map((r) => r.text)).toEqual([SHORT, LONG, 'and a third line that also streams.']);
    expect(h.heard.map((x) => x.text)).toEqual([SHORT, LONG, 'and a third line that also streams.']);
  });

  it('hung up during the pickup beat: the early synthesis is discarded, nothing plays', async () => {
    const { useVoiceStore } = await import('./useVoiceStore');
    const { notifyCompanionText } = await import('../voice/voiceBridge');
    const dial = useVoiceStore.getState().startCall('sui');
    await vi.advanceTimersByTimeAsync(900);
    notifyCompanionText('sui', LONG, {});
    // Connect lands at ~1360ms; hang up 300ms into the beat.
    await vi.advanceTimersByTimeAsync(760);
    expect(useVoiceStore.getState().status).toBe('live');
    useVoiceStore.getState().endCall('user_hangup');
    await vi.advanceTimersByTimeAsync(5000);
    await dial;
    expect(h.heard).toEqual([]);
    expect(h.slots).toEqual([]);
    expect(connectTiming()).not.toHaveProperty('first_line_ms');
    // A fresh call afterwards is unaffected by the discarded stream.
    const dial2 = useVoiceStore.getState().startCall('sui');
    await vi.advanceTimersByTimeAsync(900);
    notifyCompanionText('sui', 'second call, second hello there.', {});
    await vi.advanceTimersByTimeAsync(5000);
    await dial2;
    expect(h.heard.map((x) => x.text)).toEqual(['second call, second hello there.']);
  });

  it('group call: the dialed companion leaves during the beat, her fetched opener never plays', async () => {
    const { useVoiceStore } = await import('./useVoiceStore');
    const { notifyCompanionText } = await import('../voice/voiceBridge');
    const dial = useVoiceStore.getState().startCall('sui');
    useVoiceStore.getState().addParticipant('lyra'); // joins while dialing
    await vi.advanceTimersByTimeAsync(900);
    notifyCompanionText('sui', LONG, {});
    await vi.advanceTimersByTimeAsync(760);
    expect(useVoiceStore.getState().status).toBe('live');
    expect(ttsRequests).toHaveLength(1);
    useVoiceStore.getState().removeParticipant('sui');
    await vi.advanceTimersByTimeAsync(3000);
    await dial;
    expect(useVoiceStore.getState().participants).toEqual(['lyra']);
    expect(h.heard).toEqual([]);
    // Lyra still speaks normally afterwards.
    notifyCompanionText('lyra', 'well, that was quick of her to leave.', {});
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.heard.map((x) => x.text)).toEqual(['well, that was quick of her to leave.']);
    useVoiceStore.getState().endCall('user_hangup');
  });

  it('the early TTS fails: the opener is shown as text after the beat, never retried twice', async () => {
    streamFails = true;
    const { useVoiceStore } = await import('./useVoiceStore');
    const { notifyCompanionText } = await import('../voice/voiceBridge');
    const dial = useVoiceStore.getState().startCall('sui');
    await vi.advanceTimersByTimeAsync(900);
    notifyCompanionText('sui', LONG, {});
    await vi.advanceTimersByTimeAsync(5000);
    await dial;
    expect(ttsRequests).toHaveLength(1);
    expect(h.heard).toEqual([]);
    expect(useVoiceStore.getState().lastSpoken).toBe(LONG);
    expect(useVoiceStore.getState().voiceFailing).toBe(true);
  });

  it('greeting timeout: nothing to fetch early, the late line is spoken as it lands', { timeout: 20_000 }, async () => {
    const { useVoiceStore } = await import('./useVoiceStore');
    const { notifyCompanionText } = await import('../voice/voiceBridge');
    const dial = useVoiceStore.getState().startCall('sui');
    // Ring floor 1300 + the 5s greeting cap, then the 1s beat.
    await vi.advanceTimersByTimeAsync(7500);
    await dial;
    expect(useVoiceStore.getState().status).toBe('live');
    expect(ttsRequests).toHaveLength(0);
    notifyCompanionText('sui', LONG, {});
    await vi.advanceTimersByTimeAsync(2000);
    expect(ttsRequests).toHaveLength(1);
    expect(h.heard.map((x) => x.text)).toEqual([LONG]);
    useVoiceStore.getState().endCall('user_hangup');
    const c = connectTiming();
    expect(c.gate).toBe('greeting_timeout');
    expect(c.opener_tts_ms).toBe(c.opener_queued_ms);
  });

  it('call scene walk-on: the opener is fetched at connect and plays when she arrives', async () => {
    const { useVoiceStore } = await import('./useVoiceStore');
    const { notifyCompanionText } = await import('../voice/voiceBridge');
    useVoiceStore.getState().setIntroHold(true);
    const dial = useVoiceStore.getState().startCall('sui');
    await vi.advanceTimersByTimeAsync(900);
    notifyCompanionText('sui', LONG, {});
    await vi.advanceTimersByTimeAsync(2500);
    await dial;
    expect(h.heard).toEqual([]); // still walking on
    expect(ttsRequests).toHaveLength(1);
    const arriveAt = performance.now();
    useVoiceStore.getState().setIntroHold(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.heard.map((x) => x.text)).toEqual([LONG]);
    expect(h.heard[0].at).toBe(arriveAt);
    useVoiceStore.getState().endCall('user_hangup');
  });

  it('Kokoro (sentence by sentence): the first sentence is fetched at connect', async () => {
    cfg = { ai_backend_kind: 'local', tts_engine: 'local', local_tts_model: 'kokoro' };
    const c = await dialWithGreeting('Hey you. What are we doing today?', 'kokoro clip 500');
    expect(ttsRequests.map((r) => r.text)).toEqual(['Hey you.', 'What are we doing today?']);
    expect(ttsRequests[0].at).toBe(c.connect_ms);
    expect(c.first_line_ms).toBe((c.connect_ms as number) + 1000);
    expect(h.heard.map((x) => x.text)).toEqual(['Hey you.', 'What are we doing today?']);
  });
});
