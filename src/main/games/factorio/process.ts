/**
 * Is Factorio running (261113)? Same approach as the Don't Starve Together
 * probe (src/main/games/dontstarve/process.ts): one process listing, `ps` on
 * macOS/Linux and a CIM query on Windows, and a failure to read it is
 * "unknown" (null), never a false claim.
 *
 * Two things hang on the answer. The mod is loaded once, when Factorio
 * starts, and Factorio rewrites mods/mod-list.json itself when it quits, so
 * the mod install refuses to write while the game runs. And the Lua UDP
 * socket exists only when Factorio was STARTED with `--enable-lua-udp`, so a
 * game the player opened some other way has to be closed and started again
 * from Sei.
 */
import { execFile } from 'node:child_process';

/** Executable names per platform (bin/x64/factorio[.exe], factorio.app/Contents/MacOS/factorio). */
const EXE_NAMES = ['factorio', 'factorio.exe'];

function run(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(String(stdout));
    });
  });
}

/**
 * Parse `ps -axo comm=` output (one executable path per line; macOS prints
 * the full path, Linux the short name). Matches the last path segment
 * exactly, case-insensitively, so "factorio-server-manager" or a folder
 * called Factorio does not count.
 */
export function parsePsFactorio(out: string): boolean {
  for (const line of out.split(/\r?\n/)) {
    const exe = (line.trim().split('/').pop() ?? '').toLowerCase();
    if (EXE_NAMES.includes(exe)) return true;
  }
  return false;
}

/** Parse the Windows CIM query output: one process name per line. */
export function parseCimFactorio(out: string): boolean {
  return out.split(/\r?\n/).some((l) => EXE_NAMES.includes(l.trim().toLowerCase()));
}

/** true / false, or null when the OS listing could not be read. */
export async function isFactorioRunning(platform: NodeJS.Platform = process.platform): Promise<boolean | null> {
  if (platform === 'win32') {
    const script = "Get-CimInstance Win32_Process -Filter \"Name = 'factorio.exe'\" | ForEach-Object { $_.Name }";
    const out = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
    return out == null ? null : parseCimFactorio(out);
  }
  const out = await run('ps', ['-axo', 'comm=']);
  return out == null ? null : parsePsFactorio(out);
}
