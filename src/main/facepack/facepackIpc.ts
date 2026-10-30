/**
 * Facepack pilot IPC (261028). Every handler answers "disabled" (null / [] /
 * enabled:false) unless the dev flag is on, so in a packaged build the only
 * effect of registering them is that the renderer's one facepack:info probe
 * gets a clean "off".
 */
import { BrowserWindow, ipcMain } from 'electron';
import { IpcChannel } from '../../shared/ipc';
import type { FaceCue } from '../../shared/facepack';
import { getCharacter } from '../characterStore';
import { facesEnabled } from './facepackDev';
import { setFaceCueSink } from './faceEvents';
import { facepackDevInfo, packIdForCharacterName, readPackFile, readPackManifest } from './facepackStore';

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

  ipcMain.handle(IpcChannel.facepack.forCharacter, async (_e, characterId: unknown) => {
    if (!facesEnabled() || typeof characterId !== 'string') return null;
    const c = await getCharacter(characterId).catch(() => null);
    return c ? packIdForCharacterName(c.name) : null;
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
