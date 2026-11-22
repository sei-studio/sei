# AGENTS.md

Instructions for agent sessions in this repo. `CLAUDE.md` is the deep
architecture and decision record (~4k lines); read the section you need there
instead of re-deriving it. `docs/design/` holds the durable design docs, and
`docs/agents/` holds one playbook per subsystem (build/release, playtime,
continuity, game adapters, seilink host, chess, draw, connect4, battleship, ...): open the matching
file before touching that area.

## Commands

Node **22** and npm are required (README, CI). `npm install` once; its
`postinstall` rebuilds native modules against Electron's ABI and needs a
distutils-capable Python (CI pins 3.11) for the headless-gl build.

| what | command |
| --- | --- |
| app only, no DevTools or viewer | `npm run dev` |
| app + browser viewer (logs, prompt editor) + DevTools | `npm run dev:tools` |
| plain electron-vite dev | `npm run dev:bare` |
| typecheck (both TS projects) | `npm run typecheck` |
| whole test suite | `npm test` |
| one file / one test | `npx vitest run <path>` / add `-t "name"` |
| unbundled ESM link check (2s, also inside `npm test`) | `npm run check:esm` |
| build app around `dist/` (not installer) | `npm run build` |
| installer | `npm run dist`, `npm run dist:win`, `npm run dist:mac`, `npm run dist:linux` |
| validate game-pack workspaces + prune globs | `npm run check:packs` |
| build one game pack | `node scripts/build-game-pack.mjs <minecraft\|stardew\|dontstarve> [--skip-build] [--out dir]` |

- `npm run dev` is **not** raw electron-vite: `scripts/dev-viewer.mjs` wraps it
  and serves the viewer at `http://localhost:7077` only under `--tools`.
- CI order is `check:esm` → typecheck → test → `check:packs` → build the two
  platform-neutral packs (Don't Starve, Stardew). `check:packs` dry-runs only
  minecraft and stardew. Run `npm run typecheck` before `npm test` locally too
  (see Gotchas).
- `check:esm` (`scripts/check-esm-links.mjs`) exists because `src/bot/**` and
  the vendored `file:` deps ship **unbundled**: a named import the target does
  not export is a link-time SyntaxError that kills the bot at load, and vitest
  cannot see it (it reads as `undefined`). v0.7.0-beta.5 shipped a bot that
  never loaded. Run it after moving/renaming exports in `src/bot` or `vendor`.
- `predev`, `predist`, `predist:mac` and `build:stardew-mod` call `bash`; on
  Windows they need Git Bash on PATH. `predist:win` is pure node.
- There is no lint or formatter script and no ESLint/Prettier config in the
  tree. Do not invent one; match surrounding style.
- PRs target `dev`, one focused change each (CONTRIBUTING.md).

## Process boundaries (load-bearing)

| process | source | role |
| --- | --- | --- |
| main entry | `src/main/boot.ts` | boot shim (`dist/main/index.js`): fuses/guard, single-instance lock, updater, then `import('./index')` in normal mode only |
| main app | `src/main/index.ts` | Electron host (`dist/main/app.js`): window, IPC, config, auth, cloud, bot supervisor |
| preload | `src/preload/index.ts` | `window.sei` bridge, compiled to **`.cjs`** |
| renderer | `src/renderer/src` | React 19 + Zustand, no Node access |
| bot | `src/bot/index.js` | forked `utilityProcess`: LLM brain + game adapter |

- Anything `boot.ts` imports statically also loads in **safe mode**: keep games,
  auth, native addons and other heavy modules behind the `import('./index')`.
  Safe mode (2 failed starts, `--safe-mode`) never loads the app graph.
- `window.sei` (preload) is the only renderer→main path. The renderer never
  imports `src/main`; main and preload traffic only through channels declared in
  `src/shared`.
- `src/shared` is the single source of truth for IPC channels and shared Zod
  contracts. Change both sides there, never duplicate shapes.
- mineflayer and game SDKs load only in `src/bot`. Heavy or native modules must
  stay out of the bot's static import graph (the vision stack loads lazily via
  `src/bot/adapter/minecraft/render/povStackLoader.js` for exactly this reason).
- Secrets stay in main (`safeStorage`) and reach the bot only in the fork `init`
  message, never the renderer.
- The bot ships as raw ESM under asar-unpacked. `src/bot/package.json` exists
  **only** to declare `{"type":"module"}`; deleting it breaks packaged builds
  while `npm run dev` still works.
- One bot per character; two may never share an in-game username.

## Layout

- `src/main/games/` — one module per game: watcher ("is a world open"), join
  target, install. No game wire protocol here.
- `src/bot/adapter/<game>/` — the wire protocol plus closed Zod verb registry,
  observers, prompts. `src/bot/brain/` is game-agnostic.
- `src/renderer/src/lib/` — `registerGameSurface`, `registerSummonFlow`,
  `BOT_ERROR_ROUTES`, `registerGameSetupBody` (`gameSetupBodies.ts`), settings
  sections; each game's `register*.ts` is imported once from `App.tsx`.
- `src/shared/games.ts` — `GAME_CATALOG` (`available: false` means "coming
  soon" and hides it from launch/plan paths); `src/shared/gameIpc.ts` —
  `GameId`, `GAME_IDS`, `WorldState`, `JoinTarget`. `GameId` includes
  `connect4` and `battleship` alongside bot-backed games; these are main-side
  minigames with no downloadable pack.
- `native/<game>-mod/` — the game-side mod and its `PROTOCOL.md` contract
  (`dst-mod`, `stardew-mod`); `native/mac-*` are macOS helpers,
  not mods.
- `assets/<game>-mod/` — checked-in pack payloads; see "Game mods and packs".
- `vendor/` — sibling packages (`cce-1`, `soulcaster`, `skin-gen` imported as
  `img2skin`, plus the `gl` tarball); they have their own suites and are
  excluded from vitest.
- `packs/*` — npm workspaces whose dependencies are downloaded as game packs on
  first use (`minecraft`, `dontstarve`). Stardew has no workspace:
  its pack is asset-only. Required payload is pinned in
  `src/shared/gamePacks.ts` (`GAME_PACKS[*].requiredPaths`) and must stay equal
  to `scripts/lib/gamePackVerify.mjs` `REQUIRED_PAYLOAD`.
- `src/main/connect4/` and `src/main/battleship/` — main-side minigame
  services (one session per character, `sessions` Map). No engine, no model
  download: the LLM picks via a tool (`play(column)` for Connect 4,
  `fire(row, col)` for Battleship). Wired into `src/main/index.ts`,
  `src/main/ipc.ts`, `src/main/profile/accountSessions.ts` (`endAll*`),
  `src/preload/index.ts`, renderer store + UI + `gameLaunch.ts`.

## Game mods and packs

- `assets/` is a build output that is **committed**. CI zips Stardew
  with `--skip-build` and `check:packs` only checks the mod sources, so neither
  rebuilds the payload: an un-rebuilt mod change ships the old code. Rebuild
  first:
  - Stardew: `npm run build:stardew-mod` (needs the .NET SDK and the game install).
- `GAME_CATALOG.available` stays false until the game's live checklist passes.
  Registering a main-side module or writing a bot adapter does not light the tile.

## Adding or changing a game surface

- Keep discovery in main and protocol in the bot, as Minecraft, Stardew and
  DST do.
- The composer dynamic-imports `src/bot/adapter/<kind>/runtime.js`. That import
  **must stay dynamic**: the pack loader's module hook is installed before it.
  Register the kind in `src/bot/config.js` (`GAME_KINDS` + a real sub-schema).
- Implement the adapter contract in `src/bot/brain/types.js` (v2); prefer the
  optional members and defaults in `adapterDefaults.js` over Minecraft-specific
  branches in the brain.
- Register the main-side `GameModule` in `src/main/games/index.ts` and from
  `src/main/index.ts`.
- `src/bot/brain/systemBlocks.minecraft.test.js` pins the Minecraft cached
  prefix and tool list byte-for-byte. A brain change that trips it must be a
  deliberate update, not a fixture refresh.
- `src/bot/brain/promptLibrary.js` is the single prompt document and must stay
  import-free (the dev viewer imports it by path and edits it in place).
- For a **main-side minigame** (Connect 4, Battleship): service in
  `src/main/<game>/`, IPC contract in `src/shared/<game>Ipc.ts`, entry in
  `GameId`/`GAME_CATALOG`/`GAME_PACKS` (no pack, `requiredPaths: []`),
  `BOT_ERROR_ROUTES.<game> = {}`, `GAME_SURFACES.<game> = withGame(<game>)`,
  `summonFlows.<game>` default flow, `PLAN_GAMES.<game>` in
  `src/bot/brain/nextStep.js`, `WorldState` member, renderer store + panel,
  `endAll<game>` in `accountSessions.ts`.

## Required conventions

- **Instrumentation:** every game, minigame or timed surface emits
  `<surface>_started` and `<surface>_ended` with **`duration_ms`** (exact key:
  the dashboard sums playtime by it), `character_id` and an outcome; also on
  abandoned sessions with a `reason`. Shape only, never content. Add the
  `_ended` name to the analytics repo's `SESSION_EVENTS`.
- **Continuity:** context IN (persona, memory tail, summary/history,
  knowledge), OUT long-term (`remember` tool, `appendMemory(..., {section:
  'app'})` outside a game world), OUT short-term (one `event: {kind:'play'}`
  transcript row at the single end choke point, then fire-and-forget
  `foldIfDue`). Per-line game chat is deliberately not persisted.
- **No secrets in the tree:** API keys live in `safeStorage` or the user config,
  never in source, tests or fixtures (use fake `sk-...` values). `.env` and
  `config.json` are gitignored; scan the staged diff before committing.
- **No em dashes in user-facing copy** (UI, error strings, bot lines). En dash
  only for ranges and empty-value placeholders. Comments, logs, tests and
  model-facing prompt text are exempt.
- **Renderer styling:** use tokens from
  `src/renderer/src/styles/tokens.css`, never literal hex/px, and reuse existing
  primitives before adding CSS. Draw!'s scoped palette is a documented
  exception.

## Gotchas verified from config

- `tsc --build` emits sibling `.js` files next to renderer `.tsx`/`.ts`
  (gitignored). Vite can serve the stale `.js` in place of your edit: if a
  renderer change does not show up, delete the stray `.js` artifacts and
  restart dev. Never delete the hand-written `.js` under `src/bot`.
- Vitest excludes `vendor/`, `release/`, `supabase/functions/**`,
  `test/**/*.test.mjs` and the emitted `.js` twins under `src/renderer` and
  `src/shared`. Test files are `.test.js` under `src/bot` (hand-authored JS) and
  `.test.ts(x)` elsewhere. The `native/*/tests/*.mjs` harnesses are manual, not
  part of `npm test`.
- The renderer resolves `@` → `src/renderer/src` and `@shared` → `src/shared`
  in both Vite and vitest; tests that value-import renderer modules rely on it.
- **Some suites assert POSIX paths, `chmod` exec bits or locale date output;
  those fail on Windows regardless of your change.** This includes CJK regex
  range errors (TS1517) in files like `controlPolicy.ts`, `guessMatch.ts`,
  `tts.ts`, `echoGate.ts`, `unvoicedLine.ts`, `slug.ts`, `seilinkRoomDiff.ts`.
  Read the assertion before treating a red suite as a regression. Run the
  touched file, not just the whole suite.
- Write config through `configStore.updateConfig` (locked read-modify-write,
  only the keys you own). `loadConfig()` + `saveConfig()` is for seeding and
  tests. A new renderer-settable `UserConfig` key must be listed in
  `RENDERER_SETTABLE_KEYS` or `MAIN_OWNED_KEYS` (`src/main/configStore.ts`).
- An account switch tears down live surfaces and resets renderer caches. A new
  session surface needs an `endAll*` in
  `src/main/profile/accountSessions.ts`, the `beginSessionStart` guard, and
  scope-tracked writes.
- `.env` is entirely optional; with none, Supabase and cloud go through the
  proxy. Build-time defines must stay defined-only-when-set (an unconditional
  define kills the runtime `??` fallback).
- Packaging: `appId: com.sei.app` is locked (changing it strands stored
  keychain entries); `asarUnpack` covers `src/bot/**` and `node_modules/**`; the
  updater runs only when `app.isPackaged`.
- `npm run dist:win` produces `release/Sei-win-x64.exe` (NSIS one-click,
  per-user) and `release/win-unpacked/Sei.exe` (runs with no install). Both are
  gitignored. `predist:win` builds the SeiLink addon first; if it fails
  (`Cannot find module 'node-addon-api'`, no VS toolchain) the script warns and
  the build continues **without** the addon, and the `&&` chain skips
  `fetch-live2d-core`. A local build is unsigned (SmartScreen "unknown
  publisher") and its updater points at `sei-studio/sei`, so accepting an
  update replaces it with the official release.
- `patches/*.patch` (patch-package, applied by `postinstall`) carry the
  minecraft/mineflayer fixes. Never hand-edit those packages in `node_modules`;
  change the patch or the upstream dep. See `patches/README.md`.
- Version bumps: run `npm install --package-lock-only` only where
  `node_modules` already exists, then check `git diff package-lock.json` shows
  only version lines.
