# Phase 8 — Windows Cross-Platform Hotspots Audit

**Audit date:** 2026-05-17 (static-only; live verification deferred to Wave 2/3)
**Auditor:** Claude (Phase 8 Plan 01)
**Sources:** CONTEXT.md §code_context + grep of src/ for `process.platform`, `os.homedir`, env-var lookups, `path.*`, `child_process.*`, `utilityProcess.fork`.

## Status Legend

| Status | Meaning |
|--------|---------|
| SAFE | Statically verified cross-platform-safe — no Windows-specific action required |
| SUSPECT | Pattern looks correct but a Windows behavior bug is possible — Wave 2/3 must verify |
| FIX-INLINE | Defect found here; Plan 01 Task 2 (this plan) ships the fix |
| DEFER-TO-LIVE | Cannot be statically confirmed; Wave 2 (npm run dev) or Wave 3 (npm run dist:win + install) must verify |

## Hotspot Table

| # | File | Path / Symbol | Status | Finding / Remediation | Live-verify in |
|---|------|---------------|--------|------------------------|----------------|
| 1 | src/main/paths.ts | `userDataRoot()` + all `path.join(userDataRoot(), ...)` | SAFE | All <userData>/... reads/writes funnel through `app.getPath('userData')` + `path.join`. No raw string concat anywhere. After Plan 01 Task 2 locks appId, Windows resolves to `%APPDATA%\Sei\` deterministically. | Wave 3 (confirm files land in %APPDATA%\Sei\) |
| 2 | src/main/botSupervisor.ts | `botEntryPath()` L73-88 | SAFE | Packaged path: `path.join(process.resourcesPath, 'app.asar.unpacked', 'src/bot/index.js')`. Dev: `path.join(__dirname, '../../src/bot/index.js')`. Both use `path.join`. asarUnpack in electron-builder.yml lists `src/bot/**/*` so packaged path resolves. | Wave 3 (confirm bot forks in packaged build) |
| 3 | src/main/botSupervisor.ts | `env: { ...process.env, SEI_USER_DATA: paths.userData(), SEI_CHARACTER_ID: characterId }` L250-254 | SAFE | Env injection uses object spread; values are strings, Node handles Windows env-var serialization (UTF-16 internally). SEI_USER_DATA carries a Windows path (e.g. `C:\Users\...\AppData\Roaming\Sei`) — the bot child consumes it via `process.env.SEI_USER_DATA`, no shell expansion involved. | Wave 2 (confirm bot child reads correct userData on Windows) |
| 4 | src/main/windowChrome.ts | L14-25 platform-branched chrome | SAFE | `darwin` → `titleBarStyle: 'hiddenInset'`. `win32` → `frame: false` + `titleBarOverlay` with color/symbolColor/height. linux/other → `frame: false`. The Windows branch is what the smoke test exercises — the title bar overlay (#F6F5F2 / #1A1D24) is what the user sees. | Wave 2 (visual verification — Windows title bar overlay renders correctly) |
| 5 | src/main/index.ts | L123 `process.platform === 'linux' && backendKind() === 'basic_text'` warn | SAFE | Linux-only warning path. Inert on Windows (`process.platform === 'win32'`). | (skip — Linux path) |
| 6 | src/main/index.ts | L157 `app.on('window-all-closed', ...)` non-darwin quit | SAFE | Standard Electron pattern: on non-macOS (incl. Windows), closing the window quits the app. Correct behavior for Windows. | Wave 2 (close window on Windows → app quits) |
| 7 | src/main/index.ts | L42-45 `preloadPath()` returning `path.join(__dirname, '../preload/index.cjs')` | SAFE | path.join handles Windows separator conversion. `.cjs` extension required because package.json has `"type": "module"`. | Wave 2 (dev: preload loads on Windows) |
| 8 | src/main/index.ts | L48-54 `rendererTarget()` — uses `ELECTRON_RENDERER_URL` env var in dev, `path.join` for packaged | SAFE | electron-vite sets the env var; packaged falls back to `path.join(__dirname, '../renderer/index.html')`. Cross-platform safe. | Wave 2 (renderer paints on Windows in dev) |
| 9 | src/main/ipc.ts | L90-93 `app.warnings` handler | SAFE | `process.platform === 'linux' && backendKind() === 'basic_text'`. Returns `false` on Windows (DPAPI is always available). The Linux-fallback banner stays hidden on Windows — desired UX. | Wave 2 (open DevTools → no fallback banner on Windows) |
| 10 | src/bot/cli/index.js | L309-321 `electronUserDataDir()` | SAFE | All three platform branches handle their env-var fallbacks: `APPDATA` (Windows) / `XDG_CONFIG_HOME` (linux) / `Library/Application Support` (darwin). `homedir()` from `node:os` resolves `%USERPROFILE%` on Windows automatically. APP='Sei' constant MUST stay in sync with electron-builder.yml productName=Sei. | Wave 2 (CLI optional — only if user runs `sei reset` on Windows) |
| 11 | src/bot/brain/storage/atomicWrite.js | `writeFile(tmp, contents, 'utf8')` + `rename(tmp, path)` | SAFE | utf8 byte-faithful — no implicit `\n` → `\r\n` conversion (Node only does that with `'binary'` mode on some legacy paths). `rename` is atomic on the same filesystem (Windows ReFS/NTFS support `MoveFileEx` rename semantics). All callers (`memory/owner.js`, `memory/diary.js`, `memory/compactor.js`) write literal `\n`-separated content; readers `.split('\n')`. Round-trip is byte-identical across mac and Windows. | Wave 2 (confirm memory files written on Windows round-trip correctly to mac mount) |
| 12 | electron-builder.yml | `appId: app.sei.placeholder` + `# TODO(lock-before-signing)` | FIX-INLINE | Phase 4 Plan 04-10 left this BLOCKING. Plan 01 Task 2 locks to `appId: com.sei.app`. Removes the TODO comment line. productName=Sei stays — Electron's `app.getPath('userData')` uses productName when set, so Windows lands in `%APPDATA%\Sei\` (NOT `%APPDATA%\com.sei.app\`). | (no live verify — task 2 commits the change) |
| 13 | electron-builder.yml | win target `nsis`, `arch: [x64]`, `oneClick: false`, `perMachine: false`, `allowToChangeInstallationDirectory: true` | SAFE | Per Phase 4 RESEARCH §Resolved Q2: ship unsigned v1. SmartScreen "unknown publisher" warning is accepted UX. NSIS welcome screen + custom install path = correct per-user install behavior. | Wave 3 (confirm `.exe` produces a per-user install with SmartScreen warning expected) |
| 14 | electron-builder.yml | `asarUnpack: ['src/bot/**/*']` | SAFE | Required because utilityProcess.fork cannot enter `.asar` archives (Pitfall 1). Path glob is forward-slash and electron-builder normalizes on Windows. | Wave 3 (confirm `<install-dir>\resources\app.asar.unpacked\src\bot\index.js` exists post-install) |
| 15 | package.json | `"postinstall": "electron-builder install-app-deps"` | SAFE | Cross-platform — electron-builder picks correct prebuilds per platform on `npm install`. No native deps in current dep tree means this is mostly a no-op for v1, but the hook is wired for future native modules. | Wave 2 (confirm `npm install` on Windows completes without postinstall errors) |
| 16 | package.json | `"dist:win": "electron-vite build && electron-builder --win"` | SAFE | Standard chain. `electron-builder --win` on a Windows host builds NSIS natively without wine/mono. | Wave 3 (run on Windows VM, produces `release\Sei Setup 0.1.0.exe`) |
| 17 | src/renderer/src/styles/fonts.css | `@font-face { src: url('/fonts/<file>.woff2') }` | SUSPECT | Renderer at runtime resolves `/fonts/...` against the renderer's base URL. In dev, Vite serves from `src/renderer/public/fonts/`. In packaged build, electron-vite must bundle the public dir into `dist/renderer/`. Forward-slash path is HTTP/file-URL syntax — not filesystem syntax — so it's cross-platform-safe at the protocol layer, BUT we must verify the woff2 files end up in `dist/renderer/fonts/` after `npm run build`. | Wave 2 (open DevTools on Windows in dev → fonts load) + Wave 3 (post-install: text renders in Noto Sans, not browser default) |
| 18 | (codebase) | Any raw `child_process.spawn`/`exec` in src/ | SAFE | Grep confirms ZERO calls (only `spawn_settle_delay_ms` config + mineflayer's `bot.on('spawn')` event listener, which is unrelated). All inter-process work goes through Electron's `utilityProcess.fork` (cross-platform API). | (skip) |
| 19 | (codebase) | Native deps requiring `@electron/rebuild` ABI rebuild | SAFE | Current dep tree: mineflayer (pure JS), mineflayer-pathfinder (pure JS), mineflayer-auto-eat (pure JS), mineflayer-pvp (pure JS), Anthropic SDK (pure JS), React (pure JS), zod (pure JS). ZERO native deps — `electron-builder install-app-deps` postinstall is wired for future use but is a no-op for v1. | Wave 2 (confirm `npm install` exit 0 and no node-gyp output on Windows) |
| 20 | (codebase) | Windows ARM64 target | DEFER-TO-LIVE | Out of scope per CONTEXT §deferred. `arch: [x64]` only. No ARM Windows VM smoke required. | (skip) |
| 21 | (CONTEXT §code_context open Q1) | `npm install` cleanness on fresh Windows 10 | DEFER-TO-LIVE | Static audit cannot exercise the Windows npm registry / electron-builder prebuild fetch. | Wave 2 |
| 22 | (CONTEXT §code_context open Q2) | Renderer font loading + dev paint | DEFER-TO-LIVE | See row 17 — runtime/bundling verification on real Windows. | Wave 2 |
| 23 | (CONTEXT §code_context open Q3) | `\n` vs `\r\n` round-trip via atomicWrite | DEFER-TO-LIVE | See row 11 — static audit says SAFE; live cross-platform round-trip is the proof. Generate a memory file on Windows, copy to mac, diff. | Wave 2 |
| 24 | (CONTEXT §code_context open Q4) | `app.getPath('userData')` Windows resolution | DEFER-TO-LIVE | Plan 01 Task 2 locks appId so resolution is deterministic. Wave 3 confirms `<userData>` = `%APPDATA%\Sei\`. | Wave 3 |

## Statically-Discovered Defects (FIX-INLINE Summary)

- Row 12 (electron-builder.yml appId placeholder) — fixed by Task 2 of this plan.

(If grep against any other file uncovers a stale `app.sei.placeholder` literal, add a fix row above and a `fix(08-win):` commit before Wave 2.)

**Grep result (2026-05-17):** Cross-grep against `--include="*.yml" --include="*.ts" --include="*.js" --include="*.tsx" --include="*.json" --include="*.md"` excluding `node_modules` and `.planning/phases/04-...` returned matches only in: (a) `electron-builder.yml:11` (the placeholder itself — fixed by Task 2), and (b) Phase 8 planning documents that DESCRIBE the placeholder as historical record (these stay — they are the audit/plan/discussion docs that document this very lock event). No additional source-code FIX-INLINE rows required.

## Deferred-to-Live Summary (Wave 2 / Wave 3 checklist seed)

### Wave 2 (dev smoke on Windows VM)
- Row 3: bot child reads correct SEI_USER_DATA on Windows
- Row 4: Windows title bar overlay renders correctly
- Row 6: closing window quits app
- Row 7: preload loads
- Row 8: renderer paints
- Row 9: no Linux-fallback banner
- Row 10: optional CLI reset works (skip if not exercised)
- Row 11: memory file round-trip mac↔Windows is byte-identical
- Row 15: npm install completes
- Row 17: fonts load
- Row 19: no node-gyp output
- Rows 21, 22, 23

### Wave 3 (packaged smoke on Windows VM)
- Row 1: files land in `%APPDATA%\Sei\`
- Row 2: bot forks in packaged build
- Row 13: NSIS installer + SmartScreen warning + per-user install
- Row 14: `app.asar.unpacked\src\bot\index.js` exists after install
- Row 16: `dist:win` produces installer on Windows host
- Row 17 (packaged): text renders in Noto Sans post-install
- Row 24: <userData> = `%APPDATA%\Sei\`

## What the audit did NOT touch (and why)

- Performance comparison mac vs Windows — explicitly out of scope per CONTEXT §deferred.
- IME / fullscreen / multi-monitor — non-blocking polish per CONTEXT §"Scope of 'works'".
- Code-signing — Phase 4 D-Q2 ruled out for v1; SmartScreen warning is accepted UX.
- GitHub Actions matrix — deferred to maintenance phase per CONTEXT §"No GitHub Actions Windows runner yet".
- Linux end-to-end smoke — best-effort per Phase 4 D-60.
