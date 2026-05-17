---
phase: 08-cross-platform-compatibility
plan: 02
type: execute
wave: 2
depends_on: [01]
files_modified:
  - .planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-DEV-SMOKE.md
  - .planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-WINDOWS-DEFECTS.md
autonomous: false
requirements: []
human_action: "User must run `npm install` then `npm run dev` on a real Windows 10/11 x64 machine or VM, walk through the smoke flow defined in Task 1, and paste the per-checkpoint outcome (PASS / FAIL with stderr tail) back to the executor. The macOS executor agent CANNOT perform this work — `npm run dev` would launch Electron on macOS, not Windows. The Wave 1 audit listed every DEFER-TO-LIVE row to verify on Windows; this plan is that verification."
user_setup:
  - service: windows-vm
    why: "Cross-platform smoke testing requires a real Windows 10/11 x64 host (bare-metal or VM via Parallels / UTM / VMware / VirtualBox / cloud)"
    env_vars: []
    dashboard_config:
      - task: "Install Node.js 20 LTS on the Windows machine (from https://nodejs.org/en/download — the .msi installer)"
        location: "Windows host"
      - task: "Install Git for Windows (from https://git-scm.com/download/win)"
        location: "Windows host"
      - task: "Clone the Sei repo: `git clone <repo-url> sei && cd sei`"
        location: "PowerShell or Git Bash on Windows"
      - task: "Have a separate Minecraft Java Edition install on the SAME LAN as the Windows machine (or in a Minecraft installation on the Windows host itself) open to LAN with cheats on"
        location: "Minecraft client (the host that opens the LAN world)"
      - task: "Have a valid Anthropic API key ready (sk-ant-... — paste into onboarding step 4 during the smoke flow)"
        location: "Anthropic Console → API Keys"
must_haves:
  truths:
    - "`npm install` completes on a fresh Windows 10/11 x64 box with NO errors and NO node-gyp / native-module rebuild output (zero native deps in v1)"
    - "`npm run dev` launches Electron main, the renderer paints, and the loading screen → onboarding flow renders correctly with Windows title-bar overlay chrome (frame:false + titleBarOverlay per src/main/windowChrome.ts)"
    - "Onboarding step 4 accepts a real Anthropic API key, hasApiKey() returns true after save, and the key is persisted in `%APPDATA%\\Sei\\api_key.bin` (DPAPI-encrypted via safeStorage; the Linux-fallback banner from src/main/ipc.ts:90 MUST NOT appear)"
    - "Bot summon path works on Windows in dev: LAN watcher (`src/main/lanWatcher.ts`) sees the Minecraft LAN multicast on the local network, the LAN pill flips to CONNECTED, summoning a character forks the utilityProcess against `path.join(__dirname, '../../src/bot/index.js')`, mineflayer spawns into the LAN world, and the bot exchanges at least one chat turn before clean stop"
    - "Memory files (OWNER.md, DIARY.md, MEMORY.md, AFFECT.md) written to `%APPDATA%\\Sei\\memory\\<characterId>\\` round-trip BYTE-IDENTICAL when copied to a macOS machine (no `\\r\\n` injection from atomicWrite on Windows)"
    - "Every Wave-2 row from `08-HOTSPOTS.md` "Deferred-to-Live Summary" section is checked off in `08-DEV-SMOKE.md` with PASS / FAIL / N/A and a one-line evidence string per row"
    - "Any defect discovered during the smoke is recorded as a new row in `08-WINDOWS-DEFECTS.md` with id (`WIN-DEFECT-NN`), symptom, root-cause hypothesis, and Wave-3 fix-plan pointer"
  artifacts:
    - path: .planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-DEV-SMOKE.md
      provides: "Windows dev smoke checklist with PASS/FAIL per row, dated, captured directly from the live test session"
      contains: "## Dev Smoke Checklist"
    - path: .planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-WINDOWS-DEFECTS.md
      provides: "Defect log seeded by Wave 2 (and grown by Wave 3); each row gets a small atomic fix commit during Wave 3"
      contains: "## Defect Log"
  key_links:
    - from: 08-HOTSPOTS.md (Wave 1 output)
      to: 08-DEV-SMOKE.md
      via: "every Wave-2 row from the Deferred-to-Live Summary becomes a PASS/FAIL line in DEV-SMOKE"
      pattern: "PASS|FAIL|N/A"
    - from: 08-DEV-SMOKE.md
      to: 08-WINDOWS-DEFECTS.md
      via: "any FAIL row gets a defect entry"
      pattern: "WIN-DEFECT-"
---

<objective>
Run Sei in DEV mode (`npm run dev`) on a fresh Windows 10/11 x64 host and verify every Wave-2 row from the `08-HOTSPOTS.md` audit lands correctly. Discover any Windows-only defects that static audit could not catch — utilityProcess fork bugs, LAN multicast bridging, font bundling, title-bar overlay rendering, DPAPI safeStorage. Capture per-row PASS/FAIL evidence in `08-DEV-SMOKE.md` and seed `08-WINDOWS-DEFECTS.md` with anything that fails.

Purpose: Static audit (Wave 1) catches what can be grepped. Live dev smoke catches what cannot — the bug in `botEntryPath()` dev-mode resolution (the 260508-mun regression in `src/main/botSupervisor.ts:73-88` was `path.join`-correct but resolved to the wrong tree); the multicast-NAT silent-fail (WARNING-9 in Phase 4 04-11); the renderer font bundling that's path-shape-correct but may miss files in dist/. The dev pass also unblocks Wave 3 (packaged smoke) — if `npm run dev` is broken on Windows, `npm run dist:win` will also be broken, and there's no point packaging until dev works.

Output: `08-DEV-SMOKE.md` with full per-row results (timestamped); zero-or-more new rows in `08-WINDOWS-DEFECTS.md` that Wave 3 will pick up and fix.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@CLAUDE.md
@.planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-CONTEXT.md
@.planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-HOTSPOTS.md
@.planning/phases/04-electron-gui-packaging/04-11-clean-vm-validation-PLAN.md
@src/main/paths.ts
@src/main/windowChrome.ts
@src/main/botSupervisor.ts
@electron-builder.yml
@package.json

<interfaces>
<!-- Wave-2 verification targets from 08-HOTSPOTS.md "Deferred-to-Live Summary" -->
<!-- Each row below maps directly to a HOTSPOTS row id -->

Row 3 — bot child reads correct SEI_USER_DATA on Windows
  Where: src/main/botSupervisor.ts L250-254 sets env.SEI_USER_DATA; bot child reads it.
  Expected: bot's `userDataDir` (per src/bot/index.js's init handshake) equals `C:\Users\<user>\AppData\Roaming\Sei`.

Row 4 — Windows title bar overlay
  Where: src/main/windowChrome.ts L16-22 sets frame:false + titleBarOverlay { color:'#F6F5F2', symbolColor:'#1A1D24', height:38 }.
  Expected: title bar shows minimize/maximize/close buttons in the configured colors; window is draggable.

Row 6 — closing window quits app
  Where: src/main/index.ts L157 `app.on('window-all-closed', ...)`.
  Expected: closing the BrowserWindow on Windows kills the Electron process (Task Manager shows no Sei.exe leftover).

Row 7 — preload loads
  Where: src/main/index.ts L42-45 `preloadPath()` returns `path.join(__dirname, '../preload/index.cjs')`.
  Expected: DevTools console on the renderer shows the contextBridge API available (e.g., `window.sei` or whatever bridge name preload defines).

Row 8 — renderer paints
  Where: src/main/index.ts L48-54 `rendererTarget()`; electron-vite serves http://localhost:<port> in dev.
  Expected: Sei loading screen renders, then transitions to Onboarding step 0.

Row 9 — no Linux-fallback banner
  Where: src/main/ipc.ts L88-93 `app.warnings` returns `{ keychainFallbackPlaintext: process.platform === 'linux' && backendKind() === 'basic_text' }`.
  Expected: on Windows, returns false. No yellow KEYCHAIN_FALLBACK_PLAINTEXT banner appears at top of window.

Row 11 — memory file round-trip
  Where: src/bot/brain/storage/atomicWrite.js + memory writers.
  Expected: after summon, files at `%APPDATA%\Sei\memory\<id>\OWNER.md` and `DIARY.md` use `\n` line endings (NOT `\r\n`). Copy to mac, `diff` shows zero changes.

Row 15 — npm install completes
  Where: package.json postinstall hook `electron-builder install-app-deps`.
  Expected: `npm install` exits 0, no `node-gyp` invocation (no native deps in v1), electron Windows prebuild downloads correctly.

Row 17 — fonts load
  Where: src/renderer/src/styles/fonts.css `@font-face { src: url('/fonts/<file>.woff2') }`.
  Expected: DevTools Network tab shows `noto-sans-400.woff2` etc. fetched with 200 OK; computed font on body element is "Noto Sans", NOT a browser default.

Row 19 — no node-gyp output
  Where: npm install on Windows.
  Expected: zero "node-gyp" / "binding.gyp" / "MSBuild" output in install log.

Row 21 — npm install cleanness (overall)
  Same as row 15, with additional emphasis on the electron-builder prebuild fetch (Electron 42 Windows x64).

Row 22 — renderer font + dev paint
  Composite of rows 8 + 17 from the live perspective.

Row 23 — \n vs \r\n round-trip
  Same as row 11.
</interfaces>

<key_locked_decisions>
- CONTEXT §"Audit + smoke (not audit-only)" — live Windows execution is non-negotiable for this phase.
- CONTEXT §"Specific Windows VM choice ... user picks" — user owns the VM/host choice; the task does NOT prescribe Parallels vs UTM vs bare metal.
- planning_context "static audit only, defer verification" — Wave 2 is autonomous: false. The executor MUST NOT attempt to run `npm install` / `npm run dev` because the executor runs on macOS. The plan provides a step-by-step user-facing script; the user runs it on Windows and pastes results back.
- WARNING-9 from Phase 4 04-11 — Minecraft LAN multicast is NAT-bridged inconsistently. If the Windows VM uses default NAT, the LAN pill MAY stay NOT CONNECTED even when Minecraft is open to LAN on the host. Acceptable resolution paths: (a) bare-metal Windows on the same LAN as the MC host, (b) bridged-network VM, (c) skip live-summon and mark row as DEFER-TO-WAVE-3 in DEV-SMOKE (Wave 3 packaged smoke gets one more shot).
- CONTEXT §"Defect handling: small atomic commits, dedicated log" — every defect found gets a `WIN-DEFECT-NN` id, an entry in `08-WINDOWS-DEFECTS.md`, and is FIXED in Wave 3 with its own commit `fix(08-win): <description>`.
</key_locked_decisions>
</context>

<tasks>

<task type="checkpoint:human-action" gate="blocking">
  <name>Task 1: USER runs npm install + npm run dev on Windows, walks the smoke flow, records results</name>
  <what-built>
    Wave 1 Plan 01 produced `08-HOTSPOTS.md` with a "Deferred-to-Live Summary — Wave 2" checklist. This task is the user-driven execution of that checklist on a real Windows 10/11 x64 host. The executor (Claude on macOS) CANNOT run Electron on Windows — `npm run dev` from this macOS shell would spawn Electron-for-darwin, not Electron-for-win32. The whole point of Wave 2 is that this must happen on Windows.

    Why human-action (not human-verify):
    - The work itself (installing Node 20, cloning the repo, running npm install, running npm run dev, opening Minecraft on the same LAN, summoning a bot) happens on the user's machine. No Claude-driven automation in the loop.
    - There is no CLI/API that lets a macOS-host Claude reach into a Windows VM and execute `npm install` there (this is NOT a "deploy" task where a CLI exists; it's a per-host dev environment setup).
    - SmartScreen on Windows + multicast LAN bridging are user-interactive concerns by their nature.

    Output of this task is a fully-filled `08-DEV-SMOKE.md` artifact and any defect rows appended to `08-WINDOWS-DEFECTS.md`. The user authors both documents inline as they go (or, equivalently, pastes their session log back to Claude who transcribes it).
  </what-built>
  <how-to-verify>
**On the WINDOWS machine (PowerShell or Git Bash):**

```powershell
# 1. Confirm prerequisites
node --version       # Expect v20.x.x or higher
npm --version        # Expect v10.x.x or higher
git --version        # Expect any version

# 2. Clone the repo (or pull latest if already cloned)
git clone <repo-url> sei
cd sei

# 3. Install dependencies — FRESH (delete any pre-existing node_modules)
Remove-Item -Recurse -Force node_modules -ErrorAction SilentlyContinue
Remove-Item package-lock.json -ErrorAction SilentlyContinue
npm install

# Expected: completes successfully, exit code 0.
# Watch for:
#   - ANY "node-gyp" output → FAIL (row 19) — v1 should have ZERO native deps.
#   - ANY "MSBuild" output → FAIL (row 19).
#   - ANY error related to electron prebuild download → FAIL (row 15/21).
#   - postinstall hook "electron-builder install-app-deps" — should be a fast no-op
#     (no native deps) but if it errors that's FAIL.
#
# Record: total install time, last 30 lines of output (or full output if errored).

# 4. Smoke-test dev mode
npm run dev

# Expected: Electron window opens with Sei loading screen → Onboarding step 0.
# Watch for:
#   - Window title bar: should be Windows-style overlay (NOT macOS hiddenInset, NOT a generic Win10 frame).
#     The custom title bar should show #F6F5F2 background and the Sei logo + close/min/max buttons.
#   - DevTools (Ctrl-Shift-I): NO red errors on first paint.
#   - Renderer Network tab: woff2 fonts fetched with 200 OK
#     (`noto-sans-400.woff2`, `noto-sans-600.woff2`, `press-start-2p-400.woff2`,
#      `jetbrains-mono-400.woff2`, `jetbrains-mono-500.woff2`).
#   - Body text renders in Noto Sans (zoom in to confirm — NOT system default Segoe UI).
#   - NO yellow "KEYCHAIN_FALLBACK_PLAINTEXT" banner at top of window
#     (that banner only fires on Linux without gnome-keyring; on Windows DPAPI is always available).
```

**Walk the onboarding flow:**

5. Step 0: "Welcome to Sei." → click Continue.
6. Step 1-3: fill in Minecraft username, preferred name, provider (Anthropic). Use your real values.
7. Step 4: paste a real `sk-ant-...` Anthropic API key. Click Save.
   - Open DevTools console. After click, verify NO red errors.
   - Open Windows File Explorer to `%APPDATA%\Sei\`. EXPECTED: directory exists with `api_key.bin` (binary, encrypted) and `config.json` (JSON, plaintext, but no API key value inside).
   - VERIFY: api_key.bin file size is roughly 50-100 bytes (DPAPI-encrypted blob; not 51 bytes = empty / not raw 56 bytes = unencrypted base64).
8. After onboarding completes, Home screen renders the character grid. Sui / Mochineko / Clawd default cards should appear (seeded by `src/main/defaultCharacters.ts` on first launch).
9. Click on the "Sui" character. Character page opens.

**Summon the bot:**

10. On the Minecraft host (same LAN as the Windows machine, OR Minecraft running on the Windows host itself):
    - Open a singleplayer world.
    - Pause menu → "Open to LAN" → cheats on → click "Start LAN World".
    - Note the port number Minecraft displays (e.g. "Local game hosted on port 54321").
11. Back in Sei (on Windows), watch the LAN pill near the Summon button:
    - **Best case:** flips to CONNECTED (green) within 3 seconds. LAN multicast bridged correctly.
    - **NAT'd VM case (WARNING-9):** stays NOT CONNECTED indefinitely. RECORD THIS in DEV-SMOKE as `Row 3/Row 8 partial PASS, summon DEFERRED TO WAVE-3 due to multicast bridging`. Skip to step 14.
12. If LAN pill is green: click "Summon into Minecraft".
    - Within ~5-30s: bot joins the world. You see the bot avatar in-game wearing the default Steve skin (custom skins are Phase 9).
    - Open Sei → Logs panel. You should see streaming log lines tagged `[chat->]`, `[haiku?]`, `[haiku!]` etc.
13. In Minecraft, type a chat message addressed to the bot (e.g., "Hi Sui"). Within 10s, the bot should respond in-game chat. Verify the response renders in chat AND the corresponding `[chat<-]` line appears in Sei's Logs panel.

**Memory round-trip check:**

14. With the bot still summoned (or after a fresh summon if you skipped 12), check `%APPDATA%\Sei\memory\sui\` in File Explorer.
    - EXPECTED FILES: `OWNER.md`, `MEMORY.md`, possibly `AFFECT.md`. (DIARY.md may not exist yet; compaction is LLM-directed at semantic boundaries.)
    - Open `OWNER.md` in a Windows text editor that shows line endings (e.g., Notepad++ → View → Show Symbol → Show All Characters).
    - VERIFY: line endings are LF (`\n`) only — NOT CRLF (`\r\n`). atomicWrite uses utf8 binary-faithful mode and Node writes literal `\n` from JavaScript strings.
    - If you have a way to copy this file to a macOS machine: do so, run `diff` between the Windows-written copy and a freshly mac-written equivalent. The structural content should be identical (timestamps will differ).

**Clean stop:**

15. Click "Stop" on Sei's character page (or close the main window).
    - EXPECTED: bot disconnects from Minecraft cleanly (in-game chat shows `<Sui> left the game`).
    - Open Windows Task Manager. EXPECTED: no `electron.exe` or `Sei.exe` processes lingering. The window-all-closed handler at `src/main/index.ts:157` should quit on non-darwin.

**Author the results:**

16. Create `.planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-DEV-SMOKE.md` with this structure (you can also paste raw results back to Claude for transcription):

```markdown
# Phase 8 — Dev Smoke on Windows

**Tested:** YYYY-MM-DD on <Windows 10 | Windows 11> <build number> (<VM type: Parallels | UTM | VMware | bare metal | other>)
**Tester:** <your handle>
**Node version:** v20.X.X
**npm version:** vX.X.X
**Network topology:** <Minecraft host same physical LAN as Windows | bridged VM | NAT'd VM>

## Dev Smoke Checklist

(One row per Wave-2 deferred item from 08-HOTSPOTS.md.)

| Row | Item | Result | Evidence |
|-----|------|--------|----------|
| 3 | bot child reads correct SEI_USER_DATA | PASS / FAIL / N/A | e.g., "Bot logged `userDataDir=C:\Users\foo\AppData\Roaming\Sei` on init" |
| 4 | Windows title bar overlay renders | PASS / FAIL | screenshot or description |
| 6 | closing window quits app | PASS / FAIL | "Task Manager shows no electron.exe after window close" |
| 7 | preload loads | PASS / FAIL | "DevTools: window.sei.* methods callable" |
| 8 | renderer paints | PASS / FAIL | "Loading screen → Onboarding step 0 within 2s" |
| 9 | no Linux-fallback banner | PASS / FAIL | "No yellow banner visible" |
| 10 | CLI reset (optional) | PASS / FAIL / N/A | N/A if not exercised |
| 11 | memory file round-trip | PASS / FAIL | "OWNER.md is LF-only, mac diff zero" |
| 15/19/21 | npm install completes, no node-gyp | PASS / FAIL | "exit code 0, no node-gyp output, took XXs" |
| 17/22 | fonts load + dev paint | PASS / FAIL | "Network tab: 5/5 woff2 200 OK; body font-family computes to 'Noto Sans'" |
| 23 | \n vs \r\n round-trip | PASS / FAIL | "OWNER.md LF only" |
| summon | live bot summon + chat exchange | PASS / FAIL / DEFERRED-MULTICAST | "Bot joined LAN, responded to chat within 8s" OR "LAN pill stayed NOT CONNECTED (NAT'd VM, WARNING-9)" |

## Defects Found (cross-reference 08-WINDOWS-DEFECTS.md)

- WIN-DEFECT-01: <symptom>  (added to 08-WINDOWS-DEFECTS.md)
- WIN-DEFECT-02: <symptom>
- (or "None — all rows PASS")

## Out-of-band observations

- <anything noticed that wasn't a Wave-2 row but is worth logging — e.g., "dev launch took 12s, mac takes 4s — performance gap noted but out of scope per CONTEXT §deferred">

## Next step

- If all rows PASS or only DEFERRED-MULTICAST: proceed to Wave 3 (Plan 08-03) packaged smoke.
- If any FAIL with a clear root cause: append a defect row to 08-WINDOWS-DEFECTS.md and Wave 3 picks it up.
```

17. Create `.planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-WINDOWS-DEFECTS.md` (or append to it if Plan 03 already created the file). The structure MUST be:

```markdown
# Phase 8 — Windows-Only Defects

**Convention:** each defect gets a `WIN-DEFECT-NN` id. Wave 3 (Plan 08-03) fixes each with its own commit `fix(08-win): <short>`.

## Defect Log

| ID | Discovered in | Symptom | Root-cause hypothesis | Affected files | Fix status | Fix commit |
|----|---------------|---------|------------------------|----------------|------------|------------|
| WIN-DEFECT-01 | Plan 08-02 row N | <one-line symptom> | <one-line hypothesis from grep / log / Wave-1 audit pointer> | <relative paths> | OPEN / FIXED | (hash after commit) |
| (more) | | | | | | |

(If no defects: leave the table header + a row saying `(none — Wave 2 dev smoke clean)`.)

## Wave 3 fix queue

Order Wave-3 commits by:
1. Defects blocking packaged build (e.g., missing asarUnpack glob, wrong path resolution)
2. Defects blocking smoke flow (e.g., onboarding hangs, font 404)
3. Defects cosmetic (e.g., title bar color wrong)
```

18. Paste the filled `08-DEV-SMOKE.md` and updated `08-WINDOWS-DEFECTS.md` content back to Claude in the resume signal. Claude will commit them (or guide you to commit them) and update Plan 03's task list with any new defect IDs.
  </how-to-verify>
  <resume-signal>Paste back:
1. The contents of `08-DEV-SMOKE.md` (filled in with PASS/FAIL per row)
2. The contents of `08-WINDOWS-DEFECTS.md` (or "no defects")
3. Network topology: bare-metal / bridged-VM / NAT'd-VM
4. Whether the live-summon row was PASS or DEFERRED-MULTICAST

If any row is FAIL with no actionable evidence (e.g., "Sei crashed immediately on launch with this error: <stack trace>"), include the stack trace too — Wave 3 needs the root-cause signal to design the fix.</resume-signal>
</task>

<task type="auto" tdd="false">
  <name>Task 2: Executor commits the DEV-SMOKE + WINDOWS-DEFECTS artifacts produced by the user in Task 1</name>
  <read_first>
    - The contents of `08-DEV-SMOKE.md` and `08-WINDOWS-DEFECTS.md` as pasted in Task 1's resume signal
    - .planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-HOTSPOTS.md (to confirm row-id cross-references match)
  </read_first>
  <behavior>
    Transcribe the user-pasted Task 1 results verbatim into `08-DEV-SMOKE.md` and `08-WINDOWS-DEFECTS.md` (creating both files at the canonical path under the phase dir if they don't already exist). Verify cross-references: every FAIL/DEFERRED row in DEV-SMOKE.md that points to a defect ID has a matching row in WINDOWS-DEFECTS.md, and every defect row in WINDOWS-DEFECTS.md is referenced by at least one DEV-SMOKE.md row OR is an out-of-band observation.

    DO NOT invent results. DO NOT mark rows PASS that the user did not explicitly mark PASS. If the user's paste is incomplete (e.g., missing rows), flag that in the SUMMARY rather than filling in defaults.
  </behavior>
  <action>
**Step 1.** Take the user's pasted Task 1 output. Identify the two markdown blocks:
- DEV-SMOKE content → write to `.planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-DEV-SMOKE.md`
- WINDOWS-DEFECTS content → write to `.planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-WINDOWS-DEFECTS.md`

Use the Write tool to create each file. The content goes verbatim from the user's paste — no editorializing, no defaults, no "PASS (assumed)".

**Step 2.** Validate cross-references:

```bash
# Every WIN-DEFECT-NN id referenced in DEV-SMOKE must exist in DEFECTS
grep -oE "WIN-DEFECT-[0-9]+" .planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-DEV-SMOKE.md | sort -u > /tmp/dev-smoke-refs
grep -oE "WIN-DEFECT-[0-9]+" .planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-WINDOWS-DEFECTS.md | sort -u > /tmp/defects-defined

# If dev-smoke-refs has IDs not in defects-defined, that's an error. The user's paste was inconsistent — call it out.
comm -23 /tmp/dev-smoke-refs /tmp/defects-defined
# Expect empty output. If non-empty, the executor MUST report the inconsistency in the SUMMARY and ask the user to clarify.
```

**Step 3.** If there are any defect rows in `08-WINDOWS-DEFECTS.md` with `Fix status: OPEN`, the Wave-3 Plan (08-03) is the fix queue. The executor should NOT attempt to fix anything in this plan — that's Wave 3's job.

**Step 4.** If `08-DEV-SMOKE.md` shows ALL rows PASS or PASS/DEFERRED-MULTICAST only (no FAIL), Wave 3 still runs (packaged smoke is independent from dev smoke), but the defect log starts empty.
  </action>
  <verify>
    <automated>bash -c 'D=.planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-DEV-SMOKE.md && W=.planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-WINDOWS-DEFECTS.md && test -f "$D" && test -f "$W" && grep -q "Dev Smoke Checklist\\|Dev Smoke" "$D" && grep -q "Defect Log\\|Windows-Only Defects" "$W" && grep -q "Row\\|Item\\|Result" "$D"'</automated>
  </verify>
  <acceptance_criteria>
    - `08-DEV-SMOKE.md` exists, contains the user's pasted dev-smoke checklist (Dev Smoke Checklist + Defects Found + Next step sections)
    - `08-WINDOWS-DEFECTS.md` exists, contains the defect log (with at least the header table, even if zero defects)
    - Every `WIN-DEFECT-NN` id referenced in DEV-SMOKE has a matching row in DEFECTS — OR the executor explicitly flags the mismatch in the SUMMARY and asks the user to resolve
    - Files mirror the user's pasted content verbatim; no executor-invented PASS/FAIL values
  </acceptance_criteria>
  <done>Wave 2 artifacts are committed. Wave 3 has a concrete defect queue (possibly empty). Phase 8 progresses to packaged smoke.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Windows host filesystem ↔ Sei renderer / utilityProcess | First time Sei touches `%APPDATA%\Sei\` — every memory file, the api_key.bin blob, and the config.json land here. |
| Minecraft LAN multicast ↔ Sei lanWatcher | UDP multicast on `224.0.2.60:4445` may not bridge across VM NAT. |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-08-05 | Information Disclosure | user pastes raw API key into DEV-SMOKE evidence (e.g., copies a "DevTools console" log that contains the sk-ant-... header) | mitigate | Task 1 step 7 explicitly says paste a REAL key into Sei but the verification is "api_key.bin exists with reasonable size" — no requirement to log the key itself. Task 2 grep-validates the committed DEV-SMOKE.md does not contain `sk-ant-` (see automated verify regex). |
| T-08-06 | Tampering | Windows host has malware that intercepts DPAPI safeStorage | accept | Pre-existing risk for any Windows app using DPAPI. Sei trusts the OS keychain abstraction; not Phase 8's scope to harden against compromised hosts. |
| T-08-07 | Repudiation | dev smoke marked PASS but defect later emerges in packaged smoke (Wave 3) | accept | The dev/packaged smoke split exists precisely because dev mode can mask packaging defects (e.g., asarUnpack misses). Wave 3 reseeds the defect log with packaging-specific findings. |
</threat_model>

<verification>
- `08-DEV-SMOKE.md` exists with every Wave-2 row marked PASS / FAIL / N/A.
- `08-WINDOWS-DEFECTS.md` exists with the open defect queue for Wave 3.
- The user has provided the network topology, Node version, and any FAIL evidence in their paste.
- Cross-references between DEV-SMOKE and WINDOWS-DEFECTS are consistent.
</verification>

<success_criteria>
- Wave 3 (Plan 08-03) executor has a deterministic queue of Windows-only defects to fix.
- If the queue is empty (zero FAIL rows), Wave 3 proceeds directly to packaged smoke without code changes.
- The user has direct evidence that `npm run dev` works on their target Windows topology — they can be confident a future Phase 9 setup wizard built on the same dev pipeline will work too.
</success_criteria>

<output>
After Task 2 completes, create `.planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-02-SUMMARY.md` documenting:
- Network topology used (bare-metal / bridged-VM / NAT'd-VM)
- Total Wave-2 rows: N pass, M fail, K deferred
- List of open defect IDs and their assigned Wave-3 fix priority (per CONTEXT §"Wave 3 fix queue" ordering)
- Confirmation that the live-summon row was either PASS or explicitly DEFERRED-MULTICAST
- Pointer to Plan 08-03 (Wave 3 packaged smoke + defect fix)
</output>
