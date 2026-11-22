/**
 * Minecraft skin generation (261027, lazy skins).
 *
 * A Gemini skin is one billed proxy call (POST /generate/skin, $0.134, charged
 * to the player's allowance or credits by the proxy). It used to run on every
 * character creation, for characters most players never take into Minecraft.
 * Now:
 *
 *   - Creation paints the FREE local skin (img2skin's no-LLM painter, from the
 *     portrait colors, paintFallbackSkin) and saves the character with
 *     `metadata.skin_pending` (uniqueGeneration's cast).
 *   - ensureMinecraftSkin runs the Gemini call for a pending character the
 *     first time its owner opens the Minecraft launch panel (skin:ensure) or
 *     launches it (the Minecraft module's prepareJoin, which covers the chat
 *     and voice launch() tool too). At most once per character per app run;
 *     a character whose skin was already made is never sent again.
 *   - generateSkinForCharacter is the explicit button on the profile (skin:
 *     generate), a new billed call every time it is pressed.
 *
 * Billing stays on the proxy. This client asks for confirm mode
 * (x-sei-charge-confirm: 1): the proxy holds the charge, hands back its id in
 * x-sei-charge-id, and settles once we report whether the image became the
 * skin (POST /generate/skin/confirm). So an image img2skin cannot map (we then
 * keep or paint the free skin) costs the player nothing. A 402 (not enough
 * credits), 429 (daily skin cap) or any other failure never blocks anything:
 * the character keeps the skin it has, and one with no skin gets the painted
 * one. A proxy without confirm mode just settles on success, which is also
 * correct for this client (a 200 it cannot use is rare).
 *
 * Shared and public characters are never generated here: only the owner's
 * device makes the skin, it syncs to the cloud row with the character, and
 * everyone else downloads it (cacheOnDemand).
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { paths } from './paths';
import { getCharacter, saveCharacter } from './characterStore';
import { applyPng } from './skinStore';
import { skinPendingOf, type Character, type Skin } from '../shared/characterSchema';
import type { SkinGenOutcome, SkinGenResult } from '../shared/ipc';

const PROXY_BASE_URL = process.env.SEI_PROXY_URL ?? 'https://api.sei.gg';

/** Wall clock for the proxy's Gemini call (mirrors the portrait route). */
const SKIN_PANEL_TIMEOUT_MS = 60_000;
/** Reading the image body once the proxy has answered (headers in). */
const BODY_READ_TIMEOUT_MS = 30_000;
/** The confirm call is a single ledger update. */
const CONFIRM_TIMEOUT_MS = 10_000;

/** Request header asking the proxy to hold the charge until confirmed. */
const CHARGE_CONFIRM_HEADER = 'x-sei-charge-confirm';
/** Response header carrying the held charge's id. */
const CHARGE_ID_HEADER = 'x-sei-charge-id';

export type SkinVariant = 'slim' | 'classic';

/** Slim (Alex) arms for female companions, classic (Steve) for everyone else. */
export function skinVariantOf(c: Pick<Character, 'metadata'>): SkinVariant {
  const sheet = (c.metadata as Record<string, unknown> | undefined)?.soulcaster_sheet;
  const gender = (sheet as { gender?: unknown } | null | undefined)?.gender;
  return gender === 'female' ? 'slim' : 'classic';
}

/* -------------------------------------------------------------------------- */
/*  img2skin                                                                   */
/* -------------------------------------------------------------------------- */

/** Scratch dir with the source image written as character.png. Always cleaned up. */
async function withScratch<T>(image: Buffer, fn: (dir: string, src: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'sei-skin-'));
  try {
    const src = path.join(dir, 'character.png');
    await writeFile(src, image);
    return await fn(dir, src);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * The free skin: img2skin's deterministic painter (no network, no LLM), from
 * the image's colors. Throws only if img2skin itself fails.
 */
export async function paintFallbackSkin(image: Buffer, variant: SkinVariant): Promise<Buffer> {
  return withScratch(image, async (dir, src) => {
    const { characterToSkin } = await import('img2skin/src/pipeline.js');
    const out = path.join(dir, 'skin.png');
    await characterToSkin(src, out, { branch: 'fallback', variant });
    return await readFile(out);
  });
}

/** Map a Gemini panel atlas to a skin. Null when img2skin rejects the atlas. */
async function panelAtlasToSkin(image: Buffer, atlas: Buffer, variant: SkinVariant): Promise<Buffer | null> {
  return withScratch(image, async (dir, src) => {
    const { characterToSkin } = await import('img2skin/src/pipeline.js');
    const atlasPath = path.join(dir, 'panel.png');
    const out = path.join(dir, 'skin.png');
    await writeFile(atlasPath, atlas);
    const res = await characterToSkin(src, out, { branch: 'panel', mockAtlas: atlasPath, variant });
    if (res.valid !== true) return null;
    return await readFile(out);
  });
}

/* -------------------------------------------------------------------------- */
/*  Proxy                                                                      */
/* -------------------------------------------------------------------------- */

type PanelResult =
  | { ok: true; atlas: Buffer; chargeId: string | null }
  | { ok: false; outcome: 'insufficient_credits' | 'daily_limit' | 'failed'; detail: string };

/**
 * POST /generate/skin: the proxy's one Gemini image-to-image call that renders
 * the character as front and back Minecraft pixel-art views (img2skin Branch B
 * stage 1, prompt server-owned). Never throws.
 */
async function requestPanelAtlas(image: Buffer, jwt: string): Promise<PanelResult> {
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), SKIN_PANEL_TIMEOUT_MS);
  let chargeId: string | null = null;
  try {
    const resp = await fetch(`${PROXY_BASE_URL}/generate/skin`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt}`,
        [CHARGE_CONFIRM_HEADER]: '1',
      },
      body: JSON.stringify({ character_png_base64: image.toString('base64') }),
      signal: controller.signal,
    });
    if (resp.status === 402) return { ok: false, outcome: 'insufficient_credits', detail: 'HTTP 402' };
    if (resp.status === 429) return { ok: false, outcome: 'daily_limit', detail: 'HTTP 429' };
    if (!resp.ok) return { ok: false, outcome: 'failed', detail: `HTTP ${resp.status}` };
    // Headers are in: Gemini has answered and the charge is held. The call's
    // 60 s budget no longer applies (an abort now would leave the player
    // charged with the character still pending, and the next run bills
    // again); the body gets its own short budget, refunded if it runs out.
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), BODY_READ_TIMEOUT_MS);
    chargeId = resp.headers.get(CHARGE_ID_HEADER) || null;
    const json = (await resp.json()) as { png_base64?: unknown };
    const b64 = json?.png_base64;
    if (typeof b64 !== 'string' || b64.length === 0) {
      // The proxy answered 200 without an image: tell it so (refund).
      if (chargeId) await confirmCharge(chargeId, false, jwt);
      return { ok: false, outcome: 'failed', detail: 'response missing png_base64' };
    }
    return { ok: true, atlas: Buffer.from(b64, 'base64'), chargeId };
  } catch (err) {
    // The image never reached us after the charge was held: refund it.
    if (chargeId) await confirmCharge(chargeId, false, jwt);
    return { ok: false, outcome: 'failed', detail: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Settle a held charge: used=true charges it, used=false refunds it. Best
 * effort; an unconfirmed charge stays charged on the proxy (an image went out).
 */
async function confirmCharge(chargeId: string, used: boolean, jwt: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIRM_TIMEOUT_MS);
  try {
    const resp = await fetch(`${PROXY_BASE_URL}/generate/skin/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ charge_id: chargeId, used }),
      signal: controller.signal,
    });
    if (!resp.ok) console.warn(`[sei] skin charge confirm answered HTTP ${resp.status}`);
  } catch (err) {
    console.warn(`[sei] skin charge confirm failed: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------------------------------------------------- */
/*  Generation                                                                 */
/* -------------------------------------------------------------------------- */

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The stored portrait as PNG (the proxy takes PNG only). Null when there is none. */
async function readPortraitPng(characterId: string): Promise<Buffer | null> {
  let bytes: Buffer;
  try {
    bytes = await readFile(paths.portraitPath(characterId));
  } catch {
    return null;
  }
  if (PNG_MAGIC.every((b, i) => bytes[i] === b)) return bytes;
  // A hand-uploaded JPEG or WebP portrait.
  try {
    const { loadSharp } = await import('./uniqueGeneration');
    const sharp = loadSharp();
    return sharp ? await sharp(bytes).png().toBuffer() : null;
  } catch {
    return null;
  }
}

async function currentSession(): Promise<{ jwt: string; userId: string } | null> {
  try {
    const { getClient } = await import('./auth/supabaseClient');
    const session = (await getClient().auth.getSession()).data.session;
    if (!session?.access_token || !session.user?.id) return null;
    return { jwt: session.access_token, userId: session.user.id };
  } catch {
    return null;
  }
}

/** Owner-only: never a bundled default, never someone else's (shared/public) character. */
function mayGenerate(c: Character, userId: string): boolean {
  if (c.is_default) return false;
  return c.owner == null || c.owner === userId;
}

async function latestSkin(characterId: string): Promise<Skin | null> {
  return (await getCharacter(characterId))?.skin ?? null;
}

async function runGeneration(characterId: string): Promise<SkinGenResult> {
  const char = await getCharacter(characterId);
  if (!char) return { outcome: 'failed', skin: null };
  const done = (outcome: SkinGenOutcome, skin: Skin | null = char.skin): SkinGenResult => ({ outcome, skin });

  const session = await currentSession();
  if (!session) return done('not_signed_in');
  if (!mayGenerate(char, session.userId)) return done('not_allowed');
  const image = await readPortraitPng(characterId);
  if (!image) return done('no_portrait');

  const variant = skinVariantOf(char);
  const wasPending = skinPendingOf(char);

  const panel = await requestPanelAtlas(image, session.jwt);
  let outcome: SkinGenOutcome;
  // Retry at a later launch only when Gemini was never reached (credits,
  // daily cap, network). An image that came back unusable is not re-sent
  // automatically; the button still can.
  let keepPending = wasPending;
  if (panel.ok) {
    keepPending = false;
    let used = false;
    try {
      const skin = await panelAtlasToSkin(image, panel.atlas, variant);
      if (skin) {
        await applyPng({ personaId: characterId, pngBytes: skin, source: 'upload' });
        used = true;
      }
    } catch (err) {
      console.warn(`[sei] skin panel mapping failed for ${characterId}: ${(err as Error).message}`);
    }
    if (panel.chargeId) await confirmCharge(panel.chargeId, used, session.jwt);
    if (used) return done('generated', await latestSkin(characterId));
    outcome = 'failed';
  } else {
    console.warn(`[sei] skin generation for ${characterId} did not run: ${panel.outcome} (${panel.detail})`);
    outcome = panel.outcome;
  }

  // Never leave a character without a skin over a failed call: one with none
  // gets the free painted skin. An existing skin (painted or generated) stays.
  const latest = await getCharacter(characterId);
  if (latest && latest.skin.source === 'none') {
    try {
      const painted = await paintFallbackSkin(image, variant);
      await applyPng({ personaId: characterId, pngBytes: painted, source: 'upload', skinPending: keepPending });
    } catch (err) {
      console.warn(`[sei] fallback skin paint failed for ${characterId}: ${(err as Error).message}`);
    }
  } else if (latest && wasPending && !keepPending && skinPendingOf(latest)) {
    await clearPending(characterId);
  }
  return done(outcome, await latestSkin(characterId));
}

/** Drop the pending marker without touching the skin. */
async function clearPending(characterId: string): Promise<void> {
  try {
    const c = await getCharacter(characterId);
    if (!c || !skinPendingOf(c)) return;
    const metadata = { ...(c.metadata ?? {}) };
    delete metadata.skin_pending;
    await saveCharacter({ ...c, metadata });
  } catch (err) {
    console.warn(`[sei] clearing skin_pending failed for ${characterId}: ${(err as Error).message}`);
  }
}

/* -------------------------------------------------------------------------- */
/*  Entry points                                                               */
/* -------------------------------------------------------------------------- */

/** One generation per character at a time; a second caller joins it. */
const inflight = new Map<string, Promise<SkinGenResult>>();
/** Characters ensureMinecraftSkin already tried this app run. */
const ensured = new Set<string>();

function singleFlight(characterId: string): Promise<SkinGenResult> {
  const running = inflight.get(characterId);
  if (running) return running;
  const p = runGeneration(characterId)
    .catch((err: unknown): SkinGenResult => {
      console.warn(`[sei] skin generation threw for ${characterId}: ${(err as Error).message}`);
      return { outcome: 'failed', skin: null };
    })
    .finally(() => inflight.delete(characterId));
  inflight.set(characterId, p);
  return p;
}

/** The profile's skin button: a new billed call each press (joins a running one). */
export function generateSkinForCharacter(characterId: string): Promise<SkinGenResult> {
  ensured.add(characterId);
  return singleFlight(characterId);
}

/**
 * Launch panel open / Minecraft launch: generate only while the character
 * still has its creation placeholder, at most once per app run. Never throws.
 */
export async function ensureMinecraftSkin(characterId: string): Promise<SkinGenResult> {
  const running = inflight.get(characterId);
  if (running) return running;
  try {
      const char = await getCharacter(characterId);
    if (!char) return { outcome: 'skipped', skin: null };
    // A caller that started while this one read the character: join it, so
    // a launch never goes ahead of a generation the panel just began.
    const joined = inflight.get(characterId);
    if (joined) return joined;
    if (!skinPendingOf(char) || ensured.has(characterId)) return { outcome: 'skipped', skin: char.skin };
    ensured.add(characterId);
  } catch {
    return { outcome: 'skipped', skin: null };
  }
  return singleFlight(characterId);
}

/** Test seam. */
export function _resetSkinGenerationForTests(): void {
  inflight.clear();
  ensured.clear();
}




