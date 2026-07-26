/**
 * voiceTts (260705) — request routing + error mapping.
 *
 * Pins: a resolved ElevenLabs key (dev env / BYOK stored, 260725) talks to
 * ElevenLabs directly with the pinned model, the proxy route posts to the
 * proxy with the Bearer JWT (and the resolved voice id in the body, never a
 * key), text is clipped to the proxy cap (proxy route only), a BYOK user
 * with no key gets VOICE_NOT_CONFIGURED before any network, and upstream
 * failures map to the renderer-facing sentinels.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VOICES } from 'soulcaster';

const { mockGetSession, mockGetCharacter, mockResolveVoiceId, mockResolveRoute, mockResolveKey } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockGetCharacter: vi.fn(),
  mockResolveVoiceId: vi.fn(),
  mockResolveRoute: vi.fn(),
  mockResolveKey: vi.fn(),
}));
vi.mock('../auth/supabaseClient', () => ({
  getClient: () => ({ auth: { getSession: mockGetSession } }),
}));
vi.mock('../characterStore', () => ({ getCharacter: mockGetCharacter }));
vi.mock('./voiceAssign', () => ({ resolveVoiceId: mockResolveVoiceId }));
vi.mock('./elevenLabsKeyStore', () => ({
  resolveElevenLabsRoute: mockResolveRoute,
  resolveElevenLabsKey: mockResolveKey,
}));

import { voiceTts, voiceTtsStream, voicePreviewAvailable, ttsLanguageForText } from './tts';
import type { TtsStreamEvent } from './tts';

const VOICE = VOICES[0].id;
const CHAR = { id: 'c1', name: 'Testy' };
const fetchSpy = vi.fn();
/** The next_text conditioning tail (utterance-context, 260726) — English default. */
const NEXT_TEXT = " anyway, there's more I wanted to say about that.";

beforeEach(() => {
  vi.stubGlobal('fetch', fetchSpy);
  fetchSpy.mockReset();
  mockGetCharacter.mockResolvedValue(CHAR);
  mockResolveVoiceId.mockResolvedValue(VOICE);
  mockGetSession.mockResolvedValue({ data: { session: { access_token: 'jwt-123' } } });
  mockResolveRoute.mockResolvedValue({ kind: 'proxy' });
  mockResolveKey.mockResolvedValue(null);
});
afterEach(() => {
  vi.unstubAllGlobals();
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
    // Opening clip (no previous_text yet) carries NO conditioning at all — see
    // ttsContextFor: next_text on a conversation-opening line is what bled the
    // continuation string into the greeting's audio.
    expect(JSON.parse(init.body as string)).toEqual({ text: 'hello there', voice_id: VOICE });
  });

  it('direct route (dev env / BYOK key): talks to ElevenLabs directly with the pinned model', async () => {
    mockResolveRoute.mockResolvedValue({ kind: 'direct', key: 'dev-key' });
    fetchSpy.mockResolvedValue(okAudio());
    await voiceTts({ characterId: 'c1', text: 'hi' });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`api.elevenlabs.io/v1/text-to-speech/${VOICE}/stream`);
    expect((init.headers as Record<string, string>)['xi-api-key']).toBe('dev-key');
    expect(JSON.parse(init.body as string)).toEqual({ text: 'hi', model_id: 'eleven_flash_v2_5' });
  });

  // Utterance conditioning is scoped to ONE reply (ttsContextFor): `prev` is
  // the preceding line of that same reply, supplied by the caller, and
  // next_text only rides along when another line follows. Nothing crosses a
  // reply boundary, and a line too short to carry the extra context gets none.
  const LONG = 'this line is long enough to carry context';
  const LONG_2 = 'and here is the second line of that same reply';

  it('takes previous_text from the caller, not from any cross-turn memory', async () => {
    fetchSpy.mockImplementation(async () => okAudio());
    await voiceTts({ characterId: 'c1', text: LONG, more: true });
    await voiceTts({ characterId: 'c1', text: LONG_2, prev: LONG });
    const bodies = fetchSpy.mock.calls.map(([, i]) => JSON.parse((i as RequestInit).body as string));
    expect(bodies[0].previous_text).toBeUndefined(); // first line of the reply
    expect(bodies[0].next_text).toBe(NEXT_TEXT); // another line follows
    expect(bodies[1].previous_text).toBe(LONG); // the sibling before it
    expect(bodies[1].next_text).toBeUndefined(); // last line of the reply
  });

  it('carries NO conditioning across replies: a standalone line gets neither field', async () => {
    fetchSpy.mockImplementation(async () => okAudio());
    await voiceTts({ characterId: 'c1', text: LONG });
    await voiceTts({ characterId: 'c1', text: LONG_2 });
    for (const [, init] of fetchSpy.mock.calls as Array<[string, RequestInit]>) {
      const body = JSON.parse(init.body as string);
      expect(body.previous_text).toBeUndefined();
      expect(body.next_text).toBeUndefined();
    }
  });

  it('drops conditioning entirely on a clip too short to outweigh it', async () => {
    fetchSpy.mockImplementation(async () => okAudio());
    // Mid-reply on both sides, but three characters of primary text: this is
    // the shape that got next_text SPOKEN ("yo what's up, eh").
    await voiceTts({ characterId: 'c1', text: 'you', prev: LONG, more: true });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ text: 'you', voice_id: VOICE });
  });

  it('clips text to the proxy request cap (2500 chars, proxy v35)', async () => {
    fetchSpy.mockResolvedValue(okAudio());
    await voiceTts({ characterId: 'c1', text: 'x'.repeat(5000) });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((JSON.parse(init.body as string) as { text: string }).text.length).toBe(2500);
  });

  it('does NOT clip on the direct route (ElevenLabs takes the full text)', async () => {
    mockResolveRoute.mockResolvedValue({ kind: 'direct', key: 'dev-key' });
    fetchSpy.mockResolvedValue(okAudio());
    await voiceTts({ characterId: 'c1', text: 'x'.repeat(5000) });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((JSON.parse(init.body as string) as { text: string }).text.length).toBe(5000);
  });

  it('BYOK with no stored key → VOICE_NOT_CONFIGURED without touching the network', async () => {
    mockResolveRoute.mockResolvedValue({ kind: 'unconfigured' });
    await expect(voiceTts({ characterId: 'c1', text: 'hi' })).rejects.toThrow(
      'VOICE_NOT_CONFIGURED: add your ElevenLabs key in Settings to enable voice',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('signed out → VOICE_NO_SESSION without touching the network', async () => {
    mockGetSession.mockResolvedValue({ data: { session: null } });
    await expect(voiceTts({ characterId: 'c1', text: 'hi' })).rejects.toThrow(/VOICE_NO_SESSION/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // 260726: the curated pool is synced into SEI's ElevenLabs account, so a
  // BYOK key talking to the user's OWN account cannot speak those voices (and
  // BYOK never falls through to the proxy). Give that its own actionable
  // sentinel instead of a generic failure on every clip.
  it('direct route + a voice the account does not have → VOICE_NOT_IN_LIBRARY', async () => {
    mockResolveRoute.mockResolvedValue({ kind: 'direct', key: 'byok-key' });
    const notFound = () =>
      new Response(
        JSON.stringify({ detail: { status: 'voice_not_found', message: 'A voice for voice_id x was not found.' } }),
        { status: 404 },
      );
    fetchSpy.mockImplementation(async () => notFound());
    await expect(voiceTts({ characterId: 'c1', text: 'hi' })).rejects.toThrow(
      'VOICE_NOT_IN_LIBRARY: this voice is not in your own ElevenLabs library. Add it there, or pick a different voice.',
    );
    // The streaming path carries the same sentinel.
    await expect(voiceTtsStream({ characterId: 'c1', text: 'hi' }, () => {})).rejects.toThrow(
      /VOICE_NOT_IN_LIBRARY/,
    );
  });

  it('the proxy route keeps the generic failure for a 404', async () => {
    fetchSpy.mockResolvedValue(new Response('{"detail":{"status":"voice_not_found"}}', { status: 404 }));
    await expect(voiceTts({ characterId: 'c1', text: 'hi' })).rejects.toThrow(/VOICE_TTS_FAILED: status 404/);
  });

  it('maps 429 → VOICE_RATE_LIMITED and 503 → VOICE_NOT_CONFIGURED', async () => {
    fetchSpy.mockResolvedValue(new Response('{}', { status: 429 }));
    await expect(voiceTts({ characterId: 'c1', text: 'hi' })).rejects.toThrow(/VOICE_RATE_LIMITED/);
    fetchSpy.mockResolvedValue(new Response('{}', { status: 503 }));
    await expect(voiceTts({ characterId: 'c1', text: 'hi' })).rejects.toThrow(/VOICE_NOT_CONFIGURED/);
  });
});

// Per-message language pin (260726): CJK text pins language_code from its own
// script even while the conversation language is still 'en' (the auto-switch
// lags by 2 utterances, and a reply can mix languages line by line). Without
// it, ElevenLabs rendered Japanese/Chinese lines with English phonemes.
describe('per-message language pin', () => {
  it('a Japanese line pins ja while the conversation language is en', async () => {
    fetchSpy.mockResolvedValue(okAudio());
    await voiceTts({ characterId: 'c1', text: '何の話を聞きたいですか?' });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, string>;
    expect(body.language_code).toBe('ja');
    // Utterance-context conditioning follows the pinned language too.
    expect(body.next_text).not.toBe(NEXT_TEXT);
  });

  it('a Chinese line pins zh; a Korean line pins ko', async () => {
    fetchSpy.mockImplementation(async () => okAudio());
    await voiceTts({ characterId: 'c1', text: '你想听什么样的故事呢?' });
    await voiceTts({ characterId: 'c1', text: '안녕, 오늘 어땠어?' });
    const bodies = fetchSpy.mock.calls.map(
      (c) => JSON.parse((c as [string, RequestInit])[1].body as string) as Record<string, string>,
    );
    expect(bodies[0].language_code).toBe('zh');
    expect(bodies[1].language_code).toBe('ko');
  });

  it('kana beats han (kanji + kana is Japanese, not Chinese)', () => {
    expect(ttsLanguageForText('漢字とかなの文', 'en')).toBe('ja');
  });

  it('a kanji-only line reads as ja only when the conversation is already ja', () => {
    expect(ttsLanguageForText('日本語', 'ja')).toBe('ja');
    expect(ttsLanguageForText('日本語', 'en')).toBe('zh');
  });

  // 260726: the script test used to be a single unanchored character, so ONE
  // quoted CJK character pinned a whole English line to zh/ja/ko and the clip
  // came back garbled. CJK now has to dominate the line's letters.
  it('an English line quoting one CJK character is NOT pinned', async () => {
    expect(ttsLanguageForText('the kanji for mountain is 山, apparently', 'en')).toBe('en');
    expect(ttsLanguageForText('she wrote 안 on the board and grinned', 'en')).toBe('en');
    expect(ttsLanguageForText('we called the boss か for short, no idea why', 'en')).toBe('en');
    // Same line mid-French call: still the conversation language, not zh.
    expect(ttsLanguageForText('le kanji pour montagne est 山, parait-il', 'fr')).toBe('fr');
  });

  it('a mostly-CJK line still pins, loanwords and all', async () => {
    expect(ttsLanguageForText('この機能は最高だと思う', 'en')).toBe('ja');
    expect(ttsLanguageForText('今日は寒いね', 'en')).toBe('ja');
    expect(ttsLanguageForText('안녕, 오늘 어땠어?', 'en')).toBe('ko');
    // A short all-CJK reply has no Latin to dilute it.
    expect(ttsLanguageForText('何?', 'en')).toBe('zh');
    expect(ttsLanguageForText('はい', 'en')).toBe('ja');
    fetchSpy.mockResolvedValue(okAudio());
    await voiceTts({ characterId: 'c1', text: 'the kanji for mountain is 山, apparently' });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect('language_code' in (JSON.parse(init.body as string) as object)).toBe(false);
  });

  it('Latin script falls back to the conversation language (en stays unpinned)', async () => {
    expect(ttsLanguageForText('salut, ça va?', 'fr')).toBe('fr');
    expect(ttsLanguageForText('hello there', 'en')).toBe('en');
    fetchSpy.mockResolvedValue(okAudio());
    await voiceTts({ characterId: 'c1', text: 'plain english line' });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect('language_code' in (JSON.parse(init.body as string) as object)).toBe(false);
  });

  it('the streaming path pins per message too', async () => {
    fetchSpy.mockResolvedValue(new Response(new Uint8Array([1]), { status: 200 }));
    const events: TtsStreamEvent[] = [];
    await voiceTtsStream({ characterId: 'c1', text: 'ごめんなさい、難しいです' }, (e) => events.push(e));
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((JSON.parse(init.body as string) as Record<string, string>).language_code).toBe('ja');
  });
});

describe('voiceTtsStream stall watchdog', () => {
  /** A 200 whose body emits one chunk then goes quiet forever; aborting the
   * request signal errors the body reader, mirroring real (undici) fetch. */
  function stalledAudio(init: RequestInit): Response {
    const signal = init.signal as AbortSignal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
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
  }

  it('a body stall emits the terminal {error} instead of hanging forever', async () => {
    vi.useFakeTimers();
    try {
      fetchSpy.mockImplementation(async (_url: string, init: RequestInit) => stalledAudio(init));
      const events: TtsStreamEvent[] = [];
      const { streamId } = await voiceTtsStream({ characterId: 'c1', text: 'hi' }, (e) => events.push(e));

      // The first chunk flows; no terminal event yet.
      await vi.advanceTimersByTimeAsync(0);
      expect(events.some((e) => 'chunk' in e)).toBe(true);
      expect(events.some((e) => 'done' in e || 'error' in e)).toBe(false);

      // Quiet just short of the stall window: still waiting, not aborted.
      await vi.advanceTimersByTimeAsync(9_000);
      expect(events.some((e) => 'done' in e || 'error' in e)).toBe(false);

      // The stall window elapses: the watchdog aborts and the pump emits the
      // terminal {error} every downstream consumer unwedges on.
      await vi.advanceTimersByTimeAsync(1_100);
      const terminal = events.find((e) => 'error' in e) as { streamId: string; error: string } | undefined;
      expect(terminal).toBeDefined();
      expect(terminal?.streamId).toBe(streamId);
      expect(terminal?.error).toMatch(/VOICE_TTS_FAILED/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a chunk arriving re-arms the watchdog (slow but live streams are not cut)', async () => {
    vi.useFakeTimers();
    try {
      let push: (c: Uint8Array) => void = () => {};
      fetchSpy.mockImplementation(async (_url: string, init: RequestInit) => {
        const signal = init.signal as AbortSignal;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            push = (c) => controller.enqueue(c);
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
      const events: TtsStreamEvent[] = [];
      await voiceTtsStream({ characterId: 'c1', text: 'hi' }, (e) => events.push(e));

      // Chunks every 8s (inside the 10s window) keep the stream alive well past
      // one window's worth of wall clock.
      for (let i = 0; i < 3; i++) {
        await vi.advanceTimersByTimeAsync(8_000);
        push(new Uint8Array([i]));
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(events.filter((e) => 'chunk' in e).length).toBe(3);
      expect(events.some((e) => 'done' in e || 'error' in e)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// 260726: the probe must answer exactly what synthesize will do — it is what
// enables/disables the picker's play controls.
describe('voicePreviewAvailable', () => {
  it('true on the direct route, regardless of session', async () => {
    mockResolveRoute.mockResolvedValue({ kind: 'direct', key: 'byok-key' });
    mockGetSession.mockResolvedValue({ data: { session: null } });
    expect(await voicePreviewAvailable()).toBe(true);
  });

  it('proxy route falls back to the JWT session', async () => {
    expect(await voicePreviewAvailable()).toBe(true); // jwt-123 from beforeEach
    mockGetSession.mockResolvedValue({ data: { session: null } });
    expect(await voicePreviewAvailable()).toBe(false);
  });

  it('false for a signed-in BYOK user with no stored key (synthesize would throw)', async () => {
    mockResolveRoute.mockResolvedValue({ kind: 'unconfigured' });
    expect(await voicePreviewAvailable()).toBe(false);
  });
});
