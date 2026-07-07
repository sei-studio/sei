/**
 * Per-persona skin PNG storage.
 *
 * Responsibilities:
 *   - applyPng: validate PNG magic + IHDR (64×64 RGBA), write atomically under
 *     <userData>/skins/<personaId>.png, then persist skin descriptor + optional
 *     per-persona MC username via a SINGLE saveCharacter call (atomic
 *     two-field update — never half-applied).
 *   - removePng: unlink user-applied PNG (best-effort) and reset skin descriptor
 *     to 'none' (server falls through to Steve/Alex).
 *   - resolveSkinPng: source-of-truth lookup the HTTP server uses to translate
 *     a request URL into bytes (honors `skin.source`).
 *   - readSkinPng: pure helper from username → character lookup → resolveSkinPng.
 *
 * 260707: NO bundled skins ship with the app. The only bytes served are the
 * per-user cached override at <userData>/skins/<id>.png (pointed at by an
 * 'upload'/'username' descriptor). The three former defaults (sui/lyra/marv) are
 * ordinary public characters whose skin is downloaded from their cloud row by
 * cache-on-demand, exactly like any other public character — no offline
 * baseline, Steve until the cloud skin caches.
 *
 * Path-traversal safety: every caller MUST validate personaId via main/ipc.ts's
 * IdSchema (kebab-case slug regex) BEFORE calling into this module — the persona
 * id is consumed by paths.skinPngPath which builds a filesystem path component.
 * The IdSchema is the defense-in-depth gate; this module trusts its input.
 *
 * Sources:
 *   - CONTEXT.md §decisions "Skin serving: local HTTP, loopback only by default"
 *   - characterStore.ts (atomic-write + index-update pattern mirrored here)
 */
import { readFile, mkdir, unlink } from 'node:fs/promises';
import crypto from 'node:crypto';
// allowJs:true in tsconfig.node.json lets TS resolve these .js modules.
import { atomicWrite } from '../bot/brain/storage/atomicWrite.js';
import { withFileLock } from '../bot/brain/storage/fileLock.js';
import { paths } from './paths';
import { getCharacter, saveCharacter } from './characterStore';
import type { Character, Skin, SkinSource } from '../shared/characterSchema';

/**
 * Read the PNG bytes that should be served for this persona, honoring its
 * skin.source descriptor. Returns null when no skin should be served
 * (`source === 'none'` OR the file the descriptor points at is missing —
 * e.g. user deleted it out-of-band).
 */
export async function resolveSkinPng(character: Character): Promise<Buffer | null> {
  const s = character.skin;

  // The only skin bytes the app serves are the cached override under
  // <userData>/skins/<id>.png, pointed at by an 'upload'/'username' descriptor.
  // 260707: sui/lyra/marv are ordinary public characters now — cache-on-demand
  // flips their skin.source to 'upload' and downloads the cloud bytes here, the
  // same as any other public character. There is NO bundled baseline: when the
  // cached file is absent (source 'none'/'bundled', or an 'upload'/'username'
  // whose bytes have not downloaded yet), we serve nothing and the skin server
  // 404s → CustomSkinLoader renders Steve until the cloud skin caches. This is
  // identical to how every other public character behaves.
  if (s.source === 'upload' || s.source === 'username') {
    try {
      return await readFile(paths.skinPngPath(character.id));
    } catch {
      /* no cached bytes on disk yet → nothing to serve */
    }
  }
  return null;
}

/**
 * Apply a PNG: validate magic+IHDR, write atomically, sha256-verify, patch the
 * character's skin descriptor, optionally update per-persona MC username,
 * persist via a SINGLE saveCharacter call (atomic two-field update).
 *
 * `username` argument semantics:
 *   - undefined → leave the persisted username untouched (skin-only update)
 *   - null      → leave the persisted username untouched (renderer sentinel for "no change")
 *   - '' (empty string after trim) → clear the username (fall back to sanitizeMcName of persona name)
 *   - any other string → set as the per-persona MC username (CharacterSchema.parse
 *     inside saveCharacter validates the regex `^[A-Za-z0-9_]+$` + length 1-16)
 *
 * Defense-in-depth: we re-validate PNG bytes here even though the renderer's
 * upload dialog and the IPC schema both reject non-PNG input. Main
 * is the trust boundary — never assume the renderer already validated.
 */
export async function applyPng(args: {
  personaId: string;
  pngBytes: Buffer;
  source: SkinSource;
  mojangUsername?: string | null;
  username?: string | null;
}): Promise<{ skin: Skin; username: string | null }> {
  const { personaId, pngBytes, source, mojangUsername = null, username = undefined } = args;
  if (source !== 'upload' && source !== 'username') {
    throw new Error(`applyPng: invalid source '${source}' (must be 'upload' or 'username')`);
  }
  // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A (8 bytes). After that comes the
  // IHDR chunk: 4-byte length + 4-byte type + 13-byte data + 4-byte CRC. The
  // IHDR data starts at offset 16: width(4) height(4) bit-depth(1) color(1)
  // compression(1) filter(1) interlace(1).
  if (pngBytes.length < 24 ||
      pngBytes[0] !== 0x89 || pngBytes[1] !== 0x50 ||
      pngBytes[2] !== 0x4E || pngBytes[3] !== 0x47) {
    throw new Error('applyPng: not a PNG (magic-byte mismatch)');
  }
  // mojangSkinLookup normalizes legacy 64×32 skins to 64×64 BEFORE
  // handing the buffer here; applyPng can safely reject anything that isn't
  // 64×64 as a defense-in-depth check against a renderer that bypasses the
  // upload validator.
  const width = pngBytes.readUInt32BE(16);
  const height = pngBytes.readUInt32BE(20);
  if (width !== 64 || height !== 64) {
    throw new Error(`applyPng: PNG must be 64×64 (got ${width}×${height})`);
  }
  await mkdir(paths.skinsDir(), { recursive: true });
  const target = paths.skinPngPath(personaId);
  await withFileLock(target, async () => {
    await atomicWrite(target, pngBytes);
  });
  const sha256 = crypto.createHash('sha256').update(pngBytes).digest('hex');
  const character = await getCharacter(personaId);
  if (!character) throw new Error(`applyPng: character not found '${personaId}'`);

  const newSkin: Skin = {
    source,
    mojang_username: source === 'username' ? mojangUsername : null,
    png_sha256: sha256,
    applied_at: new Date().toISOString(),
  };

  // Resolve the username delta. Renderer semantics matrix is documented at the
  // top of applyPng's docblock. CharacterSchema.parse() inside saveCharacter
  // re-validates the regex + length cap when we hand it the new value.
  let nextUsername: string | null = character.username;
  if (typeof username === 'string') {
    const trimmed = username.trim();
    if (trimmed === '') {
      nextUsername = null; // explicit clear
    } else {
      nextUsername = trimmed; // explicit set; regex+length validated downstream
    }
  }
  // null / undefined → leave character.username unchanged

  // SINGLE atomic write. Skin descriptor + username
  // land together so the persisted character is never half-applied.
  await saveCharacter({ ...character, skin: newSkin, username: nextUsername });

  // Phase 11 — Mirror the updated character + skin bytes to cloud.
  // saveCharacter already enqueues an upsert; we enqueue a second one here
  // EXPLICITLY (it collapses with the first via enqueueUpsert's same-uuid
  // filter) so the cloud-mirror path is obvious at the skin call site.
  // The queue drainer re-reads <userData>/skins/<uuid>.png at drain time per
  // Pattern 4, so the freshly-written bytes are what land in Storage.
  // Defaults (D-22) never upload — skip the enqueue.
  if (!character.is_default) {
    void (async () => {
      try {
        const { enqueueUpsert } = await import('./cloud/syncQueue');
        await enqueueUpsert(character.id);
      } catch (err) {
        console.warn(`[sei] skin cloud mirror enqueue failed for ${character.id}: ${(err as Error).message}`);
      }
    })();
  }

  return { skin: newSkin, username: nextUsername };
}

/**
 * Reset a persona's skin to 'none' (server falls through to Steve/Alex). The
 * username is NOT touched — the user can clear it independently via the skin
 * editor's username field.
 *
 * The on-disk PNG under <userData>/skins/<id>.png is unlinked best-effort; if
 * the user never applied one (source was 'none' all along), the unlink hits
 * ENOENT which we swallow.
 */
export async function removePng(personaId: string): Promise<Skin> {
  const character = await getCharacter(personaId);
  if (!character) throw new Error(`removePng: character not found '${personaId}'`);
  try {
    await unlink(paths.skinPngPath(personaId));
  } catch {
    /* ignore ENOENT — best-effort cleanup */
  }
  const newSkin: Skin = {
    source: 'none',
    mojang_username: null,
    png_sha256: null,
    applied_at: new Date().toISOString(),
  };
  await saveCharacter({ ...character, skin: newSkin });
  return newSkin;
}

/**
 * Pure-read helper used by the skin HTTP server: takes a username, finds the
 * matching character, calls resolveSkinPng.
 *
 * Username match strategy (loose, on purpose):
 *   1. Case-insensitive match on `character.username` (the per-persona field)
 *   2. Case-insensitive sanitized-name fallback (`sanitizeMcName(character.name)`)
 *      so a renderer that hasn't wired character.username yet still resolves the
 *      right character on first launch — mirrors src/bot/index.js's
 *      sanitizeMcName.
 *
 * 260707: no bundled-default fallback. sui/lyra/marv are ordinary public
 * characters; when one isn't cached locally yet, this returns null and the skin
 * server 404s → Steve, identical to any other public character whose cloud skin
 * has not downloaded.
 */
export async function readSkinPng(args: {
  username: string;
  listCharacters: () => Promise<Character[]>;
}): Promise<Buffer | null> {
  const all = await args.listCharacters();
  const sanitize = (s: string): string => String(s || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 16) || 'Sei';
  // Case-insensitive comparison — MC usernames preserve case in display but
  // upstream CSL/preview consumers occasionally lowercase the slug. The skin
  // server's URL regex (skinServer.ts) restricts the path to [A-Za-z0-9_]{1,16}
  // so this is a pure case-fold compare; no Unicode normalization needed.
  const wantLower = args.username.toLowerCase();
  const match = all.find(
    (c) =>
      (c.username && c.username.toLowerCase() === wantLower) ||
      sanitize(c.name).toLowerCase() === wantLower,
  );
  if (match) return await resolveSkinPng(match);
  return null;
}
