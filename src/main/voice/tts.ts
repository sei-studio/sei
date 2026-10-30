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
 * 261019, direct route only (the user's own ElevenLabs account answered):
 * VOICE_NEEDS_PAID_PLAN (a free ElevenLabs plan cannot use Voice Library
 * voices over the API), VOICE_ELEVEN_QUOTA (their ElevenLabs credits ran
 * out, which is NOT Sei's credit wall), VOICE_ELEVEN_KEY_INVALID.
 *
 * 261020 (T158), own voices on CLOUD: a voice from the user's own ElevenLabs
 * account speaks DIRECT with their optional stored key, while Sei's pool
 * voices keep the proxy (resolveTtsRoute in elevenLabsKeyStore.ts has the
 * table). When that key is missing, or ElevenLabs refuses it for the voice,
 * the line is spoken through the proxy with the character's stand-in pool
 * voice (ownVoiceStandInId) and a TtsNotice says why, so a call never goes
 * silent over it. The pick itself is never swapped. (This replaced the old
 * VOICE_OWN_NEEDS_KEY refusal, which muted every line.)
 */
import { createHash } from 'node:crypto';
import { getClient } from '../auth/supabaseClient';
import { getCharacter } from '../characterStore';
import { loadConfig } from '../configStore';
import { selectedTtsEngine } from '../../shared/ttsEngine';
import { voiceStabilityFor } from '../../shared/voicePitch';
import type { Character } from '../../shared/characterSchema';
import { characterLanguage, clampChatLanguage, type ChatLanguage } from '../../shared/chatLanguage';
import { toSpokenRegister, toSpokenUtterance } from './spokenRegister';
import { stripAudioTags, SUPPORTS_AUDIO_TAGS } from './audioTags';
import { resolveVoiceId, isPoolVoiceId, ownVoicePickOf, ownVoiceStandInId } from './voiceAssign';
import { previewCacheKey, readCachedPreview, writeCachedPreview } from './previewCache';
import { NO_VOICE_ID } from '../../shared/voiceIds';
import { resolveElevenLabsRoute, resolveTtsRoute, type ElevenLabsRoute } from './elevenLabsKeyStore';
import { isOwnVoiceId } from './ownVoices';
import type { SpeechPackId } from '../speech/packs';
import { noteCreditWall } from '../creditWall';

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
 * Pool voices on the user's own key (261019). Sei's curated pool is public
 * ElevenLabs Voice Library voices. ElevenLabs' docs say a library voice can be
 * used over the API WITHOUT saving it to My Voices first, but "Voice Library
 * voices are not available via the API to free tier users". So on a paid
 * plan the pool just works through the key, and on a free plan every pool
 * clip is refused. Unverified live (no key on the build machine), so the
 * match is on the body's wording and codes rather than one exact status.
 * No em dash: user-visible copy.
 */
const VOICE_NEEDS_PAID_PLAN =
  'VOICE_NEEDS_PAID_PLAN: free ElevenLabs plans cannot use library voices through the API. Pick one of your own voices, or upgrade your ElevenLabs plan.';
const VOICE_ELEVEN_QUOTA = 'VOICE_ELEVEN_QUOTA: your ElevenLabs account is out of credits';
const VOICE_ELEVEN_KEY_INVALID = 'VOICE_ELEVEN_KEY_INVALID: ElevenLabs rejected your key. Check it in Settings.';

/**
 * Map a DIRECT-route (the user's own ElevenLabs account) failure to a
 * sentinel, or null for "no specific meaning, use the generic mapping".
 * Must run before the generic 402 → VOICE_NO_CREDITS mapping: that copy
 * talks about Sei's credits, which a BYOK user does not have.
 */
export function directElevenLabsError(status: number, body: string): string | null {
  if (isVoiceNotFound(status, body)) return VOICE_NOT_IN_LIBRARY;
  if (
    (status === 402 || status === 403 || status === 401) &&
    /free[ _-]?(users?|tier|plan)|library voices?|free_users_not_allowed/i.test(body)
  ) {
    return VOICE_NEEDS_PAID_PLAN;
  }
  // ElevenLabs reports quota as 401 quota_exceeded (long-standing) or 402
  // insufficient_credits (current error table); both mean their own account.
  if (/quota_exceeded|insufficient_credits|exceeds your quota/i.test(body) || status === 402) {
    return VOICE_ELEVEN_QUOTA;
  }
  if (status === 401) return VOICE_ELEVEN_KEY_INVALID;
  return null;
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

/**
 * The full chat-register → spoken-register conversion for one clip: bracketed
 * stage directions removed (see audioTags.ts — the shipped model READS `[laughs]`
 * aloud as a word rather than performing it), then shorthand expansion (English
 * only), then utterance form — sentence casing and the terminal full stop the
 * texting register drops (see toSpokenUtterance for why that is prosody and not
 * formality). Every language gets tag-stripping and utterance form; the stop
 * mark itself is per-script.
 */
function speechTextFor(text: string, language: ChatLanguage): string {
  const untagged = stripAudioTags(text, SUPPORTS_AUDIO_TAGS);
  return toSpokenUtterance(spokenTextFor(untagged, language), language);
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
/** Keep the conditioning tail short (and under the proxy's 1000-char field cap). */
const TTS_PREVIOUS_TEXT_MAX = 500;
/**
 * Below this many characters a clip carries no NEXT_TEXT. The floor is about
 * one specific failure and only one: a greeting rendered as "yo what's up, eh",
 * the head of next_text SPOKEN ALOUD. That needs so little primary text that
 * the trailing context outweighs it, so it is a next_text problem end to end.
 *
 * 260730: previous_text is no longer gated by it (and the floor itself went
 * 24 → 10). previous_text never bled — it is behind the clip, not in front of
 * it, so there is no head for the model to run into — and gating it was the
 * direct cause of the "starts squeaky, then calms down" report: a call opens on
 * its shortest lines, all of them fell under the floor, and a clip told nothing
 * about what preceded it is synthesized as an isolated exclamation (high onset,
 * wide excursion, no declination) which then takes the character's pitch shift
 * on top. Long sentences carry their own falling contour, so the same shift
 * reads as calm and the call seemed to settle as it went on. It deliberately no
 * longer mirrors STREAM_MIN_CHARS (24) in the voice store — that one picks a
 * PLAYBACK route and says nothing about how a clip is rendered.
 */
const TTS_NEXT_TEXT_MIN_CHARS = 10;

/**
 * Utterance-context conditioning, scoped to ONE reply.
 *
 *   previous_text — the line of THIS SAME reply that ran immediately before
 *     this clip. Supplied by the renderer, which is the only layer that knows
 *     the reply's line array; main used to keep its own last-spoken-per-
 *     character map with a 3-minute TTL, which bled context ACROSS turns (and
 *     raced: a multi-line reply fires all its TTS requests in one tick, so the
 *     map still held the PREVIOUS turn's last line for every one of them).
 *   next_text — sent when another line of this same reply follows, so the clip
 *     does not land a sentence-final pitch drop mid-reply.
 *
 * Both are strictly intra-reply now: the first line of a reply has no
 * previous_text, the last has no next_text, and a single-line reply gets
 * neither. A reply is the unit of speech, so its boundaries are where the
 * prosody should reset.
 *
 * 260726: next_text used to go out on EVERY clip, including final lines, where
 * nothing followed. On the call-opening clip flash stopped merely READING the
 * continuation string and started SPEAKING it.
 */
function ttsContextFor(
  text: string,
  language: ChatLanguage,
  prev: string | undefined,
  more: boolean,
): Record<string, string> {
  // previous_text at ANY length (260730 — see TTS_NEXT_TEXT_MIN_CHARS): the
  // shortest clips are the ones that most need to know what they follow, and
  // they are exactly what the old shared floor withheld it from.
  const withNext = more && text.trim().length >= TTS_NEXT_TEXT_MIN_CHARS;
  return {
    ...(prev ? { previous_text: prev.slice(-TTS_PREVIOUS_TEXT_MAX) } : {}),
    ...(withNext ? { next_text: TTS_NEXT_TEXT[language] ?? TTS_NEXT_TEXT.en } : {}),
  };
}

/**
 * ElevenLabs voice_settings for the dev path (the proxy path sends the same
 * knobs as flat fields — see synthesize). `style: 0` rides along with any
 * stability pin so a nonzero per-voice style default can't re-dramatize the
 * delivery that stability just flattened.
 *
 * 260731: `speed` is gone. It existed only to slow a clip so the renderer's
 * pitched playback landed at normal pace, and it was the unreliable half of
 * that pair — a conditioning hint, not arithmetic, and a short utterance gives
 * the model no room to express it. Pitch is shifted locally now
 * (renderer lib/voice/pitchBus.ts) and synthesis is asked for its natural pace.
 */
function voiceSettingsFor(stability?: number): Record<string, number> | undefined {
  if (stability === undefined) return undefined;
  return { stability, style: 0 };
}

async function getJwtOrNull(): Promise<string | null> {
  try {
    const { data } = await getClient().auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

/**
 * Local TTS route (260816, china-compat W3+W4): BYOK ('local' backend) users
 * with `tts_engine: 'local'` synthesize through the sherpa-onnx voice packs in
 * main (src/main/speech/) instead of ElevenLabs. Cloud accounts ignore the
 * field entirely, and absent means 'elevenlabs' — both ElevenLabs paths
 * (proxy + direct BYOK key) are byte-identical to before.
 */
async function localTtsSelected(): Promise<boolean> {
  try {
    const { getAiBackendKind } = await import('../apiKeyStore');
    if ((await getAiBackendKind()) !== 'local') return false;
    const engine = selectedTtsEngine(await loadConfig());
    return engine === 'local' || engine === 'kokoro';
  } catch {
    return false;
  }
}

/**
 * A local synthesis spoke with a SUBSTITUTE voice pack because the pack
 * matching the line's language (the conversation language, or the line's own
 * script when it is predominantly Chinese — see detectSpokenLanguage) is not
 * installed (260908). Pushed to the renderer (main/ipc.ts forwards over
 * voice:tts-notice) so the call UI can show a system notice naming the
 * better-fitting download; the line itself still plays. Fields are pack ids
 * from speech/packs.ts.
 */
export type TtsNotice =
  | {
      kind: 'substitute-pack';
      characterId: string;
      /** Pack that would fit the conversation language but is not installed. */
      missingPackId: string;
      /** Pack the line was actually spoken with. */
      spokenPackId: string;
    }
  | {
      /** 261020 (T158): a cloud line for an OWN ElevenLabs voice was spoken
       * with the character's stand-in Sei voice instead (see header). */
      kind: 'own-voice-stand-in';
      characterId: string;
      reason: OwnVoiceStandInReason;
    };

/** Why an own voice was not spoken with the user's key (see TtsNotice). */
export type OwnVoiceStandInReason = 'no-key' | 'key-invalid' | 'voice-missing' | 'quota' | 'plan';

const ttsNoticeListeners = new Set<(notice: TtsNotice) => void>();
export function onTtsNotice(cb: (notice: TtsNotice) => void): () => void {
  ttsNoticeListeners.add(cb);
  return () => ttsNoticeListeners.delete(cb);
}
function emitTtsNotice(notice: TtsNotice): void {
  for (const l of ttsNoticeListeners) l(notice);
}

const PROXY_ROUTE: ElevenLabsRoute = { kind: 'proxy' };

/**
 * The direct-route sentinel that means "the user's key cannot speak this own
 * voice right now", mapped to a stand-in reason; null for anything else (a
 * network blip or 5xx keeps its normal error, it is not the key's fault).
 */
export function ownKeyFailureReason(err: unknown): OwnVoiceStandInReason | null {
  const msg = String((err as Error)?.message ?? err);
  if (msg.startsWith('VOICE_ELEVEN_KEY_INVALID')) return 'key-invalid';
  if (msg.startsWith('VOICE_NOT_IN_LIBRARY')) return 'voice-missing';
  if (msg.startsWith('VOICE_ELEVEN_QUOTA')) return 'quota';
  if (msg.startsWith('VOICE_NEEDS_PAID_PLAN')) return 'plan';
  return null;
}

/**
 * Own-key refusals remembered per (key, voice) for a few minutes, so a call
 * on a dead key does not pay a failed ElevenLabs round trip before every
 * line. Keyed on a key fingerprint: saving a different key retries at once.
 */
const OWN_KEY_FAILURE_TTL_MS = 5 * 60_000;
/** Hard cap on remembered refusals (expired ones are pruned first). */
const OWN_KEY_FAILURE_MAX = 64;
const ownKeyFailures = new Map<string, { reason: OwnVoiceStandInReason; until: number }>();
function ownKeyFailureKey(key: string, voiceId: string): string {
  return `${createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16)}:${voiceId}`;
}
function rememberOwnKeyFailure(k: string, reason: OwnVoiceStandInReason): void {
  const now = Date.now();
  for (const [key, v] of ownKeyFailures) if (v.until <= now) ownKeyFailures.delete(key);
  ownKeyFailures.delete(k);
  // Map iteration is insertion order: drop the oldest past the cap.
  while (ownKeyFailures.size >= OWN_KEY_FAILURE_MAX) {
    const oldest = ownKeyFailures.keys().next().value;
    if (oldest === undefined) break;
    ownKeyFailures.delete(oldest);
  }
  ownKeyFailures.set(k, { reason, until: now + OWN_KEY_FAILURE_TTL_MS });
}
/**
 * Forget every remembered refusal. Called when the stored key is saved or
 * removed: re-saving the SAME key (after topping up ElevenLabs credits, or
 * restoring a deleted voice) should retry at once, not wait out the TTL.
 */
export function clearOwnKeyFailures(): void {
  ownKeyFailures.clear();
}
/** Test seam. */
export function _resetOwnKeyFailuresForTests(): void {
  ownKeyFailures.clear();
}
/** Test seam: how many refusals are remembered. */
export function _ownKeyFailureCountForTests(): number {
  return ownKeyFailures.size;
}

interface SpeakPlan {
  route: ElevenLabsRoute;
  /** The voice id to send: the pick, or the stand-in pool voice. */
  speakId: string;
  /** A refusal of the user's key may retry once via the proxy stand-in. */
  canFallBack: boolean;
}

/**
 * Where one ElevenLabs line goes and in which voice (261020, T158). Only an
 * own voice on cloud differs from the base route: with a key it goes direct
 * (unless that key was just refused for this voice), without one it speaks
 * the stand-in pool voice through the proxy and says so.
 */
async function planSpeech(
  character: Character,
  voiceId: string,
  own: boolean,
): Promise<SpeakPlan> {
  const { route, ownKeyOnCloud } = await resolveTtsRoute({ own });
  if (own && route.kind === 'proxy') {
    emitTtsNotice({ kind: 'own-voice-stand-in', characterId: character.id, reason: 'no-key' });
    return { route, speakId: ownVoiceStandInId(character), canFallBack: false };
  }
  if (ownKeyOnCloud && route.kind === 'direct') {
    const failed = ownKeyFailures.get(ownKeyFailureKey(route.key, voiceId));
    if (failed && failed.until > Date.now()) {
      emitTtsNotice({ kind: 'own-voice-stand-in', characterId: character.id, reason: failed.reason });
      return { route: PROXY_ROUTE, speakId: ownVoiceStandInId(character), canFallBack: false };
    }
  }
  return { route, speakId: voiceId, canFallBack: ownKeyOnCloud };
}

/**
 * After a failed direct attempt: the reason to fall back with (and the
 * refusal remembered), or null when the error must propagate as-is.
 */
function ownKeyFallback(plan: SpeakPlan, character: Character, err: unknown): OwnVoiceStandInReason | null {
  if (!plan.canFallBack || plan.route.kind !== 'direct') return null;
  const reason = ownKeyFailureReason(err);
  if (!reason) return null;
  rememberOwnKeyFailure(ownKeyFailureKey(plan.route.key, plan.speakId), reason);
  emitTtsNotice({ kind: 'own-voice-stand-in', characterId: character.id, reason });
  return reason;
}

/**
 * Synthesize via the local sherpa engine and encode as WAV bytes. The
 * character's persisted ElevenLabs voiceId maps to a local voice by GENDER
 * (speech/localVoice.ts) plus the clip's language; `voicePitch` still applies
 * renderer-side through pitchBus playbackRate, untouched.
 *
 * 260908: the pack pick is INSTALLED-AWARE (speech pickLocalVoice). The old
 * resolution demanded exactly the (gender, language) slot's pack, so a zh
 * conversation with only the English pack installed threw VOICE_PACK_MISSING
 * on every line and the whole call went silent while a working voice sat on
 * disk. Now any installed pack can speak (language match preferred), and a
 * cross-language substitute additionally emits a TtsNotice naming the pack
 * that would fit better. Only when NO voice pack is installed does
 * `VOICE_PACK_MISSING:<packId>` still throw, carrying the language-matching
 * pack id — the renderer turns that into a download hint; never
 * auto-download mid-call.
 *
 * The language keyed on is the LINE's effective language, not just the
 * conversation's (speech detectSpokenLanguage): a predominantly Chinese line
 * in an 'en' conversation prefers an installed zh pack, and when the zh pack
 * is missing the notice names it — the line is what cannot be spoken well,
 * whatever the session language says.
 */
async function synthesizeLocalClip(
  text: string,
  voiceId: string,
  language: ChatLanguage,
  characterId: string,
  /** metadata.voiceOwn.gender for an own-account voice (261019). */
  genderHint?: string,
): Promise<ArrayBuffer> {
  const speech = await import('../speech');
  const effLanguage = speech.detectSpokenLanguage(text, language);
  const gender = speech.voiceGenderFor(voiceId, genderHint);
  if (selectedTtsEngine(await loadConfig()) === 'kokoro') {
    const voice = speech.pickKokoroVoice(gender, effLanguage);
    if (voice) {
      const { samples, sampleRate } = await speech.synthesizeKokoro(text, voice);
      const { encodeWav } = await import('./stt');
      return encodeWav(samples, sampleRate);
    }
  }
  const ready: SpeechPackId[] = [];
  for (const id of speech.SPEECH_PACK_IDS) {
    if (id.startsWith('tts-') && (await speech.packReady(id))) ready.push(id);
  }
  const pick = speech.pickLocalVoice(gender, effLanguage, ready);
  if (!pick) {
    throw speech.packMissingError(
      speech.LOCAL_VOICE_SPEC[speech.localVoiceFor(gender, effLanguage)].packId,
    );
  }
  if (pick.missingPreferredPack) {
    emitTtsNotice({
      kind: 'substitute-pack',
      characterId,
      missingPackId: pick.missingPreferredPack,
      spokenPackId: speech.LOCAL_VOICE_SPEC[pick.voice].packId,
    });
  }
  const { samples, sampleRate } = await speech.synthesizeLocal(text, pick.voice);
  const { encodeWav } = await import('./stt');
  return encodeWav(samples, sampleRate);
}

/**
 * Last-resort local synthesis when the CONFIGURED voice route cannot produce
 * audio at all (260908): a BYOK user with no ElevenLabs key stored used to get
 * a hard VOICE_NOT_CONFIGURED on every line even with a local voice pack
 * installed and ready. Returns null (caller throws its original sentinel)
 * when no pack is installed or local synthesis fails.
 */
async function tryLocalFallbackClip(
  text: string,
  voiceId: string,
  language: ChatLanguage,
  characterId: string,
  genderHint?: string,
): Promise<ArrayBuffer | null> {
  try {
    return await synthesizeLocalClip(text, voiceId, language, characterId, genderHint);
  } catch (err) {
    console.warn(`[sei/voice] local TTS fallback unavailable: ${(err as Error).message}`);
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
    // Direct route (the user's own ElevenLabs account): its own vocabulary
    // first (see directElevenLabsError), so a BYOK 402 never reads as Sei's
    // credit wall and a free-plan refusal says what it is.
    const directErr = direct ? directElevenLabsError(res.status, text) : null;
    if (directErr) throw new Error(directErr);
    if (res.status === 402) {
      // 261005: the proxy's ledger is out. A direct (own ElevenLabs key) 402 is
      // the user's own account, not Sei's credit wall.
      if (!direct) noteCreditWall({ reason: 'depleted' }, { surface: 'voice', trigger: 'tts' });
      throw new Error('VOICE_NO_CREDITS: playtime balance exhausted');
    }
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
 * Route a (text, voiceId) pair to a resolved ElevenLabs key or the proxy
 * (see resolveElevenLabsRoute — the dev env key and the BYOK stored key are
 * the 'direct' branch; BYOK with no key throws VOICE_NOT_CONFIGURED).
 * `stability` (high for calm characters — see voiceStabilityFor) flattens
 * delivery. The proxy relays it into voice_settings; an older deployed proxy
 * strips the field (speech then runs expressive until the proxy ships, never
 * an error). Pitch is NOT a synthesis parameter — see voiceSettingsFor.
 */
async function synthesize(
  text: string,
  voiceId: string,
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
  const settings = voiceSettingsFor(stability);
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
    { text, voice_id: voiceId, ...langField, ...(context ?? {}), ...(stability !== undefined ? { stability } : {}) },
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
export async function voiceTts(args: {
  characterId: string;
  text: string;
  /** Another line of this same reply follows (see ttsContextFor). */
  more?: boolean;
  /** The line of the SAME reply spoken immediately before this one. */
  prev?: string;
}): Promise<ArrayBuffer> {
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
  // (see ttsLanguageForText — the fix for English-accented CJK). A
  // character-pinned language (metadata.language, 260730) beats auto-detect.
  const language = ttsLanguageForText(
    args.text,
    characterLanguage(character.metadata) ?? (await ttsLanguage()),
  );
  // Local TTS route (see localTtsSelected): same register conversion, no
  // proxy clip cap (the IPC boundary already bounds text length), WAV bytes
  // instead of mp3 — the renderer's blob playback sniffs the container.
  const own = ownVoicePickOf(character);
  if (await localTtsSelected()) {
    const localText = speechTextFor(args.text, language);
    if (!localText) throw new Error('VOICE_TTS_FAILED: empty text');
    return await synthesizeLocalClip(localText, voiceId, language, args.characterId, own?.gender);
  }
  // An own-account voice (261019) goes direct with the user's key, on cloud
  // too (261020); without a usable key on cloud it speaks the stand-in pool
  // voice through the proxy instead (planSpeech). The pick is never swapped.
  const plan = await planSpeech(character, voiceId, own !== null);
  const { route } = plan;
  // BYOK on the ElevenLabs engine with no key stored (260908): before failing
  // with the setup hint, try any installed local voice pack — an accented or
  // substitute local voice beats a silent call, and the hint still shows when
  // nothing local can speak either.
  if (route.kind === 'unconfigured') {
    const localText = speechTextFor(args.text, language);
    if (!localText) throw new Error('VOICE_TTS_FAILED: empty text');
    const fallback = await tryLocalFallbackClip(localText, voiceId, language, args.characterId, own?.gender);
    if (fallback) return fallback;
    throw new Error(NOT_CONFIGURED_BYOK);
  }
  // Spoken register BEFORE the cap: chat lines mirrored into the call carry
  // shorthand ("lmao", "rn") that TTS would read literally, and texting
  // punctuation that reads as an unfinished thought — see speechTextFor.
  const spoken = speechTextFor(args.text, language);
  const text = clipForRoute(spoken, route);
  if (!text) throw new Error('VOICE_TTS_FAILED: empty text');
  // previous_text is conditioning, so it gets the same register the clip
  // itself is rendered in.
  const prev = args.prev ? speechTextFor(args.prev, language) : undefined;
  const context = ttsContextFor(text, language, prev, args.more === true);
  const stability = voiceStabilityFor(character);
  try {
    return await synthesize(text, plan.speakId, language, stability, route, context);
  } catch (err) {
    // Cloud + own voice + a key ElevenLabs refused: speak this line with the
    // stand-in pool voice through the proxy (the notice already went out).
    if (!ownKeyFallback(plan, character, err)) throw err;
    const proxyText = clipForRoute(spoken, PROXY_ROUTE);
    return await synthesize(
      proxyText,
      ownVoiceStandInId(character),
      language,
      stability,
      PROXY_ROUTE,
      ttsContextFor(proxyText, language, prev, args.more === true),
    );
  }
}

interface OpenedTtsStream {
  body: NonNullable<Response['body']>;
  ctrl: AbortController;
}

/**
 * Open one streaming synthesis request (headers in, body not read yet).
 * Pre-flight failures throw the renderer-facing sentinels, direct-route
 * vocabulary first (see fetchAudio / directElevenLabsError). The fixed
 * timeout guards connect / time-to-first-byte only and is cleared once the
 * response is established; the body is guarded by the caller's stall
 * watchdog on the returned AbortController.
 */
async function openTtsStream(
  route: ElevenLabsRoute,
  voiceId: string,
  text: string,
  language: ChatLanguage,
  stability: number | undefined,
  context: Record<string, string>,
): Promise<OpenedTtsStream> {
  // Language pin for non-English (see synthesize — same forward-compat stance).
  const langField = language !== 'en' ? { language_code: language } : {};
  const settings = voiceSettingsFor(stability);
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
    body = { text, voice_id: voiceId, ...langField, ...context, ...(stability !== undefined ? { stability } : {}) };
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
    // Direct route vocabulary first (see fetchAudio / directElevenLabsError).
    const directErr = route.kind === 'direct' && !res.ok ? directElevenLabsError(res.status, bodyText) : null;
    if (directErr) throw new Error(directErr);
    if (res.status === 402) {
      // 261005: see fetchAudio; only the proxy route is Sei's credit wall.
      if (route.kind !== 'direct') noteCreditWall({ reason: 'depleted' }, { surface: 'voice', trigger: 'tts' });
      throw new Error('VOICE_NO_CREDITS: playtime balance exhausted');
    }
    if (res.status === 429) throw new Error('VOICE_RATE_LIMITED: daily usage cap reached');
    if (res.status === 503) throw new Error('VOICE_NOT_CONFIGURED: voice service unavailable');
    console.warn(`[sei/voice] tts upstream ${res.status}: ${bodyText.slice(0, 200)}`);
    throw new Error(`VOICE_TTS_FAILED: status ${res.status}`);
  }
  // Response established (headers in): the fixed timeout guarded connect /
  // time-to-first-byte only, NOT the whole stream. A near-cap reply can take
  // longer than TTS_TIMEOUT_MS to fully stream, so a whole-delivery deadline
  // would abort playback mid-sentence; the body is instead guarded by the
  // caller's inter-chunk stall watchdog, on this same AbortController.
  clearTimeout(timeout);
  return { body: res.body, ctrl };
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
  args: { characterId: string; text: string; more?: boolean; prev?: string },
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
  const language = ttsLanguageForText(
    args.text,
    characterLanguage(character.metadata) ?? (await ttsLanguage()),
  );
  // Local TTS route (260816): the renderer's voice store never picks the
  // streaming path while local TTS is selected (a WAV clip cannot ride the
  // audio/mpeg MSE pipeline), but any caller that does anyway degrades to a
  // whole-clip synthesis delivered as one chunk + done.
  const own = ownVoicePickOf(character);
  if (await localTtsSelected()) {
    const localText = speechTextFor(args.text, language);
    if (!localText) throw new Error('VOICE_TTS_FAILED: empty text');
    const buf = await synthesizeLocalClip(localText, voiceId, language, args.characterId, own?.gender);
    const streamId = `tts-${nextStreamSeq++}`;
    queueMicrotask(() => {
      sink({ streamId, chunk: buf });
      sink({ streamId, done: true });
    });
    return { streamId };
  }
  // Own-account voice (see voiceTts / planSpeech).
  const plan = await planSpeech(character, voiceId, own !== null);
  const { route } = plan;
  // Spoken register BEFORE the cap (see voiceTts / speechTextFor).
  const spoken = speechTextFor(args.text, language);
  const text = clipForRoute(spoken, route);
  if (!text) throw new Error('VOICE_TTS_FAILED: empty text');
  // BYOK with no key: try any installed local voice pack before the setup
  // sentinel (see voiceTts, 260908), degraded to one whole-clip chunk + done
  // exactly like the localTtsSelected branch.
  if (route.kind === 'unconfigured') {
    const fallback = await tryLocalFallbackClip(text, voiceId, language, args.characterId, own?.gender);
    if (!fallback) throw new Error(NOT_CONFIGURED_BYOK);
    const streamId = `tts-${nextStreamSeq++}`;
    queueMicrotask(() => {
      sink({ streamId, chunk: fallback });
      sink({ streamId, done: true });
    });
    return { streamId };
  }
  // Delivery calmness (see voiceStabilityFor). Pitch is not a synthesis
  // parameter — the renderer shifts it locally (see voiceSettingsFor).
  const stability = voiceStabilityFor(character);
  // Utterance-context conditioning (see ttsContextFor) — keeps a multi-line
  // reply from dropping pitch between its own sentences. `prev` is normalized
  // like the clip itself (see voiceTts).
  const prev = args.prev ? speechTextFor(args.prev, language) : undefined;
  const more = args.more === true;

  let opened: OpenedTtsStream;
  try {
    opened = await openTtsStream(route, plan.speakId, text, language, stability, ttsContextFor(text, language, prev, more));
  } catch (err) {
    // Cloud + own voice + a key ElevenLabs refused: stand-in via the proxy
    // (see voiceTts). Pre-flight only, so nothing has reached the sink yet.
    if (!ownKeyFallback(plan, character, err)) throw err;
    const proxyText = clipForRoute(spoken, PROXY_ROUTE);
    opened = await openTtsStream(
      PROXY_ROUTE,
      ownVoiceStandInId(character),
      proxyText,
      language,
      stability,
      ttsContextFor(proxyText, language, prev, more),
    );
  }
  const { body: resBody, ctrl } = opened;
  // Upstream accepted the synthesis — this line is what the player will hear
  // last, so it becomes the next clip's previous_text.

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
  const reader = resBody.getReader();
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
      // Analytics (260828): a mid-stream TTS failure mutes a spoken line —
      // previously invisible. The stall watchdog aborts read() on a hung
      // socket, so an abort HERE is that stall (a genuine failure), not a
      // user hang-up: emit it as its own class instead of dropping it.
      void (async () => {
        try {
          const { captureSurfaceError, surfaceErrorClass } = await import('../analytics');
          const cls = surfaceErrorClass(err);
          captureSurfaceError('voice', cls === 'aborted' ? 'tts_stream_stall' : `tts_stream_${cls}`);
        } catch { /* analytics is never load-bearing */ }
      })();
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
 * 260731: `pitch` is gone. It used to ask for a pace compensation the renderer
 * cancelled by resampling; the shift is local now (lib/voice/pitchBus.ts), so
 * pitch changes nothing about these bytes and keying the cache on it would
 * re-synthesize the same clip once per slider position. `calmness` maps to
 * ElevenLabs stability and still does change them.
 */
export async function voicePreviewTts(args: {
  voiceId?: string;
  calmness?: number;
  characterId?: string;
}): Promise<ArrayBuffer> {
  const language = await ttsLanguage();
  const line = PREVIEW_LINES[language] ?? PREVIEW_LINES.en;
  // Local TTS (260915): the pitch slider in Edit companion had NO sample under
  // local voices (the ElevenLabs list and its play buttons are hidden there),
  // so dragging it gave no feedback at all until the next call line. The
  // sample now synthesizes through the same local voice the call would use:
  // the companion's resolved voiceId decides gender exactly like a live clip
  // (synthesizeLocalClip), falling back to the picker's voiceId, then to a
  // female voice for a companion that has none yet. WAV bytes, ~100 ms, not
  // disk-cached: the mp3 preview cache is keyed on voiceId+text and would
  // hand a local user a stale ElevenLabs clip (or the reverse) after an
  // engine switch.
  if (await localTtsSelected()) {
    let voiceId = args.voiceId;
    let genderHint: string | undefined;
    if (args.characterId) {
      const character = await getCharacter(args.characterId);
      if (character && character.metadata?.voiceId !== NO_VOICE_ID) {
        voiceId = await resolveVoiceId(character);
        genderHint = ownVoicePickOf(character)?.gender;
      }
    }
    const character = args.characterId ? await getCharacter(args.characterId) : null;
    if (character?.metadata?.voiceId === NO_VOICE_ID) {
      throw new Error('VOICE_DISABLED: this companion has no voice');
    }
    const previewLanguage = characterLanguage(character?.metadata) ?? language;
    const sampleLine = PREVIEW_LINES[previewLanguage];
    const localText = speechTextFor(sampleLine, previewLanguage) || sampleLine;
    return await synthesizeLocalClip(localText, voiceId ?? '', previewLanguage, args.characterId ?? '', genderHint);
  }
  const voiceId = args.voiceId ?? '';
  // Closed allowlist: the curated pool, or (261019) a voice in the user's
  // own ElevenLabs account as listed with the current own-voice key. Own
  // voices only list when that key exists, and they synthesize on its direct
  // route (on cloud too, 261020), so they never reach the proxy from here; a
  // pool voice keeps the base route (the proxy on cloud).
  const pool = isPoolVoiceId(voiceId);
  if (!pool && !(await isOwnVoiceId(voiceId))) {
    throw new Error('VOICE_TTS_FAILED: unknown voice');
  }
  const calmness =
    typeof args.calmness === 'number' && Number.isFinite(args.calmness)
      ? Math.min(1, Math.max(0, args.calmness))
      : undefined;
  // The tag shape is unchanged so entries cached before 260731 at pitch 1 stay
  // valid; only the pitch component of the key is gone.
  const paramTag = calmness !== undefined ? `\n#pitch=1;calm=${calmness}` : '';
  const key = previewCacheKey(voiceId, line + paramTag);
  const cached = await readCachedPreview(key);
  if (cached) return cached;
  const { route } = await resolveTtsRoute({ own: !pool });
  const buf = await synthesize(line, voiceId, language, calmness, route);
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
