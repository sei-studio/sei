# Phase 4: Electron GUI & Packaging — Pattern Map

**Mapped:** 2026-05-08
**Files analyzed:** ~50 new files + 6 relocated/refactored files
**Analogs found in repo:** 8 strong matches; remainder are NEW (Electron / React surface area does not exist yet)

> **Reading order for executors:** for any new file under `src/main/`, `src/preload/`, or `src/renderer/`, treat the listed *near-analog* as a stylistic and structural reference (logger shape, error narration, JSDoc rhythm, atomic-write reuse) — NOT as a template to copy verbatim. The actual API shape comes from RESEARCH.md "Code Examples" + UI-SPEC.md component contracts. The mockup at `.planning/phases/04-electron-gui-packaging/design/project/{ui.jsx,screens.jsx,app.jsx,macos-window.jsx,index.html}` is the visual source of truth for renderer files.

---

## File Classification

### Repository-restructure (relocate-only — no logic change per CONTEXT D-06)

| New path | Old path | Role | Data flow | Notes |
|----------|----------|------|-----------|-------|
| `src/bot/index.js` | `src/index.js` | utilityProcess entrypoint | event-driven (parentPort) | becomes the `utilityProcess.fork` target; loadConfig now consumes a pre-merged config object delivered over MessagePort instead of reading `./config.json` |
| `src/bot/cli/index.js` | `src/cli/index.js` | CLI entrypoint | CRUD + spawn | preserved per D-07; `bin: { sei: ... }` path updates; `INDEX_PATH` constant updates to `src/bot/index.js` |
| `src/bot/config.js` | `src/config.js` | schema/validator | transform | imports updated; CLI keeps using it; main also reads (via `src/bot/`) for migration logic |
| `src/bot/registry.js` | `src/registry.js` | action registry | request-response | imports updated only |
| `src/bot/brain/**/*` | `src/brain/**/*` | brain modules | mixed | imports updated only |
| `src/bot/adapter/**/*` | `src/adapter/**/*` | adapter modules | mixed | imports updated only |

### NEW Electron-shell files (main process)

| File | Role | Data flow | Closest analog | Match quality |
|------|------|-----------|----------------|---------------|
| `src/main/index.ts` | bootstrap / app.whenReady composer | event-driven | `src/index.js` `start()` boot composer | role-match (composer pattern); language + APIs differ |
| `src/main/botSupervisor.ts` | utilityProcess lifecycle (fork / supervise / stop / restart) | event-driven (child stdio + MessagePort) | `src/cli/index.js` `cmdStart()` (`spawn(node, [INDEX_PATH], { stdio: 'inherit' })`) | partial — same conceptual ancestor (spawn-and-supervise); replace `child_process.spawn` with `utilityProcess.fork` and `'inherit'` with `'pipe'` |
| `src/main/lanWatcher.ts` | long-lived multicast LAN watcher | streaming (UDP) | `src/adapter/minecraft/lanDiscovery.js` | **EXACT** — refactor target per D-20. Pull socket logic into `watchLan({onUpdate, staleMs}) → {stop}`; existing one-shot `discoverLanPort()` becomes a thin wrapper |
| `src/main/characterStore.ts` | per-character JSON CRUD + index manifest | CRUD (file I/O) | `src/brain/memory/owner.js` (parse/save with `atomicWrite` + `withFileLock`) | role-match — same atomic-write + file-lock pattern; OWNER.md uses YAML frontmatter, characters use raw JSON |
| `src/main/configStore.ts` | `<userData>/config.json` read/write | CRUD (file I/O) | `src/config.js` `loadConfig()` + `migrateLegacyAdapterFields()` | role-match — same Zod-schema + migration pattern; new schema covers `mc_username`/`preferred_name`/`provider`/`theme_mode` only |
| `src/main/apiKeyStore.ts` | safeStorage encrypt/decrypt → `api_key.bin` | CRUD (encrypted blob) | none in repo | NEW — Electron `safeStorage` API |
| `src/main/ipc.ts` | `ipcMain.handle` channel registrations | request-response | none in repo | NEW — wires shared/ipc.ts contract |
| `src/main/logRouter.ts` | tee utilityProcess stdout/stderr → renderer + rolling file | streaming (line-split) | `src/brain/log.js` (tag-prefix line emit) | partial — log.js is the **producer** of the lines logRouter parses; tag conventions (`[chat<-]`, `[chat->]`, `[haiku?]`, `[haiku!]`, `[heal]`, `[act!]`) are established here |
| `src/main/windowChrome.ts` | platform-branched `BrowserWindow` chrome | config | none in repo | NEW — Electron BrowserWindow APIs |
| `src/main/migration.ts` | first-launch migration: legacy `persona` → `characters/sui.json`; cwd `memory/` → `<userData>/memory/sui/` | transform (idempotent) | `src/config.js` `migrateLegacyAdapterFields()` | role-match — same one-shot idempotent migration shape |

### NEW preload

| File | Role | Data flow | Closest analog | Match quality |
|------|------|-----------|----------------|---------------|
| `src/preload/index.ts` | `contextBridge.exposeInMainWorld('sei', api)` | event-driven (push) + request-response (invoke) | none in repo | NEW |

### NEW shared types

| File | Role | Data flow | Closest analog | Match quality |
|------|------|-----------|----------------|---------------|
| `src/shared/ipc.ts` | `RendererApi` type + IPC channel string-literal union + payload types | type definitions | `src/brain/types.js` Adapter contract (REQUIRED_ADAPTER_MEMBERS) | partial — same "explicit member contract" shape but types instead of runtime asserts |
| `src/shared/characterSchema.ts` | Zod schema for `<userData>/characters/<id>.json` | schema | `src/config.js` `ConfigSchema` (Zod object with defaults + nested) | role-match — same Zod patterns (defaults, nested objects, ISO timestamps as strings) |
| `src/shared/errorClasses.ts` | union of error class string-literals (GUI-05) | type definitions | `src/brain/errStrings.js` | role-match — central error-string surface |

### NEW renderer (Vite + React + TS — entirely new surface)

#### Renderer entry / shell

| File | Role | Data flow | Closest analog | Match quality |
|------|------|-----------|----------------|---------------|
| `src/renderer/index.html` | Vite entrypoint | n/a | `.planning/phases/04-electron-gui-packaging/design/project/index.html` | mockup-direct (port verbatim minus inlined `<style>`) |
| `src/renderer/src/main.tsx` | `ReactDOM.createRoot(...).render(<App/>)` | n/a | none in repo | NEW |
| `src/renderer/src/App.tsx` | router + theme provider + lazy-load boundary | event-driven (subscriptions) | `design/project/app.jsx` | mockup-direct |
| `src/renderer/src/global.d.ts` | `declare global { interface Window { sei: RendererApi } }` | type | none in repo | NEW |

#### Renderer screens (all mockup-direct from `design/project/screens.jsx` and `app.jsx`)

| File | Role | Data flow | Source |
|------|------|-----------|--------|
| `src/renderer/src/screens/LoadingScreen.tsx` | boot loading screen | timer + event | `app.jsx` LoadingScreen |
| `src/renderer/src/screens/OnboardingScreen.tsx` | 5-step onboarding | request-response | `screens.jsx` OnboardingScreen |
| `src/renderer/src/screens/HomeScreen.tsx` | character grid | CRUD | `screens.jsx` HomeScreen |
| `src/renderer/src/screens/AddCharacterScreen.tsx` | 3-step add character | request-response | `screens.jsx` AddCharacterScreen |
| `src/renderer/src/screens/CharacterPage.tsx` | character detail (portrait + persona + logs) | event-driven (status + logs) | `screens.jsx` CharacterPage |
| `src/renderer/src/screens/SettingsScreen.tsx` | settings | CRUD | `screens.jsx` SettingsScreen |
| `src/renderer/src/screens/ComingSoonScreen.tsx` | placeholder for non-Minecraft games | n/a | `screens.jsx` ComingSoonScreen |

#### Renderer components (all mockup-direct from `design/project/ui.jsx`)

| File | Role | Source |
|------|------|--------|
| `src/renderer/src/components/Button.tsx` | primary/accent/ghost/quiet button | `ui.jsx` Button |
| `src/renderer/src/components/TextField.tsx` | borderless underline input | `ui.jsx` TextField |
| `src/renderer/src/components/IconRail.tsx` | 72px sidebar | `ui.jsx` Sidebar + RailButton |
| `src/renderer/src/components/MacosWindow.tsx` | 1180×760 chrome | `ui.jsx` AppWindow + `macos-window.jsx` |
| `src/renderer/src/components/PixelPortrait.tsx` | procedural 12×12 sprite | `ui.jsx` PixelPortrait |
| `src/renderer/src/components/StepDots.tsx` | progress indicator | `screens.jsx` StepDots |
| `src/renderer/src/components/AddCard.tsx` | dashed "new character" tile | `screens.jsx` AddCard |
| `src/renderer/src/components/CharacterCard.tsx` | grid card | `screens.jsx` CharacterCard |
| `src/renderer/src/components/LanModal.tsx` | LAN instructions modal | `screens.jsx` LanModal |
| `src/renderer/src/components/SummonToast.tsx` | bottom-right toast | `screens.jsx` SummonToast |
| `src/renderer/src/components/LogsPanel.tsx` | virtualized log viewer (NEW — not in mockup, see UI-SPEC §Logs) | UI-SPEC §Logs panel |
| `src/renderer/src/components/DeleteConfirmModal.tsx` | sharp-cornered confirm | UI-SPEC §Character delete-gating |
| `src/renderer/src/components/icons.tsx` | inline SVG icons | `ui.jsx` icons |

#### Renderer lib / state

| File | Role | Closest analog | Match quality |
|------|------|----------------|---------------|
| `src/renderer/src/lib/ipcClient.ts` | typed wrapper around `window.sei` | none in repo | NEW |
| `src/renderer/src/lib/theme.ts` | `prefers-color-scheme` listener + `data-theme` apply | none in repo | NEW |
| `src/renderer/src/lib/stores/useUiStore.ts` | Zustand UI store (view/modal/theme) | `src/brain/sessionState.js` (factory closure with internal state) | partial — same "factory returns getters/setters" shape; Zustand wraps with subscribe |
| `src/renderer/src/lib/stores/useDataStore.ts` | Zustand data store (chars/lan/summon/logs ring buffer) | `src/brain/sessionState.js` | partial |
| `src/renderer/src/lib/tagLog.ts` | pure regex log-line color tagger | `src/brain/log.js` tag prefixes | role-match — log.js DEFINES the tags; tagLog.ts CONSUMES them |
| `src/renderer/src/lib/errors.ts` | error class → plain-English copy map (GUI-05) | `src/brain/errStrings.js` | role-match |
| `src/renderer/src/lib/portraitPalettes.ts` | 6-color palettes per theme | none in repo (mockup `app.jsx` constant) | NEW |

#### Renderer styles / fonts / assets

| File | Source |
|------|--------|
| `src/renderer/src/styles/tokens.css` | UI-SPEC §Color token table verbatim |
| `src/renderer/src/styles/global.css` | `design/project/index.html` `<style>` body styles |
| `src/renderer/src/styles/animations.css` | UI-SPEC §Animation Tokens (`seiPulse`, `seiDot`, `fade`, `fade-up`) |
| `src/renderer/src/styles/fonts.css` | self-hosted `@font-face` for Noto Sans / Press Start 2P / JetBrains Mono |
| `src/renderer/public/img/sei-logo*.{svg,png}` | moved from repo root per D-08 |
| `src/renderer/public/fonts/*.woff2` | downloaded from Google Fonts (D-05) |

### NEW packaging / build config

| File | Role | Closest analog | Match quality |
|------|------|----------------|---------------|
| `electron-builder.yml` | packaging config | none in repo | NEW (RESEARCH §Code Examples §3 is the spec) |
| `electron.vite.config.ts` | electron-vite build harness | none in repo | NEW |
| `tsconfig.json` (+ split tsconfigs per process) | TS configs | none in repo | NEW |
| `build/entitlements.mac.plist` | macOS hardened-runtime entitlements | none in repo | NEW (RESEARCH §Code Examples §4 is the spec) |
| `build/sign.js` (Windows custom signer, optional) | signing | none in repo | NEW |
| `package.json` | rewrites: `main`, `bin.sei` path, scripts (electron-vite dev/build/dist), postinstall, devDeps, deps | self | self-modify |

### MODIFIED existing files (small edits)

| File | Edit |
|------|------|
| `.gitignore` | add `dist/`, `release/`, `out/`, `*.log` |
| `sei_logo.{svg,png}`, `sei_logo_small.{svg,png}` (repo root) | DELETE — moved to `src/renderer/public/img/` per D-08 |

---

## Pattern Assignments

### `src/main/lanWatcher.ts` (refactor of existing module — EXACT analog)

**Analog:** `src/adapter/minecraft/lanDiscovery.js`

**Existing pattern to evolve** (lines 1-43):
```js
import dgram from 'dgram'

const MC_LAN_GROUP = '224.0.2.60'
const MC_LAN_PORT = 4445

export function discoverLanPort({ timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    let settled = false
    // ... timer + finish() + socket.on('message', ...)
    socket.bind(MC_LAN_PORT, () => {
      try { socket.addMembership(MC_LAN_GROUP) }
      catch (err) { finish(err) }
    })
  })
}
```

**Refactor target** (per D-20, RESEARCH Pattern 3):

1. Pull socket-open + `[MOTD]…[/MOTD][AD]port[/AD]` parse into `watchLan({ onUpdate, staleMs }) → { stop }` with three emitted states (`connected` / `not_connected` / `unavailable`) per D-22.
2. Keep one-shot `discoverLanPort()` AS-IS (CLI still uses it from `src/bot/cli/index.js`) but re-implement it as a thin wrapper that calls `watchLan` and resolves on first `connected` event.
3. The watcher lives in `src/main/lanWatcher.ts` and is opened once at `app.whenReady` per D-21.
4. **Pitfall 6 enforcement:** verify with grep that the bot side (relocated to `src/bot/`) makes no `discoverLanPort` calls during summon — it receives `{port}` over MessagePort per D-25.

The `watchLan` body is documented verbatim in RESEARCH Pattern 3 (lines 491-541 of 04-RESEARCH.md). Copy structure and constants from the existing file, add `lastSeenAt` / `staleTimer` for staleness detection.

---

### `src/main/characterStore.ts` (NEW — uses existing atomic-write pattern)

**Analog:** `src/brain/memory/owner.js` (parse/save shape) + `src/brain/storage/atomicWrite.js` (file write) + `src/brain/storage/fileLock.js` (per-path mutex)

**Imports pattern to follow** (lines 21-23 of `owner.js`):
```js
import { readFile } from 'node:fs/promises'
import { atomicWrite } from '../storage/atomicWrite.js'
import { withFileLock } from '../storage/fileLock.js'
```

**For characterStore.ts in `src/main/` use:** `import { atomicWrite } from '../bot/brain/storage/atomicWrite.js'` and `import { withFileLock } from '../bot/brain/storage/fileLock.js'` — these modules are pure-JS, no Electron-specific concerns; reuse directly per CONTEXT "Existing Code Insights — Atomic JSON writes via tmp+rename".

**Atomic write pattern** (`atomicWrite.js` lines 22-36, **REUSE AS-IS — do not roll a separate helper**):
```js
export async function atomicWrite(path, contents) {
  const tmp = join(dirname(path), `.${basename(path)}.tmp.${process.pid}.${Date.now()}`)
  try {
    await writeFile(tmp, contents, 'utf8')
    await rename(tmp, path)
  } catch (err) {
    try { await unlink(tmp) } catch {}
    throw err
  }
}
```

**Per-file lock pattern** (`fileLock.js` lines 33-42 — **REUSE AS-IS**):
```js
export async function withFileLock(filePath, fn) {
  const prev = tails.get(filePath) ?? Promise.resolve()
  const run = prev.catch(() => {}).then(() => fn())
  tails.set(filePath, run.then(() => undefined, () => undefined))
  return run
}
```

**Read-modify-write skeleton** (mirror `owner.js`'s `loadOwner` lines 65-78, then wrap mutating ops in `withFileLock(charPath, async () => { ... atomicWrite(charPath, JSON.stringify(next, null, 2)) })`):
- `listCharacters()` → read `<userData>/characters/index.json`, parse, return ordered list.
- `getCharacter(id)` → read `<userData>/characters/${id}.json`, parse with `CharacterSchema` (Zod, see `src/shared/characterSchema.ts`).
- `saveCharacter(c)` → `withFileLock(charPath, () => atomicWrite(charPath, JSON.stringify(c, null, 2) + '\n'))`. Update `index.json` in same lock if the id is new.
- `deleteCharacter(id)` → unlink JSON + optional PNG + recursive remove of `<userData>/memory/<id>/`. Update `index.json`.

**ENOENT pattern** (mirror `owner.js` lines 70-78):
```js
let raw
try { raw = await readFile(path, 'utf8') }
catch (err) { if (err && err.code === 'ENOENT') return null; throw err }
```

---

### `src/main/configStore.ts` (NEW — uses existing Zod-config pattern)

**Analog:** `src/config.js`

**Schema pattern** (lines 17-77):
```js
const ConfigSchema = z.object({
  chat_mode: z.enum(['chat', 'full']).default('chat'),
  owner_username: z.string(),
  persona: z.object({...}),
  anthropic: z.object({...}),
  llm: z.object({...}).default({}),
  memory: z.object({...}).default({}),
  adapter: AdapterSchema,
})
```

**For Phase 4 the GUI-side schema in `src/main/configStore.ts` is much smaller** (per D-12 — secrets and persona moved out):
```ts
const UserConfigSchema = z.object({
  mc_username: z.string(),
  preferred_name: z.string().default(''),
  provider: z.enum(['anthropic']).default('anthropic'),  // D-26 reserves more
  theme_mode: z.enum(['system', 'light', 'dark']).default('system'),
});
```

**Migration pattern to mirror** (`config.js` lines 86-100 `migrateLegacyAdapterFields`):
```js
function migrateLegacyAdapterFields(raw) {
  if (raw.adapter && raw.adapter.minecraft) return raw
  const mc = {}
  const moveKey = (k, dst = k) => { if (raw[k] !== undefined) { mc[dst] = raw[k] } }
  moveKey('host'); moveKey('port'); /* ... */
  if (Object.keys(mc).length === 0) return raw
  return { ...raw, adapter: { kind: 'minecraft', minecraft: mc } }
}
```

**For `src/main/migration.ts`, mirror this idempotency pattern (early-return when already-migrated)** — applied to D-10:
```ts
function migrateLegacyPersona(legacyConfig: any, charsDir: string) {
  if (!legacyConfig.persona) return legacyConfig            // already migrated
  if (existsSync(join(charsDir, 'sui.json'))) {
    const { persona, ...rest } = legacyConfig                // already wrote, just strip
    return rest
  }
  // ... write characters/sui.json with id='sui', name=persona.name, etc.
}
```

**Validate-on-load pattern** (`config.js` lines 102-118 `loadConfig`): wrap reads with the Zod parse so callers get a known shape.

---

### `src/main/botSupervisor.ts` (NEW — supersedes CLI's child-process spawn)

**Analog:** `src/cli/index.js` `cmdStart()` lines 259-276

**Current CLI spawn pattern** (lines 263-275):
```js
const { spawn } = await import('node:child_process')
const child = spawn(process.execPath, [INDEX_PATH], {
  stdio: 'inherit',
  cwd: PROJECT_ROOT,
})
return new Promise((res) => {
  child.on('exit', (code) => { process.exit(code ?? 0) })
  child.on('error', (err) => { /* ... */ })
})
```

**Replace with `utilityProcess.fork` + `MessageChannelMain` per D-15/D-18.** Full pattern documented in RESEARCH Pattern 1 (04-RESEARCH.md lines 321-401). Key replacements:

| Old (cli) | New (botSupervisor) | Why |
|-----------|---------------------|-----|
| `child_process.spawn(node, [INDEX_PATH])` | `utilityProcess.fork(botEntry, [], {...})` | Pitfall asar-internal-path; D-15 hard rule |
| `stdio: 'inherit'` | `stdio: 'pipe'` | Pitfall 2 — `child.stdout` becomes null with `'inherit'` |
| `cwd: PROJECT_ROOT` | path resolves via `app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked', 'src/bot/index.js') : path.join(__dirname, '../bot/index.js')` | Pitfall 1 (electron/electron#41396) |
| Config flows in via `loadConfig('./config.json')` inside the child | Config flows in via `child.postMessage({type:'init', character, apiKey, lanPort}, [port2])` after `'spawn'` | Decrypted API key never crosses through renderer; D-13 |
| Single child outlives parent | `stop({ timeoutMs }) → race(exit, timer); if !exited child.kill()` | D-16 + Project Constraint §5 (stop within 10s) |

**Lifecycle event narration pattern** (mirror `src/index.js` lines 24-27 logger calls):
```js
logger.info('Searching for an open LAN world...')
logger.info(`Found LAN world "${motd}" on port ${port}`)
```

**For botSupervisor surface lifecycle events to the renderer**: emit `bot:status` IPC with parsed events (`connected` / `disconnected` / `error` / `chat` / `summon-ready` / `summon-stopped`) per D-19 — use the same event-name vocabulary the existing brain emits.

---

### `src/main/apiKeyStore.ts` (NEW — Electron `safeStorage`)

**Analog:** none in repo (`safeStorage` is main-process-only Electron API).

**Spec:** RESEARCH Pattern 4 (04-RESEARCH.md lines 555-591). Reproduce verbatim, then add atomic-write reuse:
```ts
import { atomicWrite } from '../bot/brain/storage/atomicWrite.js';
// in saveApiKey:
const buf = safeStorage.encryptString(plaintext);
await atomicWrite(keyPath(), buf.toString('base64'));   // string-encode for atomicWrite
// or: bypass atomicWrite and use fs.writeFile directly with tmp+rename pattern
```

**Linux fallback warning** (Pitfall 3, RESEARCH lines 664-669): on app boot, check `safeStorage.getSelectedStorageBackend() === 'basic_text'` and surface the `KEYCHAIN_FALLBACK_PLAINTEXT` error class (UI-SPEC §Plain-English error copy table).

---

### `src/main/logRouter.ts` (NEW — consumes existing log.js tag conventions)

**Analog:** `src/brain/log.js` (the producer)

**Producer-side tag emit pattern** (`log.js` lines 25-50 — already shipping; do NOT modify):
```js
emit('[chat<-]', `${username}: ${trunc(message)}`)
emit('[chat->]', trunc(text))
emit('[haiku?]', `tools=... user=${trunc(userMsg)}`)
emit('[haiku!]', `stop=... text=... calls=...`)
emit('[heal]', `pos=... vel=...`)
emit('[act!]', `${name} → ${trunc(...)}`)
```

**Line-split pattern** for stdout/stderr (RESEARCH lines 372-381 — copy verbatim):
```ts
const lineSplit = (chunk: Buffer, buffer: { tail: string }, sink: (line: string) => void) => {
  const text = buffer.tail + chunk.toString('utf-8');
  const lines = text.split('\n');
  buffer.tail = lines.pop() ?? '';
  for (const line of lines) if (line) sink(line);
};
```

**Tee pattern (D-18):** sink fans out to two destinations:
1. `webContents.send('bot:log:batch', batched)` — batched per Pitfall 7 (50ms flush, max 100/batch, drop with sentinel above 1000).
2. `<userData>/logs/<characterId>-<isoTimestamp>.log` — `fs.createWriteStream` with append flag, rotated per summon session.

**Pitfall 7 batching pattern** is documented in RESEARCH (lines 696-700). Implement as a small `BatchedSender` class in `logRouter.ts`.

---

### `src/main/index.ts` (NEW — boot composer)

**Analog:** `src/index.js` `start()` function (lines 24-105)

**Boot composer structure to mirror** (lines 24-105):
```js
export async function start() {
  // 1. discover / load config
  const { port, motd } = await discoverLanPort({ timeoutMs: 5000 })
  const config = loadConfig('./config.json', { port })

  // 2. construct subsystems
  let _brain = null, _bot = null, _adapter = null, _stopped = false
  const bringUp = async () => { _bot = createBotInstance(...); _adapter = createMinecraftAdapter(...); _brain = await startBrain(...) }
  await bringUp()

  // 3. return shutdown handle
  return {
    async stop() {
      _stopped = true
      if (_brain) { try { await _brain.stop() } catch {} }
      try { _adapter?.detach?.() } catch {}
      if (_bot) { try { _bot.quit('Sei stopping') } catch {}; _bot = null }
    },
  }
}
```

**For `src/main/index.ts` adapt to Electron lifecycle:**
```ts
app.whenReady().then(async () => {
  // 1. open subsystems
  const lanWatcher = watchLan({ onUpdate: (s) => mainWindow.webContents.send('lan:state', s), staleMs: 3000 });
  const supervisor = createBotSupervisor({ /* ... */ });
  registerIpcHandlers({ characterStore, configStore, apiKeyStore, supervisor, lanWatcher });

  // 2. open window
  mainWindow = createMainWindow({ titleBarStyle: 'hiddenInset' /* per platform */ });

  // 3. graceful shutdown — same pattern as src/index.js stop()
  app.on('before-quit', async (e) => {
    e.preventDefault();
    try { await supervisor.stop({ timeoutMs: 10_000 }) } catch {}
    try { lanWatcher.stop() } catch {}
    app.exit(0);
  });
});
```

**Logger shape** (mirror `src/index.js` lines 18-22):
```js
const logger = {
  info:  (m) => console.log(`[sei] ${typeof m === 'string' ? m : JSON.stringify(m)}`),
  warn:  (m) => console.warn(`[sei] ${typeof m === 'string' ? m : JSON.stringify(m)}`),
  error: (m) => console.error(`[sei] ${typeof m === 'string' ? m : JSON.stringify(m)}`),
}
```
**Use this exact shape across all `src/main/*.ts` modules** so the relocated `src/bot/` brain logger format and the new main process logger format are identical — that means the user-data rolling log file in `<userData>/logs/` reads with the same `[sei]` / `[chat<-]` / `[haiku?]` prefix grammar regardless of which process emitted the line.

---

### `src/preload/index.ts` (NEW)

**Analog:** none (preload is unique to Electron contextBridge).

**Spec:** RESEARCH Pattern 2 (04-RESEARCH.md lines 437-474). Copy verbatim. Key contract:
```ts
contextBridge.exposeInMainWorld('sei', {
  // request/response
  listCharacters: () => ipcRenderer.invoke('chars:list'),
  // ...
  // push subscriptions return Unsubscribe
  onLog: (cb) => {
    const handler = (_e: unknown, entry: LogEntry) => cb(entry);
    ipcRenderer.on('bot:log', handler);
    return () => ipcRenderer.off('bot:log', handler);
  },
});
```

**Channel-name list (UI-SPEC Defaults, locked):** `bot:summon`, `bot:stop`, `bot:status`, `bot:log`, `bot:log:batch`, `lan:state`, `chars:list`, `chars:get`, `chars:save`, `chars:delete`, `config:get`, `config:save`, `config:save-api-key`, `config:has-api-key`, `app:ready`.

---

### `src/shared/ipc.ts` (NEW)

**Analog:** `src/brain/types.js` (Adapter contract via `REQUIRED_ADAPTER_MEMBERS` array — same intent: explicit interface)

**Pattern from `brain/index.js` lines 22-31:**
```js
const REQUIRED_ADAPTER_MEMBERS = [
  'listActions', 'getActionSchema', 'getActionDescription', 'executeAction',
  'createSnapshotComposer', 'worldPrimer',
  'attach',
  'chat', 'setInflightProvider', 'closeAnySessions',
  // ...
]
function assertAdapter(adapter) {
  for (const k of REQUIRED_ADAPTER_MEMBERS) {
    if (!(k in adapter)) throw new Error(`brain.start: adapter missing required member: ${k}`)
  }
}
```

**For `shared/ipc.ts` use TS to make this compile-time** (per CONTEXT D-17):
```ts
export type RendererApi = {
  summon(characterId: string): Promise<void>;
  stop(): Promise<void>;
  onStatus(cb: (s: BotStatus) => void): Unsubscribe;
  onLog(cb: (entry: LogEntry) => void): Unsubscribe;
  onLan(cb: (s: LanState) => void): Unsubscribe;
  listCharacters(): Promise<Character[]>;
  getCharacter(id: string): Promise<Character>;
  saveCharacter(c: Character): Promise<void>;
  deleteCharacter(id: string): Promise<void>;
  getConfig(): Promise<UserConfig>;
  saveConfig(c: UserConfig): Promise<void>;
  saveApiKey(plaintext: string): Promise<void>;
  hasApiKey(): Promise<boolean>;
};
export type BotStatus = { kind: 'idle' } | { kind: 'connecting' } | { kind: 'online'; uptime: number } | { kind: 'error'; error: ErrorClass; message: string };
export type LanState = { kind: 'connected'; port: number; motd: string; lastSeenAt: number } | { kind: 'not_connected' } | { kind: 'unavailable' };
export type LogEntry = { timestamp: string; tag: string | null; message: string; level: 'info' | 'warn' | 'error' };
export type Unsubscribe = () => void;
// IPC channel string-literal union (per channel-name list above)
export const IpcChannel = {
  bot: { summon: 'bot:summon', stop: 'bot:stop', status: 'bot:status', log: 'bot:log', logBatch: 'bot:log:batch' },
  lan: { state: 'lan:state' },
  chars: { list: 'chars:list', get: 'chars:get', save: 'chars:save', delete: 'chars:delete' },
  config: { get: 'config:get', save: 'config:save', saveApiKey: 'config:save-api-key', hasApiKey: 'config:has-api-key' },
  app: { ready: 'app:ready' },
} as const;
```

---

### `src/shared/characterSchema.ts` (NEW — same Zod pattern as `src/config.js`)

**Analog:** `src/config.js` lines 17-77 ConfigSchema

**Pattern to mirror — Zod with defaults + nested objects + ISO-string timestamps:**
```ts
export const CharacterSchema = z.object({
  id: z.string().min(1),                              // slug
  name: z.string().min(1),
  description: z.string().default(''),                // shown to user (D-47)
  persona_prompt: z.string().min(1),                  // sent to model (D-48)
  is_default: z.boolean().default(false),             // sui = true
  created: z.string(),                                // ISO timestamp, immutable (D-11)
  last_launched: z.string().nullable().default(null), // ISO or null
  playtime_ms: z.number().int().min(0).default(0),
  portrait_image: z.string().nullable().default(null),// optional override file (D-14)
});
export type Character = z.infer<typeof CharacterSchema>;
```

**Index manifest schema:**
```ts
export const CharacterIndexSchema = z.object({
  version: z.literal(1).default(1),
  order: z.array(z.string()),                         // character ids, ordered
});
```

---

### `src/renderer/src/components/PixelPortrait.tsx` (NEW — pure algorithm port)

**Analog:** `.planning/phases/04-electron-gui-packaging/design/project/ui.jsx` `PixelPortrait` + algorithm verbatim per D-14 / UI-SPEC §PixelPortrait.

**Determinism contract** (UI-SPEC lines 346-361 + 588-592): port the FNV-1a hash and mulberry32-style PRNG **byte-for-byte**. Constants `2246822507` and `3266489909` are not arbitrary — same input → same sprite is the contract.

**Image override fallback** (UI-SPEC line 361): if `<userData>/characters/<id>.png` exists, render that; missing file → silently fall back to procedural. The image existence check happens in main (`characterStore.getCharacter` returns `portrait_image: '<id>.png'` only when the file exists); renderer trusts the `portrait_image` field.

---

### `src/renderer/src/lib/tagLog.ts` (NEW — consumes `src/brain/log.js` tags)

**Analog:** `src/brain/log.js` lines 24-50 (the producer)

**Tag prefix vocabulary the renderer must recognize** (already shipping in production logs):
- `[chat<-]` — chat in (incoming player→bot)
- `[chat->]` — chat out (bot→player)  → render in `--accent` per UI-SPEC §Logs panel (only place log lines may use accent)
- `[haiku?]` — Haiku query (prompt) → `--text-2`
- `[haiku!]` — Haiku response → `--text`
- `[heal]` — pos healer → default `--text-2`
- `[act!]` — action result → default `--text-2`

**UI-SPEC Defaults log-tagging** (UI-SPEC line 762): regex first-match on tag prefix:
```ts
export function tagLog(line: string): { color: string; line: string } {
  if (/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] \[chat->\]/.test(line)) return { color: 'var(--accent)', line };
  if (/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] \[haiku!\]/.test(line)) return { color: 'var(--text)', line };
  if (/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] \[haiku\?\]/.test(line)) return { color: 'var(--text-2)', line };
  if (/\[error\]|^ERROR\b|Error:/i.test(line)) return { color: 'var(--red)', line };
  if (/\[warn\]|^WARN\b/i.test(line)) return { color: 'var(--warn)', line };
  return { color: 'var(--text-2)', line };
}
```
**Note** the timestamp prefix in `log.js` line 21: `[${ts()}] ` where `ts() === HH:MM:SS.mmm` — the regexes account for this.

---

### `src/renderer/src/lib/errors.ts` (NEW — central plain-English error map per GUI-05)

**Analog:** `src/brain/errStrings.js` (existing brain-side error narration)

**Pattern to mirror — central string map keyed by error class:**
The error class union is defined in `src/shared/errorClasses.ts` (matching UI-SPEC §Plain-English error copy table 9 seeded classes plus `KEYCHAIN_FALLBACK_PLAINTEXT`):
```ts
export type ErrorClass =
  | 'BOT_START_TIMEOUT'
  | 'LAN_NOT_OPEN'
  | 'INVALID_API_KEY'
  | 'RATE_LIMITED'
  | 'NETWORK_OFFLINE'
  | 'BOT_CRASH'
  | 'LAN_UNAVAILABLE'
  | 'KEYCHAIN_LOCKED'
  | 'KEYCHAIN_FALLBACK_PLAINTEXT'
  | 'NATIVE_MODULE_MISMATCH';
```
And `lib/errors.ts` exports a string map (UI-SPEC table verbatim):
```ts
export const ERROR_COPY: Record<ErrorClass, string> = {
  BOT_START_TIMEOUT: "Couldn't start the bot in 30s. Make sure your LAN world is still open and try again.",
  LAN_NOT_OPEN: "We can't see an open LAN world. Press ESC in Minecraft and choose Open to LAN.",
  // ... rest from UI-SPEC table
};
```

---

### `src/renderer/src/lib/stores/useDataStore.ts` (NEW — Zustand)

**Analog:** `src/brain/sessionState.js` (factory pattern with internal state) — partial.

**Pattern to mirror** (closure-encapsulated internal state, getters/setters as named exports):
- `sessionState.js` exports `createSessionState({...})` that returns `{ onPlayerJoined, onPlayerLeft, onSpawn, setCompactor, ... }`.

**Zustand version** (RESEARCH §Code Examples §6 lines 849-875 is the spec for the logs ring buffer):
```ts
export const useDataStore = create<DataState>((set) => ({
  characters: [], lan: { kind: 'not_connected' }, summon: { kind: 'idle' }, logs: [],
  loadCharacters: async () => set({ characters: await window.sei.listCharacters() }),
  appendLogBatch: (batch) => set((s) => {
    const next = s.logs.concat(batch);
    return { logs: next.length > 5000 ? next.slice(-5000) : next };
  }),
  // ...
}));
```
Bounded ring buffer (5000 lines per D-53) is the only non-trivial detail. Subscriptions to `window.sei.onLog` / `onLan` / `onStatus` happen at the **store level** in `App.tsx`, not in component effects (Q5 resolution).

---

### `src/renderer/src/components/MacosWindow.tsx` (NEW — platform branching)

**Analog:** `.planning/phases/04-electron-gui-packaging/design/project/macos-window.jsx` + `ui.jsx` `AppWindow`

**Important contract** (UI-SPEC lines 336-343, CONTEXT D-32, RESEARCH Pitfall 9):
- macOS: `titleBarStyle: 'hiddenInset'` in `BrowserWindow` opts (configured in `src/main/windowChrome.ts`); macOS draws REAL traffic-light buttons; **do NOT render the mockup's JSX `TrafficLights` component** — it would overlap OS-drawn buttons.
- Windows: `frame: false` + `titleBarOverlay`; Windows draws min/max/close on the right.
- Linux: `frame: false`; window manager draws its own chrome.

The `MacosWindow.tsx` renderer component renders the title bar (38px, draggable via `-webkit-app-region: drag`, 80px left-padding on macOS so centered title doesn't collide with OS buttons) — but **never** renders fake traffic lights.

---

### `src/renderer/index.html`, `src/renderer/src/styles/*.css`

**Analog:** `.planning/phases/04-electron-gui-packaging/design/project/index.html`

**Action:** Port verbatim minus inline `<style>` block. Inline styles split into:
- `tokens.css` — CSS variable definitions (verbatim from UI-SPEC §Color tokens table)
- `global.css` — body, scrollbars, wallpaper texture (verbatim from `index.html` `<style>` body)
- `animations.css` — `@keyframes seiPulse`, `seiDot`, `fade`, `fade-up` (verbatim from UI-SPEC §Animation Tokens)
- `fonts.css` — `@font-face` declarations for self-hosted WOFF2s (UI-SPEC line 31 mandates self-hosting per D-05)

---

### `electron-builder.yml` and `build/entitlements.mac.plist` and `package.json`

**Analog:** none.

**Spec:** RESEARCH §Code Examples §3, §4, §5 (04-RESEARCH.md lines 738-846). Copy verbatim. Key locks:
- `appId: app.sei.placeholder` with `# TODO(lock-before-signing)` comment per RESEARCH §Resolved Q1 (line 956).
- `asarUnpack: ["src/bot/**/*"]` per Pitfall 1.
- `mac.target: [{target: dmg, arch: [universal]}]`.
- `mac.notarize: true` (electron-builder 26.x supports this natively per RESEARCH A7).
- `win.target: [{target: nsis, arch: [x64]}]` with **NO `signtoolOptions`** per RESEARCH §Resolved Q2 (ship unsigned v1).
- `linux.target: [AppImage]`.
- `package.json` `postinstall: "electron-builder install-app-deps"` per RESEARCH §Resolved Q6.

---

## Shared Patterns (apply to many files)

### Atomic JSON writes

**Source:** `src/brain/storage/atomicWrite.js` (lines 22-36) + `src/brain/storage/fileLock.js` (lines 33-42)
**Apply to:** `src/main/characterStore.ts`, `src/main/configStore.ts`, `src/main/apiKeyStore.ts`, `src/main/migration.ts` — every place main writes `<userData>/`.
**Reuse path:** `import { atomicWrite } from '../bot/brain/storage/atomicWrite.js'; import { withFileLock } from '../bot/brain/storage/fileLock.js'`

> **DO NOT roll a separate file-write helper.** The existing helpers handle tmp+rename and per-path mutex correctly. (CONTEXT explicit: "Existing Code Insights — Atomic JSON writes via tmp+rename. Reuse for character JSON saves; do NOT roll a separate file-write helper.")

### Logger format

**Source:** `src/index.js` lines 18-22
```js
const logger = {
  info:  (m) => console.log(`[sei] ${typeof m === 'string' ? m : JSON.stringify(m)}`),
  warn:  (m) => console.warn(`[sei] ${typeof m === 'string' ? m : JSON.stringify(m)}`),
  error: (m) => console.error(`[sei] ${typeof m === 'string' ? m : JSON.stringify(m)}`),
}
```
**Apply to:** every module under `src/main/*.ts`. The renderer uses `console` directly (DevTools is the renderer's surface). Keeping the `[sei]` prefix means the rolling log file at `<userData>/logs/` reads consistently regardless of which process emitted the line.

### Wall-clock timeouts on every external boundary (CLAUDE.md hard rule)

**Source:** `src/adapter/minecraft/lanDiscovery.js` lines 7-19 (Promise + setTimeout reject pattern)
```js
return new Promise((resolve, reject) => {
  const timer = setTimeout(() => finish(new Error(`No ... within ${timeoutMs}ms`)), timeoutMs)
  // ...
})
```
**Apply to:**
- `src/main/botSupervisor.ts` `summon()` — 30s timeout → `BOT_START_TIMEOUT` per Project Constraint §5.
- `src/main/botSupervisor.ts` `stop()` — 10s timeout → hard kill escalation (`child.kill()`) per D-16.
- Every `ipcMain.handle` that invokes a `child.postMessage` round-trip — wrap in `Promise.race` with a timeout.

### Idempotent migrations

**Source:** `src/config.js` `migrateLegacyAdapterFields` lines 86-100 (early-return when already migrated; no-op when no legacy keys present)
**Apply to:** `src/main/migration.ts` for D-10 (legacy `persona` → `characters/sui.json`) AND for memory dir relocation (`<cwd>/memory/` → `<userData>/memory/sui/` if `<userData>/memory/sui` is absent and the legacy dir exists). Both must be safely re-runnable.

### Adapter / supervisor teardown discipline

**Source:** `src/index.js` lines 44-66 (the `onEnd` reconnect path) + lines 88-103 (`stop()`)
```js
try { _adapter?.detach?.() } catch {}
_adapter = null
_bot = null
clearTimeout(_reconnectTimer)
```
**Apply to:** `src/main/botSupervisor.ts` cleanup. Every long-lived resource (LAN watcher socket, log write streams, MessagePort) gets a `try { x?.close?.() } catch {}` swallow on shutdown — same defensive style.

### Zod validation at every external boundary

**Source:** `src/config.js` ConfigSchema (lines 33-77) + `loadConfig` (lines 102-118)
**Apply to:**
- `src/shared/characterSchema.ts` — character JSON shape (validated on read in `characterStore.getCharacter`).
- `src/shared/ipc.ts` — runtime validate IPC payloads in `ipcMain.handle` (renderer can lie even with TS at compile time).
- `src/main/configStore.ts` — `<userData>/config.json` parse.

### Error narration

**Source:** `src/adapter/minecraft/connect.js` `humanizeReason` (lines 41-50)
```js
export function humanizeReason(reason) {
  if (!reason) return 'Unknown reason'
  const text = extractReasonText(reason)
  const r = text.toLowerCase()
  if (r.includes('econnrefused') || r.includes('connect')) return 'Could not reach server — make sure a LAN world is open'
  // ...
}
```
**Apply to:** `src/renderer/src/lib/errors.ts` (the `ERROR_COPY` map per UI-SPEC §Plain-English error copy table) and `src/main/botSupervisor.ts` (translate child errors to `ErrorClass` strings before forwarding to renderer).

> The "humanize raw error → plain-English string" pattern is already in production. `lib/errors.ts` is the renderer-side analog: classify error → look up plain-English copy.

---

## No Analog Found (planner uses RESEARCH.md / UI-SPEC.md verbatim)

| File | Why no analog | Authoritative source |
|------|---------------|-----------------------|
| `src/main/apiKeyStore.ts` | Electron `safeStorage` API doesn't exist outside Electron main | RESEARCH Pattern 4 |
| `src/preload/index.ts` | `contextBridge` is unique to Electron preload | RESEARCH Pattern 2 |
| `src/main/windowChrome.ts` | `BrowserWindow` is unique to Electron main | RESEARCH Pitfall 9 + UI-SPEC §MacosWindow |
| `src/renderer/index.html` and entire `src/renderer/src/**` | No React / Vite / TS surface in repo today | UI-SPEC + `design/project/` mockup |
| `src/renderer/src/lib/stores/useUiStore.ts` and `useDataStore.ts` | No Zustand in repo | RESEARCH §Code Examples §6 |
| `src/renderer/src/components/PixelPortrait.tsx` | Procedural sprite algorithm new to repo | UI-SPEC §PixelPortrait + `design/project/ui.jsx` |
| `electron-builder.yml`, `electron.vite.config.ts`, `tsconfig.json`, `build/entitlements.mac.plist`, `build/sign.js` | All packaging/build configs new | RESEARCH §Code Examples §3, §4, §5 |
| `src/main/ipc.ts` registrations | No `ipcMain` in repo | UI-SPEC Defaults channel-name list + `shared/ipc.ts` |

For these, the planner should reference RESEARCH.md and UI-SPEC.md sections by line number in plan-step `Action` blocks rather than pointing at any in-repo file.

---

## Metadata

**Analog search scope:** `/Users/ouen/slop/sei/src/**/*.js` (full source tree); `/Users/ouen/slop/sei/package.json`; `.planning/phases/04-electron-gui-packaging/design/project/*.jsx`.

**Files scanned in detail:** `src/index.js`, `src/cli/index.js`, `src/config.js`, `src/registry.js`, `src/brain/index.js`, `src/brain/fsm.js`, `src/brain/log.js`, `src/brain/memory/owner.js`, `src/brain/storage/atomicWrite.js`, `src/brain/storage/fileLock.js`, `src/adapter/minecraft/lanDiscovery.js`, `src/adapter/minecraft/connect.js`.

**Pattern extraction date:** 2026-05-08
