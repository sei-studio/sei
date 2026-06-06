---
phase: 04-electron-gui-packaging
plan: 05
type: execute
wave: 3
depends_on: [01, 02, 03, 04]
files_modified:
  - src/main/windowChrome.ts
  - src/main/ipc.ts
  - src/main/index.ts
  - src/preload/index.ts
autonomous: true
requirements: [GUI-01, GUI-02, GUI-03, GUI-05]
must_haves:
  truths:
    - "`npm run dev` boots an Electron app with a 1180x760 BrowserWindow showing the renderer (placeholder OK at this stage)"
    - "macOS uses titleBarStyle hiddenInset; Windows uses frame:false + titleBarOverlay; Linux uses frame:false"
    - "Renderer's `window.sei` is bound to a typed RendererApi via contextBridge — no nodeIntegration"
    - "Every RendererApi method has a corresponding ipcMain.handle registration that validates input and calls into a plan-03/plan-04 module"
    - "LAN watcher opens once at app boot and streams lan:state events to renderer via webContents.send"
    - "runFirstLaunchMigration runs once after app.whenReady, before any character is summoned"
    - "app.before-quit calls supervisor.shutdown and lanWatcher.stop so the app exits cleanly"
  artifacts:
    - path: src/main/windowChrome.ts
      provides: "createMainWindow(opts) — platform-branched BrowserWindow"
      exports: ["createMainWindow"]
    - path: src/main/ipc.ts
      provides: "registerIpcHandlers(deps) wiring every IpcChannel to main-process modules"
      exports: ["registerIpcHandlers"]
    - path: src/main/index.ts
      provides: "Main process entrypoint — composes BrowserWindow + LAN watcher + bot supervisor + IPC"
      exports: []
    - path: src/preload/index.ts
      provides: "contextBridge.exposeInMainWorld('sei', api) — typed RendererApi"
      exports: []
  key_links:
    - from: src/main/index.ts
      to: src/main/ipc.ts
      via: "registerIpcHandlers call"
      pattern: "registerIpcHandlers"
    - from: src/main/index.ts
      to: src/main/lanWatcher.ts
      via: "watchLan call"
      pattern: "watchLan"
    - from: src/main/index.ts
      to: src/main/botSupervisor.ts
      via: "createBotSupervisor call"
      pattern: "createBotSupervisor"
    - from: src/main/index.ts
      to: src/main/migration.ts
      via: "runFirstLaunchMigration call"
      pattern: "runFirstLaunchMigration"
    - from: src/preload/index.ts
      to: src/shared/ipc.ts
      via: "RendererApi type + IpcChannel constants"
      pattern: "IpcChannel\\."
---

<objective>
Compose the main process. This plan wires every Wave-2 module into the Electron lifecycle: app.whenReady, BrowserWindow creation, IPC handler registration, LAN watcher boot, supervisor instantiation, migration kickoff, graceful shutdown. Also creates the preload bridge that exposes `window.sei` to the renderer.

Purpose: Wave 2 produced building blocks (configStore, characterStore, apiKeyStore, migration, lanWatcher, botSupervisor, logRouter). This plan turns them into a running Electron app. After this lands, `npm run dev` boots a window and Wave 3 plans (06–08) can populate the renderer against a stable IPC surface.

Output: 4 TS files. Plan blocks Wave 3.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@CLAUDE.md
@.planning/phases/04-electron-gui-packaging/04-CONTEXT.md
@.planning/phases/04-electron-gui-packaging/04-RESEARCH.md
@.planning/phases/04-electron-gui-packaging/04-PATTERNS.md
@.planning/phases/04-electron-gui-packaging/04-UI-SPEC.md
@src/shared/ipc.ts
@src/shared/characterSchema.ts
@src/shared/errorClasses.ts
@src/main/paths.ts
@src/main/configStore.ts
@src/main/characterStore.ts
@src/main/apiKeyStore.ts
@src/main/migration.ts
@src/main/lanWatcher.ts
@src/main/botSupervisor.ts
@src/main/logRouter.ts

<interfaces>
Wave-2 module surfaces (already exist):

- src/main/configStore.ts — `loadConfig()`, `saveConfig(c)`, `DEFAULT_CONFIG`
- src/main/characterStore.ts — `listCharacters()`, `getCharacter(id)`, `saveCharacter(c)`, `deleteCharacter(id)`
- src/main/apiKeyStore.ts — `saveApiKey(plaintext)`, `loadApiKey()`, `hasApiKey()`, `backendKind()`
- src/main/migration.ts — `runFirstLaunchMigration(cwdConfigPath?)`
- src/main/lanWatcher.ts — `watchLan({onUpdate, staleMs}): {stop}`
- src/main/botSupervisor.ts — `createBotSupervisor({getLanPort, sendStatus, sendLog})`

From src/shared/ipc.ts:
- RendererApi (13 methods)
- BotStatus, LanState, LogBatch
- IpcChannel const (every channel name)

Platform chrome contract (UI-SPEC §MacosWindow + RESEARCH §Pitfall 9):
- macOS: titleBarStyle: 'hiddenInset'
- Windows: frame: false, titleBarOverlay: { color, symbolColor, height: 38 }
- Linux: frame: false
- Window: 1180 x 760 (UI-SPEC AppWindow)
- contextIsolation: true, nodeIntegration: false (D-15)
</interfaces>

<key_locked_decisions>
- D-15: contextIsolation: true, nodeIntegration: false; mineflayer ONLY in utilityProcess.
- D-17: Preload exposes RendererApi via contextBridge.
- D-21: LAN watcher opens once at app boot, lives for whole session.
- D-32: macOS traffic lights TOP-LEFT (titleBarStyle: 'hiddenInset').
- Pitfall 5: All BrowserWindow / utilityProcess.fork must be after `app.whenReady()`.
- Pitfall 9: Platform-branched chrome.
- UI-SPEC §Defaults: app:ready IPC channel — renderer fires when first paint completes; main forwards from there if needed (for v1 main can simply log it).
- Project Constraint §5: 30s summon, 10s stop (botSupervisor enforces).
- RESEARCH Q5: Logs always batched to whichever webContents exists; no gating on renderer presence.
</key_locked_decisions>
</context>

<tasks>

<task type="auto" tdd="false">
  <name>Task 1: Create src/main/windowChrome.ts and src/preload/index.ts</name>
  <read_first>
    - .planning/phases/04-electron-gui-packaging/04-RESEARCH.md §"Pitfall 9" + §"Pattern 2" (lines ~437–474)
    - .planning/phases/04-electron-gui-packaging/04-UI-SPEC.md §"MacosWindow / AppWindow" (lines ~330–342)
    - .planning/phases/04-electron-gui-packaging/04-CONTEXT.md D-15, D-32
    - .planning/phases/04-electron-gui-packaging/04-PATTERNS.md §"src/preload/index.ts" (lines ~426–449)
    - src/shared/ipc.ts (RendererApi, IpcChannel)
  </read_first>
  <behavior>
    windowChrome.ts: Exports `createMainWindow(opts: { preloadPath, indexHtmlUrlOrPath })` returning a BrowserWindow (1180x760, sharp corners, platform-branched chrome).
    preload/index.ts: `contextBridge.exposeInMainWorld('sei', api)` where every method calls `ipcRenderer.invoke(IpcChannel.<channel>, ...)` for request/response, or `ipcRenderer.on(...)` for push subscriptions returning `Unsubscribe`.
  </behavior>
  <action>
**Step 1.** Create `src/main/windowChrome.ts`:

```ts
/**
 * Platform-branched BrowserWindow chrome.
 * Sources: UI-SPEC §MacosWindow/AppWindow, CONTEXT D-32, RESEARCH Pitfall 9, D-15.
 */
import { BrowserWindow } from 'electron';

export interface CreateMainWindowOptions {
  preloadPath: string;
  indexHtmlUrlOrPath: string;
}

export function createMainWindow(opts: CreateMainWindowOptions): BrowserWindow {
  const platformChrome: Electron.BrowserWindowConstructorOptions =
    process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' }
      : process.platform === 'win32'
        ? {
            frame: false,
            titleBarOverlay: {
              color: '#F6F5F2',
              symbolColor: '#1A1D24',
              height: 38,
            },
          }
        : { frame: false };

  const win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 1180,
    minHeight: 760,
    show: false,
    backgroundColor: '#FDFEFF',
    webPreferences: {
      preload: opts.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    ...platformChrome,
  });

  win.once('ready-to-show', () => win.show());

  if (
    opts.indexHtmlUrlOrPath.startsWith('http://') ||
    opts.indexHtmlUrlOrPath.startsWith('https://') ||
    opts.indexHtmlUrlOrPath.startsWith('file://')
  ) {
    void win.loadURL(opts.indexHtmlUrlOrPath);
  } else {
    void win.loadFile(opts.indexHtmlUrlOrPath);
  }

  return win;
}
```

**Step 2.** Create `src/preload/index.ts`:

```ts
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
```
  </action>
  <verify>
    <automated>bash -c 'test -f src/main/windowChrome.ts && test -f src/preload/index.ts && grep -q "export function createMainWindow" src/main/windowChrome.ts && grep -q "titleBarStyle: .hiddenInset." src/main/windowChrome.ts && grep -q "process.platform === .win32." src/main/windowChrome.ts && grep -q "titleBarOverlay:" src/main/windowChrome.ts && grep -q "frame: false" src/main/windowChrome.ts && grep -q "width: 1180" src/main/windowChrome.ts && grep -q "height: 760" src/main/windowChrome.ts && grep -q "contextIsolation: true" src/main/windowChrome.ts && grep -q "nodeIntegration: false" src/main/windowChrome.ts && grep -q "contextBridge.exposeInMainWorld(.sei." src/preload/index.ts && grep -q "ipcRenderer.invoke(IpcChannel" src/preload/index.ts && grep -q "ipcRenderer.on(IpcChannel.lan.state" src/preload/index.ts && grep -q "ipcRenderer.on(IpcChannel.bot.logBatch" src/preload/index.ts && grep -q "ipcRenderer.on(IpcChannel.bot.status" src/preload/index.ts && grep -q "ipcRenderer.off" src/preload/index.ts && npx tsc --noEmit -p tsconfig.node.json 2>&1 | grep -E "(windowChrome|preload/index)\.ts.*error TS" | grep -v "TS6053\\|TS6307" | wc -l | grep -qE "^[[:space:]]*0$"'</automated>
  </verify>
  <acceptance_criteria>
    - `src/main/windowChrome.ts` exports `createMainWindow`
    - File contains `process.platform === 'darwin'` branch with `titleBarStyle: 'hiddenInset'`
    - File contains `process.platform === 'win32'` branch with `titleBarOverlay:` block
    - File contains `frame: false` literal (Windows + Linux branches)
    - File contains `width: 1180` and `height: 760`
    - `webPreferences` block contains `contextIsolation: true` AND `nodeIntegration: false`
    - `src/preload/index.ts` calls `contextBridge.exposeInMainWorld('sei', ...)` exactly once
    - preload imports `IpcChannel` from `../shared/ipc`
    - preload contains all 13 RendererApi method bindings (summon, stop, listCharacters, getCharacter, saveCharacter, deleteCharacter, getConfig, saveConfig, saveApiKey, hasApiKey, onStatus, onLog, onLan)
    - preload's three `on*` methods each return a function calling `ipcRenderer.off(...)` (verified by `grep -q "ipcRenderer.off"`)
    - `npx tsc --noEmit -p tsconfig.node.json` reports 0 errors related to these files
  </acceptance_criteria>
  <done>BrowserWindow factory + preload bridge complete. Renderer can call any RendererApi method against a stable contract.</done>
</task>

<task type="auto" tdd="false">
  <name>Task 2: Create src/main/ipc.ts (registerIpcHandlers)</name>
  <read_first>
    - src/shared/ipc.ts (IpcChannel, RendererApi, types)
    - src/shared/characterSchema.ts (CharacterSchema, UserConfigSchema for runtime validation of renderer payloads)
    - src/main/configStore.ts (loadConfig, saveConfig)
    - src/main/characterStore.ts (listCharacters, getCharacter, saveCharacter, deleteCharacter)
    - src/main/apiKeyStore.ts (saveApiKey, hasApiKey)
    - src/main/botSupervisor.ts (createBotSupervisor return type)
    - .planning/phases/04-electron-gui-packaging/04-PATTERNS.md §"Zod validation at every external boundary" (lines ~715–722)
  </read_first>
  <behavior>
    - `registerIpcHandlers(deps)` accepts `{ supervisor: BotSupervisor }` and registers `ipcMain.handle` for every RendererApi request/response method (10 channels: bot.summon, bot.stop, chars.list, chars.get, chars.save, chars.delete, config.get, config.save, config.saveApiKey, config.hasApiKey).
    - Each handler runtime-validates inputs with Zod schemas before calling into the store/supervisor.
    - Handlers translate exceptions into either `throw new Error(...)` (which surfaces to renderer's `.catch(...)`) OR no-op success — never crash main.
    - Push channels (`bot:status`, `bot:log:batch`, `lan:state`) are NOT registered here — those are emitted by main directly via `webContents.send`. (The dependencies passed to ipc.ts include `supervisor`; the `sendStatus` / `sendLog` / `sendLan` callbacks are wired by `main/index.ts` directly into `supervisor` and `lanWatcher`.)
    - Returns nothing; side effect is the handler registration.
  </behavior>
  <action>
Create `src/main/ipc.ts`:

```ts
/**
 * IPC handler registrations. Wires every IpcChannel.<request-response> to
 * its main-process module. Push channels (status / log / lan) are emitted
 * directly by main/index.ts via webContents.send.
 *
 * Sources:
 *   - shared/ipc.ts (IpcChannel, RendererApi)
 *   - PATTERNS §"Zod validation at every external boundary"
 */
import { ipcMain } from 'electron';
import { z } from 'zod';
import { IpcChannel } from '../shared/ipc';
import { CharacterSchema, UserConfigSchema, type Character, type UserConfig } from '../shared/characterSchema';
import { loadConfig, saveConfig } from './configStore';
import { listCharacters, getCharacter, saveCharacter, deleteCharacter } from './characterStore';
import { saveApiKey, hasApiKey } from './apiKeyStore';
import type { BotSupervisor } from './botSupervisor';

export interface IpcHandlerDeps {
  supervisor: BotSupervisor;
}

const IdSchema = z.string().min(1);
const PlaintextSchema = z.string().min(1);

export function registerIpcHandlers(deps: IpcHandlerDeps): void {
  // Bot supervision
  ipcMain.handle(IpcChannel.bot.summon, async (_event, idArg: unknown) => {
    const id = IdSchema.parse(idArg);
    await deps.supervisor.summon(id);
  });
  ipcMain.handle(IpcChannel.bot.stop, async () => {
    await deps.supervisor.stop();
  });

  // Character CRUD
  ipcMain.handle(IpcChannel.chars.list, async (): Promise<Character[]> => {
    return await listCharacters();
  });
  ipcMain.handle(IpcChannel.chars.get, async (_event, idArg: unknown): Promise<Character | null> => {
    const id = IdSchema.parse(idArg);
    return await getCharacter(id);
  });
  ipcMain.handle(IpcChannel.chars.save, async (_event, charArg: unknown): Promise<void> => {
    const character = CharacterSchema.parse(charArg);
    await saveCharacter(character);
  });
  ipcMain.handle(IpcChannel.chars.delete, async (_event, idArg: unknown): Promise<void> => {
    const id = IdSchema.parse(idArg);
    // Refuse to delete sui — UI also gates this, but defense-in-depth.
    if (id === 'sui') throw new Error('Cannot delete the default character.');
    // Refuse to delete the active character — UI should never request this.
    if (deps.supervisor.getActiveId() === id) {
      throw new Error('Cannot delete the currently summoned character. Stop first.');
    }
    await deleteCharacter(id);
  });

  // User config
  ipcMain.handle(IpcChannel.config.get, async (): Promise<UserConfig> => {
    return await loadConfig();
  });
  ipcMain.handle(IpcChannel.config.save, async (_event, cfgArg: unknown): Promise<void> => {
    const cfg = UserConfigSchema.parse(cfgArg);
    await saveConfig(cfg);
  });
  ipcMain.handle(IpcChannel.config.saveApiKey, async (_event, plaintextArg: unknown): Promise<void> => {
    const plaintext = PlaintextSchema.parse(plaintextArg);
    await saveApiKey(plaintext);
  });
  ipcMain.handle(IpcChannel.config.hasApiKey, async (): Promise<boolean> => {
    return await hasApiKey();
  });
}
```
  </action>
  <verify>
    <automated>bash -c 'test -f src/main/ipc.ts && grep -q "export function registerIpcHandlers" src/main/ipc.ts && grep -q "ipcMain.handle(IpcChannel.bot.summon" src/main/ipc.ts && grep -q "ipcMain.handle(IpcChannel.bot.stop" src/main/ipc.ts && grep -q "ipcMain.handle(IpcChannel.chars.list" src/main/ipc.ts && grep -q "ipcMain.handle(IpcChannel.chars.get" src/main/ipc.ts && grep -q "ipcMain.handle(IpcChannel.chars.save" src/main/ipc.ts && grep -q "ipcMain.handle(IpcChannel.chars.delete" src/main/ipc.ts && grep -q "ipcMain.handle(IpcChannel.config.get" src/main/ipc.ts && grep -q "ipcMain.handle(IpcChannel.config.save" src/main/ipc.ts && grep -q "ipcMain.handle(IpcChannel.config.saveApiKey" src/main/ipc.ts && grep -q "ipcMain.handle(IpcChannel.config.hasApiKey" src/main/ipc.ts && grep -q "CharacterSchema.parse" src/main/ipc.ts && grep -q "UserConfigSchema.parse" src/main/ipc.ts && grep -q "id === .sui." src/main/ipc.ts && (grep -c "ipcMain.handle(IpcChannel\\." src/main/ipc.ts | awk "\$1 >= 10 {exit 0} {exit 1}") && npx tsc --noEmit -p tsconfig.node.json 2>&1 | grep -E "src/main/ipc\.ts.*error TS" | grep -v "TS2307.*../bot/" | wc -l | grep -qE "^[[:space:]]*0$"'</automated>
  </verify>
  <acceptance_criteria>
    - `src/main/ipc.ts` exists and exports `registerIpcHandlers(deps)`
    - All 10 request/response channels are registered (verified by grep matching each `ipcMain.handle(IpcChannel.<...>...)`):
      - bot.summon, bot.stop
      - chars.list, chars.get, chars.save, chars.delete
      - config.get, config.save, config.saveApiKey, config.hasApiKey
    - File contains `CharacterSchema.parse(charArg)` (runtime validation on save)
    - File contains `UserConfigSchema.parse(cfgArg)` (runtime validation on save)
    - File contains the literal `id === 'sui'` (defense-in-depth — refuse to delete default character)
    - File contains a check on `deps.supervisor.getActiveId()` for delete guard
    - `npx tsc --noEmit -p tsconfig.node.json` reports 0 errors for `src/main/ipc.ts`
  </acceptance_criteria>
  <done>IPC handler registration ready. Plan 06+ renderer screens can `await window.sei.<method>(...)` and reach the right module.</done>
</task>

<task type="auto" tdd="false">
  <name>Task 3: Create src/main/index.ts (Electron lifecycle composer)</name>
  <read_first>
    - src/index.js (legacy boot composer pattern — `start()` lines 24–105 — relocated to src/bot/index.js but original lives in PATTERNS analog)
    - .planning/phases/04-electron-gui-packaging/04-PATTERNS.md §"src/main/index.ts" (lines ~370–424)
    - .planning/phases/04-electron-gui-packaging/04-RESEARCH.md §"Pitfall 5" (BrowserWindow / utilityProcess.fork after app.whenReady)
    - .planning/phases/04-electron-gui-packaging/04-RESEARCH.md §"Pitfall 3" (Linux basic_text fallback)
    - src/main/windowChrome.ts (Task 1)
    - src/main/ipc.ts (Task 2)
    - src/main/lanWatcher.ts, botSupervisor.ts, migration.ts, apiKeyStore.ts, configStore.ts (Plan 03/04)
    - src/shared/ipc.ts (IpcChannel)
  </read_first>
  <behavior>
    - On `app.whenReady`: run `runFirstLaunchMigration()`, then create `mainWindow` via `createMainWindow`. Open `lanWatcher` (single instance) and forward state to renderer via `mainWindow.webContents.send(IpcChannel.lan.state, ...)`. Cache the latest LAN state in a module-level `let latestLanState`. Construct `supervisor = createBotSupervisor({ getLanPort, sendStatus, sendLog })`. Register IPC handlers via `registerIpcHandlers({ supervisor })`. On `mainWindow.webContents.on('did-finish-load')` and on every change, immediately replay the latest LAN state to renderer (so a freshly-loaded renderer doesn't have to wait for the next packet).
    - On `app.before-quit`: prevent default, await `supervisor.shutdown()`, call `lanWatcher.stop()`, then `app.exit(0)`.
    - On `window-all-closed`: quit on non-darwin (Electron convention).
    - On macOS `activate`: re-create window if all closed (Electron convention).
    - On Linux: check `backendKind() === 'basic_text'` after app.whenReady; if so, log a one-time warn (renderer-side toast happens later from a `lan:state` analog channel — but for the v1 spec, a console log is sufficient).
    - All paths to preload + index.html resolve via electron-vite conventions:
      - dev: `process.env.ELECTRON_RENDERER_URL ?? 'http://localhost:5173'` for renderer; preload at `path.join(__dirname, '../preload/index.js')` (electron-vite outputs preload to `dist/preload/index.js`).
      - prod: `path.join(__dirname, '../renderer/index.html')`; preload at `path.join(__dirname, '../preload/index.js')`.
    - Ensures `app.requestSingleInstanceLock()` so two instances of Sei don't fight over the multicast socket and userData files.
  </behavior>
  <action>
Create `src/main/index.ts`:

```ts
/**
 * Electron main process entrypoint.
 *
 * Composes:
 *   - Single-instance lock
 *   - First-launch migration (legacy persona → characters/sui.json)
 *   - BrowserWindow (1180x760, platform-branched chrome)
 *   - LAN watcher (shared UDP socket, 3s stale)
 *   - Bot supervisor (one bot at a time)
 *   - IPC handler registrations
 *   - Graceful shutdown on before-quit
 *
 * Sources:
 *   - PATTERNS §src/main/index.ts (lines 370–424)
 *   - RESEARCH §Pattern 1 (utilityProcess + MessageChannel) — used inside botSupervisor
 *   - RESEARCH §Pitfall 5 (everything behind app.whenReady)
 *   - CONTEXT D-15, D-21, D-32, project constraints
 */
import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { createMainWindow } from './windowChrome';
import { registerIpcHandlers } from './ipc';
import { watchLan } from './lanWatcher';
import { createBotSupervisor } from './botSupervisor';
import { runFirstLaunchMigration } from './migration';
import { backendKind } from './apiKeyStore';
import { IpcChannel, type LanState, type BotStatus, type LogBatch } from '../shared/ipc';

const logger = {
  info: (m: string) => console.log(`[sei] ${m}`),
  warn: (m: string) => console.warn(`[sei] ${m}`),
  error: (m: string) => console.error(`[sei] ${m}`),
};

let mainWindow: BrowserWindow | null = null;
let latestLanState: LanState = { kind: 'not_connected' };
let lanWatcherHandle: { stop: () => void } | null = null;
let supervisor: ReturnType<typeof createBotSupervisor> | null = null;

function preloadPath(): string {
  // electron-vite outputs preload to dist/preload/index.js relative to dist/main/index.js
  return path.join(__dirname, '../preload/index.js');
}

function rendererTarget(): string {
  // electron-vite sets ELECTRON_RENDERER_URL in dev (http://localhost:<port>)
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    return process.env.ELECTRON_RENDERER_URL;
  }
  return path.join(__dirname, '../renderer/index.html');
}

function broadcastLan(state: LanState): void {
  latestLanState = state;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IpcChannel.lan.state, state);
  }
}

function broadcastStatus(status: BotStatus): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IpcChannel.bot.status, status);
  }
}

function broadcastLog(batch: LogBatch): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IpcChannel.bot.logBatch, batch);
  }
}

function getLanPort(): number | null {
  return latestLanState.kind === 'connected' ? latestLanState.port : null;
}

async function bootstrap(): Promise<void> {
  // 1. Migration before any character is summoned (D-10)
  try { await runFirstLaunchMigration(); }
  catch (err) { logger.warn(`migration failed: ${(err as Error).message}`); }

  // 2. Create main window
  mainWindow = createMainWindow({
    preloadPath: preloadPath(),
    indexHtmlUrlOrPath: rendererTarget(),
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  // Replay latest LAN state on did-finish-load so freshly-loaded renderer is in sync.
  mainWindow.webContents.on('did-finish-load', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IpcChannel.lan.state, latestLanState);
    }
  });

  // 3. LAN watcher (D-21 — single instance for the whole app session)
  lanWatcherHandle = watchLan({
    onUpdate: broadcastLan,
    staleMs: 3000,
  });

  // 4. Bot supervisor
  supervisor = createBotSupervisor({
    getLanPort,
    sendStatus: broadcastStatus,
    sendLog: broadcastLog,
  });

  // 5. IPC handlers
  registerIpcHandlers({ supervisor });

  // 6. Linux fallback warning (RESEARCH Pitfall 3)
  if (process.platform === 'linux' && backendKind() === 'basic_text') {
    logger.warn(
      'safeStorage backend is basic_text — API key encryption is plaintext-with-hardcoded-key on this system. ' +
      'Renderer will surface KEYCHAIN_FALLBACK_PLAINTEXT warning to the user.',
    );
  }
}

// Single-instance lock — second launch focuses existing window
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    bootstrap().catch((err) => {
      logger.error(`bootstrap failed: ${(err as Error).message}`);
      app.exit(1);
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0 && mainWindow === null) {
        bootstrap().catch((err) => logger.error(`re-bootstrap failed: ${(err as Error).message}`));
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('before-quit', async (e) => {
    if (!supervisor && !lanWatcherHandle) return; // already shut down
    e.preventDefault();
    try { if (supervisor) await supervisor.shutdown(); } catch (err) { logger.warn(`supervisor shutdown failed: ${(err as Error).message}`); }
    try { if (lanWatcherHandle) lanWatcherHandle.stop(); } catch {}
    supervisor = null;
    lanWatcherHandle = null;
    app.exit(0);
  });
}
```
  </action>
  <verify>
    <automated>bash -c 'test -f src/main/index.ts && grep -q "import { app, BrowserWindow } from .electron." src/main/index.ts && grep -q "createMainWindow" src/main/index.ts && grep -q "registerIpcHandlers" src/main/index.ts && grep -q "watchLan" src/main/index.ts && grep -q "createBotSupervisor" src/main/index.ts && grep -q "runFirstLaunchMigration" src/main/index.ts && grep -q "app.whenReady()" src/main/index.ts && grep -q "app.requestSingleInstanceLock" src/main/index.ts && grep -q "app.on(.before-quit." src/main/index.ts && grep -q "supervisor.shutdown" src/main/index.ts && grep -q "lanWatcherHandle.stop" src/main/index.ts && grep -q "ELECTRON_RENDERER_URL" src/main/index.ts && grep -q "did-finish-load" src/main/index.ts && grep -q "backendKind() === .basic_text." src/main/index.ts && grep -q "process.platform !== .darwin." src/main/index.ts && npx tsc --noEmit -p tsconfig.node.json 2>&1 | grep -E "src/main/index\.ts.*error TS" | grep -v "TS2307.*../bot/" | wc -l | grep -qE "^[[:space:]]*0$"'</automated>
  </verify>
  <acceptance_criteria>
    - `src/main/index.ts` exists
    - File imports and calls `createMainWindow`, `registerIpcHandlers`, `watchLan`, `createBotSupervisor`, `runFirstLaunchMigration`, `backendKind`
    - Bootstrap logic is gated behind `app.whenReady().then(...)` (Pitfall 5)
    - `app.requestSingleInstanceLock()` is called and second-instance handler focuses the existing window
    - `app.on('before-quit', ...)` calls `supervisor.shutdown()` then `lanWatcherHandle.stop()`
    - Renderer URL resolution uses `process.env.ELECTRON_RENDERER_URL` for dev path
    - File contains `did-finish-load` handler that replays the latest LAN state
    - File contains `backendKind() === 'basic_text'` check on Linux
    - `process.platform !== 'darwin'` guard on `window-all-closed`
    - `npx tsc --noEmit -p tsconfig.node.json` reports 0 errors for `src/main/index.ts`
  </acceptance_criteria>
  <done>Main process composer complete. `npm run dev` should boot a window. The renderer entrypoint is still missing (plan 06 creates it) — Vite will report a missing index.html until plan 06 lands.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| renderer→main IPC | Validated via Zod at every handler entry |
| main→renderer push | webContents.send is one-way; renderer receives but cannot inject |
| second-instance | requestSingleInstanceLock prevents two concurrent main processes from racing on the multicast socket / userData files |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-04-21 | Tampering | renderer-supplied character payload | mitigate | `CharacterSchema.parse(...)` at IPC boundary in src/main/ipc.ts |
| T-04-22 | Tampering | renderer asks to delete the active or default character | mitigate | id === 'sui' refusal + supervisor.getActiveId() === id refusal in src/main/ipc.ts |
| T-04-23 | Spoofing | second instance hijacks userData files | mitigate | requestSingleInstanceLock + second-instance focus pattern |
| T-04-24 | Information Disclosure | renderer enabled with nodeIntegration | mitigate | windowChrome.ts hardcodes `contextIsolation: true, nodeIntegration: false` |
| T-04-25 | Denial of Service | unhandled bootstrap exception | mitigate | bootstrap wrapped in `.catch(err => app.exit(1))` so failure is loud, not zombied |
| T-04-26 | Information Disclosure | Linux basic_text plaintext key | accept (warn) | console.warn at boot; renderer-side toast (KEYCHAIN_FALLBACK_PLAINTEXT) plumbed in plan 09 |
</threat_model>

<verification>
- `npx tsc --noEmit -p tsconfig.node.json` reports 0 errors for any file in `src/main/` or `src/preload/`
- `npm run dev` (after plan 06 ships index.html) boots the app, shows a 1180x760 window, and logs `[sei] migration: ...` (or no migration line if no legacy config)
- A grep verifies that the only `BrowserWindow` construction site is `src/main/windowChrome.ts` (no rogue secondary windows)
</verification>

<success_criteria>
- Wave 3 plans (06–08) can run `npm run dev` and see their renderer code load against a fully-functional preload/IPC surface.
- Plan 11 (clean-VM smoke) verifies that on a fresh machine: app launches → first paint → mainWindow shows → LAN pill updates as Minecraft opens to LAN → summoning Sui forks bot → logs flow → stop terminates cleanly.
</success_criteria>

<output>
After completion, create `.planning/phases/04-electron-gui-packaging/04-05-SUMMARY.md` documenting:
- The exact preload + renderer path resolution (since electron-vite output paths matter for plan 11 packaged builds — verify on first build)
- Confirmation that `npm run dev` boots a window (even if the window shows a Vite error overlay because no index.html exists yet — this is expected; plan 06 fixes it)
- Note for plan 06 executor: the renderer can call `window.sei.<method>` immediately on App mount; preload bindings are ready before the renderer code runs.
- Note for plan 09 executor: the Linux basic_text warning is currently console-only; the renderer-side toast surface is plan 09's territory and consumes `bot:status` with `error: 'KEYCHAIN_FALLBACK_PLAINTEXT'` if we extend the supervisor to emit it.
</output>
