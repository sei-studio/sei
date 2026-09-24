/**
 * Helper-mod version comparison (260925), shared by the Stardew and DST
 * installers. The mod a game pack ships can be newer than the copy already in
 * the game folder (an app update brings a new pack; the game keeps the old
 * mod), and the installers replace the installed copy only when the pack's is
 * newer.
 *
 * Versions are SMAPI-style semantic versions (manifest.json `Version`,
 * "0.1.1", "1.2.0-beta.3+build") or the plain dotted strings DST's
 * modinfo.lua carries ("0.2.0"). Numeric parts compare numerically, missing
 * parts count as 0 ("1.2" == "1.2.0"), a prerelease sorts before its release,
 * and build metadata is ignored, as in semver 2.0.
 */

interface ParsedVersion {
  parts: number[];
  pre: string[];
}

const VERSION_RE = /^\s*v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]*)?\s*$/;

export function parseModVersion(v: string | null | undefined): ParsedVersion | null {
  if (typeof v !== 'string') return null;
  const m = VERSION_RE.exec(v);
  if (!m) return null;
  return { parts: m[1].split('.').map((n) => Number(n)), pre: m[2] ? m[2].split('.') : [] };
}

function comparePre(a: string[], b: string[]): number {
  // No prerelease outranks any prerelease of the same core version.
  if (a.length === 0 || b.length === 0) return a.length === b.length ? 0 : a.length === 0 ? 1 : -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const an = /^\d+$/.test(a[i]);
    const bn = /^\d+$/.test(b[i]);
    if (an && bn) {
      const d = Number(a[i]) - Number(b[i]);
      if (d !== 0) return Math.sign(d);
    } else if (an !== bn) {
      return an ? -1 : 1;
    } else if (a[i] !== b[i]) {
      return a[i] < b[i] ? -1 : 1;
    }
  }
  return 0;
}

/** -1 / 0 / 1 like a sort comparator, or null when either side is not a version. */
export function compareModVersions(a: string | null | undefined, b: string | null | undefined): -1 | 0 | 1 | null {
  const pa = parseModVersion(a);
  const pb = parseModVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < Math.max(pa.parts.length, pb.parts.length); i++) {
    const d = (pa.parts[i] ?? 0) - (pb.parts[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return comparePre(pa.pre, pb.pre) as -1 | 0 | 1;
}

/**
 * Should the pack's copy replace the installed one? Yes when the pack's
 * version is newer, or when the installed copy has no readable version (a
 * hand-edited or half-written manifest; the pack's copy is the known-good
 * one). Never when the pack's own version is unreadable: without it there is
 * nothing to say the pack is newer, and a downgrade is worse than keeping
 * what works.
 */
export function packModIsNewer(packVersion: string | null | undefined, installedVersion: string | null | undefined): boolean {
  if (!parseModVersion(packVersion)) return false;
  if (!parseModVersion(installedVersion)) return true;
  return compareModVersions(packVersion, installedVersion) === 1;
}
