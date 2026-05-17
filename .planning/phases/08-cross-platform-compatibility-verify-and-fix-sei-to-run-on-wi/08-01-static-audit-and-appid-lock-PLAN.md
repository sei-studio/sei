---
phase: 08-cross-platform-compatibility
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - .planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-HOTSPOTS.md
  - electron-builder.yml
autonomous: true
requirements: []
must_haves:
  truths:
    - "Every cross-platform-sensitive source file is enumerated in 08-HOTSPOTS.md with status (SAFE / SUSPECT / FIX-INLINE / DEFER-TO-LIVE)"
    - "Static-discoverable defects (raw path-string concat, missing platform branches, write-side line-ending hardcoding) either ship as inline fixes in this plan OR are explicitly logged in 08-HOTSPOTS.md with the rationale for deferral to Wave 2/3"
    - "electron-builder.yml appId is locked to a real reverse-DNS value (com.sei.app) — the placeholder `app.sei.placeholder` and its `# TODO(lock-before-signing)` comment are removed because both are referenced from `app.getPath('userData')` resolution on every platform including Windows"
  artifacts:
    - path: .planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-HOTSPOTS.md
      provides: "Audit table covering paths.ts, botSupervisor.ts, windowChrome.ts, index.ts, ipc.ts, cli/index.js, atomicWrite.js, electron-builder.yml, package.json, fonts.css, renderer logs panel, every src/ file that touches process.platform / os.homedir / env-var / path.* / child_process / utilityProcess.fork — and every Wave-2/3 live-test item"
      contains: "## Hotspot Table"
    - path: electron-builder.yml
      provides: "Locked appId for v1 (com.sei.app) — Windows %APPDATA%\\Sei\\, macOS ~/Library/Application Support/Sei/, Linux ~/.config/Sei/ all derive from productName=Sei + appId=com.sei.app"
      contains: "appId: com.sei.app"
  key_links:
    - from: electron-builder.yml
      to: src/main/paths.ts
      via: "appId + productName both feed app.getPath('userData') across darwin/win32/linux"
      pattern: "appId: com.sei.app"
    - from: 08-HOTSPOTS.md
      to: 08-02 dev smoke + 08-03 packaged smoke
      via: "every DEFER-TO-LIVE row in HOTSPOTS becomes a verification checklist item in Wave 2/3"
      pattern: "DEFER-TO-LIVE"
---

<objective>
Produce a complete static audit of every cross-platform-sensitive file in the codebase, fix anything statically discoverable inline (with atomic commits), and lock the BLOCKING appId in `electron-builder.yml` so `app.getPath('userData')` resolution becomes deterministic on Windows.

Purpose: Wave 2 (live dev smoke) and Wave 3 (live packaged smoke) on a Windows VM need a baseline where every statically-discoverable defect is already fixed AND `%APPDATA%\Sei\` is the deterministic data root. Without the appId lock, the Windows smoke would either land files in `%APPDATA%\app.sei.placeholder\` (Electron uses appId fallback when productName is missing on some platforms) or — worse — silently work in dev but break in packaged build.

Output: `08-HOTSPOTS.md` (single audit document with a row per file + status + finding + remediation); zero or more atomic fix commits for FIX-INLINE rows; `electron-builder.yml` updated to lock `appId: com.sei.app`.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@CLAUDE.md
@.planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-CONTEXT.md
@.planning/phases/04-electron-gui-packaging/04-10-packaging-PLAN.md
@src/main/paths.ts
@src/main/botSupervisor.ts
@src/main/windowChrome.ts
@src/main/index.ts
@src/main/ipc.ts
@src/bot/cli/index.js
@src/bot/brain/storage/atomicWrite.js
@electron-builder.yml
@package.json

<interfaces>
<!-- Key contracts the executor needs. Extracted from codebase + CONTEXT. -->
<!-- These ARE the surface; do not explore further unless a hotspot row demands it. -->

From src/main/paths.ts:
```typescript
// All <userData>/... reads/writes funnel through app.getPath('userData') + path.join.
// Electron's app.getPath('userData') resolves to:
//   - darwin:  ~/Library/Application Support/<productName-or-appId>
//   - win32:   %APPDATA%\<productName-or-appId>      ← productName=Sei wins when set
//   - linux:   $XDG_CONFIG_HOME/<productName-or-appId>  (defaults to ~/.config/<...>)
export const paths = {
  userData: () => userDataOverride ?? app.getPath('userData'),
  configPath: () => path.join(userDataRoot(), 'config.json'),
  charactersDir: () => path.join(userDataRoot(), 'characters'),
  // ... all join-based, no string concat
};
```

From src/main/botSupervisor.ts:73 — botEntryPath():
```typescript
// Packaged: path.join(process.resourcesPath, 'app.asar.unpacked', 'src/bot/index.js')
// Dev:      path.join(__dirname, '../../src/bot/index.js')
// Both use path.join; cross-platform safe.
```

From src/bot/cli/index.js:309-321 — electronUserDataDir():
```javascript
function electronUserDataDir() {
  const APP = 'Sei'
  if (process.platform === 'darwin') return resolve(homedir(), 'Library', 'Application Support', APP)
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA || resolve(homedir(), 'AppData', 'Roaming')
    return resolve(appdata, APP)
  }
  const xdg = process.env.XDG_CONFIG_HOME || resolve(homedir(), '.config')
  return resolve(xdg, APP)
}
// LOCKED to APP='Sei' (productName). MUST stay in sync with electron-builder.yml productName.
```

From src/main/windowChrome.ts:14-25 — platform-branched chrome:
```typescript
process.platform === 'darwin'
  ? { titleBarStyle: 'hiddenInset' }
  : process.platform === 'win32'
    ? { frame: false, titleBarOverlay: { color: '#F6F5F2', symbolColor: '#1A1D24', height: 38 } }
    : { frame: false };
```

From electron-builder.yml (current):
```yaml
# TODO(lock-before-signing) — chosen by user in plan 04-10 task 2 BLOCKING checkpoint
appId: app.sei.placeholder
productName: Sei
```

From src/bot/brain/storage/atomicWrite.js — uses `writeFile(..., 'utf8')` and `rename`. NO explicit '\n' line-ending injection; markdown content callers (owner.js, diary.js, compactor.js) embed '\n' literally in template strings. Round-trip across platforms is BYTE-IDENTICAL because the bot's memory layer never re-formats with os.EOL. SAFE.
</interfaces>

<key_locked_decisions>
- CONTEXT §"Strategy: smoke-test-driven, with light up-front audit" — Wave 1 must enumerate every hotspot but only fix statically-discoverable defects.
- CONTEXT §"Scope of 'works': packaged install path" — the bar to clear in Wave 3 is `%APPDATA%\Sei\` as the user-data root. This requires `productName: Sei` to win over `appId` in Electron's path resolution; that means the appId lock here must NOT step on the productName.
- CONTEXT §canonical_refs: Phase 4 plan 04-10 left the appId BLOCKING `app.sei.placeholder`. Phase 8 resolves it (per planning_context: "Plan 1 of Phase 8 should resolve it (static decision: lock to com.sei.app or similar conventional reverse-DNS appId)").
- The locked appId for v1 is `com.sei.app` — conventional reverse-DNS, no domain-ownership coupling, low collision risk. Matches what Phase 4's RELEASE-NOTES placeholder anticipates.
- CONTEXT §code_context — atomicWrite, paths.ts, botSupervisor.ts, cli/index.js, windowChrome.ts, index.ts, ipc.ts already designed cross-platform-safe per Phase 4 due diligence. Wave 1 confirms this in writing in HOTSPOTS, does not refactor.
</key_locked_decisions>
</context>

<tasks>

<task type="auto" tdd="false">
  <name>Task 1: Produce 08-HOTSPOTS.md — exhaustive cross-platform audit table</name>
  <read_first>
    - .planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-CONTEXT.md (entire file — the §code_context block is the audit seed)
    - src/main/paths.ts
    - src/main/botSupervisor.ts (focus on botEntryPath() at L73 and env injection at L250-254)
    - src/main/windowChrome.ts (L14-25 chrome branches)
    - src/main/index.ts (L123 linux-only basic_text warn; L157 non-darwin quit guard)
    - src/main/ipc.ts (L90-93 app.warnings handler)
    - src/bot/cli/index.js (L300-322 electronUserDataDir)
    - src/bot/brain/storage/atomicWrite.js (entire file — confirms utf8 + no \r\n injection)
    - electron-builder.yml (current state — placeholder appId + Windows nsis target config)
    - package.json (postinstall hook + dist:win script)
    - src/renderer/src/styles/fonts.css (verify @font-face uses /fonts/<file>.woff2 paths — runtime safe but bundle path requires Wave 2 live verification)
  </read_first>
  <behavior>
    The audit MUST cover every file and every "Open questions for plan-phase research to confirm" item from CONTEXT.md §code_context. Each row gets a status: SAFE (verified cross-platform-safe statically), SUSPECT (potentially broken, needs Wave 2/3 live verification — record what to watch for), FIX-INLINE (Task 2 of this plan ships a code fix), DEFER-TO-LIVE (cannot be confirmed without a real Windows machine — Wave 2 or Wave 3 picks up).

    The "Open questions" from CONTEXT §code_context (lines 135–139) MUST each become a row in the table:
    1. `npm install` cleanness on Windows 10 (DEFER-TO-LIVE → Wave 2)
    2. Renderer font loading on Windows (DEFER-TO-LIVE → Wave 2 — verify woff2 files in dist/renderer/assets/ after npm run build)
    3. `\n` vs `\r\n` round-trip on atomic writes (audit atomicWrite.js + every caller — confirms SAFE because writers write literal '\n' and readers split on '\n')
    4. `app.getPath('userData')` Windows resolution matches `%APPDATA%\Sei\` after appId lock (this plan's Task 2 makes it deterministic; DEFER-TO-LIVE final verification → Wave 3)

    Statically-discoverable defects to LOOK FOR (and either FIX-INLINE or document as SAFE):
    - String concat of paths (`'src/' + x` instead of `path.join('src', x)`)
    - Hardcoded `/` separators in paths intended for the local filesystem
    - Hardcoded `\n` injection on the WRITE side that would convert to `\r\n` on Windows and corrupt round-trip diffs (atomicWrite is utf8 binary-faithful — confirm)
    - `os.homedir()` / `process.env.HOME` calls missing the Windows `USERPROFILE` fallback (cli/index.js already uses `homedir()` from node:os which handles all three internally — confirm)
    - Missing platform branches in window chrome / IPC handlers (none found beyond what's already documented — confirm)
    - Stale `app.sei.placeholder` references in any file other than `electron-builder.yml` (grep — if any exist, FIX-INLINE)

    The audit is the foundation for Wave 4's `08-WINDOWS-GUIDE.md`. Make it complete enough that a future Phase 9 engineer can read HOTSPOTS and know exactly which files are cross-platform-safe and which paths to follow when adding new file-touching code.
  </behavior>
  <action>
**Step 1.** Create `.planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-HOTSPOTS.md`. The file structure MUST be:

```markdown
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
```

Write the file verbatim above. Do NOT abbreviate the table — every row is the seed of Wave 2/3's verification checklist.

**Step 2.** Cross-grep verification before committing:

```bash
# Confirm no stale appId references hide elsewhere in the repo.
grep -rn "app.sei.placeholder" --include="*.yml" --include="*.ts" --include="*.js" --include="*.tsx" --include="*.json" --include="*.md" . 2>/dev/null | grep -v node_modules | grep -v ".planning/phases/04-"
```

If the grep finds matches outside `.planning/phases/04-...` and outside electron-builder.yml (which Task 2 fixes), add a row to HOTSPOTS.md and FIX-INLINE.
  </action>
  <verify>
    <automated>bash -c 'F=.planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-HOTSPOTS.md && test -f "$F" && grep -q "^# Phase 8 — Windows Cross-Platform Hotspots Audit" "$F" && grep -q "## Status Legend" "$F" && grep -q "## Hotspot Table" "$F" && grep -q "## Statically-Discovered Defects" "$F" && grep -q "## Deferred-to-Live Summary" "$F" && grep -q "src/main/paths.ts" "$F" && grep -q "src/main/botSupervisor.ts" "$F" && grep -q "src/main/windowChrome.ts" "$F" && grep -q "src/main/index.ts" "$F" && grep -q "src/main/ipc.ts" "$F" && grep -q "src/bot/cli/index.js" "$F" && grep -q "src/bot/brain/storage/atomicWrite.js" "$F" && grep -q "electron-builder.yml" "$F" && grep -q "package.json" "$F" && grep -q "fonts.css" "$F" && grep -q "FIX-INLINE" "$F" && grep -q "DEFER-TO-LIVE" "$F" && grep -q "SAFE" "$F" && grep -q "SUSPECT" "$F" && grep -q "Wave 2" "$F" && grep -q "Wave 3" "$F" && grep -q "%APPDATA%" "$F" && grep -q "asarUnpack" "$F" && grep -q "atomicWrite" "$F" && grep -q "com.sei.app" "$F"'</automated>
  </verify>
  <acceptance_criteria>
    - `08-HOTSPOTS.md` exists at `.planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-HOTSPOTS.md`
    - File has sections: "Status Legend", "Hotspot Table", "Statically-Discovered Defects (FIX-INLINE Summary)", "Deferred-to-Live Summary"
    - Hotspot Table references all 10 source files from the read_first list AT MINIMUM: `src/main/paths.ts`, `src/main/botSupervisor.ts`, `src/main/windowChrome.ts`, `src/main/index.ts`, `src/main/ipc.ts`, `src/bot/cli/index.js`, `src/bot/brain/storage/atomicWrite.js`, `electron-builder.yml`, `package.json`, `fonts.css`
    - Each of the four CONTEXT §code_context "open questions" appears as its own row in the table
    - Every Wave-2 and Wave-3 verification target is enumerated in the "Deferred-to-Live Summary"
    - File mentions `%APPDATA%`, `asarUnpack`, `atomicWrite`, `com.sei.app` (the locked appId — referenced even though Task 2 makes the actual yml change)
    - At least one FIX-INLINE row exists (the appId placeholder; more if grep finds stale references)
    - At least one SUSPECT row exists (the fonts.css runtime/bundle verification)
  </acceptance_criteria>
  <done>Audit document committed. Wave 2/3 has its checklist seed. No statically-discoverable defects remain unaddressed.</done>
</task>

<task type="auto" tdd="false">
  <name>Task 2: Lock electron-builder.yml appId to com.sei.app (closes Phase 4 04-10 BLOCKING)</name>
  <read_first>
    - electron-builder.yml (current state — placeholder appId)
    - .planning/phases/04-electron-gui-packaging/04-10-packaging-PLAN.md (the BLOCKING task this resolves)
    - .planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-CONTEXT.md §specifics (the bullet on appId)
    - .planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-HOTSPOTS.md row 12 (just written by Task 1)
  </read_first>
  <behavior>
    Replace `appId: app.sei.placeholder` with `appId: com.sei.app` in electron-builder.yml. Remove the `# TODO(lock-before-signing) — chosen by user in plan 04-10 task 2 BLOCKING checkpoint` comment line. Preserve everything else in the file verbatim (productName: Sei, copyright, directories, files, asar, asarUnpack, mac block, dmg block, win block, nsis block, linux block).

    Rationale (documented inline as a comment replacing the TODO):
    - `com.sei.app` is conventional reverse-DNS, no domain-ownership requirement, low collision risk on Apple Developer / Windows registries.
    - `productName: Sei` stays — Electron's `app.getPath('userData')` uses productName when set, so Windows lands in `%APPDATA%\Sei\` and macOS in `~/Library/Application Support/Sei/`, matching `src/bot/cli/index.js:electronUserDataDir` which hardcodes `APP='Sei'`.
    - This is the LAST chance to change appId before any signed/packaged release strands existing users' Keychain entries. Phase 8 locks it because Phase 9 (custom skins setup wizard) will reference `%APPDATA%\Sei\` as a hard contract.
  </behavior>
  <action>
**Step 1.** Edit `electron-builder.yml`. The exact edit:

REPLACE these two lines (currently lines 10-11):
```yaml
# TODO(lock-before-signing) — chosen by user in plan 04-10 task 2 BLOCKING checkpoint
appId: app.sei.placeholder
```

WITH these two lines:
```yaml
# Locked 2026-05-17 (Phase 8 Plan 01 Task 2 — resolves Phase 4 04-10 BLOCKING).
appId: com.sei.app
```

Do NOT touch any other line. `productName: Sei` stays — it determines the on-disk user-data directory name on every platform.

**Step 2.** Confirm with a focused grep:

```bash
grep -n "^appId:" electron-builder.yml
# Expect exactly one line: `appId: com.sei.app`

grep -n "^productName:" electron-builder.yml
# Expect exactly one line: `productName: Sei`

grep -n "app.sei.placeholder" electron-builder.yml
# Expect ZERO matches.

grep -n "TODO(lock-before-signing)" electron-builder.yml
# Expect ZERO matches (the placeholder TODO is gone; the mac.identity TODO comment at L36-37 STAYS because Apple Developer cert is a separate user-side concern).
```

The mac.identity TODO (line 36-37 in current file: `# TODO(lock-before-signing) — set to user's actual Apple Developer identity`) is SEPARATE from the appId TODO and stays untouched — it tracks a different blocker (the Apple Developer cert) that Phase 8 does not own.

**Step 3.** Sanity check: confirm Electron's userData resolution by referencing the official mapping in HOTSPOTS row 1. With `productName: Sei` AND `appId: com.sei.app`:
- Windows: `%APPDATA%\Sei\` (productName wins over appId for path naming)
- macOS: `~/Library/Application Support/Sei/`
- Linux: `~/.config/Sei/`

This matches `src/bot/cli/index.js:electronUserDataDir` hardcoded `APP = 'Sei'`. No code change needed in CLI.

DO NOT run `npm run dist:win` here — that's Wave 3 on a Windows VM. DO NOT run `npm run build` here either — Phase 4 Plan 04-10 already verified that pipeline; re-running it on macOS gains nothing new.
  </action>
  <verify>
    <automated>bash -c 'grep -q "^appId: com.sei.app$" electron-builder.yml && grep -q "^productName: Sei$" electron-builder.yml && ! grep -q "app.sei.placeholder" electron-builder.yml && ! grep -q "TODO(lock-before-signing) — chosen by user in plan 04-10" electron-builder.yml && grep -q "^# Locked 2026-05-17 (Phase 8 Plan 01 Task 2 — resolves Phase 4 04-10 BLOCKING)\\.$" electron-builder.yml && grep -q "asarUnpack:" electron-builder.yml && grep -q "hardenedRuntime: true" electron-builder.yml && grep -q "AppImage" electron-builder.yml && grep -q "perMachine: false" electron-builder.yml'</automated>
  </verify>
  <acceptance_criteria>
    - `electron-builder.yml` line `appId: com.sei.app` is present (exactly one match)
    - `electron-builder.yml` line `productName: Sei` is present (exactly one match)
    - `electron-builder.yml` does NOT contain `app.sei.placeholder` anywhere
    - `electron-builder.yml` does NOT contain `TODO(lock-before-signing) — chosen by user in plan 04-10` (the appId TODO is gone)
    - `electron-builder.yml` contains a new comment `# Locked 2026-05-17 (Phase 8 Plan 01 Task 2 — resolves Phase 4 04-10 BLOCKING).` directly above the `appId:` line
    - Everything else in `electron-builder.yml` is unchanged: `asarUnpack`, `hardenedRuntime: true`, `AppImage`, `perMachine: false` all still present
    - The mac.identity TODO (separate concern: Apple Developer cert) is NOT removed (it remains a Phase-9-or-later concern)
  </acceptance_criteria>
  <done>Phase 4 04-10 BLOCKING is closed. `app.getPath('userData')` resolution is deterministic on Windows. Wave 3 packaged smoke can confirm `%APPDATA%\Sei\` is the data root with no further code changes needed.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| repo → first packaged Windows installer | The appId locked here becomes the irrevocable Windows + macOS Keychain partition for every existing-and-future user. |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-08-01 | Tampering | future appId change post-release strands every existing Keychain entry on Windows and macOS | mitigate | Lock once now (com.sei.app), document the irreversibility in `08-HOTSPOTS.md` row 12 and in RELEASE-NOTES (Wave 4). No future plan changes appId without an explicit migration story. |
| T-08-02 | Information Disclosure | audit document accidentally records secrets (paths with usernames, API keys, env values) | mitigate | The audit only references file paths from the codebase and constants from electron-builder.yml. No env-var values, no user-specific paths. Reviewer (executor) scans the file for `/Users/` or `C:\Users\` strings before committing — none should appear. |
| T-08-03 | Repudiation | audit row gets stale (a future code change breaks a SAFE invariant; HOTSPOTS still says SAFE) | accept | Wave 4 docs (08-WINDOWS-GUIDE.md) cites HOTSPOTS as a snapshot; future cross-platform changes are responsible for re-auditing. Not Phase 8's scope to enforce. |
| T-08-04 | Spoofing | `com.sei.app` collision with another developer's appId on Apple Developer | accept | Apple Developer Program does not enforce unique appId across developers — only within an account. com.sei.app is unique enough for a single-developer project and conventional. If collision becomes a problem post-launch, that's a v1.1 rebrand story; not Phase 8's scope. |
</threat_model>

<verification>
- 08-HOTSPOTS.md exists with all required sections and rows.
- electron-builder.yml has `appId: com.sei.app` and no `app.sei.placeholder`.
- `productName: Sei` is preserved (drives `%APPDATA%\Sei\` resolution).
- All Wave 2/3 deferred items are listed in the audit for downstream waves to pick up.
</verification>

<success_criteria>
- A future engineer reading `08-HOTSPOTS.md` can know exactly which files are cross-platform-safe and where to look first for any Windows regression.
- Wave 2 (dev smoke) and Wave 3 (packaged smoke) executors have a deterministic checklist of items to verify on a Windows VM.
- `electron-builder.yml` is ready to produce a Windows installer that lands files in `%APPDATA%\Sei\` matching the CLI's `electronUserDataDir()` resolution — no future appId drift will break that contract.
- Phase 4 Plan 04-10's BLOCKING task is closed. Phase 9's setup wizard (which depends on `%APPDATA%\Sei\` as the install root) has a stable contract to build on.
</success_criteria>

<output>
After completion, create `.planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-01-SUMMARY.md` documenting:
- Number of hotspot rows recorded, broken down by SAFE / SUSPECT / FIX-INLINE / DEFER-TO-LIVE
- Any FIX-INLINE rows beyond the appId lock (if Task 1 grep found additional stale references)
- Confirmation that `appId: com.sei.app` is locked in electron-builder.yml
- Pointer to Wave 2 (Plan 08-02) for live dev smoke and Wave 3 (Plan 08-03) for live packaged smoke
- Note that the mac.identity TODO comment (Apple Developer cert) remains open and is NOT part of Phase 8 scope
</output>
