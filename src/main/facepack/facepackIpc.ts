/**
 * Facepack IPC (261028 pilot). The dev handlers answer "disabled" (null / [] /
 * enabled:false) unless the dev flag is on. Since 261105 manifest/file/
 * forCharacter also serve the face sets the anima client downloaded (`an-`
 * ids), in every build.
 */
import { BrowserWindow, ipcMain } from 'electron';
import { IpcChannel } from '../../shared/ipc';
import type { FaceCue } from '../../shared/facepack';
import { getCharacter } from '../characterStore';
import { facesEnabled } from './facepackDev';
import { setFaceCueSink } from './faceEvents';
import { facepackDevInfo, facepackIdForCharacter, readPackFile, readPackManifest } from './facepackStore';

let previewWin: BrowserWindow | null = null;

export function registerFacepackIpc(opts: { preloadPath: string; rendererTarget: () => string }): void {
  // Cues go to every window (the dev preview is the one consumer today). The sink itself is a no-op path while the flag is off
  // (emitFaceCue returns before calling it).
  setFaceCueSink((cue: FaceCue) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(IpcChannel.facepack.cue, cue);
    }
  });

  ipcMain.handle(IpcChannel.facepack.info, async () => facepackDevInfo());

  ipcMain.handle(IpcChannel.facepack.manifest, async (_e, id: unknown) =>
    typeof id === 'string' ? readPackManifest(id) : null,
  );

  ipcMain.handle(IpcChannel.facepack.file, async (_e, args: unknown) => {
    const a = args as { id?: unknown; path?: unknown } | null;
    if (typeof a?.id !== 'string' || typeof a?.path !== 'string') return null;
    return readPackFile(a.id, a.path);
  });

  // 261105: her downloaded anima pack in any build; the dev pack dir only under the flag.
  ipcMain.handle(IpcChannel.facepack.forCharacter, async (_e, characterId: unknown) => {
    if (typeof characterId !== 'string') return null;
    const c = await getCharacter(characterId).catch(() => null);
    return c ? facepackIdForCharacter(characterId, c.name) : null;
  });

  ipcMain.handle(IpcChannel.facepack.openPreview, async () => {
    if (!facesEnabled()) return false;
    if (previewWin && !previewWin.isDestroyed()) {
      previewWin.focus();
      return true;
    }
    previewWin = new BrowserWindow({
      width: 1100,
      height: 860,
      title: 'Facepack preview (dev)',
      backgroundColor: '#14161c',
      webPreferences: { preload: opts.preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: false },
    });
    previewWin.on('closed', () => {
      previewWin = null;
    });
    const t = opts.rendererTarget();
    if (/^(https?|file):\/\//.test(t)) void previewWin.loadURL(`${t}${t.includes('?') ? '&' : '?'}facepack=1`);
    else void previewWin.loadFile(t, { search: 'facepack=1' });
    return true;
  });
}
