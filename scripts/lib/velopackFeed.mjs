// Velopack feed helpers for the release scripts (261030). Pure and
// dependency-free: the mirror and rollout scripts run on bare runners with no
// npm ci.
//
// A feed is the folder Sei's Velopack updater reads (dl.sei.gg/velopack/):
//   releases.<channel>.json   Velopack's own index: { Assets: [...] }
//   <package>.nupkg           every package the index names, flat
//   setup/<tag>/<Setup.exe>   the installer, for the NSIS -> Velopack migration
//   setup.<channel>.json      { version, tag, file, sha256, size } of the newest Setup
//   rollout.<channel>.json    { version, percent } staged rollout of one version
//   migration.<channel>.json  { percent, epoch } NSIS -> Velopack migration switch
//
// Channels: `win` is stable (vpk's default name on Windows), `beta` is the
// advanced-updates channel.

export const CHANNELS = ['win', 'beta'];
/** Versions kept in a merged releases.<channel>.json. Older packages stay in the bucket, unlisted. */
export const KEEP_VERSIONS = 20;

/** semver-ish compare: a stable outranks its own prerelease. Mirrors src/main/velopackFastApply.ts. */
export function compareVersions(a, b) {
  const parse = (v) => {
    const [main, ...pre] = String(v).replace(/^v/, '').split('-');
    return { nums: main.split('.').map((n) => Number.parseInt(n, 10) || 0), pre: pre.join('-') };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  const xa = pa.pre.split('.');
  const xb = pb.pre.split('.');
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    if (xa[i] === undefined) return -1;
    if (xb[i] === undefined) return 1;
    const na = Number(xa[i]);
    const nb = Number(xb[i]);
    if (Number.isFinite(na) && Number.isFinite(nb)) {
      if (na !== nb) return na < nb ? -1 : 1;
    } else if (xa[i] !== xb[i]) {
      return xa[i] < xb[i] ? -1 : 1;
    }
  }
  return 0;
}

export function isPrerelease(version) {
  return String(version).replace(/^v/, '').includes('-');
}

export function isValidVersion(version) {
  return /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(String(version));
}

/** Only a plain file name may land in the feed (no paths, no traversal). */
export function isSafeFileName(name) {
  return typeof name === 'string' && /^[0-9A-Za-z._-]+$/.test(name) && !name.startsWith('.');
}

/** Parses a releases.<channel>.json. Throws on a shape the updater could not read. */
export function parseReleases(json) {
  const obj = typeof json === 'string' ? JSON.parse(json) : json;
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.Assets)) throw new Error('releases json has no Assets array');
  for (const a of obj.Assets) {
    if (!a || typeof a !== 'object') throw new Error('releases json: asset is not an object');
    if (!isValidVersion(a.Version)) throw new Error(`releases json: bad Version ${a.Version}`);
    if (!isSafeFileName(a.FileName)) throw new Error(`releases json: bad FileName ${a.FileName}`);
    if (a.Type !== 'Full' && a.Type !== 'Delta') throw new Error(`releases json: bad Type ${a.Type}`);
  }
  return { ...obj, Assets: obj.Assets.slice() };
}

export function emptyReleases() {
  return { Assets: [] };
}

/** Highest version listed (Full assets only), or null. */
export function maxVersion(releases) {
  let max = null;
  for (const a of releases.Assets) {
    if (a.Type !== 'Full') continue;
    if (max === null || compareVersions(a.Version, max) > 0) max = a.Version;
  }
  return max;
}

/** The newest Full package strictly below `version`: the base vpk builds a delta from. */
export function previousFull(releases, version) {
  let best = null;
  for (const a of releases.Assets) {
    if (a.Type !== 'Full' || compareVersions(a.Version, version) >= 0) continue;
    if (best === null || compareVersions(a.Version, best.Version) > 0) best = a;
  }
  return best;
}

/** Only the assets of one version: what one GitHub release carries. */
export function onlyVersion(releases, version) {
  return { ...releases, Assets: releases.Assets.filter((a) => a.Version === version) };
}

function sortAssets(assets) {
  return assets.slice().sort((x, y) => compareVersions(x.Version, y.Version) || (x.Type === y.Type ? 0 : x.Type === 'Full' ? -1 : 1));
}

/**
 * Merges a release's assets into the feed's index. Same FileName: the incoming
 * one wins (a re-published release). Keeps the newest `keep` versions.
 */
export function mergeReleases(existing, incoming, keep = KEEP_VERSIONS) {
  const byName = new Map();
  for (const a of existing.Assets) byName.set(a.FileName, a);
  for (const a of incoming.Assets) byName.set(a.FileName, a);
  const all = sortAssets([...byName.values()]);
  const versions = [...new Set(all.map((a) => a.Version))].sort(compareVersions);
  const kept = new Set(versions.slice(-keep));
  return {
    releases: { ...existing, ...incoming, Assets: all.filter((a) => kept.has(a.Version)) },
    dropped: all.filter((a) => !kept.has(a.Version)).map((a) => a.FileName),
  };
}

/**
 * The channels a release is packed into. A prerelease is beta only. A stable
 * also goes into beta unless beta already has something at least as new, so
 * beta clients move onto a stable that passed them (the beta feed ordering
 * rule), and are never pulled back from a newer beta.
 */
export function channelsForRelease(version, betaMax) {
  if (isPrerelease(version)) return ['beta'];
  if (betaMax && compareVersions(betaMax, version) >= 0) return ['win'];
  return ['win', 'beta'];
}

export function parseSetupManifest(json) {
  const m = typeof json === 'string' ? JSON.parse(json) : json;
  if (!m || typeof m !== 'object') throw new Error('setup manifest is not an object');
  if (!isValidVersion(m.version)) throw new Error(`setup manifest: bad version ${m.version}`);
  if (typeof m.tag !== 'string' || !/^v[0-9A-Za-z.-]+$/.test(m.tag)) throw new Error(`setup manifest: bad tag ${m.tag}`);
  if (!isSafeFileName(m.file) || !m.file.endsWith('.exe')) throw new Error(`setup manifest: bad file ${m.file}`);
  if (typeof m.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(m.sha256)) throw new Error('setup manifest: bad sha256');
  if (!Number.isInteger(m.size) || m.size <= 0) throw new Error('setup manifest: bad size');
  return { version: m.version, tag: m.tag, file: m.file, sha256: m.sha256, size: m.size };
}

/** A new setup manifest replaces the published one only when it is at least as new. */
export function shouldReplaceSetup(existing, incoming) {
  return !existing || compareVersions(incoming.version, existing.version) >= 0;
}

export function setupKey(m) {
  return `setup/${m.tag}/${m.file}`;
}

/** rollout.<channel>.json, as the client reads it (velopackFastApply.parseRolloutRule). */
export function rolloutRule(version, percent) {
  if (!isValidVersion(version)) throw new Error(`bad version ${version}`);
  const p = Number(percent);
  if (!Number.isFinite(p) || p < 0 || p > 100) throw new Error(`percent must be 0..100, got ${percent}`);
  return { version, percent: p };
}

/** migration.<channel>.json, as the client reads it (velopackMigrationPolicy.parseMigrationRule). */
export function migrationRule(percent, epoch) {
  const p = Number(percent);
  if (!Number.isFinite(p) || p < 0 || p > 100) throw new Error(`percent must be 0..100, got ${percent}`);
  const e = Number(epoch);
  if (!Number.isInteger(e) || e < 0) throw new Error(`epoch must be a whole number, got ${epoch}`);
  return { percent: p, epoch: e };
}

/** Cache-Control for the small index files: short, so a rollout change lands within a minute. */
export const INDEX_CACHE_CONTROL = 'public, max-age=60';
/** Packages and installers never change under a name. */
export const PACKAGE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
