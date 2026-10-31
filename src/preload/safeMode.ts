/**
 * Preload for the safe-mode screen (261031, T277).
 *
 * Imports ONLY 'electron': the window is sandboxed, and a sandboxed preload
 * cannot require a shared chunk, so nothing here may come from src/shared
 * (electron-vite would split it into a chunk this file then fails to load).
 * The channel names are therefore spelled out, and safeMode.test.ts checks
 * them against IpcChannel.
 *
 * Exposes `window.seiSafeMode`:
 *   action(name)  -> Promise<{ ok: boolean }>  (the buttons + update steps)
 *   onUpdate(cb)  -> cb(kind, payload) for the updater's pushes, shape only
 *   ready()       -> the page is listening (main flushes held pushes)
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

export const SAFE_MODE_ACTION_CHANNEL = 'safe-mode:action';
export const SAFE_MODE_READY_CHANNEL = 'safe-mode:ready';

/** Updater push channels (IpcChannel.app.*) and the kind the page sees. */
export const SAFE_MODE_UPDATE_CHANNELS = {
  'app:update-checking': 'checking',
  'app:update-not-available': 'not-available',
  'app:update-available': 'available',
  'app:update-progress': 'progress',
  'app:update-downloaded': 'downloaded',
  'app:update-error': 'error',
} as const;

export const SAFE_MODE_ACTIONS = ['check', 'download', 'install', 'open-logs', 'reset-settings', 'normal-start'] as const;

type UpdateKind = (typeof SAFE_MODE_UPDATE_CHANNELS)[keyof typeof SAFE_MODE_UPDATE_CHANNELS];

/** Only the fields the page needs; error text never reaches it. */
function shapeOf(kind: UpdateKind, payload: unknown): Record<string, unknown> | null {
  const p = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  if (kind === 'available') return { version: typeof p.latestVersion === 'string' ? p.latestVersion : '' };
  if (kind === 'progress') return { percent: typeof p.percent === 'number' ? p.percent : 0 };
  if (kind === 'downloaded') return { forced: p.forced === true };
  return null;
}

const api = {
  action(name: string): Promise<{ ok: boolean }> {
    if (!(SAFE_MODE_ACTIONS as readonly string[]).includes(name)) return Promise.resolve({ ok: false });
    return ipcRenderer.invoke(SAFE_MODE_ACTION_CHANNEL, name) as Promise<{ ok: boolean }>;
  },
  onUpdate(cb: (kind: UpdateKind, payload: Record<string, unknown> | null) => void): void {
    for (const [channel, kind] of Object.entries(SAFE_MODE_UPDATE_CHANNELS)) {
      ipcRenderer.on(channel, (_e: IpcRendererEvent, payload: unknown) => cb(kind, shapeOf(kind, payload)));
    }
  },
  ready(): void {
    ipcRenderer.send(SAFE_MODE_READY_CHANNEL);
  },
};

// Tests import this file for its constants without an Electron context.
if (typeof contextBridge?.exposeInMainWorld === 'function') {
  contextBridge.exposeInMainWorld('seiSafeMode', api);
}
