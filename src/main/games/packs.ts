/**
 * Game pack store (260908, game-adapters M0b): downloads a game adapter's
 * runtime (the `packs/<game>` workspace's production node_modules, natives
 * rebuilt for Electron) on first use and hands the bot a root to resolve it
 * from. Contract + naming: src/shared/gamePacks.ts. Builder:
 * scripts/build-game-pack.mjs.
 *
 * Layout, device-global like chess-models and speech-models (a pack is
 * identity-free and one copy serves every profile):
 *
 *   <userData>/game-packs/<game>/installed.json        {version, treeHash, ...}
 *   <userData>/game-packs/<game>/<version>/node_modules/...   the pack
 *   <userData>/game-packs/<game>/<version>/pack.json
 *   <userData>/game-packs/<game>/tmp/                  in-flight download
 *
 * Rules:
 *   - DEV (unpackaged) short-circuits to the repo root as `ready`: the
 *     workspace's packages are hoisted into the repo's node_modules by
 *     `npm ci`, so the bot resolves them exactly as before. Set
 *     SEI_GAME_PACKS_DIR=<dir> to exercise the real download path in dev; the
 *     dir replaces <userData>/game-packs as the store root.
 *   - The manifest is fetched MIRROR FIRST (dl.sei.gg, bounded connect) then
 *     from the GitHub release; the zip the same way.
 *   - sha256 + size are verified on the downloaded zip before anything is
 *     extracted; zip entries that would escape the target dir are rejected;
 *     unix modes ride the zip so `.node` files come back executable.
 *   - A matching `treeHash` on an already-installed pack is re-linked to the
 *     new version WITHOUT a download (two releases cut from one lockfile
 *     produce byte-identical trees even though their zips differ), but only
 *     when the installed tree really holds what its pack.json promises: every
 *     GAME_PACKS[game].requiredPaths file, and pack.json's `files` count. An
 *     install that fails either reads as missing and is downloaded again
 *     (260924: v0.6.5-beta.1's DST pack extracted to pack.json alone while
 *     its treeHash matched the fixed rebuild, so a hash-only re-link would
 *     have kept those installs empty forever).
 *   - An extracted zip is held to the same check before it is committed.
 *   - Older versions of a game's pack are deleted once the new one commits.
 *   - Single-flight per game; every failure maps to GAME_PACK_DOWNLOAD_FAILED.
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import JSZip from 'jszip';
import { app } from 'electron';
import { paths } from '../paths';
import {
  GAME_PACKS,
  gamePackSources,
  manifestSources,
  parseGamePackManifest,
  pickPackEntry,
  type GameId,
  type GamePackManifestEntry,
  type GamePackSource,
  type GamePackState,
} from '../../shared/gamePacks';

export type { GameId, GamePackState } from '../../shared/gamePacks';

// ── Environment (overridable for tests) ─────────────────────────────────────

export interface GamePackEnv {
  /** app.isPackaged: false = dev short-circuit unless SEI_GAME_PACKS_DIR is set. */
  packaged: boolean;
  /** Root the bot resolves the hoisted tree from in dev (app.getAppPath()). */
  appRoot: string;
  /** App version; the manifest and pack names carry it. */
  version: string;
  platform: string;
  arch: string;
  /** Where packs are installed (`<userData>/game-packs` or SEI_GAME_PACKS_DIR). */
  storeRoot: string;
  manifestSources: (version: string) => GamePackSource[];
  packSources: (version: string, file: string) => GamePackSource[];
  fetch: typeof fetch;
  /** Stall watchdog for the zip body: no bytes for this long aborts the attempt. */
  stallMs: number;
}

function defaultEnv(): GamePackEnv {
  const devDir = process.env.SEI_GAME_PACKS_DIR;
  // Optional calls: test doubles of `electron` stub only what their subject
  // uses, and a summon test that never reaches the network must not fail on
  // an app.getVersion it never needed.
  const a = app as Partial<typeof app>;
  return {
    packaged: a.isPackaged === true || Boolean(devDir),
    appRoot: a.getAppPath?.() ?? process.cwd(),
    version: a.getVersion?.() ?? '0.0.0',
    platform: process.platform,
    arch: process.arch,
    storeRoot: devDir ? path.resolve(devDir) : path.join(paths.userData(), 'game-packs'),
    manifestSources,
    packSources: gamePackSources,
    fetch: (input, init) => fetch(input, init),
    stallMs: 30_000,
  };
}

let envOverride: Partial<GamePackEnv> | null = null;

function env(): GamePackEnv {
  return envOverride ? { ...defaultEnv(), ...envOverride } : defaultEnv();
}

/** TEST-ONLY: override the environment (null restores the defaults). */
export function _setGamePackEnvForTest(override: Partial<GamePackEnv> | null): void {
  envOverride = override;
  live.clear();
  inflight.clear();
}

// ── Paths ───────────────────────────────────────────────────────────────────

function gameDir(e: GamePackEnv, game: GameId): string {
  return path.join(e.storeRoot, game);
}
function versionRoot(e: GamePackEnv, game: GameId, version: string): string {
  return path.join(gameDir(e, game), version);
}
function installedPath(e: GamePackEnv, game: GameId): string {
  return path.join(gameDir(e, game), 'installed.json');
}
function tmpDir(e: GamePackEnv, game: GameId): string {
  return path.join(gameDir(e, game), 'tmp');
}

interface InstalledRecord {
  game: GameId;
  version: string;
  treeHash: string;
  platform: string;
  arch: string;
  installedAt: string;
}

async function readInstalled(e: GamePackEnv, game: GameId): Promise<InstalledRecord | null> {
  try {
    const raw = JSON.parse(await readFile(installedPath(e, game), 'utf8')) as Partial<InstalledRecord>;
    if (
      raw.game !== game ||
      typeof raw.version !== 'string' ||
      typeof raw.treeHash !== 'string'
    ) {
      return null;
    }
    // The record promises a tree; a half-deleted store must read as missing.
    const root = versionRoot(e, game, raw.version);
    const s = await stat(path.join(root, 'pack.json'));
    if (!s.isFile()) return null;
    // ...and a tree without its payload (the empty v0.6.5-beta.1 DST pack)
    // must too, or the re-link below would carry it forward. A few stats.
    const missing = await missingPayload(root, game);
    if (missing.length) {
      console.warn(`[sei/game-packs] installed ${game} ${raw.version} is missing ${missing.join(', ')}; will download again`);
      return null;
    }
    return raw as InstalledRecord;
  } catch {
    return null;
  }
}

async function writeInstalled(e: GamePackEnv, rec: InstalledRecord): Promise<void> {
  await mkdir(gameDir(e, rec.game), { recursive: true });
  await writeFile(installedPath(e, rec.game), JSON.stringify(rec, null, 2));
}

// ── Live state + push fan-out ───────────────────────────────────────────────

const live = new Map<GameId, GamePackState>();
const listeners = new Set<(game: GameId, state: GamePackState) => void>();

function publish(game: GameId, state: GamePackState): void {
  live.set(game, state);
  for (const l of listeners) l(game, state);
}

/** Subscribe to state changes (the IPC push wires this once). */
export function onGamePackState(cb: (game: GameId, state: GamePackState) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * Current state of one game's pack. `ready` in dev (repo root) or when the
 * installed pack's version is the app's own; `downloading` / `error` while a
 * job is live or after it failed; `missing` otherwise. A pack from an OLDER
 * app version reads as `missing` here even though ensurePack may re-link it
 * without a download: the manifest decides that, and this call never touches
 * the network.
 */
export async function getPackState(game: GameId): Promise<GamePackState> {
  const e = env();
  if (!e.packaged) return { kind: 'ready', root: e.appRoot };
  const cur = live.get(game);
  if (cur && (cur.kind === 'downloading' || cur.kind === 'error')) return cur;
  const installed = await readInstalled(e, game);
  if (installed && installed.version === e.version) {
    return { kind: 'ready', root: versionRoot(e, game, installed.version) };
  }
  return { kind: 'missing' };
}

// ── ensurePack ──────────────────────────────────────────────────────────────

export interface EnsurePackOptions {
  onProgress?: (received: number, total: number) => void;
  signal?: AbortSignal;
}

/** Single-flight per game: concurrent callers share one job. */
const inflight = new Map<GameId, Promise<string>>();

/**
 * Resolve the root the bot should resolve `<game>`'s packages from,
 * downloading + installing the pack when needed. Resolves to the pack root
 * (the directory containing `node_modules/`). Rejects with an Error whose
 * message starts with `GAME_PACK_DOWNLOAD_FAILED:` on any failure, or with an
 * AbortError when `signal` fires.
 */
export async function ensurePack(game: GameId, opts: EnsurePackOptions = {}): Promise<string> {
  const e = env();
  if (!e.packaged) return e.appRoot;
  let job = inflight.get(game);
  if (!job) {
    job = install(e, game, opts).finally(() => inflight.delete(game));
    inflight.set(game, job);
  } else if (opts.onProgress) {
    // A joiner still gets progress: mirror the push into its callback.
    const off = onGamePackState((g, s) => {
      if (g === game && s.kind === 'downloading') opts.onProgress?.(s.received, s.total);
    });
    void job.finally(off);
  }
  return job;
}

async function install(e: GamePackEnv, game: GameId, opts: EnsurePackOptions): Promise<string> {
  const desc = GAME_PACKS[game];
  try {
    const installed = await readInstalled(e, game);
    if (installed && installed.version === e.version) {
      const root = versionRoot(e, game, installed.version);
      publish(game, { kind: 'ready', root });
      return root;
    }

    publish(game, { kind: 'downloading', received: 0, total: desc.sizeHintBytes });
    const manifest = await fetchManifest(e, opts.signal);
    const entry = pickPackEntry(manifest, game, e.platform, e.arch);
    if (!entry) {
      throw new Error(`no ${game} pack for ${e.platform}-${e.arch} in ${manifestName(e)}`);
    }

    // Same tree already on disk under an older version: re-link, no download.
    // The full file-count check runs here, once per app update, not on the
    // per-summon fast path above.
    if (
      installed &&
      installed.treeHash === entry.treeHash &&
      (await treeProblem(versionRoot(e, game, installed.version), game)) === null
    ) {
      const from = versionRoot(e, game, installed.version);
      const to = versionRoot(e, game, e.version);
      if (from !== to) {
        await rm(to, { recursive: true, force: true });
        await rename(from, to);
      }
      await writeInstalled(e, { ...installed, version: e.version, installedAt: new Date().toISOString() });
      await pruneOtherVersions(e, game, e.version);
      publish(game, { kind: 'ready', root: to });
      return to;
    }

    const zipPath = await downloadZip(e, game, entry, opts);
    const root = await extractZip(e, game, entry, zipPath);
    await rm(zipPath, { force: true }).catch(() => {});
    await writeInstalled(e, {
      game,
      version: e.version,
      treeHash: entry.treeHash,
      platform: entry.platform,
      arch: entry.arch,
      installedAt: new Date().toISOString(),
    });
    await pruneOtherVersions(e, game, e.version);
    publish(game, { kind: 'ready', root });
    return root;
  } catch (err) {
    await rm(tmpDir(e, game), { recursive: true, force: true }).catch(() => {});
    if (isAbort(err, opts.signal)) {
      publish(game, { kind: 'missing' });
      throw err;
    }
    const message = errText(err);
    publish(game, { kind: 'error', error: 'GAME_PACK_DOWNLOAD_FAILED', message });
    throw new Error(`GAME_PACK_DOWNLOAD_FAILED: ${message}`);
  }
}

function manifestName(e: GamePackEnv): string {
  return e.manifestSources(e.version)[0]?.url.split('/').pop() ?? 'manifest';
}

function isAbort(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return err instanceof Error && err.name === 'AbortError';
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Network ─────────────────────────────────────────────────────────────────

/**
 * One fetch attempt with a connect (headers) timeout and the caller's abort
 * signal combined. Returns the Response once headers land; the caller keeps
 * the controller to arm its own stall watchdog on the body.
 */
async function openSource(
  e: GamePackEnv,
  src: GamePackSource,
  signal: AbortSignal | undefined,
): Promise<{ res: Response; ctrl: AbortController }> {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(signal?.reason);
  if (signal?.aborted) onAbort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const connectTimer = src.connectTimeoutMs
    ? setTimeout(() => ctrl.abort(new Error(`connect timeout after ${src.connectTimeoutMs}ms`)), src.connectTimeoutMs)
    : null;
  try {
    const res = await e.fetch(src.url, { signal: ctrl.signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} from ${hostOf(src.url)}`);
    return { res, ctrl };
  } finally {
    if (connectTimer) clearTimeout(connectTimer);
    // The body read below re-arms its own guard; the caller's abort stays
    // wired to ctrl through onAbort for the life of the request.
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

async function fetchManifest(e: GamePackEnv, signal?: AbortSignal) {
  let lastErr: unknown = null;
  for (const src of e.manifestSources(e.version)) {
    try {
      const { res } = await openSource(e, src, signal);
      const json: unknown = await res.json();
      return parseGamePackManifest(json);
    } catch (err) {
      if (isAbort(err, signal)) throw err;
      lastErr = err;
      console.warn(`[sei/game-packs] manifest failed from ${src.url}: ${errText(err)}`);
    }
  }
  throw new Error(`manifest unavailable: ${errText(lastErr ?? 'no sources')}`);
}

async function downloadZip(
  e: GamePackEnv,
  game: GameId,
  entry: GamePackManifestEntry,
  opts: EnsurePackOptions,
): Promise<string> {
  const dir = tmpDir(e, game);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, entry.file);
  let lastErr: unknown = null;
  for (const src of e.packSources(e.version, entry.file)) {
    const part = `${target}.part`;
    try {
      const { res, ctrl } = await openSource(e, src, opts.signal);
      const hash = createHash('sha256');
      let received = 0;
      let lastPushed = -1;
      const out = createWriteStream(part);
      const reader = res.body!.getReader();
      let stall = setTimeout(() => ctrl.abort(new Error('stalled')), e.stallMs);
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          clearTimeout(stall);
          stall = setTimeout(() => ctrl.abort(new Error('stalled')), e.stallMs);
          if (!value) continue;
          if (received + value.length > entry.bytes) {
            throw new Error(`oversize download from ${hostOf(src.url)}`);
          }
          hash.update(value);
          received += value.length;
          await new Promise<void>((resolve, reject) => {
            out.write(value, (err) => (err ? reject(err) : resolve()));
          });
          // Push at most once per ~1% so the renderer is not flooded.
          const pct = Math.floor((received / entry.bytes) * 100);
          if (pct !== lastPushed) {
            lastPushed = pct;
            publish(game, { kind: 'downloading', received, total: entry.bytes });
            opts.onProgress?.(received, entry.bytes);
          }
        }
      } finally {
        clearTimeout(stall);
        await new Promise<void>((resolve) => out.end(() => resolve()));
      }
      if (received !== entry.bytes) {
        throw new Error(`size mismatch: got ${received}, expected ${entry.bytes}`);
      }
      const sha = hash.digest('hex');
      if (sha !== entry.sha256) {
        throw new Error(`sha256 mismatch from ${hostOf(src.url)}`);
      }
      await rename(part, target);
      console.log(`[sei/game-packs] ${entry.file} downloaded from ${hostOf(src.url)} (${received} bytes)`);
      return target;
    } catch (err) {
      await rm(part, { force: true }).catch(() => {});
      if (isAbort(err, opts.signal)) throw err;
      lastErr = err;
      console.warn(`[sei/game-packs] download failed from ${src.url}: ${errText(err)}`);
    }
  }
  throw new Error(`download failed: ${errText(lastErr ?? 'no sources')}`);
}

// ── Extract ─────────────────────────────────────────────────────────────────

/** Pure: is this zip entry name safe to extract under a target dir? */
export function isSafeZipEntryName(name: string): boolean {
  if (!name || name.startsWith('/') || name.startsWith('\\')) return false;
  if (/^[a-zA-Z]:/.test(name)) return false;
  if (name.includes('\0')) return false;
  const parts = name.split(/[\\/]+/);
  return parts.every((p) => p !== '..');
}

async function extractZip(
  e: GamePackEnv,
  game: GameId,
  entry: GamePackManifestEntry,
  zipPath: string,
): Promise<string> {
  const finalRoot = versionRoot(e, game, e.version);
  const stagingRoot = `${finalRoot}.extracting`;
  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true });

  const zip = await JSZip.loadAsync(await readFile(zipPath));
  const names = Object.keys(zip.files).sort();
  for (const name of names) {
    const file = zip.files[name];
    if (!isSafeZipEntryName(name)) {
      throw new Error(`unsafe zip entry: ${name}`);
    }
    const dest = path.resolve(stagingRoot, name);
    if (dest !== stagingRoot && !dest.startsWith(stagingRoot + path.sep)) {
      throw new Error(`unsafe zip entry: ${name}`);
    }
    if (file.dir) {
      await mkdir(dest, { recursive: true });
      continue;
    }
    await mkdir(path.dirname(dest), { recursive: true });
    await pipeline(file.nodeStream(), createWriteStream(dest));
    // Preserve the mode the builder recorded (unixPermissions carries the
    // full st_mode; keep the permission bits). Without this a `.node` addon
    // and any bin script come back 0644.
    const perms = file.unixPermissions;
    if (typeof perms === 'number' && perms !== 0) {
      await chmod(dest, perms & 0o777).catch(() => {});
    }
  }

  // The zip must be the pack the manifest described.
  let packJson: { game?: string; treeHash?: string; version?: string };
  try {
    packJson = JSON.parse(await readFile(path.join(stagingRoot, 'pack.json'), 'utf8'));
  } catch {
    throw new Error(`${entry.file} has no pack.json`);
  }
  if (packJson.game !== game || packJson.treeHash !== entry.treeHash) {
    throw new Error(`${entry.file} pack.json does not match the manifest`);
  }
  // Asset packs (Stardew, DST) carry no node_modules/, so the check is the
  // game's own payload list, not a fixed directory.
  const problem = await treeProblem(stagingRoot, game);
  if (problem) throw new Error(`${entry.file} is incomplete: ${problem}`);

  await rm(finalRoot, { recursive: true, force: true });
  await rename(stagingRoot, finalRoot);
  return finalRoot;
}

// ── Integrity ───────────────────────────────────────────────────────────────

/** The game's required payload files that are not regular files under root. */
async function missingPayload(root: string, game: GameId): Promise<string[]> {
  const missing: string[] = [];
  for (const rel of GAME_PACKS[game].requiredPaths) {
    try {
      if (!(await stat(path.join(root, ...rel.split('/')))).isFile()) missing.push(rel);
    } catch {
      missing.push(rel);
    }
  }
  return missing;
}

/** Regular files under dir, recursively. */
async function countFiles(dir: string): Promise<number> {
  let n = 0;
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) n += await countFiles(path.join(dir, ent.name));
    else if (ent.isFile()) n++;
  }
  return n;
}

/**
 * Why the pack tree at root is not usable, or null when it is: a required
 * payload file is missing, or the tree holds fewer files than pack.json's
 * `files` (the count the builder hashed; pack.json itself excluded). Extra
 * files are tolerated: a stray .DS_Store or Thumbs.db the OS drops into the
 * store must not force a 50MB Minecraft re-download. A pack.json without a
 * numeric `files` skips only the count.
 */
async function treeProblem(root: string, game: GameId): Promise<string | null> {
  try {
    const missing = await missingPayload(root, game);
    if (missing.length) return `missing ${missing.join(', ')}`;
    const pj = JSON.parse(await readFile(path.join(root, 'pack.json'), 'utf8')) as { files?: unknown };
    if (typeof pj.files === 'number') {
      const have = (await countFiles(root)) - 1;
      if (have < pj.files) return `holds ${have} files, pack.json lists ${pj.files}`;
    }
    return null;
  } catch (err) {
    return errText(err);
  }
}

async function pruneOtherVersions(e: GamePackEnv, game: GameId, keep: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(gameDir(e, game));
  } catch {
    return;
  }
  for (const n of names) {
    if (n === keep || n === 'installed.json' || n === 'tmp') continue;
    await rm(path.join(gameDir(e, game), n), { recursive: true, force: true }).catch(() => {});
  }
}
