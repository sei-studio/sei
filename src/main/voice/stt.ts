/**
 * Voice-call cloud STT (260724) — transcribe one call utterance (MAIN only).
 *
 * Why: the in-call dictation pipeline runs whisper-tiny.en locally (40MB,
 * chosen for first-run download size), and tiny's error rate on short
 * conversational utterances is the dominant quality problem on live calls
 * ("tell me a joke" → "I'm your joke"). This module sends the same VAD-cut
 * utterance to ElevenLabs Scribe instead; the renderer races it against the
 * local worker and keeps local as the always-on fallback (see
 * renderer lib/voice/sttArbiter.ts), so cloud STT can only ever improve a
 * transcript, never block one.
 *
 * Routing mirrors tts.ts exactly (resolveElevenLabsRoute in
 * voice/elevenLabsKeyStore.ts is the shared decision):
 *   - Direct path: a resolved ElevenLabs key (SEI_TTS_DEV_KEY env, or the
 *     BYOK user's stored key) → ElevenLabs `/v1/speech-to-text` directly
 *     (multipart, scribe_v1).
 *   - Normal path: POST `${proxy}/stt/transcribe` with the Supabase Bearer
 *     JWT and a raw audio/wav body — the ElevenLabs key lives on the proxy.
 *   - BYOK ('local' backend) with no key stored never falls through to the
 *     proxy: it is { unavailable } with reason 'no-credentials'.
 *
 * Language detection (260725): the request never pins a language_code —
 * Scribe auto-detects per utterance and the response's language_code +
 * language_probability come back on the success result. The voice:stt IPC
 * handler feeds them to voice/languageAutoSwitch.ts, which persists a
 * confident, repeated detection into UserConfig.chat_language (the picker UI
 * was removed; the conversation language follows the player's voice).
 *
 * Result contract (matches the RendererApi doc in shared/ipc.ts):
 *   - { text }              — success; may be '' for non-speech audio.
 *     languageCode/languageProbability ride along when the upstream reports
 *     them (the proxy may not relay them; both are optional).
 *   - { unavailable: true } — cloud STT cannot run at all right now. `reason`
 *     tells the renderer WHY (260725):
 *       'no-credentials' — nothing configured client-side (BYOK with no
 *         stored key, or cloud with a genuinely absent session). Turn Scribe
 *         off for the call; there is nothing to retry against.
 *       'upstream'       — credentials exist but the upstream refused
 *         terminally (401/403 auth, 402 balance, 503 unconfigured, and the
 *         daily-spend-cap flavour of 429 — see isDailyCap429). The caller
 *         stops probing for the rest of the call and may surface the
 *         local-Whisper fallback prompt.
 *   - throws                — transient failure (network, 5xx, timeout, an
 *     ambiguous 429, a failed session read); the caller falls back to local
 *     for THIS utterance and tries again next one.
 */
import { getClient } from '../auth/supabaseClient';
import { resolveElevenLabsRoute } from './elevenLabsKeyStore';

const PROXY_BASE_URL = process.env.SEI_PROXY_URL ?? 'https://api.sei.gg';
const ELEVENLABS_STT_MODEL = 'scribe_v1';
/** Resource bound only — NOT the latency budget. The renderer's arbiter
 * delivers the local result after a short grace window regardless, so a slow
 * cloud pass wastes a request, never the player's time. Sized for the 15s
 * MAX_UTTERANCE_MS worst case. */
const STT_TIMEOUT_MS = 8_000;
const SAMPLE_RATE = 16_000;

/**
 * The caller's Supabase access token, or null when the user is genuinely
 * signed out.
 *
 * 260726: this used to swallow every getSession() failure into the same null,
 * and the caller reports null as { unavailable, reason:'no-credentials' } —
 * which the renderer latches as a SILENT whole-call disable. So one transient
 * session read (or a token refresh in flight) left a signed-in user's call
 * permanently deaf, with no error and no fallback prompt. A read FAILURE is
 * transient: throw, so this utterance falls back to local and the next one
 * retries. Only "no session" is terminal.
 */
async function getJwtOrNull(): Promise<string | null> {
  let token: string | null;
  try {
    const { data, error } = await getClient().auth.getSession();
    if (error) throw error;
    token = data?.session?.access_token ?? null;
  } catch (err) {
    throw new Error(`VOICE_STT_FAILED: session read failed: ${(err as Error).message}`);
  }
  return token;
}

/** Encode 16kHz mono Float32 PCM as a 16-bit PCM WAV file. */
export function encodeWav(pcm: Float32Array, sampleRate = SAMPLE_RATE): ArrayBuffer {
  const dataBytes = pcm.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const ascii = (offset: number, s: string): void => {
    for (let i = 0; i < s.length; i += 1) view.setUint8(offset + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  let off = 44;
  for (let i = 0; i < pcm.length; i += 1) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return buf;
}

/**
 * Laughter audio-event tags → text (260725 expressions). tag_audio_events is
 * ON so Scribe reports non-word expressions; a player's laugh becomes "haha"
 * the companion can actually react to. Only laughter maps — other events
 * (coughs, sighs, background noise) are stripped below, and vocalized
 * interjections ("awww", "ohhhh") plus punctuation ("?", "!") come through as
 * ordinary transcript text on their own.
 */
const LAUGH_EVENT = /[[(][^\])]*(?:laugh|giggl|chuckl)[^\])]*[\])]/gi;

/**
 * Scribe-output normalization: map laughter events to "haha", strip every
 * other bracketed/parenthesized non-speech tag (same stance as the local
 * worker's cleanTranscript), collapse whitespace, and downgrade em dashes:
 * the transcript is user-visible chat copy, and Scribe punctuates more
 * literarily than Whisper.
 */
export function normalizeSttText(raw: string): string {
  return raw
    .replace(LAUGH_EVENT, 'haha')
    .replace(/\[[^\]]*\]|\([^)]*\)/g, '')
    .replace(/—/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

class SttUnavailable extends Error {}

/** Upstream transcript + the language Scribe detected for the utterance.
 * The detection fields are best-effort: the direct ElevenLabs path always
 * carries them, the proxy path only if the proxy relays the Scribe JSON. */
type UpstreamTranscript = {
  text: string;
  languageCode?: string;
  languageProbability?: number;
};

/** The Scribe (or proxy) success body, before validation. */
type SttResponseBody = {
  text?: unknown;
  language_code?: unknown;
  language_probability?: unknown;
};

/** A Retry-After (or retry_after_seconds) at least this long is a window that
 * outlives any call, so it is the daily cap rather than a burst limit. The
 * proxy caps its Retry-After HEADER at 10s, so the honest value lives in the
 * JSON body. */
const DAILY_CAP_RETRY_AFTER_S = 300;

/**
 * Whether a 429 is the proxy's per-day SPEND cap (terminal for the call) as
 * opposed to a burst limit (transient).
 *
 * 260726: every 429 used to be terminal, and the renderer latches cloud STT
 * off for the whole call on a terminal answer. But most 429s here are bursts,
 * not caps: Cloudflare's flood guard in front of api.sei.gg is 20 requests per
 * 10s, and ElevenLabs rate-limits overlapping utterances. One of those left
 * the companion deaf for the rest of the call whenever no local Whisper worker
 * exists ('none' is the default local model). An ambiguous 429 is therefore
 * treated as transient — worst case we pay one failed round-trip on the next
 * utterance.
 */
function isDailyCap429(res: Response, body: string): boolean {
  const header = Number(res.headers.get('retry-after'));
  if (Number.isFinite(header) && header >= DAILY_CAP_RETRY_AFTER_S) return true;
  try {
    const json = JSON.parse(body) as { kind?: unknown; retry_after_seconds?: unknown };
    // The proxy's daily-spend 429 (see the bot orchestrator's haltOnDailyCap).
    if (json?.kind === 'daily_dollar') return true;
    return (
      typeof json?.retry_after_seconds === 'number' &&
      json.retry_after_seconds >= DAILY_CAP_RETRY_AFTER_S
    );
  } catch {
    return false; // not JSON: nothing says "cap", so treat it as a burst
  }
}

async function fetchTranscript(url: string, init: RequestInit): Promise<UpstreamTranscript> {
  const ctrl = new AbortController();
  // The deadline covers the BODY too (260726). Clearing it once headers landed
  // left res.json() unguarded, and the arbiter's local-empty branch awaits this
  // promise with no timeout of its own — so a half-dead socket stranded the
  // utterance forever. The payload is one small JSON object; reading it inside
  // the same window costs nothing.
  const timeout = setTimeout(() => ctrl.abort(), STT_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: ctrl.signal });
    } catch (err) {
      throw new Error(`VOICE_STT_FAILED: ${(err as Error).message}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // Terminal-for-this-call statuses: retrying next utterance cannot help
      // (auth, balance, unconfigured service) — tell the renderer to stop
      // probing instead of paying a failed round-trip per utterance. 429 is
      // terminal ONLY when it is the daily cap (see isDailyCap429).
      if ([401, 402, 403, 503].includes(res.status)) throw new SttUnavailable();
      if (res.status === 429 && isDailyCap429(res, body)) throw new SttUnavailable();
      console.warn(`[sei/voice] stt upstream ${res.status}: ${body.slice(0, 200)}`);
      throw new Error(`VOICE_STT_FAILED: status ${res.status}`);
    }
    let json: SttResponseBody | null;
    try {
      json = (await res.json()) as SttResponseBody | null;
    } catch (err) {
      // Truncated / aborted / non-JSON body: transient. Never a silent '',
      // which downstream trusts as "the clip was not speech".
      throw new Error(`VOICE_STT_FAILED: ${(err as Error).message}`);
    }
    return {
      text: typeof json?.text === 'string' ? json.text : '',
      ...(typeof json?.language_code === 'string' ? { languageCode: json.language_code } : {}),
      ...(typeof json?.language_probability === 'number'
        ? { languageProbability: json.language_probability }
        : {}),
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** One line per cloud pass in the main console: raw Scribe text (tags
 * visible), the normalized transcript, the detected language, and the
 * round-trip — the visibility needed to tune the expressions mapping, the
 * arbiter race, and the language auto-switch. */
function logSttResult(up: UpstreamTranscript, normalized: string, startedAt: number): void {
  const ms = Math.round(Date.now() - startedAt);
  // lang=? means the upstream returned no detection fields — the proxy not
  // relaying language_code (auto-switch is blind on this route), as opposed
  // to a detected language at low confidence. No lang token at all in a log
  // line means a pre-260725 build is running.
  const lang = up.languageCode
    ? ` lang=${up.languageCode}@${(up.languageProbability ?? 0).toFixed(2)}`
    : ' lang=?';
  console.log(
    `[sei/voice] stt ${ms}ms${lang} raw="${up.text.slice(0, 120)}" -> "${normalized.slice(0, 120)}"`,
  );
}

/** Why cloud STT is unavailable — see the module doc + shared/ipc.ts. */
export type SttUnavailableReason = 'no-credentials' | 'upstream';

/** Transcribe one utterance of raw Float32 16kHz mono PCM. No language is
 * pinned — Scribe detects it per utterance and the detection rides along on
 * the result for the language auto-switch. */
export async function voiceStt(args: {
  pcm: ArrayBuffer;
}): Promise<
  | { text: string; languageCode?: string; languageProbability?: number }
  | { unavailable: true; reason: SttUnavailableReason }
> {
  const wav = encodeWav(new Float32Array(args.pcm));
  const route = await resolveElevenLabsRoute();
  const startedAt = Date.now();
  try {
    if (route.kind === 'direct') {
      const form = new FormData();
      form.set('model_id', ELEVENLABS_STT_MODEL);
      form.set('file', new Blob([wav], { type: 'audio/wav' }), 'utterance.wav');
      // ON (260725): laughter tags map to "haha" in normalizeSttText.
      form.set('tag_audio_events', 'true');
      const up = await fetchTranscript('https://api.elevenlabs.io/v1/speech-to-text', {
        method: 'POST',
        headers: { 'xi-api-key': route.key },
        body: form,
      });
      const normalized = normalizeSttText(up.text);
      logSttResult(up, normalized, startedAt);
      return { ...up, text: normalized };
    }
    // BYOK with no key stored: nothing configured to call — never fall
    // through to the proxy (the user may have no session, and did not opt
    // into metered cloud voice).
    if (route.kind === 'unconfigured') return { unavailable: true, reason: 'no-credentials' };
    // null here means genuinely signed out (terminal); a failed session read
    // throws instead, so it degrades for one utterance only (see getJwtOrNull).
    const jwt = await getJwtOrNull();
    if (!jwt) return { unavailable: true, reason: 'no-credentials' };
    const up = await fetchTranscript(`${PROXY_BASE_URL}/stt/transcribe`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, 'content-type': 'audio/wav' },
      body: wav,
    });
    const normalized = normalizeSttText(up.text);
    logSttResult(up, normalized, startedAt);
    return { ...up, text: normalized };
  } catch (err) {
    if (err instanceof SttUnavailable) return { unavailable: true, reason: 'upstream' };
    throw err;
  }
}
