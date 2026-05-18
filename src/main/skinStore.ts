/**
 * Per-persona skin PNG storage (Phase 9, Plan 02).
 *
 * Responsibilities:
 *   - applyPng: validate PNG magic + IHDR (64×64 RGBA), write atomically under
 *     <userData>/skins/<personaId>.png, then persist skin descriptor + optional
 *     per-persona MC username via a SINGLE saveCharacter call (atomic two-field
 *     update per WARNING 5 of 09-02-PLAN — never half-applied).
 *   - removePng: unlink user-applied PNG (best-effort) and reset skin descriptor
 *     to 'bundled' for default personas / 'none' for user-created personas.
 *   - resolveSkinPng: source-of-truth lookup the HTTP server uses to translate
 *     a request URL into bytes (honors `skin.source`).
 *   - readSkinPng: pure helper from username → character lookup → resolveSkinPng.
 *
 * Bundled PNGs ship under `resources/skins/<id>.png` (sui/mochineko/clawd from
 * Plan 01 Task 2). The asarUnpack entry in electron-builder.yml exposes them at
 * `<process.resourcesPath>/app.asar.unpacked/resources/skins/` in packaged builds.
 *
 * Path-traversal safety: every caller MUST validate personaId via main/ipc.ts's
 * IdSchema (kebab-case slug regex) BEFORE calling into this module — the persona
 * id is consumed by paths.skinPngPath which builds a filesystem path component
 * via path.join. The IdSchema is the defense-in-depth gate; this module trusts
 * its input.
 *
 * Sources:
 *   - 09-02-PLAN Task 1
 *   - CONTEXT.md §decisions "Skin serving: local HTTP, loopback only by default"
 *   - characterStore.ts (atomic-write + index-update pattern mirrored here)
 */
import { readFile, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { app } from 'electron';
// allowJs:true in tsconfig.node.json lets TS resolve these .js modules.
import { atomicWrite } from '../bot/brain/storage/atomicWrite.js';
import { withFileLock } from '../bot/brain/storage/fileLock.js';
import { paths } from './paths';
import { getCharacter, saveCharacter } from './characterStore';
import { DEFAULT_CHARACTERS } from './defaultCharacters';
import type { Character, Skin, SkinSource } from '../shared/characterSchema';

/**
 * Resolve the absolute path to the bundled PNG for a default persona. Returns
 * null if the persona isn't one of the shipped defaults.
 *
 * Packaged build: bundled PNGs live under
 *   <resourcesPath>/app.asar.unpacked/resources/skins/<id>.png
 * (asarUnpack entry was added in Plan 01 Task 2 so the binary PNGs survive
 * packaging — they would otherwise be trapped inside the read-only app.asar).
 *
 * Dev: the compiled main module lives at <repo>/dist/main/skinStore.js (or via
 * electron-vite's dev pipeline), so two `..` levels reach the repo root and
 * resources/skins/.
 */
export function bundledSkinPath(personaId: string): string | null {
  const isBundled = DEFAULT_CHARACTERS.some((c) => c.id === personaId);
  if (!isBundled) return null;
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'skins', `${personaId}.png`);
  }
  return path.join(__dirname, '..', '..', 'resources', 'skins', `${personaId}.png`);
}

/**
 * Read the PNG bytes that should be served for this persona, honoring its
 * skin.source descriptor. Returns null when no skin should be served
 * (`source === 'none'` OR the file the descriptor points at is missing —
 * e.g. user deleted it out-of-band).
 */
export async function resolveSkinPng(character: Character): Promise<Buffer | null> {
  const s = character.skin;
  if (s.source === 'none') return null;
  if (s.source === 'bundled') {
    const p = bundledSkinPath(character.id);
    if (!p) return null;
    try {
      return await readFile(p);
    } catch {
      return null;
    }
  }
  // 'upload' or 'username' → user-applied PNG under <userData>/skins/<id>.png
  try {
    return await readFile(paths.skinPngPath(character.id));
  } catch {
    return null;
  }
}

/**
 * Apply a PNG: validate magic+IHDR, write atomically, sha256-verify, patch the
 * character's skin descriptor, optionally update per-persona MC username,
 * persist via a SINGLE saveCharacter call (atomic two-field update per WARNING 5).
 *
 * `username` argument semantics:
 *   - undefined → leave the persisted username untouched (skin-only update)
 *   - null      → leave the persisted username untouched (renderer sentinel for "no change")
 *   - '' (empty string after trim) → clear the username (fall back to sanitizeMcName of persona name)
 *   - any other string → set as the per-persona MC username (CharacterSchema.parse
 *     inside saveCharacter validates the regex `^[A-Za-z0-9_]+$` + length 1-16)
 *
 * Defense-in-depth: we re-validate PNG bytes here even though the renderer's
 * upload dialog (Plan 03) and the IPC schema both reject non-PNG input. Main
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
  // Plan 03's mojangSkinLookup normalizes legacy 64×32 skins to 64×64 BEFORE
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

  // SINGLE atomic write — this is the WARNING 5 fix. Skin descriptor + username
  // land together so the persisted character is never half-applied.
  await saveCharacter({ ...character, skin: newSkin, username: nextUsername });
  return { skin: newSkin, username: nextUsername };
}

/**
 * Reset a persona's skin. Defaults revert to 'bundled', user-created revert to
 * 'none'. The username is NOT touched — the user can clear it independently
 * via the skin editor's username field (Plan 06).
 *
 * The on-disk PNG under <userData>/skins/<id>.png is unlinked best-effort; if
 * the user never applied one (source was 'bundled' or 'none' all along), the
 * unlink hits ENOENT which we swallow.
 */
export async function removePng(personaId: string): Promise<Skin> {
  const character = await getCharacter(personaId);
  if (!character) throw new Error(`removePng: character not found '${personaId}'`);
  try {
    await unlink(paths.skinPngPath(personaId));
  } catch {
    /* ignore ENOENT — best-effort cleanup */
  }
  const isBundled = DEFAULT_CHARACTERS.some((c) => c.id === personaId);
  const newSkin: Skin = {
    source: isBundled ? 'bundled' : 'none',
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
 *   1. Exact match on `character.username` (the per-persona field added in Plan 01)
 *   2. Sanitized-name fallback (`sanitizeMcName(character.name)`) so a renderer
 *      that hasn't wired character.username yet still gets correct bundled-skin
 *      behavior on first launch — mirrors src/bot/index.js's sanitizeMcName.
 */
export async function readSkinPng(args: {
  username: string;
  listCharacters: () => Promise<Character[]>;
}): Promise<Buffer | null> {
  const all = await args.listCharacters();
  const sanitize = (s: string): string => String(s || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 16) || 'Sei';
  const match = all.find(
    (c) => (c.username && c.username === args.username) || sanitize(c.name) === args.username,
  );
  if (!match) return null;
  return await resolveSkinPng(match);
}
