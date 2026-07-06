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
import { resolveVoiceId, isPoolVoiceId } from './voiceAssign';

const PROXY_BASE_URL = process.env.SEI_PROXY_URL ?? 'https://api.sei.gg';
const ELEVENLABS_TTS_MODEL = 'eleven_flash_v2_5';
const ELEVENLABS_OUTPUT_FORMAT = 'mp3_44100_128';
const TTS_TIMEOUT_MS = 30_000;
/** Proxy-side request cap (ttsDailyGate); clip rather than 400 on long replies. */
const MAX_TTS_CHARS = 1000;

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
  const buf = await res.arrayBuffer();
  clearTimeout(timeout);
  return buf;
}

/** Route a (text, voiceId) pair to the dev key or the proxy. */
async function synthesize(text: string, voiceId: string): Promise<ArrayBuffer> {
  const devKey = process.env.SEI_TTS_DEV_KEY;
  if (devKey) {
    return fetchAudio(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=${ELEVENLABS_OUTPUT_FORMAT}`,
      { 'xi-api-key': devKey },
      { text, model_id: ELEVENLABS_TTS_MODEL },
    );
  }
  const jwt = await getJwtOrNull();
  if (!jwt) throw new Error('VOICE_NO_SESSION: sign in to use voice calls');
  return fetchAudio(
    `${PROXY_BASE_URL}/tts/speech`,
    { Authorization: `Bearer ${jwt}` },
    { text, voice_id: voiceId },
  );
}

/** Synthesize `text` in `characterId`'s voice; resolves to audio/mpeg bytes. */
export async function voiceTts(args: { characterId: string; text: string }): Promise<ArrayBuffer> {
  const character = await getCharacter(args.characterId);
  if (!character) throw new Error('VOICE_TTS_FAILED: character not found');
  const voiceId = await resolveVoiceId(character);
  const text = args.text.trim().slice(0, MAX_TTS_CHARS);
  if (!text) throw new Error('VOICE_TTS_FAILED: empty text');
  return synthesize(text, voiceId);
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
  const voiceId = await resolveVoiceId(character);
  const text = args.text.trim().slice(0, MAX_TTS_CHARS);
  if (!text) throw new Error('VOICE_TTS_FAILED: empty text');

  const devKey = process.env.SEI_TTS_DEV_KEY;
  const url = devKey
    ? `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=${ELEVENLABS_OUTPUT_FORMAT}`
    : `${PROXY_BASE_URL}/tts/speech`;
  let headers: Record<string, string>;
  let body: unknown;
  if (devKey) {
    headers = { 'xi-api-key': devKey };
    body = { text, model_id: ELEVENLABS_TTS_MODEL };
  } else {
    const jwt = await getJwtOrNull();
    if (!jwt) throw new Error('VOICE_NO_SESSION: sign in to use voice calls');
    headers = { Authorization: `Bearer ${jwt}` };
    body = { text, voice_id: voiceId };
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
    } finally {
      clearTimeout(timeout);
    }
  })();
  return { streamId };
}

/** One canned line for the creation-flow voice picker (~60 chars — cheap). */
const PREVIEW_LINE = "Hey! Ready when you are — grab your gear and let's head out.";

/**
 * Voice-picker preview (260705): speak the canned line in an arbitrary
 * curated-pool voice — no character needed (the picker runs before the voice
 * is committed). Pool membership is enforced here AND by the proxy allowlist.
 */
export async function voicePreviewTts(voiceId: string): Promise<ArrayBuffer> {
  if (!isPoolVoiceId(voiceId)) throw new Error('VOICE_TTS_FAILED: unknown voice');
  return synthesize(PREVIEW_LINE, voiceId);
}
