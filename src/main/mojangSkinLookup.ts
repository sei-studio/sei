/**
 * Mojang username → UUID → texture PNG resolver.
 *
 * Three sequential HTTPS requests, each wrapped in its own AbortController with
 * a 15s wall-clock timeout (per CONTEXT.md "Every external call has a timeout"
 * and CLAUDE.md "every external call has a timeout — no exceptions"):
 *
 *   1. GET https://api.mojang.com/users/profiles/minecraft/<name>
 *        → { id: <uuid-no-dashes>, name: <canonical-name> }   (HTTP 200)
 *        → HTTP 204 / 404                                     (no such user)
 *        → HTTP 429                                           (rate limited)
 *
 *   2. GET https://sessionserver.mojang.com/session/minecraft/profile/<uuid>
 *        → properties array; pick `name === 'textures'`; base64-decode `value`
 *          → { textures: { SKIN: { url, metadata: { model } } } }
 *
 *   3. GET <textures.SKIN.url>                                (textures.minecraft.net)
 *        → binary PNG bytes (may be legacy 64×32 OR modern 64×64)
 *
 * Step 4 (LOCAL): pipe bytes through skinImageUtil.normalize64x64 so ancient
 * legacy 64×32 skins (e.g. Notch's pre-2014 upload) are upscaled to 64×64
 * BEFORE returning. applyPng gates strictly on 64×64; without this
 * normalization, every legacy account would surface as "SKIN_FILE_INVALID" in
 * the renderer.
 *
 * Every error path throws an Error whose message starts with
 * `MOJANG_LOOKUP_FAILED:` so the renderer's `classifyRendererError` heuristic
 * (src/renderer/src/lib/errors.ts) routes the message to
 * `ERROR_COPY[MOJANG_LOOKUP_FAILED]` without needing additional rules. Specific
 * suffixes ("no Minecraft account named X", "rate-limited", "invalid characters")
 * let the UI distinguish for copy-tweaking without parsing the URL stack.
 *
 * NOT cached — `applyPng` writes the PNG once the user clicks "Apply", and
 * from then on the local file is the source of truth (no persistent
 * dependency on Mojang per CONTEXT §decisions).
 *
 * Sources:
 *   - CLAUDE.md "Every external call has a timeout"
 *   - src/shared/errorClasses.ts (MOJANG_LOOKUP_FAILED)
 */
import crypto from 'node:crypto';
import { normalize64x64 } from './skinImageUtil';

/** 15s wall-clock budget per Mojang request. Worst case 3 × 15s = 45s. */
export const TIMEOUT_MS = 15_000;

const USER_AGENT = 'sei-electron/0.1.0';
const USERNAME_REGEX = /^[A-Za-z0-9_]{1,32}$/;

/**
 * Resolved Mojang skin payload. `pngBytes` are guaranteed 64×64 RGBA (legacy
 * 64×32 inputs are normalized via skinImageUtil before this struct is built).
 */
export interface MojangSkinResult {
  /** Canonical username as Mojang spells it (case-corrected from user input). */
  resolvedUsername: string;
  /** 64×64 PNG bytes ready for applyPng. */
  pngBytes: Buffer;
  /** Base64 of pngBytes — convenience for the renderer (skips a Buffer.toString call in the IPC handler). */
  pngBase64: string;
  /** SHA-256 of pngBytes (hex). Same as what applyPng/skinStore would compute. */
  sha256: string;
  /** Original textures.minecraft.net URL (informational; not surfaced to the UI). */
  textureUrl: string;
  /** Mojang model variant — 'slim' (Alex, 3-pixel-wide arms) or 'classic' (Steve, 4-pixel-wide arms). */
  model: 'classic' | 'slim';
}

/**
 * fetch wrapper with an AbortController-backed timeout. Clears the timer in
 * finally so a slow-but-successful response doesn't leave a dangling abort
 * scheduled (which Node would garbage-collect, but cleanup is cheap).
 */
async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, {
      signal: ac.signal,
      headers: { 'user-agent': USER_AGENT },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tag an unknown error with a stage prefix. Preserves an already-prefixed
 * MOJANG_LOOKUP_FAILED message so user-facing copy isn't double-tagged.
 */
function classify(err: unknown, stage: string): Error {
  if (err instanceof Error && err.message.startsWith('MOJANG_LOOKUP_FAILED:')) {
    return err;
  }
  const msg = err instanceof Error ? err.message : String(err);
  // AbortError comes through as `name === 'AbortError'` with a generic message;
  // surface a clearer line.
  if (err instanceof Error && err.name === 'AbortError') {
    return new Error(`MOJANG_LOOKUP_FAILED: ${stage}: request timed out after ${TIMEOUT_MS / 1000}s`);
  }
  return new Error(`MOJANG_LOOKUP_FAILED: ${stage}: ${msg}`);
}

/**
 * Walk Mojang's three sequential APIs and return the normalized PNG bytes.
 * See file header for the contract + error-classification rules.
 */
export async function lookupMojangSkin(username: string): Promise<MojangSkinResult> {
  // ── Input validation ───────────────────────────────────────────────────
  const trimmed = (username ?? '').trim();
  if (trimmed === '') {
    throw new Error('MOJANG_LOOKUP_FAILED: empty username');
  }
  if (!USERNAME_REGEX.test(trimmed)) {
    throw new Error('MOJANG_LOOKUP_FAILED: invalid characters in username');
  }

  // ── Step 1: username → UUID ────────────────────────────────────────────
  let uuid: string;
  let canonicalName: string;
  try {
    const r1 = await fetchWithTimeout(
      `https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(trimmed)}`,
      TIMEOUT_MS,
    );
    if (r1.status === 204 || r1.status === 404) {
      throw new Error(`MOJANG_LOOKUP_FAILED: no Minecraft account named ${trimmed}`);
    }
    if (r1.status === 429) {
      throw new Error('MOJANG_LOOKUP_FAILED: Mojang rate-limited the lookup. Wait a minute and try again.');
    }
    if (!r1.ok) {
      throw new Error(`MOJANG_LOOKUP_FAILED: api.mojang.com responded ${r1.status}`);
    }
    const j1 = (await r1.json()) as { id?: unknown; name?: unknown };
    if (typeof j1.id !== 'string' || typeof j1.name !== 'string') {
      throw new Error('MOJANG_LOOKUP_FAILED: api.mojang.com returned an unexpected shape');
    }
    uuid = j1.id;
    canonicalName = j1.name;
  } catch (err) {
    throw classify(err, 'username-to-uuid');
  }

  // ── Step 2: UUID → texture URL + model ─────────────────────────────────
  let textureUrl: string;
  let model: 'classic' | 'slim';
  try {
    const r2 = await fetchWithTimeout(
      `https://sessionserver.mojang.com/session/minecraft/profile/${encodeURIComponent(uuid)}`,
      TIMEOUT_MS,
    );
    if (r2.status === 429) {
      throw new Error('MOJANG_LOOKUP_FAILED: Mojang rate-limited the profile lookup. Wait a minute and try again.');
    }
    if (!r2.ok) {
      throw new Error(`MOJANG_LOOKUP_FAILED: sessionserver responded ${r2.status}`);
    }
    const j2 = (await r2.json()) as { properties?: unknown };
    if (!Array.isArray(j2.properties)) {
      throw new Error('MOJANG_LOOKUP_FAILED: sessionserver returned no properties array');
    }
    const tex = j2.properties.find(
      (p): p is { name: string; value: string } =>
        p != null &&
        typeof p === 'object' &&
        (p as { name?: unknown }).name === 'textures' &&
        typeof (p as { value?: unknown }).value === 'string',
    );
    if (!tex) {
      throw new Error('MOJANG_LOOKUP_FAILED: sessionserver returned no textures property');
    }
    // Base64 unwrap of the textures property. Mojang documents this as a
    // base64-encoded JSON blob (RESEARCH.md §4).
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(tex.value, 'base64').toString('utf8'));
    } catch {
      throw new Error('MOJANG_LOOKUP_FAILED: could not decode textures property');
    }
    const textures = (decoded as { textures?: unknown })?.textures;
    const skin = (textures as { SKIN?: unknown })?.SKIN;
    const url = (skin as { url?: unknown })?.url;
    if (typeof url !== 'string' || url === '') {
      throw new Error('MOJANG_LOOKUP_FAILED: profile has no skin set');
    }
    textureUrl = url;
    const metaModel = (skin as { metadata?: { model?: unknown } })?.metadata?.model;
    model = metaModel === 'slim' ? 'slim' : 'classic';
  } catch (err) {
    throw classify(err, 'uuid-to-texture');
  }

  // ── Step 3: download PNG bytes ─────────────────────────────────────────
  let rawPngBytes: Buffer;
  try {
    const r3 = await fetchWithTimeout(textureUrl, TIMEOUT_MS);
    if (!r3.ok) {
      throw new Error(`MOJANG_LOOKUP_FAILED: textures.minecraft.net responded ${r3.status}`);
    }
    rawPngBytes = Buffer.from(new Uint8Array(await r3.arrayBuffer()));
    if (
      rawPngBytes.length < 8 ||
      rawPngBytes[0] !== 0x89 ||
      rawPngBytes[1] !== 0x50 ||
      rawPngBytes[2] !== 0x4e ||
      rawPngBytes[3] !== 0x47
    ) {
      throw new Error('MOJANG_LOOKUP_FAILED: texture endpoint did not return a PNG');
    }
  } catch (err) {
    throw classify(err, 'texture-download');
  }

  // ── Step 4: legacy 64×32 → 64×64 normalization ─────────────────────────
  // applyPng gates on 64×64 strictly. Mojang still serves legacy
  // 64×32 skins for ancient accounts; we upscale here so the renderer never
  // sees a sub-spec PNG.
  let pngBytes: Buffer;
  try {
    pngBytes = normalize64x64(rawPngBytes);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`MOJANG_LOOKUP_FAILED: ${msg}`);
  }

  const sha256 = crypto.createHash('sha256').update(pngBytes).digest('hex');
  return {
    resolvedUsername: canonicalName,
    pngBytes,
    pngBase64: pngBytes.toString('base64'),
    sha256,
    textureUrl,
    model,
  };
}
