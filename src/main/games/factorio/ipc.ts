/**
 * Factorio IPC handlers (261113): setup state, mod install, launch. Kept out
 * of the big src/main/ipc.ts so the Factorio surface is one file; that file
 * calls registerFactorioIpc once. Everything goes through the registered
 * Factorio GameModule; the renderer never names a path.
 * Contract: src/shared/factorioIpc.ts.
 */
import type { IpcMain } from 'electron';
import { FactorioChannel, type FactorioActionResult, type FactorioSetupState } from '../../../shared/factorioIpc';
import type { FactorioGameModule } from './index';

export function registerFactorioIpc(ipcMain: IpcMain, opts: { worldCheckNow?: (game: 'factorio') => Promise<unknown> } = {}): void {
  const factorioModule = async (): Promise<FactorioGameModule> => {
    const { getGameModule } = await import('../index');
    const mod = getGameModule('factorio') as FactorioGameModule | null;
    if (!mod) throw new Error('Factorio support is not available in this build.');
    return mod;
  };
  const nudge = (): void => {
    void opts.worldCheckNow?.('factorio')?.catch(() => {});
  };
  ipcMain.handle(FactorioChannel.setupState, async (): Promise<FactorioSetupState> => (await factorioModule()).getSetupState());
  ipcMain.handle(FactorioChannel.install, async (): Promise<FactorioActionResult> => {
    const r = await (await factorioModule()).runInstall();
    nudge();
    return r;
  });
  ipcMain.handle(FactorioChannel.launch, async (): Promise<FactorioActionResult> => {
    const r = await (await factorioModule()).runLaunch();
    nudge();
    return r;
  });
}
