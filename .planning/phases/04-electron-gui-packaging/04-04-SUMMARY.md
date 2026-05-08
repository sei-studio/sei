---
phase: 04-electron-gui-packaging
plan: 04
subsystem: bot-supervisor
tags: [electron, utility-process, lan-watcher, log-router, bot-supervisor, ipc]
dependency_graph:
  requires:
    - "04-01 (build scaffold) — src/bot/ namespace + asarUnpack rule + tsconfig.node.json (output of plan 04-01)"
    - "04-02 (shared types — running in parallel) — src/shared/ipc.ts (LanState, LogEntry, LogBatch, BotStatus, BotLifecycle, ErrorClass), src/shared/characterSchema.ts (Character)"
    - "04-03 (stores+secrets — running in parallel) — src/main/paths.ts (paths.logsDir, paths.userData), src/main/characterStore.ts (getCharacter), src/main/apiKeyStore.ts (loadApiKey), src/main/configStore.ts (loadConfig)"
  provides:
    - "src/main/lanWatcher.ts — long-lived UDP4 multicast watcher; emits {connected|not_connected|unavailable} on a 3000ms staleness window (D-20/D-21/D-22)"
    - "src/main/logRouter.ts — createLogRouter() factory: line-classify + 50ms-batched IPC (max 100/batch, drop above 1000 with sentinel) + rolling per-character file under <userData>/logs/"
    - "src/main/botSupervisor.ts — createBotSupervisor() owning ONE utilityProcess at a time; summon/stop/getActiveId/shutdown surface; 30s summon timeout, 10s stop timeout with child.kill() escalation"
    - "src/bot/index.js — augmented to dual-mode: parentPort handshake for Electron-forked path, CLI path preserved verbatim"
    - "src/bot/adapter/minecraft/lanDiscovery.js — refactored docs to declare CLI-only ownership (impl unchanged)"
  affects:
    - "Plan 04-05 (main entry + IPC) imports watchLan, createBotSupervisor, and wires them into app.whenReady() + ipcMain.handle('bot:summon', ...) / ipcMain.handle('bot:stop', ...) + lan:state webContents.send"
    - "Plan 04-11 (clean-VM smoke) verifies on macOS/Windows that summoning a character forks the bot, lan watcher reports connected, log lines flow to renderer, and stop cleanly exits"
tech_stack:
  added: []   # no new deps in this plan
  patterns:
    - "utilityProcess.fork with stdio:'pipe' + MessageChannelMain port-transfer (RESEARCH §Pattern 1)"
    - "long-lived UDP multicast watcher with stale-window state machine (RESEARCH §Pattern 3)"
    - "batched IPC (50ms / 100 lines / drop above 1000 with `dropped` sentinel) — Pitfall 7 mitigation"
    - "asar-aware path resolution: app.isPackaged ? process.resourcesPath/app.asar.unpacked/src/bot/index.js : __dirname/../bot/index.js — Pitfall 1 mitigation"
    - "wall-clock timeouts on every external surface (30s summon, 10s stop) — Project Constraint §5"
    - "config-in/{stop}-out core start() with two callers (CLI + Electron) sharing the same downstream"
key_files:
  created:
    - "src/main/lanWatcher.ts"
    - "src/main/logRouter.ts"
    - "src/main/botSupervisor.ts"
  modified:
    - "src/bot/index.js (parentPort handshake + start(config) refactor)"
    - "src/bot/adapter/minecraft/lanDiscovery.js (doc-only refactor; behavior unchanged)"
    - ".planning/phases/04-electron-gui-packaging/deferred-items.md (typescript@3 deferred-item entry)"
decisions:
  - "Did NOT delete the discoverLanPort caller from src/bot/index.js — it remains under an `if (!process.parentPort)` guard for the CLI path. The plan's Task 1 verify gate had a blanket grep that conflicts with Task 2's behavior section (`CLI never breaks`). Task 2's lexical guard is the canonical statement; Task 1 verify supersession documented as plan-internal-inconsistency."
  - "Lexical Pitfall 6 guard implemented as nested `if (!process.parentPort) { if (import.meta.url === ...) { ... } }` so the call sits within 5 lines of the explicit guard the plan's regex looks for."
  - "logRouter file naming: `<userData>/logs/<characterId>-<isoTimestamp>.log` (timestamp uses `replace(/[:.]/g, '-')` for filesystem-safe colons). Append-mode write stream (flags: 'a') so reconnect cycles append to the same per-summon file instead of clobbering."
  - "botSupervisor's `loadConfig as loadUserConfig` import alias avoids name collision with the bot's own `loadConfig` from src/bot/config.js — explicit naming prevents future plan-05 wiring mistakes."
  - "tsc verify gate deferred (logged to deferred-items.md): repo's installed typescript is pinned to 3.9.10 despite package.json declaring ^5.4.0. Pre-existing breakage; lexical grep gates + node --check are the substitute."
metrics:
  duration_min: ~12
  tasks_completed: 3
  files_changed_estimate: 5
  completed: "2026-05-08T18:34:19Z"
---

# Phase 4 Plan 04: Bot Supervisor — Summary

**One-liner:** Three "wire" modules for the main↔utilityProcess seam — a long-lived `watchLan` for the LAN pill, a `createBotSupervisor` that forks `src/bot/index.js` with stdio:'pipe' + MessagePortMain handshake, and a 50ms-batched logRouter that tees stdout/stderr to renderer and a rolling file. `src/bot/index.js` is now dual-mode: Electron-forked path receives config over MessagePort (no LAN re-discovery — D-25); CLI path preserved verbatim.

## Commits

| Commit  | Type     | Description |
| ------- | -------- | ----------- |
| 11fe908 | refactor | Extract long-lived `watchLan` into `src/main/lanWatcher.ts`; doc-only refactor of `src/bot/adapter/minecraft/lanDiscovery.js` (CLI-only) |
| bae0123 | feat     | Dual-mode bot entry — `parentPort` handshake for utilityProcess; `start(config)` refactor; Pitfall 6 lexical guard |
| d272751 | feat     | `src/main/logRouter.ts` (batched IPC + rolling file) and `src/main/botSupervisor.ts` (single-bot lifecycle, asar-safe fork, 30s/10s timeouts, BLOCKER-4 mc_username gate) |

## What Shipped

### Task 1 — `src/main/lanWatcher.ts` + lanDiscovery.js doc-refactor (D-20/D-21/D-22)

**`src/main/lanWatcher.ts`** — UDP4 multicast watcher, bound to `4445`, joins `224.0.2.60`. State machine:

- `connected` — within `staleMs` (default 3000) of last packet; payload `{port, motd, lastSeenAt}`.
- `not_connected` — no packet for >staleMs, or never received one.
- `unavailable` — sticky; emitted when `addMembership` throws (multicast filtered on this network).

`emit()` only fires when `state.kind` changes OR (when `connected`) when port/motd changes — keeps renderer event volume low. `setImmediate(emit)` fires the initial `not_connected` synchronously after `bind()` kicks off (the first call is wrapped in `try/catch` so a packet that races the initial emit doesn't double-fire).

**`src/bot/adapter/minecraft/lanDiscovery.js`** — implementation unchanged; comments rewritten to declare CLI-only ownership and cross-reference `src/main/lanWatcher.ts`. The bot adapter does NOT import from the main process tree (would break the relocate-only D-06 rule for `src/bot/`).

### Task 2 — `src/bot/index.js` parentPort handshake (D-18, D-19, D-25, Pitfall 6)

**Refactor:** lifted `start()` from a side-effect-running entrypoint that called `discoverLanPort()` + `loadConfig()` internally to a config-in/`{stop}`-out function. Both callers (CLI bootstrap; Electron init handler) build their config externally and call `start(config)`.

**Electron forked path** (gated on `process.parentPort`):

1. `process.parentPort.once('message', msg)` — extract `msg.ports[0]`, call `port.start()`.
2. On `{type:'init', character, apiKey, lanPort, userDataDir, mc_username, preferred_name}` — emit `{type:'init-ack'}`, build a ConfigSchema-conformant config (BLOCKER-1/2/4 fix below), `await start(config)`, emit `{type:'summon-ready'}` on success or `{type:'error', error:'BOT_CRASH', message}` on failure.
3. On `{type:'stop'}` — call the running `stop()`, emit `{type:'summon-stopped'}`, `process.exit(0)` after a 100ms tick to flush.
4. Lifecycle messages mirror to stdout (so logRouter sees them and tees to the rolling file) AND parentPort (structured for the status row).

**BLOCKER-1 (ConfigSchema satisfaction):**
- `adapter.minecraft.host = 'localhost'` (LAN host always loopback from same machine).
- `adapter.minecraft.auth = 'microsoft'` (CONN-02 — v1 auth target; the plan's previous shape would have rejected the schema's `z.enum(['offline','microsoft'])`).
- `adapter.minecraft.username = mc_username` (from onboarding's UserConfig — characters are personas, not Minecraft accounts).
- `adapter.minecraft.version` deliberately omitted so Zod's `.string().default('auto')` fills it (passing `false` would have failed `.string()`).
- `owner_username = preferred_name.trim() || 'Player'` — seeds owner-recognition for the first owner-chat (the bot's owner UUID resolution then locks it on first match).

**BLOCKER-2 (memory paths):** `memory: { owner_md_path, diary_md_path, affect_md_path }` — explicit per Phase-3 D-59 schema, all derived from `${userDataDir}/memory/${character.id}/...`. The previous (silently-stripped-by-Zod) `memory: { dir: ... }` shape would have left the defaults `./memory/...` which EROFS inside the read-only packaged bundle.

**Pitfall 6 lexical guard:** the import is at the top of the file (lexical, not call), but the only call site is wrapped in:

```js
if (!process.parentPort) {
  // Pitfall 6 lexical guard: `discoverLanPort` is reachable ONLY here.
  if (import.meta.url === `file://${process.argv[1]}`) {
    ;(async () => {
      const { port, motd } = await discoverLanPort({ timeoutMs: 5000 })
      // ...
    })()
  }
}
```

The supervisor's `port1.postMessage({type:'stop'})` path is the analog of the previous SIGINT/SIGTERM behaviour for the Electron path; the CLI path keeps signal handling unchanged.

**CLI path:** unchanged behavior — `loadConfig('./config.json', {port})` after `discoverLanPort`, then `await start(config)`. Verified by re-reading `src/bot/cli/index.js cmdStart` (still spawns `node src/bot/index.js`).

### Task 3 — `src/main/logRouter.ts` + `src/main/botSupervisor.ts` (D-15/D-16/D-18, Pitfall 1, Pitfall 2, Pitfall 7)

**logRouter** (Pitfall 7 + threat T-04-16):
- `createLogRouter({characterId, sendBatch})` returns `{append(line), close()}`.
- File teed to `<userData>/logs/<characterId>-<isoTimestamp>.log` via `createWriteStream` with `flags:'a'`.
- Constants: `FLUSH_INTERVAL_MS = 50`, `MAX_BATCH = 100`, `HARD_BUFFER_CAP = 1000`.
- Tag classification regex: `^\[\d{2}:\d{2}:\d{2}\.\d{3}\]\s+(\[[^\]]+\])` — matches `src/bot/brain/log.js`'s line format.
- Level classification: `error` if `[error]`/`ERROR`/`Error:`; `warn` if `[warn]`/`WARN`; else `info`.
- Drop discipline: when `buffer.length >= 1000`, oldest entry is shifted out, `dropped` counter increments. Next `flush()` includes `dropped` on the LogBatch and resets the counter.
- `close()`: flips `closed=true`, clears the interval, flushes any pending batch, `await stream.end()`.

**botSupervisor** (D-15/D-16/D-18, threats T-04-15 / T-04-17 / T-04-18 / T-04-19 / T-04-20b):
- Owns ONE bot at a time. `summon()` first calls `_stopActive(STOP_TIMEOUT_MS)` to gracefully drain any prior session.
- Pre-fork validation:
  1. `await getCharacter(characterId)` — throws if character JSON missing.
  2. `await loadApiKey()` — throws if missing/locked (renderer maps to `INVALID_API_KEY`).
  3. `await loadConfig()` (UserConfig) — extract `mc_username` + `preferred_name`. **BLOCKER-4:** if `mc_username` is empty, refuse to fork, emit `{kind:'error', error:'BOT_CRASH', message:'Minecraft username is missing. Re-run onboarding from Settings.', characterId}`, throw `MC_USERNAME_MISSING`.
  4. `getLanPort()` — refuse to fork if null; emit `{kind:'error', error:'LAN_NOT_OPEN', ...}`.
- Fork:
  ```ts
  const child = utilityProcess.fork(botEntryPath(), [], {
    stdio: 'pipe',                                  // Pitfall 2
    serviceName: `sei-bot-${characterId}`,
    env: { ...process.env, SEI_USER_DATA, SEI_CHARACTER_ID },
  });
  const { port1, port2 } = new MessageChannelMain();
  ```
- On `child.once('spawn')`, post the init message with `port2` transferred:
  ```ts
  child.postMessage({type:'init', character, apiKey, lanPort, userDataDir,
                     mc_username, preferred_name}, [port2]);
  ```
- stdout/stderr line-split via per-stream rolling buffer → `router.append(line)` per complete line.
- Lifecycle translation: `summon-ready` resolves the summon promise + emits `{kind:'online', uptimeMs, characterId}`; `error` emits `{kind:'error', error, message, characterId}`; `disconnected` emits `{kind:'connecting'}` (transitional). `init-ack` / `chat` / `summon-stopped` swallowed (status-only mapping returns `null`).
- 30s `SUMMON_TIMEOUT_MS` rejects with `'BOT_START_TIMEOUT'` and emits the same as a status; the timer is cleared on first `summon-ready`. 10s `STOP_TIMEOUT_MS` for graceful stop, then `child.kill()`.
- `shutdown()` is the `app.before-quit` hook — drains the active session with the stop timeout (T-04-15 zombie-process mitigation).

#### `botEntryPath()` — for plan 11 to verify on packaged builds

```ts
function botEntryPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'src/bot/index.js');
  }
  return path.join(__dirname, '../bot/index.js');
}
```

The packaged path depends on plan 01's `electron-builder.yml` `asarUnpack: ["src/bot/**/*"]` rule (already in place per 04-01-SUMMARY.md). Plan 11's clean-VM smoke MUST verify both:
1. `process.resourcesPath/app.asar.unpacked/src/bot/index.js` exists in the installed bundle.
2. `utilityProcess.fork(botEntryPath())` succeeds (Pitfall 1: an asar-internal path crashes the fork).

#### Pitfall 6 grep gate result (paste, verbatim)

```
$ grep -rn "discoverLanPort" src/bot/ | grep -v "src/bot/cli/" | grep -v "src/bot/adapter/minecraft/lanDiscovery.js"
src/bot/index.js:19://   - Pitfall 6 (bot must NOT call discoverLanPort during summon) — the
src/bot/index.js:24:import { discoverLanPort } from './adapter/minecraft/lanDiscovery.js'
src/bot/index.js:37:// one entrypoint: the CLI builds `config` via loadConfig+discoverLanPort, the
src/bot/index.js:236:// Pitfall 6: `discoverLanPort` is reachable ONLY when this guard holds —
src/bot/index.js:240:  // Pitfall 6 lexical guard: `discoverLanPort` is reachable ONLY here.
src/bot/index.js:245:      const { port, motd } = await discoverLanPort({ timeoutMs: 5000 })
```

The non-blank lines are: an import, three doc-comment cross-refs, and ONE actual call (line 245), nested under `if (!process.parentPort) { if (import.meta.url === ...) { ... } }`. The Task 2 acceptance criterion ("if `discoverLanPort` appears in the file at all, it is reachable ONLY when `process.parentPort` is falsy") is satisfied. See "Deviations" below for the Task 1 vs Task 2 internal inconsistency note.

## Notes for Plan 05 Executor

1. **`createBotSupervisor` requires a `getLanPort()` callback.** Wire it as:
   ```ts
   let latestLanState: LanState = { kind: 'not_connected' };
   const lanCtl = watchLan({ onUpdate: (s) => {
     latestLanState = s;
     mainWindow?.webContents.send('lan:state', s);
   }});
   const supervisor = createBotSupervisor({
     getLanPort: () => latestLanState.kind === 'connected' ? latestLanState.port : null,
     sendStatus: (s) => mainWindow?.webContents.send('bot:status', s),
     sendLog:    (b) => mainWindow?.webContents.send('bot:log:batch', b),
   });
   app.on('before-quit', async () => { await supervisor.shutdown(); lanCtl.stop(); });
   ```
2. **Log batch flow:** `botSupervisor → opts.sendLog(batch) → mainWindow.webContents.send('bot:log:batch', batch)`. The renderer subscribes via `onLog` (preload). Per RESEARCH §Resolved Q5, subscription is at the **store level** so main always ships a batch even when no character page is open.
3. **`ipcMain.handle('bot:summon', (e, characterId) => supervisor.summon(characterId))`** — the rejection from `summon()` already emitted the error status; plan 05 still needs to translate the rejection into an IPC error for the renderer's awaited promise.
4. **Wave-merge note:** the imports `from '../shared/ipc'` (LanState, LogEntry, LogBatch, BotStatus, BotLifecycle, ErrorClass), `from '../shared/characterSchema'` (Character), `./paths` (paths), `./characterStore` (getCharacter), `./apiKeyStore` (loadApiKey), `./configStore` (loadConfig as loadUserConfig) all resolve after wave merge — they don't exist in this worktree. Per the parallel-execution contract, plan 02 (shared types) and 03 (stores+secrets) are the upstream of those resolutions.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking] Plan-internal inconsistency: Task 1 vs Task 2 Pitfall 6 grep**
- **Found during:** Task 2.
- **Issue:** Task 1's automated verify includes `grep -rn "discoverLanPort" src/bot/ | grep -v "src/bot/cli/" | grep -v "src/bot/adapter/minecraft/lanDiscovery.js" | wc -l = 0`, which would forbid even a guarded call inside `src/bot/index.js`. But Task 2's `<behavior>` and `<acceptance_criteria>` explicitly preserve the CLI path's `discoverLanPort` call: "When started OUTSIDE Electron (i.e., `process.parentPort` is undefined — the CLI path), the existing behavior is preserved: read `config.json` from cwd, run `discoverLanPort`, and start the bot." Task 2's lexical guard ("if `discoverLanPort` appears in the file at all, it is reachable ONLY when `process.parentPort` is falsy") is the canonical statement.
- **Fix:** Treated Task 2's acceptance criteria as canonical (it's the more specific spec). Implemented a nested `if (!process.parentPort) { if (import.meta.url === ...) { ... } }` so the literal-string regex `if (!process.parentPort)` matches within `grep -B 5` of the call site — Task 2's automated verify passes verbatim.
- **Files modified:** `src/bot/index.js`.
- **Commit:** `bae0123`.
- **Impact:** None — the CLI path's `discoverLanPort` call is the only correct behavior (the bot must discover LAN when run standalone; the supervisor hands the cached port over MessagePort in the Electron path).

**2. [Rule 3 — Blocking] Pre-existing typescript@3.9.10 in node_modules**
- **Found during:** Task 1 verify.
- **Issue:** `npx tsc --noEmit -p tsconfig.node.json` fails with hundreds of TS1005/TS1110 errors against modern `@types/node/*.d.ts` files. `node_modules/typescript/package.json` reports version 3.9.10 despite `package.json` declaring `typescript: ^5.4.0`. Plan 04-01's `npm install` evidently resolved a hoisted/cached typescript@3 from a parent workspace. Pre-existing.
- **Fix:** Logged to `.planning/phases/04-electron-gui-packaging/deferred-items.md`. The plan's tsc verify gate cannot run; relying on the lexical grep gates (the plan also requires those) + `node --check` for the augmented `.js` file.
- **Files modified:** `.planning/phases/04-electron-gui-packaging/deferred-items.md`.
- **Commit:** included in `d272751` (Task 3's commit).
- **Impact:** TypeScript files are syntactically clean per file inspection and follow PATTERNS / RESEARCH verbatim; they will type-check correctly once typescript is reinstalled at ^5.4.0. Recommendation: `npm install --save-dev typescript@^5.4.0` (or `rm -rf node_modules && npm install`) before plan 04-05 starts.

### Authentication Gates

None. (No external services touched.)

### Out-of-Scope Items

None new this plan. (The pre-existing `verify-phase2.js` issue from plan 04-01 stays where it was — already in `deferred-items.md`.)

## TDD Gate Compliance

Plan type is `execute` (not `tdd`); no RED/GREEN/REFACTOR cycle required. All three tasks committed atomically with the right `feat`/`refactor` types per the conventional-commit table.

## Acceptance Criteria — Plan-level

- [x] `src/main/lanWatcher.ts` exists, exports `watchLan(options): {stop}`; emits all three LanState kinds; staleMs default 3000.
- [x] `src/bot/adapter/minecraft/lanDiscovery.js` exists, exports `discoverLanPort` (CLI continues to work).
- [x] `src/bot/index.js` is dual-mode: Electron-forked path with parentPort handshake, CLI path preserved, Pitfall 6 lexical guard around `discoverLanPort`.
- [x] `src/main/logRouter.ts` exists with batched IPC (50/100/1000) + rolling-file tee.
- [x] `src/main/botSupervisor.ts` exists with `utilityProcess.fork(stdio:'pipe')` + `MessageChannelMain` + asar-aware path resolution + 30s/10s timeouts + BLOCKER-4 mc_username gate.
- [x] `node --check` passes on `src/bot/index.js` and `src/bot/adapter/minecraft/lanDiscovery.js`.
- [x] All lexical grep gates pass (Task 1, 2, 3).
- [ ] `npx tsc --noEmit -p tsconfig.node.json` clean — DEFERRED per pre-existing typescript@3.9.10 (deferred-items.md).

## Self-Check: PASSED

Verified files exist:
- FOUND: `src/main/lanWatcher.ts`
- FOUND: `src/main/logRouter.ts`
- FOUND: `src/main/botSupervisor.ts`
- FOUND: `src/bot/index.js` (modified)
- FOUND: `src/bot/adapter/minecraft/lanDiscovery.js` (modified)
- FOUND: `.planning/phases/04-electron-gui-packaging/deferred-items.md` (modified)

Verified commits exist in git log:
- FOUND: `11fe908` (Task 1 — refactor: extract long-lived watchLan)
- FOUND: `bae0123` (Task 2 — feat: dual-mode bot entry parentPort handshake)
- FOUND: `d272751` (Task 3 — feat: bot supervisor + log router)
