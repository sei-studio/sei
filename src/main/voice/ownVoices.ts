/**
 * The user's OWN ElevenLabs voices (261019) â€” MAIN only.
 *
 * A BYOK user who cloned or designed a voice in ElevenLabs (or saved one from
 * the Voice Library) expects to pick it for a companion. The picker used to
 * show only Sei's curated pool; nothing read the user's own account. This
 * module lists that account with the stored key, so the key never reaches the
 * renderer: the renderer gets names and labels (OwnVoiceInfo), never the key
 * or the preview URLs.
 *
 * API (ElevenLabs docs, "List voices", verified 261019):
 *   GET https://api.elevenlabs.io/v2/voices
 *     ?page_size=100            (max 100)
 *     &voice_type=non-default   (everything except ElevenLabs' built-ins:
 *                                personal, saved library, workspace voices)
 *     &next_page_token=...      (pagination; rely on has_more)
 *   header xi-api-key
 *   200 â†’ { voices: [{ voice_id, name, category, labels, description,
 *            preview_url, ... }], has_more, total_count, next_page_token }
 *   401 â†’ { detail: { status: 'invalid_api_key' | 'missing_permissions', ... } }
 * Built-in ('premade') voices are filtered out again here in case a future
 * API revision ignores voice_type: they are not "your" voices, and the
 * curated pool already covers what Sei offers.
 *
 * Only an own-voice key lists anything (resolveOwnVoiceKey: the
 * SEI_TTS_DEV_KEY env, else the stored key). Since 261020 (T158) that
 * includes a CLOUD user's optional key: their own voices then speak direct
 * with it (tts.ts planSpeech) while Sei's pool keeps the proxy. With no key
 * there is nothing that could speak an own voice (the proxy only speaks Sei's
 * account), so offering one would be a lie.
 */
import { createHash } from 'node:crypto';
import type { OwnVoiceInfo, OwnVoiceList } from '../../shared/ipc';
import { isWellFormedVoiceId } from '../../shared/voiceIds';
import { resolveOwnVoiceKey } from './elevenLabsKeyStore';
import { previewCacheKey, readCachedPreview, writeCachedPreview } from './previewCache';

const LIST_URL = 'https://api.elevenlabs.io/v2/voices';
const PAGE_SIZE = 100;
/** 500 voices is far past any personal library; bounds a runaway cursor. */
const MAX_PAGES = 5;
const LIST_TIMEOUT_MS = 10_000;
/** A freshly cloned voice should show up without restarting the app, and the
 * picker re-reads on every open, so the cache only absorbs re-mounts. */
const CACHE_TTL_MS = 5 * 60_000;
const PREVIEW_TIMEOUT_MS = 15_000;
const PREVIEW_MAX_BYTES = 5 * 1024 * 1024;

/** Main-side record: what the renderer sees plus the preview URL. */
export interface OwnVoiceRecord extends OwnVoiceInfo {
  previewUrl: string | null;
}

export interface OwnVoicesPage {
  voices: OwnVoiceRecord[];
  hasMore: boolean;
  nextPageToken: string | null;
}

function str(v: unknown, max = 200): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;
}

/**
 * Preview URLs are fetched by main, so only ElevenLabs' own storage is
 * trusted; anything else falls back to synthesizing the sample. The two
 * shapes ElevenLabs serves (observed 261019 on the public /v1/voices and
 * /v1/shared-voices responses; both fetch keyless, 200 audio/mpeg, no
 * redirect):
 *   https://storage.googleapis.com/eleven-public-prod/...   (their GCS bucket)
 *   https://api.us.elevenlabs.io/v1/voices/<id>/previews/audio?payload=...
 * The GCS allowance is pinned to that bucket: storage.googleapis.com hosts
 * every Google Cloud customer's public buckets.
 */
export function isTrustedPreviewUrl(url: string | null | undefined): url is string {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
    const h = u.hostname.toLowerCase();
    if (h === 'storage.googleapis.com') return u.pathname.startsWith('/eleven-public-prod/');
    return h === 'elevenlabs.io' || h.endsWith('.elevenlabs.io');
  } catch {
    return false;
  }
}

/** Parse one /v2/voices page. Tolerant: a malformed entry is skipped, never
 * fatal, so one odd voice cannot hide the rest of the library. */
export function parseOwnVoicesPage(json: unknown): OwnVoicesPage {
  const root = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  const list = Array.isArray(root.voices) ? root.voices : [];
  const voices: OwnVoiceRecord[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const v = raw as Record<string, unknown>;
    const id = v.voice_id;
    if (!isWellFormedVoiceId(id)) continue;
    const category = str(v.category, 40) ?? 'unknown';
    if (category === 'premade') continue;
    const labels = (v.labels && typeof v.labels === 'object' ? v.labels : {}) as Record<string, unknown>;
    const previewUrl = isTrustedPreviewUrl(str(v.preview_url, 2000)) ? (v.preview_url as string).trim() : null;
    const gender = str(labels.gender, 20);
    const age = str(labels.age, 30);
    const accent = str(labels.accent, 40);
    const description = str(v.description, 200) ?? str(labels.description, 200);
    voices.push({
      id,
      name: str(v.name, 100) ?? id,
      category,
      ...(gender ? { gender: gender.toLowerCase() } : {}),
      ...(age ? { age } : {}),
      ...(accent ? { accent } : {}),
      ...(description ? { description } : {}),
      hasPreview: previewUrl !== null,
      previewUrl,
    });
  }
  const token = str(root.next_page_token, 500) ?? null;
  return { voices, hasMore: root.has_more === true && token !== null, nextPageToken: token };
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type OwnVoicesFetchResult =
  | { status: 'ok'; voices: OwnVoiceRecord[] }
  | { status: 'bad_key' | 'error'; voices: [] };

/** Page through the account's voices. Never throws. */
export async function fetchOwnVoices(key: string, fetchImpl: FetchLike = fetch): Promise<OwnVoicesFetchResult> {
  const out: OwnVoiceRecord[] = [];
  const seen = new Set<string>();
  let token: string | null = null;
  // voice_type is only a server-side filter (premade is dropped in the parser
  // either way), so if a future API revision rejects the value the list is
  // read once more without it instead of failing.
  let voiceType: string | null = 'non-default';
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params = new URLSearchParams({ page_size: String(PAGE_SIZE) });
    if (voiceType) params.set('voice_type', voiceType);
    if (token) params.set('next_page_token', token);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), LIST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetchImpl(`${LIST_URL}?${params}`, { headers: { 'xi-api-key': key }, signal: ctrl.signal });
    } catch (err) {
      clearTimeout(timer);
      console.warn(`[sei/voice] own voices fetch failed: ${(err as Error).message}`);
      return { status: 'error', voices: [] };
    }
    let body: unknown = null;
    try {
      body = res.ok ? await res.json() : await res.text();
    } catch {
      body = null;
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401 || res.status === 403) return { status: 'bad_key', voices: [] };
    if ((res.status === 400 || res.status === 422) && voiceType && page === 0) {
      voiceType = null;
      page -= 1;
      continue;
    }
    if (!res.ok) {
      console.warn(`[sei/voice] own voices upstream ${res.status}: ${String(body ?? '').slice(0, 200)}`);
      return { status: 'error', voices: [] };
    }
    const parsed = parseOwnVoicesPage(body);
    for (const v of parsed.voices) {
      if (seen.has(v.id)) continue;
      seen.add(v.id);
      out.push(v);
    }
    if (!parsed.hasMore) break;
    token = parsed.nextPageToken;
  }
  return { status: 'ok', voices: out };
}

function keyFingerprint(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16);
}

let cache: { fp: string; at: number; voices: OwnVoiceRecord[] } | null = null;
let inflight: { fp: string; promise: Promise<OwnVoicesFetchResult> } | null = null;
/** Test seam / key-change hook: the next read goes to ElevenLabs. */
export function invalidateOwnVoices(): void {
  cache = null;
  inflight = null;
}

async function ownVoiceRecords(opts: { refresh?: boolean; fetchImpl?: FetchLike } = {}): Promise<
  { status: OwnVoiceList['status']; voices: OwnVoiceRecord[] }
> {
  const key = await resolveOwnVoiceKey().catch(() => null);
  if (!key) return { status: 'unavailable', voices: [] };
  const fp = keyFingerprint(key);
  const now = Date.now();
  if (!opts.refresh && cache && cache.fp === fp && now - cache.at < CACHE_TTL_MS) {
    return { status: 'ok', voices: cache.voices };
  }
  if (!inflight || inflight.fp !== fp) {
    const promise = fetchOwnVoices(key, opts.fetchImpl);
    inflight = { fp, promise };
    void promise.finally(() => {
      if (inflight?.promise === promise) inflight = null;
    });
  }
  const result = await inflight.promise;
  // Only a good answer is cached: a network blip must not hide the tab for
  // the whole TTL, and a fixed key should work on the very next open.
  if (result.status === 'ok') cache = { fp, at: Date.now(), voices: result.voices };
  return result;
}

/** The renderer-facing list (no key, no preview URLs). Never throws. */
export async function listOwnVoices(opts: { refresh?: boolean; fetchImpl?: FetchLike } = {}): Promise<OwnVoiceList> {
  try {
    const { status, voices } = await ownVoiceRecords(opts);
    return { status, voices: voices.map(({ previewUrl: _drop, ...info }) => info) };
  } catch {
    return { status: 'error', voices: [] };
  }
}

/** Whether `id` is a voice in the account behind the CURRENT own-voice key.
 * The IPC preview boundary uses this beside isPoolVoiceId, so samples stay a
 * closed allowlist (pool âˆª the user's own library), never an arbitrary id. */
export async function isOwnVoiceId(id: string, opts: { fetchImpl?: FetchLike } = {}): Promise<boolean> {
  if (!isWellFormedVoiceId(id)) return false;
  try {
    const { status, voices } = await ownVoiceRecords(opts);
    return status === 'ok' && voices.some((v) => v.id === id);
  } catch {
    return false;
  }
}

/** The response body, or null once it passes `max` bytes (reading stops). */
async function readCapped(res: Response, max: number): Promise<ArrayBuffer | null> {
  if (!res.body) {
    const buf = await res.arrayBuffer();
    return buf.byteLength > max ? null : buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out.buffer;
}

/**
 * ElevenLabs' ready-made sample for one own voice, fetched in main and
 * disk-cached (keyed on the preview URL, which changes when the voice is
 * re-recorded). Resolves null when the voice is not in the user's library,
 * has no trusted preview URL, or the download fails: the caller then
 * synthesizes the sample line through the key instead.
 */
export async function ownVoicePreviewBytes(
  voiceId: string,
  opts: { fetchImpl?: FetchLike } = {},
): Promise<ArrayBuffer | null> {
  const { status, voices } = await ownVoiceRecords(opts);
  if (status !== 'ok') return null;
  const rec = voices.find((v) => v.id === voiceId);
  if (!rec || !isTrustedPreviewUrl(rec.previewUrl)) return null;
  const key = previewCacheKey(voiceId, `#own-preview\n${rec.previewUrl}`);
  const cached = await readCachedPreview(key);
  if (cached) return cached;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PREVIEW_TIMEOUT_MS);
  try {
    // redirect: 'error' keeps the host check meaningful (no hop elsewhere).
    const res = await fetchImpl(rec.previewUrl, { signal: ctrl.signal, redirect: 'error' });
    if (!res.ok) return null;
    const len = Number(res.headers.get('content-length') ?? '0');
    if (len > PREVIEW_MAX_BYTES) return null;
    // Content-Length is optional (chunked responses carry none), so the cap
    // is enforced while reading: past it the download is cancelled instead
    // of being buffered whole and then thrown away.
    const buf = await readCapped(res, PREVIEW_MAX_BYTES);
    if (!buf || buf.byteLength === 0) return null;
    await writeCachedPreview(key, buf);
    return buf;
  } catch (err) {
    console.warn(`[sei/voice] own voice preview fetch failed: ${(err as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}




