/**
 * Per-version cloud portrait cache (261111, World egress). MAIN PROCESS ONLY.
 *
 * The World card warms a character's data on a hover dwell (renderer
 * lib/hoverDwell.ts), and opening / refreshing / healing a character
 * downloads its full portrait. Those downloads used to repeat: the sign-in
 * reconcile sweep deletes a foreign character's local files, so the next
 * hover fetched the same bytes again. Here every downloaded portrait is also
 * kept as `<profileRoot>/cache/portraits/<uuid>@<version>.png`, keyed by the
 * cloud row's updated_at (the same `?v=` the URLs carry, which changes
 * whenever the portrait does). `fetchPortraitOnce` returns those bytes
 * without a download when the version is cached, and shares one in-flight
 * download per uuid + version.
 *
 * Only the newest version of a uuid is kept, and at most MAX_ENTRIES files
 * in all (oldest dropped first). Every failure here is soft: a cache that
 * cannot be read or written just means a download.
 */

import { mkdir, readFile, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
// allowJs:true in tsconfig.node.json lets TS resolve these .js modules.
import { atomicWrite } from '../../bot/brain/storage/atomicWrite.js';
import { paths } from '../paths';

export const MAX_ENTRIES = 200;

/** File-name-safe version tag; null when there is no version to key on. */
export function versionTag(version: string | null | undefined): string | null {
  if (!version) return null;
  const tag = version.replace(/[^A-Za-z0-9]/g, '');
  return tag.length > 0 ? tag.slice(0, 64) : null;
}

function entryPath(uuid: string, tag: string): string {
  return path.join(paths.portraitCacheDir(), `${uuid}@${tag}.png`);
}

export async function readCachedPortrait(uuid: string, version: string | null | undefined): Promise<Buffer | null> {
  const tag = versionTag(version);
  if (!tag) return null;
  try {
    const bytes = await readFile(entryPath(uuid, tag));
    return bytes.length > 0 ? bytes : null;
  } catch {
    return null;
  }
}

export async function storeCachedPortrait(uuid: string, version: string | null | undefined, bytes: Buffer): Promise<void> {
  const tag = versionTag(version);
  if (!tag || bytes.length === 0) return;
  try {
    const dir = paths.portraitCacheDir();
    await mkdir(dir, { recursive: true });
    await atomicWrite(entryPath(uuid, tag), bytes);
    await prune(dir, uuid, tag);
  } catch (err) {
    console.warn(`[sei] portrait cache write failed for ${uuid}: ${(err as Error).message}`);
  }
}

async function prune(dir: string, uuid: string, keepTag: string): Promise<void> {
  const names = (await readdir(dir)).filter((n) => n.endsWith('.png') && n.includes('@'));
  const keep = `${uuid}@${keepTag}.png`;
  // Older versions of this character.
  const stale = names.filter((n) => n.startsWith(`${uuid}@`) && n !== keep);
  for (const n of stale) await unlink(path.join(dir, n)).catch(() => {});
  const rest = names.filter((n) => !stale.includes(n));
  if (rest.length <= MAX_ENTRIES) return;
  const withTimes = await Promise.all(
    rest.map(async (n) => ({ n, t: (await stat(path.join(dir, n)).catch(() => null))?.mtimeMs ?? 0 })),
  );
  withTimes.sort((a, b) => a.t - b.t);
  for (const { n } of withTimes.slice(0, rest.length - MAX_ENTRIES)) {
    if (n !== keep) await unlink(path.join(dir, n)).catch(() => {});
  }
}

export type PortraitDownloader = (owner: string, uuid: string) => Promise<Buffer | null>;

const inFlight = new Map<string, Promise<{ bytes: Buffer | null; downloaded: boolean }>>();

/**
 * A character's portrait bytes for `version`: from the cache when present
 * (no network), else ONE download (concurrent callers for the same uuid +
 * version share it) that is then cached. `downloaded` says whether the
 * network was used. A null version is never cached and always downloads.
 */
export function fetchPortraitOnce(
  download: PortraitDownloader,
  ownerUuid: string,
  uuid: string,
  version: string | null | undefined,
): Promise<{ bytes: Buffer | null; downloaded: boolean }> {
  const tag = versionTag(version);
  const key = `${uuid}@${tag ?? ''}`;
  const existing = tag ? inFlight.get(key) : undefined;
  if (existing) return existing;
  const p = (async () => {
    const cached = await readCachedPortrait(uuid, version);
    if (cached) return { bytes: cached, downloaded: false };
    const bytes = await download(ownerUuid, uuid);
    if (bytes) await storeCachedPortrait(uuid, version, bytes);
    return { bytes, downloaded: true };
  })();
  if (!tag) return p;
  inFlight.set(key, p);
  void p.finally(() => inFlight.delete(key)).catch(() => {});
  return p;
}
