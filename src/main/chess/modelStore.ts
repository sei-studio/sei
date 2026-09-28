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

/** Pure ordering (exported for tests): origin-first unless the region is blocked. */
export function modelUrlOrder(blocked: boolean): string[] {
  return blocked
    ? [MODEL_URL_MIRROR, MODEL_URL_ORIGIN]
    : [MODEL_URL_ORIGIN, MODEL_URL_MIRROR];
}

/** Origin-first by default; mirror-first only for blocked-region users. */
async function modelUrls(): Promise<string[]> {
  let mirrorFirst = false;
  try {
    const { getRegionStatus } = await import('../regionDetect');
    mirrorFirst = (await getRegionStatus()).blocked === true;
  } catch {
    /* region unknown → historical origin-first order */
  }
  return modelUrlOrder(mirrorFirst);
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

/**
 * Download budget (260929). The first-game download used to be a bare
 * fetch() with no timeout: a stalled connection left the board in
 * "preparing" forever, and a failure ended the game as a silent "abandoned"
 * that looked exactly like a player quitting (10 of 35 chess games over 45
 * days ended at 0 moves, some after minutes at the board). Now every attempt
 * has a connect budget (until response headers) and a stall budget (no bytes
 * for this long), and the source list is walked up to `attempts` times with
 * a short pause between tries. Worst case before the panel shows its error:
 * about attempts x connectTimeoutMs. A slow but moving download never times
 * out; only silence does. Exported and mutable for tests.
 */
export const MODEL_DOWNLOAD = {
  connectTimeoutMs: 20_000,
  stallTimeoutMs: 30_000,
  attempts: 3,
  retryDelayMs: 2_000,
};

/** Why a download attempt failed. Shape only; safe for analytics classes. */
export type ModelDownloadFailure = 'timeout' | 'network' | 'http' | 'size' | 'disk';

export class ModelDownloadError extends Error {
  constructor(
    message: string,
    readonly kind: ModelDownloadFailure,
  ) {
    super(message);
    this.name = 'ModelDownloadError';
  }
}

class AttemptTimeout extends Error {
  constructor(what: string) {
    super(what);
    this.name = 'AttemptTimeout';
  }
}

/** Reject as soon as `signal` aborts, even if `p` itself never settles. */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

export interface DownloadModelOpts {
  onProgress?: DownloadProgress;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected for tests; defaults to the published model size. */
  expectedBytes?: number;
  timing?: typeof MODEL_DOWNLOAD;
}

/**
 * Walk `urls` round-robin for up to `timing.attempts` attempts. Resolves with
 * `target` once a complete, correctly sized file is in place; throws a
 * ModelDownloadError carrying the LAST failure's kind otherwise. Exported for
 * tests; production goes through ensureModel.
 */
export async function downloadModelFile(
  target: string,
  urls: string[],
  opts: DownloadModelOpts = {},
): Promise<string> {
  const timing = opts.timing ?? MODEL_DOWNLOAD;
  const doFetch = opts.fetchImpl ?? fetch;
  const expected = opts.expectedBytes ?? MODEL_BYTES;
  await mkdir(path.dirname(target), { recursive: true });
  if (urls.length === 0) throw new ModelDownloadError('chess model download failed: no sources', 'network');
  let last: ModelDownloadError | null = null;
  const attempts = Math.max(1, timing.attempts);
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0 && timing.retryDelayMs > 0) {
      await new Promise((r) => setTimeout(r, timing.retryDelayMs));
    }
    const url = urls[attempt % urls.length];
    const host = new URL(url).host;
    const tmp = `${target}.download`;
    const ctrl = new AbortController();
    let watchdog: NodeJS.Timeout | null = null;
    const arm = (ms: number, what: string): void => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => ctrl.abort(new AttemptTimeout(`${what} after ${ms}ms from ${host}`)), ms);
    };
    try {
      arm(timing.connectTimeoutMs, 'no response');
      const res = await raceAbort(doFetch(url, { signal: ctrl.signal }), ctrl.signal);
      if (!res.ok || !res.body) {
        res.body?.cancel().catch(() => {});
        throw new ModelDownloadError(`HTTP ${res.status} from ${host}`, 'http');
      }
      const total = Number(res.headers.get('content-length')) || expected;
      const out = createWriteStream(tmp);
      const hash = createHash('sha256');
      let received = 0;
      let lastPct = -1;
      const reader = res.body.getReader();
      try {
        for (;;) {
          arm(timing.stallTimeoutMs, 'download stalled');
          const { done, value } = await raceAbort(reader.read(), ctrl.signal);
          if (done) break;
          hash.update(value);
          received += value.length;
          await new Promise<void>((resolve, reject) => {
            out.write(value, (err) => (err ? reject(new ModelDownloadError(err.message, 'disk')) : resolve()));
          });
          const pct = Math.min(99, Math.floor((received / total) * 100));
          if (pct !== lastPct) {
            lastPct = pct;
            opts.onProgress?.(pct);
          }
        }
      } finally {
        if (watchdog) clearTimeout(watchdog);
        reader.cancel().catch(() => {});
        await new Promise<void>((resolve) => out.end(() => resolve()));
      }
      if (received !== expected) {
        throw new ModelDownloadError(`size mismatch: got ${received}, expected ${expected}`, 'size');
      }
      try {
        await rename(tmp, target);
      } catch (err) {
        throw new ModelDownloadError((err as Error).message, 'disk');
      }
      console.log(`[sei/chess] model downloaded from ${host} sha256=${hash.digest('hex').slice(0, 16)}…`);
      opts.onProgress?.(100);
      return target;
    } catch (err) {
      if (err instanceof ModelDownloadError) last = err;
      else if (err instanceof AttemptTimeout || ctrl.signal.reason instanceof AttemptTimeout) {
        last = new ModelDownloadError((ctrl.signal.reason as Error)?.message ?? (err as Error).message, 'timeout');
      } else {
        last = new ModelDownloadError((err as Error)?.message ?? String(err), 'network');
      }
      console.warn(
        `[sei/chess] model download attempt ${attempt + 1}/${attempts} failed from ${host}: ${last.message}`,
      );
      await unlink(tmp).catch(() => {});
    } finally {
      if (watchdog) clearTimeout(watchdog);
    }
  }
  throw new ModelDownloadError(
    `chess model download failed: ${last?.message ?? 'no sources'}`,
    last?.kind ?? 'network',
  );
}

async function download(target: string, onProgress?: DownloadProgress): Promise<string> {
  return downloadModelFile(target, await modelUrls(), { onProgress });
}
