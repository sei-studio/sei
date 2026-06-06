---
name: phase-08-context
phase: 8
description: Windows cross-platform compatibility — locked context for planning
gathered: 2026-05-17
mode: --auto (recommended defaults selected, see DISCUSSION-LOG.md)
status: Ready for planning
---

# Phase 8: Windows Cross-Platform Compatibility — Context

**Gathered:** 2026-05-17
**Depends on:** Phase 7 (per ROADMAP)
**Blocks:** Phase 9 (Custom bot skins) — Phase 9's setup wizard requires that the rest of Sei already runs cleanly on Windows before adding more cross-platform surface area.

<domain>
## Phase Boundary

Sei currently runs and is tested only on macOS. This phase: get Sei running on Windows (10+) end-to-end so Phase 9 can build its setup wizard on a known-good cross-platform substrate.

**In scope:**
- Full `npm run dev` works on Windows: Electron main launches, renderer paints, bot utilityProcess forks, mineflayer connects to a LAN world, persona expands, bot spawns + chats.
- Full packaged `.exe` build via `npm run dist:win` runs on a clean Windows box and completes the same smoke path.
- All platform-sensitive code paths audited: `paths.ts`, `electronUserDataDir()` in CLI, `botEntryPath()` resource resolution, any `spawn`/`exec` calls, file-path string handling, env-var lookups (`HOME` vs `USERPROFILE` vs `APPDATA`).
- Native module rebuild: `electron-builder install-app-deps` + `@electron/rebuild` postinstall verified clean on Windows.
- Document Windows install/run flow in `README.md` + `RELEASE-NOTES.md` (matches Phase 4 plan 04-11 pattern).
- Optional: GitHub Actions matrix entry for Windows so future regressions are caught automatically. (See decisions for default.)

**Out of scope (this phase):**
- Linux compat beyond best-effort — AppImage target stays as-is from Phase 4 (D-60). Not blocking Phase 9.
- Setup-wizard work, MC-install detection, Fabric Loader install — all live in Phase 9.
- Code-signing the Windows installer (Phase 4 D-Q2 decided to ship unsigned v1; SmartScreen warning is accepted UX).
- Windows-specific UX polish (font fallback, dark-mode title bar adjustments) — log if discovered, defer to a polish phase unless it blocks the smoke path.
- Performance comparison mac vs Windows — out of scope.
- Auto-update — already out of scope per D-63.

</domain>

<decisions>
## Implementation Decisions

### Strategy: smoke-test-driven, with light up-front audit

The phase runs in this order:

1. **Static audit pass** (Wave 1) — read every file touched by `process.platform`, `os.homedir`, env-var lookups, `path.*`, `child_process.*`, `utilityProcess.fork`, and resource-path resolution. Build a short "Windows hotspots" doc listing each finding and whether it's pre-emptively safe (already uses `path.join` etc.) or suspect. The existing audit:
   - `src/main/paths.ts` — funnels through `app.getPath('userData')`. Safe by design.
   - `src/main/botSupervisor.ts:73` — `botEntryPath()` uses `path.join` and `process.resourcesPath`. Safe.
   - `src/bot/cli/index.js:300-322` — `electronUserDataDir()` has explicit `darwin`/`win32`/linux branches with correct env-var fallbacks. Safe.
   - `src/main/windowChrome.ts:14-17` — `process.platform === 'darwin'/'win32'` chrome branching. Safe.
   - `src/main/index.ts:123,157` — linux-only branches + non-darwin guard. Safe.
   - `src/main/ipc.ts:92` — linux-only branch. Safe.
   - No `child_process.spawn`/`exec` calls in `src/`. utilityProcess.fork uses cross-platform Electron API.
   - No native deps requiring rebuild (mineflayer is pure JS; no better-sqlite3 / no sharp). Only Electron itself.

   Audit output goes to `08-HOTSPOTS.md` (or equivalent) in the phase dir.

2. **Smoke test on Windows** (Wave 2) — actually run Sei on a Windows 10+ box (VM or bare metal). Two passes:
   - Dev pass: `npm install` → `npm run dev` → walk through onboarding → summon a bot to a vanilla LAN world → exchange chat → terminate cleanly.
   - Packaged pass: `npm run dist:win` → install the resulting NSIS installer on a clean Windows VM → same smoke path. (Matches Phase 4 plan 04-11 clean-VM validation pattern.)

3. **Fix what breaks** (Wave 3) — file an issue per discovered defect in `08-WINDOWS-DEFECTS.md`, then fix each with a small dedicated commit, ideally one commit per defect. Re-run the smoke pass until clean.

4. **Document** (Wave 4) — update `README.md` with the Windows install instructions, add a "Windows" section to `RELEASE-NOTES.md`, and write a brief `08-WINDOWS-GUIDE.md` that lists every platform-sensitive file and the convention it follows. Becomes a reference for Phase 9.

### Audit + smoke (not audit-only)

Static analysis catches obvious bugs (string concatenation of paths, hardcoded `/`, missing platform branches) but cannot catch interaction bugs like the Phase 4 `botEntryPath` regression where a path was `path.join`-correct but resolved to the wrong tree. Real Windows execution is non-negotiable for this phase.

### No GitHub Actions Windows runner yet

Phase 4's clean-VM validation was manual per RELEASE-NOTES. Setting up a Windows CI matrix is a meaningful chunk of YAML + concurrency tuning and is best done after the codebase is known to work on Windows. Defer to a maintenance phase unless smoke testing finds the regression surface large enough to justify CI now.

### Scope of "works": packaged install path

Bar to clear:
1. NSIS installer from `npm run dist:win` installs cleanly on a fresh Windows 10/11 VM (no admin prompts beyond SmartScreen warning).
2. Sei launches from Start Menu.
3. First-launch onboarding completes (API key entry, persona seed).
4. User can summon a bot to a vanilla LAN world, exchange a few chat lines, see persona reactions, and disconnect cleanly.
5. `<userData>` files (config.json, characters/, api_key.bin, logs/) land in `%APPDATA%\Sei\` and persist across relaunch.
6. Bot's debug logs reach the renderer log panel (no broken IPC/path bridging).

Anything else (skin upload, multi-monitor quirks, IME edge cases, fullscreen behavior) is non-blocking — log it for future polish.

### Native module strategy: trust the toolchain

`@electron/rebuild` runs in postinstall and `electron-builder install-app-deps` reruns it during packaging. We have zero native deps right now beyond Electron itself. The only failure mode is Electron's own ABI per arch — handled by setting `arch: [x64]` in `win.target` in electron-builder.yml (already configured). If a future native dep gets added (V2 SQLite per MEM-05), it inherits the existing rebuild plumbing.

### Windows version baseline: Windows 10+ x64 only

Electron 42 (current dep) drops support for Windows 7/8, so anything below Win10 is out. No ARM Windows target for v1 (would need a separate `arch: [arm64]` entry and a separate test surface).

### Defect handling: small atomic commits, dedicated log

Each Windows-only defect gets:
- Entry in `08-WINDOWS-DEFECTS.md` (id, symptom, root cause, fix commit hash)
- Its own commit named `fix(08-win): <short description>`
- Re-test on Windows before moving on

This matches the Phase 03.1 defect-log pattern that worked well.

### Claude's Discretion

- Specific Windows VM choice (Parallels / UTM / Multipass / a colleague's loaner box) — user picks based on availability.
- Whether to capture a screencast or just write a text-based smoke log.
- Whether to add a Windows-only npm script (`sei:win`) for any platform-specific dev convenience.
- Exact format of `08-HOTSPOTS.md` (table vs prose) — Claude picks.
- Whether to also smoke-test on Windows 11 specifically vs only Windows 10 — Claude picks based on VM availability.
- Whether to run linux smoke test opportunistically (AppImage) — non-blocking, do it only if cheap.

</decisions>

<code_context>
## Existing Code Insights

**Already cross-platform-safe (Phase 4 due diligence):**
- `src/main/paths.ts` — all `<userData>/...` paths funnel through `app.getPath('userData')` + `path.join`. Single point of override for tests. Already designed for both platforms.
- `src/main/botSupervisor.ts:73` — `botEntryPath()` uses `path.join(process.resourcesPath, 'app.asar.unpacked', 'src/bot/index.js')` in packaged mode and `path.join(__dirname, '../../src/bot/index.js')` in dev. Both work on Windows.
- `src/bot/cli/index.js:308-322` — `electronUserDataDir()` already has correct branches for `darwin`/`win32`/linux with proper env-var fallbacks (`APPDATA` / `XDG_CONFIG_HOME`).
- `electron-builder.yml` — Windows target already configured: `nsis`, `arch: [x64]`, `oneClick: false`, `perMachine: false`, `allowToChangeInstallationDirectory: true`. NSIS installer ready out of the box.
- `package.json` — `dist:win` script already wired. `postinstall: electron-builder install-app-deps` handles ABI per platform.
- `electron-vite.config.ts` — uses standard cross-platform config; no `__dirname` hardcoding.

**No native deps that need rebuild attention.** Only Electron itself. Means no node-gyp toolchain dependency on Windows beyond what electron-builder bundles.

**Platform-branched code (already correctly branched, but verify on real Windows):**
- `src/main/windowChrome.ts:14-17` — title-bar / chrome behavior
- `src/main/index.ts:123,157` — Linux-only `basic_text` backend path + non-darwin window-all-closed-quit guard
- `src/main/ipc.ts:92` — Linux + `basic_text` adjustment

**Test surface:**
- 20+ `test-*.mjs` files in `test/` and `scripts/` directories. All pure-Node, no platform-specific shell. Should run on Windows via `node test-*.mjs` without changes. Worth running on Windows once as smoke.

**Open questions for plan-phase research to confirm:**
- Does `npm install` complete cleanly on a fresh Windows 10 box without errors? (electron-builder pulls platform-specific binaries on first install.)
- Does the renderer's font loading work on Windows? (`src/renderer/src/styles/fonts.css` uses imported font files — verify they bundle into dist.)
- Are there any `'\n'` vs `'\r\n'` issues in atomic file writes (`atomicWrite` helper in `src/bot/brain/storage/`)? Markdown files written on Windows + read on macOS should round-trip without diff churn.
- Does `app.getPath('userData')` resolve to `%APPDATA%\Sei` (note: capital "S") matching the placeholder appId in electron-builder.yml, or to something else if appId gets locked to a different value? The BLOCKING `appId` task from Phase 4 plan 04-10 is still open (`app.sei.placeholder`) — flag whether locking that should happen as part of Phase 8 or stay pending.

</code_context>

<specifics>
## Specific Ideas

- Phase 4 plan 04-11 (`04-11-clean-vm-validation-PLAN.md`) is the reference for clean-VM validation pattern. Re-read before planning Wave 2.
- Phase 03.1's defect-driven plan (37 cataloged defects across 10 plans) is the reference for `08-WINDOWS-DEFECTS.md` structure.
- `electron-builder install-app-deps` (the postinstall hook) MUST run on the Windows machine. If a user clones the repo on macOS, copies `node_modules/` to Windows, things will break. Document this clearly in the Windows section of README.
- The placeholder `appId: app.sei.placeholder` in electron-builder.yml is BLOCKING per Phase 4 plan 04-10. Locking it changes `app.getPath('userData')` resolution on every platform. Consider whether Phase 8 should resolve this or document the dependency on Phase 9.
- The README's current "Install / Run" section is macOS-focused. A "Windows install" section should mirror it, plus a "Known limitations" subsection (SmartScreen warning is the main one).
- Optional: snag a screencast of the Windows smoke pass for the Sei release page — nice for the launch, not required.

</specifics>

<canonical_refs>
## Canonical References

- `.planning/phases/04-electron-gui-packaging/04-11-clean-vm-validation-PLAN.md` — Phase 4 clean-VM validation pattern. Mirror its structure for Wave 2 smoke test plans.
- `.planning/phases/04-electron-gui-packaging/04-10-packaging-PLAN.md` — packaging plan with the BLOCKING `appId` lock checkpoint. Phase 8 must decide: resolve here or defer.
- `.planning/phases/04-electron-gui-packaging/04-RESEARCH.md` — original electron-builder + cross-platform research. §"Pattern 1" describes utilityProcess.fork on Windows.
- `.planning/phases/09-implement-custom-bot-skins-via-customskinloader-mod-first-la/CONTEXT.md` — Phase 9 context that depends on this phase. Cross-platform path table in §"Cross-platform paths" is the spec Phase 9 expects Phase 8 to deliver.
- `electron-builder.yml` (repo root) — Windows target config, already wired.
- `package.json` — `dist:win` script + postinstall rebuild hook.
- `src/main/paths.ts` — canonical userData resolution. Reference for any new file-path code.
- `src/bot/cli/index.js:308-322` — `electronUserDataDir()` reference implementation for platform-aware path helpers used outside the Electron context.
- Electron docs: https://www.electronjs.org/docs/latest/api/app#appgetpathname — `app.getPath` per-platform table.
- electron-builder docs: https://www.electron.build/configuration/win — Windows target options.
- @electron/rebuild docs: https://github.com/electron/rebuild — native module rebuild flow.

</canonical_refs>

<deferred>
## Deferred Ideas

- **Windows code-signing** (Phase 4 D-Q2 ruled this out for v1). Revisit when there's demonstrable demand and a budget for a signing cert.
- **GitHub Actions Windows CI matrix** — set up after manual smoke pass is clean. Best done in a maintenance phase once the defect rate stabilizes.
- **Linux end-to-end smoke** — Phase 4 D-60 already deferred Linux to best-effort. AppImage build can be smoke-tested opportunistically but isn't blocking.
- **ARM64 Windows target** — niche audience; defer until a user actually asks.
- **Performance benchmarking mac vs Windows** — not in this phase. If a glaring perf regression shows up during smoke testing, log it; otherwise defer.
- **Windows 7/8 support** — out per Electron 42's minimum. Don't backport.

</deferred>
