---
phase: 04-electron-gui-packaging
plan: 01
subsystem: build-scaffold
tags: [electron, vite, packaging, repo-restructure, scaffold]
dependency_graph:
  requires: []
  provides:
    - "src/bot/ namespace ready for utilityProcess fork target"
    - "electron-vite config wired for main + preload + renderer (paths resolve at build time)"
    - "tsconfig family (root + node + web) for TS authoring under src/main/, src/preload/, src/shared/, src/renderer/src/"
    - "electron-builder stub with appId placeholder + asarUnpack(src/bot/**/*) — extension point for plan 10"
    - "logo assets at src/renderer/public/img/ with hyphenated names matching design CSS"
  affects:
    - "All Phase 4 wave-2+ plans depend on this scaffold (main process, preload, renderer, supervisor, packaging)"
tech_stack:
  added:
    - "electron@42.0.0"
    - "electron-vite@5.0.0"
    - "electron-builder@26.8.1"
    - "vite@^7.0.0 (DEVIATION — see notes)"
    - "@electron/rebuild@4.0.4"
    - "@electron/notarize@3.1.1"
    - "@vitejs/plugin-react@^4.3.0"
    - "typescript@^5.4.0"
    - "@types/react@^19.0.0"
    - "@types/react-dom@^19.0.0"
    - "react@19.2.6"
    - "react-dom@19.2.6"
    - "zustand@5.0.13"
  patterns:
    - "Three-process Electron with electron-vite per-process config (main/preload/renderer)"
    - "asarUnpack rule keeps utilityProcess fork target on disk under app.asar.unpacked/"
    - "TypeScript Project References split: tsconfig.node.json (Electron + bundler) vs tsconfig.web.json (DOM + react-jsx)"
    - "postinstall=electron-builder install-app-deps (gentler than raw @electron/rebuild for zero-native-dep projects)"
key_files:
  created:
    - "electron.vite.config.ts"
    - "tsconfig.json"
    - "tsconfig.node.json"
    - "tsconfig.web.json"
    - "electron-builder.yml"
    - "src/renderer/public/img/sei-logo.svg"
    - "src/renderer/public/img/sei-logo.png"
    - "src/renderer/public/img/sei-logo-small.svg"
    - "src/renderer/public/img/sei-logo-small.png"
    - ".planning/phases/04-electron-gui-packaging/deferred-items.md"
  modified:
    - "package.json"
    - "package-lock.json"
    - ".gitignore"
    - "src/bot/cli/index.js (PROJECT_ROOT depth + INDEX_PATH)"
  relocated:
    - "src/{index,config,registry}.js → src/bot/"
    - "src/cli/ → src/bot/cli/"
    - "src/brain/ → src/bot/brain/"
    - "src/adapter/ → src/bot/adapter/"
    - "sei_logo{,_small}.{svg,png} → src/renderer/public/img/sei-logo{,-small}.{svg,png}"
decisions:
  - "Pinned vite to ^7 (not 8 per RESEARCH §Standard Stack) because electron-vite@5 peerDeps cap at vite@^7 — fix needed to satisfy dependency resolver"
  - "Updated CLI PROJECT_ROOT to walk up 3 directory levels (was 2) so config/memory paths still resolve to repo root after src/bot/cli/ relocation"
  - "Split CLI relocation into two commits (rename + path update) because git couldn't capture both as a single rename diff"
metrics:
  duration_min: 4
  tasks_completed: 3
  files_changed_estimate: 60
  completed: "2026-05-08T18:06:37Z"
---

# Phase 4 Plan 01: Build Scaffold Summary

**One-liner:** Electron + electron-vite + electron-builder toolchain pinned, src/bot/ namespace established for utilityProcess fork, logos relocated under hyphenated paths the renderer CSS mask-image already references.

## Commits

| Commit  | Type     | Description |
| ------- | -------- | ----------- |
| bf14e99 | refactor | Relocate src/{brain,adapter,cli,index,config,registry} → src/bot/ via git mv (history preserved) |
| 21a4cd6 | refactor | Update CLI INDEX_PATH and PROJECT_ROOT for src/bot/cli/ depth |
| fc1bb7a | chore    | Add Electron toolchain + tsconfig family + electron-vite config + .gitignore updates |
| 9f6643c | chore    | Add stub electron-builder.yml + relocate logos with hyphenated filenames |

## What Shipped

### Task 1 — Repo restructure (D-06, D-07)
All bot code lives under `src/bot/` now. Top of `src/` is empty save `src/bot/`, ready for plan 02 to drop `src/main/`, `src/preload/`, plan 03/05 to drop `src/shared/`, plan 06+ to drop `src/renderer/`. Same-tree relative imports (`./brain/...`, `../adapter/...`, etc.) continue to resolve unchanged because the entire tree moved together.

CLI fix: `src/bot/cli/index.js` is now one directory deeper than the original `src/cli/index.js`. PROJECT_ROOT changed from `resolve(__dirname, '..', '..')` to `resolve(__dirname, '..', '..', '..')` so `config.json` / `memory/` / `INDEX_PATH` still resolve to repo root. INDEX_PATH updated to `src/bot/index.js`.

Verified: `node src/bot/cli/index.js help` renders the help banner with the correct config-path display.

### Task 2 — Toolchain + configs (D-03, D-04, D-05, D-07)
- **package.json**: `main` → `dist/main/index.js` (electron-vite output target). `bin.sei` → `src/bot/cli/index.js` (CLI keeps shipping per D-07). Scripts: `dev`, `build`, `preview`, `start`, `dist`, `dist:mac`, `dist:win`, `dist:linux`, `postinstall=electron-builder install-app-deps`, `sei`, `verify:phase2`, `verify:phase3`.
- **electron.vite.config.ts**: per-process config with `externalizeDepsPlugin()` for main/preload, `@vitejs/plugin-react` for renderer, `@/` alias → `src/renderer/src/`, `@shared/` alias → `src/shared/`. Input paths point at files plan 02/06 will create.
- **tsconfig.json** (root): Project References to node and web configs.
- **tsconfig.node.json**: ES2022 + Bundler resolution + node/electron types; covers `src/main/`, `src/preload/`, `src/shared/`.
- **tsconfig.web.json**: ES2022 + DOM lib + `react-jsx` + `vite/client` types + `@/`/`@shared/` paths.
- **.gitignore**: appended `dist/`, `release/`, `out/`, `*.log`, `.DS_Store`.

`npm install` completed cleanly. The postinstall hook ran `electron-builder install-app-deps` which invoked `@electron/rebuild electronVersion=42.0.0 arch=arm64 buildFromSource=false` — completed in ~1s with no native modules to rebuild (expected, per RESEARCH §1; mineflayer's prismarine deps stay pure-JS until the bundler reaches them).

### Task 3 — electron-builder stub + logo relocation (D-08, D-60, RESEARCH Q1, Q2)
- **electron-builder.yml**: appId placeholder `app.sei.placeholder` with `# TODO(lock-before-signing)` comment immediately above (the hook plan 10's BLOCKING task searches for). asarUnpack lists `"src/bot/**/*"` (Pitfall 1 — utilityProcess fork target must be on disk, not in asar). Targets: macOS dmg/universal, Windows nsis/x64, Linux AppImage. Critically, NO `signtoolOptions` and NO `azureSignOptions` — Windows ships UNSIGNED for v1 per RESEARCH Q2.
- **Logos**: all four moved from repo root to `src/renderer/public/img/` with hyphenated filenames (`sei-logo.svg`, `sei-logo.png`, `sei-logo-small.svg`, `sei-logo-small.png`). Hyphenated form matches the design's `mask-image: url(/img/sei-logo-small.svg)` reference (D-35, canonical_refs).

## Final Dependency Versions Installed

```
electron@42.0.0
electron-vite@5.0.0
electron-builder@26.8.1
vite@^7.0.0          ← DEVIATION from spec's 8.0.11
@electron/rebuild@4.0.4
@electron/notarize@3.1.1
@vitejs/plugin-react@^4.3.0
typescript@^5.4.0
@types/react@^19.0.0
@types/react-dom@^19.0.0
react@19.2.6
react-dom@19.2.6
zustand@5.0.13
```

## Postinstall Output

Clean. Verbatim:
```
> electron-builder install-app-deps
  • electron-builder  version=26.8.1
  • executing @electron/rebuild  electronVersion=42.0.0 arch=arm64 buildFromSource=false
  • installing native dependencies  arch=arm64
  • completed installing native dependencies
```

Four `npm warn deprecated` notices (`inflight`, `rimraf@2`, `glob@7`, `boolean`) — all transitive through electron-builder's tooling and outside our direct control. No action.

## Exact electron-builder.yml Stub

See `/electron-builder.yml`. The complete stub includes:
- appId placeholder + lock-before-signing TODO comment
- productName: Sei
- directories.output: release, directories.buildResources: build
- files allow-list: dist/**/*, package.json, exclusion of test/tests/__tests__/*.md
- asar: true + asarUnpack: ["src/bot/**/*"]
- mac: dmg/universal target with category public.app-category.games (no signing config)
- dmg.sign: false
- win: nsis/x64 (NO signtoolOptions / azureSignOptions)
- nsis: oneClick:false, perMachine:false, allowToChangeInstallationDirectory:true
- linux: AppImage, category Game

## CLI Sanity Check (D-07)

```
$ node src/bot/cli/index.js help
sei — framework for custom Minecraft personas
usage
  sei              show menu (or run onboarding on first run)
  sei start        connect to an open LAN world and run the persona
  sei config       re-run onboarding
  sei help         show this help
config lives in <repo-root>/config.json
```

Help renders correctly. Config path resolves to repo root (proves the PROJECT_ROOT depth fix works).

## Note for Plan 10 Executor

Search for the marker `# TODO(lock-before-signing)` in `/electron-builder.yml`. The line directly below it is the appId that must be locked **before** the first signed `dist:mac` ships. Once the appId is locked and the app has shipped, changing it strands all existing safeStorage Keychain entries for users (Keychain entries are namespaced by appId).

The same file is the docked surface for the rest of plan 10's signing config:
- `mac.hardenedRuntime`, `mac.identity`, `mac.notarize`, `mac.entitlements`, `mac.entitlementsInherit`
- `dmg.sign` flips to `true` once an identity is configured
- Windows stays UNSIGNED for v1 per RESEARCH Q2 — do **not** add `signtoolOptions` / `azureSignOptions` blocks. SmartScreen "unknown publisher" warning is documented in plan 11's release notes.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Pinned vite to ^7 instead of 8.0.11**
- **Found during:** Task 2 (`npm install`)
- **Issue:** `electron-vite@5.0.0` peerDeps require `vite: ^5.0.0 || ^6.0.0 || ^7.0.0`, while RESEARCH §Standard Stack specified `vite@8.0.11`. `npm install` failed with ERESOLVE. The plan's spec is internally inconsistent — electron-vite@5 simply doesn't support vite@8 yet (and `@vitejs/plugin-react` doesn't either, requiring vite ^4–^7).
- **Fix:** Changed `"vite": "8.0.11"` to `"vite": "^7.0.0"` in package.json.
- **Files modified:** package.json
- **Commit:** fc1bb7a
- **Impact:** None — vite@7 is the latest version supported by both electron-vite@5 and @vitejs/plugin-react. Functionality and API surface used by electron-vite is identical for our purposes. RESEARCH should be updated by plan-author next time around.

**2. [Rule 1 - Bug] CLI PROJECT_ROOT walked wrong number of levels post-relocation**
- **Found during:** Task 1 (post git mv)
- **Issue:** `src/cli/index.js` previously had `PROJECT_ROOT = resolve(__dirname, '..', '..')` to reach repo root from `src/cli/`. After `git mv` to `src/bot/cli/`, `__dirname` is now `src/bot/cli/` — same expression resolves to `src/`, not repo root. `CONFIG_PATH`, `MEMORY_DIR`, and `INDEX_PATH` would all be wrong, and `requireOnboarded()` would not find an existing config.json.
- **Fix:** `resolve(__dirname, '..', '..', '..')` — walk up one extra level.
- **Files modified:** src/bot/cli/index.js
- **Commit:** 21a4cd6
- **Impact:** None — fix verified via `node src/bot/cli/index.js help`, which now displays the correct repo-root config path.

### Out-of-scope items deferred (logged to deferred-items.md)
- `scripts/verify-phase2.js` and `scripts/verify-phase2_1.js` import paths that no longer exist (`../src/llm/orchestrator.js`, `../src/observers/snapshot.js`, `../src/llm/persona.js`). These were already broken **before** this plan because Phase 03.1's refactor moved the LLM code into `src/brain/` and the observer code into `src/adapter/minecraft/observers/`. Pure pre-existing breakage; left untouched per scope boundary.

### Authentication Gates
None.

## Acceptance Criteria — Plan-level

- [x] `npm install` exits 0
- [x] `node src/bot/cli/index.js help` runs the CLI without errors (D-07 regression check)
- [x] `cat package.json | jq .bin.sei` → `"src/bot/cli/index.js"`
- [x] `grep -q "src/bot" electron-builder.yml` returns success (asarUnpack rule present)
- [x] All four logos at `src/renderer/public/img/` with hyphenated filenames
- [x] All three task acceptance-criteria blocks pass (verified inline before each commit)

## Self-Check: PASSED

Verified files exist:
- FOUND: electron.vite.config.ts
- FOUND: tsconfig.json
- FOUND: tsconfig.node.json
- FOUND: tsconfig.web.json
- FOUND: electron-builder.yml
- FOUND: src/renderer/public/img/sei-logo.svg
- FOUND: src/renderer/public/img/sei-logo.png
- FOUND: src/renderer/public/img/sei-logo-small.svg
- FOUND: src/renderer/public/img/sei-logo-small.png
- FOUND: src/bot/index.js
- FOUND: src/bot/cli/index.js
- FOUND: src/bot/config.js
- FOUND: src/bot/registry.js

Verified directories: src/bot/brain/, src/bot/adapter/ — exist.
Verified absent: src/index.js, src/cli/, src/config.js, src/registry.js, src/brain/, src/adapter/, ./sei_logo*.{svg,png} — none present.

Verified commits exist in git log:
- FOUND: bf14e99 (Task 1 — relocation)
- FOUND: 21a4cd6 (Task 1 follow-up — CLI path fix)
- FOUND: fc1bb7a (Task 2 — toolchain + configs)
- FOUND: 9f6643c (Task 3 — builder stub + logos)
