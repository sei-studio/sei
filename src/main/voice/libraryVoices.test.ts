/**
 * Voice Library voices, main side (261119): the proxy calls and their reason
 * mapping, the preview fetch allowlist, and the refusal memory tts.ts reads.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockGetSession, mockList } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockList: vi.fn(async () => [] as unknown[]),
}));
vi.mock('../auth/supabaseClient', () => ({ getClient: () => ({ auth: { getSession: mockGetSession } }) }));
vi.mock('../characterStore', () => ({ listCharacters: mockList }));

import {
  LIBRARY_REFUSAL_TTL_MS,
  _resetLibraryVoicesForTests,
  addLibraryVoice,
  forgetLibraryRefusal,
  isAllowedPreviewUrl,
  isKnownLibraryVoiceId,
  libraryVoicePreviewBytes,
  libraryVoiceRefused,
  libraryVoiceStatus,
  lookupLibraryVoice,
  rememberLibraryRefusal,
} from './libraryVoices';

const VID = 'LibVoice0000000000aa';
const PREVIEW = 'https://storage.googleapis.com/eleven-public-prod/voices/x/preview.mp3';
const fetchSpy = vi.fn();
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });
const publicVoice = { voice_id: VID, name: 'Captain Wren', gender: 'female', accent: 'british', preview_url: PREVIEW };

beforeEach(() => {
  _resetLibraryVoicesForTests();
  vi.stubGlobal('fetch', fetchSpy);
  fetchSpy.mockReset();
  mockGetSession.mockResolvedValue({ data: { session: { access_token: 'jwt-1' } } });
  mockList.mockResolvedValue([]);
});
afterEach(() => vi.unstubAllGlobals());

describe('lookupLibraryVoice', () => {
  it('posts the paste with the JWT and returns the voice without its URL', async () => {
    fetchSpy.mockResolvedValue(json({ ok: true, voice: publicVoice }));
    const r = await lookupLibraryVoice('  https://elevenlabs.io/app/voice-library?voiceId=' + VID + ' ');
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.sei.gg/tts/library-voice/lookup');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer jwt-1');
    expect(JSON.parse(init.body as string)).toEqual({ input: 'https://elevenlabs.io/app/voice-library?voiceId=' + VID });
    expect(r).toEqual({
      ok: true,
      voice: { voiceId: VID, name: 'Captain Wren', gender: 'female', age: null, accent: 'british', description: null, hasPreview: true },
    });
    expect(JSON.stringify(r)).not.toContain('googleapis');
    expect(await isKnownLibraryVoiceId(VID)).toBe(true);
  });

  it('maps every failure to a reason the picker has copy for', async () => {
    expect(await lookupLibraryVoice('   ')).toEqual({ ok: false, reason: 'invalid_input' });
    fetchSpy.mockResolvedValueOnce(json({ ok: false, reason: 'custom_rate' }));
    expect(await lookupLibraryVoice(VID)).toEqual({ ok: false, reason: 'custom_rate' });
    fetchSpy.mockResolvedValueOnce(json({ ok: false, reason: 'something_new' }));
    expect(await lookupLibraryVoice(VID)).toEqual({ ok: false, reason: 'unavailable' });
    fetchSpy.mockResolvedValueOnce(json({ error: 'rate_limited' }, 429));
    expect(await lookupLibraryVoice(VID)).toEqual({ ok: false, reason: 'rate_limited' });
    fetchSpy.mockResolvedValueOnce(json({ error: 'missing_jwt' }, 401));
    expect(await lookupLibraryVoice(VID)).toEqual({ ok: false, reason: 'no_session' });
    fetchSpy.mockResolvedValueOnce(new Response('not found', { status: 404 }));
    expect(await lookupLibraryVoice(VID)).toEqual({ ok: false, reason: 'unavailable' });
    fetchSpy.mockRejectedValueOnce(new Error('offline'));
    expect(await lookupLibraryVoice(VID)).toEqual({ ok: false, reason: 'unavailable' });
    fetchSpy.mockResolvedValueOnce(json({ ok: true, voice: { voice_id: '../x', name: 'x' } }));
    expect(await lookupLibraryVoice(VID)).toEqual({ ok: false, reason: 'unavailable' });
    mockGetSession.mockResolvedValue({ data: { session: null } });
    expect(await lookupLibraryVoice(VID)).toEqual({ ok: false, reason: 'no_session' });
    expect(fetchSpy).toHaveBeenCalledTimes(7);
  });
});

describe('addLibraryVoice', () => {
  it('sends the library voices the characters use, clears a remembered refusal', async () => {
    const OTHER = 'Other00000000000000a';
    mockList.mockResolvedValue([
      { metadata: { voiceId: OTHER, voiceLibrary: { name: 'Other' } } },
      { metadata: { voiceId: 'NXaTw4ifg0LAguvKuIwZ' } },
      { metadata: { voiceId: 'aBcDeFgHiJkLmNoPqRsT', voiceOwn: { name: 'Mine' } } },
    ]);
    rememberLibraryRefusal(VID);
    fetchSpy.mockResolvedValue(json({ ok: true, already: true, voice: publicVoice }));
    const r = await addLibraryVoice(VID);
    expect(JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string)).toEqual({ input: VID, in_use: [OTHER] });
    expect(r).toMatchObject({ ok: true, already: true, voice: { voiceId: VID } });
    expect(libraryVoiceRefused(VID)).toBe(false);
  });

  it('a rejection at add time passes its reason through', async () => {
    fetchSpy.mockResolvedValue(json({ ok: false, reason: 'daily_limit' }));
    expect(await addLibraryVoice(VID)).toEqual({ ok: false, reason: 'daily_limit' });
  });
});

describe('libraryVoiceStatus', () => {
  it('removed is remembered as a refusal, active clears it', async () => {
    fetchSpy.mockResolvedValueOnce(json({ status: 'removed', name: 'Captain Wren', gender: 'female' }));
    expect(await libraryVoiceStatus(VID)).toEqual({ status: 'removed', name: 'Captain Wren', gender: 'female' });
    expect(libraryVoiceRefused(VID)).toBe(true);
    fetchSpy.mockResolvedValueOnce(json({ status: 'active', name: 'Captain Wren', gender: null }));
    expect((await libraryVoiceStatus(VID)).status).toBe('active');
    expect(libraryVoiceRefused(VID)).toBe(false);
    fetchSpy.mockResolvedValueOnce(json({ status: 'pool' }));
    expect(await libraryVoiceStatus(VID)).toEqual({ status: 'pool' });
    fetchSpy.mockResolvedValueOnce(json({}, 500));
    expect(await libraryVoiceStatus(VID)).toEqual({ status: 'error' });
    expect(await libraryVoiceStatus('../etc')).toEqual({ status: 'unknown' });
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });
});

describe('refusal memory', () => {
  it('expires after the TTL', () => {
    rememberLibraryRefusal(VID, 1000);
    expect(libraryVoiceRefused(VID, 1000 + LIBRARY_REFUSAL_TTL_MS - 1)).toBe(true);
    expect(libraryVoiceRefused(VID, 1000 + LIBRARY_REFUSAL_TTL_MS)).toBe(false);
    rememberLibraryRefusal(VID);
    forgetLibraryRefusal(VID);
    expect(libraryVoiceRefused(VID)).toBe(false);
  });
});

describe('preview clips', () => {
  it('only from the ElevenLabs public bucket or elevenlabs.io, https', () => {
    expect(isAllowedPreviewUrl(PREVIEW)).toBe(true);
    expect(isAllowedPreviewUrl('https://cdn.elevenlabs.io/a.mp3')).toBe(true);
    expect(isAllowedPreviewUrl('http://storage.googleapis.com/eleven-public-prod/a.mp3')).toBe(false);
    expect(isAllowedPreviewUrl('https://storage.googleapis.com/some-bucket/a.mp3')).toBe(false);
    expect(isAllowedPreviewUrl('https://elevenlabs.io.evil.example/a.mp3')).toBe(false);
    expect(isAllowedPreviewUrl('https://user:pw@elevenlabs.io/a.mp3')).toBe(false);
    expect(isAllowedPreviewUrl('not a url')).toBe(false);
  });

  it('fetches only the clip the proxy named for a looked-up voice', async () => {
    await expect(libraryVoicePreviewBytes(VID)).rejects.toThrow(/no preview/);
    fetchSpy.mockResolvedValueOnce(json({ ok: true, voice: publicVoice }));
    await lookupLibraryVoice(VID);
    fetchSpy.mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    expect(new Uint8Array(await libraryVoicePreviewBytes(VID))).toEqual(new Uint8Array([1, 2, 3]));
    expect(fetchSpy.mock.calls[1][0]).toBe(PREVIEW);
    fetchSpy.mockResolvedValueOnce(new Response('x', { status: 200, headers: { 'content-length': String(6 * 1024 * 1024) } }));
    await expect(libraryVoicePreviewBytes(VID)).rejects.toThrow(/too large/);
  });

  it('a voice whose proxy answer named a foreign URL has no preview', async () => {
    fetchSpy.mockResolvedValueOnce(json({ ok: true, voice: { ...publicVoice, preview_url: 'https://evil.example/x.mp3' } }));
    const r = await lookupLibraryVoice(VID);
    expect(r.ok && r.voice.hasPreview).toBe(false);
    await expect(libraryVoicePreviewBytes(VID)).rejects.toThrow(/no preview/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('isKnownLibraryVoiceId', () => {
  it('a voice stored on a character with the library marker', async () => {
    expect(await isKnownLibraryVoiceId(VID)).toBe(false);
    mockList.mockResolvedValue([{ metadata: { voiceId: VID, voiceLibrary: { name: 'Captain Wren' } } }]);
    expect(await isKnownLibraryVoiceId(VID)).toBe(true);
    expect(await isKnownLibraryVoiceId('bad id')).toBe(false);
  });
});




