---
phase: 04-electron-gui-packaging
plan: 04
type: execute
wave: 2
depends_on: [01, 02]
files_modified:
  - src/main/lanWatcher.ts
  - src/bot/adapter/minecraft/lanDiscovery.js
  - src/main/botSupervisor.ts
  - src/main/logRouter.ts
  - src/bot/index.js
autonomous: true
requirements: [GUI-02, GUI-03]
must_haves:
  truths:
    - "Main can call `watchLan({ onUpdate, staleMs })` and receive `connected` / `not_connected` / `unavailable` state transitions on the same UDP socket the CLI used to use"
    - "CLI's existing `discoverLanPort()` still works (one-shot wrapper preserved)"
    - "Main can `spawnBot(opts)` to fork the relocated `src/bot/index.js` as a utilityProcess, deliver decrypted config + api key over MessagePortMain, and tee stdout/stderr into a sink + rolling file"
    - "Bot exit / error / lifecycle events surface as `BotLifecycle` messages to the supervisor's `onLifecycle` callback"
    - "`spawnBot.stop({ timeoutMs })` resolves on graceful exit OR escalates to `child.kill()` after the timeout"
    - "`src/bot/index.js` accepts an init message over `process.parentPort` containing `{ character, apiKey, lanPort }` and bootstraps without re-discovering LAN"
  artifacts:
    - path: src/main/lanWatcher.ts
      provides: "watchLan({onUpdate, staleMs}): {stop} long-lived UDP multicast watcher with three state transitions"
      exports: ["watchLan"]
    - path: src/main/botSupervisor.ts
      provides: "createBotSupervisor() managing one utilityProcess at a time with summon/stop/onLifecycle/onLog"
      exports: ["createBotSupervisor", "BotSupervisor"]
    - path: src/main/logRouter.ts
      provides: "createLogRouter() — line-split + classify + batched-IPC + rolling-file tee"
      exports: ["createLogRouter", "LogRouter"]
    - path: src/bot/index.js
      provides: "utilityProcess entrypoint — receives {character, apiKey, lanPort} from parentPort and bootstraps bot"
  key_links:
    - from: src/main/botSupervisor.ts
      to: src/bot/index.js
      via: "utilityProcess.fork with asar-aware path resolution"
      pattern: "utilityProcess\\.fork"
    - from: src/main/botSupervisor.ts
      to: src/main/logRouter.ts
      via: "stdout/stderr lineSplit → router.append"
      pattern: "child\\.stdout\\?\\.on\\('data'"
    - from: src/main/lanWatcher.ts
      to: src/bot/adapter/minecraft/lanDiscovery.js
      via: "shared algorithm; lanDiscovery.js becomes a thin wrapper"
      pattern: "watchLan"
    - from: src/bot/index.js
      to: process.parentPort
      via: "MessagePort init message handler"
      pattern: "process\\.parentPort"
---

<changes_made>
**Revision pass (BLOCKERs 1, 2, 4):**
- **Task 2 (`bootstrapWithInit`) — BLOCKER 1 fix:** the v1 config object now satisfies `ConfigSchema` (see `src/config.js`). Required fields added: `adapter.minecraft.auth: 'microsoft'` (per CONN-02 — Microsoft is the v1 auth target), `adapter.minecraft.username` sourced from the init message's `mc_username`. The bogus `version: false` (boolean — failed Zod `.string().default('auto')`) is removed so the schema fills the `'auto'` default. `owner_username` is seeded from `cfg.preferred_name` so owner-recognition works on first run. `localhost` is replaced with the `lanPort.host` if provided in init, defaulting to `localhost`.
- **Task 2 — BLOCKER 2 fix:** the invalid `memory: { dir: ... }` (silently stripped by Zod, defaulting to cwd-relative paths that EROFS in the packaged bundle) is replaced with the explicit Phase-3 D-59 schema: `memory: { owner_md_path, diary_md_path, affect_md_path }`, all derived from the supervisor-supplied `userDataDir/memory/<id>/` (matches `paths.memoryDir(id)`). Plan 03's `saveCharacter` mkdir guarantees the parent directory exists.
- **Task 2 — BLOCKER 4 fix:** the init message contract is widened from `{ type, character, apiKey, lanPort, userDataDir }` to `{ type, character, apiKey, lanPort, userDataDir, mc_username, preferred_name }`. The bot uses these to populate `adapter.minecraft.username` and `owner_username`.
- **Task 3 (`_summon`) — BLOCKER 4 fix:** the supervisor now calls `await loadConfig()` (UserConfig from `configStore.ts`) before posting the init message, and includes `mc_username` and `preferred_name` in the postMessage payload. If `mc_username` is empty (user skipped onboarding before summon), the supervisor emits an `INVALID_API_KEY`-style status with a clear message and refuses to fork.
</changes_made>

<objective>
Build the three "wire" modules that connect main process to utilityProcess: a long-lived LAN watcher, a bot supervisor that forks the bot, and a log router that tees stdout into renderer-bound batches + rolling files. Also augment the relocated `src/bot/index.js` to receive init config over MessagePort instead of reading `./config.json` from disk.

Purpose: GUI-02 (Start/Stop button), GUI-03 (live log viewer), CONTEXT D-15 / D-18 / D-20–D-25 (three-process arch + LAN watcher). These are the most architectural files in the phase — they encode CLAUDE.md's hard rule that mineflayer runs ONLY in utilityProcess, and the Pitfall 1 (asar-internal-path) / Pitfall 2 (stdio:'inherit') / Pitfall 6 (multicast collision) / Pitfall 7 (IPC backpressure) mitigations.

Output: 3 new TS files + 1 augmented JS file. No BrowserWindow, no IPC handler registrations — those land in plan 05. This plan's modules export factories that plan 05 composes.
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
@.planning/phases/04-electron-gui-packaging/04-02-shared-types-PLAN.md
@src/shared/ipc.ts
@src/bot/adapter/minecraft/lanDiscovery.js
@src/bot/index.js
@src/bot/cli/index.js
@src/main/paths.ts

<interfaces>
<!-- Types/contracts available from prior plans -->

From src/shared/ipc.ts (plan 02):
```ts
export type LanState =
  | { kind: 'connected'; port: number; motd: string; lastSeenAt: number }
  | { kind: 'not_connected' }
  | { kind: 'unavailable' };

export interface LogEntry { timestamp: string; tag: string | null; message: string; level: 'info'|'warn'|'error'; }
export interface LogBatch { entries: LogEntry[]; dropped?: number; }
export type BotLifecycle =
  | { type: 'init-ack' }
  | { type: 'connected' }
  | { type: 'disconnected'; reason?: string }
  | { type: 'error'; error: ErrorClass; message: string }
  | { type: 'chat'; from: string; text: string }
  | { type: 'summon-ready' }
  | { type: 'summon-stopped' }
  | { type: 'exit'; code: number | null };
```

From src/main/paths.ts (plan 03):
```ts
export const paths = { logsDir: () => string, ... }
```

From src/bot/adapter/minecraft/lanDiscovery.js (existing — refactor target):
```js
const MC_LAN_GROUP = '224.0.2.60';
const MC_LAN_PORT = 4445;
export function discoverLanPort({ timeoutMs = 5000 } = {}) { /* one-shot Promise */ }
```

From RESEARCH §Pattern 3 (lines ~491–541) — full watchLan algorithm.
From RESEARCH §Pattern 1 (lines ~321–401) — utilityProcess.fork + MessageChannelMain.
From RESEARCH §Pitfall 7 (lines ~692–700) — batching: setInterval(50ms), max 100/batch, drop above 1000.
</interfaces>

<key_locked_decisions>
- D-15: Three-process Electron — mineflayer ONLY in utilityProcess. Renderer never imports mineflayer.
- D-16: One bot at a time. Switching characters stops current with `bot.quit()` (graceful) before starting next.
- D-18: utilityProcess.fork(`src/bot/index.js`, {stdio:'pipe'}); pass merged config (incl. decrypted API key) over MessagePortMain.
- D-19: Lifecycle event vocabulary: `connected`, `disconnected`, `error`, `chat`, `summon-ready`, `summon-stopped`.
- D-20: Refactor `lanDiscovery.js` into `watchLan({onUpdate, staleMs}): {stop}` with three-state pill.
- D-21: Watcher opens ONCE at app boot, lives for whole session, single shared UDP socket on `224.0.2.60:4445`.
- D-22: States — `connected` (≤3000ms since last packet), `not_connected` (>3000ms), `unavailable` (addMembership failed).
- D-25: Summon hands cached `{port}` to bot; utilityProcess does NOT re-discover LAN.
- Pitfall 1: utilityProcess.fork crashes on asar-internal paths. Use `app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked', 'src/bot/index.js') : path.join(__dirname, '../bot/index.js')`. `asarUnpack` for `src/bot/**/*` already in plan 01 stub.
- Pitfall 2: stdio MUST be `'pipe'` (default 'inherit' makes child.stdout null).
- Pitfall 6: Bot must NOT call `discoverLanPort` during summon. Verify via grep that the only remaining caller is the CLI.
- Pitfall 7: Coalesce log lines: 50ms flush, max 100/batch, drop above 1000 with sentinel `{ dropped: count }`.
- RESEARCH §Resolved Q5: Logs subscription happens at the **store level** in the renderer; main always ships a batch even if no character page is open. The supervisor doesn't gate on renderer presence.
- Existing `src/bot/index.js` start() function (Phase 1–3) accepts a config object — augmentation is to wrap it with a parentPort handshake.
</key_locked_decisions>
</context>

<tasks>

<task type="auto" tdd="false">
  <name>Task 1: Refactor LAN discovery — create src/main/lanWatcher.ts + collapse src/bot/adapter/minecraft/lanDiscovery.js to a thin wrapper</name>
  <read_first>
    - src/bot/adapter/minecraft/lanDiscovery.js (entire current file ~43 lines — the algorithm to extract)
    - src/bot/cli/index.js (search for `discoverLanPort` call — verify the CLI continues to work)
    - .planning/phases/04-electron-gui-packaging/04-RESEARCH.md §"Pattern 3" (lines ~491–552)
    - .planning/phases/04-electron-gui-packaging/04-PATTERNS.md §"src/main/lanWatcher.ts" (lines ~139–171)
    - .planning/phases/04-electron-gui-packaging/04-CONTEXT.md D-20, D-21, D-22, D-25
    - src/shared/ipc.ts (LanState type)
  </read_first>
  <behavior>
    - `watchLan({ onUpdate, staleMs })` opens a UDP4 socket bound to `4445`, joins multicast group `224.0.2.60`, parses `[MOTD]…[/MOTD][AD]port[/AD]` payloads. Emits initial state, plus any time the state transitions (or staleMs elapses without a packet).
    - Initial emit: `{kind:'not_connected'}` (because lastSeenAt is 0 at start).
    - On message: `{kind:'connected', port, motd, lastSeenAt: Date.now()}`.
    - After staleMs without packets: `{kind:'not_connected'}`.
    - On `addMembership` throw: `{kind:'unavailable'}` (sticky — doesn't recover).
    - Returns `{stop}`. Calling stop closes the socket and clears any timers.
    - The legacy `discoverLanPort({timeoutMs})` in `src/bot/adapter/minecraft/lanDiscovery.js` becomes a thin wrapper around `watchLan`. Same Promise contract: resolves on first `connected`, rejects on `unavailable` or after `timeoutMs`. CLI's existing call signature unchanged.
    - **No reuse from src/bot/ in main → main lanWatcher is its own implementation.** The bot-side wrapper is its own implementation. (Sharing a module between main and utilityProcess is technically possible but the algorithm is small; duplicating avoids cross-tier import paths and matches the relocate-only D-06 rule for `src/bot/`.)
    - Pitfall 6: After this task, grep verifies that `src/bot/` callers of `discoverLanPort` are limited to CLI.
  </behavior>
  <action>
**Step 1.** Create `src/main/lanWatcher.ts`:

```ts
/**
 * Long-lived multicast LAN watcher (Electron main process).
 *
 * Sources:
 *   - RESEARCH §Pattern 3 (lines 491–541) — verbatim algorithm
 *   - PATTERNS §src/main/lanWatcher.ts — refactor target
 *   - CONTEXT D-20, D-21, D-22 (three-state pill)
 *
 * Behavior:
 *   - Opens once at app boot; lives for the whole app session.
 *   - UDP socket bound to 4445 with reuseAddr:true; joins 224.0.2.60.
 *   - Emits `connected` after each fresh packet; `not_connected` after staleMs;
 *     `unavailable` (sticky) on addMembership failure.
 *
 * Renderer consumes via webContents.send('lan:state', ...) wired in plan 05.
 */
import dgram from 'node:dgram';
import type { LanState } from '../shared/ipc';

const MC_LAN_GROUP = '224.0.2.60';
const MC_LAN_PORT = 4445;

export interface WatchLanOptions {
  onUpdate: (state: LanState) => void;
  staleMs?: number;            // default 3000ms (D-22)
}

export function watchLan({ onUpdate, staleMs = 3000 }: WatchLanOptions): { stop: () => void } {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  let lastSeenAt = 0;
  let lastPort: number | null = null;
  let lastMotd = '';
  let unavailable = false;
  let staleTimer: NodeJS.Timeout | null = null;
  let lastEmitted: LanState | null = null;

  const compute = (): LanState => {
    if (unavailable) return { kind: 'unavailable' };
    const fresh = lastSeenAt > 0 && (Date.now() - lastSeenAt) <= staleMs;
    if (fresh && lastPort !== null) {
      return { kind: 'connected', port: lastPort, motd: lastMotd, lastSeenAt };
    }
    return { kind: 'not_connected' };
  };

  const emit = (): void => {
    const next = compute();
    // Only fire when state.kind changes OR connected payload changes
    const changed =
      !lastEmitted ||
      lastEmitted.kind !== next.kind ||
      (next.kind === 'connected' && lastEmitted.kind === 'connected' &&
        (next.port !== lastEmitted.port || next.motd !== lastEmitted.motd));
    if (changed) {
      lastEmitted = next;
      onUpdate(next);
    }
  };

  const scheduleStale = (): void => {
    if (staleTimer) clearTimeout(staleTimer);
    staleTimer = setTimeout(emit, staleMs + 100);
  };

  socket.on('error', () => {
    unavailable = true;
    emit();
  });

  socket.on('message', (msg: Buffer) => {
    const text = msg.toString('utf-8');
    const portMatch = text.match(/\[AD\](\d{1,5})\[\/AD\]/);
    if (!portMatch) return;
    const port = Number(portMatch[1]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return;
    lastPort = port;
    lastMotd = text.match(/\[MOTD\](.*?)\[\/MOTD\]/)?.[1] ?? '';
    lastSeenAt = Date.now();
    emit();
    scheduleStale();
  });

  socket.bind(MC_LAN_PORT, () => {
    try {
      socket.addMembership(MC_LAN_GROUP);
    } catch {
      unavailable = true;
      emit();
    }
  });

  // Fire initial state synchronously after bind kicks off
  setImmediate(emit);

  return {
    stop: () => {
      if (staleTimer) clearTimeout(staleTimer);
      try { socket.close(); } catch {}
    },
  };
}
```

**Step 2.** Refactor `src/bot/adapter/minecraft/lanDiscovery.js` to keep the existing one-shot Promise API for the CLI but reimplemented as a thin wrapper. Keep the file at the same path so existing imports continue to resolve.

Replace the entire file with:

```js
// src/bot/adapter/minecraft/lanDiscovery.js
//
// One-shot LAN discovery used by the CLI (src/bot/cli/index.js cmdStart).
// The Electron main process uses src/main/lanWatcher.ts (a long-lived watcher).
// This file uses an internal lightweight watch loop so we don't depend on
// the main process module from utilityProcess code.
//
// Source: refactored from prior phase per CONTEXT D-20.
import dgram from 'node:dgram'

const MC_LAN_GROUP = '224.0.2.60'
const MC_LAN_PORT = 4445

/**
 * One-shot: resolve on the first multicast packet within timeoutMs, or reject.
 * Used by the CLI only — Electron uses watchLan() in src/main/lanWatcher.ts.
 */
export function discoverLanPort({ timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    let settled = false
    const finish = (err, payload) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { socket.close() } catch {}
      if (err) reject(err)
      else resolve(payload)
    }
    const timer = setTimeout(
      () => finish(new Error(`No Minecraft LAN broadcast received within ${timeoutMs}ms`)),
      timeoutMs,
    )
    socket.on('error', (err) => finish(err))
    socket.on('message', (msg) => {
      const text = msg.toString('utf-8')
      const portStr = text.match(/\[AD\](\d{1,5})\[\/AD\]/)?.[1]
      if (!portStr) return
      const port = Number(portStr)
      if (!Number.isInteger(port) || port < 1 || port > 65535) return
      const motd = text.match(/\[MOTD\](.*?)\[\/MOTD\]/)?.[1] ?? ''
      finish(null, { port, motd })
    })
    socket.bind(MC_LAN_PORT, () => {
      try { socket.addMembership(MC_LAN_GROUP) }
      catch (err) { finish(err) }
    })
  })
}
```

This is essentially the original file (preserved as-is for the CLI path); the refactor target — the long-lived watcher — lives in `src/main/lanWatcher.ts`. CLI behavior is unchanged.

**Step 3.** Verify Pitfall 6 — the bot side does NOT re-discover LAN during summon-from-Electron. Run grep:
```
grep -rn "discoverLanPort" src/bot/ | grep -v "src/bot/cli/"
```
The result must list only `src/bot/adapter/minecraft/lanDiscovery.js` (the export site) — no callers inside `src/bot/index.js`, `src/bot/brain/**`, or `src/bot/adapter/minecraft/index.js`. If the existing `src/bot/index.js` calls `discoverLanPort` (it does, per RESEARCH analog), the next task removes that call.
  </action>
  <verify>
    <automated>test -f src/main/lanWatcher.ts && grep -q "export function watchLan" src/main/lanWatcher.ts && grep -q "MC_LAN_GROUP = '224.0.2.60'" src/main/lanWatcher.ts && grep -q "MC_LAN_PORT = 4445" src/main/lanWatcher.ts && grep -q "addMembership" src/main/lanWatcher.ts && grep -q "kind: 'unavailable'" src/main/lanWatcher.ts && grep -q "kind: 'connected'" src/main/lanWatcher.ts && grep -q "kind: 'not_connected'" src/main/lanWatcher.ts && grep -q "staleMs = 3000" src/main/lanWatcher.ts && test -f src/bot/adapter/minecraft/lanDiscovery.js && grep -q "export function discoverLanPort" src/bot/adapter/minecraft/lanDiscovery.js && (grep -rn "discoverLanPort" src/bot/ | grep -v "src/bot/cli/" | grep -v "src/bot/adapter/minecraft/lanDiscovery.js" | wc -l | grep -qE "^[[:space:]]*0$") && npx tsc --noEmit -p tsconfig.node.json 2>&1 | grep -E "lanWatcher\.ts.*error TS" | grep -c "" | grep -qE '^0$'</automated>
  </verify>
  <acceptance_criteria>
    - `src/main/lanWatcher.ts` exists and exports `watchLan(options): {stop}`
    - File contains constants `MC_LAN_GROUP = '224.0.2.60'` and `MC_LAN_PORT = 4445`
    - File contains all three LanState kinds: `'connected'`, `'not_connected'`, `'unavailable'`
    - Default `staleMs = 3000` is present
    - File handles `socket.on('error')` → sets `unavailable = true`
    - File parses both `[AD](\d+)[/AD]` and `[MOTD](.*?)[/MOTD]`
    - `src/bot/adapter/minecraft/lanDiscovery.js` exists and exports `discoverLanPort` (CLI continues to work)
    - **Pitfall 6 enforcement:** `grep -rn "discoverLanPort" src/bot/ | grep -v "src/bot/cli/" | grep -v "src/bot/adapter/minecraft/lanDiscovery.js"` returns ZERO matches (no `src/bot/index.js` or `src/bot/brain/**` or `src/bot/adapter/minecraft/index.js` callers)
    - `npx tsc --noEmit -p tsconfig.node.json` reports 0 errors for `lanWatcher.ts`
  </acceptance_criteria>
  <done>LAN watcher refactor complete. Main has `watchLan` for the long-lived pill; CLI keeps `discoverLanPort` for one-shot CLI start; bot side never calls discoverLanPort during summon (Pitfall 6 prevented).</done>
</task>

<task type="auto" tdd="false">
  <name>Task 2: Augment src/bot/index.js for parentPort handshake — accept {character, apiKey, lanPort} via MessagePort</name>
  <read_first>
    - src/bot/index.js (entire current file — the existing `start()` function and any cwd-based config loading)
    - src/bot/config.js (loadConfig + ConfigSchema — **CANONICAL** schema reference; the config object the bot constructs MUST satisfy `ConfigSchema.parse` — see BLOCKER 1/2 fix in changes_made)
    - .planning/phases/04-electron-gui-packaging/04-RESEARCH.md §"Pattern 1" — bot side (lines ~404–427)
    - .planning/phases/04-electron-gui-packaging/04-PATTERNS.md §"src/main/botSupervisor.ts" (lines ~282–315) — config flow direction
    - src/shared/ipc.ts (BotLifecycle, ErrorClass)
  </read_first>
  <behavior>
    - When the bot is started by `utilityProcess.fork` (from main), it receives a single message on `process.parentPort` of shape `{ ports: [port], data: {…ignored…} }` then expects an init message on `port` with `{type:'init', character, apiKey, lanPort, userDataDir, mc_username, preferred_name}` (BLOCKER-4 fix — `mc_username` and `preferred_name` are sourced from UserConfig in plan 04 task 3).
    - Init message bootstraps the existing bot startup with a config object built from `character` + `apiKey` + `lanPort` — equivalent to the prior `loadConfig('./config.json', {port})` shape but without re-discovering LAN (D-25).
    - Bot emits lifecycle messages back on the same port using the `BotLifecycle` vocabulary: `init-ack` (immediately on receiving init), then later `connected`, `summon-ready`, `disconnected`, `error`, `chat`, `summon-stopped`.
    - On a `{type:'stop'}` message from main, bot calls `gracefulShutdown()` (existing path: `bot.quit('Sei stopping')` then `process.exit(0)`).
    - When started OUTSIDE Electron (i.e., `process.parentPort` is undefined — the CLI path), the existing behavior is preserved: read `config.json` from cwd, run `discoverLanPort`, and start the bot. CLI never breaks.
    - Lifecycle events go to BOTH stdout (so logRouter sees them) AND parentPort (structured form for status row).
  </behavior>
  <action>
Augment `src/bot/index.js`. Read the existing file first; the current entrypoint (Phases 1–3) wraps a `start()` function that reads config from disk and starts the bot. Wrap that in a parentPort handshake while preserving the CLI behavior.

Add the parentPort handshake block at the TOP of the entrypoint (before the existing CLI-style startup). The structure:

```js
// src/bot/index.js — augmented for utilityProcess host (Phase 4)
//
// Two startup paths:
//   1. Forked by Electron main (process.parentPort exists)
//      → wait for init message over MessagePort, then start with provided config.
//   2. Run by CLI (`node src/bot/index.js`) — process.parentPort is undefined
//      → existing CLI path: load config.json from cwd, discoverLanPort, start.
//
// Sources:
//   - RESEARCH §Pattern 1 (bot side) — parentPort message flow
//   - CONTEXT D-18, D-25 (no re-discover LAN)
//   - D-19 (lifecycle event vocabulary)

// ... existing imports preserved (loadConfig, createBotInstance, startBrain, etc.) ...

let initPort = null;
let _running = null;       // { stop } returned by bringUp()

function emitLifecycle(payload) {
  // payload conforms to BotLifecycle (src/shared/ipc.ts)
  if (initPort) {
    try { initPort.postMessage(payload); } catch {}
  }
  // Also log to stdout for the rolling log file (logRouter parses these tags)
  console.log(`[lifecycle] ${JSON.stringify(payload)}`);
}

async function bootstrapWithInit(initData) {
  const {
    character,
    apiKey,
    lanPort,
    userDataDir,
    mc_username,         // BLOCKER-4: Minecraft username collected in onboarding
    preferred_name,      // BLOCKER-1: seeds owner_username for owner-recognition
  } = initData;

  // BLOCKER-1 fix: build a config shape that satisfies ConfigSchema.parse
  // (see src/config.js — adapter.minecraft requires {host, auth, username}
  // and `version` must be a string, not boolean). v1 hardcodes
  // `auth: 'microsoft'` per CONN-02. Username comes from onboarding's
  // UserConfig (NOT from character.id — characters are personas, not
  // Minecraft accounts). owner_username is seeded from preferred_name so
  // the bot recognises the owner from the first owner-chat.
  //
  // BLOCKER-2 fix: memory paths follow Phase-3 D-59 schema explicitly
  // (owner_md_path / diary_md_path / affect_md_path). The previous
  // `memory: { dir: ... }` shape was silently stripped by Zod, leaving
  // the defaults (./memory/...) which EROFS-ed inside the read-only
  // packaged Sei.app bundle. Plan 03's saveCharacter pre-creates the
  // parent dir so atomic-write helpers find it.
  const memDir = `${userDataDir}/memory/${character.id}`;
  const config = {
    chat_mode: 'chat',  // default for v1; renderer can flip in a later phase
    owner_username: typeof preferred_name === 'string' && preferred_name.trim()
      ? preferred_name.trim()
      : 'Player',                                     // fallback for safety; should never trigger
    persona: {
      name: character.name,
      backstory: character.persona_prompt,
      tone: 'curious',  // tone preset retained for back-compat with Phase 2 prompts
    },
    anthropic: { api_key: apiKey },
    adapter: {
      kind: 'minecraft',
      minecraft: {
        host: 'localhost',                            // LAN host always loopback from same machine
        port: lanPort,
        auth: 'microsoft',                            // v1: Microsoft auth only (CONN-02)
        username: mc_username,                        // from onboarding UserConfig
        // `version` deliberately omitted — Zod fills 'auto' default per
        // src/config.js MinecraftAdapterSchema. Passing `false` (a boolean)
        // would fail .string().default('auto').
      },
    },
    memory: {
      owner_md_path:  `${memDir}/OWNER.md`,
      diary_md_path:  `${memDir}/DIARY.md`,
      affect_md_path: `${memDir}/AFFECT.md`,
    },
    llm: {},  // existing defaults
  };

  emitLifecycle({ type: 'init-ack' });

  try {
    _running = await start(config);  // existing bot start function — same shape
    emitLifecycle({ type: 'summon-ready' });
  } catch (err) {
    emitLifecycle({ type: 'error', error: 'BOT_CRASH', message: String(err && err.message || err) });
  }
}

async function gracefulShutdown() {
  try {
    if (_running && typeof _running.stop === 'function') await _running.stop();
  } catch {}
  emitLifecycle({ type: 'summon-stopped' });
  // Give the lifecycle message a tick to flush before exiting
  setTimeout(() => process.exit(0), 100);
}

// ─── Electron forked path ─────────────────────────────────────────────────
if (process.parentPort) {
  process.parentPort.once('message', (msg) => {
    const ports = msg.ports || [];
    if (!ports.length) return;
    initPort = ports[0];
    initPort.start();
    initPort.on('message', (e) => {
      const data = e?.data ?? e;
      if (data?.type === 'init') {
        bootstrapWithInit(data);
      } else if (data?.type === 'stop') {
        gracefulShutdown();
      }
    });
  });
} else {
  // ─── CLI path (existing behavior) ─────────────────────────────────────
  // The existing `start()` invocation that the CLI relies on.
  // Preserve any prior IIFE / top-level await / module-level call here.
  // (Adapt the augmentation to the actual existing entry shape — read it first.)
  // Existing pattern from src/index.js:
  //   const { port } = await discoverLanPort({...});
  //   const config = loadConfig('./config.json', { port });
  //   await start(config);
  // Keep that unchanged below.
}
```

**Important:** Read the existing `src/bot/index.js` first to understand its current shape (`start()` signature, top-level invocation, error-handling). Then **insert** the parentPort handshake block at the top, and **gate** the existing CLI startup behind `if (!process.parentPort) { ... existing code ... }`. Do NOT remove or rewrite the existing CLI startup — just wrap it.

If the existing `start()` does not accept a config object directly (e.g., it always calls `loadConfig` internally), refactor lightly: extract config-loading to the call site so both paths share the same `start(config)` API. Lookout for and preserve any reconnect timers and signal handlers (SIGINT/SIGTERM) — they should still apply in the Electron path (the supervisor's `port1.postMessage({type:'stop'})` is the new analog, but SIGTERM on `child.kill()` must still gracefully shut down).

Verify Pitfall 6: after the augmentation, `discoverLanPort` is called from the bot ONLY in the CLI branch (the `else` branch above), never in the Electron branch.
  </action>
  <verify>
    <automated>test -f src/bot/index.js && grep -q "process.parentPort" src/bot/index.js && grep -q "type: 'init-ack'" src/bot/index.js && grep -q "type: 'summon-ready'" src/bot/index.js && grep -q "type: 'summon-stopped'" src/bot/index.js && grep -q "type: 'error'" src/bot/index.js && grep -q "if (process.parentPort)" src/bot/index.js && grep -q "auth: 'microsoft'" src/bot/index.js && grep -q "username: mc_username" src/bot/index.js && grep -q "owner_md_path" src/bot/index.js && grep -q "diary_md_path" src/bot/index.js && grep -q "affect_md_path" src/bot/index.js && ! grep -q "memory: { dir:" src/bot/index.js && ! grep -q "version: false" src/bot/index.js && (grep -B 5 "discoverLanPort" src/bot/index.js | grep -q "if (!process.parentPort)\|if (process.parentPort) {" || ! grep -q "discoverLanPort" src/bot/index.js) && node --check src/bot/index.js</automated>
  </verify>
  <acceptance_criteria>
    - `src/bot/index.js` contains `process.parentPort` references — gated init handshake
    - File emits at minimum these lifecycle types: `init-ack`, `summon-ready`, `summon-stopped`, `error` (verified by literal substrings)
    - File contains `if (process.parentPort)` branch (the Electron path)
    - **Pitfall 6 verification (lexical):** if `discoverLanPort` appears in the file at all, it is reachable ONLY when `process.parentPort` is falsy. Acceptable shapes: an `else` branch under `if (process.parentPort)`, or an `if (!process.parentPort)` guard. Verified by checking that within 5 lines preceding any `discoverLanPort` call there is a guard against `process.parentPort`.
    - **BLOCKER-1 fix (ConfigSchema satisfaction):** config object literally contains `auth: 'microsoft'`, `username: mc_username`, and does NOT contain `version: false` (verified by grep). `owner_username` is sourced from `preferred_name`.
    - **BLOCKER-2 fix (memory paths):** config.memory contains explicit `owner_md_path`, `diary_md_path`, `affect_md_path` literals (verified by grep). The invalid `memory: { dir: ... }` shape is absent (verified by negative grep).
    - **BLOCKER-4 fix (init contract):** init handler destructures `mc_username` and `preferred_name` alongside the existing fields.
    - `node --check src/bot/index.js` exits 0 (file is syntactically valid)
  </acceptance_criteria>
  <done>Bot entry now dual-mode. CLI still works; Electron forks the same file and feeds it a ConfigSchema-conformant config (auth + username + version-default + explicit memory paths) over MessagePort.</done>
</task>

<task type="auto" tdd="false">
  <name>Task 3: Create src/main/logRouter.ts + src/main/botSupervisor.ts</name>
  <read_first>
    - .planning/phases/04-electron-gui-packaging/04-RESEARCH.md §"Pattern 1" main side (lines ~321–401) — full utilityProcess.fork pattern
    - .planning/phases/04-electron-gui-packaging/04-RESEARCH.md §"Pitfall 1" (asar path), §"Pitfall 2" (stdio:'pipe'), §"Pitfall 7" (batching)
    - .planning/phases/04-electron-gui-packaging/04-PATTERNS.md §"src/main/botSupervisor.ts" (lines ~282–315)
    - .planning/phases/04-electron-gui-packaging/04-PATTERNS.md §"src/main/logRouter.ts" (lines ~334–363)
    - .planning/phases/04-electron-gui-packaging/04-PATTERNS.md §"Adapter / supervisor teardown discipline" (lines ~706–714)
    - src/shared/ipc.ts (LogEntry, LogBatch, BotLifecycle, ErrorClass)
    - src/main/paths.ts (logsDir)
    - src/main/configStore.ts (loadConfig — UserConfig with mc_username/preferred_name fields needed for BLOCKER-4 fix)
    - src/bot/brain/log.js (lines 21–50 — tag prefix vocabulary the router classifies)
  </read_first>
  <behavior>
    **logRouter.ts:**
    - Factory `createLogRouter({ characterId, sendBatch })` returns `{ append(line: string), close() }`.
    - `append(line)` parses the line, classifies tag/level, accumulates into in-memory buffer.
    - Every 50ms (or when buffer reaches 100), flushes via `sendBatch(batch)`. Drops oldest with sentinel when buffer >1000.
    - Simultaneously appends every line to a write stream at `<userData>/logs/<characterId>-<isoTimestamp>.log` (append mode).
    - `close()` flushes any remaining batch, ends write stream, clears interval.

    **botSupervisor.ts:**
    - Factory `createBotSupervisor({ getApiKey, getLanState, sendStatus, sendLog, onCharStarted })` returns `BotSupervisor` interface: `summon(characterId): Promise<void>`, `stop(): Promise<void>`, `getActiveId(): string | null`.
    - `summon(id)` semantics:
      1. If a bot is already running (D-16): `await stop()` first.
      2. Resolve bot entry path (Pitfall 1: `app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked', 'src/bot/index.js') : path.join(__dirname, '../bot/index.js')`).
      3. `utilityProcess.fork(botEntry, [], {stdio: 'pipe'})`.
      4. On `'spawn'`: open MessageChannelMain, transfer port2 to child via `child.postMessage({type:'init', character, apiKey, lanPort, userDataDir, mc_username, preferred_name}, [port2])`. Pass `getApiKey()` (calls `loadApiKey()` from plan 03), `getLanState()` (returns the cached LAN state's port), AND `await loadConfig()` (UserConfig — provides `mc_username` and `preferred_name` for the bot's `adapter.minecraft.username` and `owner_username` slots; **BLOCKER-4 fix**) at this moment. If `mc_username` is empty/missing, refuse to fork and emit a status with a clear message — onboarding should have prevented this state.
      5. Wire `child.stdout?.on('data', ...)` and `child.stderr?.on('data', ...)` through line-split into `logRouter.append(line)`.
      6. Wire `port1.on('message', ...)` to translate `BotLifecycle` → `BotStatus` and call `sendStatus(...)`.
      7. Returns when the child emits `summon-ready` or after 30s timeout (BOT_START_TIMEOUT — Project Constraint §5).
    - `stop()` semantics: posts `{type:'stop'}` to port1, awaits child `'exit'` with 10s timeout, escalates to `child.kill()` on timeout.
    - On unexpected exit / error: cleans up logRouter + ports, calls `sendStatus({kind:'error', ...})`.
  </behavior>
  <action>
**Step 1.** Create `src/main/logRouter.ts`:

```ts
/**
 * Bot log routing: stdout/stderr → batched IPC + rolling file.
 *
 * Sources:
 *   - PATTERNS §src/main/logRouter.ts
 *   - RESEARCH §Pitfall 7 (batching: 50ms / 100 lines / drop above 1000 with sentinel)
 *   - src/bot/brain/log.js — tag prefix vocabulary
 */
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { LogEntry, LogBatch } from '../shared/ipc';
import { paths } from './paths';

const FLUSH_INTERVAL_MS = 50;
const MAX_BATCH = 100;
const HARD_BUFFER_CAP = 1000;

const TAG_RE = /^\[\d{2}:\d{2}:\d{2}\.\d{3}\]\s+(\[[^\]]+\])/;

function classify(line: string): { tag: string | null; level: 'info' | 'warn' | 'error' } {
  const m = line.match(TAG_RE);
  const tag = m ? m[1] : null;
  let level: 'info' | 'warn' | 'error' = 'info';
  if (/\[error\]|^ERROR\b|^Error:/i.test(line)) level = 'error';
  else if (/\[warn\]|^WARN\b/i.test(line)) level = 'warn';
  return { tag, level };
}

export interface LogRouterOptions {
  characterId: string;
  sendBatch: (batch: LogBatch) => void;
}

export interface LogRouter {
  append(line: string): void;
  close(): Promise<void>;
}

export async function createLogRouter(opts: LogRouterOptions): Promise<LogRouter> {
  const { characterId, sendBatch } = opts;
  const tsForFile = new Date().toISOString().replace(/[:.]/g, '-');
  const logFile = path.join(paths.logsDir(), `${characterId}-${tsForFile}.log`);
  await mkdir(paths.logsDir(), { recursive: true });
  const stream: WriteStream = createWriteStream(logFile, { flags: 'a' });

  let buffer: LogEntry[] = [];
  let dropped = 0;
  let closed = false;

  const flush = (): void => {
    if (closed) return;
    if (buffer.length === 0 && dropped === 0) return;
    const entries = buffer;
    buffer = [];
    const batch: LogBatch = { entries };
    if (dropped > 0) { batch.dropped = dropped; dropped = 0; }
    try { sendBatch(batch); } catch {}
  };

  const interval = setInterval(flush, FLUSH_INTERVAL_MS);

  return {
    append(line: string) {
      if (closed) return;
      const cleaned = line.replace(/\r?$/, '');
      if (!cleaned) return;
      const { tag, level } = classify(cleaned);
      const entry: LogEntry = {
        timestamp: new Date().toISOString(),
        tag,
        message: cleaned,
        level,
      };
      // Tee to file (best-effort; backpressure ignored — fs has its own queue)
      try { stream.write(cleaned + '\n'); } catch {}

      if (buffer.length >= HARD_BUFFER_CAP) {
        // Drop oldest, increment counter
        buffer.shift();
        dropped += 1;
      }
      buffer.push(entry);
      if (buffer.length >= MAX_BATCH) flush();
    },
    async close() {
      closed = true;
      clearInterval(interval);
      flush();
      await new Promise<void>((resolve) => stream.end(resolve));
    },
  };
}
```

**Step 2.** Create `src/main/botSupervisor.ts`:

```ts
/**
 * Bot utilityProcess supervisor.
 *
 * Sources:
 *   - RESEARCH §Pattern 1 (full utilityProcess.fork + MessageChannelMain pattern)
 *   - PATTERNS §src/main/botSupervisor.ts
 *   - CONTEXT D-15, D-16, D-18, D-19, D-25
 *   - Pitfall 1 (asar path), Pitfall 2 (stdio:'pipe')
 *   - Project Constraint §5 (30s summon timeout, 10s stop timeout)
 *
 * Lifecycle: the supervisor owns ONE bot at a time. Switching characters
 * stops the current bot (10s budget) before starting the new one.
 */
import { utilityProcess, MessageChannelMain, app, type UtilityProcess } from 'electron';
import path from 'node:path';
import type { BotStatus, LanState, LogBatch, BotLifecycle, ErrorClass } from '../shared/ipc';
import type { Character } from '../shared/characterSchema';
import { getCharacter } from './characterStore';
import { loadApiKey } from './apiKeyStore';
import { loadConfig as loadUserConfig } from './configStore';   // BLOCKER-4: UserConfig (mc_username, preferred_name) for bot init
import { paths } from './paths';
import { createLogRouter, type LogRouter } from './logRouter';

const SUMMON_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 10_000;

const logger = {
  info: (m: string) => console.log(`[sei] ${m}`),
  warn: (m: string) => console.warn(`[sei] ${m}`),
  error: (m: string) => console.error(`[sei] ${m}`),
};

function botEntryPath(): string {
  // Pitfall 1: asar-internal path crashes utilityProcess.fork.
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'src/bot/index.js');
  }
  // In dev: __dirname is dist/main; bot lives at src/bot/index.js relative to repo root.
  // electron-vite's main bundle preserves this layout.
  return path.join(__dirname, '../bot/index.js');
}

export interface BotSupervisorOptions {
  getLanPort: () => number | null;             // returns cached lanPort or null
  sendStatus: (status: BotStatus) => void;     // forward to renderer via webContents.send
  sendLog: (batch: LogBatch) => void;          // forward to renderer (batched)
}

export interface BotSupervisor {
  summon(characterId: string): Promise<void>;
  stop(): Promise<void>;
  getActiveId(): string | null;
  shutdown(): Promise<void>;                   // for app.before-quit cleanup
}

interface ActiveSession {
  characterId: string;
  startedAtMs: number;
  child: UtilityProcess;
  port1: Electron.MessagePortMain;
  router: LogRouter;
  exited: Promise<void>;
  resolveExited: () => void;
}

export function createBotSupervisor(opts: BotSupervisorOptions): BotSupervisor {
  let active: ActiveSession | null = null;

  const lifecycleToStatus = (e: BotLifecycle, characterId: string, startedAtMs: number): BotStatus | null => {
    switch (e.type) {
      case 'connected':
      case 'summon-ready':
        return { kind: 'online', uptimeMs: Date.now() - startedAtMs, characterId };
      case 'disconnected':
        // map to a transitional state; stay 'online' visually with a hint, or use 'connecting'
        return { kind: 'connecting' };
      case 'error':
        return { kind: 'error', error: e.error, message: e.message, characterId };
      case 'exit':
        // exit handled separately — supervisor flips to 'idle' when no active session
        return null;
      case 'init-ack':
      case 'chat':
      case 'summon-stopped':
      default:
        return null;
    }
  };

  async function _stopActive(timeoutMs: number): Promise<void> {
    if (!active) return;
    const session = active;
    try { session.port1.postMessage({ type: 'stop' }); } catch {}

    const exited = await Promise.race<boolean>([
      session.exited.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), timeoutMs)),
    ]);
    if (!exited) {
      logger.warn(`bot stop timed out after ${timeoutMs}ms — escalating to kill`);
      try { session.child.kill(); } catch {}
      // Wait briefly for kill to settle (best-effort)
      await Promise.race<void>([session.exited, new Promise<void>((r) => setTimeout(r, 1000))]);
    }
    try { await session.router.close(); } catch {}
    try { session.port1.close(); } catch {}
    if (active === session) active = null;
    opts.sendStatus({ kind: 'idle' });
  }

  async function _summon(characterId: string): Promise<void> {
    // D-16: stop current bot first if any
    if (active) {
      await _stopActive(STOP_TIMEOUT_MS);
    }

    const character: Character | null = await getCharacter(characterId);
    if (!character) throw new Error(`Character not found: ${characterId}`);

    const apiKey = await loadApiKey();    // throws if missing/locked — caller maps to ErrorClass

    // BLOCKER-4 fix: load UserConfig so the bot's adapter.minecraft.username
    // (Microsoft account) and owner_username (preferred_name) are populated
    // from onboarding. ConfigSchema.parse in the bot will throw if username
    // is missing, so we refuse to fork early with a clear error.
    const userCfg = await loadUserConfig();
    const mc_username = (userCfg.mc_username ?? '').trim();
    const preferred_name = (userCfg.preferred_name ?? '').trim();
    if (!mc_username) {
      const status: BotStatus = {
        kind: 'error',
        error: 'BOT_CRASH',
        message: 'Minecraft username is missing. Re-run onboarding from Settings.',
        characterId,
      };
      opts.sendStatus(status);
      throw new Error('MC_USERNAME_MISSING');
    }

    const lanPort = opts.getLanPort();
    if (lanPort == null) {
      const status: BotStatus = { kind: 'error', error: 'LAN_NOT_OPEN', message: 'No LAN world detected. Open one to LAN in Minecraft.', characterId };
      opts.sendStatus(status);
      throw new Error('LAN_NOT_OPEN');
    }

    const startedAtMs = Date.now();
    opts.sendStatus({ kind: 'connecting' });

    const router = await createLogRouter({ characterId, sendBatch: opts.sendLog });
    const child = utilityProcess.fork(botEntryPath(), [], {
      stdio: 'pipe',                     // Pitfall 2 — required for stdout/stderr access
      serviceName: `sei-bot-${characterId}`,
      env: {
        ...process.env,
        SEI_USER_DATA: paths.userData(),
        SEI_CHARACTER_ID: characterId,
      },
    });
    const { port1, port2 } = new MessageChannelMain();

    let resolveExited!: () => void;
    const exitedP = new Promise<void>((resolve) => { resolveExited = resolve; });

    const session: ActiveSession = {
      characterId,
      startedAtMs,
      child,
      port1,
      router,
      exited: exitedP,
      resolveExited,
    };
    active = session;

    // stdout/stderr line-split → router
    const buffers = { stdout: '', stderr: '' };
    const sink = (chunk: Buffer, key: 'stdout' | 'stderr') => {
      const text = buffers[key] + chunk.toString('utf-8');
      const lines = text.split('\n');
      buffers[key] = lines.pop() ?? '';
      for (const line of lines) if (line) router.append(line);
    };
    child.stdout?.on('data', (c: Buffer) => sink(c, 'stdout'));
    child.stderr?.on('data', (c: Buffer) => sink(c, 'stderr'));

    // Lifecycle messages
    let summonResolved = false;
    let summonResolve: () => void = () => {};
    let summonReject: (err: Error) => void = () => {};
    const summonPromise = new Promise<void>((resolve, reject) => {
      summonResolve = resolve;
      summonReject = reject;
    });
    const summonTimer = setTimeout(() => {
      if (summonResolved) return;
      summonResolved = true;
      const err: ErrorClass = 'BOT_START_TIMEOUT';
      opts.sendStatus({ kind: 'error', error: err, message: 'Bot did not signal ready within 30s.', characterId });
      summonReject(new Error(err));
    }, SUMMON_TIMEOUT_MS);

    port1.on('message', (e: { data: BotLifecycle }) => {
      const data = e.data;
      if (data.type === 'summon-ready' && !summonResolved) {
        summonResolved = true;
        clearTimeout(summonTimer);
        summonResolve();
      }
      const status = lifecycleToStatus(data, characterId, startedAtMs);
      if (status) opts.sendStatus(status);
    });
    port1.start();

    child.once('spawn', () => {
      // BLOCKER-4 fix: ship mc_username + preferred_name from UserConfig so
      // the bot can satisfy ConfigSchema (adapter.minecraft.username) and
      // seed owner_username for owner-recognition without disk reads.
      child.postMessage({
        type: 'init',
        character,
        apiKey,
        lanPort,
        userDataDir: paths.userData(),
        mc_username,
        preferred_name,
      }, [port2]);
    });

    child.on('exit', (code) => {
      if (!summonResolved) {
        summonResolved = true;
        clearTimeout(summonTimer);
        summonReject(new Error(`Bot exited before summon-ready (code=${code ?? 'null'})`));
      }
      session.resolveExited();
    });
    child.on('error', (err) => {
      logger.error(`bot child error: ${err.message}`);
      if (!summonResolved) {
        summonResolved = true;
        clearTimeout(summonTimer);
        summonReject(err);
      }
    });

    // Wait for summon-ready or fail
    try { await summonPromise; }
    catch (err) {
      // Cleanup on failure
      try { await router.close(); } catch {}
      try { port1.close(); } catch {}
      try { child.kill(); } catch {}
      if (active === session) active = null;
      throw err;
    }
  }

  return {
    summon: _summon,
    stop: () => _stopActive(STOP_TIMEOUT_MS),
    getActiveId: () => active?.characterId ?? null,
    shutdown: async () => {
      if (active) await _stopActive(STOP_TIMEOUT_MS);
    },
  };
}

export type { BotSupervisor as BotSupervisorType };
```
  </action>
  <verify>
    <automated>test -f src/main/logRouter.ts && test -f src/main/botSupervisor.ts && grep -q "export async function createLogRouter" src/main/logRouter.ts && grep -q "FLUSH_INTERVAL_MS = 50" src/main/logRouter.ts && grep -q "MAX_BATCH = 100" src/main/logRouter.ts && grep -q "HARD_BUFFER_CAP = 1000" src/main/logRouter.ts && grep -q "createWriteStream" src/main/logRouter.ts && grep -q "export function createBotSupervisor" src/main/botSupervisor.ts && grep -q "utilityProcess.fork" src/main/botSupervisor.ts && grep -q "stdio: 'pipe'" src/main/botSupervisor.ts && grep -q "MessageChannelMain" src/main/botSupervisor.ts && grep -q "app.isPackaged" src/main/botSupervisor.ts && grep -q "process.resourcesPath" src/main/botSupervisor.ts && grep -q "app.asar.unpacked" src/main/botSupervisor.ts && grep -q "SUMMON_TIMEOUT_MS = 30" src/main/botSupervisor.ts && grep -q "STOP_TIMEOUT_MS = 10" src/main/botSupervisor.ts && grep -q "BOT_START_TIMEOUT" src/main/botSupervisor.ts && grep -q "child.kill()" src/main/botSupervisor.ts && grep -q "loadApiKey" src/main/botSupervisor.ts && grep -q "getCharacter(characterId)" src/main/botSupervisor.ts && grep -q "loadUserConfig\|loadConfig as loadUserConfig" src/main/botSupervisor.ts && grep -q "mc_username," src/main/botSupervisor.ts && grep -q "preferred_name," src/main/botSupervisor.ts && grep -q "MC_USERNAME_MISSING" src/main/botSupervisor.ts && npx tsc --noEmit -p tsconfig.node.json 2>&1 | grep -E "(logRouter|botSupervisor)\.ts.*error TS" | grep -v "TS2307.*../bot/" | grep -c "" | grep -qE '^0$'</automated>
  </verify>
  <acceptance_criteria>
    - `src/main/logRouter.ts` exports `createLogRouter` returning `{append, close}`
    - logRouter contains constants `FLUSH_INTERVAL_MS = 50`, `MAX_BATCH = 100`, `HARD_BUFFER_CAP = 1000` (Pitfall 7)
    - logRouter writes to `<userData>/logs/<characterId>-<isoTimestamp>.log` via `createWriteStream` with `flags: 'a'`
    - logRouter classifies tags using regex `^\[\d{2}:\d{2}:\d{2}\.\d{3}\]\s+(\[[^\]]+\])`
    - `src/main/botSupervisor.ts` exports `createBotSupervisor`
    - botSupervisor uses `utilityProcess.fork(botEntry, [], {stdio: 'pipe'})` (Pitfall 2 mitigated — `stdio: 'pipe'` literal present)
    - botSupervisor branches on `app.isPackaged` and uses `process.resourcesPath` + `'app.asar.unpacked'` + `'src/bot/index.js'` for the packaged path (Pitfall 1)
    - botSupervisor uses `MessageChannelMain` and transfers port2 to child via `child.postMessage(..., [port2])`
    - botSupervisor calls `loadApiKey` to obtain plaintext api key, passes it via the init message — never via webContents.send/IPC
    - botSupervisor implements 30s summon timeout (`SUMMON_TIMEOUT_MS = 30`) and 10s stop timeout (`STOP_TIMEOUT_MS = 10`)
    - botSupervisor escalates to `child.kill()` on stop timeout (Project Constraint §5)
    - botSupervisor calls `getCharacter(characterId)` to load character JSON (Plan 03 surface)
    - **BLOCKER-4 fix:** botSupervisor imports `loadConfig as loadUserConfig` from `./configStore`, calls it before fork, and includes `mc_username` and `preferred_name` in the postMessage payload (verified by grep `mc_username,` and `preferred_name,` in the file)
    - **BLOCKER-4 fix:** botSupervisor refuses to fork when `mc_username` is empty — throws `MC_USERNAME_MISSING` and emits a status with an explanatory message (verified by grep `MC_USERNAME_MISSING`)
    - `npx tsc --noEmit -p tsconfig.node.json` reports 0 errors for `logRouter.ts` and `botSupervisor.ts` (TS2307 for `../bot/...` tolerated)
  </acceptance_criteria>
  <done>Bot supervisor + log router complete. Plan 05 wires these into IPC handlers.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| utilityProcess→main | Child stdout/stderr is untrusted (could contain anything mineflayer/Anthropic logs); main treats as opaque text |
| main→utilityProcess | Decrypted API key + character config crosses MessagePortMain — outside of the renderer's reach by design |
| renderer→main | Plan 05's IPC layer enforces — this plan only defines factories |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-04-14 | Information Disclosure | API key in stdout/log file | mitigate | Bot must NEVER log the api key string — caller (plan 03) verifies; logRouter does not redact (logs are user-local under `<userData>/logs/`, OS-protected) |
| T-04-15 | Tampering | utilityProcess crash leaves zombie processes | mitigate | `child.on('exit')` always resolves session.exited; `app.before-quit` calls `supervisor.shutdown()` to gracefully stop active session |
| T-04-16 | Denial of Service | log firehose stalls renderer | mitigate | Pitfall 7 batching: 50ms flush, 100/batch, drop with sentinel above 1000 |
| T-04-17 | Tampering | asar-internal path crash on packaged build | mitigate | Pitfall 1: branch on `app.isPackaged` + asarUnpack `src/bot/**/*` already in plan 01 stub |
| T-04-18 | Spoofing | stdio:'inherit' silently breaks log routing | mitigate | Pitfall 2: explicit `stdio: 'pipe'` |
| T-04-19 | Denial of Service | summon hangs forever on unresponsive bot | mitigate | 30s `SUMMON_TIMEOUT_MS` rejects with `BOT_START_TIMEOUT` |
| T-04-20 | Tampering | bot spuriously calls discoverLanPort during summon, conflicting with main watcher socket | mitigate | Pitfall 6 lexical guard in `src/bot/index.js`; verified by grep gate |
| T-04-20b | Tampering | malformed init payload silently breaks ConfigSchema.parse, bot exits without summon-ready | mitigate | BLOCKER-1/2/4 fix: bot config object explicitly satisfies ConfigSchema (auth/username/memory paths); supervisor refuses to fork on missing mc_username; ConfigSchema.parse failure surfaces via init-ack absence + 30s SUMMON_TIMEOUT |
</threat_model>

<verification>
- `npx tsc --noEmit -p tsconfig.node.json` clean for `src/main/{lanWatcher,botSupervisor,logRouter}.ts`
- `node --check src/bot/index.js` clean
- `node --check src/bot/adapter/minecraft/lanDiscovery.js` clean
- Pitfall 6 grep gate (in Task 1's verify): `grep -rn 'discoverLanPort' src/bot/ | grep -v 'src/bot/cli/' | grep -v 'src/bot/adapter/minecraft/lanDiscovery.js'` returns 0 matches
</verification>

<success_criteria>
- Plan 05 (main entry + IPC) imports `watchLan`, `createBotSupervisor`, and the supervisor's `BotSupervisor` interface and wires them into `app.whenReady()` + `ipcMain.handle('bot:summon', ...)` + `ipcMain.handle('bot:stop', ...)`.
- Plan 11 (clean-VM smoke) verifies on macOS/Windows that summoning a character forks the bot, lan watcher reports `connected`, log lines flow to renderer, and stop cleanly exits.
</success_criteria>

<output>
After completion, create `.planning/phases/04-electron-gui-packaging/04-04-SUMMARY.md` documenting:
- The exact `botEntryPath()` resolution function — important for plan 11 to verify on packaged builds
- Confirmation of Pitfall 6 grep gate result (paste the empty output)
- Note for plan 05 executor: `createBotSupervisor` requires `getLanPort()` callback — wire it as `() => latestLanState.kind === 'connected' ? latestLanState.port : null` inside main/index.ts
- Note for plan 05 executor: log batch flow is `botSupervisor → opts.sendLog(batch) → mainWindow.webContents.send('bot:log:batch', batch)`. The renderer subscribes via `onLog` (preload).
</output>
