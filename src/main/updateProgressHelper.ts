/**
 * Sei's own progress window for the Windows in-app update (261030).
 *
 * The NSIS install that follows "Update Sei" takes a median ~104 s on real
 * machines (IQR 77-173 s), and Sei cannot draw anything during it: the
 * installer closes the app and overwrites its files. So the window lives in a
 * separate, tiny process that owns nothing inside the install folder:
 *
 *   powershell.exe (Windows' own, Microsoft-signed, on every Windows 10/11)
 *   running resources/update-progress/update-progress.ps1, a WPF window.
 *   The script, two fonts, the logo and the icon are COPIED to a fresh
 *   %TEMP%\sei-update-progress-XXXX first, and the process starts with that
 *   folder as its cwd, so it holds no file or directory handle under the
 *   install folder and the installer can replace everything.
 *
 * Why PowerShell + WPF and not a native helper exe: Sei's Windows build is
 * unsigned, so a bundled exe would be an unknown unsigned binary started from
 * %TEMP%, which is what Defender's cloud heuristics flag. powershell.exe is
 * signed by Microsoft and Sei already starts it (hostClient.ts reads LAN
 * host command lines with it). WPF loads a TTF from a file, draws gradients
 * and runs storyboard animations on the GPU, and needs no runtime download
 * (WebView2 is not guaranteed on Windows 10). SmartScreen never runs here:
 * it checks files carrying a download mark, and these are copies Sei made.
 *
 * Fail safe: launchUpdateProgressHelper resolves `ready: true` only once the
 * window has drawn its first frame (the script writes `ready` into its folder
 * from ContentRendered). Anything else (spawn error, the script exiting
 * nonzero, the window process writing `failed`, a Group Policy or
 * Constrained Language Mode block, no `ready` within READY_TIMEOUT_MS, or
 * READY_LOADED_CAP_MS once the window process has loaded WPF) writes `cancel`, kills both stages and resolves `ready: false`, and updater.ts
 * runs the visible stock installer instead, exactly as before.
 *
 * Two stages: the script Sei starts only re-launches itself with -Detached
 * (Start-Process, hidden) and exits 0. That grandchild is the window and
 * records its pid. See the spawn below for why.
 *
 * Progress is time-based: an installer run silently exposes nothing to read.
 * This module computes the whole plan (bar curve, status lines, copy) and
 * hands it to the script as JSON, so the script only plays it back and reacts
 * to two real events: the new Sei process appearing, then its first window.
 *
 * Pure node (no electron import) so it unit-tests on any host; updater.ts
 * supplies the Electron-specific inputs.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Default install estimate: the measured real-user median (261030). */
export const DEFAULT_INSTALL_SECONDS = 100;
/** Estimates are clamped here, so one odd sample cannot promise 10 s or 20 min. */
export const MIN_ESTIMATE_SECONDS = 45;
export const MAX_ESTIMATE_SECONDS = 300;
/**
 * How long the app waits for the window's first frame before falling back.
 * Measured on windows-latest (a cold 2-4 vCPU VM): 4.5-6.4 s from spawn to
 * first frame (two PowerShell starts, WPF load and XAML parse), 10.8-12.2 s
 * while a freshly installed Sei was running and being scanned. Real failures
 * end sooner (nonzero exit, `failed`).
 */
export const READY_TIMEOUT_MS = 12_000;
/**
 * Hard cap when the window process has already loaded WPF (`loaded`) by
 * READY_TIMEOUT_MS: it is past every policy block and only building the
 * window (about 3-4 s on the runner), so it gets this long in total.
 */
export const READY_LOADED_CAP_MS = 20_000;
/** Helper folders older than this are swept on the next launch. */
const STALE_DIR_MS = 60 * 60 * 1000;
const DIR_PREFIX = 'sei-update-progress-';

/** Files copied out of resources/update-progress (relative paths). */
export const HELPER_FILES = [
  'update-progress.ps1',
  'sei-text.png',
  'icon-64.png',
  'fonts/sei-oswald-600.ttf',
  'fonts/sei-rajdhani-500.ttf',
  'fonts/sei-rajdhani-600.ttf',
] as const;

export type HelperLang = 'en' | 'zh';
export type HelperTheme = 'midnight' | 'ice' | 'acorn' | 'mint';

/** Every line the window can show. Plain and short (prompt-writing-style). */
export interface HelperCopy {
  title: string;
  subtitle: string;
  /** `{n}` = whole minutes, 2 or more. */
  minutes: string;
  oneMinute: string;
  underMinute: string;
  seconds: string;
  almost: string;
  longer: string;
  opening: string;
  failed: string;
}

export const HELPER_COPY: Record<HelperLang, HelperCopy> = {
  en: {
    title: 'Updating',
    subtitle: "Sei reopens by itself when it's done.",
    minutes: 'About {n} minutes left',
    oneMinute: 'About a minute left',
    underMinute: 'Less than a minute left',
    seconds: 'A few seconds left',
    almost: 'Almost done',
    longer: 'Taking a little longer than usual',
    opening: 'Opening Sei',
    failed: "Sei didn't reopen. Open it from the Start menu.",
  },
  zh: {
    title: '正在更新',
    subtitle: '更新完成后 Sei 会自动重新打开。',
    minutes: '大约还剩 {n} 分钟',
    oneMinute: '大约还剩 1 分钟',
    underMinute: '还剩不到 1 分钟',
    seconds: '还剩几秒',
    almost: '马上就好',
    longer: '比平时慢一点，请稍候',
    opening: '正在打开 Sei',
    failed: 'Sei 没有自动打开，请从开始菜单打开。',
  },
};

/**
 * This machine's estimate: the median of its last (up to 3) measured
 * installs, else the real-user median. Clamped to [45, 300] s.
 */
export function estimateInstallSeconds(history: readonly number[] | undefined): number {
  const recent = (history ?? []).filter((s) => Number.isFinite(s) && s >= 10 && s <= 1800).slice(-3);
  if (recent.length === 0) return DEFAULT_INSTALL_SECONDS;
  const sorted = [...recent].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(Math.min(MAX_ESTIMATE_SECONDS, Math.max(MIN_ESTIMATE_SECONDS, median)));
}

/**
 * The share of the whole update that is already done when the window opens.
 * The window only starts after electron-updater has downloaded the update and
 * verified it (sha512, signature): `installerPath` is set at that point and
 * not before. For most users that download is the longer half of the update,
 * so the bar opens with it counted as done work instead of starting from
 * nothing. With no completed download the bar starts at 0 (no fake progress).
 */
export const DOWNLOAD_DONE_SHARE = 0.4;
/** How long the opening fill to DOWNLOAD_DONE_SHARE takes (ease-out). Instant with reduced motion. */
export const OPENING_FILL_SEC = 0.5;

/**
 * Bar position (0..1) at `t` seconds for an estimate of `e` seconds, starting
 * from `start` (DOWNLOAD_DONE_SHARE after a completed download, else 0).
 *
 * Harrison et al., "Rethinking the Progress Bar" (UIST 2007): what people
 * remember is the peak and the end; pauses or stalls near the end are the
 * worst behavior, and a fast finish is the most favored. So the install part
 * is front-loaded against the estimate and never flat:
 *   - start 0: a short burst (12% with a 3 s time constant) answers the click,
 *     then ~45% at half the estimate, ~70% at the estimate, ~85% at 1.7x;
 *   - start > 0: the opening fill already answered the click, so no burst; the
 *     same exponential approach runs over the remaining share: ~65% at half
 *     the estimate, ~80% at the estimate, ~90% at 1.7x (the slow quartile).
 * It never reaches CURVE_CAP, so the bar cannot sit full before the install
 * is done. The script sprints the rest (to 100%) only when the new Sei window
 * is up: the fast, real finish the study favors. Monotonic in t, so with the
 * script's max() guard it never moves backwards.
 */
export const CURVE_CAP = 0.97;
export function progressAt(t: number, e: number, start = 0): number {
  const s0 = Math.min(0.9, Math.max(0, start));
  if (!(t > 0)) return s0;
  const approach = 1 - Math.exp(-t / e / 0.9);
  if (s0 > 0) return Math.min(CURVE_CAP, s0 + (1 - s0) * 0.98 * approach);
  const burst = 0.12 * (1 - Math.exp(-t / 3));
  return Math.min(CURVE_CAP, burst + 0.86 * approach);
}

/**
 * The status line at `t` seconds. Rounded buckets rather than a ticking
 * countdown: the estimate is a median, and a clock that hits zero and keeps
 * waiting reads as a lie. Past the estimate it says so plainly.
 */
export function statusAt(t: number, e: number, copy: HelperCopy): string {
  const r = e - t;
  if (r >= 90) return copy.minutes.replace('{n}', String(Math.max(2, Math.round(r / 60))));
  if (r >= 45) return copy.oneMinute;
  if (r >= 12) return copy.underMinute;
  if (r >= 0) return copy.seconds;
  if (-r <= Math.max(20, e * 0.25)) return copy.almost;
  return copy.longer;
}

export interface HelperPlan {
  estimateSec: number;
  /** Bar position when the window opens (DOWNLOAD_DONE_SHARE or 0). */
  startShare: number;
  /** Seconds the opening fill to startShare takes (the script skips it with reduced motion). */
  openingFillSec: number;
  /** [seconds, bar 0..1], 1 s apart, through 4x the estimate (then hold). */
  curve: Array<[number, number]>;
  /** [seconds, line]: the line from each time on, only where it changes. */
  status: Array<[number, string]>;
}

export function buildPlan(estimateSec: number, copy: HelperCopy, startShare = 0): HelperPlan {
  const end = Math.ceil(estimateSec * 4);
  const curve: Array<[number, number]> = [];
  const status: Array<[number, string]> = [];
  for (let t = 0; t <= end; t++) {
    curve.push([t, Math.round(progressAt(t, estimateSec, startShare) * 10000) / 10000]);
    const line = statusAt(t, estimateSec, copy);
    if (status.length === 0 || status[status.length - 1][1] !== line) status.push([t, line]);
  }
  return { estimateSec, startShare, openingFillSec: startShare > 0 ? OPENING_FILL_SEC : 0, curve, status };
}

export interface HelperConfig {
  lang: HelperLang;
  theme: HelperTheme;
  copy: HelperCopy;
  plan: HelperPlan;
  /** Version being installed without a "v" (the window shows "v0.7.0"); empty hides it. */
  version: string;
  /** Process name (no .exe) of the installer electron-updater starts. */
  installerName: string;
  /** Process name (no .exe) of the app, "Sei". */
  appName: string;
  /** The installed Sei.exe, started by the script only if the installer
   *  exits and no Sei comes back by itself. '' = never. */
  appExe: string;
  /** Seconds to wait for the installer process before giving up. */
  installerWaitSec: number;
}

/** The window's theme from UserConfig.theme_mode ('system' follows the OS). */
export function resolveHelperTheme(mode: string | undefined, osDark: boolean): HelperTheme {
  if (mode === 'midnight' || mode === 'ice' || mode === 'acorn' || mode === 'mint') return mode;
  if (mode === 'dark') return 'midnight';
  if (mode === 'light') return 'ice';
  return osDark ? 'midnight' : 'ice';
}

/** The window's language from UserConfig.ui_language (absent = en). */
export function resolveHelperLang(uiLanguage: string | undefined): HelperLang {
  return uiLanguage === 'zh' ? 'zh' : 'en';
}

export interface HelperConfigInputs {
  themeMode?: string;
  osDark: boolean;
  uiLanguage?: string;
  /** UpdateState.installSeconds. */
  history?: readonly number[];
  version: string;
  installerPath: string;
  appExe: string;
  /** The update is downloaded and verified (the installer file exists). */
  downloaded?: boolean;
}

/** Everything the script needs, from plain inputs (pure). */
export function buildHelperConfig(i: HelperConfigInputs): HelperConfig {
  const lang = resolveHelperLang(i.uiLanguage);
  const copy = HELPER_COPY[lang];
  return {
    lang,
    theme: resolveHelperTheme(i.themeMode, i.osDark),
    copy,
    plan: buildPlan(estimateInstallSeconds(i.history), copy, i.downloaded ? DOWNLOAD_DONE_SHARE : 0),
    version: i.version.replace(/^v/, ''),
    installerName: processNameOf(i.installerPath),
    appName: processNameOf(i.appExe),
    appExe: i.appExe,
    installerWaitSec: 25,
  };
}

/**
 * Process name Windows reports for an executable path (Get-Process -Name).
 */
export function processNameOf(exePath: string): string {
  return path.win32.basename(exePath).replace(/\.exe$/i, '');
}

export interface LaunchOptions {
  /** Folder holding update-progress.ps1 and its assets. */
  resourcesDir: string;
  /** Parent folder for the private copy (os.tmpdir()). */
  tmpRoot: string;
  config: HelperConfig;
  readyTimeoutMs?: number;
  /** Total budget when `loaded` exists at readyTimeoutMs (READY_LOADED_CAP_MS). */
  readyCapMs?: number;
  /** Test seams. The defaults start Windows PowerShell. */
  command?: string;
  args?: (scriptPath: string, configPath: string) => string[];
  spawnImpl?: typeof spawn;
}

export interface HelperHandle {
  ready: boolean;
  /** Why it is not ready ('' when ready). Logged by the caller. */
  reason: string;
  /** The private %TEMP% folder (holds helper.log / result.json). */
  dir: string;
  /** Close the window now (the install did not start after all). */
  kill(): void;
}

/** Windows PowerShell 5.1 by absolute path, never whatever is first on PATH. */
export function powershellPath(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot || env.SYSTEMROOT || env.windir || 'C:\\Windows';
  return path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export function powershellArgs(scriptPath: string, configPath: string): string[] {
  return [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    // A process-scope override for this one unsigned script file. A Group
    // Policy execution policy still wins over it; then the script never
    // starts, `ready` never comes, and the stock installer window shows.
    '-ExecutionPolicy',
    'Bypass',
    '-STA',
    '-File',
    scriptPath,
    '-ConfigPath',
    configPath,
  ];
}

/** Remove helper folders left by earlier updates (best effort). */
export function sweepStaleHelperDirs(tmpRoot: string, now = Date.now()): void {
  let entries: string[];
  try {
    entries = readdirSync(tmpRoot);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(DIR_PREFIX)) continue;
    const full = path.join(tmpRoot, name);
    try {
      if (now - statSync(full).mtimeMs > STALE_DIR_MS) rmSync(full, { recursive: true, force: true });
    } catch {
      // In use or already gone.
    }
  }
}

function copyHelperFiles(resourcesDir: string, dir: string): void {
  for (const rel of HELPER_FILES) {
    const to = path.join(dir, rel);
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(path.join(resourcesDir, rel), to);
  }
}

/**
 * Copy the helper out, start it, and wait for its first frame. Never throws:
 * every failure resolves `{ ready: false }` with the process gone.
 */
export async function launchUpdateProgressHelper(opts: LaunchOptions): Promise<HelperHandle> {
  const timeoutMs = opts.readyTimeoutMs ?? READY_TIMEOUT_MS;
  const capMs = Math.max(timeoutMs, opts.readyCapMs ?? READY_LOADED_CAP_MS);
  let dir = '';
  let child: ChildProcess | null = null;
  const kill = (): void => {
    try {
      if (child && child.exitCode === null && !child.killed) child.kill();
    } catch {
      // Already gone.
    }
    if (!dir) return;
    // The window process is the script's second stage (see below), so the
    // handle on `child` is not enough: tell a late starter to stand down and
    // end a running one by the pid it recorded.
    try {
      writeFileSync(path.join(dir, 'cancel'), 'cancel');
    } catch {
      // Folder gone.
    }
    try {
      const pid = Number(readFileSync(path.join(dir, 'pid'), 'utf8').trim());
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) process.kill(pid);
    } catch {
      // No pid yet, or already gone.
    }
  };
  const fail = (reason: string): HelperHandle => {
    kill();
    return { ready: false, reason, dir, kill };
  };

  try {
    sweepStaleHelperDirs(opts.tmpRoot);
    dir = mkdtempSync(path.join(opts.tmpRoot, DIR_PREFIX));
    copyHelperFiles(opts.resourcesDir, dir);
    const configPath = path.join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify(opts.config), 'utf8');
    const scriptPath = path.join(dir, 'update-progress.ps1');
    const command = opts.command ?? powershellPath();
    const args = (opts.args ?? powershellArgs)(scriptPath, configPath);
    const doSpawn = opts.spawnImpl ?? spawn;
    // NOT detached: powershell.exe started as a DETACHED_PROCESS exits at once
    // (code 0) without running the script, measured on a Windows runner. An
    // attached child sits in node's kill-on-close job and would die with Sei,
    // so the script's first stage only starts the real window as a
    // grandchild (which leaves the job) and exits 0. windowsHide gives the
    // first stage a console with no window.
    child = doSpawn(command, args, { cwd: dir, stdio: 'ignore', windowsHide: true });
  } catch (err) {
    return fail(`start failed: ${(err as Error).message}`);
  }

  const proc = child;
  const readyFile = path.join(dir, 'ready');
  const failedFile = path.join(dir, 'failed');
  const loadedFile = path.join(dir, 'loaded');
  const outcome = await new Promise<string>((resolve) => {
    let settled = false;
    const finish = (why: string): void => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      resolve(why);
    };
    proc.once('error', (err) => finish(`spawn error: ${err.message}`));
    // Exit 0 is the first stage handing over to the window process; anything
    // else means the script never got that far (a Group Policy block, a
    // parse error, a failed hand-over).
    proc.once('exit', (code, signal) => {
      if (code !== 0) finish(`exited early (${code === null ? `signal ${signal}` : `code ${code}`})`);
    });
    const poll = setInterval(() => {
      if (existsSync(readyFile)) return finish('');
      if (existsSync(failedFile)) {
        let why = '';
        try {
          why = readFileSync(failedFile, 'utf8').trim().slice(0, 300);
        } catch {
          // Unreadable: the generic reason will do.
        }
        finish(`window failed: ${why || 'unknown'}`);
      }
    }, 100);
    // A window process that has loaded WPF by the base budget is only slow
    // (a busy or freshly scanned machine), not blocked: give it up to the cap.
    let timer = setTimeout(() => {
      if (capMs > timeoutMs && existsSync(loadedFile)) {
        timer = setTimeout(() => finish(`no first frame within ${capMs} ms (WPF loaded)`), capMs - timeoutMs);
      } else {
        finish(`no first frame within ${timeoutMs} ms`);
      }
    }, timeoutMs);
  });
  if (outcome) return fail(outcome);
  proc.unref();
  return { ready: true, reason: '', dir, kill };
}
