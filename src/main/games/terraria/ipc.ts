/**
 * Terraria IPC handlers (261113): setup state, mod install, launch. Kept out
 * of the big src/main/ipc.ts so the Terraria surface is one file; that file
 * calls registerTerrariaIpc once. Everything goes through the registered
 * Terraria GameModule; the renderer never names a path.
 * Contract: src/shared/terrariaIpc.ts.
 */
import type { IpcMain } from 'electron';
import { TerrariaChannel, type TerrariaActionResult, type TerrariaSetupState } from '../../../shared/terrariaIpc';
import type { TerrariaGameModule } from './index';

export function registerTerrariaIpc(ipcMain: IpcMain, opts: { worldCheckNow?: (game: 'terraria') => Promise<unknown> } = {}): void {
  const terrariaModule = async (): Promise<TerrariaGameModule> => {
    const { getGameModule } = await import('../index');
    const mod = getGameModule('terraria') as TerrariaGameModule | null;
    if (!mod) throw new Error('Terraria support is not available in this build.');
    return mod;
  };
  const nudge = (): void => {
    void opts.worldCheckNow?.('terraria')?.catch(() => {});
  };
  ipcMain.handle(TerrariaChannel.setupState, async (): Promise<TerrariaSetupState> => (await terrariaModule()).getSetupState());
  ipcMain.handle(TerrariaChannel.install, async (): Promise<TerrariaActionResult> => {
    const r = await (await terrariaModule()).runInstall();
    nudge();
    return r;
  });
  ipcMain.handle(TerrariaChannel.launch, async (): Promise<TerrariaActionResult> => {
    const r = await (await terrariaModule()).runLaunch();
    nudge();
    return r;
  });
}
