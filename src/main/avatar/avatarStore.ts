/**
 * Per-character Live2D avatar store (260804).
 *
 * A user-imported Live2D Cubism model (moc3 + model3.json + textures +
 * expressions + physics), extracted from a zip into
 * `<profileRoot>/avatars/<characterId>/` next to a `manifest.json`. Outside
 * memoryDir (knowledge precedent) so "Reset memory" never touches it; a full
 * character delete / remove-from-library takes it (characterStore, ipc).
 *
 * LOCAL-ONLY by design: nothing here rides `character.metadata`, so nothing
 * syncs to the cloud — a character adopted elsewhere simply has no avatar and
 * the overlay falls back to the static portrait tile.
 *
 * Import NORMALIZES the stored model3.json, because real-world VTuber exports
 * are sloppy in two specific ways (measured on the first test model):
 *   1. `.exp3.json` expression files ship in the zip but are NOT referenced in
 *      `FileReferences.Expressions` — the renderer's loader only knows what
 *      the settings file names, so unreferenced expressions would not exist.
 *   2. The `EyeBlink` parameter group can be missing, which silently disables
 *      the SDK's automatic blink on a motionless model.
 * The stored copy is ours, so we fix both at import time and the renderer
 * loader stays dumb.
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { paths } from '../paths';
import type { AvatarEmotion, AvatarManifest, AvatarModelFile } from '../../shared/ipc';

/** Upload cap for the zip itself (a full VTuber model with 4k textures is
 * ~20 MB; 128 MB leaves generous headroom without inviting abuse). */
export const AVATAR_ZIP_MAX_BYTES = 128 * 1024 * 1024;
/** Cap on total EXTRACTED bytes (zip-bomb guard). */
export const AVATAR_EXTRACTED_MAX_BYTES = 256 * 1024 * 1024;
/** Cap on extracted entry count. */
export const AVATAR_MAX_ENTRIES = 512;

const MANIFEST_NAME = 'manifest.json';

/* Per-character write serialization (chain lock, knowledgeStore pattern). */
const locks = new Map<string, Promise<unknown>>();
function withLock<T>(characterId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(characterId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(
    characterId,
    next.catch(() => undefined),
  );
  return next;
}

/**
 * Emotion mapping by expression NAME keywords, bilingual (zh/en) because the
 * VTuber-model ecosystem is overwhelmingly Chinese/Japanese-named. First
 * matching expression per emotion wins; expressions matching nothing (item
 * toggles like 帽/手机) stay importable but unmapped. Deliberately avoids
 * over-generic single characters (bare 心 would make 开心 read as love).
 */
const EMOTION_KEYWORDS: ReadonlyArray<readonly [AvatarEmotion, RegExp]> = [
  ['sad', /泪|哭|伤心|难过|悲|tear|cry|sad/i],
  ['shy', /害羞|脸红|红脸|羞|blush|shy|embarrass/i],
  ['angry', /生气|愤怒|黑脸|怒|angry|mad|rage|grr/i],
  ['love', /爱心|心眼|heart|love/i],
  ['excited', /星星|兴奋|激动|闪亮|star|sparkle|excited|wow/i],
  ['surprised', /吃惊|惊讶|惊|surprise|shock/i],
  ['happy', /开心|高兴|微笑|笑|喜|happy|smile|joy|grin/i],
];

/** Map available expression names onto the closed emotion set. Exported for
 * tests. */
export function mapEmotions(names: string[]): Partial<Record<AvatarEmotion, string>> {
  const out: Partial<Record<AvatarEmotion, string>> = {};
  for (const [emotion, re] of EMOTION_KEYWORDS) {
    const hit = names.find((n) => re.test(n));
    if (hit) out[emotion] = hit;
  }
  return out;
}

/**
 * Decode a zip entry name that lacks the UTF-8 flag. The bytes are cp437 per
 * the spec, but every real archive in this ecosystem is GBK (VTube Studio on
 * Chinese Windows) — try GBK first, fall back to latin1 so a weird name still
 * imports (the name only has to round-trip to disk and back, not be pretty).
 */
function decodeZipName(bytes: string[] | Uint8Array | Buffer): string {
  const u8 = Array.isArray(bytes)
    ? Uint8Array.from(bytes.map((c) => c.charCodeAt(0)))
    : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    return new TextDecoder('gbk', { fatal: true }).decode(u8);
  } catch {
    return new TextDecoder('latin1').decode(u8);
  }
}

/** Junk entries that must never be extracted. */
function isJunkEntry(rel: string): boolean {
  const parts = rel.split('/');
  return parts.some((p) => p === '__MACOSX' || p === '.DS_Store' || p.startsWith('._'));
}

/**
 * Sanitize one zip entry path: forward slashes, no absolute paths, no '..',
 * no empty segments, no Windows drive letters. Returns the clean relative
 * path or null when the entry must be rejected.
 */
export function sanitizeEntryPath(name: string): string | null {
  const norm = name.replace(/\\/g, '/');
  if (norm.startsWith('/') || /^[a-zA-Z]:/.test(norm)) return null;
  const parts = norm.split('/').filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  if (parts.some((p) => p === '..' || p === '.')) return null;
  return parts.join('/');
}

interface ExtractedFile {
  rel: string;
  bytes: Buffer;
}

/** Strip a single shared root directory (zips of a folder) so model paths
 * stay short; keeps paths as-is when files live at multiple roots. */
function stripCommonRoot(files: ExtractedFile[]): ExtractedFile[] {
  const roots = new Set(files.map((f) => f.rel.split('/')[0]));
  if (roots.size !== 1) return files;
  const root = [...roots][0];
  if (files.some((f) => !f.rel.includes('/'))) return files; // a file IS the root
  return files.map((f) => ({ ...f, rel: f.rel.slice(root.length + 1) }));
}

interface ModelSettings {
  Version?: number;
  FileReferences?: {
    Moc?: string;
    Textures?: string[];
    Physics?: string;
    Pose?: string;
    DisplayInfo?: string;
    Expressions?: Array<{ Name: string; File: string }>;
    [k: string]: unknown;
  };
  Groups?: Array<{ Target: string; Name: string; Ids: string[] }>;
  [k: string]: unknown;
}

/** Resolve a model3.json relative ref against the entry file's directory. */
function resolveRef(entryDir: string, ref: string): string {
  const joined = entryDir ? `${entryDir}/${ref}` : ref;
  // Normalize any './' the author wrote; '..' was already rejected per entry.
  return joined
    .split('/')
    .filter((p) => p.length > 0 && p !== '.')
    .join('/');
}

/**
 * Import a Live2D model zip for `characterId`. Extracts (with GBK filename
 * fallback), validates, normalizes and writes the model + manifest, replacing
 * any previous avatar. Throws Error with a human-readable message on any
 * validation failure; the previous avatar survives a failed import (the dir
 * is only replaced after the zip parsed and validated).
 */
export async function importAvatarZip(characterId: string, zip: Buffer): Promise<AvatarManifest> {
  if (zip.byteLength > AVATAR_ZIP_MAX_BYTES) {
    throw new Error(`avatar zip too large (${zip.byteLength} bytes)`);
  }
  const archive = await JSZip.loadAsync(zip, { decodeFileName: decodeZipName });

  // ── Extract into memory, sanitized + capped ─────────────────────────────
  const files: ExtractedFile[] = [];
  let total = 0;
  for (const entry of Object.values(archive.files)) {
    if (entry.dir) continue;
    const rel = sanitizeEntryPath(entry.name);
    if (!rel || isJunkEntry(rel)) continue;
    const bytes = Buffer.from(await entry.async('uint8array'));
    total += bytes.byteLength;
    if (total > AVATAR_EXTRACTED_MAX_BYTES) throw new Error('avatar zip expands too large');
    files.push({ rel, bytes });
    if (files.length > AVATAR_MAX_ENTRIES) throw new Error('avatar zip has too many files');
  }
  if (files.length === 0) throw new Error('avatar zip is empty');
  const stripped = stripCommonRoot(files);
  const byRel = new Map(stripped.map((f) => [f.rel, f]));

  // ── Locate + parse the model3.json ──────────────────────────────────────
  const candidates = stripped.filter((f) => f.rel.toLowerCase().endsWith('.model3.json'));
  let entryFile: ExtractedFile | null = null;
  let settings: ModelSettings | null = null;
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c.bytes.toString('utf8')) as ModelSettings;
      if (parsed?.FileReferences?.Moc) {
        entryFile = c;
        settings = parsed;
        break;
      }
    } catch {
      /* not the settings file */
    }
  }
  if (!entryFile || !settings?.FileReferences) {
    throw new Error('no .model3.json with a Moc reference found in the zip');
  }
  const entryDir = entryFile.rel.includes('/')
    ? entryFile.rel.slice(0, entryFile.rel.lastIndexOf('/'))
    : '';

  // ── Validate the referenced core files exist ────────────────────────────
  const refs = settings.FileReferences;
  const mocRel = resolveRef(entryDir, refs.Moc!);
  if (!byRel.has(mocRel)) throw new Error(`model references missing moc3 file: ${refs.Moc}`);
  for (const tex of refs.Textures ?? []) {
    if (!byRel.has(resolveRef(entryDir, tex))) {
      throw new Error(`model references missing texture: ${tex}`);
    }
  }

  // ── Normalize: register expressions + ensure EyeBlink group ─────────────
  const declared = new Map<string, string>(); // file rel → name
  for (const e of refs.Expressions ?? []) {
    if (e?.File && byRel.has(resolveRef(entryDir, e.File))) {
      declared.set(resolveRef(entryDir, e.File), e.Name || e.File);
    }
  }
  for (const f of stripped) {
    if (!f.rel.toLowerCase().endsWith('.exp3.json')) continue;
    if (declared.has(f.rel)) continue;
    // Only register expressions living beside (or under) the entry dir, and
    // name them by filename stem — the only name the author gave them.
    if (entryDir && !f.rel.startsWith(`${entryDir}/`)) continue;
    const base = f.rel.slice(f.rel.lastIndexOf('/') + 1);
    const name = base.replace(/\.exp3\.json$/i, '');
    declared.set(f.rel, name);
  }
  const relFromEntry = (rel: string): string =>
    entryDir && rel.startsWith(`${entryDir}/`) ? rel.slice(entryDir.length + 1) : rel;
  refs.Expressions = [...declared.entries()].map(([rel, name]) => ({
    Name: name,
    File: relFromEntry(rel),
  }));

  const groups = (settings.Groups ??= []);
  if (!groups.some((g) => g?.Target === 'Parameter' && g?.Name === 'EyeBlink')) {
    groups.push({ Target: 'Parameter', Name: 'EyeBlink', Ids: ['ParamEyeLOpen', 'ParamEyeROpen'] });
  }
  const normalized = Buffer.from(JSON.stringify(settings, null, '\t'), 'utf8');
  byRel.get(entryFile.rel)!.bytes = normalized;

  const expressions = [...declared.entries()].map(([rel, name]) => ({ name, file: rel }));
  const manifest: AvatarManifest = {
    version: 1,
    name: entryFile.rel
      .slice(entryFile.rel.lastIndexOf('/') + 1)
      .replace(/\.model3\.json$/i, ''),
    entry: entryFile.rel,
    importedAt: new Date().toISOString(),
    bytes: [...byRel.values()].reduce((n, f) => n + f.bytes.byteLength, 0),
    expressions,
    emotions: mapEmotions(expressions.map((e) => e.name)),
  };

  // ── Replace the avatar dir atomically-ish (validated before we wipe) ────
  return withLock(characterId, async () => {
    const dir = paths.avatarsDir(characterId);
    await rm(dir, { recursive: true, force: true });
    for (const f of byRel.values()) {
      const target = path.join(dir, ...f.rel.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, f.bytes);
    }
    // Manifest last: its presence is what "an avatar exists" means.
    await writeFile(path.join(dir, MANIFEST_NAME), JSON.stringify(manifest, null, 2), 'utf8');
    return manifest;
  });
}

/** The character's avatar manifest, or null when none is imported. */
export async function getAvatarManifest(characterId: string): Promise<AvatarManifest | null> {
  try {
    const raw = await readFile(path.join(paths.avatarsDir(characterId), MANIFEST_NAME), 'utf8');
    const parsed = JSON.parse(raw) as AvatarManifest;
    return parsed?.version === 1 && typeof parsed.entry === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/** Delete the character's imported avatar. Idempotent. */
export async function removeAvatar(characterId: string): Promise<void> {
  return withLock(characterId, async () => {
    await rm(paths.avatarsDir(characterId), { recursive: true, force: true });
  });
}

/**
 * The model bundle for the renderer's in-memory loader: every file under the
 * avatar dir except the manifest, as posix-relative paths + bytes.
 */
export async function readAvatarModelFiles(characterId: string): Promise<AvatarModelFile[]> {
  const dir = paths.avatarsDir(characterId);
  const out: AvatarModelFile[] = [];
  async function walk(sub: string): Promise<void> {
    const entries = await readdir(path.join(dir, sub), { withFileTypes: true });
    for (const e of entries) {
      const rel = sub ? `${sub}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(rel);
      else if (rel !== MANIFEST_NAME) {
        const abs = path.join(dir, ...rel.split('/'));
        const s = await stat(abs);
        if (s.isFile()) out.push({ path: rel, bytes: new Uint8Array(await readFile(abs)) });
      }
    }
  }
  try {
    await walk('');
  } catch {
    return [];
  }
  return out;
}
