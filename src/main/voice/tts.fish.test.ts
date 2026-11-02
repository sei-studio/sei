/**
 * Fish Audio as the local voice (261103): routing, the automatic voice and a
 * character's own pick, and the Fast fallback with its one notice. Same
 * harness as tts.kokoro.test.ts; the Fish HTTP client is mocked here (its
 * own behavior is pinned in fishTts.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
const m = vi.hoisted(() => ({
  config: { tts_engine: 'local', local_tts_model: 'fish', chat_language: 'en' } as Record<string, unknown>,
  backend: 'local', gender: 'female', key: 'fish-key' as string | null,
  local: vi.fn(), ready: vi.fn(), route: vi.fn(), fishSynth: vi.fn(), fishOpen: vi.fn(),
  character: { id: 'c1', name: 'Test', metadata: { voiceId: 'voice123456789', language: undefined as string | undefined } },
}));
vi.mock('../configStore', () => ({ loadConfig: async () => m.config }));
vi.mock('../apiKeyStore', () => ({ getAiBackendKind: async () => m.backend }));
vi.mock('../characterStore', () => ({ getCharacter: async () => m.character }));
vi.mock('./voiceAssign', () => ({
  resolveVoiceId: async () => 'voice123456789',
  ownVoicePickOf: () => null,
  isPoolVoiceId: () => true, ownVoiceStandInId: () => 'voice123456789',
}));
vi.mock('../speech', async () => ({
  ...await import('../speech/localVoice'),
  ...await import('../speech/packs'),
  ...await import('../speech/kokoro'),
  ...await import('../speech/spokenLanguage'),
  packMissingError: (id: string) => new Error(`VOICE_PACK_MISSING:${id}`),
  synthesizeKokoro: vi.fn(), synthesizeLocal: m.local, packReady: m.ready,
  releaseKokoroEngines: vi.fn(),
  voiceGenderFor: (_id: string, hint?: string) => hint ?? m.gender,
}));
vi.mock('../auth/supabaseClient', () => ({ getClient: () => null }));
vi.mock('./elevenLabsKeyStore', () => ({ resolveElevenLabsRoute: m.route, resolveTtsRoute: m.route }));
vi.mock('./ownVoices', () => ({ isOwnVoiceId: () => false }));
vi.mock('../creditWall', () => ({ noteCreditWall: vi.fn() }));
vi.mock('./stt', () => ({ encodeWav: () => new TextEncoder().encode('RIFF').buffer }));
vi.mock('./fishKeyStore', () => ({ resolveFishKey: async () => m.key }));
vi.mock('./fishTts', async (orig) => ({
  ...await orig<typeof import('./fishTts')>(),
  synthesizeFish: m.fishSynth,
  openFishStream: m.fishOpen,
}));
import { voiceTts, voicePreviewTts, voiceTtsStream, fishSampleTts, onTtsNotice, type TtsNotice } from './tts';
import { clearFishFailures } from './fishTts';
import { FISH_VOICES } from '../../shared/fishVoices';

const notices: TtsNotice[] = [];
onTtsNotice((n) => notices.push(n));
const MP3 = new Uint8Array([0xff, 0xf3, 0x10, 0x20]).buffer;
const OWN = 'f'.repeat(32);

type StreamEvent = { streamId: string; chunk?: ArrayBuffer; done?: true; error?: string };

function collect(): { events: StreamEvent[]; sink: (e: StreamEvent) => void; settled: Promise<void> } {
  const events: StreamEvent[] = [];
  let resolve!: () => void;
  const settled = new Promise<void>((r) => { resolve = r; });
  return {
    events,
    sink: (e) => { events.push(e); if (e.done || e.error) resolve(); },
    settled,
  };
}

describe('Fish Audio TTS routing', () => {
  beforeEach(() => {
    for (const k of Object.keys(m.config)) delete m.config[k];
    Object.assign(m.config, { tts_engine: 'local', local_tts_model: 'fish', chat_language: 'en' });
    m.backend = 'local'; m.gender = 'female'; m.key = 'fish-key';
    m.character.metadata.voiceId = 'voice123456789';
    m.local.mockReset().mockResolvedValue({ samples: new Float32Array([0.1]), sampleRate: 24000 });
    m.ready.mockReset().mockImplementation(async (id) => id === 'tts-en' || id === 'tts-zh');
    m.route.mockReset().mockResolvedValue({ kind: 'unconfigured' });
    m.fishSynth.mockReset().mockResolvedValue(MP3);
    m.fishOpen.mockReset();
    clearFishFailures();
    notices.length = 0;
  });

  it('speaks with the automatic voice for the gender and the line language', async () => {
    const buf = await voiceTts({ characterId: 'c1', text: 'Hello Marco.' });
    expect(buf).toBe(MP3);
    expect(m.fishSynth).toHaveBeenLastCalledWith('fish-key', expect.any(String),
      expect.objectContaining({ id: FISH_VOICES.en.female.id, source: 'auto', speed: FISH_VOICES.en.female.speed }), 'en');
    m.gender = 'male';
    await voiceTts({ characterId: 'c1', text: '你好，今天想做什么？' });
    expect(m.fishSynth).toHaveBeenLastCalledWith('fish-key', expect.any(String),
      expect.objectContaining({ id: FISH_VOICES.zh.male.id }), 'zh');
    expect(m.local).not.toHaveBeenCalled();
    expect(m.route).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
  });

  it("uses the character's own Fish voice when one is set", async () => {
    m.config.fish_voice_overrides = { c1: { id: OWN, name: 'Mine' } };
    await voiceTts({ characterId: 'c1', text: 'Hello.' });
    expect(m.fishSynth).toHaveBeenLastCalledWith('fish-key', expect.any(String),
      { id: OWN, name: 'Mine', speed: 1.3, volume: 0, source: 'override' }, 'en');
    // Another character keeps the automatic voice.
    m.character.id = 'c2';
    await voiceTts({ characterId: 'c2', text: 'Hello.' });
    expect(m.fishSynth).toHaveBeenLastCalledWith('fish-key', expect.any(String),
      expect.objectContaining({ source: 'auto' }), 'en');
    m.character.id = 'c1';
  });

  it('falls back to Fast with a no-key notice when no key is stored', async () => {
    m.key = null;
    const buf = await voiceTts({ characterId: 'c1', text: 'Hello.' });
    expect(buf.byteLength).toBeGreaterThan(0);
    expect(m.fishSynth).not.toHaveBeenCalled();
    expect(m.local).toHaveBeenLastCalledWith(expect.any(String), 'en-f');
    expect(notices).toEqual([{ kind: 'fish-fallback', characterId: 'c1', reason: 'no-key' }]);
  });

  it.each([
    ['FISH_KEY_INVALID: status 401', 'key-invalid'],
    ['FISH_NO_CREDIT: status 402', 'no-credit'],
    ['FISH_BUSY: status 429', 'busy'],
    ['FISH_VOICE_MISSING: status 404', 'voice-missing'],
    ['FISH_FAILED: fetch failed', 'failed'],
  ])('falls back to Fast on %s', async (message, reason) => {
    m.fishSynth.mockRejectedValue(new Error(message));
    await voiceTts({ characterId: 'c1', text: 'Hello.' });
    expect(m.local).toHaveBeenLastCalledWith(expect.any(String), 'en-f');
    expect(notices).toEqual([{ kind: 'fish-fallback', characterId: 'c1', reason }]);
  });

  it('does not ask Fish again for every line after an account refusal', async () => {
    m.fishSynth.mockRejectedValue(new Error('FISH_NO_CREDIT: status 402'));
    await voiceTts({ characterId: 'c1', text: 'One.' });
    await voiceTts({ characterId: 'c1', text: 'Two.' });
    expect(m.fishSynth).toHaveBeenCalledTimes(1);
    expect(m.local).toHaveBeenCalledTimes(2);
    expect(notices.map((n) => n.kind === 'fish-fallback' && n.reason)).toEqual(['no-credit', 'no-credit']);
    // A busy account is asked again on the next line.
    clearFishFailures();
    m.fishSynth.mockReset().mockRejectedValue(new Error('FISH_BUSY: status 429'));
    await voiceTts({ characterId: 'c1', text: 'Three.' });
    await voiceTts({ characterId: 'c1', text: 'Four.' });
    expect(m.fishSynth).toHaveBeenCalledTimes(2);
  });

  it('never reaches Fish when another local model is chosen or on a cloud account', async () => {
    m.config.local_tts_model = 'fast';
    await voiceTts({ characterId: 'c1', text: 'Hello.' });
    expect(m.fishSynth).not.toHaveBeenCalled();
    m.config.local_tts_model = 'fish'; m.backend = 'cloud-proxy';
    m.route.mockRejectedValue(new Error('cloud route reached'));
    await expect(voiceTts({ characterId: 'c1', text: 'Hello.' })).rejects.toThrow('cloud route reached');
    expect(m.fishSynth).not.toHaveBeenCalled();
  });

  it('streams the Fish mp3 chunk by chunk', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new Uint8Array([1, 2])); c.enqueue(new Uint8Array([3])); c.close(); },
    });
    m.fishOpen.mockResolvedValue({ body, ctrl: new AbortController() });
    const s = collect();
    const { streamId } = await voiceTtsStream({ characterId: 'c1', text: 'Hello.' }, s.sink);
    await s.settled;
    expect(m.fishOpen).toHaveBeenCalledWith('fish-key', expect.any(String), expect.objectContaining({ source: 'auto' }), 'en');
    expect(s.events.map((e) => (e.chunk ? e.chunk.byteLength : e.done ? 'done' : e.error))).toEqual([2, 1, 'done']);
    expect(s.events.every((e) => e.streamId === streamId)).toBe(true);
    expect(m.local).not.toHaveBeenCalled();
  });

  it('a stream that cannot open sends one Fast WAV chunk, then done, and the notice', async () => {
    m.fishOpen.mockRejectedValue(new Error('FISH_KEY_INVALID: status 401'));
    const s = collect();
    await voiceTtsStream({ characterId: 'c1', text: 'Hello.' }, s.sink);
    await s.settled;
    expect(s.events).toHaveLength(2);
    const head = new Uint8Array(s.events[0].chunk!, 0, 4);
    expect(String.fromCharCode(...head)).toBe('RIFF');
    expect(s.events[1].done).toBe(true);
    expect(notices).toEqual([{ kind: 'fish-fallback', characterId: 'c1', reason: 'key-invalid' }]);
  });

  it('the voice preview tries Fish, then the Fast sample without a notice', async () => {
    expect(await voicePreviewTts({ characterId: 'c1' })).toBe(MP3);
    m.fishSynth.mockRejectedValue(new Error('FISH_FAILED: x'));
    const buf = await voicePreviewTts({ characterId: 'c1' });
    expect(buf).not.toBe(MP3);
    expect(m.local).toHaveBeenCalled();
    expect(notices).toEqual([]);
  });

  it('the Settings test sample needs a key and reports Fish errors as they are', async () => {
    m.key = null;
    await expect(fishSampleTts()).rejects.toThrow(/^FISH_NO_KEY/);
    m.key = 'fish-key';
    expect(await fishSampleTts()).toBe(MP3);
    expect(m.fishSynth).toHaveBeenLastCalledWith('fish-key', 'Hi, this is what I sound like.',
      expect.objectContaining({ id: FISH_VOICES.en.female.id }), 'en');
    await fishSampleTts({ voiceId: OWN });
    expect(m.fishSynth).toHaveBeenLastCalledWith('fish-key', expect.any(String),
      expect.objectContaining({ id: OWN, source: 'override' }), 'en');
    m.fishSynth.mockRejectedValue(new Error('FISH_NO_CREDIT: status 402'));
    await expect(fishSampleTts()).rejects.toThrow(/^FISH_NO_CREDIT/);
  });
});
