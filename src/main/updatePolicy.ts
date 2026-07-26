/**
 * Update policy — pure decision functions for the in-app updater
 * (quick/260604-uoy).
 *
 * This module is INTENTIONALLY electron-free: it imports only `semver` so it
 * can run in dev (unpackaged, where `electron-updater`'s `autoUpdater` throws)
 * and under vitest. The `autoUpdater` wiring lives in `updater.ts` and is
 * guarded by `app.isPackaged`.
 *
 * Two policy levels, derived from semver alone — no manual urgency flag:
 *
 *   | bump from `current` → `latest` | level     | behavior                       |
 *   |--------------------------------|-----------|--------------------------------|
 *   | major or minor                 | optional  | ask first, changelog up front  |
 *   | patch only                     | mandatory | silent download, changelog after|
 *   | equal / downgrade / invalid    | none      | nothing                        |
 *
 * If a user is several versions behind (on 0.1.1, latest 0.2.0) the MINOR
 * differs → `optional`, and the skipped patch rides along inside it. The
 * mandatory/silent path triggers ONLY when major.minor are equal and only the
 * patch component moved forward.
 *
 * Source: .planning/quick/260604-uoy-... PLAN.md "Locked design".
 */
import semver from 'semver';

/** The policy level derived from comparing installed vs available versions. */
export type UpdateLevel = 'optional' | 'mandatory' | 'none';

/**
 * The mandatory-update apply timing carried by `version.json.apply`. Consulted
 * ONLY for mandatory (patch-only) updates; optional updates always ask first.
 *
 *   - `on-restart` (DEFAULT) — silent download, applies on next app quit via
 *     `autoInstallOnAppQuit`; changelog shown on next launch.
 *   - `now` — silent download, then an immediate forced restart.
 */
export type ApplyTiming = 'on-restart' | 'now';

/**
 * Coerce a raw version string (possibly `v`-prefixed) to a valid semver string,
 * or `null` if it cannot be parsed. `semver.valid` rejects `v0.1.2`; `coerce`
 * tolerates it — but `coerce` is lossy on prerelease tags, so we try `valid`
 * (after stripping a leading `v`) first and only fall back to `coerce`.
 */
function clean(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const stripped = raw.replace(/^v/i, '');
  if (semver.valid(stripped)) return stripped;
  const coerced = semver.coerce(raw);
  return coerced ? coerced.version : null;
}

/**
 * Map a `semver.diff` result (which may be `prepatch`/`preminor`/`premajor`
 * when a prerelease tag is involved) to one of the three base release levels.
 */
function baseDiff(from: string, to: string): 'major' | 'minor' | 'patch' | null {
  const d = semver.diff(from, to);
  if (!d) return null;
  if (d.endsWith('major')) return 'major';
  if (d.endsWith('minor')) return 'minor';
  // patch, prepatch, prerelease → treat as patch-level movement.
  return 'patch';
}

/**
 * Derive the update level from the installed `current` vs the available
 * `latest`. Returns `none` for equal versions, downgrades, or anything that
 * fails to parse (defensive — a malformed remote version must never trigger a
 * silent mandatory download).
 */
export function deriveLevel(current: string, latest: string): UpdateLevel {
  const cur = clean(current);
  const lat = clean(latest);
  if (!cur || !lat) return 'none';
  // Only ever act on a strictly-newer available version.
  if (!semver.gt(lat, cur)) return 'none';
  const level = baseDiff(cur, lat);
  if (level === 'patch') return 'mandatory';
  if (level === 'major' || level === 'minor') return 'optional';
  return 'none';
}

/**
 * True when `to` is strictly newer than `from` AND the move is patch-only
 * (major.minor unchanged). Drives both the mandatory/silent path and the
 * what's-new fallback (a patch bump means the user never saw a changelog up
 * front, so show it after the fact).
 */
export function isPatchOnlyBump(from: string, to: string): boolean {
  const f = clean(from);
  const t = clean(to);
  if (!f || !t) return false;
  if (!semver.gt(t, f)) return false;
  return baseDiff(f, t) === 'patch';
}

/**
 * Normalize the raw `version.json.apply` field to a known timing. Anything
 * absent, non-string, or unrecognized defaults to `on-restart` (the safe,
 * non-disruptive timing).
 */
export function normalizeApply(raw: unknown): ApplyTiming {
  return raw === 'now' ? 'now' : 'on-restart';
}

/**
 * Decide whether to show a post-update "what's new" popup as a FALLBACK, when
 * there is no stashed `pending` record matching the current version. We only
 * surface the fallback for a patch-only forward bump — minor/major bumps showed
 * their changelog up front (optional flow), so re-showing would be redundant.
 *
 * `lastSeen` is the version recorded on the previous launch; `cur` is
 * `app.getVersion()` now. Returns false when either is missing/invalid or when
 * the version did not actually move forward by a patch.
 */
export function shouldShowWhatsNew(lastSeen: string | null, cur: string): boolean {
  if (!lastSeen) return false;
  return isPatchOnlyBump(lastSeen, cur);
}

/**
 * True for the "the feed points at something with no installable build behind
 * it" family of electron-updater errors. Those must read as *no update*, not as
 * a failed check.
 *
 * A git tag is PUBLIC the moment it is pushed, and GitHub's `releases.atom`
 * (which electron-updater's GitHubProvider reads when `allowPrerelease` is on,
 * instead of the API) lists tags that have no published release. A draft
 * release is invisible, but its TAG is not — so between `git push --tags` and
 * publishing, the draft's tag is the newest feed entry, and every channel-file
 * request against it 404s because draft assets are not downloadable. Same shape
 * when a tag is pushed before its build finishes, or when the build fails.
 *
 * 260725: v0.5.0-beta.1 sat in draft for ~20 minutes and every beta-channel
 * client reported "check failed" for the whole window.
 *
 * Note this reports "up to date" rather than falling back to the newest tag
 * that DOES have assets — reproducing the provider's feed walk is not worth it
 * for a transient state. A published release genuinely missing its `.yml` would
 * also land here, so callers should log it.
 */
export function isMissingReleaseArtifacts(err: unknown): boolean {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  if (code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' || code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS') {
    return true;
  }
  // Fall back to the message: the `code` property is lost whenever the error
  // crosses a boundary that re-wraps it (or arrives as a plain string).
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return (
    /cannot find .*\.yml in the latest release artifacts/i.test(message) ||
    /no published versions/i.test(message)
  );
}
