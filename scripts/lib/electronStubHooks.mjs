// ESM resolve/load hooks that answer `import ... from 'electron'` with an inert
// stub, so offline probe scripts (scripts/game-sim-probe.ts) can import main-
// process modules whose prompt builders are pure but whose module graph
// reaches paths.ts / safeStorage. Never used by the app or the tests.
// Register with: module.register('./lib/electronStubHooks.mjs', import.meta.url)
const STUB_URL = 'sei-electron-stub:electron'

const SOURCE = `
import { tmpdir } from 'node:os'
const noop = () => {}
const emitter = { on: noop, once: noop, off: noop, removeListener: noop, emit: noop }
export const app = {
  ...emitter,
  isPackaged: false,
  getPath: () => process.env.SEI_PROBE_USERDATA || tmpdir(),
  getVersion: () => '0.0.0-probe',
  getName: () => 'Sei',
  getAppPath: () => process.cwd(),
  whenReady: () => Promise.resolve(),
  commandLine: { hasSwitch: () => false, appendSwitch: noop },
}
export class BrowserWindow { static getAllWindows() { return [] } }
export class Notification { show() {} }
export class Tray {}
export const dialog = {}
export const globalShortcut = { register: noop, unregisterAll: noop }
export const ipcMain = { ...emitter, handle: noop, removeHandler: noop }
export const Menu = { buildFromTemplate: () => ({}), setApplicationMenu: noop }
export const nativeImage = { createFromPath: () => ({}), createEmpty: () => ({}) }
export const net = {}
export const powerMonitor = emitter
export const protocol = { handle: noop, registerSchemesAsPrivileged: noop }
export const safeStorage = { isEncryptionAvailable: () => false, encryptString: (s) => Buffer.from(String(s)), decryptString: (b) => String(b) }
export const screen = { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) }
export const session = {}
export const shell = { openExternal: async () => {} }
export const systemPreferences = {}
export default { app, BrowserWindow, Notification, Tray, dialog, globalShortcut, ipcMain, Menu, nativeImage, net, powerMonitor, protocol, safeStorage, screen, session, shell, systemPreferences }
`

export async function resolve(specifier, context, next) {
  if (specifier === 'electron') return { url: STUB_URL, shortCircuit: true }
  return next(specifier, context)
}

export async function load(url, context, next) {
  if (url === STUB_URL) return { format: 'module', source: SOURCE, shortCircuit: true }
  return next(url, context)
}
