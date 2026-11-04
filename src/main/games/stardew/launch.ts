/**
 * Launching Stardew Valley with SMAPI (game-adapters M1).
 *
 * Windows: StardewModdingAPI.exe from the game folder. Started this way the
 * game runs with mods but outside Steam's overlay, so Steam achievements do
 * not unlock; the fix is the Steam launch option SMAPI's own installer
 * prints, which Sei cannot set (Steam keeps it in localconfig.vdf and must be
 * closed to edit it safely). The launch panel shows it once with a copy
 * button (steamLaunchOption in src/shared/stardewIpc.ts).
 * macOS / Linux: the SMAPI installer already renamed the game's launcher, so
 * `StardewValley` in the game folder IS the SMAPI launcher.
 *
 * Before starting the game the installed mod is brought up to the pack's
 * version (260925): the game is closed at this point, which is the one time
 * Windows lets the loaded DLL be replaced. A failed pack fetch or copy is
 * logged and the game starts with the mod it has.
 */
import type { StardewGameRunning, StardewLaunchResult } from '../../../shared/stardewIpc';
import { defaultEnv, detectStardew, spawnGame, upgradeModIfNewer, type StardewInstallEnv } from './install';
import { probeHello } from './watcher';

export interface LaunchDeps {
  env?: StardewInstallEnv;
  fetch?: typeof fetch;
  logger?: { info: (m: string) => void; warn: (m: string) => void };
}

export async function launchStardew(deps: LaunchDeps = {}): Promise<StardewLaunchResult> {
  const env = deps.env ?? defaultEnv();
  const logger = deps.logger ?? { info: (m: string) => console.log(m), warn: (m: string) => console.warn(m) };
  const state = await detectStardew(env);
  if (!state.gamePath) return { launched: false, via: 'none', message: 'GAME_NOT_INSTALLED: Stardew Valley was not found on this computer.' };
  if (!state.smapiInstalled || !state.modInstalled) {
    return { launched: false, via: 'none', message: 'GAME_INSTALL_FAILED: run the Stardew setup first so SMAPI and the Sei companion mod are installed.' };
  }
  // Already running with the mod: do not start a second copy.
  if (state.modConfig) {
    const hello = await probeHello(state.modConfig.port, deps.fetch ?? ((i, o) => fetch(i, o)), 800);
    if (hello) return { launched: false, via: 'none', message: 'Stardew Valley is already running.' };
  }
  try {
    const up = await upgradeModIfNewer(state.gamePath, await env.getPackRoot());
    if (up.upgraded) logger.info(`[sei/stardew] companion mod updated ${up.from ?? '?'} -> ${up.to}`);
  } catch (err) {
    logger.warn(`[sei/stardew] companion mod update skipped: ${String((err as Error)?.message ?? err)}`);
  }
  try {
    const { via } = await spawnGame(state.gamePath, state.platform);
    return { launched: true, via };
  } catch (err) {
    return { launched: false, via: 'none', message: String((err as Error)?.message ?? err) };
  }
}

/* ── Is the game running? (261104) ───────────────────────────────────── */

/**
 * The game's processes in a process listing (`tasklist /FO CSV /NH` on
 * Windows, `ps -eo args=` elsewhere). SMAPI runs the game as its own
 * process (StardewModdingAPI.exe / StardewModdingAPI), so "running and not
 * SMAPI" is the vanilla game started from Steam or the Xbox app, where the
 * helper mod never loads.
 */
export function parseStardewProcesses(listing: string, platform: StardewInstallEnv['platform']): StardewGameRunning {
  const lines = listing.split(/\r?\n/);
  const smapi = lines.some((l) => (platform === 'win32' ? /^"StardewModdingAPI\.exe"/i.test(l) : /StardewModdingAPI(\s|$)/.test(l)));
  const vanilla = lines.some((l) =>
    platform === 'win32' ? /^"Stardew Valley\.exe"/i.test(l) : /(^|\/)Stardew Valley(\s|$)|\/StardewValley(\s|$)/.test(l),
  );
  const running = smapi || vanilla;
  return { running, smapi: running ? smapi : null };
}

export async function stardewGameRunning(platform: StardewInstallEnv['platform'] = defaultEnv().platform): Promise<StardewGameRunning> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  try {
    const { stdout } =
      platform === 'win32'
        ? await run('tasklist', ['/FO', 'CSV', '/NH'], { timeout: 5000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
        : await run('ps', ['-eo', 'args='], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
    return parseStardewProcesses(String(stdout ?? ''), platform);
  } catch {
    return { running: null, smapi: null };
  }
}
