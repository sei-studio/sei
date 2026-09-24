/**
 * Is Don't Starve Together running, and since when (260909).
 *
 * The helper mod is indexed once, at game start (Klei's modindex.lua reads
 * the mods folder and modsettings.lua in UpdateModSettings), so a game that
 * was already open when Sei copied the helper in will never load it. The
 * launch panel needs two facts to say "quit the game and open it again" at
 * the right moment and nothing else: whether the game is running, and
 * whether it started before the helper landed. Both come from one process
 * listing: `ps` on macOS/Linux (lstart = the start time), a CIM query on
 * Windows (CreationDate). Failure to read either is reported as "unknown",
 * never as a false claim.
 */
import { execFile } from 'node:child_process';

export interface GameProcessState {
  running: boolean;
  /** Epoch ms the process started, or null when the OS did not say. */
  startedAt: number | null;
}

/** Executable names per platform (Steam's bin/, bin64/ and the mac bundle). */
const EXE_NAMES = ['dontstarve_steam', 'dontstarve_steam_x64', 'dontstarve_steam.exe', 'dontstarve_steam_x64.exe'];

function run(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(String(stdout));
    });
  });
}

/**
 * Parse `ps -axo pid=,lstart=,comm=` output. The comm column is the full
 * executable path on macOS; the DST binary sits in the .app bundle.
 */
export function parsePsList(out: string): GameProcessState {
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d{4})\s+(.+)$/.exec(line);
    if (!m) continue;
    const exe = m[3].trim().split('/').pop() ?? '';
    if (!EXE_NAMES.includes(exe)) continue;
    // "Tue Sep  8 23:41:15 2026": ps pads the day, and Date.parse is happier
    // with single spaces.
    const started = Date.parse(m[2].replace(/\s+/g, ' '));
    return { running: true, startedAt: Number.isFinite(started) ? started : null };
  }
  return { running: false, startedAt: null };
}

/**
 * Parse the Windows CIM query output: one line per matching process,
 * `<name>|<CreationDate as ISO 8601>`.
 */
export function parseCimList(out: string): GameProcessState {
  for (const line of out.split(/\r?\n/)) {
    const [name, iso] = line.trim().split('|');
    if (!name || !EXE_NAMES.includes(name.toLowerCase())) continue;
    const started = iso ? Date.parse(iso) : NaN;
    return { running: true, startedAt: Number.isFinite(started) ? started : null };
  }
  return { running: false, startedAt: null };
}

export async function findGameProcess(platform: NodeJS.Platform = process.platform): Promise<GameProcessState> {
  if (platform === 'win32') {
    const script =
      "Get-CimInstance Win32_Process -Filter \"Name like 'dontstarve_steam%'\" | ForEach-Object { $_.Name + '|' + $_.CreationDate.ToString('o') }";
    const out = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
    return out == null ? { running: false, startedAt: null } : parseCimList(out);
  }
  const out = await run('ps', ['-axo', 'pid=,lstart=,comm=']);
  return out == null ? { running: false, startedAt: null } : parsePsList(out);
}
