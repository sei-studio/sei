/**
 * ownVoices (261019) â€” the user's own ElevenLabs voices, read in main.
 *
 * Pins: the documented GET /v2/voices shape parses (cloned, generated and
 * saved-library voices, premade dropped, labels mapped), pagination follows
 * has_more + next_page_token, a rejected key is 'bad_key', a network failure
 * is 'error' (never a throw), the voice_type filter falls back once if the
 * API rejects it, the list is cached per key and only for good answers, a
 * cloud/unconfigured route lists nothing, and preview bytes come only from
 * ElevenLabs' storage hosts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockResolveKey, mockReadCached, mockWriteCached } = vi.hoisted(() => ({
  mockResolveKey: vi.fn(),
  mockReadCached: vi.fn(),
  mockWriteCached: vi.fn(),
}));
vi.mock('./elevenLabsKeyStore', () => ({ resolveOwnVoiceKey: mockResolveKey }));
vi.mock('./previewCache', () => ({
  previewCacheKey: (id: string, text: string) => `${id}|${text.length}`,
  readCachedPreview: mockReadCached,
  writeCachedPreview: mockWriteCached,
}));

import {
  parseOwnVoicesPage,
  fetchOwnVoices,
  listOwnVoices,
  isOwnVoiceId,
  ownVoicePreviewBytes,
  invalidateOwnVoices,
  isTrustedPreviewUrl,
  type FetchLike,
} from './ownVoices';

const CLONED = {
  voice_id: 'aBcDeFgHiJkLmNoPqRsT',
  name: 'My Clone',
  category: 'cloned',
  labels: { gender: 'Male', age: 'young', accent: 'american' },
  description: null,
  preview_url: 'https://storage.googleapis.com/eleven-public-prod/abc/preview.mp3',
  available_for_tiers: [],
  settings: null,
};
const DESIGNED = {
  voice_id: 'GeNeRaTeD0123456789x',
  name: 'Dragon Narrator',
  category: 'generated',
  labels: { gender: 'female', description: 'raspy and old' },
  preview_url: null,
};
const SAVED = {
  voice_id: 'LiBrArY0123456789abc',
  name: 'Library Pick',
  category: 'professional',
  labels: {},
  description: 'Warm audiobook voice',
  preview_url: 'https://evil.example.com/preview.mp3',
};
const PREMADE = { voice_id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah', category: 'premade', labels: {} };

function page(voices: unknown[], extra: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({ voices, has_more: false, total_count: voices.length, next_page_token: null, ...extra }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

beforeEach(() => {
  invalidateOwnVoices();
  mockResolveKey.mockReset();
  mockResolveKey.mockResolvedValue('user-key-1');
  mockReadCached.mockReset();
  mockReadCached.mockResolvedValue(null);
  mockWriteCached.mockReset();
  mockWriteCached.mockResolvedValue(undefined);
});

describe('parseOwnVoicesPage', () => {
  it('maps the documented /v2/voices shape and drops premade voices', () => {
    const out = parseOwnVoicesPage({
      voices: [CLONED, DESIGNED, SAVED, PREMADE],
      has_more: false,
      total_count: 4,
      next_page_token: null,
    });
    expect(out.hasMore).toBe(false);
    expect(out.voices.map((v) => v.id)).toEqual([CLONED.voice_id, DESIGNED.voice_id, SAVED.voice_id]);
    expect(out.voices[0]).toEqual({
      id: CLONED.voice_id,
      name: 'My Clone',
      category: 'cloned',
      gender: 'male',
      age: 'young',
      accent: 'american',
      hasPreview: true,
      previewUrl: CLONED.preview_url,
    });
    // description falls back to labels.description; no preview URL â†’ none.
    expect(out.voices[1]).toMatchObject({ description: 'raspy and old', gender: 'female', hasPreview: false });
    // an untrusted preview host is never kept (main would fetch it).
    expect(out.voices[2]).toMatchObject({ description: 'Warm audiobook voice', hasPreview: false, previewUrl: null });
  });

  it('skips malformed entries instead of failing the page', () => {
    const out = parseOwnVoicesPage({
      voices: [null, 'x', { name: 'no id' }, { voice_id: '../etc/passwd', name: 'bad' }, { voice_id: 'none' }, CLONED],
    });
    expect(out.voices.map((v) => v.id)).toEqual([CLONED.voice_id]);
    expect(parseOwnVoicesPage(null).voices).toEqual([]);
    expect(parseOwnVoicesPage({ voices: 'nope' }).voices).toEqual([]);
  });

  it('only reports more pages when has_more AND a token are present', () => {
    expect(parseOwnVoicesPage({ voices: [], has_more: true, next_page_token: 't1' })).toMatchObject({
      hasMore: true,
      nextPageToken: 't1',
    });
    expect(parseOwnVoicesPage({ voices: [], has_more: true, next_page_token: null }).hasMore).toBe(false);
  });

  it('a voice with no name shows its id', () => {
    expect(parseOwnVoicesPage({ voices: [{ voice_id: 'NoNameVoice12345' }] }).voices[0]).toMatchObject({
      name: 'NoNameVoice12345',
      category: 'unknown',
    });
  });
});

describe('isTrustedPreviewUrl', () => {
  it('accepts ElevenLabs storage over https only', () => {
    expect(isTrustedPreviewUrl('https://storage.googleapis.com/eleven-public-prod/x.mp3')).toBe(true);
    expect(isTrustedPreviewUrl('https://api.elevenlabs.io/v1/x.mp3')).toBe(true);
    expect(
      isTrustedPreviewUrl('https://api.us.elevenlabs.io/v1/voices/FGY2WhTYpPnrIDTdsKH5/previews/audio?payload=e30%3D'),
    ).toBe(true);
    // storage.googleapis.com is shared by every GCS customer: only ElevenLabs' bucket.
    expect(isTrustedPreviewUrl('https://storage.googleapis.com/someone-else/x.mp3')).toBe(false);
    expect(isTrustedPreviewUrl('https://storage.googleapis.com/eleven-public-prod-evil/x.mp3')).toBe(false);
    expect(isTrustedPreviewUrl('https://storage.googleapis.com/x.mp3')).toBe(false);
    expect(isTrustedPreviewUrl('https://api.elevenlabs.io:8443/x.mp3')).toBe(false);
    expect(isTrustedPreviewUrl('http://storage.googleapis.com/eleven-public-prod/x.mp3')).toBe(false);
    expect(isTrustedPreviewUrl('https://user:pw@storage.googleapis.com/eleven-public-prod/x.mp3')).toBe(false);
    expect(isTrustedPreviewUrl('https://elevenlabs.io.evil.com/x.mp3')).toBe(false);
    expect(isTrustedPreviewUrl('file:///etc/passwd')).toBe(false);
    expect(isTrustedPreviewUrl(null)).toBe(false);
    expect(isTrustedPreviewUrl('not a url')).toBe(false);
  });
});

describe('fetchOwnVoices', () => {
  it('sends the key in xi-api-key with the non-default filter', async () => {
    const f = vi.fn<FetchLike>(async () => page([CLONED]));
    const out = await fetchOwnVoices('k-123', f);
    expect(out.status).toBe('ok');
    const [url, init] = f.mock.calls[0];
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://api.elevenlabs.io/v2/voices');
    expect(u.searchParams.get('page_size')).toBe('100');
    expect(u.searchParams.get('voice_type')).toBe('non-default');
    expect(u.searchParams.has('next_page_token')).toBe(false);
    expect((init?.headers as Record<string, string>)['xi-api-key']).toBe('k-123');
  });

  it('follows next_page_token and de-duplicates ids', async () => {
    const f = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(page([CLONED], { has_more: true, next_page_token: 'tok-2' }))
      .mockResolvedValueOnce(page([CLONED, DESIGNED]));
    const out = await fetchOwnVoices('k', f);
    expect(out.voices.map((v) => v.id)).toEqual([CLONED.voice_id, DESIGNED.voice_id]);
    expect(new URL(f.mock.calls[1][0]).searchParams.get('next_page_token')).toBe('tok-2');
  });

  it('stops at the page bound on a runaway cursor', async () => {
    const f = vi.fn<FetchLike>(async () => page([], { has_more: true, next_page_token: 'again' }));
    const out = await fetchOwnVoices('k', f);
    expect(out.status).toBe('ok');
    expect(f).toHaveBeenCalledTimes(5);
  });

  it('401 / 403 â†’ bad_key', async () => {
    const body = JSON.stringify({ detail: { status: 'invalid_api_key', message: 'Invalid API key' } });
    expect(await fetchOwnVoices('k', async () => new Response(body, { status: 401 }))).toEqual({
      status: 'bad_key',
      voices: [],
    });
    expect((await fetchOwnVoices('k', async () => new Response('{}', { status: 403 }))).status).toBe('bad_key');
  });

  it('a network failure or 5xx â†’ error, never a throw', async () => {
    expect(
      await fetchOwnVoices('k', async () => {
        throw new TypeError('fetch failed');
      }),
    ).toEqual({ status: 'error', voices: [] });
    expect((await fetchOwnVoices('k', async () => new Response('down', { status: 500 }))).status).toBe('error');
  });

  it('retries once without voice_type when the API rejects the filter', async () => {
    const f = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(new Response('{"detail":"bad voice_type"}', { status: 422 }))
      .mockResolvedValueOnce(page([CLONED, PREMADE]));
    const out = await fetchOwnVoices('k', f);
    expect(out.status).toBe('ok');
    // premade is still filtered client-side.
    expect(out.voices.map((v) => v.id)).toEqual([CLONED.voice_id]);
    expect(new URL(f.mock.calls[1][0]).searchParams.has('voice_type')).toBe(false);
    expect(f).toHaveBeenCalledTimes(2);
  });
});

describe('listOwnVoices', () => {
  it('lists nothing without an own-voice key (none stored, or the store broke)', async () => {
    const f = vi.fn<FetchLike>(async () => page([CLONED]));
    mockResolveKey.mockResolvedValue(null);
    expect(await listOwnVoices({ fetchImpl: f })).toEqual({ status: 'unavailable', voices: [] });
    mockResolveKey.mockRejectedValue(new Error('keystore broke'));
    expect((await listOwnVoices({ fetchImpl: f })).status).toBe('unavailable');
    expect(f).not.toHaveBeenCalled();
  });

  it('never hands the renderer the preview URL (or the key)', async () => {
    const out = await listOwnVoices({ fetchImpl: async () => page([CLONED]) });
    expect(out.status).toBe('ok');
    expect(out.voices[0]).not.toHaveProperty('previewUrl');
    expect(JSON.stringify(out)).not.toContain('user-key-1');
    expect(JSON.stringify(out)).not.toContain('googleapis');
  });

  it('caches per key, refresh bypasses it, and a key change re-reads', async () => {
    const f = vi.fn<FetchLike>(async () => page([CLONED]));
    await listOwnVoices({ fetchImpl: f });
    await listOwnVoices({ fetchImpl: f });
    expect(f).toHaveBeenCalledTimes(1);
    await listOwnVoices({ fetchImpl: f, refresh: true });
    expect(f).toHaveBeenCalledTimes(2);
    mockResolveKey.mockResolvedValue('user-key-2');
    await listOwnVoices({ fetchImpl: f });
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('does not cache a failure, so the next open retries', async () => {
    const f = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(page([CLONED]));
    expect((await listOwnVoices({ fetchImpl: f })).status).toBe('bad_key');
    expect((await listOwnVoices({ fetchImpl: f })).status).toBe('ok');
  });

  it('concurrent opens share one request', async () => {
    const f = vi.fn<FetchLike>(async () => page([CLONED]));
    await Promise.all([listOwnVoices({ fetchImpl: f }), listOwnVoices({ fetchImpl: f })]);
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('isOwnVoiceId', () => {
  it('true only for a voice in the current account', async () => {
    const f: FetchLike = async () => page([CLONED]);
    expect(await isOwnVoiceId(CLONED.voice_id, { fetchImpl: f })).toBe(true);
    expect(await isOwnVoiceId(DESIGNED.voice_id, { fetchImpl: f })).toBe(false);
    expect(await isOwnVoiceId('../x', { fetchImpl: f })).toBe(false);
    mockResolveKey.mockResolvedValue(null);
    invalidateOwnVoices();
    expect(await isOwnVoiceId(CLONED.voice_id, { fetchImpl: f })).toBe(false);
  });
});

describe('ownVoicePreviewBytes', () => {
  it('fetches the trusted preview URL without redirects and caches it', async () => {
    const f = vi.fn<FetchLike>(async (url) =>
      url.startsWith('https://api.elevenlabs.io/v2/voices')
        ? page([CLONED])
        : new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    );
    const buf = await ownVoicePreviewBytes(CLONED.voice_id, { fetchImpl: f });
    expect(buf && new Uint8Array(buf)).toEqual(new Uint8Array([1, 2, 3]));
    const previewCall = f.mock.calls.find(([u]) => u === CLONED.preview_url);
    expect(previewCall?.[1]).toMatchObject({ redirect: 'error' });
    // the preview request carries no key.
    expect(previewCall?.[1]?.headers).toBeUndefined();
    expect(mockWriteCached).toHaveBeenCalledTimes(1);
  });

  it('serves a disk-cached sample without downloading again', async () => {
    const cached = new Uint8Array([7]).buffer;
    mockReadCached.mockResolvedValue(cached);
    const f = vi.fn<FetchLike>(async () => page([CLONED]));
    expect(await ownVoicePreviewBytes(CLONED.voice_id, { fetchImpl: f })).toBe(cached);
    expect(f).toHaveBeenCalledTimes(1); // the list only
  });

  it('null when there is nothing safe to fetch (caller synthesizes instead)', async () => {
    const f = vi.fn<FetchLike>(async () => page([CLONED, DESIGNED, SAVED]));
    expect(await ownVoicePreviewBytes(DESIGNED.voice_id, { fetchImpl: f })).toBeNull(); // no URL
    expect(await ownVoicePreviewBytes(SAVED.voice_id, { fetchImpl: f })).toBeNull(); // untrusted host
    expect(await ownVoicePreviewBytes('NotInAccount1234', { fetchImpl: f })).toBeNull();
    expect(f.mock.calls.every(([u]) => u.startsWith('https://api.elevenlabs.io/v2/voices'))).toBe(true);
  });

  it('null on a failed or empty download', async () => {
    const list: FetchLike = async () => page([CLONED]);
    const failing: FetchLike = async (url) => (url === CLONED.preview_url ? new Response('', { status: 403 }) : list(url));
    expect(await ownVoicePreviewBytes(CLONED.voice_id, { fetchImpl: failing })).toBeNull();
    const empty: FetchLike = async (url) => (url === CLONED.preview_url ? new Response(new Uint8Array(0)) : list(url));
    expect(await ownVoicePreviewBytes(CLONED.voice_id, { fetchImpl: empty })).toBeNull();
    const throwing: FetchLike = async (url) => {
      if (url === CLONED.preview_url) throw new TypeError('redirect');
      return list(url);
    };
    expect(await ownVoicePreviewBytes(CLONED.voice_id, { fetchImpl: throwing })).toBeNull();
    expect(mockWriteCached).not.toHaveBeenCalled();
  });

  it('caps a body with no Content-Length while reading, and cancels it', async () => {
    const list: FetchLike = async () => page([CLONED]);
    let pulled = 0;
    let cancelled = false;
    const chunk = new Uint8Array(1024 * 1024);
    const endless = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        pulled += 1;
        ctrl.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const big: FetchLike = async (url) => (url === CLONED.preview_url ? new Response(endless) : list(url));
    expect(await ownVoicePreviewBytes(CLONED.voice_id, { fetchImpl: big })).toBeNull();
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(10);
    expect(mockWriteCached).not.toHaveBeenCalled();
  });
});




