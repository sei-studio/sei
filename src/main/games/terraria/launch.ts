/**
 * Launching tModLoader (261113). tModLoader is a free Steam app (1281930)
 * that needs Terraria (105600) owned; Steam starts it from
 * `steam://rungameid/1281930` on every OS, which also keeps the overlay and
 * achievements as the player knows them. Before that the mod is brought up
 * to the pack's version while the game is closed (Windows locks a loaded
 * .tmod). A running tModLoader that already answers is not started twice.
 */
import { TML_STEAM_APP_ID, TERRARIA_PORT_SPAN } from '../../../shared/terrariaIpc';
import { installTerrariaMod, readLink, tmlSaveDir, type TerrariaInstallEnv } from './install';
import { probeHello } from './watcher';

export const TML_STEAM_URL = `steam://rungameid/${TML_STEAM_APP_ID}`;

export interface LaunchDeps {
  env: TerrariaInstallEnv;
  openExternal: (url: string) => Promise<void>;
  fetch?: typeof fetch;
  logger?: { info: (m: string) => void; warn: (m: string) => void };
}

export type LaunchOutcome = { launched: true } | { launched: false; alreadyRunning: true } | { launched: false; error: string };

export async function launchTerraria(deps: LaunchDeps): Promise<LaunchOutcome> {
  const fetchImpl = deps.fetch ?? ((i, o) => fetch(i, o));
  const link = await readLink(tmlSaveDir(deps.env));
  if (link) {
    for (let i = 0; i < TERRARIA_PORT_SPAN; i++) {
      if (await probeHello(link.port + i, fetchImpl, 600)) return { launched: false, alreadyRunning: true };
    }
  }
  try {
    const r = await installTerrariaMod(deps.env);
    if (r.upgraded) deps.logger?.info(`[sei/terraria] companion mod ${r.from ?? 'none'} -> ${r.to}`);
  } catch (err) {
    // A failed update is not a reason to keep the player out of their game.
    deps.logger?.warn(`[sei/terraria] mod install/update skipped: ${(err as Error)?.message ?? err}`);
  }
  try {
    await deps.openExternal(TML_STEAM_URL);
    return { launched: true };
  } catch (err) {
    return { launched: false, error: String((err as Error)?.message ?? err) };
  }
}
