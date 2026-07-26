/**
 * voiceStt (260724) — request routing, WAV encoding, result contract.
 *
 * Pins: the direct route (dev env key / BYOK stored key, 260725) posts
 * multipart to ElevenLabs' /v1/speech-to-text with the pinned scribe model;
 * the proxy route posts a raw audio/wav body to the proxy with the Bearer
 * JWT; no credentials (BYOK with no key, or cloud signed out) →
 * { unavailable, reason:'no-credentials' } (not a throw); terminal upstream
 * statuses (401/402/403/503, and a daily-cap 429) →
 * { unavailable, reason:'upstream' }; transient failures throw (the renderer
 * falls back to local for that utterance only) — including a burst 429 and a
 * failed session read, both of which used to latch cloud STT off for the whole
 * call; the WAV encoder emits a valid 16-bit mono 16kHz header.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockGetSession, mockResolveRoute } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockResolveRoute: vi.fn(),
}));
vi.mock('../auth/supabaseClient', () => ({
  getClient: () => ({ auth: { getSession: mockGetSession } }),
}));
vi.mock('./elevenLabsKeyStore', () => ({
  resolveElevenLabsRoute: mockResolveRoute,
}));

import { voiceStt, encodeWav, normalizeSttText } from './stt';

const fetchSpy = vi.fn();

/** A 0.5s silent utterance (Float32 16kHz mono), as the renderer sends it. */
function pcm(samples = 8_000): ArrayBuffer {
  return new Float32Array(samples).buffer;
}

function okText(text: string, extra: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({ text, language_code: 'en', language_probability: 0.97, ...extra }),
    { status: 200 },
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchSpy);
  fetchSpy.mockReset();
  mockGetSession.mockResolvedValue({ data: { session: { access_token: 'jwt-123' } } });
  mockResolveRoute.mockResolvedValue({ kind: 'proxy' });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('encodeWav', () => {
  it('emits a valid 16-bit mono 16kHz RIFF header and scaled samples', () => {
    const wav = encodeWav(new Float32Array([0, 0.5, -0.5, 1, -1]));
    const view = new DataView(wav);
    const tag = (o: number, n: number) =>
      String.fromCharCode(...new Uint8Array(wav, o, n));
    expect(tag(0, 4)).toBe('RIFF');
    expect(tag(8, 4)).toBe('WAVE');
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(view.getUint32(40, true)).toBe(10); // 5 samples × 2 bytes
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(Math.trunc(0.5 * 0x7fff)); // setInt16 truncates
    expect(view.getInt16(48, true)).toBe(-0.5 * 0x8000);
    expect(view.getInt16(50, true)).toBe(0x7fff); // +1 clamps to int16 max
    expect(view.getInt16(52, true)).toBe(-0x8000); // -1 hits int16 min
  });
});

describe('normalizeSttText', () => {
  it('strips non-laughter tags, collapses whitespace, downgrades em dashes', () => {
    expect(normalizeSttText(' (coughs) tell me a  joke [clicking] — now ')).toBe(
      'tell me a joke - now',
    );
  });

  it('maps laughter events to "haha" (260725 expressions)', () => {
    expect(normalizeSttText('(laughs) no way')).toBe('haha no way');
    expect(normalizeSttText('(laughter)')).toBe('haha');
    expect(normalizeSttText('that was [chuckles] something (giggling)')).toBe(
      'that was haha something haha',
    );
  });

  it('keeps interjections and punctuation as-is', () => {
    expect(normalizeSttText('Awww, really?!')).toBe('Awww, really?!');
    expect(normalizeSttText('Ohhhh!')).toBe('Ohhhh!');
  });
});

describe('voiceStt', () => {
  it('proxy path: raw wav body + Bearer JWT, no language pin, detection relayed', async () => {
    fetchSpy.mockResolvedValue(okText('hello', { language_code: 'fr', language_probability: 0.91 }));
    const res = await voiceStt({ pcm: pcm() });
    expect(res).toEqual({ text: 'hello', languageCode: 'fr', languageProbability: 0.91 });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.sei.gg/stt/transcribe');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer jwt-123');
    expect((init.headers as Record<string, string>)['content-type']).toBe('audio/wav');
    const body = init.body as ArrayBuffer;
    expect(body.byteLength).toBe(44 + 8_000 * 2);
  });

  it('direct route (dev env / BYOK key): multipart to ElevenLabs with pinned model, no language_code', async () => {
    mockResolveRoute.mockResolvedValue({ kind: 'direct', key: 'dev-key' });
    fetchSpy.mockResolvedValue(okText('hi there'));
    const res = await voiceStt({ pcm: pcm() });
    expect(res).toEqual({ text: 'hi there', languageCode: 'en', languageProbability: 0.97 });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.elevenlabs.io/v1/speech-to-text');
    expect((init.headers as Record<string, string>)['xi-api-key']).toBe('dev-key');
    const form = init.body as FormData;
    expect(form.get('model_id')).toBe('scribe_v1');
    expect(form.get('tag_audio_events')).toBe('true');
    // 260725: never pinned — Scribe detects per utterance for the auto-switch.
    expect(form.get('language_code')).toBeNull();
    expect((form.get('file') as Blob).type).toBe('audio/wav');
  });

  it('tolerates a proxy that strips the detection fields', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ text: 'hey' }), { status: 200 }));
    const res = await voiceStt({ pcm: pcm() });
    expect(res).toEqual({ text: 'hey' });
  });

  it('signed out with no key → { unavailable, reason:"no-credentials" }, no network call', async () => {
    mockGetSession.mockResolvedValue({ data: { session: null } });
    const res = await voiceStt({ pcm: pcm() });
    expect(res).toEqual({ unavailable: true, reason: 'no-credentials' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('BYOK with no stored key → { unavailable, reason:"no-credentials" }, never the proxy', async () => {
    mockResolveRoute.mockResolvedValue({ kind: 'unconfigured' });
    const res = await voiceStt({ pcm: pcm() });
    expect(res).toEqual({ unavailable: true, reason: 'no-credentials' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a session READ FAILURE throws instead of latching the call off', async () => {
    // 260726: this used to return { unavailable, reason:'no-credentials' },
    // which the renderer latches as a SILENT whole-call disable — one flaky
    // getSession (or a refresh in flight) deafened a signed-in user for the
    // rest of the call.
    mockGetSession.mockRejectedValue(new Error('network'));
    await expect(voiceStt({ pcm: pcm() })).rejects.toThrow('VOICE_STT_FAILED');
    mockGetSession.mockResolvedValue({ data: { session: null }, error: new Error('refresh failed') });
    await expect(voiceStt({ pcm: pcm() })).rejects.toThrow('VOICE_STT_FAILED');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([401, 402, 403, 503])('terminal upstream %d → { unavailable, reason:"upstream" }', async (status) => {
    fetchSpy.mockResolvedValue(new Response('nope', { status }));
    const res = await voiceStt({ pcm: pcm() });
    expect(res).toEqual({ unavailable: true, reason: 'upstream' });
  });

  // 260726: a burst 429 (Cloudflare's 20 req/10s flood guard, or ElevenLabs
  // rate-limiting overlapping utterances) is NOT terminal — latching it left
  // the companion deaf for the rest of the call on the default 'none' local
  // model. Only the daily spend cap is terminal.
  it('a burst 429 throws (retried next utterance)', async () => {
    fetchSpy.mockResolvedValue(new Response('too many requests', { status: 429 }));
    await expect(voiceStt({ pcm: pcm() })).rejects.toThrow('VOICE_STT_FAILED');
  });

  it('a daily-cap 429 → { unavailable, reason:"upstream" }', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ error: 'rate_limited', kind: 'daily_dollar', retry_after_seconds: 3600 }), {
        status: 429,
      }),
    );
    expect(await voiceStt({ pcm: pcm() })).toEqual({ unavailable: true, reason: 'upstream' });
    // A long Retry-After is the same signal when the body says nothing.
    fetchSpy.mockResolvedValue(new Response('nope', { status: 429, headers: { 'retry-after': '3600' } }));
    expect(await voiceStt({ pcm: pcm() })).toEqual({ unavailable: true, reason: 'upstream' });
  });

  it('a short Retry-After stays transient', async () => {
    fetchSpy.mockResolvedValue(new Response('nope', { status: 429, headers: { 'retry-after': '10' } }));
    await expect(voiceStt({ pcm: pcm() })).rejects.toThrow('VOICE_STT_FAILED');
  });

  it('transient upstream 500 → throws (renderer falls back to local once)', async () => {
    fetchSpy.mockResolvedValue(new Response('boom', { status: 500 }));
    await expect(voiceStt({ pcm: pcm() })).rejects.toThrow('VOICE_STT_FAILED');
  });

  it('network failure → throws', async () => {
    fetchSpy.mockRejectedValue(new Error('ECONNRESET'));
    await expect(voiceStt({ pcm: pcm() })).rejects.toThrow('VOICE_STT_FAILED');
  });

  it('an unreadable success body throws instead of resolving a silent ""', async () => {
    // 260726: the body read now rides the same abort deadline as the request
    // (a half-dead socket used to strand the utterance forever), and a body
    // that cannot be parsed is transient, never trusted as "not speech".
    fetchSpy.mockResolvedValue(new Response('<html>gateway</html>', { status: 200 }));
    await expect(voiceStt({ pcm: pcm() })).rejects.toThrow('VOICE_STT_FAILED');
  });

  it('a body that never finishes aborts on the request deadline', async () => {
    vi.useFakeTimers();
    try {
      fetchSpy.mockImplementation(async (_url: string, init: RequestInit) => {
        const signal = init.signal as AbortSignal;
        // 200 with headers in, then a body that goes quiet forever.
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            signal.addEventListener('abort', () => {
              try {
                controller.error(new Error('This operation was aborted'));
              } catch {
                /* already errored */
              }
            });
          },
        });
        return new Response(body, { status: 200 });
      });
      const p = voiceStt({ pcm: pcm() });
      const assertion = expect(p).rejects.toThrow('VOICE_STT_FAILED');
      await vi.advanceTimersByTimeAsync(9_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
