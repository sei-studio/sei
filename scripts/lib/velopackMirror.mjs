// Mirror one release's Velopack assets into a feed and merge its index
// (261030). Used by mirror-release.yml (into R2 behind dl.sei.gg) and by
// velopack-update.yml (into a local folder the CI scenarios serve).
//
// Order matters, as in the electron-updater mirror: packages and the Setup go
// up FIRST, then releases.<channel>.json, then setup.<channel>.json, so a
// client never reads an index that names a file that is not there yet.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  CHANNELS,
  INDEX_CACHE_CONTROL,
  PACKAGE_CACHE_CONTROL,
  emptyReleases,
  mergeReleases,
  parseReleases,
  parseSetupManifest,
  setupKey,
  shouldReplaceSetup,
} from './velopackFeed.mjs';
import { getJson } from './velopackStore.mjs';

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** The Velopack files among a release's assets (the NSIS installer and ymls are not). */
export function velopackAssetNames(names) {
  return names.filter(
    (n) =>
      n.endsWith('.nupkg') ||
      /^releases\.[a-z]+\.json$/.test(n) ||
      /^setup\.[a-z]+\.json$/.test(n) ||
      /^Sei-[a-z]+-Setup\.exe$/.test(n),
  );
}

export async function mirrorRelease({ assetsDir, tag, store, log = console.log }) {
  const names = readdirSync(assetsDir);
  const channels = CHANNELS.filter((ch) => names.includes(`releases.${ch}.json`));
  if (channels.length === 0) {
    log(`no Velopack assets in ${assetsDir}; nothing to mirror`);
    return { channels: [] };
  }
  const summary = { channels, uploaded: [], dropped: {}, setup: {} };
  for (const ch of channels) {
    const incoming = parseReleases(readFileSync(path.join(assetsDir, `releases.${ch}.json`), 'utf8'));
    if (incoming.Assets.length === 0) throw new Error(`releases.${ch}.json lists no assets`);
    for (const a of incoming.Assets) {
      const f = path.join(assetsDir, a.FileName);
      if (!existsSync(f)) throw new Error(`releases.${ch}.json names ${a.FileName}, which is not among the assets`);
      if (a.Size && statSync(f).size !== a.Size) throw new Error(`${a.FileName}: size ${statSync(f).size}, index says ${a.Size}`);
      if (a.SHA256 && sha256(f).toLowerCase() !== String(a.SHA256).toLowerCase()) throw new Error(`${a.FileName}: sha256 does not match the index`);
    }

    let setup = null;
    if (names.includes(`setup.${ch}.json`)) {
      setup = parseSetupManifest(readFileSync(path.join(assetsDir, `setup.${ch}.json`), 'utf8'));
      if (setup.tag !== tag) throw new Error(`setup.${ch}.json is for ${setup.tag}, mirroring ${tag}`);
      const f = path.join(assetsDir, setup.file);
      if (!existsSync(f)) throw new Error(`setup.${ch}.json names ${setup.file}, which is not among the assets`);
      if (statSync(f).size !== setup.size || sha256(f) !== setup.sha256) throw new Error(`${setup.file} does not match setup.${ch}.json`);
    }

    // 1. packages, flat
    for (const a of incoming.Assets) {
      await store.putFile(a.FileName, path.join(assetsDir, a.FileName), { cacheControl: PACKAGE_CACHE_CONTROL });
      summary.uploaded.push(a.FileName);
    }
    // 2. the Setup, under its tag
    if (setup) {
      await store.putFile(setupKey(setup), path.join(assetsDir, setup.file), { cacheControl: PACKAGE_CACHE_CONTROL });
      summary.uploaded.push(setupKey(setup));
    }
    // 3. the merged index
    const existingJson = await getJson(store, `releases.${ch}.json`);
    const existing = existingJson ? parseReleases(existingJson) : emptyReleases();
    const { releases, dropped } = mergeReleases(existing, incoming);
    await store.putJson(`releases.${ch}.json`, releases, { cacheControl: INDEX_CACHE_CONTROL });
    summary.dropped[ch] = dropped;
    log(`${ch}: index now lists ${new Set(releases.Assets.map((a) => a.Version)).size} versions${dropped.length ? `, unlisted ${dropped.join(', ')}` : ''}`);
    // 4. the setup manifest, never backwards
    if (setup) {
      const prev = await getJson(store, `setup.${ch}.json`);
      let prevManifest = null;
      try {
        prevManifest = prev ? parseSetupManifest(prev) : null;
      } catch {
        prevManifest = null;
      }
      if (shouldReplaceSetup(prevManifest, setup)) {
        await store.putJson(`setup.${ch}.json`, setup, { cacheControl: INDEX_CACHE_CONTROL });
        summary.setup[ch] = setup.version;
      } else {
        log(`${ch}: setup.${ch}.json stays at ${prevManifest.version} (newer than ${setup.version})`);
        summary.setup[ch] = prevManifest.version;
      }
    }
  }
  return summary;
}
