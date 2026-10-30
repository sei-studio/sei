/**
 * Where a FacepackView reads its pack from (261028, facepack pilot), plus the
 * decoded-image cache.
 *
 *  - ipcPackSource: the dev pack dir in main (SEI_FACEPACK_DIR, honoured only
 *    unpackaged), over window.sei.facepackManifest / facepackFile.
 *  - urlPackSource: `${base}/${id}/<path>` over fetch. This is the hook for a
 *    later download (an https pack host) and what the browser harness uses
 *    against a local static server. Nothing in the app calls it yet.
 *
 * Images are decoded to ImageBitmaps lazily, per expression + pose, and kept
 * in a byte-bounded LRU: a pack's full frame set is 60-84 full-canvas bases
 * (up to 6 MB each decoded), too much to hold at once.
 */
import type { FacepackManifest } from '@shared/facepack';
import { isSafePackPath } from '@shared/facepack';
import { sei } from '../ipcClient';

export interface FacepackSource {
  /** Stable key for caches (pack id + origin). */
  key: string;
  manifest(): Promise<FacepackManifest | null>;
  file(path: string): Promise<Blob | null>;
}

const MIME: Record<string, string> = { webp: 'image/webp', png: 'image/png', json: 'application/json' };

function mimeOf(path: string): string {
  return MIME[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream';
}

export function ipcPackSource(id: string): FacepackSource {
  return {
    key: `ipc:${id}`,
    manifest: async () => (await sei.facepackManifest?.(id)) ?? null,
    file: async (path) => {
      if (!isSafePackPath(path)) return null;
      const bytes = await sei.facepackFile?.(id, path);
      return bytes ? new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mimeOf(path) }) : null;
    },
  };
}

export function urlPackSource(id: string, baseUrl: string): FacepackSource {
  const base = `${baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(id)}/`;
  return {
    key: `url:${base}`,
    manifest: async () => {
      try {
        const r = await fetch(`${base}facepack.json`);
        if (!r.ok) return null;
        const m = (await r.json()) as FacepackManifest;
        return m?.format === 'sei-facepack' && m.version === 1 ? m : null;
      } catch {
        return null;
      }
    },
    file: async (path) => {
      if (!isSafePackPath(path)) return null;
      try {
        const r = await fetch(base + path.split('/').map(encodeURIComponent).join('/'));
        return r.ok ? await r.blob() : null;
      } catch {
        return null;
      }
    },
  };
}

/** Decoded-image LRU, bounded by decoded bytes (w * h * 4). */
export class FaceImageCache {
  private readonly map = new Map<string, ImageBitmap>();
  private readonly pending = new Map<string, Promise<ImageBitmap | null>>();
  private bytes = 0;
  private disposed = false;

  constructor(
    private readonly source: FacepackSource,
    private readonly maxBytes = 160 * 1024 * 1024,
  ) {}

  get(path: string): ImageBitmap | undefined {
    const bmp = this.map.get(path);
    if (bmp) {
      // Refresh recency.
      this.map.delete(path);
      this.map.set(path, bmp);
    }
    return bmp;
  }

  has(path: string): boolean {
    return this.map.has(path);
  }

  /** Decode every path not yet cached. Resolves when all are in (or failed). */
  async load(paths: readonly string[]): Promise<void> {
    await Promise.all(paths.map((p) => this.loadOne(p)));
  }

  private loadOne(path: string): Promise<ImageBitmap | null> {
    const hit = this.map.get(path);
    if (hit) return Promise.resolve(hit);
    const inflight = this.pending.get(path);
    if (inflight) return inflight;
    const p = (async () => {
      try {
        const blob = await this.source.file(path);
        if (!blob || this.disposed) return null;
        const bmp = await createImageBitmap(blob);
        if (this.disposed) {
          bmp.close();
          return null;
        }
        this.map.set(path, bmp);
        this.bytes += bmp.width * bmp.height * 4;
        return bmp;
      } catch {
        return null;
      } finally {
        this.pending.delete(path);
      }
    })();
    this.pending.set(path, p);
    return p;
  }

  /** Drop least-recent images until under budget, never touching `keep`. */
  trim(keep: ReadonlySet<string>): void {
    if (this.bytes <= this.maxBytes) return;
    for (const [path, bmp] of this.map) {
      if (this.bytes <= this.maxBytes) break;
      if (keep.has(path)) continue;
      this.map.delete(path);
      this.bytes -= bmp.width * bmp.height * 4;
      bmp.close();
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const bmp of this.map.values()) bmp.close();
    this.map.clear();
    this.bytes = 0;
  }
}
