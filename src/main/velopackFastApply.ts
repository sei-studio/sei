/**
 * Fast Windows updates on Velopack (261030): pure helpers, no electron import,
 * so they unit-test on any host.
 *
 * Sei ships a patched Velopack Update.exe (build/velopack/, see its README)
 * with three additions this module drives:
 *
 *   `Update.exe stage --package <nupkg>`
 *       Extracts the downloaded package next to the app while Sei is still
 *       running, at background priority, into packages\SeiStaged\v<version>.
 *       It writes v<version>.ok only once the copy is complete and verified,
 *       so a killed or failed stage is simply ignored. It skips itself when
 *       the disk is short (last-result.txt says why).
 *   `apply ... --noHooks`
 *       Applies without app hooks and starts the new Sei right after the
 *       folder swap, before the bookkeeping. With a staged copy the swap is
 *       two renames, so the restart gap is roughly "Sei quits + Sei starts".
 *   `apply ... --seiOverlay <dir>`
 *       Shows <dir>'s frames (Sei's own launch splash with "Updating…",
 *       rendered by Sei) as a native topmost window, from before Update.exe
 *       waits for Sei to exit until the restarted Sei shows its own window.
 *
 * A stock Update.exe ignores the unknown flags (its parser has
 * ignore_errors), so an old updater still applies, just slowly.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';

/** Folder (inside the Velopack packages dir) the stage command writes to. */
export const STAGE_DIR = 'SeiStaged';
/** Folder (inside the packages dir) the overlay frames are written to. */
export const OVERLAY_DIR = 'SeiOverlay';
/** The overlay switches from "Updating…" to a time estimate after this. */
export const SLOW_AFTER_MS = 8000;
/** Time-estimate frames, in seconds. Anything longer shows the "few minutes" frame. */
export const ETA_BUCKETS = [10, 20, 30, 45, 60, 120] as const;
/** Longest Sei waits for a stage before it offers the restart anyway. */
export const STAGE_TIMEOUT_MS = 10 * 60 * 1000;
/** Longest the quitting Sei waits for the overlay to report it is on screen. */
export const OVERLAY_SHOWN_TIMEOUT_MS = 1500;

export interface VelopackPaths {
  /** %LOCALAPPDATA%\Sei (or wherever Setup.exe installed). */
  root: string;
  packagesDir: string;
  updateExe: string;
  stageDir: string;
  overlayDir: string;
}

/**
 * The install layout around a Velopack-installed Sei.exe, which always runs
 * from <root>\current\Sei.exe. Null for any other layout (NSIS, dev).
 */
export function velopackPathsFor(execPath: string, p: typeof path = path.win32): VelopackPaths | null {
  const bin = p.dirname(execPath);
  if (p.basename(bin).toLowerCase() !== 'current') return null;
  const root = p.dirname(bin);
  const packagesDir = p.join(root, 'packages');
  return {
    root,
    packagesDir,
    updateExe: p.join(root, 'Update.exe'),
    stageDir: p.join(packagesDir, STAGE_DIR),
    overlayDir: p.join(packagesDir, OVERLAY_DIR),
  };
}

export interface ApplyArgsInput {
  packagePath: string;
  waitPid: number;
  restart: boolean;
  root: string;
  packagesDir: string;
  /** Present: show the native overlay from this folder. */
  overlayDir?: string;
}

/** Arguments for Update.exe apply, the same base set the velopack npm package passes, plus Sei's flags. */
export function applyArgs(i: ApplyArgsInput): string[] {
  const args = ['apply', '--package', i.packagePath, '--waitPid', String(i.waitPid), '--silent'];
  if (!i.restart) args.push('--norestart');
  args.push('--root', i.root, '--packageDir', i.packagesDir, '--noHooks');
  if (i.overlayDir) args.push('--seiOverlay', i.overlayDir);
  return args;
}

export function stageArgs(packagePath: string, root: string, packagesDir: string): string[] {
  return ['stage', '--package', packagePath, '--silent', '--root', root, '--packageDir', packagesDir];
}

/** True when stage left a complete copy of `version` (its .ok marker). */
export function stagedMarkerName(version: string): string {
  return `v${version}.ok`;
}

export interface StageResult {
  outcome: 'ok' | 'skipped' | 'failed' | 'unknown';
  line: string;
}

/** Parses packages\SeiStaged\last-result.txt ("ok 0.7.1 staged in 9123 ms", "skipped 0.7.1: low disk ..."). */
export function parseStageResult(text: string | null | undefined): StageResult {
  const line = (text ?? '').trim();
  const word = line.split(/\s+/, 1)[0];
  if (word === 'ok' || word === 'skipped' || word === 'failed') return { outcome: word, line };
  return { outcome: 'unknown', line };
}

/* -------------------------------------------------------------------------- */
/*  Update screen text                                                         */
/* -------------------------------------------------------------------------- */

export type UpdateLang = 'en' | 'zh';

export interface UpdateScreenText {
  updating: string;
  error: string;
  /** Keyed by frame name: eta-10 .. eta-120, eta-long. */
  eta: Record<string, string>;
}

/**
 * The status line under the logo. Short on purpose: it sits in a 320 px wide
 * splash. The time estimate only appears when an update is slower than
 * expected (see SLOW_AFTER_MS); it keeps "Updating…" so the line never reads
 * as a different screen.
 */
export function updateScreenText(lang: UpdateLang): UpdateScreenText {
  const zh = lang === 'zh';
  const updating = zh ? '正在更新…' : 'Updating…';
  const eta: Record<string, string> = {};
  for (const s of ETA_BUCKETS) {
    let rest: string;
    if (s < 60) rest = zh ? `大约还需 ${s} 秒` : `about ${s} seconds left`;
    else if (s === 60) rest = zh ? '大约还需 1 分钟' : 'about a minute left';
    else rest = zh ? `大约还需 ${s / 60} 分钟` : `about ${s / 60} minutes left`;
    eta[`eta-${s}`] = zh ? `${updating}${rest}` : `${updating} ${rest}`;
  }
  eta['eta-long'] = zh ? `${updating}还需几分钟` : `${updating} a few more minutes`;
  return {
    updating,
    error: zh ? '更新失败，正在打开 Sei…' : "Couldn't update. Opening Sei…",
    eta,
  };
}

/** Every overlay frame: name -> status line. `updating` is required by Update.exe. */
export function overlayFrames(lang: UpdateLang): Record<string, string> {
  const t = updateScreenText(lang);
  return { updating: t.updating, error: t.error, ...t.eta };
}

/** <overlayDir>\overlay.txt for Update.exe: position in physical pixels plus frame files. */
export function overlaySpec(x: number, y: number, frameNames: readonly string[], slowAfterMs = SLOW_AFTER_MS): string {
  const lines = [`x=${Math.round(x)}`, `y=${Math.round(y)}`, `slowAfterMs=${slowAfterMs}`];
  for (const n of frameNames) lines.push(`frame.${n}=${n}.png`);
  return lines.join('\n') + '\n';
}

/**
 * True when a rendered overlay frame looks like the splash: mostly transparent
 * (the page has no backdrop) with some opaque ink (the logo). `pixels` is
 * 4 bytes per pixel with alpha last (BGRA or RGBA). An offscreen window's
 * first paint can be solid white before the page commits (CI run 41028220016:
 * 3 of 8 runs cached a white `updating` frame and the overlay showed a white
 * box), and a capture before the logo decodes is fully transparent.
 */
export function overlayFrameLooksRight(pixels: Uint8Array): boolean {
  const n = Math.floor(pixels.length / 4);
  if (n === 0) return false;
  let clear = 0;
  let ink = 0;
  for (let i = 3; i < n * 4; i += 4) {
    const a = pixels[i];
    if (a < 16) clear++;
    else if (a > 200) ink++;
  }
  return clear / n >= 0.3 && ink / n >= 0.005;
}

/* -------------------------------------------------------------------------- */
/*  Launch during an apply                                                     */
/* -------------------------------------------------------------------------- */

/** An applying.pid older than this is stale (an apply never takes this long). */
export const APPLYING_MARKER_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * True when Update.exe is applying right now, so a Sei launched by the user
 * must not start (it would hold files the swap renames, or be killed by it).
 * It leaves a relaunch request instead, which the apply honours.
 */
export function applyInProgress(
  markerText: string | null,
  markerMtimeMs: number,
  nowMs: number,
  isAlive: (pid: number) => boolean,
): boolean {
  if (markerText == null) return false;
  const pid = Number.parseInt(markerText.trim(), 10);
  if (!Number.isFinite(pid) || pid <= 0) return false;
  if (nowMs - markerMtimeMs > APPLYING_MARKER_MAX_AGE_MS) return false;
  return isAlive(pid);
}

/**
 * The image name in `tasklist /FI "PID eq N" /FO CSV /NH` output, or null
 * when the pid is not listed (tasklist then prints an INFO line).
 */
export function tasklistImage(out: string | null | undefined): string | null {
  const m = /^"([^"]+)","(\d+)"/m.exec(out ?? '');
  return m ? m[1] : null;
}

/** applying.pid is written by Update.exe itself (sei_fast::mark_applying). */
export function isUpdaterImage(image: string): boolean {
  return /^(update|squirrel)\.exe$/i.test(image);
}

/** A relaunch request older than this, with no apply running, is a leftover. */
export const RELAUNCH_LEFTOVER_AGE_MS = 30 * 1000;

/* -------------------------------------------------------------------------- */
/*  Staged rollout                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Optional rollout.<channel>.json next to the Velopack feed, the equivalent of
 * electron-updater's stagingPercentage: `{ "version": "0.7.1", "percent": 20 }`
 * offers 0.7.1 to 20% of installs. No file (or another version) = everyone.
 */
export interface RolloutRule {
  version: string;
  percent: number;
}

export function parseRolloutRule(json: unknown): RolloutRule | null {
  if (!json || typeof json !== 'object') return null;
  const r = json as { version?: unknown; percent?: unknown };
  if (typeof r.version !== 'string' || typeof r.percent !== 'number' || !Number.isFinite(r.percent)) return null;
  return { version: r.version, percent: Math.max(0, Math.min(100, r.percent)) };
}

/** Stable 0..99 bucket for this install and version, so each version samples a different 20%. */
export function rolloutBucket(installId: string, version: string): number {
  const h = createHash('sha256').update(`${installId}:${version}`).digest();
  return h.readUInt32BE(0) % 100;
}

export function rolloutAllows(rule: RolloutRule | null, targetVersion: string, installId: string): boolean {
  if (!rule || rule.version !== targetVersion) return true;
  if (rule.percent >= 100) return true;
  return rolloutBucket(installId, targetVersion) < rule.percent;
}

/* -------------------------------------------------------------------------- */
/*  Applying a pending update at launch                                        */
/* -------------------------------------------------------------------------- */

/** A launch-time apply of the same version is attempted at most this often before it waits for a fresh download. */
export const MAX_LAUNCH_APPLY_ATTEMPTS = 2;

export interface LaunchApplyState {
  version: string;
  attempts: number;
}

/**
 * Should this launch apply the pending (downloaded and staged) update before
 * Sei starts? Not right after Update.exe restarted us (that apply just ran;
 * if we are still old, it failed), and not after repeated failed attempts at
 * the same version (no update loop).
 */
export function shouldApplyAtLaunch(
  pendingVersion: string | null,
  currentVersion: string,
  staged: boolean,
  restartedByUpdater: boolean,
  state: LaunchApplyState | null,
): boolean {
  if (!pendingVersion || !staged || restartedByUpdater) return false;
  if (compareVersions(pendingVersion, currentVersion) <= 0) return false;
  if (state && state.version === pendingVersion && state.attempts >= MAX_LAUNCH_APPLY_ATTEMPTS) return false;
  return true;
}

/** Semver-ish compare (major.minor.patch, then prerelease: none > any). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): { nums: number[]; pre: string } => {
    const [main, ...pre] = v.replace(/^v/, '').split('-');
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
