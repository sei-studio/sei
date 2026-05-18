// scripts/lib/electron-stub.mjs
//
// Minimal `electron` module replacement for pure-Node verify scripts.
// Substituted via scripts/lib/hook.mjs.
//
// Only the surface src/main/* code touches at module-init time is provided:
//   - `app.getPath(name)` → tmpdir-rooted directory keyed by `name`
//   - `app.isPackaged` → false (forces dev-mode code paths)
//
// Verify scripts that need a known userData layout should set the
// SEI_USER_DATA_OVERRIDE env var before importing src/main/ modules:
//   process.env.SEI_USER_DATA_OVERRIDE = '/tmp/my-fixture-userdata'
//
// `app.getPath('userData')` checks SEI_USER_DATA_OVERRIDE first and falls
// back to a stable tmpdir-rooted path (so two consecutive invocations
// of the same script see the same dir).
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const baseTmp = path.join(os.tmpdir(), 'sei-electron-stub');

function getPath(name) {
  if (name === 'userData') {
    if (process.env.SEI_USER_DATA_OVERRIDE) return process.env.SEI_USER_DATA_OVERRIDE;
    return path.join(baseTmp, 'userData');
  }
  if (name === 'logs') return path.join(baseTmp, 'logs');
  if (name === 'home') return os.homedir();
  if (name === 'appData') return path.join(baseTmp, 'appData');
  return path.join(baseTmp, name);
}

export const app = {
  getPath,
  isPackaged: false,
  isReady: () => true,
  whenReady: async () => undefined,
  on: () => undefined,
  off: () => undefined,
  quit: () => undefined,
  exit: () => undefined,
};

// Minimal stubs for the rest of the surface — verify scripts shouldn't
// touch these, but `import { ipcMain } from 'electron'` in src/main/ipc.ts
// would otherwise crash at module-init time even when nothing in the script
// triggers a handler call.
export const ipcMain = {
  handle: () => undefined,
  on: () => undefined,
  off: () => undefined,
  removeHandler: () => undefined,
};
export const BrowserWindow = class {};
export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showMessageBox: async () => ({ response: 0 }),
};
export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: (s) => Buffer.from(s, 'utf8'),
  decryptString: (b) => b.toString('utf8'),
  getSelectedStorageBackend: () => 'basic_text',
};
export const utilityProcess = { fork: () => undefined };
export const MessageChannelMain = class { constructor() { this.port1 = {}; this.port2 = {}; } };
export const shell = { openExternal: async () => undefined, openPath: async () => '' };

// Default export so `import electron from 'electron'` also works.
export default { app, ipcMain, BrowserWindow, dialog, safeStorage, utilityProcess, MessageChannelMain, shell };
