/**
 * Call connect timing wiring (261127, T563): a dial through the REAL
 * useVoiceStore.startCall, with the mic, speech recognition, audio queue and
 * call sounds stubbed, reports its connect phases on the dialed companion's
 * hang-up (voice_call_ended via voice:call-state). Fake clocks, so the
 * numbers are the store's own fixed waits plus the stub delays below.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  onAudible: null as null | ((cid: string, text: string) => void),
  micDelayMs: 0,
  sttDelayMs: 0,
}));

/** Any method, any depth: the audio queue / dictation surface the store pokes. */
function anything(): unknown {
  const fn = (): unknown => anything();
  return new Proxy(fn, {
    get: (_t, k) => (k === 'then' ? undefined : anything()),
    apply: () => anything(),
  });
}

vi.mock('../voice/audioQueue', () => ({
  createAudioQueue: (_onSpeaking: unknown, onAudible: (cid: string, text: string) => void) => {
    h.onAudible = onAudible;
    return anything();
  },
}));
vi.mock('../voice/sentenceTts', () => ({ createSentenceTts: () => anything() }));
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
    await new Promise((r) => setTimeout(r, h.micDelayMs));
    opts.onMicReady?.();
    await new Promise((r) => setTimeout(r, h.sttDelayMs));
    return anything();
  },
}));

const DIAL_WALL = 1_800_000_000_000;

let callState: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ now: DIAL_WALL, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
  h.onAudible = null;
  h.micDelayMs = 300;
  h.sttDelayMs = 50;
  callState = vi.fn(async () => {});
  const sei = new Proxy(
    {
      platform: 'linux',
      voiceCallSetActive: callState,
      voiceGreet: vi.fn(async () => {}),
      getConfig: vi.fn(async () => ({ ai_backend_kind: 'cloud-proxy' })),
      voiceElevenKeyStatus: vi.fn(async () => ({ present: false })),
      speechPackStatus: vi.fn(async () => ({ packs: {} })),
      track: vi.fn(),
      onChatMessage: () => () => {},
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

function hangUpReport(characterId: string): Record<string, unknown> | undefined {
  const calls = callState.mock.calls.map((c) => c[0] as Record<string, unknown>);
  return calls.find((a) => a.characterId === characterId && a.active === false);
}

describe('call connect timing through startCall (261127, T563)', () => {
  it('a greeting that is ready during the ring: connect at the ring floor, opener after the pickup beat', async () => {
    const { useVoiceStore } = await import('./useVoiceStore');
    const { notifyCompanionText } = await import('../voice/voiceBridge');

    const dial = useVoiceStore.getState().startCall('sui');
    // Main sends the greeting's LLM request 120ms in; the line lands at 900ms.
    await vi.advanceTimersByTimeAsync(900);
    notifyCompanionText('sui', 'oh hey, you called.', { replyTiming: { llmStartAt: DIAL_WALL + 120 } });
    await vi.advanceTimersByTimeAsync(2000);
    await dial;
    expect(useVoiceStore.getState().status).toBe('live');
    // The opener's first audio, 400ms after it was handed to TTS.
    await vi.advanceTimersByTimeAsync(400);
    h.onAudible?.('sui', 'oh hey, you called.');

    useVoiceStore.getState().endCall('user_hangup');
    const report = hangUpReport('sui');
    expect(report?.connectedMs).toBeGreaterThan(0);
    const c = report?.connect as Record<string, unknown>;
    expect(c).toMatchObject({
      greet_path: 'app',
      stt_local: 'none',
      gate: 'ring',
      greet_request_ms: 120,
      greet_ready_ms: 900,
      mic_open_ms: 300,
      stt_ready_ms: 350,
    });
    // Ring floor 1300ms, polled every 80ms.
    expect(c.connect_ms as number).toBeGreaterThanOrEqual(1300);
    expect(c.connect_ms as number).toBeLessThan(1400);
    // + the 1000ms pickup beat.
    expect((c.opener_queued_ms as number) - (c.connect_ms as number)).toBe(1000);
    expect(c.first_line_ms as number).toBeGreaterThan(c.opener_queued_ms as number);
    expect(c.mic_permission_ms as number).toBeLessThanOrEqual(c.setup_reads_ms as number);
  });

  it('a slow greeting holds the connect and is named as the gate', async () => {
    const { useVoiceStore } = await import('./useVoiceStore');
    const { notifyCompanionText } = await import('../voice/voiceBridge');

    const dial = useVoiceStore.getState().startCall('sui');
    await vi.advanceTimersByTimeAsync(2500);
    expect(useVoiceStore.getState().status).toBe('connecting');
    notifyCompanionText('sui', 'hey.', {});
    await vi.advanceTimersByTimeAsync(1200);
    await dial;
    useVoiceStore.getState().endCall('user_hangup');
    const c = hangUpReport('sui')?.connect as Record<string, unknown>;
    expect(c.gate).toBe('greeting');
    expect(c.greet_ready_ms).toBe(2500);
    expect(c).not.toHaveProperty('greet_request_ms');
    // Hung up before the opener was heard.
    expect(c).not.toHaveProperty('first_line_ms');
  });

  it('the three call-start reads run together (261128, T571)', async () => {
    const sei = (globalThis as unknown as { window: { sei: Record<string, unknown> } }).window.sei;
    const slow = <T,>(v: T) => vi.fn(() => new Promise<T>((r) => setTimeout(() => r(v), 100)));
    sei.getConfig = slow({ ai_backend_kind: 'cloud-proxy' });
    sei.voiceElevenKeyStatus = slow({ present: false });
    sei.speechPackStatus = slow({ packs: {} });
    const { useVoiceStore } = await import('./useVoiceStore');
    const { notifyCompanionText } = await import('../voice/voiceBridge');
    const dial = useVoiceStore.getState().startCall('sui');
    await vi.advanceTimersByTimeAsync(900);
    notifyCompanionText('sui', 'hey.', {});
    await vi.advanceTimersByTimeAsync(2000);
    await dial;
    useVoiceStore.getState().endCall('user_hangup');
    const c = hangUpReport('sui')?.connect as Record<string, number>;
    // One 100ms round trip after the permission check, not three in a row.
    expect(c.setup_reads_ms - c.mic_permission_ms).toBe(100);
  });

  it('a call hung up while dialing reports no connect timing (and no connectedMs)', async () => {
    const { useVoiceStore } = await import('./useVoiceStore');
    void useVoiceStore.getState().startCall('sui');
    await vi.advanceTimersByTimeAsync(500);
    useVoiceStore.getState().endCall('user_hangup');
    const report = hangUpReport('sui');
    expect(report).toBeDefined();
    expect(report).not.toHaveProperty('connect');
    expect(report).not.toHaveProperty('connectedMs');
  });
});
