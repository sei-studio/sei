/**
 * Fish Audio synthesis (261103), the third local-voice choice beside the Fast
 * packs and Kokoro. MAIN only, and only with the user's OWN Fish API key
 * (fishKeyStore.ts): every request goes straight to api.fish.audio, never
 * through the Sei proxy.
 *
 * The `model` header is ALWAYS `s2.1-pro-free` (FISH_TTS_MODEL). Fish reads a
 * missing or unknown value as the paid s2.1-pro, which bills an account that
 * has credit, so EVERY request in this file (synthesis and the voice lookup
 * alike) is built with fishHeaders, the only header builder; tests pin it.
 *
 * Fish allows 5 requests at a time per account, and a call opens a request
 * for every queued line. acquireFishSlot keeps at most FISH_MAX_IN_FLIGHT per
 * key open (released when the body is fully read, fails, is cancelled or
 * aborted); the rest WAIT for a slot instead of meeting a 429, so one reply
 * does not switch to the Fast voice half way.
 *
 * Errors are thrown with a sentinel prefix (fishFailureReason maps them):
 *   FISH_NO_KEY         no key stored
 *   FISH_KEY_INVALID    401 / 403
 *   FISH_NO_CREDIT      402: no credit, or the free model is not available
 *   FISH_BUSY           429 after one short retry (5 requests at a time per
 *                       account; Fish sends no Retry-After)
 *   FISH_VOICE_MISSING  the voice id does not exist (404, or a 400 "Reference
 *                       not found" from /v1/tts), or it is not a usable TTS voice
 *   FISH_FAILED         network, timeout, 5xx, anything else
 * tts.ts turns every one of them into a Fast-voice fallback, with a notice
 * once the Fast clip exists.
 */
import { createHash } from 'node:crypto';
import {
  FISH_API_BASE,
  FISH_TTS_MODEL,
  clampFishSpeed,
  pickFishVoice,
  type FishFailureReason,
  type FishVoiceGender,
} from '../../shared/fishVoices';

export type { FishFailureReason };

/** What one line is spoken with. */
export interface FishVoicePlan {
  id: string;
  name: string;
  speed: number;
  volume: number;
  /** 'override': the user's own pick, played without the pitch shift. */
  source: 'auto' | 'override';
}

export interface FishOverride {
  id: string;
  name: string;
  speed?: number;
}

/** Connect / time-to-first-byte budget. Short on purpose: a failure falls back
 * to the Fast voices, and a long wait before that is a silent call. */
export const FISH_CONNECT_TIMEOUT_MS = 12_000;
/** One retry after a 429, this long after it. */
export const FISH_BUSY_RETRY_MS = 600;
const FISH_LOOKUP_TIMEOUT_MS = 8_000;
/** Synthesis requests open at once per key (Fish's limit is 5 per account). */
export const FISH_MAX_IN_FLIGHT = 4;

/** The request headers. The ONLY place they are built: the model pin rides
 * every request. */
export function fishHeaders(key: string): Record<string, string> {
  return {
    Authorization: `Bearer ${key}`,
    'content-type': 'application/json',
    model: FISH_TTS_MODEL,
  };
}

/** The /v1/tts body for one line. `language` is sent for non-English only. */
export function fishTtsBody(
  text: string,
  voice: { id: string; speed: number; volume: number },
  language?: string,
): Record<string, unknown> {
  const lang = language ? String(language).toLowerCase().split(/[-_]/)[0] : '';
  return {
    text,
    reference_id: voice.id,
    format: 'mp3',
    mp3_bitrate: 128,
    latency: 'balanced',
    prosody: { speed: voice.speed, volume: voice.volume },
    ...(lang && lang !== 'en' ? { language: lang } : {}),
  };
}

/** The reason behind a FISH_* sentinel, or null for anything else. */
export function fishFailureReason(err: unknown): FishFailureReason | null {
  const msg = String((err as Error)?.message ?? err);
  if (msg.startsWith('FISH_NO_KEY')) return 'no-key';
  if (msg.startsWith('FISH_KEY_INVALID')) return 'key-invalid';
  if (msg.startsWith('FISH_NO_CREDIT')) return 'no-credit';
  if (msg.startsWith('FISH_BUSY')) return 'busy';
  if (msg.startsWith('FISH_VOICE_MISSING')) return 'voice-missing';
  if (msg.startsWith('FISH_FAILED')) return 'failed';
  return null;
}

/** Map an HTTP failure to its sentinel. `body` is a short excerpt for logs only. */
export function fishHttpError(status: number, body: string): Error {
  if (status === 401 || status === 403) return new Error(`FISH_KEY_INVALID: status ${status}`);
  if (status === 402) return new Error('FISH_NO_CREDIT: status 402');
  if (status === 429) return new Error('FISH_BUSY: status 429');
  if (status === 404 || (status === 400 && /reference not found/i.test(body))) {
    return new Error(`FISH_VOICE_MISSING: status ${status}`);
  }
  return new Error(`FISH_FAILED: status ${status}`);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('FISH_FAILED: aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('FISH_FAILED: aborted'));
    }, { once: true });
  });
}

export interface OpenedFishStream {
  body: NonNullable<Response['body']>;
  /** Aborts the body read (the caller's stall watchdog uses it). */
  ctrl: AbortController;
}

/**
 * Open one /v1/tts request and return once the headers are in (the mp3 body
 * not read yet). Waits for one of the key's FISH_MAX_IN_FLIGHT slots first;
 * the slot is held until the body ends, fails, is cancelled or aborted. A 429
 * is retried once after FISH_BUSY_RETRY_MS (holding the slot). The connect
 * timeout is cleared when the response arrives; the body is the caller's to
 * guard.
 */
export async function openFishStream(
  key: string,
  text: string,
  voice: { id: string; speed: number; volume: number },
  language?: string,
  opts: { retryDelayMs?: number; timeoutMs?: number } = {},
): Promise<OpenedFishStream> {
  // Wait for a slot first: the connect timeout below starts only once this
  // request may actually go out.
  const release = await acquireFishSlot(key);
  try {
    const opened = await openFishStreamNow(key, text, voice, language, opts);
    // An abort (the caller's stall watchdog) ends the request too.
    opened.ctrl.signal.addEventListener('abort', release, { once: true });
    return { body: releasingBody(opened.body, release), ctrl: opened.ctrl };
  } catch (err) {
    release();
    throw err;
  }
}

async function openFishStreamNow(
  key: string,
  text: string,
  voice: { id: string; speed: number; volume: number },
  language: string | undefined,
  opts: { retryDelayMs?: number; timeoutMs?: number },
): Promise<OpenedFishStream> {
  const payload = JSON.stringify(fishTtsBody(text, voice, language));
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? FISH_CONNECT_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${FISH_API_BASE}/v1/tts`, {
        method: 'POST',
        headers: fishHeaders(key),
        body: payload,
        signal: ctrl.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      throw new Error(`FISH_FAILED: ${(err as Error).message}`);
    }
    if (res.ok && res.body) {
      clearTimeout(timeout);
      return { body: res.body, ctrl };
    }
    clearTimeout(timeout);
    const excerpt = (await res.text().catch(() => '')).slice(0, 200);
    if (res.status === 429 && attempt === 0) {
      await sleep(opts.retryDelayMs ?? FISH_BUSY_RETRY_MS);
      continue;
    }
    // Never log the key; the excerpt is Fish's own error message.
    console.warn(`[sei/voice] fish tts ${res.status}: ${excerpt}`);
    throw fishHttpError(res.ok ? 502 : res.status, excerpt);
  }
}

/**
 * Per-key slots for synthesis (see the file header). Resolves with a release
 * function once a slot is free; a released slot passes straight to the next
 * waiter in order. release is idempotent.
 */
const fishSlots = new Map<string, { active: number; waiters: Array<() => void> }>();

export async function acquireFishSlot(key: string): Promise<() => void> {
  const print = keyPrint(key);
  let slot = fishSlots.get(print);
  if (!slot) {
    slot = { active: 0, waiters: [] };
    fishSlots.set(print, slot);
  }
  const s = slot;
  if (s.active < FISH_MAX_IN_FLIGHT) s.active++;
  else await new Promise<void>((resolve) => s.waiters.push(resolve)); // slot handed over by release
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = s.waiters.shift();
    if (next) {
      next();
      return;
    }
    s.active--;
    if (s.active === 0 && fishSlots.get(print) === s) fishSlots.delete(print);
  };
}

/** The body, releasing its slot when it is read to the end, fails or is cancelled. */
function releasingBody(body: OpenedFishStream['body'], release: () => void): OpenedFishStream['body'] {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          release();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (err) {
        release();
        controller.error(err);
      }
    },
    cancel(reason) {
      release();
      return reader.cancel(reason);
    },
  });
}

/** Buffered synthesis: the whole mp3. Used for short lines, previews and Test. */
export async function synthesizeFish(
  key: string,
  text: string,
  voice: { id: string; speed: number; volume: number },
  language?: string,
  opts: { retryDelayMs?: number; timeoutMs?: number } = {},
): Promise<ArrayBuffer> {
  const { body, ctrl } = await openFishStream(key, text, voice, language, opts);
  // Whole-body deadline: a short line is a few seconds of audio; a body that
  // takes this long is a stalled socket.
  const deadline = setTimeout(() => ctrl.abort(), 45_000);
  try {
    const buf = await new Response(body).arrayBuffer();
    if (buf.byteLength === 0) throw new Error('FISH_FAILED: empty audio');
    return buf;
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    throw msg.startsWith('FISH_') ? err : new Error(`FISH_FAILED: ${msg}`);
  } finally {
    clearTimeout(deadline);
  }
}

/**
 * Look a voice up with the user's key (GET /model/{id}). Only a trained TTS
 * voice can speak; anything else is FISH_VOICE_MISSING. Returns the id and
 * its display name.
 */
export async function fetchFishVoice(key: string, id: string): Promise<{ id: string; name: string }> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), FISH_LOOKUP_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${FISH_API_BASE}/model/${encodeURIComponent(id)}`, {
      headers: fishHeaders(key),
      signal: ctrl.signal,
    });
  } catch (err) {
    throw new Error(`FISH_FAILED: ${(err as Error).message}`);
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) {
    const excerpt = (await res.text().catch(() => '')).slice(0, 200);
    throw fishHttpError(res.status, excerpt);
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new Error('FISH_FAILED: bad response');
  }
  const m = (data ?? {}) as { _id?: unknown; title?: unknown; type?: unknown; state?: unknown };
  if (m.type !== 'tts' || m.state !== 'trained') {
    throw new Error('FISH_VOICE_MISSING: not a usable voice');
  }
  const rawName = typeof m.title === 'string' ? m.title.trim() : '';
  const name = (rawName || id).slice(0, 120);
  return { id: typeof m._id === 'string' && m._id ? m._id : id, name };
}

/**
 * The voice for one line: the character's own pick when the user set one
 * (played without the pitch shift), else the automatic voice for the
 * character's gender and the line's language.
 */
export function planFishVoice(
  override: FishOverride | undefined,
  gender: FishVoiceGender,
  language: string,
): FishVoicePlan {
  if (override) {
    return {
      id: override.id,
      name: override.name,
      speed: clampFishSpeed(override.speed),
      volume: 0,
      source: 'override',
    };
  }
  const v = pickFishVoice(gender, language);
  return { id: v.id, name: v.name, speed: v.speed, volume: v.volume, source: 'auto' };
}

/**
 * Terminal refusals remembered for a few minutes, so a call on a dead key or
 * an empty account does not pay a failed round trip before every line.
 * 'key-invalid' and 'no-credit' are about the ACCOUNT (any voice); a missing
 * voice is per voice; a network failure is remembered briefly so a dead
 * connection does not cost the connect timeout on every line. Keyed on a key
 * fingerprint: saving a different key retries at once, and saving any key
 * clears the memory (clearFishFailures).
 */
const FISH_FAILURE_TTL_MS = 5 * 60_000;
const FISH_NETWORK_FAILURE_TTL_MS = 20_000;
const FISH_FAILURE_MAX = 64;
const fishFailures = new Map<string, { reason: FishFailureReason; until: number }>();

function keyPrint(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16);
}

/** A remembered refusal that applies to (key, voice), or null. */
export function rememberedFishFailure(key: string, voiceId: string): FishFailureReason | null {
  const now = Date.now();
  const print = keyPrint(key);
  for (const k of [`${print}:*`, `${print}:${voiceId}`]) {
    const hit = fishFailures.get(k);
    if (hit && hit.until > now) return hit.reason;
  }
  return null;
}

/** Remember a failure when it is one worth remembering (see above). */
export function rememberFishFailure(key: string, voiceId: string, reason: FishFailureReason): void {
  let scope: string;
  let ttl: number;
  if (reason === 'key-invalid' || reason === 'no-credit') {
    scope = '*';
    ttl = FISH_FAILURE_TTL_MS;
  } else if (reason === 'voice-missing') {
    scope = voiceId;
    ttl = FISH_FAILURE_TTL_MS;
  } else if (reason === 'failed') {
    scope = '*';
    ttl = FISH_NETWORK_FAILURE_TTL_MS;
  } else {
    return; // 'busy' is momentary; 'no-key' never reached the network.
  }
  const now = Date.now();
  for (const [k, v] of fishFailures) if (v.until <= now) fishFailures.delete(k);
  while (fishFailures.size >= FISH_FAILURE_MAX) {
    const oldest = fishFailures.keys().next().value;
    if (oldest === undefined) break;
    fishFailures.delete(oldest);
  }
  fishFailures.set(`${keyPrint(key)}:${scope}`, { reason, until: now + ttl });
}

/** Forget every remembered refusal (the key was saved or removed). */
export function clearFishFailures(): void {
  fishFailures.clear();
}
