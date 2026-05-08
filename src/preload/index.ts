/**
 * Preload — typed RendererApi bridge.
 * Sources: RESEARCH §Pattern 2, PATTERNS §src/preload/index.ts, CONTEXT D-17.
 */
import { contextBridge, ipcRenderer } from 'electron';
import {
  IpcChannel,
  type RendererApi,
  type BotStatus,
  type LanState,
  type LogBatch,
} from '../shared/ipc';

const api: RendererApi = {
  summon: (id) => ipcRenderer.invoke(IpcChannel.bot.summon, id),
  stop: () => ipcRenderer.invoke(IpcChannel.bot.stop),

  listCharacters: () => ipcRenderer.invoke(IpcChannel.chars.list),
  getCharacter: (id) => ipcRenderer.invoke(IpcChannel.chars.get, id),
  saveCharacter: (c) => ipcRenderer.invoke(IpcChannel.chars.save, c),
  deleteCharacter: (id) => ipcRenderer.invoke(IpcChannel.chars.delete, id),

  getConfig: () => ipcRenderer.invoke(IpcChannel.config.get),
  saveConfig: (c) => ipcRenderer.invoke(IpcChannel.config.save, c),
  saveApiKey: (plaintext) => ipcRenderer.invoke(IpcChannel.config.saveApiKey, plaintext),
  hasApiKey: () => ipcRenderer.invoke(IpcChannel.config.hasApiKey),

  getStartupWarnings: () => ipcRenderer.invoke(IpcChannel.app.warnings),

  onStatus(cb: (status: BotStatus) => void) {
    const handler = (_e: Electron.IpcRendererEvent, status: BotStatus) => cb(status);
    ipcRenderer.on(IpcChannel.bot.status, handler);
    return () => ipcRenderer.off(IpcChannel.bot.status, handler);
  },
  onLog(cb: (batch: LogBatch) => void) {
    const handler = (_e: Electron.IpcRendererEvent, batch: LogBatch) => cb(batch);
    ipcRenderer.on(IpcChannel.bot.logBatch, handler);
    return () => ipcRenderer.off(IpcChannel.bot.logBatch, handler);
  },
  onLan(cb: (state: LanState) => void) {
    const handler = (_e: Electron.IpcRendererEvent, state: LanState) => cb(state);
    ipcRenderer.on(IpcChannel.lan.state, handler);
    return () => ipcRenderer.off(IpcChannel.lan.state, handler);
  },
};

contextBridge.exposeInMainWorld('sei', api);
