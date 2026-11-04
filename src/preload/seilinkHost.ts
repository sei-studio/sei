/**
 * Preload for the SeiLink room host page (261104, milestone 3). The page is
 * the companion's room drawn as wallpaper, inside the separate room host
 * process (src/main/seilink/host/hostEntry.ts), never the main app.
 *
 * Imports ONLY 'electron' (sandboxed preload; see safeMode.ts for why a
 * shared chunk cannot load here). The channel names are spelled out and
 * seilinkHostChannels.test.ts checks them against SEILINK_HOST_CHANNELS.
 *
 * Exposes `window.seiRoomHost` (SeilinkHostBridge in src/shared/seilinkHost.ts),
 * and a small `window.sei` with only the avatar calls RoomAvatar's views make
 * (avatarGet, avatarModelFiles, onAvatarManifest, facepackForCharacter,
 * facepackManifest, facepackFile). The host relays each one to main, which
 * answers for the moved-in character only. Every other RendererApi method is
 * absent here; the views call these with `?.` or only after avatarGet /
 * facepackForCharacter found something.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

export const SEILINK_HOST_PRELOAD_CHANNELS = {
  room: 'seilink-host:room',
  fps: 'seilink-host:fps',
  poke: 'seilink-host:poke',
  box: 'seilink-host:box',
  frames: 'seilink-host:frames',
  firstFrame: 'seilink-host:first-frame',
  ready: 'seilink-host:ready',
  busy: 'seilink-host:busy',
  call: 'seilink-host:call',
  avatarManifest: 'seilink-host:avatar-manifest',
  layout: 'seilink-host:layout',
  dockState: 'seilink-host:dock-state',
  dockPress: 'seilink-host:dock-press',
  dock: 'seilink-host:dock',
  dockAction: 'seilink-host:dock-action',
  line: 'seilink-host:line',
} as const;

const C = SEILINK_HOST_PRELOAD_CHANNELS;

function listen<T>(channel: string, cb: (v: T) => void): () => void {
  const fn = (_e: IpcRendererEvent, v: T): void => cb(v);
  ipcRenderer.on(channel, fn);
  return () => {
    ipcRenderer.removeListener(channel, fn);
  };
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('seiRoomHost', {
    onRoom: (cb: (room: unknown) => void) => listen(C.room, cb),
    onFps: (cb: (fps: number) => void) => listen<number>(C.fps, (v) => cb(num(v))),
    onPoke: (cb: (kind: string) => void) => listen<string>(C.poke, (v) => cb(String(v))),
    setBox: (box: { x: number; y: number; w: number; h: number } | null) =>
      ipcRenderer.send(C.box, box ? { x: num(box.x), y: num(box.y), w: num(box.w), h: num(box.h) } : null),
    frames: (count: number) => ipcRenderer.send(C.frames, num(count)),
    firstFrame: () => ipcRenderer.send(C.firstFrame),
    ready: () => ipcRenderer.send(C.ready),
    onBusy: (cb: (busy: boolean) => void) => listen<boolean>(C.busy, (v) => cb(v === true)),
    onLayout: (cb: (layout: unknown) => void) => listen(C.layout, cb),
    onDockState: (cb: (state: unknown) => void) => listen(C.dockState, cb),
    onDockPress: (cb: (id: string) => void) => listen<string>(C.dockPress, (v) => cb(String(v))),
    setDock: (buttons: Array<{ id: string; x: number; y: number; w: number; h: number }> | null) =>
      ipcRenderer.send(
        C.dock,
        Array.isArray(buttons)
          ? buttons.slice(0, 8).map((b) => ({ id: String(b.id), x: num(b.x), y: num(b.y), w: num(b.w), h: num(b.h) }))
          : null,
      ),
    dockAction: (action: string) => ipcRenderer.send(C.dockAction, String(action)),
    onLine: (cb: (line: unknown) => void) => listen(C.line, cb),
  });
  const call = (method: string, ...args: unknown[]): Promise<unknown> => ipcRenderer.invoke(C.call, method, args);
  contextBridge.exposeInMainWorld('sei', {
    avatarGet: (characterId: string) => call('avatarGet', characterId),
    avatarModelFiles: (characterId: string) => call('avatarModelFiles', characterId),
    onAvatarManifest: (cb: (update: unknown) => void) => listen(C.avatarManifest, cb),
    facepackForCharacter: (characterId: string) => call('facepackForCharacter', characterId),
    facepackManifest: (id: string) => call('facepackManifest', id),
    facepackFile: (id: string, path: string) => call('facepackFile', id, path),
  });
}
