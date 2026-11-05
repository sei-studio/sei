/**
 * SeiLink IPC (261104, host pass): packs, per-companion room get/set, the
 * room-changed push, the dev preview window (dev flag only), and the desktop
 * host's start/stop/status (host/seilinkHost.ts).
 */
import { BrowserWindow, ipcMain } from 'electron';
import { IpcChannel } from '../../shared/ipc';
import { listPacks, publicPack, seilinkDevEnabled, seilinkDevInfo } from './packs';
import { seilinkAvailability, seilinkEnabled } from './gate';
import { getRoomPayload, isRoomCharacterId, onRoomChange, setRoomState } from './roomStore';
import { seilinkHostStatus, startSeilinkHost, stopSeilinkHost } from './host/seilinkHost';
import { ANIMA_TRIGGERS, isAnimaShownKind, type AnimaTrigger } from '../../shared/anima';
import { anima } from '../anima/animaRuntime';
import { isEditorSessionToken, onRoomEditorClosed, onRoomEditorOpened } from './roomReaction';

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

  // 261105 Anima: her face set. Only while SeiLink is on: nobody else starts a bake.
  ipcMain.handle(IpcChannel.seilink.animaPrepare, async (_e, args: unknown) => {
    const a = args as { characterId?: unknown; trigger?: unknown } | null;
    if (!isRoomCharacterId(a?.characterId)) throw new Error('SEILINK_BAD_ID');
    const trigger = ANIMA_TRIGGERS.includes(a.trigger as AnimaTrigger) ? (a.trigger as AnimaTrigger) : 'editor';
    if (!seilinkEnabled()) return anima.status(a.characterId);
    // Answer at once; the bake and the download run in the background (status pushes follow).
    void anima.prepare(a.characterId, trigger);
    return anima.status(a.characterId);
  });
  ipcMain.handle(IpcChannel.seilink.animaStatus, async (_e, characterId: unknown) => {
    if (!isRoomCharacterId(characterId)) throw new Error('SEILINK_BAD_ID');
    return anima.status(characterId);
  });
  ipcMain.on(IpcChannel.seilink.animaShown, (_e, args: unknown) => {
    const a = args as { characterId?: unknown; kind?: unknown } | null;
    if (isRoomCharacterId(a?.characterId) && isAnimaShownKind(a?.kind)) anima.noteShown(a.characterId, a.kind, 'editor');
  });

  // 261105 (T335): the companion editor's session, for her one reaction line to the edits.
  ipcMain.on(IpcChannel.seilink.editorSession, (_e, args: unknown) => {
    const a = args as { phase?: unknown; token?: unknown; characterId?: unknown } | null;
    if (!isEditorSessionToken(a?.token)) return;
    if (a.phase === 'open' && isRoomCharacterId(a.characterId)) onRoomEditorOpened(a.token, a.characterId);
    else if (a.phase === 'close') onRoomEditorClosed(a.token);
  });

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
