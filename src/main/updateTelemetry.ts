/**
 * Update telemetry (261126, product call (261126) "fast updater"): pure
 * helpers, no electron import, so they unit-test on any host. updater.ts
 * captures the events; docs/agents/build-release.md lists them.
 *
 * Shape only: which updater, which stage, a closed error class, durations and
 * sizes. Never an error message, a path, a URL or a feed body.
 *
 *   update_downloaded {updater, to, level, download_ms, download_mb?, prepare_ms?}
 *   update_failed     {updater, stage, class}
 *   update_installed  {from, to, via, updater, install_s?, restart_ms?, progress_window?}
 */

/** Which update path a client is on. */
export type UpdaterKind = 'nsis' | 'velopack' | 'squirrel_mac' | 'appimage' | 'other';

export function updaterKind(platform: string, velopack: boolean): UpdaterKind {
  if (platform === 'win32') return velopack ? 'velopack' : 'nsis';
  if (platform === 'darwin') return 'squirrel_mac';
  if (platform === 'linux') return 'appimage';
  return 'other';
}

export type UpdateStage = 'check' | 'download' | 'prepare' | 'install';

export type UpdateErrorClass =
  | 'offline'
  | 'timeout'
  | 'http_4xx'
  | 'http_5xx'
  | 'checksum'
  | 'signature'
  | 'disk'
  | 'permission'
  | 'no_effect'
  | 'other';

/**
 * A closed class for an updater error message (electron-updater, Velopack,
 * Squirrel.Mac). The message itself never leaves the machine.
 */
export function classifyUpdateError(message: string): UpdateErrorClass {
  const m = message.toLowerCase();
  if (/signature|authenticode|code ?sign|not signed|publisher|designated requirement/.test(m)) return 'signature';
  if (/sha512|sha256|sha1|checksum|hash mismatch|integrity/.test(m)) return 'checksum';
  if (/enospc|no space|disk (is )?full|not enough (free )?space|low[- ]disk/.test(m)) return 'disk';
  if (/eacces|eperm|access is denied|permission|operation not permitted|read-only/.test(m)) return 'permission';
  if (/etimedout|timed? ?out|timeout/.test(m)) return 'timeout';
  const status = /(?:status(?: code)?|http)[^0-9]{0,12}([45]\d\d)\b/.exec(m) ?? /\b([45]\d\d)\b (?:not found|forbidden|bad gateway|service unavailable|internal server error|gateway)/.exec(m);
  if (status) return status[1].startsWith('4') ? 'http_4xx' : 'http_5xx';
  if (/enotfound|eai_again|econnrefused|econnreset|enetunreach|ehostunreach|net::err_|socket hang up|network|offline|getaddrinfo|dns/.test(m)) return 'offline';
  return 'other';
}

/**
 * One failure per stage and class per process: a background check that fails
 * offline on every focus must not become a stream of events.
 */
export class FailureDedupe {
  private seen = new Set<string>();
  first(stage: UpdateStage, cls: UpdateErrorClass): boolean {
    const k = `${stage}:${cls}`;
    if (this.seen.has(k)) return false;
    this.seen.add(k);
    return true;
  }
}

/** Bytes to megabytes with one decimal, or undefined when unknown. */
export function toMb(bytes: number | null | undefined): number | undefined {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return undefined;
  return Math.round(bytes / 1e5) / 10;
}

/** A duration in ms, or undefined when it cannot be right (clock moved, never started). */
export function durationMs(startedAt: number | null | undefined, now: number): number | undefined {
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return undefined;
  const d = now - startedAt;
  return d >= 0 && d < 24 * 3600 * 1000 ? Math.round(d) : undefined;
}

/** How a restart-to-update that started earlier ended, as seen by the next launch. */
export type InstallOutcome = { kind: 'installed'; ms: number } | { kind: 'no_effect' } | null;

/**
 * The next launch's view of a recorded restart-to-update. A launch on a NEW
 * version within 30 minutes is an install (its time in ms); a launch on the SAME
 * version within 30 minutes means the restart did not apply the update. Older
 * records say nothing (the machine slept, the user came back much later).
 */
export function installOutcome(
  timing: { startedAt: number; fromVersion: string } | null | undefined,
  currentVersion: string,
  now: number,
): InstallOutcome {
  if (!timing) return null;
  const ms = now - timing.startedAt;
  if (!(ms > 0) || ms > 30 * 60 * 1000) return null;
  if (timing.fromVersion === currentVersion) return { kind: 'no_effect' };
  return { kind: 'installed', ms: Math.round(ms) };
}
