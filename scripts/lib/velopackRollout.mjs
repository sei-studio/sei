// Set the staged rollout of a Velopack release, or the NSIS -> Velopack
// migration switch, in a feed (261030). Used by velopack-rollout.yml.
//
//   kind update:    rollout.<channel>.json { version, percent }
//                   The client holds <version> back unless its install falls
//                   in the first <percent> buckets. Any other version, or no
//                   file, is open to everyone; percent 100 = fully out.
//   kind migration: migration.<channel>.json { percent, epoch }
//                   NSIS installs in the first <percent> buckets move to
//                   Velopack. No file or percent 0 = nobody moves. A higher
//                   epoch gives installs that gave up three more tries.

import { compareVersions, INDEX_CACHE_CONTROL, migrationRule, parseReleases, parseSetupManifest, rolloutRule } from './velopackFeed.mjs';
import { getJson } from './velopackStore.mjs';

export async function setRollout({ store, channel, kind, version, percent, epoch, log = console.log }) {
  if (channel !== 'win' && channel !== 'beta') throw new Error(`channel must be win or beta, got ${channel}`);
  if (kind === 'update') {
    const rule = rolloutRule(version, percent);
    const idx = await getJson(store, `releases.${channel}.json`);
    const releases = idx ? parseReleases(idx) : null;
    if (!releases || !releases.Assets.some((a) => a.Type === 'Full' && a.Version === version)) {
      throw new Error(`${version} is not in releases.${channel}.json of ${store.describe}; mirror the release first`);
    }
    const prev = await getJson(store, `rollout.${channel}.json`);
    if (prev && typeof prev.version === 'string' && compareVersions(version, prev.version) < 0 && prev.percent < 100) {
      log(`note: replacing the rollout of ${prev.version} (${prev.percent}%), which is NEWER than ${version}; ${prev.version} becomes open to everyone`);
    }
    await store.putJson(`rollout.${channel}.json`, rule, { cacheControl: INDEX_CACHE_CONTROL });
    log(`rollout.${channel}.json = ${JSON.stringify(rule)} (${store.describe})`);
    return rule;
  }
  if (kind === 'migration') {
    const prev = await getJson(store, `migration.${channel}.json`);
    const e = epoch === undefined || epoch === '' ? (Number.isInteger(prev?.epoch) ? prev.epoch : 0) : epoch;
    const rule = migrationRule(percent, e);
    if (rule.percent > 0) {
      const setup = await getJson(store, `setup.${channel}.json`);
      if (!setup) throw new Error(`no setup.${channel}.json in ${store.describe}; mirror a release with a Setup first`);
      parseSetupManifest(setup);
    }
    await store.putJson(`migration.${channel}.json`, rule, { cacheControl: INDEX_CACHE_CONTROL });
    log(`migration.${channel}.json = ${JSON.stringify(rule)} (${store.describe})`);
    return rule;
  }
  throw new Error(`kind must be update or migration, got ${kind}`);
}
