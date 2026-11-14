/**
 * Starting Slay the Spire 2 windows (261115).
 *
 * The PLAYER's window starts through Steam (`steam://rungameid/<app id>`):
 * it is their normal game, with their saves and Steam account. The
 * COMPANION's window is a second process of the same executable, started by
 * Sei with the game's own developer switches:
 *
 *   --windowed             a small window, not a second fullscreen
 *   --force-steam off      no Steam client for this process (one account, one copy)
 *   --clientId 1001        its own settings and save folder, so it never
 *                          writes over the player's
 *   -fastmp join           join the localhost ENet lobby on 127.0.0.1:33771
 *
 * On macOS the executable inside the .app is run directly: `open` would hand
 * the request to the player's already running instance.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { STS2_COMPANION_CLIENT_ID, STS2_STEAM_APP_ID } from '../../../shared/sts2Ipc';

export const STEAM_RUN_URL = `steam://rungameid/${STS2_STEAM_APP_ID}`;

export function companionArgs(clientId: number = STS2_COMPANION_CLIENT_ID): string[] {
  return ['--windowed', '--force-steam', 'off', '--clientId', String(clientId), '-fastmp', 'join'];
}

export interface CompanionWindow {
  pid: number | null;
  /** Still running (no exit seen). */
  alive(): boolean;
  /** Ask it to close, then force after `graceMs`. */
  stop(graceMs?: number): void;
  onExit(cb: (code: number | null) => void): void;
}

export interface SpawnLike {
  (cmd: string, args: string[], opts: Record<string, unknown>): ChildProcess;
}

export function spawnCompanionWindow(binary: string, opts: { spawnImpl?: SpawnLike; env?: NodeJS.ProcessEnv; log?: (m: string) => void } = {}): CompanionWindow {
  const doSpawn = opts.spawnImpl ?? (spawn as unknown as SpawnLike);
  const child = doSpawn(binary, companionArgs(), {
    cwd: path.dirname(binary),
    detached: false,
    stdio: 'ignore',
    windowsHide: false,
    // The mod also reads its role from --clientId; the env is a second, explicit signal.
    env: { ...(opts.env ?? process.env), SEI_STS2_ROLE: 'seat' },
  });
  let exited = false;
  const exitCbs: ((code: number | null) => void)[] = [];
  child.on('exit', (code) => {
    exited = true;
    for (const cb of exitCbs) {
      try {
        cb(code);
      } catch {
        /* listener errors never break the window bookkeeping */
      }
    }
  });
  child.on('error', (err) => {
    exited = true;
    opts.log?.(`companion window failed to start: ${err.message}`);
    for (const cb of exitCbs) {
      try {
        cb(null);
      } catch {
        /* ignore */
      }
    }
  });
  return {
    pid: child.pid ?? null,
    alive: () => !exited,
    stop(graceMs = 5_000) {
      if (exited) return;
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      const t = setTimeout(() => {
        if (!exited) {
          try {
            child.kill('SIGKILL');
          } catch {
            /* already gone */
          }
        }
      }, graceMs);
      if (typeof t.unref === 'function') t.unref();
    },
    onExit(cb) {
      exitCbs.push(cb);
    },
  };
}
