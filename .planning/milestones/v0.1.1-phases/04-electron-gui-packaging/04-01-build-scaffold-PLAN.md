---
phase: 04-electron-gui-packaging
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - package.json
  - tsconfig.json
  - tsconfig.node.json
  - tsconfig.web.json
  - electron.vite.config.ts
  - electron-builder.yml
  - .gitignore
  - src/bot/index.js
  - src/bot/cli/index.js
  - src/bot/config.js
  - src/bot/registry.js
  - src/bot/brain/
  - src/bot/adapter/
  - src/index.js
  - src/cli/index.js
  - src/config.js
  - src/registry.js
  - src/brain/
  - src/adapter/
  - sei_logo.svg
  - sei_logo.png
  - sei_logo_small.svg
  - sei_logo_small.png
  - src/renderer/public/img/sei-logo.svg
  - src/renderer/public/img/sei-logo.png
  - src/renderer/public/img/sei-logo-small.svg
  - src/renderer/public/img/sei-logo-small.png
autonomous: true
requirements: [PKG-01, PKG-02]
must_haves:
  truths:
    - "`npm install` succeeds with new Electron toolchain pinned"
    - "`npm run dev` boots an Electron BrowserWindow showing index.html (placeholder ok)"
    - "All existing src/{brain,adapter,cli,registry,config,index}.js files are reachable under src/bot/ and old top-level paths are removed"
    - "`sei` CLI command still resolves and runs via `node src/bot/cli/index.js`"
  artifacts:
    - path: package.json
      provides: "Electron toolchain pinned (electron@42, electron-vite@5, electron-builder@26, react@19, zustand@5, typescript), bin path updated to src/bot/cli/index.js, dist:mac/dist:win/dist:linux scripts present, postinstall=electron-builder install-app-deps"
    - path: electron.vite.config.ts
      provides: "Vite config for main, preload, and renderer process targets"
    - path: electron-builder.yml
      provides: "Stub packaging config with appId placeholder + asarUnpack(src/bot/**/*) + mac/win/linux target stubs (signing config deferred to plan 10)"
    - path: tsconfig.json
      provides: "TypeScript root config referencing tsconfig.node and tsconfig.web"
    - path: src/bot/index.js
      provides: "Relocated bot entrypoint (former src/index.js)"
    - path: src/bot/cli/index.js
      provides: "Relocated CLI entrypoint (former src/cli/index.js) with INDEX_PATH updated"
    - path: src/renderer/public/img/sei-logo-small.svg
      provides: "Logo asset relocated for renderer mask-image use"
  key_links:
    - from: package.json
      to: src/bot/cli/index.js
      via: "bin.sei field"
      pattern: "src/bot/cli/index.js"
    - from: src/bot/cli/index.js
      to: src/bot/index.js
      via: "INDEX_PATH constant for child_process.spawn"
      pattern: "INDEX_PATH"
    - from: electron-builder.yml
      to: src/bot/
      via: "asarUnpack glob"
      pattern: "src/bot/\\*\\*/\\*"
---

<objective>
Lay the Electron build scaffold and refactor the existing CLI codebase under `src/bot/` so subsequent plans can build the main process, preload, and renderer on top of a working dev/build pipeline.

Purpose: Phase 4 introduces a brand-new three-process Electron shell around the existing bot. Before any new code can be written, the repo must (a) acquire the Electron toolchain (electron@42, electron-vite@5, electron-builder@26, react@19, zustand, typescript), (b) reshuffle existing code under `src/bot/` per CONTEXT D-06, (c) relocate logo assets per D-08, and (d) have a runnable `npm run dev` that boots an Electron BrowserWindow. This is foundation for every other plan in the phase — Wave 2 starts here.

Output: Reorganized `src/`, new `src/bot/`, new `src/renderer/public/img/`, new `package.json` with electron toolchain + scripts, new `electron.vite.config.ts`, new `tsconfig.json` family, new stub `electron-builder.yml`, updated `.gitignore`. CLI keeps shipping (D-07).
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/ROADMAP.md
@CLAUDE.md
@.planning/phases/04-electron-gui-packaging/04-CONTEXT.md
@.planning/phases/04-electron-gui-packaging/04-RESEARCH.md
@.planning/phases/04-electron-gui-packaging/04-PATTERNS.md
@package.json
@src/index.js
@src/cli/index.js

<interfaces>
<!-- The CLI's existing INDEX_PATH constant must be updated. Extracted from src/cli/index.js -->
<!-- The CLI uses spawn(node, [INDEX_PATH], { stdio: 'inherit' }) — only the path constant changes; spawn pattern preserved. -->

From src/cli/index.js (current — line ~10–20 area):
```js
const PROJECT_ROOT = path.resolve(...)
const INDEX_PATH = path.join(PROJECT_ROOT, 'src/index.js')   // ← becomes 'src/bot/index.js'
```

From package.json (current):
```json
"main": "src/index.js",
"bin": { "sei": "src/cli/index.js" },
"scripts": { "start": "node src/index.js", "sei": "node src/cli/index.js" }
```
</interfaces>

<key_locked_decisions>
- D-06: Reshuffle `src/{brain,adapter,cli,config.js,registry.js,index.js}` under `src/bot/`. Top of `src/` reads as the Electron app (`main/`, `preload/`, `renderer/`, `shared/` come in later plans).
- D-07: Existing CLI (`sei start` / `sei config`) keeps shipping. Lives at `src/bot/cli/index.js`. `bin: { sei }` points there.
- D-08: Logo files move from repo root to `src/renderer/public/img/`. Repo-root copies DELETED.
- D-04: electron-builder for packaging; postinstall hook runs `electron-builder install-app-deps` (per RESEARCH §Resolved Q6 — gentler than raw `@electron/rebuild` when `dependencies` has zero native modules).
- D-60: electron-builder produces .dmg (macOS), NSIS .exe (Windows), AppImage (Linux). Full signing config flows in plan 10.
- RESEARCH §Resolved Q1: appId starts as placeholder `app.sei.placeholder` with `# TODO(lock-before-signing)` comment. Real appId locked in plan 10's BLOCKING task.
- RESEARCH §Resolved Q2: Windows ships UNSIGNED for v1. NO `signtoolOptions` / `azureSignOptions` in this stub or in plan 10's flesh-out.
- Pitfall 1: `asarUnpack: ["src/bot/**/*"]` is required so `utilityProcess.fork` can resolve the bot entry from `process.resourcesPath/app.asar.unpacked/src/bot/index.js`.
</key_locked_decisions>
</context>

<tasks>

<task type="auto" tdd="false">
  <name>Task 1: Relocate src/{brain,adapter,cli,config,registry,index}.js → src/bot/ and update internal imports</name>
  <read_first>
    - src/index.js (entire file — current bot entrypoint)
    - src/cli/index.js (entire file — current CLI; INDEX_PATH and import paths)
    - src/config.js (entire file — used by both bot and CLI)
    - src/registry.js (header lines for imports only)
    - src/brain/index.js (header — import structure)
    - src/adapter/minecraft/index.js (header)
    - .planning/phases/04-electron-gui-packaging/04-RESEARCH.md §"Recommended Project Structure" (lines ~273–319)
    - .planning/phases/04-electron-gui-packaging/04-PATTERNS.md §"Repository-restructure" table
    - .planning/phases/04-electron-gui-packaging/04-CONTEXT.md D-06, D-07, D-08
  </read_first>
  <behavior>
    - All previously passing imports continue to resolve after the move (same module shape, just under src/bot/).
    - `node src/bot/cli/index.js --help` runs the CLI help text without throwing import errors.
    - `node src/bot/index.js` (with a valid config.json) starts the bot identically to the prior `node src/index.js` invocation (no behavioral change — pure relocation).
  </behavior>
  <action>
Use `git mv` for every relocation so history is preserved. Per CONTEXT D-06 / D-07 / PATTERNS §Repository-restructure, perform the following moves verbatim:

1. `git mv src/index.js src/bot/index.js`
2. `git mv src/cli src/bot/cli` (this moves `src/cli/index.js` → `src/bot/cli/index.js` and any sibling files)
3. `git mv src/config.js src/bot/config.js`
4. `git mv src/registry.js src/bot/registry.js`
5. `git mv src/brain src/bot/brain` (entire directory)
6. `git mv src/adapter src/bot/adapter` (entire directory)

After moves, `src/` should contain ONLY `src/bot/` (renderer/, main/, preload/, shared/ are created by later plans).

Update internal imports in the relocated files:
- In `src/bot/cli/index.js`: change the `INDEX_PATH` constant from `path.join(PROJECT_ROOT, 'src/index.js')` to `path.join(PROJECT_ROOT, 'src/bot/index.js')`.
- In `src/bot/cli/index.js`: change any imports of `../config.js` / `../brain/...` / `../registry.js` / `../adapter/...` so they resolve against the new layout. Since the entire tree moved together, **same-tree relative imports stay the same** (e.g., `../brain/index.js` is still `../brain/index.js` from `src/bot/cli/index.js`). Verify by running `node --check src/bot/cli/index.js` after edits.
- In `src/bot/index.js`: same — its imports of `./brain/...`, `./adapter/...`, `./config.js`, `./registry.js` continue to resolve unchanged because the whole tree moved together.
- Spot-check `src/bot/config.js`, `src/bot/registry.js`, `src/bot/brain/**/*.js`, `src/bot/adapter/**/*.js` — none of these import outside `src/`, so no edits needed there. Use `grep -rn "from '../[^.]" src/bot/` to confirm no imports cross outside `src/bot/`.

Verify nothing references the old paths from outside the move:
- Run `grep -rn "src/index.js\|src/cli/\|src/brain/\|src/adapter/\|src/config.js\|src/registry.js" --include='*.js' --include='*.json' --include='*.md' . | grep -v '^./.planning/' | grep -v '^./node_modules/' | grep -v 'src/bot/'` — should return only allowed references (none expected outside docs/planning).

Do NOT modify package.json in this task — that happens in Task 2.

(Per D-06, D-07.)
  </action>
  <verify>
    <automated>node --check src/bot/index.js && node --check src/bot/cli/index.js && node --check src/bot/config.js && node --check src/bot/registry.js && test ! -e src/index.js && test ! -e src/cli && test ! -e src/config.js && test ! -e src/registry.js && test ! -d src/brain && test ! -d src/adapter && test -d src/bot/brain && test -d src/bot/adapter && test -f src/bot/cli/index.js</automated>
  </verify>
  <acceptance_criteria>
    - `src/index.js` does NOT exist (`test ! -e src/index.js` passes)
    - `src/cli/`, `src/brain/`, `src/adapter/` directories do NOT exist
    - `src/config.js`, `src/registry.js` files do NOT exist at top of src/
    - `src/bot/index.js`, `src/bot/cli/index.js`, `src/bot/config.js`, `src/bot/registry.js` exist
    - `src/bot/brain/` and `src/bot/adapter/` are directories
    - `node --check src/bot/index.js` exits 0
    - `node --check src/bot/cli/index.js` exits 0
    - `grep -n "INDEX_PATH" src/bot/cli/index.js` shows the constant references `'src/bot/index.js'` (NOT `'src/index.js'`)
    - `grep -rn "from '\\.\\./\\.\\./[^b]" src/bot/cli/ 2>/dev/null` returns no results (no imports escape src/bot/)
  </acceptance_criteria>
  <done>All `src/{brain,adapter,cli,index,config,registry}` paths relocated to `src/bot/` with git history preserved; CLI's INDEX_PATH points to the new bot entry; no orphaned files at top of `src/`.</done>
</task>

<task type="auto" tdd="false">
  <name>Task 2: Add Electron toolchain to package.json + create electron-vite config + tsconfigs + .gitignore updates</name>
  <read_first>
    - package.json (entire file — current state)
    - .planning/phases/04-electron-gui-packaging/04-RESEARCH.md §"Standard Stack" (lines ~157–200)
    - .planning/phases/04-electron-gui-packaging/04-RESEARCH.md §"Code Examples §5: package.json scripts shape" (lines ~826–847)
    - .planning/phases/04-electron-gui-packaging/04-RESEARCH.md §"Recommended Project Structure" (file layout under src/)
    - .planning/phases/04-electron-gui-packaging/04-RESEARCH.md §"Resolved During Plan-Phase" Q6 (postinstall = electron-builder install-app-deps)
    - .planning/phases/04-electron-gui-packaging/04-CONTEXT.md D-03, D-04, D-05, D-07
    - .gitignore (current content)
  </read_first>
  <behavior>
    - `npm install` completes without errors after the package.json changes.
    - `npm run dev` (after this plan + scaffold files exist) boots `electron-vite dev`.
    - `npm run dist:mac`, `dist:win`, `dist:linux` exist as scripts (config flesh-out happens in plan 10).
    - The `sei` CLI bin still resolves: `node ./node_modules/.bin/sei --help` works (or after `npm link`, `sei --help` works).
    - `npm run start` (CLI sanity) is removed/replaced (CLI is invoked via `npm run sei` per Example 5).
  </behavior>
  <action>
Edit `package.json` to match RESEARCH §"Code Examples §5" (lines 826–847) verbatim except for the appId placeholder. Specifically:

1. Change `"main"` from `"src/index.js"` to `"dist/main/index.js"` (electron-vite outputs main process here).
2. Change `"bin"` from `{ "sei": "src/cli/index.js" }` to `{ "sei": "src/bot/cli/index.js" }` per D-07.
3. Replace `"scripts"` with the full set:
```json
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
  "sei": "node src/bot/cli/index.js",
  "verify:phase2": "node scripts/verify-phase2.js",
  "verify:phase3": "node scripts/verify-phase3.js"
}
```
(Preserve the existing verify:phase2 / verify:phase3 scripts.)

4. Add `"devDependencies"` (use `npm install --save-dev` or hand-edit; ensure these versions per RESEARCH §Standard Stack):
   - `electron@42.0.0`
   - `electron-vite@5.0.0`
   - `electron-builder@26.8.1`
   - `vite@8.0.11`
   - `@electron/rebuild@4.0.4`
   - `@electron/notarize@3.1.1`
   - `typescript@^5.4.0`
   - `@types/react@^19.0.0`
   - `@types/react-dom@^19.0.0`

5. Add `"dependencies"` (preserve existing entries, add new):
   - `react@19.2.6`
   - `react-dom@19.2.6`
   - `zustand@5.0.13`

Run `npm install` to install everything. The postinstall hook (`electron-builder install-app-deps`) runs and is a no-op today (zero native modules per RESEARCH §1) — that's the correct outcome.

Create `electron.vite.config.ts` at repo root (per electron-vite 5.x conventions). Use this minimal config:
```ts
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: path.resolve('src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: path.resolve('src/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: path.resolve('src/renderer'),
    build: {
      rollupOptions: {
        input: { index: path.resolve('src/renderer/index.html') },
      },
    },
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve('src/renderer/src'),
        '@shared': path.resolve('src/shared'),
      },
    },
  },
});
```
(Plan 02 creates `src/main/index.ts`; plan 02 creates `src/preload/index.ts`; plan 06 creates `src/renderer/index.html`. The config can reference paths that don't exist yet — Vite errors only at build time.)

Add `@vitejs/plugin-react@^4.3.0` to devDependencies (used by the renderer config).

Create `tsconfig.json` at repo root referencing the per-process configs:
```json
{
  "files": [],
  "references": [
    { "path": "./tsconfig.node.json" },
    { "path": "./tsconfig.web.json" }
  ]
}
```

Create `tsconfig.node.json` (covers main + preload + shared):
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "allowJs": true,
    "outDir": "dist",
    "types": ["node", "electron"]
  },
  "include": ["src/main/**/*.ts", "src/preload/**/*.ts", "src/shared/**/*.ts"]
}
```

Create `tsconfig.web.json` (covers renderer):
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "types": ["vite/client"],
    "paths": {
      "@/*": ["src/renderer/src/*"],
      "@shared/*": ["src/shared/*"]
    },
    "baseUrl": "."
  },
  "include": ["src/renderer/src/**/*.ts", "src/renderer/src/**/*.tsx", "src/shared/**/*.ts"]
}
```

Update `.gitignore` — append these lines if not already present:
```
dist/
release/
out/
*.log
.DS_Store
```

Do NOT create `electron-builder.yml` here — that's Task 3.
Do NOT create any source files under `src/main/`, `src/preload/`, `src/renderer/` — those happen in later plans. The configs reference future paths; that's intentional.
  </action>
  <verify>
    <automated>npm install --no-audit --no-fund 2>&1 | tail -5 && test -f electron.vite.config.ts && test -f tsconfig.json && test -f tsconfig.node.json && test -f tsconfig.web.json && grep -q '"dist:mac"' package.json && grep -q '"dist:win"' package.json && grep -q '"dist:linux"' package.json && grep -q '"postinstall": "electron-builder install-app-deps"' package.json && grep -q '"sei": "src/bot/cli/index.js"' package.json && grep -q '"electron":' package.json && grep -q '"electron-vite":' package.json && grep -q '"electron-builder":' package.json && grep -q '"react":' package.json && grep -q '"zustand":' package.json && grep -q '^dist/' .gitignore && grep -q '^release/' .gitignore</automated>
  </verify>
  <acceptance_criteria>
    - `npm install` exits 0
    - `package.json` "main" field equals `"dist/main/index.js"`
    - `package.json` "bin.sei" field equals `"src/bot/cli/index.js"`
    - `package.json` scripts include exactly these keys: `dev`, `build`, `preview`, `start`, `dist`, `dist:mac`, `dist:win`, `dist:linux`, `postinstall`, `sei`, `verify:phase2`, `verify:phase3`
    - `package.json` postinstall script equals `"electron-builder install-app-deps"`
    - `package.json` devDependencies contains: `electron`, `electron-vite`, `electron-builder`, `vite`, `@electron/rebuild`, `@electron/notarize`, `typescript`, `@vitejs/plugin-react`, `@types/react`, `@types/react-dom`
    - `package.json` dependencies contains: `react`, `react-dom`, `zustand` (in addition to existing `@anthropic-ai/sdk`, `mineflayer`, etc.)
    - `electron.vite.config.ts` exists and contains `defineConfig` and three sections: `main:`, `preload:`, `renderer:`
    - `tsconfig.json` exists with `"references"` pointing at the two child configs
    - `tsconfig.node.json` exists with `"include"` listing `src/main/**/*.ts`, `src/preload/**/*.ts`, `src/shared/**/*.ts`
    - `tsconfig.web.json` exists with `"jsx": "react-jsx"` and `"include"` listing `src/renderer/src/**/*.ts(x)`
    - `.gitignore` contains `dist/`, `release/`, `out/`, `*.log`
    - `node ./src/bot/cli/index.js --version` (or `--help`) exits without an unhandled exception (CLI is intact)
  </acceptance_criteria>
  <done>Electron toolchain installed; tsconfig family + electron-vite config in place; all dist/dev/postinstall scripts wired; `sei` CLI still resolves through the bin.</done>
</task>

<task type="auto" tdd="false">
  <name>Task 3: Create stub electron-builder.yml + relocate logo assets to src/renderer/public/img/</name>
  <read_first>
    - .planning/phases/04-electron-gui-packaging/04-RESEARCH.md §"Code Examples §3: electron-builder.yml" (lines ~738–805)
    - .planning/phases/04-electron-gui-packaging/04-RESEARCH.md §"Resolved During Plan-Phase" Q1 (appId placeholder), Q2 (Windows unsigned v1)
    - .planning/phases/04-electron-gui-packaging/04-RESEARCH.md §"Common Pitfalls" Pitfall 1 (asarUnpack)
    - .planning/phases/04-electron-gui-packaging/04-CONTEXT.md D-08, D-60
    - ls of repo root for the four logo files
  </read_first>
  <behavior>
    - `electron-builder.yml` exists with appId placeholder + asarUnpack rule + macOS/Windows/Linux target stubs.
    - The appId is the placeholder `app.sei.placeholder` with a `# TODO(lock-before-signing)` comment immediately above it.
    - NO `signtoolOptions` and NO `azureSignOptions` blocks are present (Windows unsigned v1 per RESEARCH Q2).
    - The four logo files (`sei_logo.svg`, `sei_logo.png`, `sei_logo_small.svg`, `sei_logo_small.png`) live in `src/renderer/public/img/` (renamed to use a hyphen, not an underscore, to match the design `index.html` which references `/img/sei-logo-small.svg`) and are GONE from repo root.
  </behavior>
  <action>
**Stub electron-builder.yml.** Create `electron-builder.yml` at repo root with the following content (copy verbatim — flesh-out for signing/notarization happens in plan 10):

```yml
# electron-builder.yml — Phase 4 STUB. Plan 10 fleshes signing + notarize.
# Source: .planning/phases/04-electron-gui-packaging/04-RESEARCH.md §"Code Examples §3"

# TODO(lock-before-signing) — chosen by user before first signed dist:mac
# Plan 10 contains a [BLOCKING] task to lock this. Once shipped, changing this
# strands all existing safeStorage Keychain entries.
appId: app.sei.placeholder
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
  # hardenedRuntime, identity, notarize, entitlements added in plan 10

dmg:
  sign: false

win:
  target:
    - target: nsis
      arch: [x64]
  # NO signtoolOptions / azureSignOptions — Windows ships UNSIGNED v1 per RESEARCH Q2.
  # SmartScreen "unknown publisher" warning is accepted UX for v1; documented in release notes.

nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: true

linux:
  target:
    - AppImage
  category: Game
```

**Relocate logo assets.** From repo root, perform these moves:

1. `mkdir -p src/renderer/public/img`
2. `git mv sei_logo.svg src/renderer/public/img/sei-logo.svg`
3. `git mv sei_logo.png src/renderer/public/img/sei-logo.png`
4. `git mv sei_logo_small.svg src/renderer/public/img/sei-logo-small.svg`
5. `git mv sei_logo_small.png src/renderer/public/img/sei-logo-small.png`

(Note the underscore→hyphen filename change: design references `mask-image: url(/img/sei-logo-small.svg)` per CONTEXT D-35 / canonical_refs. Hyphenated form is the canonical form going forward.)

After moves, verify with `ls` that the four files no longer exist at repo root and DO exist in `src/renderer/public/img/`.

Do NOT create any other build/ files in this task. `build/entitlements.mac.plist` is plan 10's job.
  </action>
  <verify>
    <automated>test -f electron-builder.yml && grep -q '^appId: app.sei.placeholder' electron-builder.yml && grep -q '# TODO(lock-before-signing)' electron-builder.yml && grep -q '^asarUnpack:' electron-builder.yml && grep -q '"src/bot/\*\*/\*"' electron-builder.yml && ! grep -q 'signtoolOptions:' electron-builder.yml && ! grep -q 'azureSignOptions:' electron-builder.yml && grep -q 'target: dmg' electron-builder.yml && grep -q 'target: nsis' electron-builder.yml && grep -q 'AppImage' electron-builder.yml && test -f src/renderer/public/img/sei-logo.svg && test -f src/renderer/public/img/sei-logo.png && test -f src/renderer/public/img/sei-logo-small.svg && test -f src/renderer/public/img/sei-logo-small.png && test ! -e sei_logo.svg && test ! -e sei_logo.png && test ! -e sei_logo_small.svg && test ! -e sei_logo_small.png</automated>
  </verify>
  <acceptance_criteria>
    - `electron-builder.yml` exists at repo root
    - `electron-builder.yml` contains line `appId: app.sei.placeholder`
    - `electron-builder.yml` contains line `# TODO(lock-before-signing)` (case-sensitive)
    - `electron-builder.yml` contains `asarUnpack:` block listing `"src/bot/**/*"`
    - `electron-builder.yml` does NOT contain the strings `signtoolOptions:` or `azureSignOptions:` (grep returns 0 matches)
    - `electron-builder.yml` mac target has `arch: [universal]`
    - `electron-builder.yml` win target has `arch: [x64]` and `target: nsis`
    - `electron-builder.yml` linux target is `AppImage`
    - Files exist: `src/renderer/public/img/sei-logo.svg`, `sei-logo.png`, `sei-logo-small.svg`, `sei-logo-small.png`
    - Files DO NOT exist: `./sei_logo.svg`, `./sei_logo.png`, `./sei_logo_small.svg`, `./sei_logo_small.png`
  </acceptance_criteria>
  <done>Stub `electron-builder.yml` ready for plan 10 to flesh out; logo assets relocated under hyphenated filenames in `src/renderer/public/img/`.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| filesystem→build-config | Untrusted file paths could be packed if `files:` glob is too permissive |
| repo-root→app-bundle | Repo-root assets that should be packed must be under `dist/`; this plan does NOT touch dist contents but sets the future shape |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-04-01 | Tampering | electron-builder.yml `files:` glob | mitigate | Use explicit allow-list `dist/**/*` + `package.json`; exclude node_modules test dirs |
| T-04-02 | Information Disclosure | future packaged builds | accept | This plan ships only stub; secrets handling locked in plans 03/05/10 |
| T-04-03 | Tampering | bot entry resolution | mitigate | `asarUnpack: ["src/bot/**/*"]` ensures runtime resolves the real file from disk; main process branches on `app.isPackaged` (plan 04) |
| T-04-04 | Repudiation | unsigned Windows installer | accept | Per RESEARCH Q2, Windows ships UNSIGNED for v1; SmartScreen warning is documented in plan 11's release notes |
</threat_model>

<verification>
Phase-level: Once Plan 1 lands, `npm install` should succeed cleanly. Subsequent plans build on this scaffold.
- `npm install` → exits 0 (postinstall is a no-op today)
- `node src/bot/cli/index.js --help` → CLI works (regression check on D-07)
- `cat package.json | jq .bin.sei` → `"src/bot/cli/index.js"`
- `grep -q "src/bot" electron-builder.yml` → asarUnpack rule present
- All four logo files at `src/renderer/public/img/` (hyphenated names per design `index.html`)
</verification>

<success_criteria>
- Wave 2 plans (02 main process, 03 stores, 04 supervisor, 05 shared types) can begin compilation against tsconfig.node.json without "no inputs" errors (will report empty inputs but not error on missing files because `include` globs accept zero matches).
- Wave 3 plans can begin renderer authoring with `tsconfig.web.json` and `electron.vite.config.ts` already wired.
- Wave 4 (plan 10 packaging) can extend the stub `electron-builder.yml` without rewriting it.
- The CLI (`sei`) remains functional for headless / dev use throughout the phase per D-07.
</success_criteria>

<output>
After completion, create `.planning/phases/04-electron-gui-packaging/04-01-SUMMARY.md` documenting:
- Final dependency versions installed (in case any drifted from spec)
- Any postinstall warnings observed
- The exact electron-builder.yml stub written
- Confirmation that CLI sanity-check passed
- Note for Plan 10 executor: search for `# TODO(lock-before-signing)` comment to find the appId placeholder; that is the hook for the BLOCKING lock-identifiers task.
</output>
