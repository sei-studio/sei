/**
 * Voice-call TTS (260705) — synthesize a companion's spoken line (MAIN only).
 *
 * Normal path: POST `${proxy}/tts/speech` with the Supabase Bearer JWT — the
 * ElevenLabs key lives on the proxy and never ships in the client. Requires a
 * signed-in session, like every other cloud surface.
 *
 * Direct path: when resolveElevenLabsRoute (voice/elevenLabsKeyStore.ts)
 * yields a key — the SEI_TTS_DEV_KEY env (dev shells only — never a committed
 * file; see .env.example) or, for BYOK ('local' backend) users, their own
 * stored ElevenLabs key — main talks to ElevenLabs directly. Model/format
 * pins mirror the proxy (sei-proxy src/tts/forward.ts). BYOK with no key
 * stored throws VOICE_NOT_CONFIGURED instead of falling through to the proxy.
 *
 * Errors are thrown as Error with a sentinel message prefix the renderer can
 * match on: VOICE_NO_SESSION, VOICE_NO_CREDITS (402 — playtime balance
 * exhausted; TTS bills from the same ledger as LLM turns), VOICE_RATE_LIMITED
 * (429 — daily $ cap), VOICE_NOT_CONFIGURED, VOICE_NOT_IN_LIBRARY (direct
 * route: the voice is not in that ElevenLabs account), VOICE_TTS_FAILED.
 */
import { getClient } from '../auth/supabaseClient';
import { getCharacter } from '../characterStore';
import { loadConfig } from '../configStore';
import { VOICE_PITCH_MAX, VOICE_PITCH_MIN, ttsSpeedFor, voicePitchRate, voiceStabilityFor } from '../../shared/voicePitch';
import type { Character } from '../../shared/characterSchema';
import { clampChatLanguage, type ChatLanguage } from '../../shared/chatLanguage';
import { toSpokenRegister } from './spokenRegister';
import { resolveVoiceId, isPoolVoiceId } from './voiceAssign';
import { previewCacheKey, readCachedPreview, writeCachedPreview } from './previewCache';
import { NO_VOICE_ID } from '../../shared/voiceIds';
import { resolveElevenLabsRoute, type ElevenLabsRoute } from './elevenLabsKeyStore';

const PROXY_BASE_URL = process.env.SEI_PROXY_URL ?? 'https://api.sei.gg';
const ELEVENLABS_TTS_MODEL = 'eleven_flash_v2_5';
const ELEVENLABS_OUTPUT_FORMAT = 'mp3_44100_128';
const TTS_TIMEOUT_MS = 30_000;
/** Streaming synthesis: max quiet gap between body chunks before the stream is
 * declared dead. ElevenLabs (and the proxy relaying it) emits chunks at a
 * sub-second cadence for the whole clip, so this long a silence only ever means
 * a stalled socket — and a stream that never terminates is what wedged a whole
 * call mute (the renderer's audio queue and pendingTts counter unwedge ONLY on
 * the pump's terminal {done}/{error} event). */
const TTS_STREAM_STALL_MS = 10_000;
/** Proxy-side request cap (ttsGate); clip rather than 400 on long replies.
 * PROXY PATH ONLY (260725) — the direct path (dev env key or the BYOK stored
 * key) talks to ElevenLabs directly (model limit ~40k chars), so clipping
 * there just cut long lines off mid-sentence for no reason. 2500 mirrors the
 * proxy's cap as of release v35 (260725, was 1000); raising it further needs
 * the proxy cap lifted first or cloud users get a hard 400. */
const MAX_TTS_CHARS = 2500;

/** Clip to the proxy request cap only when the request will hit the proxy. */
function clipForRoute(text: string, route: ElevenLabsRoute): string {
  return route.kind === 'direct' ? text : text.slice(0, MAX_TTS_CHARS);
}

/** Renderer-facing sentinel for a BYOK user with no ElevenLabs key stored.
 * No em dash: this string is user-visible error copy. */
const NOT_CONFIGURED_BYOK = 'VOICE_NOT_CONFIGURED: add your ElevenLabs key in Settings to enable voice';

/**
 * Renderer-facing sentinel for a voice the direct route's account cannot use
 * (260726). The curated pool is community voices synced into SEI's ElevenLabs
 * account; a BYOK user's key talks to THEIR account, where those voices are
 * not in the library, and BYOK never falls through to the proxy. ElevenLabs
 * answers that with a `voice_not_found` body, which used to surface as a
 * generic failure on every single clip. No em dash: user-visible copy.
 */
const VOICE_NOT_IN_LIBRARY =
  'VOICE_NOT_IN_LIBRARY: this voice is not in your own ElevenLabs library. Add it there, or pick a different voice.';

/** ElevenLabs' "no such voice for this account" answer: a 4xx whose body names
 * the voice id as missing. Status has drifted between 400/404/422 across API
 * revisions, so the body signal is what we match on. */
function isVoiceNotFound(status: number, body: string): boolean {
  if (status !== 400 && status !== 404 && status !== 422) return false;
  return /voice_not_found|voice_does_not_exist|voice[ _]?id[^.]{0,80}(not found|does not exist)/i.test(body);
}

/**
 * 260709: conversation language for TTS. Non-English pins ElevenLabs'
 * `language_code` (eleven_flash_v2_5 is multilingual; auto-detect is flaky on
 * the short one-liners a live call produces, so pinning wins). 'en' sends
 * nothing — request bodies stay byte-identical to before. Read fresh per
 * synthesis so an auto-switch applies to the very next spoken line.
 */
async function ttsLanguage(): Promise<ChatLanguage> {
  try {
    return clampChatLanguage((await loadConfig()).chat_language);
  } catch {
    return 'en';
  }
}

// Unicode script ranges for the per-message pin below. Kana (hiragana,
// katakana, halfwidth katakana) can only be Japanese; hangul only Korean;
// han is shared by zh and ja, so it reads as Japanese only when the
// conversation is already Japanese (a kanji-only line mid-ja-call).
const KANA_RE = /[぀-ヿㇰ-ㇿｦ-ﾟ]/g;
const HANGUL_RE = /[가-힣ᄀ-ᇿ㄰-㆏]/g;
const HAN_RE = /[一-鿿㐀-䶿豈-﫿]/g;

/** Letters in any script — the denominator of the dominance ratio below. */
const LETTER_RE = /\p{L}/gu;
/**
 * How much of a line's letter content must be CJK before its script overrides
 * the conversation language. 260726: the test was a single unanchored
 * character, so ONE quoted kanji/hanzi/hangul in an otherwise English line
 * pinned the whole clip to zh/ja/ko and it came back garbled. A third of the
 * letters is far above an incidental quote and still below a genuinely mixed
 * CJK line (which carries latin loanwords, names and product terms).
 */
const CJK_PIN_RATIO = 0.3;

function countMatches(text: string, re: RegExp): number {
  return text.match(re)?.length ?? 0;
}

/**
 * Per-message language pin (260726). The conversation language follows the
 * player's voice with a 2-utterance detection lag, and a single reply can mix
 * languages line by line, so pinning every clip to the global chat_language
 * rendered CJK lines with English phonemes on a live call (Lyra spoke
 * English-accented Japanese while chat_language was still 'en'). For CJK the
 * text itself is the ground truth, so it overrides the conversation language,
 * but only when CJK actually DOMINATES the line (CJK_PIN_RATIO); Latin script
 * is ambiguous (en/fr/es share it) and falls back to it.
 */
export function ttsLanguageForText(text: string, conversationLanguage: ChatLanguage): ChatLanguage {
  const kana = countMatches(text, KANA_RE);
  const hangul = countMatches(text, HANGUL_RE);
  const han = countMatches(text, HAN_RE);
  const letters = countMatches(text, LETTER_RE);
  if (!letters || (kana + hangul + han) / letters < CJK_PIN_RATIO) return conversationLanguage;
  if (kana) return 'ja';
  if (hangul) return 'ko';
  return conversationLanguage === 'ja' ? 'ja' : 'zh';
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

// Delivery calmness (260724): voiceStabilityFor moved to shared/voicePitch.ts
// (260725) so the renderer's voice sliders share the same baked defaults.

/**
 * Utterance-context conditioning (260726). ElevenLabs renders the end of a
 * request's text with utterance-FINAL prosody — a hard terminal pitch drop —
 * whenever nothing follows it. `next_text` is read by the model but never
 * spoken: it says "more speech comes after this", so the last word keeps a
 * mid-conversation contour instead of landing hard. The string's content
 * barely matters (only that speech plausibly continues); per-language so a
 * non-English call isn't conditioned on English. `previous_text` is the
 * character's own last spoken line, which stops each clip's START from
 * resetting to fresh-utterance pitch. Live-call speech only — the voice-picker
 * sample SHOULD sound like a complete statement, and its cache key must stay
 * param-stable. The proxy relays both fields (v36); an older deployed proxy
 * strips them (endings just fall again, never an error).
 */
const TTS_NEXT_TEXT: Record<ChatLanguage, string> = {
  en: " anyway, there's more I wanted to say about that.",
  zh: '总之，这件事我还有话想说。',
  ja: 'とにかく、それについてまだ話したいことがあるんだ。',
  ko: '아무튼, 그 얘기는 아직 더 하고 싶은 게 남았어.',
  fr: " enfin, j'ai encore des choses à dire là-dessus.",
  es: ' en fin, todavía tengo más que decir sobre eso.',
};
/** A stale previous line must not make a NEW call's greeting sound
 * mid-conversation, so context expires between conversations. */
const TTS_CONTEXT_TTL_MS = 3 * 60_000;
/** Keep the conditioning tail short (and under the proxy's 1000-char field cap). */
const TTS_PREVIOUS_TEXT_MAX = 500;
const lastSpokenByCharacter = new Map<string, { text: string; at: number }>();

function ttsContextFor(characterId: string, language: ChatLanguage): Record<string, string> {
  const prev = lastSpokenByCharacter.get(characterId);
  const fresh = prev && Date.now() - prev.at < TTS_CONTEXT_TTL_MS ? prev.text.slice(-TTS_PREVIOUS_TEXT_MAX) : undefined;
  return { ...(fresh ? { previous_text: fresh } : {}), next_text: TTS_NEXT_TEXT[language] ?? TTS_NEXT_TEXT.en };
}

/** Record only AFTER a successful synthesis: a failed request's text was never
 * heard, so conditioning the next clip on it would be false continuity. */
function rememberSpoken(characterId: string, text: string): void {
  lastSpokenByCharacter.set(characterId, { text, at: Date.now() });
}

/** Test hook — the context map is module state that would leak across cases. */
export function _resetTtsContextForTest(): void {
  lastSpokenByCharacter.clear();
}

/**
 * ElevenLabs voice_settings for the dev path (the proxy path sends the same
 * knobs as flat fields — see synthesize). `style: 0` rides along with any
 * stability pin so a nonzero per-voice style default can't re-dramatize the
 * delivery that stability just flattened.
 */
function voiceSettingsFor(speed?: number, stability?: number): Record<string, number> | undefined {
  if (speed === undefined && stability === undefined) return undefined;
  return {
    ...(speed !== undefined ? { speed } : {}),
    ...(stability !== undefined ? { stability, style: 0 } : {}),
  };
}

async function getJwtOrNull(): Promise<string | null> {
  try {
    const { data } = await getClient().auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

async function fetchAudio(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  direct = false,
): Promise<ArrayBuffer> {
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
    // Direct route only: the user's own account has no such voice (see
    // VOICE_NOT_IN_LIBRARY). Actionable, so it gets its own sentinel.
    if (direct && isVoiceNotFound(res.status, text)) throw new Error(VOICE_NOT_IN_LIBRARY);
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
 * Route a (text, voiceId) pair to a resolved ElevenLabs key or the proxy
 * (see resolveElevenLabsRoute — the dev env key and the BYOK stored key are
 * the 'direct' branch; BYOK with no key throws VOICE_NOT_CONFIGURED).
 * `speed` (< 1 for pitched-up characters) slows the synthesis so the
 * renderer's pitched playback lands at normal pace — see
 * shared/voicePitch.ts. `stability` (high for calm characters — see
 * voiceStabilityFor) flattens delivery. The proxy relays both into
 * voice_settings; an older deployed proxy strips the fields (speech then
 * runs fast / expressive until the proxy ships, never an error).
 */
async function synthesize(
  text: string,
  voiceId: string,
  speed?: number,
  language: ChatLanguage = 'en',
  stability?: number,
  routeArg?: ElevenLabsRoute,
  context?: Record<string, string>,
): Promise<ArrayBuffer> {
  // Non-English pins the synthesis language (per-message via
  // ttsLanguageForText). An older deployed proxy strips the unknown field —
  // speech still auto-detects, never an error — same forward-compat stance
  // as `speed`.
  const langField = language !== 'en' ? { language_code: language } : {};
  const settings = voiceSettingsFor(speed, stability);
  const route = routeArg ?? (await resolveElevenLabsRoute());
  if (route.kind === 'direct') {
    return fetchAudio(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=${ELEVENLABS_OUTPUT_FORMAT}`,
      { 'xi-api-key': route.key },
      { text, model_id: ELEVENLABS_TTS_MODEL, ...langField, ...(context ?? {}), ...(settings ? { voice_settings: settings } : {}) },
      true,
    );
  }
  // BYOK with no key: fail with the setup hint instead of trying the proxy
  // with a JWT a BYOK user may not have (and did not opt into being metered by).
  if (route.kind === 'unconfigured') throw new Error(NOT_CONFIGURED_BYOK);
  const jwt = await getJwtOrNull();
  if (!jwt) throw new Error('VOICE_NO_SESSION: sign in to use voice calls');
  return fetchAudio(
    `${PROXY_BASE_URL}/tts/speech`,
    { Authorization: `Bearer ${jwt}` },
    { text, voice_id: voiceId, ...langField, ...(context ?? {}), ...(speed !== undefined ? { speed } : {}), ...(stability !== undefined ? { stability } : {}) },
  );
}

/**
 * 260724 latency: pre-establish the TCP+TLS connection to the TTS origin.
 * Conversation gaps outlive fetch's keep-alive window, so without this every
 * reply's first audio byte pays a fresh connection setup to the proxy edge.
 * Called fire-and-forget when a voice turn is DISPATCHED (chat:send while a
 * call is live, voice:greet, voice:companion-turn in src/main/ipc.ts) so the
 * handshake overlaps the LLM turn and the pooled connection is fresh when the
 * reply's synthesis request lands. Best-effort: never throws, any response
 * status counts (only the connection matters), throttled so bursty dispatch
 * paths cannot stack requests.
 */
let lastPrewarmAt = 0;
const PREWARM_MIN_INTERVAL_MS = 3_000;
export function prewarmTts(): void {
  const now = Date.now();
  if (now - lastPrewarmAt < PREWARM_MIN_INTERVAL_MS) return;
  lastPrewarmAt = now;
  // Fire-and-forget: the route only picks the ORIGIN to warm, so the key
  // store read rides inside the async wrapper (callers stay synchronous).
  void (async () => {
    const route = await resolveElevenLabsRoute().catch((): ElevenLabsRoute => ({ kind: 'proxy' }));
    // Unconfigured BYOK: no request will follow, so nothing to warm.
    if (route.kind === 'unconfigured') return;
    const origin = route.kind === 'direct' ? 'https://api.elevenlabs.io' : PROXY_BASE_URL;
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 3_000);
    await fetch(origin, { method: 'HEAD', signal: ctrl.signal })
      .catch(() => {})
      .finally(() => clearTimeout(timeout));
  })();
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
  // Per-message pin: the text's own script beats the conversation language
  // (see ttsLanguageForText — the fix for English-accented CJK).
  const language = ttsLanguageForText(args.text, await ttsLanguage());
  const route = await resolveElevenLabsRoute();
  // Spoken register BEFORE the cap: chat lines mirrored into the call carry
  // shorthand ("lmao", "rn") that TTS would read literally. English only —
  // see spokenTextFor.
  const text = clipForRoute(spokenTextFor(args.text, language), route);
  if (!text) throw new Error('VOICE_TTS_FAILED: empty text');
  const context = ttsContextFor(character.id, language);
  const buf = await synthesize(
    text, voiceId, ttsSpeedFor(voicePitchRate(character)), language, voiceStabilityFor(character), route, context,
  );
  rememberSpoken(character.id, text);
  return buf;
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
  // Per-message pin (see ttsLanguageForText and voiceTts).
  const language = ttsLanguageForText(args.text, await ttsLanguage());
  const route = await resolveElevenLabsRoute();
  // Spoken register BEFORE the cap (see voiceTts). English only.
  const text = clipForRoute(spokenTextFor(args.text, language), route);
  if (!text) throw new Error('VOICE_TTS_FAILED: empty text');
  // BYOK with no key: same pre-flight sentinel as synthesize (see there).
  if (route.kind === 'unconfigured') throw new Error(NOT_CONFIGURED_BYOK);
  // Pace compensation for pitched playback (see synthesize / shared/voicePitch.ts).
  const speed = ttsSpeedFor(voicePitchRate(character));
  // Delivery calmness (see voiceStabilityFor — same relay stance as speed).
  const stability = voiceStabilityFor(character);
  // Language pin for non-English (see synthesize — same forward-compat stance).
  const langField = language !== 'en' ? { language_code: language } : {};
  const settings = voiceSettingsFor(speed, stability);
  // Utterance-context conditioning (see ttsContextFor) — open terminal contour.
  const context = ttsContextFor(character.id, language);

  const url = route.kind === 'direct'
    ? `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=${ELEVENLABS_OUTPUT_FORMAT}`
    : `${PROXY_BASE_URL}/tts/speech`;
  let headers: Record<string, string>;
  let body: unknown;
  if (route.kind === 'direct') {
    headers = { 'xi-api-key': route.key };
    body = { text, model_id: ELEVENLABS_TTS_MODEL, ...langField, ...context, ...(settings ? { voice_settings: settings } : {}) };
  } else {
    const jwt = await getJwtOrNull();
    if (!jwt) throw new Error('VOICE_NO_SESSION: sign in to use voice calls');
    headers = { Authorization: `Bearer ${jwt}` };
    body = { text, voice_id: voiceId, ...langField, ...context, ...(speed !== undefined ? { speed } : {}), ...(stability !== undefined ? { stability } : {}) };
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
    // Direct route only (see fetchAudio / VOICE_NOT_IN_LIBRARY).
    if (route.kind === 'direct' && isVoiceNotFound(res.status, bodyText)) {
      throw new Error(VOICE_NOT_IN_LIBRARY);
    }
    console.warn(`[sei/voice] tts upstream ${res.status}: ${bodyText.slice(0, 200)}`);
    throw new Error(`VOICE_TTS_FAILED: status ${res.status}`);
  }
  // Response established (headers in): the fixed timeout guarded connect /
  // time-to-first-byte only, NOT the whole stream. A near-cap reply can take
  // longer than TTS_TIMEOUT_MS to fully stream, so a whole-delivery deadline
  // would abort playback mid-sentence; the body is instead guarded by the
  // inter-chunk stall watchdog below, on this same AbortController.
  clearTimeout(timeout);
  // Upstream accepted the synthesis — this line is what the player will hear
  // last, so it becomes the next clip's previous_text.
  rememberSpoken(character.id, text);

  const streamId = `tts-${nextStreamSeq++}`;
  // Pump in the background; the caller gets the id NOW so it can route chunks.
  //
  // Stall watchdog (260725): every consumer of this stream (the renderer's
  // audio-queue slot, its pendingTts counter, the chess reveal gate polling
  // voiceTtsDrained) unwedges ONLY on the terminal {done}/{error} event. A
  // half-dead socket used to hang reader.read() forever with the timer already
  // cleared — no terminal event, so the call went permanently mute behind the
  // frozen playhead until the OS gave up on the socket minutes later (heard as
  // a "random TTS message" long after). Abort when no chunk arrives for
  // TTS_STREAM_STALL_MS: read() rejects and the catch emits the {error}.
  const reader = res.body.getReader();
  let stallTimer = setTimeout(() => ctrl.abort(), TTS_STREAM_STALL_MS);
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => ctrl.abort(), TTS_STREAM_STALL_MS);
        if (value && value.byteLength > 0) {
          // Copy out of the pooled buffer before it crosses the IPC boundary.
          const chunk = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
          sink({ streamId, chunk });
        }
      }
      sink({ streamId, done: true });
    } catch (err) {
      sink({ streamId, error: `VOICE_TTS_FAILED: ${(err as Error).message}` });
    } finally {
      clearTimeout(stallTimer);
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
 * Voice-picker sample (260705; disk-cached 260720; playground params 260725):
 * speak the sample line in an arbitrary curated-pool voice — no character
 * needed (the picker runs before the voice is committed). Pool membership is
 * enforced here AND by the proxy allowlist. Each (voice, line, params) tuple
 * synthesizes at most once per machine — repeat plays are served from the
 * userData cache for free (params ride into the cache key via the hashed text
 * argument, so the no-params key is unchanged and old entries stay valid).
 *
 * `pitch` is the playground's playback rate: synthesis gets the matching pace
 * compensation (ttsSpeedFor), and the RENDERER plays the clip at
 * playbackRate = pitch with preservesPitch off — same split as live calls
 * (shared/voicePitch.ts). `calmness` maps to ElevenLabs stability.
 */
export async function voicePreviewTts(args: {
  voiceId: string;
  pitch?: number;
  calmness?: number;
}): Promise<ArrayBuffer> {
  const { voiceId } = args;
  if (!isPoolVoiceId(voiceId)) throw new Error('VOICE_TTS_FAILED: unknown voice');
  const pitch =
    typeof args.pitch === 'number' && Number.isFinite(args.pitch) && args.pitch !== 1
      ? Math.min(VOICE_PITCH_MAX, Math.max(VOICE_PITCH_MIN, args.pitch))
      : undefined;
  const calmness =
    typeof args.calmness === 'number' && Number.isFinite(args.calmness)
      ? Math.min(1, Math.max(0, args.calmness))
      : undefined;
  const language = await ttsLanguage();
  const line = PREVIEW_LINES[language] ?? PREVIEW_LINES.en;
  const paramTag =
    pitch !== undefined || calmness !== undefined ? `\n#pitch=${pitch ?? 1};calm=${calmness ?? ''}` : '';
  const key = previewCacheKey(voiceId, line + paramTag);
  const cached = await readCachedPreview(key);
  if (cached) return cached;
  const buf = await synthesize(line, voiceId, pitch !== undefined ? ttsSpeedFor(pitch) : undefined, language, calmness);
  await writeCachedPreview(key, buf);
  return buf;
}

/**
 * Whether voice samples can synthesize right now (260720). The picker uses
 * this to disable sample playback with a quiet hint (selection still works)
 * instead of failing on first click.
 *
 * 260726: the probe answers off the RESOLVED ROUTE, exactly as synthesize
 * decides. It used to fall back to "any signed-in session", but a BYOK
 * ('local' backend) user with no stored ElevenLabs key routes 'unconfigured'
 * and synthesize throws VOICE_NOT_CONFIGURED without ever reaching the proxy,
 * so a signed-in BYOK user got enabled play controls that errored on every
 * click.
 */
export async function voicePreviewAvailable(): Promise<boolean> {
  const route = await resolveElevenLabsRoute();
  if (route.kind === 'direct') return true;
  if (route.kind === 'unconfigured') return false;
  return (await getJwtOrNull()) !== null;
}
