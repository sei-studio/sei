---
phase: 04-electron-gui-packaging
plan: 05
subsystem: main-entry-and-ipc
tags: [electron, main-process, preload, contextBridge, ipc, browser-window, lifecycle]
dependency_graph:
  requires:
    - phase: 04-electron-gui-packaging plan 01
      provides: "electron-vite scaffold + tsconfig.node.json + tsconfig.web.json + preload directory layout convention"
    - phase: 04-electron-gui-packaging plan 02
      provides: "src/shared/ipc.ts (IpcChannel, RendererApi, BotStatus, LanState, LogBatch types)"
    - phase: 04-electron-gui-packaging plan 03
      provides: "src/main/configStore.ts, characterStore.ts, apiKeyStore.ts (backendKind), migration.ts"
    - phase: 04-electron-gui-packaging plan 04
      provides: "src/main/lanWatcher.ts (watchLan), src/main/botSupervisor.ts (createBotSupervisor)"
  provides:
    - "src/main/windowChrome.ts — createMainWindow(opts) returns a 1180x760 BrowserWindow with platform-branched chrome (macOS hiddenInset / Windows titleBarOverlay / Linux frame:false), contextIsolation:true + nodeIntegration:false"
    - "src/main/ipc.ts — registerIpcHandlers(deps) registers ipcMain.handle for all 10 request/response channels with Zod validation at every boundary"
    - "src/main/index.ts — Electron main entrypoint: single-instance lock, app.whenReady bootstrap (migration -> window -> watchLan -> supervisor -> IPC), LAN state cache + did-finish-load replay, graceful before-quit"
    - "src/preload/index.ts — contextBridge.exposeInMainWorld('sei', api) typed RendererApi (13 methods)"
  affects:
    - "Plan 06 (renderer scaffold) — can now `import.meta.env.ELECTRON_RENDERER_URL` is served and `window.sei.*` is available before App mount"
    - "Plan 07/08 (renderer screens) — every render-side store can call `window.sei.<method>` against a stable IPC surface; subscriptions via onStatus/onLog/onLan return Unsubscribe"
    - "Plan 09 (error mapping) — Linux basic_text warning is currently console-only at boot; renderer-side toast surface (KEYCHAIN_FALLBACK_PLAINTEXT) is plan 09's territory"
    - "Plan 11 (clean-VM smoke) — can validate `npm run dev` boot, single-instance lock, before-quit graceful shutdown on packaged builds"
tech_stack:
  added: []
  patterns:
    - "Platform-branched BrowserWindow chrome via inline ternary into ...platformChrome spread (UI-SPEC §MacosWindow + RESEARCH Pitfall 9)"
    - "contextBridge.exposeInMainWorld with typed RendererApi (D-15, D-17, RESEARCH Pattern 2) — preload imports IpcChannel constants and types from src/shared/ipc.ts (single source of truth)"
    - "ipcRenderer.on(...) handler + closure returning ipcRenderer.off(...) for typed Unsubscribe contract"
    - "Push-channel state cache (latestLanState) + did-finish-load replay so a freshly-loaded renderer never lags behind the watcher"
    - "Single-instance lock with second-instance focus pattern (T-04-23 mitigation)"
    - "Bootstrap is wrapped in app.whenReady().then(() => bootstrap().catch(app.exit(1))) — failure is loud, not zombied (T-04-25 mitigation)"
    - "Graceful before-quit with e.preventDefault() + await supervisor.shutdown() + lanWatcherHandle.stop() then app.exit(0)"
    - "Zod validation at every IPC boundary (PATTERNS) — IdSchema/PlaintextSchema for primitives, CharacterSchema/UserConfigSchema for structured payloads"
    - "Defense-in-depth deletion guard: refuse `id === 'sui'` and refuse the active character (T-04-22 mitigation)"
key_files:
  created:
    - "src/main/windowChrome.ts"
    - "src/main/ipc.ts"
    - "src/main/index.ts"
    - "src/preload/index.ts"
  modified: []
key_decisions:
  - "preload's three on* methods use a closure-captured IpcRendererEvent handler so the unsubscribe function passed back to the renderer can call ipcRenderer.off(channel, sameHandler) with the exact reference. ipcRenderer.removeListener requires reference equality."
  - "did-finish-load replay sends the cached latestLanState (default { kind: 'not_connected' }) immediately on every paint complete — even before the watcher emits — so renderer never has to wait for a fresh packet to render the LAN pill in 'not_connected' state."
  - "before-quit handler is idempotent via a `if (!supervisor && !lanWatcherHandle) return;` early-out so the synthetic e.preventDefault() + app.exit(0) sequence cannot loop."
  - "rendererTarget() returns process.env.ELECTRON_RENDERER_URL only when !app.isPackaged. Packaged builds always go to dist/renderer/index.html relative to dist/main/index.js."
  - "Linux basic_text branch logs a warning at bootstrap end (after IPC register) so the warning appears in the rolling log; the renderer-side toast plumbing is intentionally deferred to plan 09 (only after error mapping ships)."
patterns_established:
  - "Pattern: webContents.send guarded by mainWindow && !mainWindow.isDestroyed() — the three broadcast helpers (broadcastLan/Status/Log) are mounted onto the supervisor + watcher BEFORE the window's 'closed' fires. Surviving a closed window without crashing is required because the supervisor may still emit summon-stopped during shutdown."
  - "Pattern: lan port lookup as `latestLanState.kind === 'connected' ? latestLanState.port : null` — the supervisor.getLanPort callback is a single closure over the cache, no heavy callback wiring."
requirements_completed: [GUI-01, GUI-02, GUI-03, GUI-05]
metrics:
  duration_min: ~5
  tasks_completed: 3
  files_changed: 4
  loc_added: 336
  completed: "2026-05-08T18:42:00Z"
---

# Phase 4 Plan 05: Main Entry and IPC Summary

**One-liner:** Composes the Electron main process — `windowChrome.ts` factory (1180x760 BrowserWindow with platform-branched chrome), `ipc.ts` registering ipcMain.handle for all 10 request/response channels with Zod-validated boundaries, `preload/index.ts` exposing typed `window.sei` via contextBridge, and `main/index.ts` driving the lifecycle (single-instance lock → migration → window → watchLan → supervisor → IPC → graceful before-quit).

## Performance

- **Duration:** ~5 min
- **Started:** 2026-05-08T18:37:00Z
- **Completed:** 2026-05-08T18:42:00Z
- **Tasks:** 3 (all auto, no TDD)
- **Files created:** 4 (no modifications)

## Task Commits

| Commit  | Type | Description |
| ------- | ---- | ----------- |
| fc1ae26 | feat | Task 1 — `src/main/windowChrome.ts` (createMainWindow factory) + `src/preload/index.ts` (contextBridge RendererApi) |
| 31f6c66 | feat | Task 2 — `src/main/ipc.ts` (registerIpcHandlers wiring 10 R/R channels with Zod validation) |
| 34c9ef4 | feat | Task 3 — `src/main/index.ts` (lifecycle composer: single-instance lock, migration, window, watchLan, supervisor, IPC, graceful shutdown) |

## What Shipped

### Task 1 — `src/main/windowChrome.ts` + `src/preload/index.ts` (D-15, D-17, D-32)

**`windowChrome.ts`** — `createMainWindow(opts: { preloadPath, indexHtmlUrlOrPath })` returns a `BrowserWindow`:

- 1180×760 minimum (UI-SPEC AppWindow), `show: false` until `ready-to-show` fires.
- `backgroundColor: '#FDFEFF'` (light theme window token from D-29; renderer overrides on dark mode).
- `webPreferences`: `preload`, `contextIsolation: true`, `nodeIntegration: false`, `sandbox: false` (D-15 — sandbox kept off so the preload can import from `../shared/ipc`).
- Platform-branched chrome via spread:
  - macOS → `{ titleBarStyle: 'hiddenInset' }` (D-32: traffic lights top-left).
  - Windows → `{ frame: false, titleBarOverlay: { color: '#F6F5F2', symbolColor: '#1A1D24', height: 38 } }`.
  - Linux → `{ frame: false }`.
- Loads URL or file based on whether `indexHtmlUrlOrPath` starts with `http://`, `https://`, or `file://`.

**`preload/index.ts`** — `contextBridge.exposeInMainWorld('sei', api)` where `api: RendererApi` (typed against the single source of truth in `src/shared/ipc.ts`):

- 10 request/response methods → `ipcRenderer.invoke(IpcChannel.<channel>, ...args)`.
- 3 push-subscribe methods (`onStatus`, `onLog`, `onLan`) → close-over a handler, register via `ipcRenderer.on(channel, handler)`, return an `Unsubscribe` that calls `ipcRenderer.off(channel, handler)`. Reference equality is preserved so removal is exact.

### Task 2 — `src/main/ipc.ts` (T-04-21, T-04-22 mitigations)

`registerIpcHandlers(deps: { supervisor: BotSupervisor })` registers `ipcMain.handle` for all 10 channels. Each handler:

1. Runtime-validates inputs with Zod (`IdSchema`/`PlaintextSchema` for primitives, `CharacterSchema.parse(charArg)` for save, `UserConfigSchema.parse(cfgArg)` for config save).
2. Calls into the wave-2 module (`configStore`, `characterStore`, `apiKeyStore`, or `botSupervisor`).
3. Translates exceptions to thrown errors (which surface to the renderer's `.catch(...)` via Electron's IPC plumbing).

**Defense-in-depth on delete (T-04-22):**
```ts
if (id === 'sui') throw new Error('Cannot delete the default character.');
if (deps.supervisor.getActiveId() === id) {
  throw new Error('Cannot delete the currently summoned character. Stop first.');
}
```

The 10 R/R channels: `bot.summon`, `bot.stop`, `chars.list/get/save/delete`, `config.get/save/saveApiKey/hasApiKey`. Push channels (`bot.status`, `bot.logBatch`, `lan.state`) are intentionally NOT registered here — main/index.ts emits them directly via `webContents.send`.

### Task 3 — `src/main/index.ts` (D-15, D-21, T-04-23, T-04-25 mitigations)

**Lifecycle order on app.whenReady (Pitfall 5 — every Electron API behind whenReady):**

1. `runFirstLaunchMigration()` — idempotent legacy persona → `characters/sui.json` (D-10, plan 03).
2. `createMainWindow({ preloadPath, indexHtmlUrlOrPath })` — see preload + renderer path resolution below.
3. `mainWindow.webContents.on('did-finish-load', ...)` — replays cached `latestLanState` so a freshly-loaded renderer never lags behind a multicast packet that fired before paint.
4. `watchLan({ onUpdate: broadcastLan, staleMs: 3000 })` — D-21 single instance for whole session. `broadcastLan` updates the cache and `webContents.send('lan:state', ...)`.
5. `createBotSupervisor({ getLanPort, sendStatus, sendLog })` — `getLanPort` reads `latestLanState.kind === 'connected' ? latestLanState.port : null`.
6. `registerIpcHandlers({ supervisor })` — wires the renderer-facing surface.
7. Linux fallback warning — `if (process.platform === 'linux' && backendKind() === 'basic_text') logger.warn(...)`. Console-only for v1; renderer toast lands in plan 09.

**Single-instance lock (T-04-23):**
```ts
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }
else {
  app.on('second-instance', () => { mainWindow?.restore(); mainWindow?.focus(); });
  app.whenReady().then(() => bootstrap().catch(err => app.exit(1)));
}
```

**Graceful shutdown (T-04-25):**
```ts
app.on('before-quit', async (e) => {
  if (!supervisor && !lanWatcherHandle) return;       // already shut down — idempotent
  e.preventDefault();
  try { if (supervisor) await supervisor.shutdown(); } catch { ... }
  try { if (lanWatcherHandle) lanWatcherHandle.stop(); } catch {}
  supervisor = null;
  lanWatcherHandle = null;
  app.exit(0);
});
```

`window-all-closed` quits on non-darwin per Electron convention. `activate` (macOS dock click) re-runs bootstrap if the window is gone.

## Path Resolution (electron-vite output layout)

This MUST be revalidated by plan 11 on packaged builds, since the paths are relative-to-`__dirname` and depend on electron-vite's `dist/` layout:

| Path | Resolution |
| --- | --- |
| `preloadPath()` | `path.join(__dirname, '../preload/index.js')` — main bundle is `dist/main/index.js`, preload bundle is `dist/preload/index.js` |
| `rendererTarget()` (dev) | `process.env.ELECTRON_RENDERER_URL` (e.g. `http://localhost:5173`) — set by `electron-vite dev` |
| `rendererTarget()` (prod) | `path.join(__dirname, '../renderer/index.html')` — relative to `dist/main/index.js`, points to `dist/renderer/index.html` |
| `botEntryPath()` (in plan 04 supervisor) | dev: `path.join(__dirname, '../bot/index.js')`; prod: `path.join(process.resourcesPath, 'app.asar.unpacked', 'src/bot/index.js')` (Pitfall 1 — asar-internal paths crash utilityProcess.fork) |

`electron.vite.config.ts` (already in place from plan 01) declares the input entries as `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/index.html`, so the dist layout matches the assumed `__dirname` arithmetic.

## Notes for Plan 06 Executor

- The renderer can call `window.sei.<method>(...)` immediately on App mount; preload bindings are ready before the renderer code runs (contextBridge fires synchronously during preload execution before the renderer's first script runs).
- `window.sei.onStatus` / `onLog` / `onLan` each return an `Unsubscribe` — call it from the React effect cleanup. Reference equality is preserved between the captured handler and `ipcRenderer.off`, so cleanup is correct.
- The first `lan:state` event the renderer sees is the `latestLanState` cached at boot (`{ kind: 'not_connected' }` until a packet arrives). The renderer can render the LAN pill in initial state without waiting.
- Until plan 06 ships `src/renderer/index.html`, `npm run dev` will boot a window that shows a Vite error overlay (no index.html). This is expected. The main process is otherwise fully functional — the IPC surface is ready for renderer code to call.
- TypeScript types for `window.sei`: import `RendererApi` from `@shared/ipc` (the alias is set up in plan 01's `tsconfig.web.json` and `electron.vite.config.ts`). Add a `declare global { interface Window { sei: RendererApi } }` ambient declaration in plan 06's renderer entry.

## Notes for Plan 09 Executor

The Linux `basic_text` warning is currently **console-only** at boot. The renderer-side toast (KEYCHAIN_FALLBACK_PLAINTEXT) is plan 09's territory. Two options for plumbing:

1. (Preferred) Add a `getKeychainBackend(): Promise<string>` to RendererApi + ipcMain.handle wrapping `backendKind()`. The renderer's onboarding completion handler (or App boot) checks the backend and surfaces the toast inline. No supervisor changes.
2. Extend `BotStatus` to include `error: 'KEYCHAIN_FALLBACK_PLAINTEXT'` and have main emit it as a one-shot status at boot time. More plumbing, but consistent with the existing error-class taxonomy.

Plan 09 picks one — the supervisor doesn't currently emit anything keychain-related.

## Notes for Plan 11 Executor

- Single-instance lock test: launch the app twice. Second launch should silently focus the first window. Verify with `ps -e | grep -c sei` returning `1`.
- Graceful shutdown test: `kill -TERM <pid>` should let `before-quit` run (await supervisor.shutdown() finishes within 10s STOP_TIMEOUT). Verify with no orphaned `sei-bot-*` utility processes after `app.exit(0)`.
- Path arithmetic test on packaged build: `process.resourcesPath/app.asar.unpacked/src/bot/index.js` exists; `dist/preload/index.js` exists relative to `dist/main/index.js` AFTER electron-builder packages the `dist/` tree.

## Deviations from Plan

None. Plan 05 executed exactly as written. All three tasks committed atomically with the right `feat` types per the conventional-commit table. Verify gates passed first-attempt for all three tasks.

### Authentication Gates

None. (No external services touched.)

### Out-of-Scope Items

None. The plan is purely composition of wave-2 modules — no new dependencies introduced, no behavioral changes to the wave-2 surface.

## Threat Flags

None new this plan. Per the plan's `<threat_model>`, all 6 STRIDE threats (T-04-21 through T-04-26) have explicit mitigations baked into the implementation:

| Threat ID | Mitigation in this plan |
| --- | --- |
| T-04-21 (renderer character payload) | `CharacterSchema.parse(charArg)` in src/main/ipc.ts |
| T-04-22 (delete active/default char) | `id === 'sui'` refusal + `supervisor.getActiveId() === id` refusal in src/main/ipc.ts |
| T-04-23 (second instance hijack) | `app.requestSingleInstanceLock()` + second-instance focus handler in src/main/index.ts |
| T-04-24 (nodeIntegration disclosure) | `windowChrome.ts` hardcodes `contextIsolation: true, nodeIntegration: false` |
| T-04-25 (bootstrap exception) | `bootstrap().catch(err => app.exit(1))` in src/main/index.ts |
| T-04-26 (Linux basic_text) | console.warn at boot in src/main/index.ts; renderer toast deferred to plan 09 (accept-with-warn disposition) |

No NEW security-relevant surface introduced beyond the threat model.

## Acceptance Criteria — Plan-level

- [x] `src/main/windowChrome.ts` exports `createMainWindow` with platform-branched chrome + 1180x760 + contextIsolation:true / nodeIntegration:false.
- [x] `src/preload/index.ts` calls `contextBridge.exposeInMainWorld('sei', ...)` exactly once with all 13 RendererApi method bindings; three on* methods return `ipcRenderer.off(...)`-wrapped Unsubscribes.
- [x] `src/main/ipc.ts` registers all 10 R/R channels with Zod validation at every boundary; defense-in-depth on delete.
- [x] `src/main/index.ts` runs single-instance lock → migration → window → watchLan → supervisor → IPC → graceful before-quit; LAN replay on did-finish-load; Linux basic_text warn.
- [x] `npx tsc --noEmit -p tsconfig.node.json` reports 0 errors across all main+preload files.
- [x] Only one `new BrowserWindow` construction site (in src/main/windowChrome.ts).

## Self-Check: PASSED

Verified files exist:
- FOUND: src/main/windowChrome.ts
- FOUND: src/main/ipc.ts
- FOUND: src/main/index.ts
- FOUND: src/preload/index.ts

Verified commits exist in git log:
- FOUND: fc1ae26 (Task 1 — windowChrome + preload bridge)
- FOUND: 31f6c66 (Task 2 — IPC handler registrations)
- FOUND: 34c9ef4 (Task 3 — main entrypoint composer)

Verified plan-level checks:
- `grep -rn "new BrowserWindow" src/` returns exactly one site (src/main/windowChrome.ts:27) — no rogue construction.
- `./node_modules/.bin/tsc --noEmit -p tsconfig.node.json` exits 0 with 0 lines of output across the entire main+preload+shared tree.

---
*Phase: 04-electron-gui-packaging*
*Completed: 2026-05-08*
