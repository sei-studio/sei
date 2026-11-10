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

const { mockGetSession, mockGetCharacter, mockResolveVoiceId, mockResolveRoute, mockResolveKey, mockIsOwn, mockResolveTtsRoute } = vi.hoisted(() => ({
  mockIsOwn: vi.fn(),
  mockResolveTtsRoute: vi.fn(),
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
vi.mock('./voiceAssign', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./voiceAssign')>()),
  resolveVoiceId: mockResolveVoiceId,
}));
vi.mock('./ownVoices', () => ({ isOwnVoiceId: mockIsOwn }));
vi.mock('../auth/authState', () => ({
  getCurrentAuthState: () => ({ kind: 'signed_in', user: { id: '11111111-1111-4111-8111-111111111111' } }),
}));
vi.mock('./elevenLabsKeyStore', () => ({
  resolveElevenLabsRoute: mockResolveRoute,
  // 261110: the speech route (Sei voices on the ChatGPT plan, else the
  // ElevenLabs route); these tests drive both through the same mock.
  resolveSpeakRoute: mockResolveRoute,
  resolveElevenLabsKey: mockResolveKey,
  resolveTtsRoute: mockResolveTtsRoute,
}));

import {
  voiceTts,
  voiceTtsStream,
  voicePreviewAvailable,
  voicePreviewTts,
  ttsLanguageForText,
  directElevenLabsError,
  onTtsNotice,
  ownKeyFailureReason,
  _resetOwnKeyFailuresForTests,
  _ownKeyFailureCountForTests,
  clearOwnKeyFailures,
} from './tts';
import type { TtsStreamEvent, TtsNotice } from './tts';
import { ownVoiceStandInId } from './voiceAssign';

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
  mockIsOwn.mockReset();
  mockIsOwn.mockResolvedValue(false);
  // Default: the base route for every voice (what resolveTtsRoute returns
  // for a pool voice, and for any voice off cloud). Own-voice-on-cloud tests
  // override it.
  mockResolveTtsRoute.mockReset();
  mockResolveTtsRoute.mockImplementation(async () => ({ route: await mockResolveRoute(), ownKeyOnCloud: false }));
  _resetOwnKeyFailuresForTests();
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
    // Utterance form (260729): the clip text carries the sentence capital and
    // the full stop the texting register drops — see toSpokenUtterance.
    expect(JSON.parse(init.body as string)).toEqual({ text: 'Hello there.', voice_id: VOICE });
  });

  it('direct route (dev env / BYOK key): talks to ElevenLabs directly with the pinned model', async () => {
    mockResolveRoute.mockResolvedValue({ kind: 'direct', key: 'dev-key' });
    fetchSpy.mockResolvedValue(okAudio());
    await voiceTts({ characterId: 'c1', text: 'hi' });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`api.elevenlabs.io/v1/text-to-speech/${VOICE}/stream`);
    expect((init.headers as Record<string, string>)['xi-api-key']).toBe('dev-key');
    expect(JSON.parse(init.body as string)).toEqual({ text: 'Hi.', model_id: 'eleven_flash_v2_5' });
  });

  // Utterance conditioning is scoped to ONE reply (ttsContextFor): `prev` is
  // the preceding line of that same reply, supplied by the caller, and
  // next_text only rides along when another line follows. Nothing crosses a
  // reply boundary, and a line too short to carry the extra context gets none.
  const LONG = 'this line is long enough to carry context';
  const LONG_2 = 'and here is the second line of that same reply';
  /** What each of those reaches ElevenLabs as (utterance form, 260729). */
  const LONG_SPOKEN = 'This line is long enough to carry context.';

  it('takes previous_text from the caller, not from any cross-turn memory', async () => {
    fetchSpy.mockImplementation(async () => okAudio());
    await voiceTts({ characterId: 'c1', text: LONG, more: true });
    await voiceTts({ characterId: 'c1', text: LONG_2, prev: LONG });
    const bodies = fetchSpy.mock.calls.map(([, i]) => JSON.parse((i as RequestInit).body as string));
    expect(bodies[0].previous_text).toBeUndefined(); // first line of the reply
    expect(bodies[0].next_text).toBe(NEXT_TEXT); // another line follows
    // previous_text is conditioning, so it is normalized like the clip itself.
    expect(bodies[1].previous_text).toBe(LONG_SPOKEN); // the sibling before it
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

  it('drops NEXT_text on a clip too short to outweigh it, but keeps previous_text', async () => {
    fetchSpy.mockImplementation(async () => okAudio());
    // Mid-reply on both sides, but three characters of primary text: this is
    // the shape that got next_text SPOKEN ("yo what's up, eh"). previous_text
    // has no head to run into, so it rides at any length (260730) — and a clip
    // this small is precisely the one that needs to know what it follows.
    await voiceTts({ characterId: 'c1', text: 'you', prev: LONG, more: true });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      text: 'You.',
      voice_id: VOICE,
      previous_text: LONG_SPOKEN,
    });
  });

  it('gives previous_text to a short opening clip: the squeaky-call fix', async () => {
    // 260730: previous_text used to share next_text's floor, so a call's
    // OPENING lines — its shortest — were rendered knowing nothing about what
    // came before them: isolated exclamations, high onset, no declination,
    // then the character's pitch shift on top. The call seemed to "calm down"
    // only because its lines got longer. Nothing is withheld now.
    fetchSpy.mockImplementation(async () => okAudio());
    await voiceTts({ characterId: 'c1', text: 'oh', prev: LONG });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.text).toBe('Oh.');
    expect(body.previous_text).toBe(LONG_SPOKEN);
    expect(body.next_text).toBeUndefined(); // nothing follows, and it is tiny
  });

  it('never sends a bracketed stage direction to be read aloud', async () => {
    // Measured: eleven_flash_v2_5 SPEAKS "[laughs]" rather than performing it
    // (see voice/audioTags.ts), so an unprompted tag is a word in the
    // character's mouth. Stripped here as well as out of the chat bubble.
    fetchSpy.mockImplementation(async () => okAudio());
    await voiceTts({ characterId: 'c1', text: '[laughs] no way that actually worked' });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).text).toBe('No way that actually worked.');
  });

  /**
   * 260729: the companion writes in texting register ("no period at the end of
   * a sentence"), and ElevenLabs takes its intonation from the punctuation, so
   * a finished statement was being synthesized with continuation prosody: no
   * terminal pitch fall, the reply sounding cut off mid-sentence. `?` and `!`
   * survive the texting register, which is why questions always sounded
   * finished. Repaired at the synthesis boundary so it also covers speech the
   * voice-call prompt never saw (a typed reply mirrored onto a call, an
   * in-world say() routed up).
   */
  it('gives an unpunctuated statement a full stop, and leaves a question alone', async () => {
    fetchSpy.mockImplementation(async () => okAudio());
    await voiceTts({ characterId: 'c1', text: 'i already grabbed the iron' });
    await voiceTts({ characterId: 'c1', text: 'you nearby?' });
    const bodies = fetchSpy.mock.calls.map(([, i]) => JSON.parse((i as RequestInit).body as string));
    expect(bodies[0].text).toBe('I already grabbed the iron.');
    expect(bodies[1].text).toBe('You nearby?');
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
    // 5000 + the appended full stop (utterance form runs before the cap).
    expect((JSON.parse(init.body as string) as { text: string }).text.length).toBe(5001);
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

// 261019: voices from the user's own ElevenLabs account.
describe('own ElevenLabs voices', () => {
  const OWN_ID = 'aBcDeFgHiJkLmNoPqRsT';
  const OWN_CHAR = { id: 'c1', name: 'Testy', metadata: { voiceId: OWN_ID, voiceOwn: { name: 'My Clone', gender: 'male' } } };

  beforeEach(() => {
    mockGetCharacter.mockResolvedValue(OWN_CHAR);
    mockResolveVoiceId.mockResolvedValue(OWN_ID);
  });

  it('direct key route: the own id goes to ElevenLabs unchanged', async () => {
    mockResolveRoute.mockResolvedValue({ kind: 'direct', key: 'byok-key' });
    fetchSpy.mockResolvedValue(okAudio());
    await voiceTts({ characterId: 'c1', text: 'hi' });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`api.elevenlabs.io/v1/text-to-speech/${OWN_ID}/stream`);
    expect((init.headers as Record<string, string>)['xi-api-key']).toBe('byok-key');
  });

  // 261020 (T158): own voices on CLOUD.
  const cloudOwnKey = (): void => {
    mockResolveTtsRoute.mockImplementation(async ({ own }: { own: boolean }) =>
      own
        ? { route: { kind: 'direct', key: 'own-key' }, ownKeyOnCloud: true }
        : { route: { kind: 'proxy' }, ownKeyOnCloud: false },
    );
  };
  const collectNotices = (): { notices: TtsNotice[]; off: () => void } => {
    const notices: TtsNotice[] = [];
    const off = onTtsNotice((n) => notices.push(n));
    return { notices, off };
  };
  const reject401 = (): Response =>
    new Response('{"detail":{"status":"invalid_api_key"}}', { status: 401 });
  const streamOk = (): Response =>
    new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([7])); c.close(); } }), { status: 200 });

  it('cloud + own voice + no key: the stand-in pool voice speaks via the proxy, with a notice, both paths', async () => {
    const { notices, off } = collectNotices();
    const standIn = ownVoiceStandInId(OWN_CHAR as never);
    expect(VOICES.some((v) => v.id === standIn)).toBe(true);
    fetchSpy.mockImplementation(async () => okAudio());
    await voiceTts({ characterId: 'c1', text: 'hi' });
    let [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.sei.gg/tts/speech');
    expect(JSON.parse(init.body as string).voice_id).toBe(standIn);
    fetchSpy.mockImplementation(async () => streamOk());
    await voiceTtsStream({ characterId: 'c1', text: 'hi' }, () => {});
    [url, init] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('https://api.sei.gg/tts/speech');
    expect(JSON.parse(init.body as string).voice_id).toBe(standIn);
    expect(mockResolveTtsRoute).toHaveBeenCalledWith({ own: true });
    expect(notices).toEqual([
      { kind: 'own-voice-stand-in', characterId: 'c1', reason: 'no-key' },
      { kind: 'own-voice-stand-in', characterId: 'c1', reason: 'no-key' },
    ]);
    // the pick itself is never touched (no save path is reachable from here)
    expect(OWN_CHAR.metadata.voiceId).toBe(OWN_ID);
    off();
  });

  it('cloud + own voice + key: speaks DIRECT with the key, no proxy, no notice', async () => {
    cloudOwnKey();
    const { notices, off } = collectNotices();
    fetchSpy.mockResolvedValue(okAudio());
    await voiceTts({ characterId: 'c1', text: 'hi' });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`api.elevenlabs.io/v1/text-to-speech/${OWN_ID}/stream`);
    expect((init.headers as Record<string, string>)['xi-api-key']).toBe('own-key');
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(notices).toEqual([]);
    off();
  });

  it('cloud + POOL voice with a key stored: still the proxy (the plan pays, never the key)', async () => {
    cloudOwnKey();
    mockGetCharacter.mockResolvedValue({ ...CHAR, metadata: { voiceId: VOICE } });
    mockResolveVoiceId.mockResolvedValue(VOICE);
    fetchSpy.mockResolvedValue(okAudio());
    await voiceTts({ characterId: 'c1', text: 'hi' });
    expect(mockResolveTtsRoute).toHaveBeenCalledWith({ own: false });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.sei.gg/tts/speech');
    expect((init.headers as Record<string, string>)['xi-api-key']).toBeUndefined();
  });

  it('cloud + own voice + a key ElevenLabs rejects: falls back to the stand-in on the proxy, then skips the key', async () => {
    cloudOwnKey();
    const { notices, off } = collectNotices();
    const standIn = ownVoiceStandInId(OWN_CHAR as never);
    fetchSpy.mockImplementation(async (url: string) => (url.includes('elevenlabs.io') ? reject401() : okAudio()));
    await voiceTts({ characterId: 'c1', text: 'hi' });
    expect(fetchSpy.mock.calls.map(([u]) => u)).toEqual([
      expect.stringContaining(`api.elevenlabs.io/v1/text-to-speech/${OWN_ID}`),
      'https://api.sei.gg/tts/speech',
    ]);
    expect(JSON.parse((fetchSpy.mock.calls[1][1] as RequestInit).body as string).voice_id).toBe(standIn);
    // The refusal is remembered: the next line goes straight to the stand-in.
    await voiceTts({ characterId: 'c1', text: 'again' });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(fetchSpy.mock.calls[2][0]).toBe('https://api.sei.gg/tts/speech');
    expect(notices.map((n) => n.kind === 'own-voice-stand-in' && n.reason)).toEqual(['key-invalid', 'key-invalid']);
    off();
  });

  it('clearOwnKeyFailures (key re-saved): the same key is tried direct again at once', async () => {
    cloudOwnKey();
    fetchSpy.mockImplementation(async (url: string) => (url.includes('elevenlabs.io') ? reject401() : okAudio()));
    await voiceTts({ characterId: 'c1', text: 'hi' });
    expect(_ownKeyFailureCountForTests()).toBe(1);
    clearOwnKeyFailures();
    fetchSpy.mockClear();
    fetchSpy.mockImplementation(async () => okAudio());
    await voiceTts({ characterId: 'c1', text: 'again' });
    expect(fetchSpy.mock.calls[0][0]).toContain(`api.elevenlabs.io/v1/text-to-speech/${OWN_ID}`);
  });

  it('remembered refusals are bounded (expired pruned, oldest dropped past the cap)', async () => {
    fetchSpy.mockImplementation(async (url: string) => (url.includes('elevenlabs.io') ? reject401() : okAudio()));
    for (let i = 0; i < 80; i++) {
      // A different key per line: each refusal is its own (key, voice) entry.
      mockResolveTtsRoute.mockImplementation(async ({ own }: { own: boolean }) =>
        own
          ? { route: { kind: 'direct', key: `own-key-${i}` }, ownKeyOnCloud: true }
          : { route: { kind: 'proxy' }, ownKeyOnCloud: false },
      );
      await voiceTts({ characterId: 'c1', text: `line ${i}` });
    }
    expect(_ownKeyFailureCountForTests()).toBeLessThanOrEqual(64);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 6 * 60_000);
      await voiceTts({ characterId: 'c1', text: 'later' });
      // Everything older than the TTL was pruned; only the newest refusal is left.
      expect(_ownKeyFailureCountForTests()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('streaming: a rejected own key falls back before any chunk reaches the sink', async () => {
    cloudOwnKey();
    const events: TtsStreamEvent[] = [];
    fetchSpy.mockImplementation(async (url: string) => (url.includes('elevenlabs.io') ? reject401() : streamOk()));
    await voiceTtsStream({ characterId: 'c1', text: 'hi' }, (e) => events.push(e));
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[1][0]).toBe('https://api.sei.gg/tts/speech');
    expect(events.some((e) => 'done' in e)).toBe(true);
    expect(events.some((e) => 'error' in e)).toBe(false);
  });

  it('cloud + own key + a network failure: the normal error, no fallback (not the key\'s fault)', async () => {
    cloudOwnKey();
    fetchSpy.mockRejectedValue(new Error('ECONNRESET'));
    await expect(voiceTts({ characterId: 'c1', text: 'hi' })).rejects.toThrow(/^VOICE_TTS_FAILED/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('local (BYOK) + own voice + a rejected key: unchanged, the error surfaces, never the proxy', async () => {
    mockResolveRoute.mockResolvedValue({ kind: 'direct', key: 'byok-key' });
    fetchSpy.mockImplementation(async () => reject401());
    await expect(voiceTts({ characterId: 'c1', text: 'hi' })).rejects.toThrow(/^VOICE_ELEVEN_KEY_INVALID/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('ownKeyFailureReason maps only the key-side sentinels', () => {
    expect(ownKeyFailureReason(new Error('VOICE_ELEVEN_KEY_INVALID: x'))).toBe('key-invalid');
    expect(ownKeyFailureReason(new Error('VOICE_NOT_IN_LIBRARY: x'))).toBe('voice-missing');
    expect(ownKeyFailureReason(new Error('VOICE_ELEVEN_QUOTA: x'))).toBe('quota');
    expect(ownKeyFailureReason(new Error('VOICE_NEEDS_PAID_PLAN: x'))).toBe('plan');
    expect(ownKeyFailureReason(new Error('VOICE_TTS_FAILED: status 500'))).toBeNull();
    expect(ownKeyFailureReason(new Error('VOICE_NO_SESSION: x'))).toBeNull();
  });

  it("an adopted character with its author's own voice plays a pool voice on the proxy", async () => {
    const pool = VOICES[1].id;
    mockGetCharacter.mockResolvedValue({ ...OWN_CHAR, owner: '22222222-2222-4222-8222-222222222222' });
    mockResolveVoiceId.mockResolvedValue(pool); // what the real resolver borrows
    fetchSpy.mockResolvedValue(okAudio());
    await voiceTts({ characterId: 'c1', text: 'hi' });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.sei.gg/tts/speech');
    expect(JSON.parse(init.body as string).voice_id).toBe(pool);
  });

  it('key removed (unconfigured): the normal setup hint, not a swap', async () => {
    mockResolveRoute.mockResolvedValue({ kind: 'unconfigured' });
    await expect(voiceTts({ characterId: 'c1', text: 'hi' })).rejects.toThrow(/VOICE_NOT_CONFIGURED/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a pool voice on the proxy route is unaffected by the own-voice gate', async () => {
    mockGetCharacter.mockResolvedValue({ ...CHAR, metadata: { voiceId: VOICE } });
    mockResolveVoiceId.mockResolvedValue(VOICE);
    fetchSpy.mockResolvedValue(okAudio());
    await voiceTts({ characterId: 'c1', text: 'hi' });
    expect(fetchSpy.mock.calls[0][0]).toBe('https://api.sei.gg/tts/speech');
  });

  it('a stale voiceOwn beside a POOL id does not trip the own-voice gate', async () => {
    mockGetCharacter.mockResolvedValue({ ...CHAR, metadata: { voiceId: VOICE, voiceOwn: { name: 'Old Clone' } } });
    mockResolveVoiceId.mockResolvedValue(VOICE);
    fetchSpy.mockResolvedValue(okAudio());
    await voiceTts({ characterId: 'c1', text: 'hi' });
    expect(fetchSpy.mock.calls[0][0]).toBe('https://api.sei.gg/tts/speech');
  });

  it('preview allowlist: pool or a voice in the current account, nothing else', async () => {
    mockResolveRoute.mockResolvedValue({ kind: 'direct', key: 'byok-key' });
    fetchSpy.mockResolvedValue(okAudio());
    await expect(voicePreviewTts({ voiceId: 'SomeoneElse123456789' })).rejects.toThrow(/unknown voice/);
    expect(fetchSpy).not.toHaveBeenCalled();
    mockIsOwn.mockResolvedValue(true);
    await voicePreviewTts({ voiceId: OWN_ID });
    expect(mockIsOwn).toHaveBeenCalledWith(OWN_ID);
    expect(fetchSpy.mock.calls[0][0]).toContain(`/v1/text-to-speech/${OWN_ID}`);
  });

  it('cloud preview: an own voice samples through the own key, a pool voice through the proxy', async () => {
    cloudOwnKey();
    fetchSpy.mockImplementation(async () => okAudio());
    mockIsOwn.mockImplementation(async (id: string) => id === OWN_ID);
    await voicePreviewTts({ voiceId: OWN_ID, calmness: 0.35 });
    expect(fetchSpy.mock.calls[0][0]).toContain(`api.elevenlabs.io/v1/text-to-speech/${OWN_ID}`);
    expect(((fetchSpy.mock.calls[0][1] as RequestInit).headers as Record<string, string>)['xi-api-key']).toBe('own-key');
    await voicePreviewTts({ voiceId: VOICE, calmness: 0.35 });
    expect(fetchSpy.mock.calls[1][0]).toBe('https://api.sei.gg/tts/speech');
  });
});

describe('voicePreviewTts by companion (261110, profile Overview sample)', () => {
  it('plays the assigned pool voice and resolves it without writing anything', async () => {
    mockGetCharacter.mockResolvedValue({ ...CHAR, metadata: { voiceId: VOICES[1].id } });
    mockResolveVoiceId.mockClear();
    fetchSpy.mockResolvedValue(okAudio());
    await voicePreviewTts({ characterId: 'c1' });
    expect(fetchSpy.mock.calls[0][0]).toBe('https://api.sei.gg/tts/speech');
    expect(JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body)).voice_id).toBe(VOICES[1].id);
    expect(mockResolveVoiceId).not.toHaveBeenCalled();
  });

  it('a silent companion has no sample', async () => {
    mockGetCharacter.mockResolvedValue({ ...CHAR, metadata: { voiceId: 'none' } });
    await expect(voicePreviewTts({ characterId: 'c1' })).rejects.toThrow(/VOICE_DISABLED/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("someone else's own ElevenLabs voice samples as the voice they chose for others", async () => {
    const foreign = {
      ...CHAR,
      owner: '22222222-2222-4222-8222-222222222222',
      is_default: false,
      metadata: { voiceId: 'aBcDeFgHiJkLmNoPqRsT', voiceOwn: { name: 'Clone', gender: 'female' }, voiceShared: VOICES[2].id },
    };
    mockGetCharacter.mockResolvedValue(foreign);
    fetchSpy.mockResolvedValue(okAudio());
    await voicePreviewTts({ characterId: 'c1' });
    expect(JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body)).voice_id).toBe(
      ownVoiceStandInId(foreign as never),
    );
  });
});

describe('directElevenLabsError (BYOK account answers)', () => {
  it('voice missing → VOICE_NOT_IN_LIBRARY', () => {
    expect(directElevenLabsError(404, '{"detail":{"status":"voice_not_found"}}')).toMatch(/^VOICE_NOT_IN_LIBRARY/);
  });

  it('free plan refusing a library voice → VOICE_NEEDS_PAID_PLAN', () => {
    const body = JSON.stringify({
      detail: { status: 'free_users_not_allowed', message: 'Free users cannot use library voices via the API.' },
    });
    expect(directElevenLabsError(402, body)).toMatch(/^VOICE_NEEDS_PAID_PLAN/);
    expect(directElevenLabsError(403, body)).toMatch(/^VOICE_NEEDS_PAID_PLAN/);
    expect(directElevenLabsError(401, body)).toMatch(/^VOICE_NEEDS_PAID_PLAN/);
  });

  it('out of their own credits → VOICE_ELEVEN_QUOTA, never Sei credit copy', () => {
    expect(directElevenLabsError(401, '{"detail":{"status":"quota_exceeded"}}')).toMatch(/^VOICE_ELEVEN_QUOTA/);
    expect(directElevenLabsError(402, '{"detail":{"code":"insufficient_credits"}}')).toMatch(/^VOICE_ELEVEN_QUOTA/);
    expect(directElevenLabsError(402, '')).toMatch(/^VOICE_ELEVEN_QUOTA/);
  });

  it('a rejected key → VOICE_ELEVEN_KEY_INVALID; other statuses fall through', () => {
    expect(directElevenLabsError(401, '{"detail":{"status":"invalid_api_key"}}')).toMatch(/^VOICE_ELEVEN_KEY_INVALID/);
    expect(directElevenLabsError(429, '{}')).toBeNull();
    expect(directElevenLabsError(500, 'oops')).toBeNull();
  });

  it('wired into the direct route only', async () => {
    mockResolveRoute.mockResolvedValue({ kind: 'direct', key: 'byok-key' });
    fetchSpy.mockImplementation(async () => new Response('{"detail":{"status":"insufficient_credits"}}', { status: 402 }));
    await expect(voiceTts({ characterId: 'c1', text: 'hi' })).rejects.toThrow(/^VOICE_ELEVEN_QUOTA/);
    await expect(voiceTtsStream({ characterId: 'c1', text: 'hi' }, () => {})).rejects.toThrow(/VOICE_ELEVEN_QUOTA/);
    mockResolveRoute.mockResolvedValue({ kind: 'proxy' });
    await expect(voiceTts({ characterId: 'c1', text: 'hi' })).rejects.not.toThrow(/VOICE_ELEVEN_QUOTA/);
  });
});
