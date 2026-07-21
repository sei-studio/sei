/**
 * Voice-call TTS (260705) — synthesize a companion's spoken line (MAIN only).
 *
 * Normal path: POST `${proxy}/tts/speech` with the Supabase Bearer JWT — the
 * ElevenLabs key lives on the proxy and never ships in the client. Requires a
 * signed-in session, like every other cloud surface.
 *
 * Dev path: when SEI_TTS_DEV_KEY is set in the environment (dev shells only —
 * never a committed file; see .env.example), main talks to ElevenLabs
 * directly so the voice pipeline can be exercised without a deployed proxy.
 * Model/format pins mirror the proxy (sei-proxy src/tts/forward.ts).
 *
 * Errors are thrown as Error with a sentinel message prefix the renderer can
 * match on: VOICE_NO_SESSION, VOICE_NO_CREDITS (402 — playtime balance
 * exhausted; TTS bills from the same ledger as LLM turns), VOICE_RATE_LIMITED
 * (429 — daily $ cap), VOICE_NOT_CONFIGURED, VOICE_TTS_FAILED.
 */
import { getClient } from '../auth/supabaseClient';
import { getCharacter } from '../characterStore';
import { loadConfig } from '../configStore';
import { ttsSpeedFor, voicePitchRate } from '../../shared/voicePitch';
import { clampChatLanguage, type ChatLanguage } from '../../shared/chatLanguage';
import { toSpokenRegister } from './spokenRegister';
import { resolveVoiceId, isPoolVoiceId } from './voiceAssign';
import { previewCacheKey, readCachedPreview, writeCachedPreview } from './previewCache';
import { NO_VOICE_ID } from '../../shared/voiceIds';

const PROXY_BASE_URL = process.env.SEI_PROXY_URL ?? 'https://api.sei.gg';
const ELEVENLABS_TTS_MODEL = 'eleven_flash_v2_5';
const ELEVENLABS_OUTPUT_FORMAT = 'mp3_44100_128';
const TTS_TIMEOUT_MS = 30_000;
/** Proxy-side request cap (ttsDailyGate); clip rather than 400 on long replies. */
const MAX_TTS_CHARS = 1000;

/**
 * 260709: conversation language for TTS. Non-English pins ElevenLabs'
 * `language_code` (eleven_flash_v2_5 is multilingual; auto-detect is flaky on
 * the short one-liners a live call produces, so pinning wins). 'en' sends
 * nothing — request bodies stay byte-identical to before. Read fresh per
 * synthesis so a Settings change applies to the very next spoken line.
 */
async function ttsLanguage(): Promise<ChatLanguage> {
  try {
    return clampChatLanguage((await loadConfig()).chat_language);
  } catch {
    return 'en';
  }
}

/**
 * Chat-register → spoken-register shorthand expansion is an ENGLISH word list
 * ("lmao" → "haha"); on any other conversation language it must not touch the
 * text (a \b-bounded English token can still shadow a real word in French or
 * Spanish). Pure pass-through for non-English.
 */
function spokenTextFor(text: string, language: ChatLanguage): string {
  return language === 'en' ? toSpokenRegister(text) : text.trim();
}

async function getJwtOrNull(): Promise<string | null> {
  try {
    const { data } = await getClient().auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

async function fetchAudio(url: string, headers: Record<string, string>, body: unknown): Promise<ArrayBuffer> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), TTS_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    throw new Error(`VOICE_TTS_FAILED: ${(err as Error).message}`);
  }
  if (!res.ok) {
    clearTimeout(timeout);
    const text = await res.text().catch(() => '');
    if (res.status === 402) throw new Error('VOICE_NO_CREDITS: playtime balance exhausted');
    if (res.status === 429) throw new Error('VOICE_RATE_LIMITED: daily usage cap reached');
    if (res.status === 503) throw new Error('VOICE_NOT_CONFIGURED: voice service unavailable');
    // Log a truncated excerpt for diagnosis; never bubble upstream bodies.
    console.warn(`[sei/voice] tts upstream ${res.status}: ${text.slice(0, 200)}`);
    throw new Error(`VOICE_TTS_FAILED: status ${res.status}`);
  }
  // Response established (headers in): the timeout was a connect / time-to-
  // first-byte guard, NOT a whole-delivery deadline. A near-cap (up to 1000
  // char) clip's body can take longer than TTS_TIMEOUT_MS to download; clear
  // the timer now so reading it can't abort mid-stream.
  clearTimeout(timeout);
  const buf = await res.arrayBuffer();
  return buf;
}

/**
 * Route a (text, voiceId) pair to the dev key or the proxy. `speed` (< 1 for
 * pitched-up characters) slows the synthesis so the renderer's pitched
 * playback lands at normal pace — see shared/voicePitch.ts. The proxy relays
 * it as voice_settings.speed; an older deployed proxy strips the field
 * (speech then runs fast until the proxy ships, never an error).
 */
async function synthesize(
  text: string,
  voiceId: string,
  speed?: number,
  language: ChatLanguage = 'en',
): Promise<ArrayBuffer> {
  // Non-English pins the synthesis language (see ttsLanguage). An older
  // deployed proxy strips the unknown field — speech still auto-detects, never
  // an error — same forward-compat stance as `speed`.
  const langField = language !== 'en' ? { language_code: language } : {};
  const devKey = process.env.SEI_TTS_DEV_KEY;
  if (devKey) {
    return fetchAudio(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=${ELEVENLABS_OUTPUT_FORMAT}`,
      { 'xi-api-key': devKey },
      { text, model_id: ELEVENLABS_TTS_MODEL, ...langField, ...(speed !== undefined ? { voice_settings: { speed } } : {}) },
    );
  }
  const jwt = await getJwtOrNull();
  if (!jwt) throw new Error('VOICE_NO_SESSION: sign in to use voice calls');
  return fetchAudio(
    `${PROXY_BASE_URL}/tts/speech`,
    { Authorization: `Bearer ${jwt}` },
    { text, voice_id: voiceId, ...langField, ...(speed !== undefined ? { speed } : {}) },
  );
}

/** Synthesize `text` in `characterId`'s voice; resolves to audio/mpeg bytes. */
export async function voiceTts(args: { characterId: string; text: string }): Promise<ArrayBuffer> {
  const character = await getCharacter(args.characterId);
  if (!character) throw new Error('VOICE_TTS_FAILED: character not found');
  // Explicit "no voice" pick (260720): a silent companion never synthesizes.
  // The renderer's TTS catch paths swallow this sentinel quietly (text still
  // lands in transcripts; no audio plays).
  if (character.metadata?.voiceId === NO_VOICE_ID) {
    throw new Error('VOICE_DISABLED: this companion has no voice');
  }
  const voiceId = await resolveVoiceId(character);
  const language = await ttsLanguage();
  // Spoken register BEFORE the cap: chat lines mirrored into the call carry
  // shorthand ("lmao", "rn") that TTS would read literally. English only —
  // see spokenTextFor.
  const text = spokenTextFor(args.text, language).slice(0, MAX_TTS_CHARS);
  if (!text) throw new Error('VOICE_TTS_FAILED: empty text');
  return synthesize(text, voiceId, ttsSpeedFor(voicePitchRate(character)), language);
}

/** Monotonic stream ids for voiceTtsStream (uniqueness within one main run). */
let nextStreamSeq = 1;

export type TtsStreamEvent =
  | { streamId: string; chunk: ArrayBuffer }
  | { streamId: string; done: true }
  | { streamId: string; error: string };

/**
 * Streaming synthesis (260705). Same request as voiceTts — the proxy (and the
 * dev path) already hit ElevenLabs' /stream endpoint; the buffering was OURS
 * (res.arrayBuffer()). This resolves { streamId } as soon as upstream says
 * 200 and then pumps body chunks to `sink` (ordered; terminal {done} or
 * {error}), so the renderer can start playback on the first mp3 frame.
 * Pre-flight failures (no session, 402/429/503, fetch error) reject the
 * returned promise with the same sentinels as voiceTts — the renderer's
 * existing catch copy applies unchanged.
 */
export async function voiceTtsStream(
  args: { characterId: string; text: string },
  sink: (event: TtsStreamEvent) => void,
): Promise<{ streamId: string }> {
  const character = await getCharacter(args.characterId);
  if (!character) throw new Error('VOICE_TTS_FAILED: character not found');
  // Silent companion (see voiceTts) — reject before any network work.
  if (character.metadata?.voiceId === NO_VOICE_ID) {
    throw new Error('VOICE_DISABLED: this companion has no voice');
  }
  const voiceId = await resolveVoiceId(character);
  const language = await ttsLanguage();
  // Spoken register BEFORE the cap (see voiceTts). English only.
  const text = spokenTextFor(args.text, language).slice(0, MAX_TTS_CHARS);
  if (!text) throw new Error('VOICE_TTS_FAILED: empty text');
  // Pace compensation for pitched playback (see synthesize / shared/voicePitch.ts).
  const speed = ttsSpeedFor(voicePitchRate(character));
  // Language pin for non-English (see synthesize — same forward-compat stance).
  const langField = language !== 'en' ? { language_code: language } : {};

  const devKey = process.env.SEI_TTS_DEV_KEY;
  const url = devKey
    ? `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=${ELEVENLABS_OUTPUT_FORMAT}`
    : `${PROXY_BASE_URL}/tts/speech`;
  let headers: Record<string, string>;
  let body: unknown;
  if (devKey) {
    headers = { 'xi-api-key': devKey };
    body = { text, model_id: ELEVENLABS_TTS_MODEL, ...langField, ...(speed !== undefined ? { voice_settings: { speed } } : {}) };
  } else {
    const jwt = await getJwtOrNull();
    if (!jwt) throw new Error('VOICE_NO_SESSION: sign in to use voice calls');
    headers = { Authorization: `Bearer ${jwt}` };
    body = { text, voice_id: voiceId, ...langField, ...(speed !== undefined ? { speed } : {}) };
  }

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), TTS_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    throw new Error(`VOICE_TTS_FAILED: ${(err as Error).message}`);
  }
  if (!res.ok || !res.body) {
    clearTimeout(timeout);
    const bodyText = await res.text().catch(() => '');
    if (res.status === 402) throw new Error('VOICE_NO_CREDITS: playtime balance exhausted');
    if (res.status === 429) throw new Error('VOICE_RATE_LIMITED: daily usage cap reached');
    if (res.status === 503) throw new Error('VOICE_NOT_CONFIGURED: voice service unavailable');
    console.warn(`[sei/voice] tts upstream ${res.status}: ${bodyText.slice(0, 200)}`);
    throw new Error(`VOICE_TTS_FAILED: status ${res.status}`);
  }
  // Response established (headers in): the timeout guarded connect / time-to-
  // first-byte only, NOT the whole stream. A near-cap reply can take longer
  // than TTS_TIMEOUT_MS to fully stream; since this same AbortController also
  // governs the body reader, leaving the timer armed would abort playback
  // mid-sentence. Clear it here so only the pre-response fetch was protected.
  clearTimeout(timeout);

  const streamId = `tts-${nextStreamSeq++}`;
  // Pump in the background; the caller gets the id NOW so it can route chunks.
  const reader = res.body.getReader();
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          // Copy out of the pooled buffer before it crosses the IPC boundary.
          const chunk = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
          sink({ streamId, chunk });
        }
      }
      sink({ streamId, done: true });
    } catch (err) {
      sink({ streamId, error: `VOICE_TTS_FAILED: ${(err as Error).message}` });
    }
  })();
  return { streamId };
}

/**
 * The voice-picker sample line (260720). English is the exact spec line for
 * the picker ("Hi, this is what I sound like."); the other conversation
 * languages carry the same sentence (260709 localization: the sample should
 * demonstrate the voice the way the user will actually hear it).
 */
const PREVIEW_LINES: Record<ChatLanguage, string> = {
  en: 'Hi, this is what I sound like.',
  zh: '嗨，这就是我的声音。',
  ja: 'やあ、これが私の声だよ。',
  ko: '안녕, 이게 내 목소리야.',
  fr: 'Salut, voici ma voix.',
  es: 'Hola, así es como sueno.',
};

/**
 * Voice-picker sample (260705; disk-cached 260720): speak the sample line in
 * an arbitrary curated-pool voice — no character needed (the picker runs
 * before the voice is committed). Pool membership is enforced here AND by the
 * proxy allowlist. Each (voice, line) pair synthesizes at most once per
 * machine — repeat plays are served from the userData cache for free.
 */
export async function voicePreviewTts(voiceId: string): Promise<ArrayBuffer> {
  if (!isPoolVoiceId(voiceId)) throw new Error('VOICE_TTS_FAILED: unknown voice');
  const language = await ttsLanguage();
  const line = PREVIEW_LINES[language] ?? PREVIEW_LINES.en;
  const key = previewCacheKey(voiceId, line);
  const cached = await readCachedPreview(key);
  if (cached) return cached;
  const buf = await synthesize(line, voiceId, undefined, language);
  await writeCachedPreview(key, buf);
  return buf;
}

/**
 * Whether voice samples can synthesize right now (260720): a dev TTS key or a
 * signed-in session. The picker uses this to disable sample playback with a
 * quiet hint (selection still works) instead of failing on first click.
 */
export async function voicePreviewAvailable(): Promise<boolean> {
  if (process.env.SEI_TTS_DEV_KEY) return true;
  return (await getJwtOrNull()) !== null;
}
