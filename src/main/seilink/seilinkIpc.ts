/**
 * SeiLink IPC (261104, host pass): packs, per-companion room get/set, the
 * room-changed push, the dev preview window (dev flag only), and the desktop
 * host's start/stop/status (host/seilinkHost.ts).
 */
import { BrowserWindow, ipcMain } from 'electron';
import { IpcChannel } from '../../shared/ipc';
import { listPacks, publicPack, seilinkDevEnabled, seilinkDevInfo } from './packs';
import { seilinkAvailability } from './gate';
import { getRoomPayload, isRoomCharacterId, onRoomChange, setRoomState } from './roomStore';
import { seilinkHostStatus, startSeilinkHost, stopSeilinkHost } from './host/seilinkHost';

let previewWin: BrowserWindow | null = null;
let registered = false;

/** Once per process (ipcMain.handle throws on a second handler for a channel). */
export function registerSeilinkIpc(opts: { preloadPath: string; rendererTarget: () => string }): void {
  if (registered) return;
  registered = true;
  onRoomChange((characterId) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(IpcChannel.seilink.roomChanged, characterId);
    }
  });

  ipcMain.handle(IpcChannel.seilink.devInfo, async () => seilinkDevInfo());

  ipcMain.handle(IpcChannel.seilink.packs, async () => (await listPacks()).map(publicPack));

  ipcMain.handle(IpcChannel.seilink.roomGet, async (_e, characterId: unknown) => {
    if (!isRoomCharacterId(characterId)) throw new Error('SEILINK_BAD_ID');
    return getRoomPayload(characterId);
  });

  ipcMain.handle(IpcChannel.seilink.roomSet, async (_e, args: unknown) => {
    const a = args as { characterId?: unknown; state?: unknown } | null;
    if (!isRoomCharacterId(a?.characterId)) throw new Error('SEILINK_BAD_ID');
    await setRoomState(a.characterId, a.state);
    return getRoomPayload(a.characterId);
  });

  // Desktop host. Start throws SEILINK_DISABLED while SeiLink is off (gate.ts).
  ipcMain.handle(IpcChannel.seilink.hostStart, async (_e, characterId: unknown, opts: unknown) => {
    if (!isRoomCharacterId(characterId)) throw new Error('SEILINK_BAD_ID');
    const firstRoom = typeof opts === 'object' && opts !== null && (opts as { firstRoom?: unknown }).firstRoom === true;
    return startSeilinkHost(characterId, { firstRoom });
  });
  ipcMain.handle(IpcChannel.seilink.hostStop, async () => stopSeilinkHost('user_stop'));
  ipcMain.handle(IpcChannel.seilink.hostStatus, async () => seilinkHostStatus());
  ipcMain.handle(IpcChannel.seilink.availability, async () => seilinkAvailability());

  ipcMain.handle(IpcChannel.seilink.openPreview, async () => {
    if (!seilinkDevEnabled()) return false;
    openSeilinkPreview(opts);
    return true;
  });
}

/** The dev preview window (RoomCanvas full size with a time switch and tint picker). */
export function openSeilinkPreview(opts: { preloadPath: string; rendererTarget: () => string }): BrowserWindow | null {
  if (!seilinkDevEnabled()) return null;
  if (previewWin && !previewWin.isDestroyed()) {
    previewWin.focus();
    return previewWin;
  }
  previewWin = new BrowserWindow({
    width: 1280,
    height: 760,
    title: 'SeiLink room preview (dev)',
    backgroundColor: '#14161c',
    webPreferences: { preload: opts.preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  previewWin.on('closed', () => {
    previewWin = null;
  });
  const t = opts.rendererTarget();
  if (/^(https?|file):\/\//.test(t)) void previewWin.loadURL(`${t}${t.includes('?') ? '&' : '?'}seilink=1`);
  else void previewWin.loadFile(t, { search: 'seilink=1' });
  return previewWin;
}
