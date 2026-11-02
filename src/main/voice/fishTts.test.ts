/**
 * Fish Audio client (261103). The load-bearing pin is the `model` header:
 * Fish reads a missing or unknown value as the PAID s2.1-pro, so EVERY
 * request (each /v1/tts try, the 429 retry and the /model voice lookup) must
 * carry `model: s2.1-pro-free`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearFishFailures,
  fetchFishVoice,
  fishFailureReason,
  fishHeaders,
  fishHttpError,
  fishTtsBody,
  FISH_MAX_IN_FLIGHT,
  openFishStream,
  planFishVoice,
  rememberFishFailure,
  rememberedFishFailure,
  synthesizeFish,
} from './fishTts';
import { FISH_VOICES } from '../../shared/fishVoices';

const VOICE = { id: '0123456789abcdef0123456789abcdef', speed: 1.2, volume: -1 };
const fetchMock = vi.fn();

function audioResponse(bytes = [0xff, 0xf3, 0x01, 0x02]): Response {
  return new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
}

function errorResponse(status: number, body = ''): Response {
  return new Response(body, { status });
}

/** Every header object fetch was called with. */
function sentHeaders(): Record<string, string>[] {
  return fetchMock.mock.calls.map((c) => (c[1] as RequestInit).headers as Record<string, string>);
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  clearFishFailures();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the free-model pin', () => {
  it('fishHeaders always names the free model', () => {
    const h = fishHeaders('k');
    expect(h.model).toBe('s2.1-pro-free');
    expect(h.Authorization).toBe('Bearer k');
    expect(h['content-type']).toBe('application/json');
  });

  it('a /v1/tts request carries the model header and the expected body', async () => {
    fetchMock.mockResolvedValueOnce(audioResponse());
    const buf = await synthesizeFish('key-1', 'Hello there.', VOICE, 'en');
    expect(buf.byteLength).toBe(4);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.fish.audio/v1/tts');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).model).toBe('s2.1-pro-free');
    expect(JSON.parse(init.body as string)).toEqual({
      text: 'Hello there.',
      reference_id: VOICE.id,
      format: 'mp3',
      mp3_bitrate: 128,
      latency: 'balanced',
      prosody: { speed: 1.2, volume: -1 },
    });
  });

  it('the 429 retry carries the model header too', async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(429)).mockResolvedValueOnce(audioResponse());
    await synthesizeFish('key-1', 'Hi.', VOICE, 'en', { retryDelayMs: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentHeaders().map((h) => h.model)).toEqual(['s2.1-pro-free', 's2.1-pro-free']);
  });
});

describe('requests in flight per key', () => {
  /** fetch calls that wait until the test resolves them. */
  function deferredFetches(): Array<(r: Response) => void> {
    const pending: Array<(r: Response) => void> = [];
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => pending.push(resolve)));
    return pending;
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it(`keeps at most ${FISH_MAX_IN_FLIGHT} open and queues the rest instead of failing`, async () => {
    expect(FISH_MAX_IN_FLIGHT).toBe(4);
    const pending = deferredFetches();
    const lines = Array.from({ length: 6 }, (_, i) => synthesizeFish('key-q', `Line ${i}.`, VOICE, 'en'));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    // Another key has its own slots.
    const other = synthesizeFish('key-other', 'Other.', VOICE, 'en');
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(5);
    pending[4](audioResponse());
    await other;
    // A finished line lets the next queued line go, in order.
    pending[0](audioResponse());
    await lines[0];
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(JSON.parse((fetchMock.mock.calls[5][1] as RequestInit).body as string).text).toBe('Line 4.');
    // A failed line frees its slot too.
    pending[1](errorResponse(401));
    await expect(lines[1]).rejects.toThrow(/^FISH_KEY_INVALID/);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(7);
    for (const i of [2, 3, 5, 6]) pending[i](audioResponse());
    const bufs = await Promise.all([lines[2], lines[3], lines[4], lines[5]]);
    expect(bufs.every((b) => b.byteLength === 4)).toBe(true);
  });

  it('a streamed body holds its slot until it is read to the end or cancelled', async () => {
    const pending = deferredFetches();
    const opens = Array.from({ length: 5 }, (_, i) => openFishStream('key-s', `S${i}.`, VOICE, 'en'));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (let i = 0; i < 4; i++) pending[i](audioResponse());
    const opened = await Promise.all(opens.slice(0, 4));
    await flush();
    // Headers are in, but no body is done: the fifth still waits.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect((await new Response(opened[0].body).arrayBuffer()).byteLength).toBe(4);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(5);
    pending[4](audioResponse());
    const fifth = await opens[4];
    await opened[1].body.cancel();
    await opened[2].body.cancel();
    await opened[3].body.cancel();
    await fifth.body.cancel();
    // All slots are free again: four new requests go out at once.
    const again = Array.from({ length: 4 }, () => openFishStream('key-s', 'Again.', VOICE, 'en'));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(9);
    for (let i = 5; i < 9; i++) pending[i](audioResponse());
    for (const o of await Promise.all(again)) await o.body.cancel();
  });
});

describe('fishTtsBody', () => {
  it('sends the language for non-English lines only', () => {
    expect(fishTtsBody('x', VOICE, 'en')).not.toHaveProperty('language');
    expect(fishTtsBody('x', VOICE)).not.toHaveProperty('language');
    expect(fishTtsBody('x', VOICE, 'zh-CN').language).toBe('zh');
    expect(fishTtsBody('x', VOICE, 'JA').language).toBe('ja');
  });
});

describe('errors', () => {
  it('retries a 429 exactly once, then reports busy', async () => {
    fetchMock.mockResolvedValue(errorResponse(429));
    const err = await synthesizeFish('k', 'Hi.', VOICE, 'en', { retryDelayMs: 1 }).catch((e) => e);
    expect(fishFailureReason(err)).toBe('busy');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    [401, '', 'key-invalid'],
    [403, '', 'key-invalid'],
    [402, '', 'no-credit'],
    [404, '', 'voice-missing'],
    [400, '{"message":"Reference not found"}', 'voice-missing'],
    [400, '{"message":"bad text"}', 'failed'],
    [500, '', 'failed'],
  ])('status %i maps to %s', async (status, body, reason) => {
    fetchMock.mockResolvedValue(errorResponse(status, body));
    const err = await synthesizeFish('k', 'Hi.', VOICE, 'en', { retryDelayMs: 1 }).catch((e) => e);
    expect(fishFailureReason(err)).toBe(reason);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a network error or an empty body is a plain failure', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(fishFailureReason(await synthesizeFish('k', 'Hi.', VOICE).catch((e) => e))).toBe('failed');
    fetchMock.mockResolvedValueOnce(audioResponse([]));
    expect(fishFailureReason(await synthesizeFish('k', 'Hi.', VOICE).catch((e) => e))).toBe('failed');
  });

  it('a connect timeout aborts and reports a failure', async () => {
    fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise((_res, rej) => {
      init.signal?.addEventListener('abort', () => rej(new Error('aborted')));
    }));
    const err = await openFishStream('k', 'Hi.', VOICE, 'en', { timeoutMs: 5 }).catch((e) => e);
    expect(fishFailureReason(err)).toBe('failed');
  });

  it('fishFailureReason ignores non-Fish errors', () => {
    expect(fishFailureReason(new Error('VOICE_TTS_FAILED: x'))).toBeNull();
    expect(fishFailureReason(fishHttpError(402, ''))).toBe('no-credit');
  });
});

describe('fetchFishVoice', () => {
  const ID = '0123456789abcdef0123456789abcdef';
  const model = (over: Record<string, unknown> = {}) =>
    new Response(JSON.stringify({ _id: ID, title: '  Calm Voice ', type: 'tts', state: 'trained', ...over }), { status: 200 });

  it('returns the id and trimmed title of a trained TTS voice, with the key', async () => {
    fetchMock.mockResolvedValueOnce(model());
    expect(await fetchFishVoice('key-9', ID)).toEqual({ id: ID, name: 'Calm Voice' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.fish.audio/model/${ID}`);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer key-9');
  });

  it('the voice lookup carries the free-model header too', async () => {
    fetchMock.mockResolvedValueOnce(model());
    await fetchFishVoice('key-9', ID);
    expect(sentHeaders()).toEqual([fishHeaders('key-9')]);
    expect(sentHeaders()[0].model).toBe('s2.1-pro-free');
  });

  it('caps a long title and falls back to the id when there is none', async () => {
    fetchMock.mockResolvedValueOnce(model({ title: 'x'.repeat(500) }));
    expect((await fetchFishVoice('k', ID)).name).toHaveLength(120);
    fetchMock.mockResolvedValueOnce(model({ title: '' }));
    expect((await fetchFishVoice('k', ID)).name).toBe(ID);
  });

  it('refuses a voice that cannot speak', async () => {
    fetchMock.mockResolvedValueOnce(model({ type: 'svc' }));
    expect(fishFailureReason(await fetchFishVoice('k', ID).catch((e) => e))).toBe('voice-missing');
    fetchMock.mockResolvedValueOnce(model({ state: 'training' }));
    expect(fishFailureReason(await fetchFishVoice('k', ID).catch((e) => e))).toBe('voice-missing');
    fetchMock.mockResolvedValueOnce(errorResponse(404));
    expect(fishFailureReason(await fetchFishVoice('k', ID).catch((e) => e))).toBe('voice-missing');
    fetchMock.mockResolvedValueOnce(errorResponse(401));
    expect(fishFailureReason(await fetchFishVoice('k', ID).catch((e) => e))).toBe('key-invalid');
    fetchMock.mockResolvedValueOnce(new Response('not json', { status: 200 }));
    expect(fishFailureReason(await fetchFishVoice('k', ID).catch((e) => e))).toBe('failed');
  });
});

describe('planFishVoice', () => {
  it('auto: the table voice with its speed and trim', () => {
    const plan = planFishVoice(undefined, 'male', 'zh');
    expect(plan).toEqual({
      id: FISH_VOICES.zh.male.id,
      name: FISH_VOICES.zh.male.name,
      speed: FISH_VOICES.zh.male.speed,
      volume: FISH_VOICES.zh.male.volume,
      source: 'auto',
    });
  });

  it('override: the user voice, its speed clamped (default 1.3), no trim', () => {
    const id = 'f'.repeat(32);
    expect(planFishVoice({ id, name: 'Mine' }, 'female', 'en')).toEqual({ id, name: 'Mine', speed: 1.3, volume: 0, source: 'override' });
    expect(planFishVoice({ id, name: 'Mine', speed: 5 }, 'female', 'en').speed).toBe(2);
  });
});

describe('remembered refusals', () => {
  const A = 'a'.repeat(32);
  const B = 'b'.repeat(32);

  it('key-invalid and no-credit cover every voice for that key only', () => {
    rememberFishFailure('key-1', A, 'no-credit');
    expect(rememberedFishFailure('key-1', A)).toBe('no-credit');
    expect(rememberedFishFailure('key-1', B)).toBe('no-credit');
    expect(rememberedFishFailure('key-2', A)).toBeNull();
  });

  it('a missing voice is per voice; busy and no-key are not remembered', () => {
    rememberFishFailure('key-1', A, 'voice-missing');
    expect(rememberedFishFailure('key-1', A)).toBe('voice-missing');
    expect(rememberedFishFailure('key-1', B)).toBeNull();
    rememberFishFailure('key-3', A, 'busy');
    rememberFishFailure('key-3', A, 'no-key');
    expect(rememberedFishFailure('key-3', A)).toBeNull();
  });

  it('expires (network failures sooner) and clears on demand', () => {
    vi.useFakeTimers();
    try {
      rememberFishFailure('key-1', A, 'failed');
      rememberFishFailure('key-2', A, 'key-invalid');
      vi.advanceTimersByTime(21_000);
      expect(rememberedFishFailure('key-1', A)).toBeNull();
      expect(rememberedFishFailure('key-2', A)).toBe('key-invalid');
      clearFishFailures();
      expect(rememberedFishFailure('key-2', A)).toBeNull();
      rememberFishFailure('key-2', A, 'key-invalid');
      vi.advanceTimersByTime(5 * 60_000 + 1);
      expect(rememberedFishFailure('key-2', A)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
