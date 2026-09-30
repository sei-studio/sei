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
import type { StardewLaunchResult } from '../../../shared/stardewIpc';
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
