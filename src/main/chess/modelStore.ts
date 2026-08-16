/**
 * Maia model store: the CCE engine needs the ~21 MB Maia-3 ONNX model, which
 * is NOT bundled (it would grow every installer and update). It downloads once
 * on first chess launch and lives in userData (app-global, not profile-scoped —
 * the model is identity-free).
 *
 * The file is our own ONNX export (cce-1 scripts/export-maia3.py) of the
 * official AGPL-3.0 Maia3-5M checkpoint (github.com/CSSLab/maia3), published
 * as a cce-1 GitHub release asset. A dev machine with the ~/.sei-dev/cce copy
 * uses it directly and never downloads.
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { app } from 'electron';

const MODEL_FILENAME = 'maia3-5m.onnx';
/** Exact size of the published model; a mismatched download is discarded. */
const MODEL_BYTES = 21_130_791;

// Two sources (260816, china-compat): GitHub's release-asset CDN is
// unreliable from mainland China, so blocked-region users try the R2 mirror
// first; everyone else keeps the historical GitHub-first order (the W10
// cloud-no-regression rule — same regionStatus gate the whisper host loop
// uses). The loop below falls through to the next URL on any failure, so a
// missing/unreachable mirror costs one failed attempt and nothing else.
// Assets land in the bucket via scripts/mirror-assets.mjs.
const MODEL_URL_MIRROR = `https://dl.sei.gg/chess/${MODEL_FILENAME}`;
const MODEL_URL_ORIGIN =
  'https://github.com/sei-studio/cce-1/releases/download/model-v1/maia3-5m.onnx';

/** Origin-first by default; mirror-first only for blocked-region users. */
async function modelUrls(): Promise<string[]> {
  let mirrorFirst = false;
  try {
    const { getRegionStatus } = await import('../regionDetect');
    mirrorFirst = (await getRegionStatus()).blocked === true;
  } catch {
    /* region unknown → historical origin-first order */
  }
  return mirrorFirst
    ? [MODEL_URL_MIRROR, MODEL_URL_ORIGIN]
    : [MODEL_URL_ORIGIN, MODEL_URL_MIRROR];
}

const DEV_MODEL = path.join(homedir(), '.sei-dev', 'cce', MODEL_FILENAME);

export type DownloadProgress = (pct: number) => void;

function modelDir(): string {
  return path.join(app.getPath('userData'), 'chess-models');
}

export function modelPath(): string {
  return path.join(modelDir(), MODEL_FILENAME);
}

async function fileOk(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isFile() && s.size === MODEL_BYTES;
  } catch {
    return false;
  }
}

/** Single-flight: concurrent ensureModel calls share one download. */
let inflight: Promise<string> | null = null;

/**
 * Resolve a usable model path, downloading if needed. Progress is reported in
 * whole percents (0-100). Throws when every source fails.
 */
export async function ensureModel(onProgress?: DownloadProgress): Promise<string> {
  if (await fileOk(DEV_MODEL)) return DEV_MODEL;
  const target = modelPath();
  if (await fileOk(target)) return target;
  if (!inflight) {
    inflight = download(target, onProgress).finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

/** True when no download would be needed (drives the 'preparing' status). */
export async function modelReady(): Promise<boolean> {
  return (await fileOk(DEV_MODEL)) || (await fileOk(modelPath()));
}

async function download(target: string, onProgress?: DownloadProgress): Promise<string> {
  await mkdir(path.dirname(target), { recursive: true });
  let lastErr: Error | null = null;
  for (const url of await modelUrls()) {
    const tmp = `${target}.download`;
    try {
      const res = await fetch(url);
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
      const total = Number(res.headers.get('content-length')) || MODEL_BYTES;
      const out = createWriteStream(tmp);
      const hash = createHash('sha256');
      let received = 0;
      let lastPct = -1;
      const reader = res.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          hash.update(value);
          received += value.length;
          await new Promise<void>((resolve, reject) => {
            out.write(value, (err) => (err ? reject(err) : resolve()));
          });
          const pct = Math.min(99, Math.floor((received / total) * 100));
          if (pct !== lastPct) {
            lastPct = pct;
            onProgress?.(pct);
          }
        }
      } finally {
        await new Promise<void>((resolve) => out.end(() => resolve()));
      }
      if (received !== MODEL_BYTES) {
        throw new Error(`size mismatch: got ${received}, expected ${MODEL_BYTES}`);
      }
      await rename(tmp, target);
      console.log(`[sei/chess] model downloaded from ${new URL(url).host} sha256=${hash.digest('hex').slice(0, 16)}…`);
      onProgress?.(100);
      return target;
    } catch (err) {
      lastErr = err as Error;
      console.warn(`[sei/chess] model download failed from ${url}: ${lastErr.message}`);
      await unlink(tmp).catch(() => {});
    }
  }
  throw new Error(`chess model download failed: ${lastErr?.message ?? 'no sources'}`);
}
