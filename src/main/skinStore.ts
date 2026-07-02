/**
 * Per-persona skin PNG storage.
 *
 * Responsibilities:
 *   - applyPng: validate PNG magic + IHDR (64×64 RGBA), write atomically under
 *     <userData>/skins/<personaId>.png, then persist skin descriptor + optional
 *     per-persona MC username via a SINGLE saveCharacter call (atomic
 *     two-field update — never half-applied).
 *   - removePng: unlink user-applied PNG (best-effort) and reset skin descriptor
 *     to 'bundled' for default personas / 'none' for user-created personas.
 *   - resolveSkinPng: source-of-truth lookup the HTTP server uses to translate
 *     a request URL into bytes (honors `skin.source`).
 *   - readSkinPng: pure helper from username → character lookup → resolveSkinPng.
 *
 * Bundled PNGs ship under `resources/skins/<id>.png` (sui/lyra/clawd). The
 * asarUnpack entry in electron-builder.yml exposes them at
 * `<process.resourcesPath>/app.asar.unpacked/resources/skins/` in packaged builds.
 *
 * Path-traversal safety: every caller MUST validate personaId via main/ipc.ts's
 * IdSchema (kebab-case slug regex) BEFORE calling into this module — the persona
 * id is consumed by paths.skinPngPath which builds a filesystem path component
 * via path.join. The IdSchema is the defense-in-depth gate; this module trusts
 * its input.
 *
 * Sources:
 *   - CONTEXT.md §decisions "Skin serving: local HTTP, loopback only by default"
 *   - characterStore.ts (atomic-write + index-update pattern mirrored here)
 */
import { readFile, mkdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { app } from 'electron';
// allowJs:true in tsconfig.node.json lets TS resolve these .js modules.
import { atomicWrite } from '../bot/brain/storage/atomicWrite.js';
import { withFileLock } from '../bot/brain/storage/fileLock.js';
import { paths } from './paths';
import { getCharacter, saveCharacter } from './characterStore';
import { DEFAULT_CHARACTERS, DEFAULT_CHARACTER_UUIDS } from './defaultCharacters';
import type { Character, Skin, SkinSource } from '../shared/characterSchema';

/**
 * ROOT CAUSE (ITEM 9, quick/260523-t8d): the previous bundledSkinPath
 * interpolated the persona's UUID directly into the path — yielding
 * `resources/skins/<UUID>.png` — but the bundled PNGs on disk are SLUG-named
 * (`resources/skins/sui.png`, `lyra.png`, `clawd.png`). The Plan 11-05
 * slug→UUID migration's docblock in defaultCharacters.ts:49-50 PROMISED a
 * UUID→slug reverse lookup here, but the implementation never landed. Every
 * default's resolveSkinPng() then hit ENOENT → skin server 404 → preview +
 * in-game both fell back to Steve. See DEFAULT-SKIN-DIAGNOSIS.md for the
 * full trace.
 *
 * FIX: take the Character (not the bare UUID) so we can read
 * `character.slug` directly. Defensive fallback to `DEFAULT_CHARACTER_UUIDS`
 * reverse-lookup when slug is null/undefined (handles legacy on-disk rows
 * from older builds where the slug field was stripped).
 *
 * Packaged build: bundled PNGs live under
 *   <resourcesPath>/app.asar.unpacked/resources/skins/<slug>.png
 * The asarUnpack entry (electron-builder.yml line ~7: `resources/skins/**`)
 * exposes the binary PNGs at runtime — they would otherwise be trapped
 * inside the read-only app.asar.
 *
 * Dev: the compiled main module lives at <repo>/dist/main/skinStore.js (or
 * via electron-vite's dev pipeline), so two `..` levels reach the repo root
 * and resources/skins/.
 */
function slugFromUuid(uuid: string): string | null {
  for (const [slug, id] of Object.entries(DEFAULT_CHARACTER_UUIDS)) {
    if (id === uuid) return slug;
  }
  return null;
}

export function bundledSkinPath(character: Pick<Character, 'id' | 'slug'>): string | null {
  const isBundled = DEFAULT_CHARACTERS.some((c) => c.id === character.id);
  if (!isBundled) return null;
  const slug = character.slug ?? slugFromUuid(character.id);
  if (!slug) return null;
  const file = `${slug}.png`;
  if (app.isPackaged) {
    // 260607 (packaged skin-load fix): the bundled PNGs can sit in DIFFERENT
    // places depending on the packaging layout —
    //   1. <resourcesPath>/app.asar.unpacked/resources/skins/  (asarUnpack — current intent)
    //   2. inside app.asar at <appPath>/resources/skins/        (the MAIN process can
    //      still fs.read this via Electron's asar patch even if it was NOT unpacked)
    //   3. <resourcesPath>/resources/skins/                     (flat extraResources copy)
    // A single hard-coded guess that misses the actual layout fails SILENTLY
    // (resolveSkinPng/readSkinPng swallow ENOENT → skin server 404 → in-game &
    // preview fall back to Steve), which is exactly the "works in dev, broken in
    // the built release" report. Probe candidates, return the first that exists,
    // and log loudly when none do so the failure is finally diagnosable.
    const candidates = [
      path.join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'skins', file),
      path.join(app.getAppPath(), 'resources', 'skins', file),
      path.join(process.resourcesPath, 'resources', 'skins', file),
    ];
    const found = candidates.find((p) => existsSync(p));
    if (found) return found;
    console.warn(
      `[sei] bundledSkinPath: bundled skin '${slug}' not found at any candidate ` +
        `(isPackaged=true, resourcesPath=${process.resourcesPath}, appPath=${app.getAppPath()}); ` +
        `tried: ${candidates.join(' | ')}`,
    );
    return candidates[0]; // primary — the caller's readFile will ENOENT + log
  }
  return path.join(__dirname, '..', '..', 'resources', 'skins', file);
}

/**
 * Read the PNG bytes that should be served for this persona, honoring its
 * skin.source descriptor. Returns null when no skin should be served
 * (`source === 'none'` OR the file the descriptor points at is missing —
 * e.g. user deleted it out-of-band).
 */
export async function resolveSkinPng(character: Character): Promise<Buffer | null> {
  const s = character.skin;
  const bundledFallback = bundledSkinPath(character); // non-null only for defaults

  // Cloud-override-wins: an explicit 'upload'/'username' descriptor points at a
  // PNG cached under <userData>/skins/<id>.png. For a DEFAULT this is how it
  // receives an UPDATED skin from cloud (cache-on-demand flips skin.source to
  // 'upload' and downloads the bytes) — so the cached override must take
  // precedence over the bundled baseline. If the cached file is absent
  // (offline, cloud bytes not yet downloaded), we fall through to the bundled
  // fallback below, preserving the offline baseline.
  if (s.source === 'upload' || s.source === 'username') {
    try {
      return await readFile(paths.skinPngPath(character.id));
    } catch {
      /* no cached override on disk → fall through to bundled fallback */
    }
  }

  // Bundled-default safety net: if this is a bundled default (sui/lyra/clawd),
  // serve the bundled PNG. A persisted character may have drifted to
  // `source: 'none'` or `source: 'upload'` with no on-disk PNG (an aborted
  // apply, a manual edit, a legacy migration, or a cloud override whose bytes
  // failed to download) — defaults always have a bundled baseline to fall back
  // on. This was a real foot-gun: the skin server would return 404 for
  // /skins/Sui.png and the 3D preview would silently fall back to Steve.
  if (bundledFallback) {
    try {
      return await readFile(bundledFallback);
    } catch (err) {
      // 260607: was a silent swallow — a packaged ENOENT here IS the "skin
      // works in dev, Steve in the built release" bug. Log the attempted path
      // so it surfaces in logs instead of vanishing into a 404.
      console.warn(
        `[sei] resolveSkinPng: bundled read failed for ${character.id} at ${bundledFallback}: ` +
          `${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`,
      );
    }
  }
  // Non-default 'none'/'bundled', or an 'upload'/'username' with no cached
  // bytes and no bundled baseline → nothing to serve.
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
 * Reset a persona's skin. Defaults revert to 'bundled', user-created revert to
 * 'none'. The username is NOT touched — the user can clear it independently
 * via the skin editor's username field.
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
 *   1. Case-insensitive match on `character.username` (the per-persona field)
 *   2. Case-insensitive sanitized-name fallback (`sanitizeMcName(character.name)`)
 *      so a renderer that hasn't wired character.username yet still gets correct
 *      bundled-skin behavior on first launch — mirrors src/bot/index.js's
 *      sanitizeMcName.
 *   3. **Bundled-default fallback (ui-A8)**: when no local character matches, fall
 *      through to the bundled defaults shipped under `resources/skins/<slug>.png`.
 *      We match against the default's slug, name, and per-persona username — all
 *      case-insensitively. This covers two real scenarios:
 *        (a) the renderer's SkinPreview3d for a default opened from the world
 *            (Browse) tab BEFORE seedDefaultCharacters has run on this machine
 *            (fresh install, first launch race) — without the fallback the
 *            preview shows the Steve silhouette;
 *        (b) any CustomSkinLoader / external consumer that requests the lower-
 *            case slug variant (`/skins/sui.png`) instead of the seeded
 *            persona-username (`/skins/Sui.png`).
 *      The fallback returns the EXACT bundled bytes for the matching slug; no
 *      user-applied PNG state is touched. Bundled defaults are read-only at the
 *      user level (D-22), so serving them by slug on a cache miss is safe.
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

  // ── Bundled-default fallback (ui-A8) ───────────────────────────────────
  //
  // No local character matched. If the request maps to a known default
  // (by slug, name, or username — all case-insensitive), read the bundled
  // PNG directly. The default's slug is the source of truth for the on-disk
  // file (`resources/skins/<slug>.png`); we build a synthetic
  // `Pick<Character, 'id'|'slug'>` so bundledSkinPath can do its UUID→slug
  // resolution unchanged.
  for (const def of DEFAULT_CHARACTERS) {
    const defSlug = (def.slug ?? '').toLowerCase();
    const defUsername = (def.username ?? '').toLowerCase();
    const defName = sanitize(def.name).toLowerCase();
    if (defSlug === wantLower || defUsername === wantLower || defName === wantLower) {
      const p = bundledSkinPath({ id: def.id, slug: def.slug });
      if (!p) continue;
      try {
        return await readFile(p);
      } catch (err) {
        // 260607: log instead of silently swallowing — a packaged ENOENT here
        // is the "Steve in the built release" bug. asarUnpack SHOULD cover
        // resources/skins/**, but if the layout differs this warn is the only
        // trace; bundledSkinPath() already probed candidates before returning p.
        console.warn(
          `[sei] readSkinPng: bundled read failed for ${def.slug} at ${p}: ` +
            `${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`,
        );
        continue;
      }
    }
  }
  return null;
}
