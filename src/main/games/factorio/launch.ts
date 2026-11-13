/**
 * Starting Factorio with the Sei link (261113).
 *
 * The Lua UDP socket the mod talks through exists only when Factorio is
 * started with `--enable-lua-udp <port>`; there is no config.ini key for it.
 * So Sei starts the game itself:
 *
 *   standalone (any OS)  the binary, detached, with the flag.
 *   Steam on Windows     `steam.exe -applaunch 427520 --enable-lua-udp <port>`
 *                        (steam.exe from HKCU\Software\Valve\Steam SteamExe,
 *                        else beside SteamPath, else the default folder).
 *                        Steam passes the extra arguments to the game.
 *   Steam on macOS/Linux the inner binary directly, with SteamAppId=427520 in
 *                        its environment so the Steam API attaches to the
 *                        running Steam client instead of asking Steam to
 *                        restart the game (which would drop the flag).
 *                        Fallback idea, NOT done: a `steam_appid.txt`
 *                        holding 427520 beside the binary does the same, but
 *                        on macOS that file would go inside factorio.app,
 *                        which changes a signed bundle and needs App
 *                        Management (the Don't Starve Together lesson).
 *
 * A running Factorio is never started twice: the player has to close it,
 * because a game started some other way has no link socket.
 *
 * After the spawn the module tails `<userdata>/factorio-current.log`
 * (rewritten on every start) for Factorio's own line saying the socket could
 * not be opened, which means the port was taken.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { FACTORIO_STEAM_APP_ID } from '../../../shared/factorioIpc';
import type { FactorioCandidate, FactorioInstallDeps } from './install';

export interface LaunchPlan {
  cmd: string;
  args: string[];
  /** Extra environment for the child (merged over process.env). */
  env?: Record<string, string>;
  cwd?: string;
  via: 'standalone' | 'steam';
}

export function linkArgs(port: number): string[] {
  return ['--enable-lua-udp', String(port)];
}

/** Where steam.exe is on Windows, or null when nothing exists there. */
export async function findSteamExe(deps: Pick<FactorioInstallDeps, 'registrySteam' | 'exists' | 'env'>): Promise<string | null> {
  const candidates: string[] = [];
  const exe = await deps.registrySteam('SteamExe').catch(() => null);
  if (exe) candidates.push(exe);
  const steamPath = await deps.registrySteam('SteamPath').catch(() => null);
  if (steamPath) candidates.push(path.win32.join(steamPath, 'steam.exe'));
  candidates.push(path.win32.join(deps.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Steam', 'steam.exe'));
  for (const c of candidates) {
    // The registry stores forward slashes ("c:/program files (x86)/steam/steam.exe").
    const p = path.win32.normalize(c);
    if (await deps.exists(p)) return p;
  }
  return null;
}

/** Pure: how to start this install with the link on `port`. */
export function launchPlan(c: FactorioCandidate, port: number, platform: NodeJS.Platform, steamExe: string | null): LaunchPlan {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const cwd = p.dirname(c.binary);
  if (c.store === 'standalone') return { cmd: c.binary, args: linkArgs(port), cwd, via: 'standalone' };
  if (platform === 'win32' && steamExe) {
    return { cmd: steamExe, args: ['-applaunch', String(FACTORIO_STEAM_APP_ID), ...linkArgs(port)], via: 'steam' };
  }
  // macOS / Linux Steam, and Windows Steam with no steam.exe found.
  const id = String(FACTORIO_STEAM_APP_ID);
  return { cmd: c.binary, args: linkArgs(port), cwd, env: { SteamAppId: id, SteamGameId: id }, via: 'steam' };
}

/** Start the plan detached; resolves once the OS has started the process (or rejects). */
export function spawnPlan(plan: LaunchPlan): Promise<void> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(plan.cmd, plan.args, {
        cwd: plan.cwd,
        env: plan.env ? { ...process.env, ...plan.env } : process.env,
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
    } catch (err) {
      reject(err);
      return;
    }
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

/* ── factorio-current.log ───────────────────────────────────────────────── */

/** Factorio's line when the Lua UDP socket could not be opened (the port is taken). */
export const UDP_SOCKET_FAILED_RE = /Opening Lua UDP Socket failed/i;

export function logSaysSocketFailed(text: string | null): boolean {
  return !!text && UDP_SOCKET_FAILED_RE.test(text);
}

export interface LogWatchDeps {
  readText(p: string): Promise<string | null>;
  /** mtime (epoch ms) or null when the file is missing. */
  mtime(p: string): Promise<number | null>;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
  now(): number;
}

/**
 * Poll the log written by THIS start (mtime at or after `since`, with a
 * second of slack for coarse file times) until it reports the socket
 * failure, `timeoutMs` passes, or `stop()` is called. Never throws.
 */
export function watchLinkLog(
  logPath: string,
  opts: { since: number; onFailure: () => void; timeoutMs?: number; intervalMs?: number },
  deps: LogWatchDeps,
): { stop(): void } {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const intervalMs = opts.intervalMs ?? 2_000;
  const until = deps.now() + timeoutMs;
  let timer: unknown = null;
  let stopped = false;
  const tick = async (): Promise<void> => {
    timer = null;
    if (stopped) return;
    try {
      const m = await deps.mtime(logPath);
      if (m != null && m >= opts.since - 1000 && logSaysSocketFailed(await deps.readText(logPath))) {
        stopped = true;
        opts.onFailure();
        return;
      }
    } catch {
      /* keep polling */
    }
    if (!stopped && deps.now() < until) timer = deps.setTimer(() => void tick(), intervalMs);
  };
  timer = deps.setTimer(() => void tick(), intervalMs);
  return {
    stop() {
      stopped = true;
      if (timer != null) deps.clearTimer(timer);
      timer = null;
    },
  };
}
