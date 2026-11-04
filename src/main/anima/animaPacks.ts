/**
 * Anima pack store (261105): downloaded face sets on disk.
 *
 *   <root>/packs/<an-id>/facepack.json + frames   (an extracted pack.zip)
 *   <root>/index.json                              which character uses which pack
 *
 * The root is paths.animaDir() in the app (device-global). A pack is
 * installed from the archive the proxy signed for us: its sha256 must match
 * what the proxy said, every entry must be a safe pack path, and the result
 * must hold a readable sei-facepack v1 manifest. Extraction goes to a temp
 * dir that is renamed into place, so a half-written pack is never visible.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import type { FacepackManifest } from '../../shared/facepack';
import { isSafePackPath } from '../../shared/facepack';
import { ANIMA_PACK_ID_RE, animaPackId, isAnimaPackId } from '../../shared/anima';

/** One pack file (facepackStore's read limit). */
export const ANIMA_FILE_MAX_BYTES = 16 * 1024 * 1024;
/** A whole extracted pack (a THA3 pack is ~12 MB). */
export const ANIMA_PACK_MAX_BYTES = 80 * 1024 * 1024;
export const ANIMA_PACK_MAX_FILES = 4000;

export interface AnimaIndexEntry {
  /** sha256 of the pack.zip it came from (the pack id is derived from it). */
  pack_sha256: string;
  /** The portrait the pack was baked from (proxy's hash). */
  portrait_hash: string | null;
  /** Her local portrait ref when it was last checked (portrait_image|cloud_updated_at). */
  portrait_ref: string | null;
  /** Last time the proxy was asked about her (ms). */
  checked_at: number;
}

interface AnimaIndex {
  version: 1;
  characters: Record<string, AnimaIndexEntry>;
}

export class AnimaPackError extends Error {
  constructor(public readonly code: 'hash_mismatch' | 'bad_archive' | 'bad_entry' | 'too_big' | 'no_manifest') {
    super(code);
    this.name = 'AnimaPackError';
  }
}

const SHA_RE = /^[0-9a-f]{64}$/;
const CHAR_ID_RE = /^[0-9a-z_-]{1,64}$/i;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function isFacepackManifest(m: unknown): m is FacepackManifest {
  const v = m as FacepackManifest | null;
  return !!v && v.format === 'sei-facepack' && v.version === 1 && !!v.expressions && Array.isArray(v.canvas);
}

export class AnimaPackStore {
  private index: AnimaIndex | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly root: () => string) {}

  packsDir(): string {
    return path.join(this.root(), 'packs');
  }

  packDir(id: string): string | null {
    return isAnimaPackId(id) ? path.join(this.packsDir(), id) : null;
  }

  private indexPath(): string {
    return path.join(this.root(), 'index.json');
  }

  private async loadIndex(): Promise<AnimaIndex> {
    if (this.index) return this.index;
    let out: AnimaIndex = { version: 1, characters: {} };
    try {
      const raw = JSON.parse(await readFile(this.indexPath(), 'utf8')) as Partial<AnimaIndex>;
      if (raw?.version === 1 && raw.characters && typeof raw.characters === 'object') {
        for (const [id, e] of Object.entries(raw.characters)) {
          if (CHAR_ID_RE.test(id) && e && SHA_RE.test(String(e.pack_sha256))) {
            out.characters[id] = {
              pack_sha256: e.pack_sha256,
              portrait_hash: typeof e.portrait_hash === 'string' ? e.portrait_hash : null,
              portrait_ref: typeof e.portrait_ref === 'string' ? e.portrait_ref : null,
              checked_at: Number(e.checked_at) || 0,
            };
          }
        }
      }
    } catch {
      out = { version: 1, characters: {} };
    }
    this.index = out;
    return out;
  }

  private async saveIndex(): Promise<void> {
    const idx = await this.loadIndex();
    const body = JSON.stringify(idx);
    this.writing = this.writing.then(async () => {
      await mkdir(this.root(), { recursive: true });
      const tmp = `${this.indexPath()}.${randomBytes(4).toString('hex')}.tmp`;
      await writeFile(tmp, body);
      await rename(tmp, this.indexPath());
    });
    await this.writing.catch(() => {
      this.writing = Promise.resolve();
    });
  }

  async entry(characterId: string): Promise<AnimaIndexEntry | null> {
    return (await this.loadIndex()).characters[characterId] ?? null;
  }

  async setEntry(characterId: string, e: AnimaIndexEntry | null): Promise<void> {
    if (!CHAR_ID_RE.test(characterId)) return;
    const idx = await this.loadIndex();
    if (e) idx.characters[characterId] = e;
    else delete idx.characters[characterId];
    await this.saveIndex();
  }

  /** Her installed pack id, or null (no entry, or the pack dir is gone). */
  async packIdFor(characterId: string): Promise<string | null> {
    const e = await this.entry(characterId);
    if (!e) return null;
    const id = animaPackId(e.pack_sha256);
    return (await this.hasPack(id)) ? id : null;
  }

  async hasPack(id: string): Promise<boolean> {
    const dir = this.packDir(id);
    if (!dir) return false;
    try {
      return (await stat(path.join(dir, 'facepack.json'))).isFile();
    } catch {
      return false;
    }
  }

  async manifest(id: string): Promise<FacepackManifest | null> {
    const dir = this.packDir(id);
    if (!dir) return null;
    try {
      const m = JSON.parse(await readFile(path.join(dir, 'facepack.json'), 'utf8')) as unknown;
      return isFacepackManifest(m) ? m : null;
    } catch {
      return null;
    }
  }

  /** Where one pack file is on disk, or null (bad id/path, missing, too big). */
  async filePath(id: string, rel: string): Promise<string | null> {
    const dir = this.packDir(id);
    if (!dir || !isSafePackPath(rel)) return null;
    const full = path.resolve(dir, rel);
    if (!full.startsWith(dir + path.sep)) return null;
    try {
      const s = await stat(full);
      return s.isFile() && s.size <= ANIMA_FILE_MAX_BYTES ? full : null;
    } catch {
      return null;
    }
  }

  /**
   * Install a downloaded pack.zip whose sha256 the proxy gave as `sha`.
   * Returns the pack id. Already installed: verifies nothing more, returns it.
   */
  async install(zip: Uint8Array, sha: string): Promise<{ id: string; bytes: number; files: number }> {
    if (!SHA_RE.test(sha) || sha256Hex(zip) !== sha) throw new AnimaPackError('hash_mismatch');
    const id = animaPackId(sha);
    const dir = this.packDir(id)!;
    if (await this.hasPack(id)) return { id, bytes: 0, files: 0 };
    let archive: JSZip;
    try {
      archive = await JSZip.loadAsync(zip);
    } catch {
      throw new AnimaPackError('bad_archive');
    }
    const entries = Object.values(archive.files).filter((f) => !f.dir);
    if (entries.length === 0) throw new AnimaPackError('bad_archive');
    if (entries.length > ANIMA_PACK_MAX_FILES) throw new AnimaPackError('too_big');
    for (const f of entries) if (!isSafePackPath(f.name)) throw new AnimaPackError('bad_entry');
    if (!entries.some((f) => f.name === 'facepack.json')) throw new AnimaPackError('no_manifest');

    await mkdir(this.packsDir(), { recursive: true });
    const tmp = path.join(this.packsDir(), `.tmp-${id}-${randomBytes(4).toString('hex')}`);
    let total = 0;
    try {
      for (const f of entries) {
        const bytes = await f.async('uint8array');
        if (bytes.byteLength > ANIMA_FILE_MAX_BYTES) throw new AnimaPackError('too_big');
        total += bytes.byteLength;
        if (total > ANIMA_PACK_MAX_BYTES) throw new AnimaPackError('too_big');
        const out = path.resolve(tmp, f.name);
        if (!out.startsWith(tmp + path.sep)) throw new AnimaPackError('bad_entry');
        await mkdir(path.dirname(out), { recursive: true });
        await writeFile(out, bytes);
      }
      let m: unknown = null;
      try {
        m = JSON.parse(await readFile(path.join(tmp, 'facepack.json'), 'utf8'));
      } catch {
        m = null;
      }
      if (!isFacepackManifest(m)) throw new AnimaPackError('no_manifest');
      try {
        await rename(tmp, dir);
      } catch (err) {
        // A second install of the same pack won the race: keep that one.
        if (!(await this.hasPack(id))) throw err;
        await rm(tmp, { recursive: true, force: true });
      }
      return { id, bytes: total, files: entries.length };
    } catch (err) {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  }

  /**
   * Remove packs no character points at any more, and (`temps`, only before
   * any install can be running) leftover temp dirs. Best effort.
   */
  async prune(temps = false): Promise<number> {
    const idx = await this.loadIndex();
    const keep = new Set(Object.values(idx.characters).map((e) => animaPackId(e.pack_sha256)));
    let names: string[] = [];
    try {
      names = await readdir(this.packsDir());
    } catch {
      return 0;
    }
    let removed = 0;
    for (const name of names) {
      if (keep.has(name)) continue;
      if (!ANIMA_PACK_ID_RE.test(name) && !(temps && name.startsWith('.tmp-an-'))) continue;
      await rm(path.join(this.packsDir(), name), { recursive: true, force: true }).catch(() => {});
      removed++;
    }
    return removed;
  }

  /** Tests: drop the cached index. */
  forget(): void {
    this.index = null;
  }
}
