# Phase 4: Electron GUI & Packaging — Research

**Researched:** 2026-05-08
**Domain:** Electron desktop app (main + preload + renderer + utilityProcess), Vite/React/TS renderer, electron-builder distribution with code-signing, native-module rebuild via @electron/rebuild, OS keychain via safeStorage, live IPC log streaming.
**Confidence:** HIGH on Electron APIs / packaging mechanics (Context7 + official docs), HIGH on existing-codebase shape (file inspection), MEDIUM on Windows code-signing path (depends on user-supplied cert type), MEDIUM on universal-arm64 macOS build success (no native modules to break, but untested in this repo).

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Phase scope**
- D-01 — Full original roadmap scope ships in this phase: launcher UI **+** live log viewer (GUI-04) **+** signed `.dmg` / `.exe` packaging (PKG-01/02/03).
- D-02 — Phase 4 is reordered ahead of Phases 5/6/7 in execution order; ROADMAP numbering stays as-is.

**Build tooling**
- D-03 — **Vite + React + TypeScript** for the renderer. Mockup is React-shaped → 1:1 port. TS catches IPC contract drift between main/renderer/utility.
- D-04 — **electron-builder** for packaging; **`@electron/rebuild`** in `postinstall` for native-module ABI matching.
- D-05 — No CDN-loaded React/Babel. All renderer deps bundled by Vite. Same rule applies to fonts (UI-SPEC).

**Repository layout (everything under `src/`)**
- D-06 — Reshuffle to: `src/main/`, `src/preload/`, `src/renderer/{index.html,src/{App.tsx,screens/,components/,lib/,styles/},public/img/}`, `src/bot/` (existing brain/adapter/cli/etc relocated), `src/shared/` (TS types).
- D-07 — Existing CLI keeps shipping (`bin: { sei: ... }`); moves to `src/bot/cli/index.js`. Electron app gets a new `electron` script and a separate packaged-app bin.
- D-08 — Logos move from repo root → `src/renderer/public/img/`; repo-root copies deleted.

**Multi-character data model**
- D-09 — One JSON file per character at `<userData>/characters/<id>.json`, plus `<userData>/characters/index.json` manifest. `<userData>` = `app.getPath('userData')`, NEVER inside the app bundle.
- D-10 — First-launch migration: legacy `config.json.persona` → `characters/sui.json` with id `sui`. Idempotent.
- D-11 — `last_launched` set at summon-start; `playtime_ms` accumulates on summon-stop; `created` immutable.
- D-12 — `<userData>/config.json` keeps non-secret prefs (`mc_username`, `preferred_name`, `provider`, `theme_mode`). API key is **never** in `config.json`.
- D-13 — API key stored via Electron `safeStorage`; persisted as `<userData>/api_key.bin`. Satisfies GUI-01.
- D-14 — Procedural pixel portraits by default, deterministic from `id + name`. Optional image-upload override copied to `<userData>/characters/<id>.png`; missing file → fall back to procedural.

**IPC architecture**
- D-15 — **Three-process Electron:** main ↔ renderer (contextIsolation, no nodeIntegration) ↔ utilityProcess (mineflayer + orchestrator). Mineflayer ONLY in utilityProcess.
- D-16 — One bot at a time. Switching characters stops current utilityProcess (`bot.quit()` graceful) before starting next.
- D-17 — contextBridge in `src/preload/index.ts` exposes typed `RendererApi` (summon, stop, onStatus, onLog, onLan, character CRUD, config get/save, saveApiKey, hasApiKey).
- D-18 — Main spawns `utilityProcess.fork(src/bot/index.js, { stdio: 'pipe' })`, passes merged config (incl. decrypted API key) over `MessagePortMain`. stdout/stderr tee'd to (a) renderer via `onLog`, (b) rolling file at `<userData>/logs/<characterId>-<timestamp>.log`.
- D-19 — Bot lifecycle events: `connected`, `disconnected`, `error`, `chat`, `summon-ready`, `summon-stopped`.

**LAN connectivity**
- D-20 — Refactor `lanDiscovery.js` into `watchLan({ onUpdate, staleMs }) → { stop }`. Existing one-shot `discoverLanPort()` becomes a thin wrapper.
- D-21 — Watcher opens once at app boot in main; lives for whole session; single shared UDP socket on `224.0.2.60:4445` with `reuseAddr: true`.
- D-22 — Pill states: `connected` (≤3000ms since last packet), `not_connected` (>3000ms), `unavailable` (`addMembership` failed).
- D-23 — **No manual override** for LAN state.
- D-24 — Summon-while-disconnected: open LAN modal in Searching mode. On `connected` event → auto-dismiss + proceed. ESC/Cancel aborts pending summon.
- D-25 — Summon hands cached `{port}` to bot; utilityProcess does NOT re-discover LAN.

**Provider picker**
- D-26 — Render all 4 tiles (Anthropic/OpenAI/Google/Local). **Only Anthropic is selectable**; others have "Coming soon" chip + `aria-disabled`.
- D-27 — `provider` persisted as string; only `'anthropic'` valid today.

**Visual design** (D-28..D-36 verbatim from mockup)
- All edges sharp (`border-radius: 0`).
- Color tokens light + dark (warm beige accent light / light blue dark).
- Typography: Noto Sans body, Press Start 2P pixel (sparingly), JetBrains Mono.
- Inputs: borderless 1.5px underline.
- macOS traffic lights: native, top-LEFT (`titleBarStyle: 'hiddenInset'`).
- Theme respects `prefers-color-scheme` first run; user override in `config.json.theme_mode`.
- Sidebar rail icons: Home → MC pixel block → "+" → spacer → Theme → Settings. **No "Sei" wordmark in rail.**
- Loading screen: ~1.6s, recolored via `mask-image`, pulse + 3 dots. Subsequent transitions use 220–280ms fades.
- Step-dots: active 22×6, inactive 6×6.

**Onboarding (5 steps)**
- D-37..D-42 — Welcome → MC username → preferred name → provider picker → API key. "Finish" persists via safeStorage, saves prefs, runs first-launch migration, navigates Home. Re-onboarding from Settings reuses flow.

**Home / character grid**
- D-43..D-45 — "Characters" h1, LAN pill + "+ New". Grid `repeat(auto-fill, minmax(220px, 1fr))` 18px gap. Hover overlays Summon button. AddCard at end.

**Add character (3 steps)**
- D-46..D-48 — Name → Description → Persona prompt. Submit generates id slug, seeds palette, writes JSON, navigates.

**Character page**
- D-49..D-53 — Two-column (320px portrait + 1fr details, 36px gap). Summon CTA uses sparkle icon (NOT play). Delete hidden when `id === 'sui'`. Persona prompt collapsed by default. Logs tab enabled only when this character is the active summon. Buffer cap 5000 lines in renderer; main keeps the rolling file.

**LAN modal**
- D-54..D-57 — 4 numbered steps (verbatim copy locked). Live "Connected/Not connected" indicator in header. "Searching…" row in summon-while-disconnected mode. Auto-dismiss on `connected`. ESC/Cancel aborts pending summon. **No "Mark as connected" button.**

**Settings** D-58 — Account, Appearance, Setup sections.

**Summon flow** D-59 — If LAN green: toast + spawn utilityProcess. If LAN not green: Searching modal. Status row + Logs tab live as IPC events arrive.

**Packaging (PKG-01/02/03)**
- D-60 — electron-builder produces: macOS `.dmg` universal (arm64+x64), Hardened Runtime, signed + notarized; Windows NSIS `.exe` signed with EV cert; Linux AppImage unsigned best-effort.
- D-61 — `@electron/rebuild` in `postinstall`. (Note: no native modules in repo today — see Architectural Map.)
- D-62 — Code-signing certs are **external prerequisites** the user is pursuing (Apple Developer + Windows EV cert). Surface as prereq, not a task.
- D-63 — Auto-update is **out of scope** for this phase.

### Claude's Discretion
- Exact React component hierarchy / file split inside `src/renderer/src/`.
- Animation timings (200/220/240/280ms — match closely; flex if a transition feels off).
- IPC channel names (`bot:summon`, `lan:state`, `chars:list`, etc. — pick consistently).
- Whether to introduce `better-sqlite3` for the character index now or stick with JSON files. **CONTEXT locks JSON files (D-09)**; SQLite can come back if perf/atomicity proves a problem (V2).
- Renderer state management (Zustand / Jotai / plain context). **No Redux.**
- Loading-screen exact duration (~1.6s, but tie to actual ready state if first paint is slower).
- Log-line color tagging algorithm (regex on `[haiku?]` / `[chat->]` etc. — best-effort; clean fallback to plain mono if no match).

### Deferred Ideas (OUT OF SCOPE)
- Concurrent character summons (multiple bots in world at once).
- Movement-LLM (Ollama Qwen) revival — provider tile "Local" stays disabled.
- OpenAI / Google provider clients — visible but not wired.
- Auto-update — electron-updater integration deferred.
- Per-character LLM model override or per-character LAN-port override.
- Theming beyond light/dark (no accent color picker).
- Character export / import / share.
- Discord-style "rich presence."
- Custom server connection (non-LAN).
- Telemetry / crash reporting (Sentry / crashReporter).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description (verbatim from REQUIREMENTS.md) | Research Support |
|----|---------------------------------------------|------------------|
| GUI-01 | Electron app presents a setup form: server IP/port, Anthropic API key (stored in OS keychain via safeStorage), personality fields | UI-SPEC §Onboarding (5 steps) + D-13 safeStorage. **NB: server IP/port collapses to LAN auto-detect (D-20..D-25) — the requirement language is stale.** |
| GUI-02 | Start/Stop button launches and terminates the bot process (Electron utilityProcess) | UI-SPEC CharacterPage Summon CTA + D-15..D-19 IPC contract |
| GUI-03 | Live log viewer displays bot activity, LLM decisions, and errors in real time | UI-SPEC §Logs panel D-53 + IPC log streaming patterns below |
| GUI-04 | Personality form: name, backstory text area, tone preset selector | UI-SPEC §AddCharacterScreen (D-46..D-48). **NB: "tone preset" from REQUIREMENTS is replaced by free-form persona prompt — same intent, evolved schema.** |
| GUI-05 | All user-facing errors include a plain-English explanation and an action hint | UI-SPEC §Plain-English error copy table (9 seeded error classes) |
| PKG-01 | App packages as a bundled .dmg (macOS) and .exe installer (Windows) via electron-builder | electron-builder docs + D-60 |
| PKG-02 | Native modules (better-sqlite3) rebuild correctly for the bundled Electron ABI via @electron/rebuild | @electron/rebuild docs + postinstall hook. **NB: no native modules in repo today — see Architectural Map.** |
| PKG-03 | Packaged builds tested on clean VMs (no dev environment) before each release | Smoke-test matrix in §Packaging Validation |
</phase_requirements>

## Summary

This phase wraps the existing `src/{brain,adapter,cli,registry,index}.js` codebase in a three-process Electron shell (main + preload + renderer + utilityProcess), with a Vite+React+TS launcher driving a single utilityProcess-hosted bot at a time. The UI design contract is locked (UI-SPEC.md, approved 2026-05-08), so this research focuses on **how the Electron infrastructure plumbs together** — not on what the UI looks like.

Three high-value findings shape planning:

1. **The codebase has zero native modules today.** [VERIFIED: `find /Users/ouen/slop/sei/node_modules -name "*.node"` returned empty; no `binding.gyp` files; package.json lists only pure-JS deps (mineflayer, anthropic SDK, zod, mineflayer-pathfinder, mineflayer-pvp, mineflayer-auto-eat).] PKG-02 still requires the `@electron/rebuild` postinstall hook (it's cheap insurance and ROADMAP success criterion item 4 explicitly calls for `better-sqlite3 rebuilt for the bundled Electron ABI`), but ABI mismatch crashes are not a real risk this phase. The **fragile native-module reality is an empty risk** — but the rebuild *infrastructure* must still ship so MEM-V2 can re-enable better-sqlite3 without re-architecting packaging. Plan accordingly: build the postinstall hook + universal arm64/x64 macOS pipeline, and verify it on a clean VM, but don't burn a wave hunting better-sqlite3 ABI bugs that don't exist yet.

2. **safeStorage > keytar.** [VERIFIED: keytar archived/unmaintained since Dec 2022; VS Code migrated; Electron 42 ships safeStorage with platform-specific Keychain/DPAPI/libsecret backends.] D-13 already locks safeStorage, but the planning detail worth surfacing: on Linux without a secret store, safeStorage falls back to **hardcoded plaintext encryption** (detectable via `safeStorage.getSelectedStorageBackend() === 'basic_text'`). Linux is best-effort AppImage per D-60, so we should warn the user in plain English (GUI-05 error map: `KEYCHAIN_FALLBACK_PLAINTEXT`) but not block.

3. **utilityProcess + asar has a known sharp edge.** [VERIFIED: electron/electron#41396 — `utilityProcess.fork()` crashes when given a path *inside* `app.asar`.] The bot entry must be `asarUnpack`-ed (or live outside asar) and resolved via `app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked', 'src/bot/index.js') : path.join(__dirname, '../bot/index.js')`. This is a planning gotcha that would otherwise surface as a packaged-build-only crash — exactly the failure mode PKG-03 (clean VM smoke test) catches.

**Primary recommendation:** Use **electron-vite** (not Electron Forge, not vite-plugin-electron alone) as the build harness. It gives separate Vite configs for main/preload/renderer with TypeScript built in, hot-reload across all three processes, and a documented electron-builder integration. It's the dominant pattern in the React+Electron ecosystem (electron-vite-react template) and matches D-03 (Vite+React+TS) without bespoke config.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Onboarding / character CRUD UI | Renderer | Main (file I/O) | UI lives in renderer; preload exposes `chars:save` invoke; main writes JSON via existing `atomicWrite` |
| API key storage | Main (safeStorage) | — | safeStorage is **main-process-only**. Renderer never sees plaintext; preload exposes `config:save-api-key(plaintext)` and `config:has-api-key()` only. Plaintext crosses to utilityProcess via MessagePortMain (never via renderer). |
| LAN multicast watcher | Main | — | UDP socket lives in main, broadcasts state to renderer via `lan:state`. Long-lived single socket, opened at app ready. |
| Bot supervisor (start/stop/restart) | Main | utilityProcess | Main owns lifecycle; utilityProcess hosts mineflayer + orchestrator + Anthropic SDK |
| Mineflayer + Anthropic LLM loop | utilityProcess | — | **Hard rule (CLAUDE.md):** mineflayer must run in utilityProcess only. Renderer never imports mineflayer-anything. |
| Live log stream → renderer | utilityProcess → main → renderer (3-hop) | — | utilityProcess writes to stdout/stderr (already does this — orchestrator's `console.log` patterns); main tees to (a) IPC `bot:log` events and (b) rolling file in `<userData>/logs/`. |
| Theme application | Renderer (DOM attribute) | Main (persist) | `data-theme="light"|"dark"` on `<html>`; main persists `theme_mode` to `config.json` on toggle. |
| Procedural pixel portrait rendering | Renderer | — | Pure deterministic algorithm (FNV-1a + xorshift); no node APIs needed. Canvas or SVG render in renderer. |
| Packaging (.dmg / .exe / AppImage) | electron-builder (CI / local build) | @electron/rebuild (postinstall) | Single `electron-builder.yml` declaration; postinstall hook ensures native ABI even when no native modules exist today. |
| Code signing | electron-builder + external certs | macOS notarytool / Azure Trusted Signing or EV cert | External prereq per D-62. |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| electron | 42.0.0 | Desktop runtime — main + renderer + utilityProcess | The platform; only choice for D-15 three-process arch. [VERIFIED: `npm view electron version` 2026-05-08] |
| electron-vite | 5.0.0 | Build harness for main/preload/renderer with Vite | Out-of-box TS, hot reload across 3 processes, electron-builder integration. Dominant in 2026 React+Electron docs. [VERIFIED: `npm view electron-vite version` 2026-05-08] |
| vite | 8.0.11 | Renderer bundler | Locked by D-03. [VERIFIED: `npm view vite version`] |
| react | 19.2.6 | Renderer UI library | Locked by D-03. Mockup is React-shaped. [VERIFIED: `npm view react version`] |
| typescript | latest 5.x | Type system across main/preload/renderer/shared | Locked by D-03 — catches IPC contract drift. [ASSUMED current 5.x latest] |
| electron-builder | 26.8.1 | Packaging (.dmg, .exe, AppImage) | Locked by D-04. [VERIFIED: `npm view electron-builder version` 2026-05-08] |
| @electron/rebuild | 4.0.4 | Postinstall native-module ABI rebuild | Locked by D-04 / PKG-02. [VERIFIED: `npm view @electron/rebuild version` 2026-05-08] |
| @electron/notarize | 3.1.1 | macOS notarytool wrapper invoked by electron-builder afterSign | Required when macOS hardened runtime + signed + notarized (D-60). electron-builder ≥24 supports `notarize: true` natively, but explicit afterSign hook gives more control. [VERIFIED: `npm view @electron/notarize version`] |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| @electron-toolkit/preload | 3.0.2 | `electronAPI` helper to safely expose IPC via contextBridge | If we want a turnkey preload shape; otherwise hand-roll |
| @electron-toolkit/utils | 4.0.0 | `is.dev`, `optimizer` shortcuts | Convenience |
| zustand | 5.0.13 | Renderer state management (UI store + data store) | Picked in UI-SPEC Defaults. Smallest API, TS-first, no providers. [VERIFIED: `npm view zustand version`] |
| electron-log | 5.4.3 | Optional: persistent log file with rotation in main | Useful for the rolling file in D-18; alternative is hand-rolled fs.createWriteStream. [VERIFIED] |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| electron-vite | Electron Forge + Vite plugin | Forge is well-supported but heavier and more opinionated; electron-vite has tighter electron-builder integration and a thinner config layer for our case |
| electron-vite | vite-plugin-electron (raw) | More flexible but you wire all three Vite configs by hand — extra maintenance for no benefit |
| safeStorage | keytar | keytar archived since Dec 2022; safeStorage uses the same OS backends without an extra native dep [VERIFIED: freek.dev migration writeup, microsoft/vscode#185677, github.com/CheckerNetwork/desktop#1656] |
| safeStorage | electron-store + hand-rolled crypto | electron-store's encryption was broken in 2018 (jse.li/posts/electron-store-encryption); avoid |
| Zustand | Jotai | Atom granularity adds ceremony for this small app (UI-SPEC Defaults) |
| Zustand | plain React Context | Re-renders too aggressively given the live log stream (UI-SPEC Defaults) |
| Zustand | Redux | **Forbidden** by CONTEXT |
| JSON character index | better-sqlite3 | Locked to JSON by D-09 (V2 escalation if perf becomes a problem) |
| `react-virtuoso` log virtualization | hand-rolled IntersectionObserver windowing | UI-SPEC Defaults picked hand-rolled (~30KB savings) |
| utilityProcess.fork | child_process.fork | utilityProcess is the supported path in Electron ≥22; gives MessagePortMain + service-API integration. child_process.fork inside Electron has historical asar/native-module issues (electron/electron#8727, #6656). |

**Installation:**
```bash
npm install --save-dev electron@42 electron-builder@26 electron-vite@5 vite@8 typescript @electron/rebuild@4 @electron/notarize@3
npm install react@19 react-dom@19 zustand@5
npm install --save-dev @types/react @types/react-dom
# Optional
npm install --save-dev @electron-toolkit/preload @electron-toolkit/utils electron-log
```

## Architecture Patterns

### System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Electron App Process Tree                                               │
│                                                                         │
│  ┌────────────┐                                                         │
│  │   main     │  Owns: BrowserWindow, utilityProcess supervisor,       │
│  │  process   │        LAN watcher (UDP socket), safeStorage,          │
│  │            │        file I/O for characters/config, log rolling     │
│  └─────┬──────┘                                                         │
│        │                                                                │
│        │ ipcMain.handle('chars:*')                                      │
│        │ ipcMain.handle('config:*')                                     │
│        │ webContents.send('lan:state')                                  │
│        │ webContents.send('bot:log') / send('bot:status')               │
│        ▼                                                                │
│  ┌────────────┐    contextBridge (preload, isolated)                   │
│  │  preload   │ ──► exposes typed `window.sei` RendererApi             │
│  │            │     no nodeIntegration in renderer                     │
│  └─────┬──────┘                                                         │
│        ▼                                                                │
│  ┌────────────┐                                                         │
│  │  renderer  │  Vite + React + TS                                     │
│  │  (Chromium)│  - LoadingScreen → Onboarding/Home/Character/Settings  │
│  │            │  - LAN pill subscribes to `lan:state`                  │
│  │            │  - Logs panel subscribes to `bot:log`                  │
│  └────────────┘                                                         │
│                                                                         │
│        ▲                                                                │
│        │ MessagePortMain (config + lifecycle bidir)                    │
│        │ stdio:'pipe' stdout/stderr → main → tee to renderer + file   │
│        │                                                                │
│  ┌─────┴──────┐                                                         │
│  │utilityProc │  Hosts: src/bot/index.js (relocated from src/index.js)│
│  │  (forked)  │  - mineflayer connect + reflex behaviors              │
│  │            │  - LLM orchestrator (Anthropic SDK)                    │
│  │            │  - FSM + action registry + memory layer                │
│  │            │  Receives: { character config, decrypted API key,     │
│  │            │             cached LAN port, paths }                   │
│  │            │  Emits: stdout log lines, parentPort lifecycle msgs   │
│  └────────────┘                                                         │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘

           ▲                                              ▲
           │                                              │
   ┌───────┴──────┐                              ┌────────┴──────┐
   │ <userData>/  │                              │  Anthropic    │
   │  config.json │                              │  Messages API │
   │  api_key.bin │                              │  (HTTPS)      │
   │  characters/ │                              └───────────────┘
   │  memory/<id>/│
   │  logs/<id>/  │                              ┌───────────────┐
   └──────────────┘                              │ Minecraft LAN │
                                                 │ on port 25565+│
                                                 │ (UDP+TCP via  │
                                                 │  mineflayer)  │
                                                 └───────────────┘
   ▲
   │ multicast 224.0.2.60:4445 (UDP, MOTD broadcast every ~1.5s)
   │ — main process LAN watcher receives, parses [AD]port[/AD]
```

### Recommended Project Structure

```
src/
├── main/
│   ├── index.ts              # app.whenReady → BrowserWindow + LAN watcher + IPC
│   ├── botSupervisor.ts      # utilityProcess.fork wrapper, lifecycle, restart-on-crash policy
│   ├── lanWatcher.ts         # watchLan({onUpdate, staleMs}) — refactored from existing lanDiscovery.js
│   ├── characterStore.ts     # JSON CRUD via existing brain/atomicWrite.js (relocated to src/bot/atomicWrite.js)
│   ├── configStore.ts        # config.json read/write
│   ├── apiKeyStore.ts        # safeStorage encrypt/decrypt → api_key.bin
│   ├── ipc.ts                # ipcMain.handle registrations for all channels in shared/ipc.ts
│   ├── logRouter.ts          # tee utilityProcess stdout to renderer + rolling file
│   └── windowChrome.ts       # titleBarStyle, titleBarOverlay platform branching
├── preload/
│   └── index.ts              # contextBridge.exposeInMainWorld('sei', api)
├── renderer/
│   ├── index.html
│   └── src/
│       ├── App.tsx           # router + theme provider + lazy-load boundary
│       ├── main.tsx          # React.createRoot
│       ├── screens/          # LoadingScreen, Onboarding, Home, AddCharacter, CharacterPage, Settings, ComingSoon
│       ├── components/       # Button, TextField, IconRail, MacosWindow, PixelPortrait, LanModal, SummonToast, StepDots, AddCard, LogsPanel, icons.tsx
│       ├── lib/
│       │   ├── ipcClient.ts  # thin wrapper around window.sei with typed return
│       │   ├── theme.ts      # prefers-color-scheme listener + data-theme apply
│       │   ├── stores/       # useUiStore.ts (view/modal/theme), useDataStore.ts (chars/lan/summon/logs)
│       │   ├── tagLog.ts     # pure log-line color tagger (unit-testable)
│       │   └── errors.ts     # error class → plain-English copy map (GUI-05)
│       └── styles/
│           ├── tokens.css    # CSS variables
│           ├── global.css
│           ├── animations.css
│           └── fonts.css     # @font-face for Noto Sans / Press Start 2P / JetBrains Mono
│   └── public/
│       ├── img/              # sei-logo.{svg,png}, sei-logo-small.{svg,png}
│       └── fonts/            # WOFF2s self-hosted (D-05)
├── bot/                      # = old src/{brain,adapter,registry,config,index,cli}/
│   ├── index.js              # utilityProcess entrypoint (relocated from src/index.js)
│   ├── cli/index.js          # `sei` CLI (preserved per D-07)
│   ├── brain/                # orchestrator, loop, fsm, etc.
│   ├── adapter/minecraft/    # mineflayer wiring; lanDiscovery.js stays here as thin one-shot wrapper
│   ├── registry.js
│   └── config.js
└── shared/
    ├── ipc.ts                # RendererApi type + IpcMessage types + IPC channel constants
    ├── characterSchema.ts    # zod schema for character JSON
    └── errorClasses.ts       # union of error class string-literals
```

### Pattern 1: utilityProcess.fork with stdio:'pipe' + MessagePortMain

**What:** Spawn the bot in a Node.js+MessagePort-enabled child process; transfer a port-pair so renderer-driven config (and the decrypted API key) reaches the bot without crossing through the renderer.

**When to use:** Always for the bot in this app — D-15 hard rule.

**Example:**
```ts
// src/main/botSupervisor.ts
// Source: https://www.electronjs.org/docs/latest/api/utility-process (Context7 verified)
import { utilityProcess, MessageChannelMain, app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

export function spawnBot(opts: {
  characterConfig: Character,           // already-merged shape from characterStore + configStore
  decryptedApiKey: string,              // from apiKeyStore
  cachedLanPort: number,                // from lanWatcher
  userDataDir: string,                  // app.getPath('userData')
  onLog: (line: string) => void,        // tee to renderer + rolling file
  onLifecycle: (event: BotLifecycle) => void,
}) {
  // Resolve bot entry path: .asar.unpacked in production
  const botEntry = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'src/bot/index.js')
    : path.join(__dirname, '../bot/index.js');

  const child = utilityProcess.fork(botEntry, [], {
    stdio: 'pipe',                      // REQUIRED for stdout/stderr access (Context7 verified)
    serviceName: `sei-bot-${opts.characterConfig.id}`,
    env: {
      ...process.env,
      SEI_USER_DATA: opts.userDataDir,
      SEI_CHARACTER_ID: opts.characterConfig.id,
    },
  });

  // Open a private channel for config + lifecycle messages
  const { port1, port2 } = new MessageChannelMain();

  child.once('spawn', () => {
    // Transfer port2 to the child; pass config + key on the same message
    child.postMessage({
      type: 'init',
      character: opts.characterConfig,
      apiKey: opts.decryptedApiKey,
      lanPort: opts.cachedLanPort,
    }, [port2]);
  });

  // stdout/stderr stream parsing (Context7 verified — child.stdout is NodeJS.ReadableStream when stdio='pipe')
  const lineSplit = (chunk: Buffer, buffer: { tail: string }, sink: (line: string) => void) => {
    const text = buffer.tail + chunk.toString('utf-8');
    const lines = text.split('\n');
    buffer.tail = lines.pop() ?? '';
    for (const line of lines) if (line) sink(line);
  };
  const stdoutBuf = { tail: '' };
  const stderrBuf = { tail: '' };
  child.stdout?.on('data', (c: Buffer) => lineSplit(c, stdoutBuf, opts.onLog));
  child.stderr?.on('data', (c: Buffer) => lineSplit(c, stderrBuf, opts.onLog));

  port1.on('message', (e) => opts.onLifecycle(e.data as BotLifecycle));
  port1.start();

  child.on('exit', (code) => opts.onLifecycle({ type: 'exit', code }));
  child.on('error', (err) => opts.onLifecycle({ type: 'error', error: String(err) }));

  return {
    pid: child.pid,
    stop: async (timeoutMs = 10_000) => {
      port1.postMessage({ type: 'stop' });
      const exited = await Promise.race([
        new Promise<true>((r) => child.once('exit', () => r(true))),
        new Promise<false>((r) => setTimeout(() => r(false), timeoutMs)),
      ]);
      if (!exited) child.kill();    // hard kill escalation
    },
  };
}
```

The bot side:
```js
// src/bot/index.js — augment existing entrypoint
// Source: https://www.electronjs.org/docs/latest/api/parent-port (Context7 verified)
let initPort;
process.parentPort.once('message', (e) => {
  const [port] = e.ports;             // the transferred port2
  initPort = port;
  initPort.start();
  initPort.on('message', (msg) => {
    if (msg.data?.type === 'init') {
      // existing loadConfig() now receives a pre-merged config object
      bootstrap(msg.data);
    }
    if (msg.data?.type === 'stop') {
      gracefulShutdown();             // bot.quit() then process.exit(0)
    }
  });
});

// Lifecycle emit — replaces console.log of structured events
function emit(type, payload) {
  initPort?.postMessage({ type, ...payload });
}
```

### Pattern 2: contextBridge.exposeInMainWorld + ipcRenderer.invoke

**What:** Renderer never has Node access; preload exposes a typed API. All privileged ops cross via `ipcRenderer.invoke` (request/response) or `ipcRenderer.on` (push events).

**When to use:** Every renderer ↔ main interaction.

**Example:**
```ts
// src/preload/index.ts
// Source: https://www.electronjs.org/docs/latest/api/context-bridge (Context7 verified pattern)
import { contextBridge, ipcRenderer } from 'electron';
import type { RendererApi } from '../shared/ipc';

const api: RendererApi = {
  // request/response
  listCharacters: () => ipcRenderer.invoke('chars:list'),
  getCharacter: (id) => ipcRenderer.invoke('chars:get', id),
  saveCharacter: (c) => ipcRenderer.invoke('chars:save', c),
  deleteCharacter: (id) => ipcRenderer.invoke('chars:delete', id),
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (c) => ipcRenderer.invoke('config:save', c),
  saveApiKey: (plaintext) => ipcRenderer.invoke('config:save-api-key', plaintext),
  hasApiKey: () => ipcRenderer.invoke('config:has-api-key'),
  summon: (id) => ipcRenderer.invoke('bot:summon', id),
  stop: () => ipcRenderer.invoke('bot:stop'),

  // push subscriptions — return Unsubscribe
  onStatus: (cb) => {
    const handler = (_e: unknown, s: BotStatus) => cb(s);
    ipcRenderer.on('bot:status', handler);
    return () => ipcRenderer.off('bot:status', handler);
  },
  onLog: (cb) => {
    const handler = (_e: unknown, entry: LogEntry) => cb(entry);
    ipcRenderer.on('bot:log', handler);
    return () => ipcRenderer.off('bot:log', handler);
  },
  onLan: (cb) => {
    const handler = (_e: unknown, s: LanState) => cb(s);
    ipcRenderer.on('lan:state', handler);
    return () => ipcRenderer.off('lan:state', handler);
  },
};

contextBridge.exposeInMainWorld('sei', api);
```

The window.sei type lives in `src/shared/ipc.ts` and is imported in renderer via a `global.d.ts`:
```ts
// src/renderer/src/global.d.ts
import type { RendererApi } from '../../shared/ipc';
declare global {
  interface Window { sei: RendererApi; }
}
```

### Pattern 3: Long-lived multicast LAN watcher

**What:** Refactor `lanDiscovery.js` from one-shot resolve into an event-emitter that runs for the app's lifetime. Pill state derives from "last packet timestamp."

**When to use:** D-20..D-22.

**Example:**
```js
// src/main/lanWatcher.ts (or src/bot/adapter/minecraft/lanDiscovery.js)
// Source: existing src/adapter/minecraft/lanDiscovery.js + Node.js dgram docs
import dgram from 'node:dgram';

const MC_LAN_GROUP = '224.0.2.60';
const MC_LAN_PORT = 4445;

export function watchLan({ onUpdate, staleMs = 3000 }) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  let lastSeenAt = 0;
  let lastPort = null;
  let lastMotd = '';
  let unavailable = false;
  let staleTimer = null;

  const emit = () => {
    const fresh = lastSeenAt > 0 && (Date.now() - lastSeenAt) <= staleMs;
    if (unavailable) onUpdate({ kind: 'unavailable' });
    else if (fresh) onUpdate({ kind: 'connected', port: lastPort, motd: lastMotd, lastSeenAt });
    else onUpdate({ kind: 'not_connected' });
  };

  const scheduleStale = () => {
    clearTimeout(staleTimer);
    staleTimer = setTimeout(emit, staleMs + 100);
  };

  socket.on('error', () => { unavailable = true; emit(); });
  socket.on('message', (msg) => {
    const text = msg.toString('utf-8');
    const portStr = text.match(/\[AD\](\d{1,5})\[\/AD\]/)?.[1];
    if (!portStr) return;
    const port = Number(portStr);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return;
    lastPort = port;
    lastMotd = text.match(/\[MOTD\](.*?)\[\/MOTD\]/)?.[1] ?? '';
    lastSeenAt = Date.now();
    emit();
    scheduleStale();
  });

  socket.bind(MC_LAN_PORT, () => {
    try { socket.addMembership(MC_LAN_GROUP); }
    catch (err) { unavailable = true; emit(); }
  });

  emit();   // initial state
  return { stop: () => { clearTimeout(staleTimer); try { socket.close(); } catch {} } };
}

// Backward-compat thin wrapper for existing CLI callers
export function discoverLanPort({ timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { stop(); reject(new Error(`No Minecraft LAN broadcast received within ${timeoutMs}ms`)); }, timeoutMs);
    const { stop } = watchLan({ onUpdate: (s) => {
      if (s.kind === 'connected') { clearTimeout(t); stop(); resolve({ port: s.port, motd: s.motd }); }
      if (s.kind === 'unavailable') { clearTimeout(t); stop(); reject(new Error('multicast unavailable')); }
    }});
  });
}
```

### Pattern 4: safeStorage encrypt/decrypt → file

**What:** Encrypt API key with OS keychain-backed key, persist as opaque blob, decrypt on summon (in main, never in renderer).

**Example:**
```ts
// src/main/apiKeyStore.ts
// Source: https://www.electronjs.org/docs/latest/api/safe-storage (Context7 verified)
import { safeStorage, app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';

const keyPath = () => path.join(app.getPath('userData'), 'api_key.bin');

export async function saveApiKey(plaintext: string) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('KEYCHAIN_UNAVAILABLE');
  }
  const buf = safeStorage.encryptString(plaintext);
  await fs.writeFile(keyPath(), buf);                    // atomic-write helper preferred
}

export async function hasApiKey(): Promise<boolean> {
  try { await fs.access(keyPath()); return true; } catch { return false; }
}

export async function loadApiKey(): Promise<string> {
  const buf = await fs.readFile(keyPath());
  return safeStorage.decryptString(buf);                  // throws on KEYCHAIN_LOCKED — map to plain-English
}

export function backendKind() {
  // Linux: returns one of 'kwallet', 'kwallet5', 'kwallet6', 'gnome_libsecret', 'basic_text'
  // basic_text === unprotected → surface a warning to the user
  return safeStorage.getSelectedStorageBackend?.() ?? 'unknown';
}
```

### Anti-Patterns to Avoid

- **`require()`-ing mineflayer in renderer** — violates D-15 + Electron security model. Renderer has `nodeIntegration: false, contextIsolation: true`; even if it didn't, mineflayer brings TCP sockets and `dns` into a sandboxed context.
- **`utilityProcess.fork(path/inside/app.asar)`** — known crash (electron/electron#41396). Either `asarUnpack` the bot tree or resolve via `process.resourcesPath/app.asar.unpacked/...` when `app.isPackaged`.
- **`stdio: 'inherit'` on utilityProcess** — `child.stdout` becomes `null`; you cannot tee logs to renderer + file. Always use `'pipe'` per D-18.
- **Decrypting the API key in renderer** — safeStorage is main-only; even if it weren't, the renderer is a Chromium sandbox with its own attack surface. Pass plaintext only over MessagePortMain to utilityProcess.
- **Synchronous `safeStorage.encryptString` on the hot path** — on macOS/Linux it can block the main thread for keychain prompts. Wrap calls in async helpers and surface "first call may take a moment" UX.
- **Re-discovering LAN inside utilityProcess** — D-25 explicitly hands `{port}` to bot. The 1.5–5s discovery handshake is wasted on every summon and creates two sockets bound to the same port (one in main, one in bot — second `bind` will fail or steal packets from the watcher).
- **Writing inside the app bundle** — D-09. On macOS the bundle is read-only-by-default and signed; any write breaks the signature. Always use `app.getPath('userData')`.
- **Hand-rolled "encryption"** — do not invent. safeStorage is the only correct path. (See electron-store CVE-style writeup at jse.li/posts/electron-store-encryption.)

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Per-platform secret storage | Custom AES with hardcoded key | `electron.safeStorage` | OS keychain-backed; macOS Keychain / Windows DPAPI / Linux libsecret. keytar is unmaintained. |
| Renderer↔node bridge | `nodeIntegration: true` shortcut | `contextBridge` + `ipcRenderer.invoke` | Sandboxed-renderer is the security baseline; nodeIntegration:true is a footgun. |
| Renderer ↔ utilityProcess direct comm | Custom socket / file polling | `MessageChannelMain` + transfer port through main | Designed for exactly this; backed by V8 structured-clone. |
| Native-module ABI rebuild | Manual `node-gyp rebuild` | `@electron/rebuild` (or `electron-builder install-app-deps`) | Discovers Electron version, downloads matching headers, rebuilds in-place. |
| macOS notarization | Custom xcrun shell wrapper | `@electron/notarize` (electron-builder afterSign) | Wraps notarytool with the right entitlement plumbing; staples ticket. |
| Windows code signing | Manual signtool.exe pipeline | electron-builder `win.sign` / Azure Trusted Signing / `@electron/windows-sign` | Handles HSM/Yubikey/Azure-cloud signing without bespoke wiring. |
| Universal macOS binary | Two builds + manual `lipo` | electron-builder `mac.target` `[{target:'dmg', arch:['universal']}]` (or `arch: ['x64', 'arm64']`) | electron-builder + `@electron/universal` glue handle it. |
| Window chrome cross-platform | Hand-fake traffic lights | `BrowserWindow` `titleBarStyle: 'hiddenInset'` (mac) + `frame: false` + `titleBarOverlay` (win) | UI-SPEC explicitly bans rendering fake traffic lights; OS-drawn buttons are the only correct choice. |
| Atomic JSON writes | Plain `fs.writeFile` | Reuse `src/brain/atomicWrite.js` (existing) | Tmp+rename pattern already in repo; locks for free. |
| Log-line virtualization | Big DOM list with `whiteSpace: pre` | Hand-rolled IntersectionObserver + 200-line render window | UI-SPEC Defaults; `react-virtuoso` adds 30KB for fixed-height monospace list. |
| State management | Redux | `zustand` (UI-SPEC pick) | Smaller surface; Redux explicitly forbidden by CONTEXT. |

**Key insight:** Electron in 2026 has officially-maintained primitives for *every* hard piece of this phase (safeStorage, utilityProcess, MessageChannelMain, @electron/rebuild, @electron/notarize, @electron/windows-sign, electron-builder, @electron/universal). Hand-rolling any of them produces less secure, less reliable code. The phase budget should focus on **gluing** these together — not reimplementing them.

## Runtime State Inventory

This phase involves both new code (Electron shell) AND a directory restructure (D-06: relocate `src/{brain,adapter,cli,index,registry,config}.js` under `src/bot/`). The reorganization is a code-only refactor — nothing is *renamed* in a way that breaks runtime state — but I'm including the inventory for completeness because the user data location *also* changes (CWD config.json → `app.getPath('userData')`/config.json).

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | (1) Existing `config.json` at repo root (CLI's CWD-anchored config) — production users have this in their dev clone; packaged users start fresh. (2) `memory/OWNER.md`, `memory/AFFECT.md`, `memory/DIARY.md` from Phase 3 at repo root. | First-launch migration in main: if `<userData>/config.json` is absent AND the CLI is detected to have a `~/.sei/config.json` or `cwd/config.json`, prompt-or-migrate. **CONTEXT (D-10) only specifies legacy-persona-field migration; cross-machine migration is out of scope** — packaged users go through onboarding fresh. Existing CLI users keep using CLI from their dev clone (`<cwd>/config.json` and `<cwd>/memory/`). The Electron app reads from `<userData>` only. |
| Live service config | None. No external service has a "Sei" name registered. | None. |
| OS-registered state | None today. After packaging: macOS bundle id `com.sei.app` (or chosen reverse-DNS), Windows AppUserModelID. These are *new* registrations the installer creates. | Plan must lock the bundle ID / appId in `electron-builder.yml` (it appears in safeStorage Keychain entries, in launchpad / Start menu, in update channels later). Once shipped, **changing it strands all existing safeStorage entries** — pick once, document. |
| Secrets/env vars | (1) `ANTHROPIC_API_KEY` env-var fallback in current loadConfig (per STATE.md). The Electron app does NOT read env-vars; it uses safeStorage exclusively. The CLI keeps env-var fallback. (2) macOS notarization needs `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` (or App Store Connect API key) — CI/build-time only. (3) Windows signing needs cert credentials (token PIN for HSM, or Azure tenant/client/secret for Trusted Signing). | (1) None — Electron + CLI paths are independent. (2) Document required CI secrets; user has cert applications in flight (STATE.md Todos). (3) Same. |
| Build artifacts / installed packages | (1) `package.json` — needs new `electron`, `main: dist/main/index.js` (or wherever electron-vite outputs), `bin: { sei: "src/bot/cli/index.js" }` updated path, new `scripts.electron`, `scripts.build`, `scripts.dist`. (2) `npm postinstall` to be added — `@electron/rebuild` or `electron-builder install-app-deps`. (3) `node_modules/.bin/electron` after install. (4) Output `dist/` and `release/` (or `out/`) directories — add to `.gitignore`. | All require code edits in package.json + new electron-builder.yml. Migration: existing `npm install` users post-merge must `rm -rf node_modules && npm install` to pick up postinstall hook. |

**Nothing found in category for "Live service config" and "OS-registered state":** Verified — Sei is currently a CLI-only project with no external service registrations and no installed app artifacts on user machines.

## Common Pitfalls

### Pitfall 1: utilityProcess.fork() crashes when given an asar-internal path

**What goes wrong:** Packaged build launches, app window appears, but Summon click silently does nothing (or crashes the bot host). Dev build works fine.
**Why it happens:** electron/electron#41396 — `utilityProcess.fork()` cannot resolve a path *inside* `app.asar`. Bundler typically packages `src/bot/index.js` *into* the asar.
**How to avoid:** Add `asarUnpack` for the bot directory in `electron-builder.yml`:
```yml
asar: true
asarUnpack:
  - "src/bot/**/*"
  - "src/bot/cli/**/*"   # CLI keeps shipping per D-07
```
And resolve the entry path branch on `app.isPackaged`:
```ts
const botEntry = app.isPackaged
  ? path.join(process.resourcesPath, 'app.asar.unpacked', 'src/bot/index.js')
  : path.join(__dirname, '../bot/index.js');
```
**Warning signs:** PKG-03 clean-VM smoke test catches this on first run. Also `child.on('error')` will fire — log the error, do not swallow.

### Pitfall 2: stdio:'inherit' (the default) makes child.stdout null

**What goes wrong:** Logs panel never receives lines. `child.stdout?.on('data', ...)` silently no-ops because `child.stdout === null`.
**Why it happens:** Default `stdio` is `'inherit'` per Electron docs; `child.stdout` is only a stream when `stdio === 'pipe'`.
**How to avoid:** Always pass `{ stdio: 'pipe' }` to `utilityProcess.fork()`. Also handle `child.stderr` (mineflayer + Anthropic SDK occasionally write there).
**Warning signs:** Logs panel renders but stays empty even after summon. Add a sanity log line ("[bot:supervisor] forked pid=%d") in main on `'spawn'` event so you can confirm the supervisor is wired.

### Pitfall 3: safeStorage backend silently falls back to plaintext on Linux

**What goes wrong:** User on Linux without kwallet/libsecret has their API key written to `<userData>/api_key.bin` "encrypted" with a hardcoded key — equivalent to plaintext.
**Why it happens:** Electron docs explicitly state this fallback. `safeStorage.getSelectedStorageBackend() === 'basic_text'` signals the unsafe state.
**How to avoid:** On app boot, check `safeStorage.getSelectedStorageBackend()`; if `basic_text`, surface a one-time warning toast (UI-SPEC error class `KEYCHAIN_FALLBACK_PLAINTEXT`): "Your system has no secret store. Sei will save your API key but it won't be hardware-protected." Linux is best-effort per D-60 — don't block.
**Warning signs:** Linux build; no kwallet / no gnome-keyring. AppImage smoke-test on a clean Ubuntu/Fedora VM should hit this.

### Pitfall 4: postinstall hook runs in CI even when not building Electron

**What goes wrong:** CI installs deps for the CLI smoke test; postinstall tries to rebuild against bundled Electron headers; CI doesn't have Electron set up; `npm install` fails.
**Why it happens:** `"postinstall": "@electron/rebuild"` runs unconditionally. Electron must be installed (it is — devDep), and rebuild must find native modules to rebuild (none today, so it's a no-op — but if `npm install --omit=optional` strips `electron` it errors).
**How to avoid:** Use `electron-builder install-app-deps` (only rebuilds when there *are* native modules in `dependencies`) instead of `@electron/rebuild` directly. Today this is a no-op (zero native modules) — exactly what we want until MEM-V2 brings better-sqlite3 back.
**Warning signs:** CI green-light pre-merge but failing on first install after merge. Test `rm -rf node_modules && npm install` locally before pushing.

### Pitfall 5: BrowserWindow created before app.whenReady() / utilityProcess.fork before ready

**What goes wrong:** App refuses to launch with no clear error.
**Why it happens:** Electron docs: `utilityProcess.fork can only be called after the 'ready' event has been emitted on App.` Same for `BrowserWindow`.
**How to avoid:** All app setup behind `await app.whenReady()`.
**Warning signs:** `Error: BrowserWindow can't be used before app is ready` or `Error: utilityProcess.fork can only be called after app is ready`. Easy to catch in dev.

### Pitfall 6: Multicast socket binding conflicts when LAN watcher + bot both call addMembership

**What goes wrong:** Either watcher or bot misses LAN broadcasts; or one of them throws `EADDRINUSE`.
**Why it happens:** Both the main-process watcher (D-21) and the bot's existing `discoverLanPort` could try to bind to `224.0.2.60:4445`. With `reuseAddr: true` they coexist on most systems, but kernel multicast routing depends on which socket joined the group.
**How to avoid:** D-25 already nails this — the bot should NEVER re-discover LAN. Verify by grepping for `discoverLanPort` calls in `src/bot/` after the relocation; the only remaining caller should be the CLI (which runs without the GUI's watcher).
**Warning signs:** Pill stays green but bot can't connect; or pill flickers. Pull `lsof -i UDP:4445` to count open sockets.

### Pitfall 7: Renderer log-stream firehose stalls main↔renderer IPC

**What goes wrong:** During heavy bot iteration (Haiku verbose mode), bot writes ~20 lines/second; main forwards via `webContents.send('bot:log', line)`; renderer can't keep up; main's IPC queue backs up; status events queue behind log events.
**Why it happens:** Electron IPC has no built-in backpressure. Each `webContents.send` queues a structured-clone copy.
**How to avoid:**
- **Batch:** Coalesce log lines in main — `setInterval(flush, 50ms)` sends `bot:log:batch` with up to N lines (e.g., 100). One IPC call instead of 100.
- **Drop-on-pressure:** If batch length > 1000, keep newest 1000 + sentinel `{ dropped: count }`. Log panel shows "(N lines dropped due to backpressure)".
- **Separate channels:** `bot:log` (high-volume) vs `bot:status` (lifecycle, low-volume). Status events never starve.
- The rolling file in `<userData>/logs/` is the source of truth; renderer is best-effort.
**Warning signs:** Renderer feels laggy; `webContents` warnings about queue length. Heavy verbose-mode chat-log generation is a good stress test.

### Pitfall 8: Code signing identity mismatch on macOS universal build

**What goes wrong:** Build succeeds; user double-clicks .dmg; macOS Gatekeeper says "app is damaged."
**Why it happens:** Universal binary signing requires the `Developer ID Application: <name>` identity (NOT the Mac App Store identity). electron-builder auto-detects but can pick the wrong one if both are in the keychain.
**How to avoid:** Pin identity in `electron-builder.yml`:
```yml
mac:
  identity: "Developer ID Application: <Name> (TEAM_ID)"
  hardenedRuntime: true
  gatekeeperAssess: false
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.plist
  notarize: true             # uses APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD env vars
```
**Warning signs:** Builds succeed locally on dev machine that has the cert; CI fails with `Gatekeeper assessment failed`. Always smoke-test the `.dmg` on a clean macOS VM (PKG-03).

### Pitfall 9: Window chrome differs cross-platform; mockup assumes macOS

**What goes wrong:** On Windows, the user sees a bare frameless window with no min/max/close buttons. On Linux, weird chrome.
**Why it happens:** D-32 says "traffic lights top-LEFT (matches macOS native)." UI-SPEC §MacosWindow already addresses this: macOS uses `titleBarStyle: 'hiddenInset'`; Windows/Linux use `frame: false` + `titleBarOverlay`.
**How to avoid:** Implement the platform branch in `src/main/windowChrome.ts` (UI-SPEC pattern). Test all three platforms in PKG-03 smoke.
**Warning signs:** Windows users can't close the window. Should be obvious in clean-VM smoke.

## Code Examples

Verified patterns from official sources:

### Example 1: utilityProcess fork with stdio:pipe + MessagePort (Context7)

See Pattern 1 above. Source: https://www.electronjs.org/docs/latest/api/utility-process

### Example 2: contextBridge expose typed API

See Pattern 2 above. Source: https://www.electronjs.org/docs/latest/api/context-bridge

### Example 3: electron-builder.yml — universal macOS + signed Windows + AppImage

```yml
# electron-builder.yml
# Source: https://www.electron.build/configuration.html
appId: com.sei.app                        # LOCK FIRST RELEASE — drives Keychain entries
productName: Sei
directories:
  output: release
  buildResources: build
files:
  - dist/**/*
  - package.json
  - "!**/node_modules/*/{test,tests,__tests__,*.md}"
asar: true
asarUnpack:
  - "src/bot/**/*"

mac:
  category: public.app-category.games
  target:
    - target: dmg
      arch: [universal]
  hardenedRuntime: true
  gatekeeperAssess: false
  identity: "Developer ID Application: <Name> (TEAM_ID)"
  notarize: true
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.plist

dmg:
  sign: false                              # Default since electron-builder 20.43.0
  contents:
    - x: 410
      y: 220
      type: link
      path: /Applications
    - x: 130
      y: 220
      type: file

win:
  target:
    - target: nsis
      arch: [x64]
  # Pick ONE signing path based on the cert the user obtained:
  # Option A: EV cert on hardware token / Yubikey
  signtoolOptions:
    sign: "./build/sign.js"                # Custom signer using @electron/windows-sign or signtool
  # Option B: Azure Trusted Signing (cheapest in 2026; requires US/CA org or individual)
  # azureSignOptions:
  #   endpoint: https://eus.codesigning.azure.net/
  #   codeSigningAccountName: <name>
  #   certificateProfileName: <name>

nsis:
  oneClick: false                          # show Welcome / Choose Path
  perMachine: false                        # per-user install — no admin prompt
  allowToChangeInstallationDirectory: true

linux:
  target:
    - AppImage
  category: Game

# DO NOT add publish: { provider: github } yet — auto-update is deferred (D-63)
```

### Example 4: build/entitlements.mac.plist for hardened runtime

```xml
<!-- Source: https://www.electronjs.org/docs/latest/tutorial/code-signing -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key>             <!-- V8 -->
  <true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
  <key>com.apple.security.network.client</key>           <!-- Anthropic + LAN connect -->
  <true/>
  <key>com.apple.security.network.server</key>           <!-- multicast LAN watcher -->
  <true/>
</dict>
</plist>
```

### Example 5: package.json scripts shape

```json
{
  "main": "dist/main/index.js",
  "bin": {
    "sei": "src/bot/cli/index.js"
  },
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "preview": "electron-vite preview",
    "start": "electron-vite preview",
    "dist": "electron-vite build && electron-builder",
    "dist:mac": "electron-vite build && electron-builder --mac",
    "dist:win": "electron-vite build && electron-builder --win",
    "dist:linux": "electron-vite build && electron-builder --linux",
    "postinstall": "electron-builder install-app-deps",
    "sei": "node src/bot/cli/index.js"
  }
}
```

### Example 6: Reduced-motion-respecting log streaming with batching (renderer side)

```ts
// src/renderer/src/lib/stores/useDataStore.ts (zustand)
// Pattern: bounded ring buffer + batched setState
const MAX_LINES = 5000;

interface LogState {
  lines: LogEntry[];
  appendBatch: (batch: LogEntry[]) => void;
  clear: () => void;
}

export const useLogStore = create<LogState>((set) => ({
  lines: [],
  appendBatch: (batch) => set((s) => {
    const next = s.lines.concat(batch);
    return { lines: next.length > MAX_LINES ? next.slice(-MAX_LINES) : next };
  }),
  clear: () => set({ lines: [] }),
}));

// In React mount:
useEffect(() => {
  return window.sei.onLog((entry) => useLogStore.getState().appendBatch([entry]));
}, []);
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `child_process.fork()` for headless work | `utilityProcess.fork()` | Electron 22 (Nov 2022) | utilityProcess gives MessagePort transfer + Chromium service-API integration; child_process.fork has historical issues inside packaged Electron apps (electron/electron#8727) |
| `keytar` for OS keychain | `electron.safeStorage` | Electron 12 stable; keytar archived Dec 2022 | safeStorage is bundled, no extra native dep, no extra ABI rebuild burden. VS Code migrated. |
| `electron-rebuild` (legacy) | `@electron/rebuild` (v3+) | Renamed/migrated 2022 | Same tool; new package name. Use `@electron/rebuild` 4.x. |
| `electron-notarize` (legacy) | `@electron/notarize` | Renamed | Wraps `notarytool` (the modern Apple binary; `altool` is deprecated as of Nov 2023). |
| `altool` for notarization | `notarytool` | Apple deprecated `altool` Nov 2023 | electron-builder ≥24 uses `notarytool` automatically when `notarize: true`. |
| Windows EV cert on USB dongle | Azure Trusted Signing or @electron/windows-sign with HSM | Microsoft mandate June 2023 + Azure Trusted Signing GA 2024-2025 | Cheaper for new orgs; works in CI without hardware. EV certs still work but bound to physical token. |
| `BrowserWindow.titleBarStyle: 'customButtonsOnHover'` | `'hiddenInset'` (mac) + `titleBarOverlay` (win) | Electron 16+ titleBarOverlay GA | Native chrome on both platforms; no fake-buttons drift. |
| Single-architecture macOS build (x64-only) | Universal arm64+x64 via `@electron/universal` | Apple Silicon 2020-2024 transition | Required for App Store + smooth M-series UX. |

**Deprecated/outdated:**
- `keytar` — unmaintained since Dec 2022. Use `safeStorage`.
- `altool` — deprecated by Apple Nov 2023. Use `notarytool` (electron-builder handles internally).
- `electron-rebuild` (the old package) — superseded by `@electron/rebuild`.
- `electron-store` 6.x with `encryptionKey` option — encryption was broken (jse.li/posts/electron-store-encryption); newer versions improved but use `safeStorage` directly for secrets.
- `nodeIntegration: true` + `contextIsolation: false` — security anti-pattern, will be removed in future Electron major.

## Project Constraints (from CLAUDE.md)

These directives override all research recommendations and must be honored in plans:

1. **Three-process Electron is mandatory.** Mineflayer must run in utilityProcess only. Renderer must have `contextIsolation: true`. (Not negotiable; D-15 enforces.)
2. **Closed action registry.** LLM calls Zod-typed actions, single Haiku call combines reasoning + dispatch. Phase 4 does NOT touch the LLM loop — it just hosts the existing one.
3. **Event-sourced FSM with priority queue and AbortController.** Already in place from Phases 1-3.1; phase 4 wires it inside utilityProcess unchanged.
4. **LLM-directed memory compaction.** Already in place from Phase 3; Phase 4 just persists `<userData>/memory/<characterId>/` instead of `<cwd>/memory/`.
5. **Every external call has a timeout.** Phase 4 adds two new external boundaries: (a) IPC `summon()` resolves within 30s or rejects with `BOT_START_TIMEOUT`; (b) IPC `stop()` resolves within 10s or escalates to hard kill (CONTEXT D-codes 17, 18 imply this; existing pathfinder/Anthropic timeouts inside utilityProcess remain unchanged).
6. **Native ABI mismatch → `@electron/rebuild` in postinstall, test packaged builds on clean VMs.** Mandatory per CLAUDE.md "Critical Pitfalls."
7. **macOS screen recording → optional, degrade gracefully.** Not in scope this phase (Phase 4 doesn't touch screenshots; v2 Vision feature only).
8. **Pathfinder silent hangs → wrap every call with wall-clock timeout.** Already wrapped in utilityProcess code; phase 4 doesn't change.
9. **Single-layer iteration runaway → iteration_cap (default 20).** Already enforced; phase 4 doesn't change.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | electron-vite, electron-builder | ✓ (assumed; existing project uses node) | ≥20 LTS expected by Electron 42 | — |
| npm | install pipeline | ✓ | — | — |
| electron CLI | dev launch | ✗ (not installed yet) | — | `npm install --save-dev electron@42` |
| electron-vite | dev launch | ✗ (not installed yet) | — | `npm install --save-dev electron-vite` |
| electron-builder | packaging | ✗ (not installed yet) | — | `npm install --save-dev electron-builder` |
| @electron/rebuild | postinstall | ✗ (not installed yet) | — | `npm install --save-dev @electron/rebuild` |
| @electron/notarize | macOS notarize | ✗ (not installed yet) | — | `npm install --save-dev @electron/notarize` |
| Apple Developer cert | macOS .dmg signing | ✗ (in progress per STATE.md Todos) | — | Defer signed macOS build to a later release; ship unsigned .dmg as a stop-gap with Gatekeeper warning |
| Apple App-Specific Password OR App Store Connect API key | macOS notarization | ✗ (depends on Apple Developer) | — | Same as above |
| Windows EV cert OR Azure Trusted Signing account | Windows .exe signing | ✗ (in progress per STATE.md Todos) | — | Ship unsigned NSIS installer with SmartScreen warning; users click "More info → Run anyway" |
| macOS clean VM (parallels/utm/cloud) | PKG-03 smoke test | ? (user-supplied) | — | Skip macOS clean-VM test, only smoke on dev machine — accept the risk |
| Windows clean VM | PKG-03 smoke test | ? (user-supplied) | — | Same |
| Linux clean VM (Ubuntu LTS or Fedora) | AppImage smoke (best-effort) | ? (user-supplied) | — | Skip; AppImage is best-effort per D-60 |

**Missing dependencies with no fallback:**
- None at the dev level. All npm packages are installable.

**Missing dependencies with fallback:**
- Code-signing certs — degraded ship without signing. Plan must surface "signing prereq blocks shipping a release-quality build" but the engineering can complete and verify in unsigned form.
- Clean VMs — PKG-03 explicitly requires them. If user can't provision, surface as a release blocker; do not silently skip.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The phase deliberately ships PKG-02 (`@electron/rebuild` postinstall) even though zero native modules exist today, because MEM-V2 will reintroduce better-sqlite3 | Summary, Pattern §rebuild | LOW — postinstall hook is cheap; verifying it works without modules to rebuild is a quick smoke check |
| A2 | The 30-second `summon()` timeout / 10-second `stop()` timeout values are sensible defaults | Pitfall 1 / Project Constraints §5 | LOW — easy to tune; no decision is locked downstream |
| A3 | `app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked', 'src/bot/index.js') : path.join(__dirname, '../bot/index.js')` is the correct path resolution after electron-vite's build (which outputs to `dist/main/index.js`) | Pattern 1 | MEDIUM — electron-vite's exact output layout may differ; PKG-03 clean-VM smoke catches this |
| A4 | electron-vite 5.x is the leading 2026 React+Electron build harness | Standard Stack | LOW — Electron Forge is also viable; switching is a script-level change, not architectural |
| A5 | TypeScript 5.x latest is fine; existing JS in `src/bot/` does not need to convert to TS this phase | Standard Stack | LOW — TS is locked for renderer/main/preload only by D-03; bot stays JS |
| A6 | Anthropic identity for macOS signing is `Developer ID Application` (not Mac App Store / Distribution) | Pitfall 8 | LOW — only valid path for direct .dmg distribution outside MAS |
| A7 | electron-builder ≥26 supports `mac.notarize: true` natively without explicit `afterSign` hook | Code Examples §3 | MEDIUM — should verify against electron-builder 26.x release notes; if not, add `afterSign: build/notarize.js` script |
| A8 | macOS bundle ID `com.sei.app` is acceptable / available; user has not yet picked one | Runtime State Inventory | MEDIUM — once shipped, changing this strands all safeStorage entries. **User decision needed before first signed release.** |
| A9 | `@electron/windows-sign` or Azure Trusted Signing is the right Windows path for 2026 | Standard Stack / State of the Art | MEDIUM — depends on which cert path the user pursues; plan should branch on cert type at packaging task |
| A10 | The existing `src/brain/atomicWrite.js` is reusable as-is for character JSON writes (mentioned in CONTEXT) | Architecture / project structure | LOW — verified by grep; module is small and lift-and-shift |
| A11 | Cross-machine migration from CLI users' `~/.sei/` or `cwd/config.json` to packaged-app `<userData>/` is OUT of scope | Runtime State Inventory | LOW — CLI keeps shipping per D-07; users who already use CLI keep using it from their dev clone |

**Items A8 and A9 require user confirmation before first signed release.** Specifically:
- A8 (bundle ID) — surface in discuss-phase or plan-phase and lock before any signed build.
- A9 (Windows cert path) — depends on which cert the user actually obtains; the plan should have a packaging task with two variants (EV-cert-on-token vs Azure-Trusted-Signing) and pick at execution time.

## Resolved During Plan-Phase (2026-05-08)

- **Q1 (bundle ID): DEFERRED → [BLOCKING] task before first signed build.**
  Planner MUST insert a `[BLOCKING]` "lock identifiers" task that runs after packaging config is written but before `npm run dist:mac` ever executes. User picks the reverse-DNS form (`gg.sei.app` / `studio.sei.app` / `bot.sei.app`) when domain is registered. Use a placeholder like `app.sei.placeholder` in `electron-builder.yml` `appId` until then; mark with a `# TODO(lock-before-signing)` comment.
- **Q2 (Windows signing): SHIP UNSIGNED v1.**
  No `signtoolOptions` / `azureSignOptions` in `electron-builder.yml`. Windows users see SmartScreen "unknown publisher" warning on first install — accepted UX for v1. Plan must document this in release notes and flag a future phase for signing once company is formed. NSIS `.exe` output remains required.
- **Q3 (CI build pipeline): LOCAL-ONLY for v1.** `npm run dist:mac` / `dist:win` / `dist:linux` documented as the release procedure.
- **Q4 (CLI user data migration): TREAT AS FRESH.** Per Runtime State Inventory; document in release notes.
- **Q5 (Logs panel persistence): STORE-LEVEL SUBSCRIPTION.** Logs ring buffer always-mounted at the data-store level; panel is a view onto it. Navigation does not drop lines.
- **Q6 (postinstall hook): `electron-builder install-app-deps`.** Same end behavior as `@electron/rebuild` but graceful when `dependencies` has zero native modules (current state of repo).

---

## Open Questions

1. **What is the canonical macOS bundle ID / Windows AppUserModelID?**
   - What we know: STATE.md "Sei = framework / character = Sui rebrand" landed; product name is "Sei."
   - What's unclear: Reverse-DNS form. `com.sei.app`? `com.<vendor>.sei`? User's domain unknown.
   - Recommendation: Surface in plan-checker review or plan a "lock identifiers" task before any signed build. Once shipped, **changing it strands all existing users' safeStorage entries** — pick once.

2. **Which Windows code-signing path is the user pursuing — EV cert on token, or Azure Trusted Signing?**
   - What we know: STATE.md lists "start Apple Developer / Windows EV cert applications" as a parallel todo.
   - What's unclear: EV vs Azure. Different config blocks in electron-builder.yml.
   - Recommendation: Plan should have a single packaging task with conditional branches; user picks cert path before that task executes.

3. **Should there be CI / release infrastructure (GitHub Actions building signed artifacts on tag)?**
   - What we know: ROADMAP success criterion 5 says "Packaged builds validated on clean VMs."
   - What's unclear: Manual local builds vs automated. Auto-update is deferred (D-63), so CI publish flow is not blocking.
   - Recommendation: Plan as local-build-only for v1.0; CI is V2 work. Document `npm run dist:mac` / `dist:win` / `dist:linux` as the release procedure.

4. **What is the migration story for in-flight CLI users with existing `cwd/config.json` and `cwd/memory/`?**
   - What we know: CLI keeps shipping (D-07). D-10 covers legacy `persona` field migration on first Electron launch.
   - What's unclear: Whether CLI users' existing data should be auto-detected from `cwd/` and migrated to `<userData>/` on first Electron launch, or whether they're treated as fresh.
   - Recommendation: Treat as fresh per Runtime State Inventory. CLI users continue using CLI from dev clone; if they want to switch to GUI, they re-onboard. Document this in release notes.

5. **Should the Logs panel persist across screen navigation, or only render while CharacterPage > Logs tab is active?**
   - What we know: UI-SPEC D-53 says "Tab is only enabled when this character is the active summon."
   - What's unclear: Mounting/unmounting behavior of the panel React component during navigation.
   - Recommendation: Logs subscription happens at the data-store level (not the panel component); panel is a view onto an always-mounted ring buffer. This way navigating away doesn't drop lines.

6. **Should `@electron/rebuild` postinstall hook be the actual `@electron/rebuild` binary, or `electron-builder install-app-deps`?**
   - What we know: D-04 says "@electron/rebuild in postinstall."
   - What's unclear: `electron-builder install-app-deps` is a thin wrapper that's gentler when no native modules exist.
   - Recommendation: Use `electron-builder install-app-deps` for the no-native-modules-today reality. Same end behavior; more graceful when `dependencies` has zero native modules. Document in plan as the chosen postinstall command.

## Sources

### Primary (HIGH confidence)
- **Context7** `/websites/electronjs` — Topics fetched: `utilityProcess.fork`, `MessageChannelMain`, `MessagePortMain`, `safeStorage.encryptString/decryptString`, `safeStorage` overview, `parentPort`, `ipcRenderer.postMessage`, `webContents` MessageChannel transfer.
- https://www.electronjs.org/docs/latest/api/utility-process — utilityProcess API surface, stdio configuration, stdout stream contract
- https://www.electronjs.org/docs/latest/api/safe-storage — platform-specific backends (Keychain/DPAPI/libsecret/basic_text)
- https://www.electronjs.org/docs/latest/api/message-channel-main — MessageChannelMain + MessagePortMain
- https://www.electronjs.org/docs/latest/api/parent-port — utilityProcess child-side messaging
- https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules/ — @electron/rebuild rationale
- https://www.electronjs.org/docs/latest/tutorial/code-signing — code signing macOS + Windows overview
- https://www.electron.build/configuration.html — electron-builder common configuration
- https://www.electron.build/code-signing-win.html — Windows signing options (EV / @electron/windows-sign / Azure)
- https://www.electron.build/mac.html — macOS targets (universal, dmg, notarize)
- https://github.com/electron/notarize — @electron/notarize current docs
- https://github.com/electron/rebuild — @electron/rebuild current docs
- https://electron-vite.org/ — electron-vite 5.x docs (build harness)
- https://electron-vite.org/guide/distribution — electron-builder integration

### Secondary (MEDIUM confidence)
- npm registry verifications (2026-05-08): `electron@42.0.0`, `electron-builder@26.8.1`, `@electron/rebuild@4.0.4`, `@electron/notarize@3.1.1`, `vite@8.0.11`, `react@19.2.6`, `electron-vite@5.0.0`, `zustand@5.0.13`, `keytar@7.9.0`, `@electron-toolkit/preload@3.0.2`, `@electron-toolkit/utils@4.0.0`, `electron-log@5.4.3`, `better-sqlite3@12.9.0`
- https://github.com/electron/electron/issues/41396 — utilityProcess + asar path crash (verified known issue)
- https://github.com/electron/electron/issues/8727 — child_process.fork inside Electron with native modules (historical context)
- https://github.com/electron/electron/issues/36411 — utilityProcess output sometimes missing (edge cases)
- https://github.com/electron-userland/electron-builder/issues/8276 — Azure Trusted Signing support tracking
- https://github.com/microsoft/vscode/issues/185677 — VS Code's keytar→safeStorage migration (real-world precedent)
- https://github.com/CheckerNetwork/desktop/issues/1656 — Another keytar→safeStorage migration
- https://freek.dev/2103-replacing-keytar-with-electrons-safestorage-in-ray — keytar→safeStorage walkthrough
- https://blog.jse.li/posts/electron-store-encryption/ — electron-store encryption defects (justifies safeStorage)

### Tertiary (LOW confidence — verified or surfaced as ASSUMED in Assumptions Log)
- https://medium.com/@andreialex.patru/electron-electron-builder-node-sqlite3-and-universal-mac-builds-x64-and-arm64-fb7c50e1fff4 — universal mac builds + sqlite3 (community writeup)
- https://www.danielcorin.com/posts/2024/challenges-building-an-electron-app/ — challenges building an Electron app (asarUnpack patterns)
- https://medium.com/@paul.pietzko/build-a-desktop-app-with-electron-react-vite-and-typescript-a928944996ea — Electron+React+Vite+TS (Mar 2026, recent)
- https://hendrik-erz.de/post/code-signing-with-azure-trusted-signing — Azure Trusted Signing GitHub Actions

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — every package version verified against npm registry on 2026-05-08; deprecated alternatives identified.
- Architecture: HIGH on Electron primitives (Context7 verified); HIGH on existing-codebase shape (file inspection); HIGH on UI-SPEC contract (already approved).
- Pitfalls: HIGH — each pitfall has a verified GitHub issue or official-docs citation behind it.
- Code-signing details: MEDIUM — depends on user-supplied cert details (A8, A9). Plan must branch.
- macOS universal build: MEDIUM — well-documented but no native modules to break, so the test surface is small. Real test is PKG-03 clean-VM smoke.
- Filesystem layout post-electron-vite-build: MEDIUM — exact output paths (`dist/main/index.js` etc.) need verification on first build. Surfaced as A3.

**Research date:** 2026-05-08
**Valid until:** ~2026-06-07 (30 days for stable Electron / electron-builder ecosystem; revisit if Electron 43 ships before phase execution)

## RESEARCH COMPLETE
