/**
 * voiceTts (260705) — request routing + error mapping.
 *
 * Pins: the dev-key path talks to ElevenLabs directly with the pinned model,
 * the normal path posts to the proxy with the Bearer JWT (and the resolved
 * voice id in the body, never a key), text is clipped to the proxy cap, and
 * upstream failures map to the renderer-facing sentinels.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VOICES } from 'soulcaster';

const { mockGetSession, mockGetCharacter, mockResolveVoiceId } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockGetCharacter: vi.fn(),
  mockResolveVoiceId: vi.fn(),
}));
vi.mock('../auth/supabaseClient', () => ({
  getClient: () => ({ auth: { getSession: mockGetSession } }),
}));
vi.mock('../characterStore', () => ({ getCharacter: mockGetCharacter }));
vi.mock('./voiceAssign', () => ({ resolveVoiceId: mockResolveVoiceId }));

import { voiceTts } from './tts';

const VOICE = VOICES[0].id;
const CHAR = { id: 'c1', name: 'Testy' };
const fetchSpy = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchSpy);
  fetchSpy.mockReset();
  mockGetCharacter.mockResolvedValue(CHAR);
  mockResolveVoiceId.mockResolvedValue(VOICE);
  mockGetSession.mockResolvedValue({ data: { session: { access_token: 'jwt-123' } } });
  delete process.env.SEI_TTS_DEV_KEY;
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SEI_TTS_DEV_KEY;
});

function okAudio(): Response {
  return new Response(new Uint8Array([9, 9, 9]), { status: 200 });
}

describe('voiceTts', () => {
  it('proxy path: posts to /tts/speech with Bearer JWT + voice_id', async () => {
    fetchSpy.mockResolvedValue(okAudio());
    const buf = await voiceTts({ characterId: 'c1', text: 'hello there' });
    expect(new Uint8Array(buf)).toEqual(new Uint8Array([9, 9, 9]));
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.sei.gg/tts/speech');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer jwt-123');
    expect(JSON.parse(init.body as string)).toEqual({ text: 'hello there', voice_id: VOICE });
  });

  it('dev-key path: talks to ElevenLabs directly with the pinned model', async () => {
    process.env.SEI_TTS_DEV_KEY = 'dev-key';
    fetchSpy.mockResolvedValue(okAudio());
    await voiceTts({ characterId: 'c1', text: 'hi' });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`api.elevenlabs.io/v1/text-to-speech/${VOICE}/stream`);
    expect((init.headers as Record<string, string>)['xi-api-key']).toBe('dev-key');
    expect(JSON.parse(init.body as string)).toEqual({ text: 'hi', model_id: 'eleven_flash_v2_5' });
  });

  it('clips text to the proxy request cap (1000 chars)', async () => {
    fetchSpy.mockResolvedValue(okAudio());
    await voiceTts({ characterId: 'c1', text: 'x'.repeat(5000) });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((JSON.parse(init.body as string) as { text: string }).text.length).toBe(1000);
  });

  it('signed out → VOICE_NO_SESSION without touching the network', async () => {
    mockGetSession.mockResolvedValue({ data: { session: null } });
    await expect(voiceTts({ characterId: 'c1', text: 'hi' })).rejects.toThrow(/VOICE_NO_SESSION/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('maps 429 → VOICE_RATE_LIMITED and 503 → VOICE_NOT_CONFIGURED', async () => {
    fetchSpy.mockResolvedValue(new Response('{}', { status: 429 }));
    await expect(voiceTts({ characterId: 'c1', text: 'hi' })).rejects.toThrow(/VOICE_RATE_LIMITED/);
    fetchSpy.mockResolvedValue(new Response('{}', { status: 503 }));
    await expect(voiceTts({ characterId: 'c1', text: 'hi' })).rejects.toThrow(/VOICE_NOT_CONFIGURED/);
  });
});
