/**
 * Dev pack store (261028, facepack pilot): reads baked packs from
 * SEI_FACEPACK_DIR. Nothing is bundled into the app yet (Shawn has not
 * decided bundle vs download, ~24 MB for the three defaults), so every read
 * returns empty while the dev flag is off.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FacepackDevInfo, FacepackInfo, FacepackManifest } from '../../shared/facepack';
import { isSafePackPath, packPalette } from '../../shared/facepack';
import type { FacePalette } from '../../bot/brain/faceExpressions.js';
import { facepackBaseUrl, facepackDir, facesEnabled } from './facepackDev';

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/i;

async function readManifestAt(dir: string): Promise<FacepackManifest | null> {
  try {
    const m = JSON.parse(await readFile(path.join(dir, 'facepack.json'), 'utf8')) as FacepackManifest;
    if (m?.format !== 'sei-facepack' || m.version !== 1 || !m.expressions || !Array.isArray(m.canvas)) return null;
    return m;
  } catch {
    return null;
  }
}

export async function listPacks(): Promise<FacepackInfo[]> {
  const root = facepackDir();
  if (!root) return [];
  let names: string[] = [];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const out: FacepackInfo[] = [];
  for (const id of names.sort()) {
    if (!ID_RE.test(id)) continue;
    const m = await readManifestAt(path.join(root, id));
    if (!m) continue;
    out.push({ id, character: m.character, bytes: m.bytes ?? 0, attribution: m.attribution ?? [] });
  }
  return out;
}

export async function facepackDevInfo(): Promise<FacepackDevInfo> {
  const enabled = facesEnabled() && facepackDir() !== null;
  return { enabled, packs: enabled ? await listPacks() : [], baseUrl: enabled ? facepackBaseUrl() : null };
}

export async function readPackManifest(id: string): Promise<FacepackManifest | null> {
  const root = facepackDir();
  if (!root || !ID_RE.test(id)) return null;
  return readManifestAt(path.join(root, id));
}

/** One pack file's bytes, or null (flag off, bad id/path, missing file). */
export async function readPackFile(id: string, rel: string): Promise<Uint8Array | null> {
  const root = facepackDir();
  if (!root || !ID_RE.test(id) || !isSafePackPath(rel)) return null;
  const packDir = path.join(root, id);
  const full = path.resolve(packDir, rel);
  if (!full.startsWith(packDir + path.sep)) return null;
  try {
    const s = await stat(full);
    if (!s.isFile() || s.size > 16 * 1024 * 1024) return null;
    return new Uint8Array(await readFile(full));
  } catch {
    return null;
  }
}

/**
 * The pack for a character, matched on the pack's `character` field or dir
 * name against the character's name (the three defaults: Sui, Lyra, Marv).
 */
export async function packIdForCharacterName(name: string): Promise<string | null> {
  const key = String(name ?? '').trim().toLowerCase();
  if (!key) return null;
  const packs = await listPacks();
  return packs.find((p) => p.character.toLowerCase() === key || p.id.toLowerCase() === key)?.id ?? null;
}

/**
 * The face palette for a character (261028): its pack's palette, or null when
 * the flag is off or the character has no pack (the FACE block then offers
 * the base 12). Read per turn; a pack is a small local JSON file.
 */
export async function facePaletteForCharacterName(name: string): Promise<FacePalette | null> {
  if (!facesEnabled()) return null;
  const id = await packIdForCharacterName(name);
  if (!id) return null;
  const m = await readPackManifest(id);
  return m ? packPalette(m) : null;
}
