/**
 * Speech pack store (260816, china-compat W3+W4): download-on-demand of the
 * sherpa-onnx model packs into `<userData>/speech-models/<packId>/`.
 *
 * Device-global like chess-models (a model is identity-free), NOT
 * profile-scoped. Layout per pack:
 *
 *   <userData>/speech-models/<packId>/<archive dirName>/...   extracted tree
 *   <userData>/speech-models/<packId>/pack.json               readiness marker
 *
 * The marker is written LAST (after a fully verified extract), so a crash
 * mid-extract leaves the pack 'absent' and the next download starts clean.
 * Download is mirror-first (mirrors.ts) with the exact-size check the chess
 * model store uses; extraction is the in-repo tar+bzip2 pair (the archives are
 * .tar.bz2 and Node has no bzip2). Entry names are traversal-checked before
 * any write.
 *
 * State pushed to the renderer is maintained through the PURE reducer
 * `reducePackState` (tested) so the IPC surface cannot drift from the
 * on-disk truth between events.
 */
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { paths } from '../paths';
import { bunzip2 } from './bzip2';
import { parseTar } from './tar';
import { SPEECH_PACKS, SPEECH_PACK_IDS, type SpeechPackId } from './packs';
import { speechSources } from './mirrors';

export interface PackState {
  state: 'absent' | 'downloading' | 'ready';
  /** Download progress in whole percents, present only while downloading. */
  pct?: number;
  /** Archive size in bytes (what a download will cost / has cost). */
  bytes: number;
}

export type PackStates = Record<SpeechPackId, PackState>;

export type PackEvent =
  | { kind: 'snapshot'; ready: SpeechPackId[] }
  | { kind: 'download-start'; packId: SpeechPackId }
  | { kind: 'progress'; packId: SpeechPackId; pct: number }
  | { kind: 'done'; packId: SpeechPackId }
  | { kind: 'failed'; packId: SpeechPackId }
  | { kind: 'removed'; packId: SpeechPackId };

/** Pure state reducer over pack lifecycle events (tested in packState.test.ts). */
export function reducePackState(current: PackStates | null, ev: PackEvent): PackStates {
  const base: PackStates = current ?? ({} as PackStates);
  const next: PackStates = { ...base };
  for (const id of SPEECH_PACK_IDS) {
    next[id] = next[id] ?? { state: 'absent', bytes: SPEECH_PACKS[id].archiveBytes };
  }
  switch (ev.kind) {
    case 'snapshot':
      for (const id of SPEECH_PACK_IDS) {
        // A snapshot never demotes a live download: 'downloading' is runtime
        // truth this module owns, and the disk scan cannot see it.
        if (next[id].state === 'downloading') continue;
        next[id] = {
          state: ev.ready.includes(id) ? 'ready' : 'absent',
          bytes: SPEECH_PACKS[id].archiveBytes,
        };
      }
      return next;
    case 'download-start':
      next[ev.packId] = { state: 'downloading', pct: 0, bytes: SPEECH_PACKS[ev.packId].archiveBytes };
      return next;
    case 'progress': {
      const cur = next[ev.packId];
      if (cur.state !== 'downloading') return next; // stale progress after done/fail
      next[ev.packId] = { ...cur, pct: Math.max(cur.pct ?? 0, Math.min(100, ev.pct)) };
      return next;
    }
    case 'done':
      next[ev.packId] = { state: 'ready', bytes: SPEECH_PACKS[ev.packId].archiveBytes };
      return next;
    case 'failed':
    case 'removed':
      next[ev.packId] = { state: 'absent', bytes: SPEECH_PACKS[ev.packId].archiveBytes };
      return next;
  }
}

function speechModelsRoot(): string {
  return path.join(paths.userData(), 'speech-models');
}

export function packRoot(id: SpeechPackId): string {
  return path.join(speechModelsRoot(), id);
}

/** Directory the extracted model tree lives in (the archive's own top dir). */
export function packModelDir(id: SpeechPackId): string {
  return path.join(packRoot(id), SPEECH_PACKS[id].dirName);
}

function markerPath(id: SpeechPackId): string {
  return path.join(packRoot(id), 'pack.json');
}

export async function packReady(id: SpeechPackId): Promise<boolean> {
  try {
    await stat(markerPath(id));
  } catch {
    return false;
  }
  // The marker promises the tree, but a required file check is cheap and makes
  // a half-deleted store honest.
  try {
    for (const rel of SPEECH_PACKS[id].requiredFiles) {
      const s = await stat(path.join(packModelDir(id), rel));
      if (!s.isFile()) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ── Live state + push fan-out ───────────────────────────────────────────────

let states: PackStates | null = null;
const listeners = new Set<(states: PackStates) => void>();

function apply(ev: PackEvent): void {
  states = reducePackState(states, ev);
  for (const l of listeners) l(states);
}

export function onPackStates(cb: (states: PackStates) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Current pack states, disk-scanned on first call and kept live after. */
export async function packStatus(): Promise<PackStates> {
  const ready: SpeechPackId[] = [];
  for (const id of SPEECH_PACK_IDS) {
    if (await packReady(id)) ready.push(id);
  }
  apply({ kind: 'snapshot', ready });
  return states as PackStates;
}

// ── Download + extract ──────────────────────────────────────────────────────

/** Single-flight per pack: concurrent download requests share one job. */
const inflight = new Map<SpeechPackId, Promise<void>>();

export async function downloadPack(id: SpeechPackId): Promise<void> {
  if (await packReady(id)) return;
  let job = inflight.get(id);
  if (!job) {
    job = doDownload(id).finally(() => inflight.delete(id));
    inflight.set(id, job);
  }
  return job;
}

async function fetchArchive(id: SpeechPackId): Promise<Uint8Array> {
  const def = SPEECH_PACKS[id];
  let lastErr: Error | null = null;
  for (const src of speechSources(def.asset, def.originUrl)) {
    const ctrl = new AbortController();
    // Connect/TTFB guard only — cleared once headers land. The body has its
    // own progress-driven liveness below.
    const connectTimer = src.connectTimeoutMs
      ? setTimeout(() => ctrl.abort(), src.connectTimeoutMs)
      : null;
    try {
      const res = await fetch(src.url, { signal: ctrl.signal });
      if (connectTimer) clearTimeout(connectTimer);
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} from ${new URL(src.url).host}`);
      const out = new Uint8Array(def.archiveBytes);
      let received = 0;
      let lastPct = -1;
      const reader = res.body.getReader();
      // Stall watchdog: no chunk for 30s aborts (a dead socket must not hang
      // the download forever; the renderer is showing a progress bar).
      let stallTimer = setTimeout(() => ctrl.abort(), 30_000);
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          clearTimeout(stallTimer);
          stallTimer = setTimeout(() => ctrl.abort(), 30_000);
          if (!value) continue;
          if (received + value.length > def.archiveBytes) {
            throw new Error(`oversize download from ${new URL(src.url).host}`);
          }
          out.set(value, received);
          received += value.length;
          const pct = Math.min(99, Math.floor((received / def.archiveBytes) * 100));
          if (pct !== lastPct) {
            lastPct = pct;
            apply({ kind: 'progress', packId: id, pct });
          }
        }
      } finally {
        clearTimeout(stallTimer);
      }
      if (received !== def.archiveBytes) {
        throw new Error(`size mismatch: got ${received}, expected ${def.archiveBytes}`);
      }
      return out;
    } catch (err) {
      if (connectTimer) clearTimeout(connectTimer);
      lastErr = err as Error;
      console.warn(`[sei/speech] download failed from ${src.url}: ${lastErr.message}`);
    }
  }
  throw new Error(`SPEECH_DOWNLOAD_FAILED: ${lastErr?.message ?? 'no sources'}`);
}

async function doDownload(id: SpeechPackId): Promise<void> {
  const def = SPEECH_PACKS[id];
  apply({ kind: 'download-start', packId: id });
  try {
    const archive = await fetchArchive(id);
    // Extract into a temp sibling, then rename over — the marker write is the
    // commit point either way, but a clean tree beats a half tree on crash.
    const root = packRoot(id);
    const tmpRoot = `${root}.extracting`;
    await rm(tmpRoot, { recursive: true, force: true });
    await mkdir(tmpRoot, { recursive: true });
    const tarBytes = bunzip2(archive);
    const entries = parseTar(tarBytes);
    for (const entry of entries) {
      // Traversal check: resolved path must stay inside tmpRoot.
      const dest = path.resolve(tmpRoot, entry.name);
      if (dest !== tmpRoot && !dest.startsWith(tmpRoot + path.sep)) {
        throw new Error(`SPEECH_EXTRACT_FAILED: unsafe entry name ${entry.name}`);
      }
      if (entry.type === 'dir') {
        await mkdir(dest, { recursive: true });
      } else {
        await mkdir(path.dirname(dest), { recursive: true });
        await writeFile(dest, entry.data);
      }
    }
    // Verify the promised files exist before committing.
    for (const rel of def.requiredFiles) {
      await stat(path.join(tmpRoot, def.dirName, rel));
    }
    await rm(root, { recursive: true, force: true });
    await rename(tmpRoot, root);
    await writeFile(
      markerPath(id),
      JSON.stringify({ asset: def.asset, bytes: def.archiveBytes, at: new Date().toISOString() }),
    );
    apply({ kind: 'done', packId: id });
  } catch (err) {
    apply({ kind: 'failed', packId: id });
    await rm(`${packRoot(id)}.extracting`, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

export async function removePack(id: SpeechPackId): Promise<void> {
  await rm(packRoot(id), { recursive: true, force: true });
  apply({ kind: 'removed', packId: id });
}
