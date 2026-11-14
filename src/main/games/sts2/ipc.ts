/**
 * Slay the Spire 2 IPC handlers (261115): setup state, mod install, start
 * the game. Kept out of the big src/main/ipc.ts; that file calls
 * registerSts2Ipc once. Everything goes through the registered StS2
 * GameModule; the renderer never names a path. Contract: src/shared/sts2Ipc.ts.
 *
 * Both actions are clicks in the renderer, so on macOS they carry the
 * one-time App Management grant (the Open panel, then Finder), as DST's
 * install does (games/dontstarve/macGrant.ts).
 */
import { BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron';
import { Sts2Channel, type Sts2ActionResult, type Sts2SetupState } from '../../../shared/sts2Ipc';
import type { MacGrant } from '../dontstarve/install';
import type { Sts2GameModule } from './index';

export function registerSts2Ipc(
  ipcMain: IpcMain,
  opts: { worldCheckNow?: (game: 'sts2') => Promise<unknown>; uiLanguage?: () => Promise<string> } = {},
): void {
  const sts2Module = async (): Promise<Sts2GameModule> => {
    const { getGameModule } = await import('../index');
    const mod = getGameModule('sts2') as Sts2GameModule | null;
    if (!mod) throw new Error('Slay the Spire 2 support is not available in this build.');
    return mod;
  };
  const nudge = (): void => {
    void opts.worldCheckNow?.('sts2')?.catch(() => {});
  };
  const grantFor = async (event: IpcMainInvokeEvent): Promise<MacGrant | undefined> => {
    if (process.platform !== 'darwin') return undefined;
    const { createMacGrant, grantCopyFor } = await import('../dontstarve/macGrant');
    const { normalizeUiLanguage } = await import('../../../shared/uiLanguage');
    const language = normalizeUiLanguage(await opts.uiLanguage?.().catch(() => 'en'));
    return createMacGrant({
      window: BrowserWindow.fromWebContents(event.sender),
      language,
      copy: grantCopyFor(language, 'Slay the Spire 2', '《杀戮尖塔2》'),
      tempPrefix: 'sei-sts2-',
    });
  };
  ipcMain.handle(Sts2Channel.setupState, async (): Promise<Sts2SetupState> => (await sts2Module()).getSetupState());
  ipcMain.handle(Sts2Channel.install, async (event): Promise<Sts2ActionResult> => {
    const r = await (await sts2Module()).runInstall({ grant: await grantFor(event) });
    nudge();
    return r;
  });
  ipcMain.handle(Sts2Channel.startGame, async (event): Promise<Sts2ActionResult> => {
    const r = await (await sts2Module()).runStartGame({ grant: await grantFor(event) });
    nudge();
    return r;
  });
}
