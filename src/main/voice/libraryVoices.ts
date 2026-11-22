/**
 * Voice Library voices on Sei cloud (261119), main side.
 *
 * A cloud user pastes an ElevenLabs Voice Library link (or id) into the voice
 * picker. The proxy (sei-proxy src/tts/libraryVoiceRoutes.ts) looks it up and
 * validates it, adds it to Sei's ElevenLabs account on pick, and from then on
 * /tts/speech plays it for everyone, metered like a pool voice. The pick is
 * stored as metadata.voiceLibrary (shared/voiceIds.ts).
 *
 * This module:
 *   - calls the three proxy routes with the Supabase JWT (lookup, add,
 *     status) and maps every failure to a reason code the picker has copy for
 *     (never throws);
 *   - fetches a looked-up voice's ElevenLabs preview clip for the picker, only
 *     from the URL the proxy returned for that voice id (the renderer never
 *     names a URL);
 *   - remembers voice ids the proxy refused at synthesis time
 *     (libraryVoiceRefused), so tts.ts speaks the stand-in pool voice straight
 *     away for a while instead of paying a failed round trip per line;
 *   - answers whether a voice id is a known library voice (looked up or added
 *     this session, or stored on a character), the allowlist voicePreviewTts
 *     applies before sending one to the proxy.
 */
import { getClient } from '../auth/supabaseClient';
import { listCharacters } from '../characterStore';
import { isWellFormedVoiceId, libraryVoiceOf } from '../../shared/voiceIds';
import type {
  LibraryVoiceAddResult,
  LibraryVoiceInfo,
  LibraryVoiceLookupResult,
  LibraryVoiceReason,
  LibraryVoiceStatusResult,
} from '../../shared/ipc';

const PROXY_BASE_URL = process.env.SEI_PROXY_URL ?? 'https://api.sei.gg';
const PROXY_TIMEOUT_MS = 15_000;
const PREVIEW_TIMEOUT_MS = 15_000;
const PREVIEW_MAX_BYTES = 5 * 1024 * 1024;
const KNOWN_MAX = 200;

const SERVER_REASONS: ReadonlySet<string> = new Set<LibraryVoiceReason>([
  'invalid_input',
  'not_found',
  'pool_voice',
  'custom_rate',
  'live_moderation',
  'short_notice',
  'delisted',
  'restricted_category',
  'daily_limit',
  'voice_limit',
  'capacity',
  'unavailable',
]);

// â”€â”€ Refusal memory (tts.ts) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** How long a refused library voice speaks the stand-in without asking. */
export const LIBRARY_REFUSAL_TTL_MS = 10 * 60_000;
const refusals = new Map<string, number>();

export function libraryVoiceRefused(voiceId: string, now = Date.now()): boolean {
  const until = refusals.get(voiceId);
  if (until === undefined) return false;
  if (until > now) return true;
  refusals.delete(voiceId);
  return false;
}

export function rememberLibraryRefusal(voiceId: string, now = Date.now()): void {
  if (refusals.size >= KNOWN_MAX) {
    for (const [k, until] of refusals) if (until <= now) refusals.delete(k);
    if (refusals.size >= KNOWN_MAX) {
      const oldest = refusals.keys().next().value;
      if (oldest !== undefined) refusals.delete(oldest);
    }
  }
  refusals.set(voiceId, now + LIBRARY_REFUSAL_TTL_MS);
}

export function forgetLibraryRefusal(voiceId: string): void {
  refusals.delete(voiceId);
}

// â”€â”€ Known ids + preview URLs â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** voiceId â†’ preview URL from the proxy (null: the voice has none). */
const known = new Map<string, string | null>();

function remember(voiceId: string, previewUrl: string | null): void {
  known.delete(voiceId);
  known.set(voiceId, previewUrl);
  while (known.size > KNOWN_MAX) {
    const oldest = known.keys().next().value;
    if (oldest === undefined) break;
    known.delete(oldest);
  }
}

export function _resetLibraryVoicesForTests(): void {
  refusals.clear();
  known.clear();
}

/** A library voice the user looked up this session or a character stores. */
export async function isKnownLibraryVoiceId(voiceId: string): Promise<boolean> {
  if (!isWellFormedVoiceId(voiceId)) return false;
  if (known.has(voiceId)) return true;
  try {
    return (await listCharacters()).some(
      (c) => c.metadata?.voiceId === voiceId && libraryVoiceOf(c.metadata) !== null,
    );
  } catch {
    return false;
  }
}

/** Library voice ids the user's characters use now (the proxy's in_use). */
async function libraryVoicesInUse(): Promise<string[]> {
  try {
    const ids = new Set<string>();
    for (const c of await listCharacters()) {
      const v = c.metadata?.voiceId;
      if (typeof v === 'string' && libraryVoiceOf(c.metadata)) ids.add(v);
    }
    return [...ids].slice(0, 200);
  } catch {
    return [];
  }
}

// â”€â”€ Proxy calls â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

type ProxyAnswer = { status: number; body: unknown } | { fail: 'no_session' | 'unavailable' };

async function jwtOrNull(): Promise<string | null> {
  try {
    const { data } = await getClient().auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

async function callProxy(path: string, init: { method: 'GET' | 'POST'; body?: unknown }): Promise<ProxyAnswer> {
  const jwt = await jwtOrNull();
  if (!jwt) return { fail: 'no_session' };
  try {
    const res = await fetch(`${PROXY_BASE_URL}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${jwt}`,
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  } catch {
    return { fail: 'unavailable' };
  }
}

function failureReason(a: ProxyAnswer): LibraryVoiceReason {
  if ('fail' in a) return a.fail;
  if (a.status === 401) return 'no_session';
  if (a.status === 429) return 'rate_limited';
  // 404 = a proxy without the routes yet; 5xx, anything else = try later.
  return 'unavailable';
}

function str(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}

/** The proxy's public voice â†’ the renderer's shape (no URL crosses IPC). */
function toInfo(raw: unknown): LibraryVoiceInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  const voiceId = v.voice_id;
  const name = str(v.name, 120);
  if (!isWellFormedVoiceId(voiceId) || !name) return null;
  const rawPreview = str(v.preview_url, 2048);
  const previewUrl = rawPreview && isAllowedPreviewUrl(rawPreview) ? rawPreview : null;
  remember(voiceId, previewUrl);
  return {
    voiceId,
    name,
    gender: str(v.gender, 20),
    age: str(v.age, 40),
    accent: str(v.accent, 60),
    description: str(v.description, 400),
    hasPreview: previewUrl !== null,
  };
}

function parseResult(a: ProxyAnswer): { ok: true; voice: LibraryVoiceInfo; body: Record<string, unknown> } | { ok: false; reason: LibraryVoiceReason } {
  if ('fail' in a || a.status !== 200 || !a.body || typeof a.body !== 'object') {
    return { ok: false, reason: failureReason(a) };
  }
  const body = a.body as Record<string, unknown>;
  if (body.ok === true) {
    const voice = toInfo(body.voice);
    return voice ? { ok: true, voice, body } : { ok: false, reason: 'unavailable' };
  }
  const reason = typeof body.reason === 'string' && SERVER_REASONS.has(body.reason) ? body.reason : 'unavailable';
  return { ok: false, reason: reason as LibraryVoiceReason };
}

/** Paste â†’ the voice (name, details, whether it has a preview) or why not. */
export async function lookupLibraryVoice(input: string): Promise<LibraryVoiceLookupResult> {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, reason: 'invalid_input' };
  const r = parseResult(await callProxy('/tts/library-voice/lookup', { method: 'POST', body: { input: trimmed } }));
  return r.ok ? { ok: true, voice: r.voice } : r;
}

/** The pick: the proxy validates again, adds the voice, records it. */
export async function addLibraryVoice(input: string): Promise<LibraryVoiceAddResult> {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, reason: 'invalid_input' };
  const r = parseResult(
    await callProxy('/tts/library-voice/add', {
      method: 'POST',
      body: { input: trimmed, in_use: await libraryVoicesInUse() },
    }),
  );
  if (!r.ok) return r;
  // Freshly added: whatever this machine remembered about a refusal is stale.
  forgetLibraryRefusal(r.voice.voiceId);
  return { ok: true, voice: r.voice, already: r.body.already === true };
}

/** Whether a stored library voice still plays (the picker's current row). */
export async function libraryVoiceStatus(voiceId: string): Promise<LibraryVoiceStatusResult> {
  if (!isWellFormedVoiceId(voiceId)) return { status: 'unknown' };
  const a = await callProxy(`/tts/library-voice/${encodeURIComponent(voiceId)}`, { method: 'GET' });
  if ('fail' in a || a.status !== 200 || !a.body || typeof a.body !== 'object') return { status: 'error' };
  const b = a.body as Record<string, unknown>;
  if (b.status === 'active' || b.status === 'removed') {
    if (b.status === 'removed') rememberLibraryRefusal(voiceId);
    else forgetLibraryRefusal(voiceId);
    return { status: b.status, name: str(b.name, 120) ?? '', gender: str(b.gender, 20) };
  }
  return { status: b.status === 'pool' ? 'pool' : 'unknown' };
}

/** ElevenLabs hosts library preview clips on its public bucket. */
export function isAllowedPreviewUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  if (u.hostname === 'storage.googleapis.com') return /^\/eleven-public-[a-z0-9-]+\//.test(u.pathname);
  return u.hostname === 'elevenlabs.io' || u.hostname.endsWith('.elevenlabs.io');
}

/** The preview clip of a voice looked up this session (mp3 bytes). */
export async function libraryVoicePreviewBytes(voiceId: string): Promise<ArrayBuffer> {
  const url = known.get(voiceId);
  if (!url || !isAllowedPreviewUrl(url)) throw new Error('VOICE_TTS_FAILED: no preview for this voice');
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(PREVIEW_TIMEOUT_MS) });
  } catch (err) {
    throw new Error(`VOICE_TTS_FAILED: ${(err as Error).message}`);
  }
  if (!res.ok) throw new Error(`VOICE_TTS_FAILED: preview status ${res.status}`);
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > PREVIEW_MAX_BYTES) throw new Error('VOICE_TTS_FAILED: preview too large');
  const buf = await res.arrayBuffer();
  if (buf.byteLength > PREVIEW_MAX_BYTES) throw new Error('VOICE_TTS_FAILED: preview too large');
  return buf;
}




