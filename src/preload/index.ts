/**
 * Preload — typed RendererApi bridge.
 * Sources: RESEARCH §Pattern 2, PATTERNS §src/preload/index.ts, CONTEXT D-17.
 *
 * Phase 9 (09-01): adds skin + wizard channels. Main handlers ship in Plans
 * 02/03 (skin) and 04/05 (wizard). The wizardCancel binding is the
 * IPC-crossing abort path for in-flight installs — a renderer-local
 * AbortController can't reach the child process running fabric-installer.
 */
import { contextBridge, ipcRenderer } from 'electron';
import {
  IpcChannel,
  type RendererApi,
  type BotStatus,
  type LanState,
  type LogBatch,
  type WizardProgressEvent,
} from '../shared/ipc';

const api: RendererApi = {
  summon: (id) => ipcRenderer.invoke(IpcChannel.bot.summon, id),
  stop: () => ipcRenderer.invoke(IpcChannel.bot.stop),

  listCharacters: () => ipcRenderer.invoke(IpcChannel.chars.list),
  getCharacter: (id) => ipcRenderer.invoke(IpcChannel.chars.get, id),
  saveCharacter: (c, opts) => ipcRenderer.invoke(IpcChannel.chars.save, c, opts),
  deleteCharacter: (id) => ipcRenderer.invoke(IpcChannel.chars.delete, id),
  resetMemory: (id) => ipcRenderer.invoke(IpcChannel.chars.resetMemory, id),

  getConfig: () => ipcRenderer.invoke(IpcChannel.config.get),
  saveConfig: (c) => ipcRenderer.invoke(IpcChannel.config.save, c),
  saveApiKey: (plaintext) => ipcRenderer.invoke(IpcChannel.config.saveApiKey, plaintext),
  hasApiKey: () => ipcRenderer.invoke(IpcChannel.config.hasApiKey),

  getStartupWarnings: () => ipcRenderer.invoke(IpcChannel.app.warnings),

  // --- Phase 9: skin pipeline (Plan 02/03) ---
  applySkin: (args) => ipcRenderer.invoke(IpcChannel.skin.apply, args),
  removeSkin: (id) => ipcRenderer.invoke(IpcChannel.skin.remove, id),
  uploadSkinPng: () => ipcRenderer.invoke(IpcChannel.skin.uploadPng),
  searchMojangSkin: (u) => ipcRenderer.invoke(IpcChannel.skin.searchMojang, u),
  getSkinServerUrl: () => ipcRenderer.invoke(IpcChannel.skin.getServerUrl),

  // --- Phase 9: setup wizard (Plan 04/05) ---
  detectMcInstalls: () => ipcRenderer.invoke(IpcChannel.wizard.detectInstalls),
  runWizardInstall: (args) => ipcRenderer.invoke(IpcChannel.wizard.install, args),
  wizardCancel: (sessionId) => ipcRenderer.invoke(IpcChannel.wizard.cancel, sessionId),
  getWizardState: () => ipcRenderer.invoke(IpcChannel.wizard.getState),

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
  onWizardProgress(cb: (ev: WizardProgressEvent) => void) {
    const handler = (_e: Electron.IpcRendererEvent, ev: WizardProgressEvent) => cb(ev);
    ipcRenderer.on(IpcChannel.wizard.progress, handler);
    return () => ipcRenderer.off(IpcChannel.wizard.progress, handler);
  },
};

contextBridge.exposeInMainWorld('sei', api);
