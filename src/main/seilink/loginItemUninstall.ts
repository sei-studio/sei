/**
 * Velopack uninstall (261107): remove the "Open Sei when I log in" Run value
 * (openAtLogin.ts) when it starts THIS install, so an uninstalled Sei does not
 * leave a dead startup entry behind. Windows keeps Run values after a program
 * is removed; NSIS installs do the same in build/installer.nsh
 * (customUnInstall).
 *
 * Runs inside Velopack's `--veloapp-uninstall` hook (velopackBoot.ts), before
 * app ready and with a short time limit, so it uses reg.exe directly instead
 * of Electron's login item API. Never throws.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { WIN_RUN_NAME } from './openAtLogin';

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const APPROVED_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';

/** The data of Sei's Run value in `reg query` output, or null. */
export function runValueFromRegQuery(out: string): string | null {
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*(\S+)\s+REG_(?:EXPAND_)?SZ\s+(.*)$/.exec(line);
    if (m && m[1] === WIN_RUN_NAME) return m[2].trim();
  }
  return null;
}

/** True when the value starts an exe inside `root` (case-insensitive, Windows paths). */
export function runValueBelongsTo(value: string, root: string): boolean {
  const exe = (/^"([^"]+)"/.exec(value)?.[1] ?? value.split(/\s+/)[0] ?? '').toLowerCase();
  const r = path.win32.normalize(root).replace(/\\+$/, '').toLowerCase();
  return !!exe && !!r && exe.startsWith(`${r}\\`);
}

export function removeLoginValueForUninstall(root: string, log: (m: string) => void): void {
  try {
    let out = '';
    try {
      out = execFileSync('reg.exe', ['query', RUN_KEY, '/v', WIN_RUN_NAME], {
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return; // no such value
    }
    const value = runValueFromRegQuery(out);
    if (!value || !runValueBelongsTo(value, root)) return;
    for (const key of [RUN_KEY, APPROVED_KEY]) {
      try {
        execFileSync('reg.exe', ['delete', key, '/v', WIN_RUN_NAME, '/f'], { timeout: 3000, windowsHide: true, stdio: 'ignore' });
      } catch {
        /* StartupApproved usually has no value */
      }
    }
    log('uninstall: removed the open-at-login item');
  } catch (err) {
    log(`uninstall: open-at-login cleanup failed: ${(err as Error).message}`);
  }
}
