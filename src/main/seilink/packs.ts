/**
 * SeiLink room art packs (261104, host pass). See src/shared/seilinkPack.ts
 * for the layout and the `sei-room://` URL shape.
 *
 * Where packs come from, first match wins:
 *   1. dev: SEI_SEILINK_PACKS=<dir> (unpackaged builds only, never read in a
 *      packaged app), e.g. the placeholder pack from
 *      scripts/seilink-dev-pack.mjs or the designer's pack dir;
 *   2. installed: <userData>/seilink/packs/<presetId>/ (filled by a download
 *      from dl.sei.gg later; see downloadPack, a stub for now).
 *
 * Trust: a pack is data from disk or the network. Before anything is served
 * or path-joined, the manifest is validated (parseRoomManifest: plain
 * relative .webp/.png paths only) AND every file it references is realpath'd
 * and must resolve inside the pack dir's own realpath (a symlink pointing
 * out is refused). One bad reference refuses the whole pack. The protocol
 * serves only files the manifest references, re-checking containment per
 * request, so a file swapped for a symlink after load is still refused.
 */
import { protocol, app } from 'electron';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseRoomManifest, isRoomPresetId } from '../../shared/seilinkValidate';
import type { RoomPresetId, RoomPresetManifest } from '../../shared/seilinkRoom';
import { SEILINK_ROOM_SCHEME, type SeilinkDevInfo, type SeilinkPack, type SeilinkPackSource } from '../../shared/seilinkPack';
import { paths } from '../paths';

/** Future download origin (dl.sei.gg mirrors release assets). Nothing fetches it yet. */
export const SEILINK_PACK_BASE_URL = 'https://dl.sei.gg/seilink/packs/';

const MANIFEST_NAME = 'manifest.json';
const MANIFEST_MAX_BYTES = 1024 * 1024;
/** Per file. A 2560x1440 webp frame is well under 2 MB. */
export const PACK_FILE_MAX_BYTES = 24 * 1024 * 1024;

export interface LoadedPack extends SeilinkPack {
  /** Realpath of the pack dir. */
  dir: string;
  /** Every file the manifest references: relative path -> realpath inside dir. */
  files: Map<string, string>;
}

// ── Roots ───────────────────────────────────────────────────────────────────

let rootsOverride: Array<{ dir: string; source: SeilinkPackSource }> | null = null;

function isUnpackaged(): boolean {
  try {
    // In vitest 'electron' is the npm stub, so `app` is undefined: packaged.
    return Boolean(app) && app.isPackaged === false;
  } catch {
    return false;
  }
}

/** The dev override dir, or null (packaged, or the variable is unset). */
export function seilinkDevPacksDir(): string | null {
  if (!isUnpackaged()) return null;
  const raw = process.env.SEI_SEILINK_PACKS?.trim();
  return raw ? path.resolve(raw) : null;
}

/** Dev flag: unpackaged with SEI_SEILINK_PACKS set. Gates the preview window. */
export function seilinkDevEnabled(): boolean {
  return seilinkDevPacksDir() !== null;
}

export function seilinkDevInfo(): SeilinkDevInfo {
  const dir = seilinkDevPacksDir();
  return { enabled: dir !== null, packsDir: dir };
}

function packRoots(): Array<{ dir: string; source: SeilinkPackSource }> {
  if (rootsOverride) return rootsOverride;
  const out: Array<{ dir: string; source: SeilinkPackSource }> = [];
  const dev = seilinkDevPacksDir();
  if (dev) out.push({ dir: dev, source: 'dev' });
  try {
    out.push({ dir: paths.seilinkPacksDir(), source: 'installed' });
  } catch {
    // No userData (tests without an override): installed packs simply absent.
  }
  return out;
}

/** Tests only. null restores the real roots. */
export function __setPackRootsForTest(roots: Array<{ dir: string; source: SeilinkPackSource }> | null): void {
  rootsOverride = roots;
  cache.clear();
}

// ── Containment ─────────────────────────────────────────────────────────────

/**
 * Realpath of `rel` under `realRoot` (itself a realpath), or null when it
 * escapes, is not a regular file, or is too big. `rel` must already be a
 * validated pack path (isSafeRoomPackPath); this is the second, filesystem
 * level check that catches symlinks.
 */
export async function containedFile(realRoot: string, rel: string): Promise<string | null> {
  try {
    const real = await realpath(path.resolve(realRoot, rel));
    if (!real.startsWith(realRoot + path.sep)) return null;
    const s = await stat(real);
    if (!s.isFile() || s.size > PACK_FILE_MAX_BYTES) return null;
    return real;
  } catch {
    return null;
  }
}

/** Every pack file a manifest names (frames, masks, glows). */
export function manifestFiles(m: RoomPresetManifest): string[] {
  const out = new Set<string>();
  for (const c of m.components) {
    for (const f of Object.values(c.frames)) {
      if (!f) continue;
      out.add(f.src);
      if (f.mask) out.add(f.mask);
      if (f.glow) out.add(f.glow);
    }
  }
  return [...out];
}

// ── Loading ─────────────────────────────────────────────────────────────────

const cache = new Map<string, { mtimeMs: number; manifestPath: string; pack: LoadedPack }>();

async function loadPackAt(dir: string, id: RoomPresetId, source: SeilinkPackSource): Promise<LoadedPack | null> {
  let realDir: string;
  try {
    realDir = await realpath(dir);
  } catch {
    return null;
  }
  const manifestPath = path.join(realDir, MANIFEST_NAME);
  let mtimeMs: number;
  try {
    const s = await stat(manifestPath);
    if (!s.isFile() || s.size > MANIFEST_MAX_BYTES) {
      console.warn(`[seilink] pack ${id}: manifest missing or too big`);
      return null;
    }
    mtimeMs = Math.floor(s.mtimeMs);
  } catch {
    return null;
  }
  const hit = cache.get(`${source}:${id}`);
  if (hit && hit.manifestPath === manifestPath && hit.mtimeMs === mtimeMs) return hit.pack;

  let manifest: RoomPresetManifest | null = null;
  try {
    manifest = parseRoomManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
  } catch (err) {
    console.warn(`[seilink] pack ${id}: unreadable manifest: ${(err as Error).message}`);
    return null;
  }
  if (!manifest) {
    console.warn(`[seilink] pack ${id}: manifest failed validation`);
    return null;
  }
  if (manifest.id !== id) {
    console.warn(`[seilink] pack ${id}: manifest id "${manifest.id}" does not match its dir`);
    return null;
  }
  const files = new Map<string, string>();
  for (const rel of manifestFiles(manifest)) {
    const real = await containedFile(realDir, rel);
    if (!real) {
      console.warn(`[seilink] pack ${id}: refused, "${rel}" is missing or outside the pack`);
      return null;
    }
    files.set(rel, real);
  }
  const pack: LoadedPack = { id, manifest, rev: mtimeMs, source, dir: realDir, files };
  cache.set(`${source}:${id}`, { mtimeMs, manifestPath, pack });
  return pack;
}

/** The pack for a preset (dev dir first), validated, or null when none is usable. */
export async function loadPack(id: string): Promise<LoadedPack | null> {
  if (!isRoomPresetId(id)) return null;
  for (const root of packRoots()) {
    const pack = await loadPackAt(path.join(root.dir, id), id, root.source);
    if (pack) return pack;
  }
  return null;
}

/** Every usable preset pack, one per preset. */
export async function listPacks(): Promise<LoadedPack[]> {
  const out: LoadedPack[] = [];
  for (const id of ['cozy', 'gamer', 'forest'] as const) {
    const p = await loadPack(id);
    if (p) out.push(p);
  }
  return out;
}

/** The renderer-facing view of a pack (no paths on disk). */
export function publicPack(p: LoadedPack): SeilinkPack {
  return { id: p.id, manifest: p.manifest, rev: p.rev, source: p.source };
}

/**
 * Download a preset's pack from SEILINK_PACK_BASE_URL into the installed
 * packs dir. Stub: packs ship by download later (a signed index, sha256 per
 * file, unpack to a temp dir, validate with loadPackAt, then rename into
 * place). Until then the dev dir is the only source.
 */
export async function downloadPack(id: RoomPresetId): Promise<never> {
  throw new Error(`SEILINK_DOWNLOAD_UNAVAILABLE: pack downloads are not built yet (${id})`);
}

// ── Protocol ────────────────────────────────────────────────────────────────

/** Privileges for registerSchemesAsPrivileged (index.ts registers every scheme in ONE call). */
export const SEILINK_SCHEME_PRIVILEGES = {
  scheme: SEILINK_ROOM_SCHEME,
  // fetch() + CORS so the renderer can read pixels back (mask conversion,
  // overlay colour sampling) from the dev http origin and the packaged one.
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
} as const;

const CONTENT_TYPES: Record<string, string> = { '.webp': 'image/webp', '.png': 'image/png' };

/** Resolve a sei-room:// URL to a file on disk, or null. Exported for tests. */
export async function resolveSeilinkUrl(url: string): Promise<{ file: string; type: string } | null> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== `${SEILINK_ROOM_SCHEME}:`) return null;
  const pack = await loadPack(u.hostname);
  if (!pack) return null;
  let rel: string;
  try {
    rel = u.pathname.replace(/^\//, '').split('/').map(decodeURIComponent).join('/');
  } catch {
    return null;
  }
  if (!pack.files.has(rel)) return null;
  // Re-check on disk: the file may have been replaced since the pack loaded.
  const real = await containedFile(pack.dir, rel);
  if (!real) return null;
  return { file: real, type: CONTENT_TYPES[path.extname(real).toLowerCase()] ?? 'application/octet-stream' };
}

/** Attach the sei-room:// handler. After app 'ready'. */
export function registerSeilinkProtocol(): void {
  protocol.handle(SEILINK_ROOM_SCHEME, async (request) => {
    const headers = { 'Access-Control-Allow-Origin': '*' };
    const hit = await resolveSeilinkUrl(request.url);
    if (!hit) return new Response('not found', { status: 404, headers });
    try {
      const bytes = await readFile(hit.file);
      return new Response(new Uint8Array(bytes), {
        status: 200,
        // The URL carries ?v=<rev>, so a pack update is a new URL.
        headers: { ...headers, 'Content-Type': hit.type, 'Cache-Control': 'max-age=31536000, immutable' },
      });
    } catch {
      return new Response('not found', { status: 404, headers });
    }
  });
}
