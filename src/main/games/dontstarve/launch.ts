/**
 * Launch Don't Starve Together through Steam (game-adapters M2, 260908).
 * `steam://rungameid/322330` hands everything to Steam (login, updates, the
 * launcher); the mod is force-enabled by install.ts so any world the player
 * hosts afterwards carries it. The opener is injectable for tests; the real
 * one is Electron's shell.openExternal, imported lazily so this module can
 * be unit-tested without Electron.
 */
import { DST_STEAM_APP_ID } from '../../../shared/dstIpc';

export const DST_STEAM_URL = `steam://rungameid/${DST_STEAM_APP_ID}`;

export async function launchDst(open?: (url: string) => Promise<void>): Promise<void> {
  if (open) return open(DST_STEAM_URL);
  const { shell } = await import('electron');
  await shell.openExternal(DST_STEAM_URL);
}
