/**
 * Per-character Live2D avatar store (260804).
 *
 * A user-imported Live2D Cubism model (moc3 + model3.json + textures +
 * expressions + physics), extracted from a zip into
 * `<profileRoot>/avatars/<characterId>/` next to a `manifest.json`. Outside
 * memoryDir (knowledge precedent) so "Reset memory" never touches it; a full
 * character delete / remove-from-library takes it (characterStore, ipc).
 *
 * Nothing here rides `character.metadata`. Since 261106 the avatar library
 * (main/avatarLibrary/) keeps this store in step with the server: the owner's
 * imports are uploaded (zipStoredAvatar), other users' apps download the
 * character's public model into it (manifest.library records the link).
 *
 * Import NORMALIZES the stored model, because real-world VTuber exports are
 * sloppy in three specific ways (all measured on the first test model):
 *   1. `.exp3.json` expression files ship in the zip but are NOT referenced in
 *      `FileReferences.Expressions` — the renderer's loader only knows what
 *      the settings file names, so unreferenced expressions would not exist.
 *   2. The `EyeBlink` parameter group can be missing, which silently disables
 *      the SDK's automatic blink on a motionless model.
 *   3. Filenames are Chinese with spaces ("【雪熊企划】雪熊少女.moc3",
 *      "1 帽.exp3.json"). pixi-live2d-display's FileLoader compares
 *      `encodeURI(webkitRelativePath)` against the RAW refs resolved from the
 *      settings JSON, so ANY name encodeURI changes (non-ASCII, spaces) fails
 *      its existence check and the model refuses to load. Measured live: the
 *      moc3 itself "doesn't exist in given files". So every stored path is
 *      renamed to an ASCII-safe slug and all refs are rewritten to match.
 *      Display names (manifest.name, expression Names) keep the originals.
 * The stored copy is ours, so we fix all three at import time and the renderer
 * loader stays dumb. `getAvatarManifest` lazily re-runs the same normalization
 * on a version-1 store (imported before the rename existed) so early imports
 * heal in place.
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { paths } from '../paths';
import { avatarImageProblem, MAX_TEXTURE_SIDE, sniffAvatarImage, type ImageProblem } from './avatarImage';
import type {
  AvatarEmotion,
  AvatarManifest,
  AvatarModelFile,
  AvatarRigLayer,
  AvatarRigSpec,
} from '../../shared/ipc';

/** Cap for the zip itself (a full VTuber model with 4k textures is ~20 MB).
 * The same as the avatar library proxy's zip cap, so every model this store
 * takes can also be uploaded. */
export const AVATAR_ZIP_MAX_BYTES = 64 * 1024 * 1024;
/** Cap on total EXTRACTED bytes (zip-bomb guard). */
export const AVATAR_EXTRACTED_MAX_BYTES = 256 * 1024 * 1024;
/** Cap on extracted entry count. */
export const AVATAR_MAX_ENTRIES = 512;
/** One extracted file at most (the avatar library proxy's per-entry cap). */
export const AVATAR_ENTRY_MAX_BYTES = 64 * 1024 * 1024;

const MANIFEST_NAME = 'manifest.json';
/** v2 = paths renamed ASCII-safe (v1 stores are lazily re-normalized). */
export const MANIFEST_VERSION = 2;

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

/** Sanitize one path segment to [A-Za-z0-9._-]: everything else (runs of it)
 * becomes a single '_'. Leading dots are stripped so no name goes hidden. */
function safeSegment(seg: string): string {
  const cleaned = seg.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '');
  return cleaned.length > 0 ? cleaned : '_';
}

/**
 * Map every stored path to an ASCII-safe equivalent, consistently per
 * directory (the same original dir always maps to the same safe dir) and
 * collision-free per parent ("雪熊.png" and "企划.png" both slug to "_.png";
 * the second becomes "_-2.png"). Exported for tests.
 */
export function buildSafePathMap(rels: string[]): Map<string, string> {
  const map = new Map<string, string>();
  // Keyed by ORIGINAL parent path: children of the same original dir dedupe
  // against each other; distinct original dirs are themselves deduped a level
  // up, so their children can never meet.
  const perDir = new Map<string, { bySeg: Map<string, string>; used: Set<string> }>();
  for (const rel of [...rels].sort()) {
    const segs = rel.split('/');
    let parent = '';
    const safeSegs: string[] = [];
    for (const seg of segs) {
      let dir = perDir.get(parent);
      if (!dir) {
        dir = { bySeg: new Map(), used: new Set() };
        perDir.set(parent, dir);
      }
      let safe = dir.bySeg.get(seg);
      if (!safe) {
        const base = safeSegment(seg);
        safe = base;
        if (dir.used.has(safe)) {
          const dot = base.indexOf('.');
          const stem = dot === -1 ? base : base.slice(0, dot);
          const rest = dot === -1 ? '' : base.slice(dot);
          for (let n = 2; dir.used.has(safe); n++) safe = `${stem}-${n}${rest}`;
        }
        dir.used.add(safe);
        dir.bySeg.set(seg, safe);
      }
      safeSegs.push(safe);
      parent = parent ? `${parent}/${seg}` : seg;
    }
    map.set(rel, safeSegs.join('/'));
  }
  return map;
}

/**
 * Parse + validate a rig.json (260817): the entry file of a simple layered
 * rig avatar (aligned PNG layers + blink/talk patches, the chibi-rig pipeline
 * output). Throws with a readable message on any shape problem. Exported for
 * tests.
 */
export function parseRigSpec(raw: unknown): AvatarRigSpec {
  if (typeof raw !== 'object' || raw === null) throw new Error('rig.json is not an object');
  const spec = raw as Record<string, unknown>;
  const canvas = spec.canvas;
  if (
    !Array.isArray(canvas) ||
    canvas.length !== 2 ||
    !canvas.every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0)
  ) {
    throw new Error('rig.json canvas must be [width, height]');
  }
  if (!Array.isArray(spec.layers) || spec.layers.length === 0) {
    throw new Error('rig.json has no layers');
  }
  const seen = new Set<string>();
  const layers: AvatarRigLayer[] = spec.layers.map((l, i) => {
    if (typeof l !== 'object' || l === null) throw new Error(`layer ${i} is not an object`);
    const layer = l as Record<string, unknown>;
    const id = layer.id;
    if (typeof id !== 'string' || id.length === 0) throw new Error(`layer ${i} has no id`);
    if (seen.has(id)) throw new Error(`duplicate layer id: ${id}`);
    seen.add(id);
    if (typeof layer.z !== 'number' || !Number.isFinite(layer.z)) {
      throw new Error(`layer ${id} has no z order`);
    }
    const out: AvatarRigLayer = { id, z: layer.z };
    if (typeof layer.src === 'string' && layer.src.length > 0) out.src = layer.src;
    const states = layer.states as Record<string, unknown> | undefined;
    if (states && typeof states === 'object') {
      if (typeof states.open !== 'string' || typeof states.closed !== 'string') {
        throw new Error(`layer ${id} states need open + closed image paths`);
      }
      out.states = { open: states.open, closed: states.closed };
      const box = layer.box;
      if (
        !Array.isArray(box) ||
        box.length !== 4 ||
        !box.every((n) => typeof n === 'number' && Number.isFinite(n))
      ) {
        throw new Error(`layer ${id} has states but no [x0,y0,x1,y1] box`);
      }
      out.box = box as [number, number, number, number];
    }
    if (!out.src && !out.states) throw new Error(`layer ${id} has neither src nor states`);
    if (typeof layer.group === 'string') out.group = layer.group;
    if (typeof layer.sway === 'number' && Number.isFinite(layer.sway)) out.sway = layer.sway;
    const physics = layer.physics as Record<string, unknown> | undefined;
    if (physics && typeof physics === 'object') {
      if (
        typeof physics.k !== 'number' ||
        typeof physics.c !== 'number' ||
        !(physics.k > 0) ||
        !(physics.c >= 0)
      ) {
        throw new Error(`layer ${id} physics needs k > 0 and c >= 0`);
      }
      out.physics = { k: physics.k, c: physics.c };
    }
    return out;
  });
  const out: AvatarRigSpec = { canvas: [canvas[0], canvas[1]], layers };
  if (typeof spec.version === 'number') out.version = spec.version;
  if (typeof spec.name === 'string' && spec.name.length > 0) out.name = spec.name;
  return out;
}

/** Every image path a rig spec references, in declaration order. */
/**
 * The image types an avatar may hold (261106): PNG, JPEG, WebP by magic
 * bytes, static and at most MAX_TEXTURE_SIDE px (avatarImage.ts). Exactly
 * what the avatar library proxy moderates, so whatever this store holds can
 * be uploaded and checked.
 */
export { sniffAvatarImage };

/** Names that look like images (the proxy refuses a zip where one is not a real PNG/JPEG/WebP). */
const IMAGE_NAME_RE = /\.(png|jpe?g|webp|gif|bmp|tiff?|avif|heic|heif|ico)$/i;

/** GIF / TIFF / BMP / ICO / AVIF / HEIC by magic bytes: images nobody moderates (the proxy refuses them). */
function isUnsupportedImage(b: Uint8Array): boolean {
  if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return true;
  if (b.length >= 4 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 0x2a))) return true;
  if (b.length >= 26 && b[0] === 0x42 && b[1] === 0x4d && [12, 40, 52, 56, 64, 108, 124].includes(b[14]! | (b[15]! << 8))) return true;
  if (b.length >= 6 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0 && (b[4]! | (b[5]! << 8)) > 0) return true;
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    return /^(avif|avis|heic|heix|hevc|heim|heis|mif1|msf1)$/.test(Buffer.from(b.subarray(8, 12)).toString('latin1'));
  }
  return false;
}

function rigImageRefs(spec: AvatarRigSpec): string[] {
  const refs: string[] = [];
  for (const l of spec.layers) {
    if (l.src) refs.push(l.src);
    if (l.states) refs.push(l.states.open, l.states.closed);
  }
  return refs;
}

/** Why a referenced image was left out by the image rules, or null. */
function refusedMessage(problem: ImageProblem | undefined, ref: string): string | null {
  if (problem === 'animated_image') return `model image is animated (APNG or animated WebP): ${ref}`;
  if (problem === 'image_too_large') return `model image is larger than ${MAX_TEXTURE_SIDE} px: ${ref}`;
  if (problem === 'bad_image') return `model image is not a readable PNG, JPEG or WebP: ${ref}`;
  return null;
}

/** Replace the avatar dir with the given file set + manifest. Shared tail of
 * both normalize paths; the manifest goes last — its presence is what "an
 * avatar exists" means. */
async function replaceStore(
  characterId: string,
  byRel: Map<string, ExtractedFile>,
  safe: (rel: string) => string,
  manifest: AvatarManifest,
): Promise<AvatarManifest> {
  const dir = paths.avatarsDir(characterId);
  await rm(dir, { recursive: true, force: true });
  for (const [rel, f] of byRel) {
    const target = path.join(dir, ...safe(rel).split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, f.bytes);
  }
  await writeFile(path.join(dir, MANIFEST_NAME), JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}

/**
 * Normalize + write a simple rig store (260817). Same contract as the Cubism
 * path: validates every referenced image exists, renames stored paths
 * ASCII-safe and rewrites the spec's refs to match.
 */
async function normalizeRigAndWrite(
  characterId: string,
  entryFile: ExtractedFile,
  byRel: Map<string, ExtractedFile>,
  refused: Map<string, ImageProblem>,
): Promise<AvatarManifest> {
  const spec = parseRigSpec(JSON.parse(entryFile.bytes.toString('utf8')));
  const entryDir = entryFile.rel.includes('/')
    ? entryFile.rel.slice(0, entryFile.rel.lastIndexOf('/'))
    : '';
  for (const ref of rigImageRefs(spec)) {
    const rel = resolveRef(entryDir, ref);
    const f = byRel.get(rel);
    if (!f) throw new Error(refusedMessage(refused.get(rel), ref) ?? `rig.json references missing image: ${ref}`);
    if (!sniffAvatarImage(f.bytes)) throw new Error(`rig.json image is not a PNG, JPEG or WebP: ${ref}`);
  }

  const safeMap = buildSafePathMap([...byRel.keys()]);
  const safe = (rel: string): string => safeMap.get(rel) ?? rel;
  const safeEntry = safe(entryFile.rel);
  const safeEntryDir = safeEntry.includes('/')
    ? safeEntry.slice(0, safeEntry.lastIndexOf('/'))
    : '';
  const reRef = (ref: string): string => {
    const mapped = safeMap.get(resolveRef(entryDir, ref));
    if (!mapped) return ref;
    return safeEntryDir && mapped.startsWith(`${safeEntryDir}/`)
      ? mapped.slice(safeEntryDir.length + 1)
      : mapped;
  };
  for (const l of spec.layers) {
    if (l.src) l.src = reRef(l.src);
    if (l.states) l.states = { open: reRef(l.states.open), closed: reRef(l.states.closed) };
  }
  entryFile.bytes = Buffer.from(JSON.stringify(spec, null, '\t'), 'utf8');

  const manifest: AvatarManifest = {
    version: MANIFEST_VERSION,
    kind: 'rig',
    name: spec.name ?? (entryDir ? entryDir.slice(entryDir.lastIndexOf('/') + 1) : 'Rig'),
    entry: safeEntry,
    importedAt: new Date().toISOString(),
    bytes: [...byRel.values()].reduce((n, f) => n + f.bytes.byteLength, 0),
    expressions: [],
    emotions: {},
  };
  return replaceStore(characterId, byRel, safe, manifest);
}

/**
 * Validate + normalize an extracted (or previously stored) file set and write
 * it as `characterId`'s avatar. Does NOT take the per-character lock — every
 * caller wraps it (a nested chain-lock acquisition would deadlock).
 */
async function normalizeAndWrite(
  characterId: string,
  incoming: ExtractedFile[],
  /** Accessory toggles to carry over (the v1→v2 heal path; a fresh import
   * starts clean — a new model's expression names owe it nothing). */
  keepAccessories?: Record<string, boolean>,
  /** A fresh import applies the image rules (avatarImage.ts); the v1 heal of
   * a store already on disk does not (it keeps rendering what it had). */
  imageRules = false,
): Promise<AvatarManifest> {
  const all = stripCommonRoot(incoming);
  // Animated or oversized images are left out like unsupported ones; a model
  // that references one fails with that reason.
  const refused = new Map<string, ImageProblem>();
  const stripped = imageRules
    ? all.filter((f) => {
        if (!sniffAvatarImage(f.bytes)) return true;
        const problem = avatarImageProblem(f.bytes, MAX_TEXTURE_SIDE);
        if (problem) refused.set(f.rel, problem);
        return !problem;
      })
    : all;
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
    // Not a Cubism zip — a simple rig zip instead (260817)? The shallowest
    // rig.json wins, mirroring the model3.json candidate walk.
    const rigEntry = stripped
      .filter((f) => (f.rel.split('/').pop() ?? '') === 'rig.json')
      .sort((a, b) => a.rel.split('/').length - b.rel.split('/').length)[0];
    if (rigEntry) return normalizeRigAndWrite(characterId, rigEntry, byRel, refused);
    throw new Error('no .model3.json with a Moc reference (and no rig.json) found in the zip');
  }
  const entryDir = entryFile.rel.includes('/')
    ? entryFile.rel.slice(0, entryFile.rel.lastIndexOf('/'))
    : '';

  // ── Validate the referenced core files exist ────────────────────────────
  const refs = settings.FileReferences;
  const mocRel = resolveRef(entryDir, refs.Moc!);
  if (!byRel.has(mocRel)) throw new Error(`model references missing moc3 file: ${refs.Moc}`);
  if (refs.Textures !== undefined && !Array.isArray(refs.Textures)) throw new Error('model Textures is not a list');
  for (const tex of refs.Textures ?? []) {
    const rel = typeof tex === 'string' ? resolveRef(entryDir, tex) : '';
    const f = rel ? byRel.get(rel) : undefined;
    if (!f) throw new Error(refusedMessage(refused.get(rel), String(tex)) ?? `model references missing texture: ${String(tex)}`);
    if (!sniffAvatarImage(f.bytes)) throw new Error(`model texture is not a PNG, JPEG or WebP: ${tex}`);
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

  const groups = (settings.Groups ??= []);
  if (!groups.some((g) => g?.Target === 'Parameter' && g?.Name === 'EyeBlink')) {
    groups.push({ Target: 'Parameter', Name: 'EyeBlink', Ids: ['ParamEyeLOpen', 'ParamEyeROpen'] });
  }

  // ── Rename to ASCII-safe paths + rewrite every ref to match ─────────────
  const safeMap = buildSafePathMap([...byRel.keys()]);
  const safe = (rel: string): string => safeMap.get(rel) ?? rel;
  const safeEntry = safe(entryFile.rel);
  const safeEntryDir = safeEntry.includes('/')
    ? safeEntry.slice(0, safeEntry.lastIndexOf('/'))
    : '';
  const fromSafeEntry = (safeRel: string): string =>
    safeEntryDir && safeRel.startsWith(`${safeEntryDir}/`)
      ? safeRel.slice(safeEntryDir.length + 1)
      : safeRel;
  /** Rewrite one settings ref (relative to the entry) onto the safe tree.
   * A ref to a file that does not exist is left as-is — the loader treats
   * optional refs as absent either way. */
  const reRef = (ref: string | undefined): string | undefined => {
    if (typeof ref !== 'string' || ref.length === 0) return ref;
    const mapped = safeMap.get(resolveRef(entryDir, ref));
    return mapped ? fromSafeEntry(mapped) : ref;
  };

  refs.Moc = reRef(refs.Moc);
  if (refs.Textures) refs.Textures = refs.Textures.map((t) => reRef(t)!);
  refs.Physics = reRef(refs.Physics);
  refs.Pose = reRef(refs.Pose);
  refs.DisplayInfo = reRef(refs.DisplayInfo);
  if (typeof refs.UserData === 'string') refs.UserData = reRef(refs.UserData);
  refs.Expressions = [...declared.entries()].map(([rel, name]) => ({
    Name: name,
    File: fromSafeEntry(safe(rel)),
  }));
  const motions = refs.Motions as
    | Record<string, Array<{ File?: string; Sound?: string; [k: string]: unknown }>>
    | undefined;
  if (motions && typeof motions === 'object') {
    for (const group of Object.values(motions)) {
      if (!Array.isArray(group)) continue;
      for (const m of group) {
        if (m && typeof m === 'object') {
          m.File = reRef(m.File);
          m.Sound = reRef(m.Sound);
        }
      }
    }
  }

  const normalized = Buffer.from(JSON.stringify(settings, null, '\t'), 'utf8');
  byRel.get(entryFile.rel)!.bytes = normalized;

  const expressions = [...declared.entries()].map(([rel, name]) => ({ name, file: safe(rel) }));
  const manifest: AvatarManifest = {
    version: MANIFEST_VERSION,
    // Display name keeps the author's original (pretty) filename stem.
    name: entryFile.rel.slice(entryFile.rel.lastIndexOf('/') + 1).replace(/\.model3\.json$/i, ''),
    entry: safeEntry,
    importedAt: new Date().toISOString(),
    bytes: [...byRel.values()].reduce((n, f) => n + f.bytes.byteLength, 0),
    expressions,
    emotions: mapEmotions(expressions.map((e) => e.name)),
  };
  if (keepAccessories) {
    // Keep only toggles whose expression still exists after renormalizing.
    const names = new Set(expressions.map((e) => e.name));
    const kept = Object.fromEntries(
      Object.entries(keepAccessories).filter(([name, on]) => on && names.has(name)),
    );
    if (Object.keys(kept).length > 0) manifest.accessories = kept;
  }

  // ── Replace the avatar dir atomically-ish (validated before we wipe) ────
  return replaceStore(characterId, byRel, safe, manifest);
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

  // ── Check every declared size BEFORE inflating anything (a 1 MB zip can
  // declare, and inflate to, a gigabyte) ────────────────────────────────────
  const wanted: Array<{ rel: string; entry: JSZip.JSZipObject; size: number }> = [];
  let declaredTotal = 0;
  for (const entry of Object.values(archive.files)) {
    if (entry.dir) continue;
    const rel = sanitizeEntryPath(entry.name);
    if (!rel || isJunkEntry(rel)) continue;
    const size = declaredSize(entry);
    if (size > AVATAR_ENTRY_MAX_BYTES) throw new Error('avatar zip has a file that is too large');
    declaredTotal += size;
    if (declaredTotal > AVATAR_EXTRACTED_MAX_BYTES) throw new Error('avatar zip expands too large');
    wanted.push({ rel, entry, size });
    if (wanted.length > AVATAR_MAX_ENTRIES) throw new Error('avatar zip has too many files');
  }

  // ── Extract into memory, each entry capped at its declared size ─────────
  const files: ExtractedFile[] = [];
  for (const w of wanted) {
    const bytes = await readEntryCapped(w.entry, w.size);
    // Images only as PNG/JPEG/WebP (what the avatar library moderates). A
    // model's textures and rig layers are checked by name in normalize; any
    // other unusable image (a GIF preview, a broken thumbnail) is left out.
    if (!sniffAvatarImage(bytes) && (isUnsupportedImage(bytes) || IMAGE_NAME_RE.test(w.rel))) continue;
    files.push({ rel: w.rel, bytes });
  }
  if (files.length === 0) throw new Error('avatar zip is empty');

  return withLock(characterId, () => normalizeAndWrite(characterId, files, undefined, true));
}

/** An entry's uncompressed size as its central directory declares it. */
function declaredSize(entry: JSZip.JSZipObject): number {
  const n = (entry as unknown as { _data?: { uncompressedSize?: unknown } })._data?.uncompressedSize;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) throw new Error('avatar zip entry has no size');
  return n;
}

interface EntryStream {
  on(event: 'data', cb: (chunk: Uint8Array) => void): EntryStream;
  on(event: 'error', cb: (err: unknown) => void): EntryStream;
  on(event: 'end', cb: () => void): EntryStream;
  resume(): EntryStream;
  pause(): EntryStream;
}

/**
 * Inflate one entry chunk by chunk and stop the moment it passes `size`
 * bytes (its declared size): a lying header never gets to allocate more.
 * The result must be exactly `size` bytes.
 */
export function readEntryCapped(entry: JSZip.JSZipObject, size: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    let settled = false;
    const finish = (err: Error | null): void => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(Buffer.concat(chunks, total));
    };
    let stream: EntryStream;
    try {
      stream = (entry as unknown as { internalStream(type: 'uint8array'): EntryStream }).internalStream('uint8array');
    } catch (err) {
      finish(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    stream
      .on('data', (chunk) => {
        if (settled) return;
        total += chunk.byteLength;
        if (total > size) {
          stream.pause();
          finish(new Error('avatar zip file expands past its declared size'));
          return;
        }
        chunks.push(chunk);
      })
      .on('error', (err) => finish(err instanceof Error ? err : new Error(String(err))))
      .on('end', () => finish(total === size ? null : new Error('avatar zip file is not its declared size')))
      .resume();
  });
}

/** Read the stored avatar tree back as ExtractedFiles (manifest excluded). */
async function readStoredFiles(characterId: string): Promise<ExtractedFile[]> {
  const dir = paths.avatarsDir(characterId);
  const out: ExtractedFile[] = [];
  async function walk(sub: string): Promise<void> {
    const entries = await readdir(path.join(dir, sub), { withFileTypes: true });
    for (const e of entries) {
      const rel = sub ? `${sub}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(rel);
      else if (rel !== MANIFEST_NAME) out.push({ rel, bytes: await readFile(path.join(dir, ...rel.split('/'))) });
    }
  }
  await walk('');
  return out;
}

/**
 * The character's avatar manifest, or null when none is imported. A version-1
 * store (imported before the ASCII-safe rename existed) is re-normalized in
 * place — same pipeline as import, run over the stored tree — so it heals to
 * version 2 the first time anything asks for it.
 */
export async function getAvatarManifest(characterId: string): Promise<AvatarManifest | null> {
  let parsed: AvatarManifest;
  try {
    const raw = await readFile(path.join(paths.avatarsDir(characterId), MANIFEST_NAME), 'utf8');
    parsed = JSON.parse(raw) as AvatarManifest;
  } catch {
    return null;
  }
  if (typeof parsed?.entry !== 'string') return null;
  if (parsed.version === MANIFEST_VERSION) return parsed;
  if (parsed.version !== 1) return null;
  try {
    return await withLock(characterId, async () =>
      normalizeAndWrite(characterId, await readStoredFiles(characterId), parsed.accessories),
    );
  } catch {
    // A store too broken to renormalize is a store that cannot render either.
    return null;
  }
}

/**
 * Flip a persistent accessory toggle (260806): `name` must be one of the
 * manifest's expression names. Returns the updated manifest, or null when the
 * character has no imported avatar. The record stays sparse — turning a
 * toggle off removes its entry.
 */
export async function setAvatarAccessory(
  characterId: string,
  name: string,
  on: boolean,
): Promise<AvatarManifest | null> {
  const manifest = await getAvatarManifest(characterId);
  if (!manifest) return null;
  if (!manifest.expressions.some((e) => e.name === name)) return manifest;
  return withLock(characterId, async () => {
    const accessories = { ...(manifest.accessories ?? {}) };
    if (on) accessories[name] = true;
    else delete accessories[name];
    const next: AvatarManifest = { ...manifest };
    if (Object.keys(accessories).length > 0) next.accessories = accessories;
    else delete next.accessories;
    await writeFile(
      path.join(paths.avatarsDir(characterId), MANIFEST_NAME),
      JSON.stringify(next, null, 2),
      'utf8',
    );
    return next;
  });
}

/**
 * Record (or clear) the avatar library link (261106): this stored model is the
 * server avatar `link.avatarId`. Returns the updated manifest, or null when
 * the character has no imported avatar.
 */
export async function setAvatarLibraryLink(
  characterId: string,
  link: { avatarId: string; rev: string } | null,
): Promise<AvatarManifest | null> {
  // Heal a v1 store first (it takes the lock itself), then read the manifest
  // again INSIDE the lock, so an import that lands meanwhile is never
  // overwritten with the old manifest.
  if (!(await getAvatarManifest(characterId))) return null;
  return withLock(characterId, async () => {
    let manifest: AvatarManifest;
    try {
      manifest = JSON.parse(await readFile(path.join(paths.avatarsDir(characterId), MANIFEST_NAME), 'utf8')) as AvatarManifest;
    } catch {
      return null;
    }
    if (typeof manifest?.entry !== 'string' || manifest.version !== MANIFEST_VERSION) return null;
    const next: AvatarManifest = { ...manifest };
    if (link) next.library = { avatarId: link.avatarId, rev: link.rev };
    else delete next.library;
    await writeFile(path.join(paths.avatarsDir(characterId), MANIFEST_NAME), JSON.stringify(next, null, 2), 'utf8');
    return next;
  });
}

/** Fixed entry date for zipStoredAvatar, so the same files always give the same bytes. */
const STABLE_ZIP_DATE = new Date(Date.UTC(2000, 0, 1, 0, 0, 0));
const STORED_EXT_RE = /\.(png|jpe?g|webp)$/i;

/**
 * Pack the stored model back into a zip for the avatar library upload
 * (261106): files in sorted order with a fixed date, images stored and
 * everything else deflated, so the same store always hashes the same (the
 * upload happens once per hash). The manifest is not included (it is ours,
 * rebuilt by the import on the other side). Null when nothing is stored.
 */
export async function zipStoredAvatar(characterId: string): Promise<Buffer | null> {
  const manifest = await getAvatarManifest(characterId);
  if (!manifest) return null;
  const files = await withLock(characterId, () => readStoredFiles(characterId));
  if (files.length === 0) return null;
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const zip = new JSZip();
  for (const f of files) {
    zip.file(f.rel, f.bytes, {
      date: STABLE_ZIP_DATE,
      compression: STORED_EXT_RE.test(f.rel) ? 'STORE' : 'DEFLATE',
      compressionOptions: { level: 6 },
    });
  }
  return zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' });
}

/** Delete the character's imported avatar. Idempotent. */
export async function removeAvatar(characterId: string): Promise<void> {
  return withLock(characterId, async () => {
    await rm(paths.avatarsDir(characterId), { recursive: true, force: true });
  });
}

/**
 * Where the model bundle's files are: every file under the avatar dir except
 * the manifest, as posix-relative paths + absolute files. The SeiLink room
 * host reads them itself (seilink/host/avatarRelay.ts).
 */
export async function listAvatarModelFiles(characterId: string): Promise<Array<{ path: string; file: string }>> {
  const dir = paths.avatarsDir(characterId);
  const out: Array<{ path: string; file: string }> = [];
  async function walk(sub: string): Promise<void> {
    const entries = await readdir(path.join(dir, sub), { withFileTypes: true });
    for (const e of entries) {
      const rel = sub ? `${sub}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(rel);
      else if (rel !== MANIFEST_NAME) {
        const abs = path.join(dir, ...rel.split('/'));
        const s = await stat(abs);
        if (s.isFile()) out.push({ path: rel, file: abs });
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

/**
 * The model bundle for the renderer's in-memory loader: every file under the
 * avatar dir except the manifest, as posix-relative paths + bytes.
 */
export async function readAvatarModelFiles(characterId: string): Promise<AvatarModelFile[]> {
  const out: AvatarModelFile[] = [];
  try {
    for (const f of await listAvatarModelFiles(characterId)) out.push({ path: f.path, bytes: new Uint8Array(await readFile(f.file)) });
  } catch {
    return [];
  }
  return out;
}
