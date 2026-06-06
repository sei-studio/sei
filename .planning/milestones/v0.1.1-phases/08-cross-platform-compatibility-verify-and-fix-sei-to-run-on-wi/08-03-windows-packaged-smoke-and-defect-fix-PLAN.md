---
phase: 08-cross-platform-compatibility
plan: 03
type: execute
wave: 3
depends_on: [01, 02]
files_modified:
  - .planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-PACKAGED-SMOKE.md
  - .planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-WINDOWS-DEFECTS.md
autonomous: false
requirements: []
human_action: "User must run `npm run dist:win` on a real Windows 10/11 x64 machine, install the resulting NSIS .exe on a fresh-or-clean profile, walk the packaged smoke flow defined in Task 1, and paste back per-row results. The executor (Claude on macOS) does the static code fixes for any OPEN defects from `08-WINDOWS-DEFECTS.md` AFTER the user provides Wave-2 + Wave-3 evidence, then asks the user to re-verify on Windows. The executor CANNOT run `npm run dist:win` from macOS even though `electron-builder --win` technically supports cross-compilation — the explicit project decision (CONTEXT §code_context plus the WIN-only smoke requirement) is to build ON Windows so toolchain quirks (codepage, path-length limits, Defender false-positives) are part of the validation."
user_setup:
  - service: windows-vm
    why: "Cross-platform packaged smoke testing — same Windows host as Wave 2, or a SECOND clean Windows host for fresh-install validation"
    env_vars: []
    dashboard_config:
      - task: "Re-use the Wave-2 Windows host (already has Node + Git + the repo). For best smoke coverage, install the produced .exe on a SECOND Windows machine or a snapshotted clean VM with no Node / no Sei dev clone."
        location: "Windows host"
      - task: "Same Minecraft host + LAN-open world as Wave 2"
        location: "Minecraft client"
      - task: "Same Anthropic API key as Wave 2 (or a fresh one for the second install)"
        location: "Anthropic Console → API Keys"
must_haves:
  truths:
    - "`npm run dist:win` on Windows produces `release\\Sei Setup 0.1.0.exe` (NSIS installer) with no errors, no codepage / path-length warnings, no Windows Defender false-positive that blocks the build"
    - "Installing `Sei Setup 0.1.0.exe` on a clean Windows profile (no existing %APPDATA%\\Sei\\) walks through SmartScreen → NSIS welcome → install-directory prompt (allowToChangeInstallationDirectory: true) → success in <60 seconds. The SmartScreen 'unknown publisher' warning is EXPECTED v1 UX (Phase 4 D-Q2)"
    - "Launching the installed Sei.exe from Start menu produces the same dev-smoke pass-set as Wave 2 BUT against the packaged build: window opens with Windows title-bar overlay, onboarding completes, %APPDATA%\\Sei\\config.json + api_key.bin are written, default characters seeded, bot summons to LAN, exchanges chat, stops cleanly"
    - "All files land in `%APPDATA%\\Sei\\` — confirming the Plan 01 Task 2 appId lock (com.sei.app) + productName (Sei) resolution behaves the same in packaged as in dev"
    - "The installed app contains `<install-dir>\\resources\\app.asar.unpacked\\src\\bot\\index.js` (per electron-builder.yml asarUnpack glob) — utilityProcess.fork resolves it"
    - "Every OPEN defect in `08-WINDOWS-DEFECTS.md` from Wave 2 is resolved by an atomic `fix(08-win): ...` commit in this plan, with fix_commit hash recorded back into the defect row"
    - "Re-running the packaged-smoke checklist AFTER all defect fixes yields PASS on every row (re-verification loop)"
  artifacts:
    - path: .planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-PACKAGED-SMOKE.md
      provides: "Windows packaged smoke checklist with PASS/FAIL per row + installer-specific findings (SmartScreen UX, install dir, Start Menu entry, Add/Remove Programs entry, uninstall behavior)"
      contains: "## Packaged Smoke Checklist"
    - path: .planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-WINDOWS-DEFECTS.md
      provides: "Defect log updated — every OPEN defect from Wave 2 now has Fix status: FIXED + commit hash, plus any new packaging-only defects discovered in this wave"
      contains: "FIXED"
  key_links:
    - from: 08-WINDOWS-DEFECTS.md (Wave 2 OPEN rows)
      to: src/ code fixes
      via: "executor reads each OPEN row, performs static fix, makes atomic commit, updates row with hash"
      pattern: "fix(08-win):"
    - from: 08-PACKAGED-SMOKE.md
      to: 08-04 documentation (Wave 4)
      via: "Wave 4 README + RELEASE-NOTES cite the smoke results"
      pattern: "PASS"
---

<objective>
On a real Windows host: build the NSIS installer (`npm run dist:win`), install it on a clean profile, run the same end-to-end smoke path as Wave 2 but against the PACKAGED build (not dev), and verify every Phase 8 "Bar to clear" item from CONTEXT §"Scope of 'works'". Separately on the executor side (Claude on macOS): consume any OPEN defects from `08-WINDOWS-DEFECTS.md` and ship atomic `fix(08-win):` commits with static fix work the executor CAN do without a Windows machine (typo fixes, missing platform branches, electron-builder.yml tweaks, README pointers). The user re-verifies on Windows after each batch of fixes until all rows PASS.

Purpose: Wave 3 closes the loop between Wave 1's static audit (what could be found by reading) and Wave 2's live dev smoke (what could only be found by running) and the PACKAGED build (the actual artifact that v1 users will install). The CONTEXT §"Scope of 'works'" 6-point bar is the success contract — Wave 3's PASS state is the definition of "Phase 8 done."

Output: `08-PACKAGED-SMOKE.md` with PASS/FAIL per row; updated `08-WINDOWS-DEFECTS.md` with Fix status FIXED + commit hashes for every OPEN row; zero-or-more `fix(08-win):` commits in the repo.
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
@electron-builder.yml
@package.json

<interfaces>
<!-- CONTEXT §"Scope of 'works': packaged install path" — the 6-point bar to clear -->
<!-- Wave 3's job is to verify each of these on Windows -->

Bar #1 — NSIS installer from `npm run dist:win` installs cleanly on a fresh Windows 10/11 VM (no admin prompts beyond SmartScreen warning).
Bar #2 — Sei launches from Start Menu.
Bar #3 — First-launch onboarding completes (API key entry, persona seed).
Bar #4 — User can summon a bot to a vanilla LAN world, exchange a few chat lines, see persona reactions, and disconnect cleanly.
Bar #5 — <userData> files (config.json, characters/, api_key.bin, logs/) land in `%APPDATA%\Sei\` and persist across relaunch.
Bar #6 — Bot's debug logs reach the renderer log panel (no broken IPC/path bridging).

<!-- Defect-fix workflow (CONTEXT §"Defect handling: small atomic commits, dedicated log") -->
For each OPEN row in 08-WINDOWS-DEFECTS.md:
  1. Executor reads `Symptom` + `Root-cause hypothesis` + `Affected files`
  2. Executor reads each affected file in full
  3. Executor designs the minimal fix
  4. Executor edits the file(s)
  5. Executor commits with message: `fix(08-win): <short description>` (and Co-Authored-By footer per CLAUDE.md)
  6. Executor updates the row in 08-WINDOWS-DEFECTS.md: Fix status → FIXED, Fix commit → <hash>
  7. User re-runs the failing smoke step on Windows to confirm
</interfaces>

<key_locked_decisions>
- CONTEXT §"Scope of 'works': packaged install path" — the 6-point bar IS the must_haves.truths for this plan.
- CONTEXT §"Defect handling: small atomic commits, dedicated log" — every defect gets its own commit. NEVER bundle multiple defects in one commit.
- CONTEXT §"Audit + smoke (not audit-only)" — the packaged smoke must actually run; static analysis is insufficient.
- Phase 4 04-11 WARNING-9 — multicast NAT bridging is the known LAN failure mode; document but accept.
- planning_context "static audit only, defer verification" — this plan's TASK 1 is autonomous: false and is human_action. TASK 2 (executor static defect fix) IS autonomous because it's editing source files, but it depends on user evidence from Task 1 + Wave 2.
- The executor MAY produce more than one `fix(08-win):` commit. Each commit is small (one defect each). The executor reads every affected file BEFORE editing, per `<read_first>`.
- The executor MUST NOT produce a fix for a defect whose root cause requires runtime Windows information not present in Wave-2 / Wave-3 evidence. In that case: add a comment row to the defect saying "Fix BLOCKED — need additional evidence: <specific question>" and surface it in the SUMMARY.
</key_locked_decisions>
</context>

<tasks>

<task type="checkpoint:human-action" gate="blocking">
  <name>Task 1: USER builds + installs the Windows .exe, walks the packaged smoke flow, records results</name>
  <what-built>
    The user runs `npm run dist:win` on a Windows host, installs the resulting NSIS installer (preferably on a clean Windows profile or a second VM), walks the same end-to-end smoke flow as Wave 2 but against the PACKAGED build. The executor cannot run this from macOS — even though `electron-builder --win` supports cross-compiling from macOS, the explicit project decision is to build ON Windows so all toolchain quirks become part of the validation surface.
  </what-built>
  <how-to-verify>
**On the WINDOWS machine (PowerShell, in the Sei repo):**

```powershell
# 1. Make sure everything from Wave 2 is up to date
git pull
npm install   # idempotent; if Wave 2 was clean, this is fast

# 2. Build the Windows installer
npm run dist:win

# Expected:
#   - electron-vite build phase: dist/main, dist/preload, dist/renderer all written.
#   - electron-builder phase: `release\Sei Setup 0.1.0.exe` produced.
#   - No "Windows Defender removed file" warnings — Defender sometimes false-positives on Electron NSIS installers; if it does, add an exclusion for the repo's release/ dir and re-run.
#   - No path-length errors (Windows MAX_PATH=260 unless long paths enabled — node_modules/.cache nesting can hit this).
#
# Record: total build time, last 30 lines of dist:win output, final release/ contents (`Get-ChildItem release\`).
```

**Install the .exe (ideally on a clean profile / second VM):**

```powershell
# 3. Copy release\Sei Setup 0.1.0.exe to the target machine. Double-click.

# Expected:
#   - SmartScreen "Windows protected your PC" blue dialog. Click "More info" → "Run anyway".
#     (This IS expected for v1 per Phase 4 D-Q2 — unsigned NSIS.)
#   - NSIS welcome screen → "Choose Install Location" prompt
#     (because nsis.allowToChangeInstallationDirectory: true).
#     Default install dir on Windows for per-user is `%LOCALAPPDATA%\Programs\Sei\`.
#   - Click Install. Progress bar. <60s typical.
#   - "Run Sei" checkbox visible on finish page. Either click it OR launch from Start Menu next step.
```

**Launch from Start Menu (NOT from File Explorer of the install dir):**

```powershell
# 4. Win key → type "Sei" → click Sei tile/result.

# Expected:
#   - Window opens with Windows title-bar overlay chrome (same as Wave 2 row 4).
#   - Loading screen → Onboarding step 0.
#   - %APPDATA%\Sei\ directory does NOT exist yet (fresh install).
```

**Walk onboarding (mirror Wave 2 steps 5-9 but on the packaged build):**

```powershell
# 5. Step 0-4: complete onboarding. Use real values + your Anthropic API key.
# 6. After step 4 Save: open File Explorer to %APPDATA%\Sei\.
#    Verify config.json + api_key.bin exist (Bar #5 from CONTEXT §"Scope of 'works'").
# 7. Home screen renders. Default characters (Sui/Mochineko/Clawd) appear
#    (seeded by src/main/defaultCharacters.ts on first launch).
```

**Verify the asarUnpack glob produced the bot entry file:**

```powershell
# 8. Navigate File Explorer (or PowerShell) to the install directory:
#    `%LOCALAPPDATA%\Programs\Sei\` (or whatever you chose at step 3).
# Verify: `resources\app.asar.unpacked\src\bot\index.js` EXISTS.
Get-Item "$env:LOCALAPPDATA\Programs\Sei\resources\app.asar.unpacked\src\bot\index.js"
# Should print file info (length, last write time). NotFound = packaging failure → defect row.
```

**Summon a bot (Bar #4 from CONTEXT §"Scope of 'works'"):**

```powershell
# 9. Same as Wave 2 step 10-13:
#    - Open Minecraft on the same LAN, "Open to LAN" with cheats on.
#    - In Sei: wait for LAN pill green (or DEFERRED-MULTICAST if NAT'd).
#    - Click Sui card → Summon.
#    - Bot joins, exchange chat, verify [chat<-] log lines stream in Sei's Logs panel
#      (Bar #6 — debug logs reach renderer).
#    - Stop. Verify clean disconnect.
```

**Verify persistence across relaunch (Bar #5):**

```powershell
# 10. Close Sei (or its window).
# 11. Re-launch Sei from Start Menu.
# Expected:
#   - NO onboarding screen (config.json + api_key.bin persisted).
#   - Home screen renders with same characters.
#   - hasApiKey() returns true (api_key.bin decrypts via DPAPI).
```

**Uninstall (smoke the NSIS uninstaller too):**

```powershell
# 12. Settings → Apps → installed apps → find Sei → Uninstall.
# Expected:
#   - Uninstaller runs, removes %LOCALAPPDATA%\Programs\Sei\.
#   - NOTE: %APPDATA%\Sei\ user data is INTENTIONALLY left in place
#     (per-user data should survive uninstall for re-install scenarios).
#     If user data is wiped on uninstall, that's a defect — log it.
```

**Author the results document:**

13. Create or update `.planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-PACKAGED-SMOKE.md`:

```markdown
# Phase 8 — Packaged Smoke on Windows

**Tested:** YYYY-MM-DD on <Windows 10 | Windows 11> <build number> (<install context: same as Wave 2 / second VM / bare metal>)
**Tester:** <your handle>
**Build host:** <Windows 10/11 build, Node v20.X.X>
**Install host:** <same as build / second machine>
**Network topology:** <bare-metal / bridged-VM / NAT'd-VM>

## Build Results

| Metric | Value |
|--------|-------|
| `npm run dist:win` exit code | 0 / non-zero |
| Build time | XX s / m |
| Output file | release\Sei Setup 0.1.0.exe (size: XX MB) |
| Defender false-positive? | YES / NO |
| Path-length / codepage errors? | YES / NO |

## Packaged Smoke Checklist

(One row per CONTEXT §"Scope of 'works'" bar + per Wave-3 deferred items from 08-HOTSPOTS.md.)

| Bar / Row | Item | Result | Evidence |
|-----------|------|--------|----------|
| Bar #1 | Installer installs cleanly (SmartScreen → NSIS welcome → choose dir → install) | PASS / FAIL | "SmartScreen warning appeared, clicked through, NSIS welcome OK, install dir chosen as <path>, completed in XXs" |
| Bar #2 | Sei launches from Start Menu | PASS / FAIL | "Win → Sei → window opened" |
| Bar #3 | Onboarding completes | PASS / FAIL | "Steps 0-4 completed without error" |
| Bar #4 | Bot summons + chats + disconnects | PASS / FAIL / DEFERRED-MULTICAST | "Bot joined, replied to 'hi Sui', clean disconnect" |
| Bar #5 | %APPDATA%\Sei\ files persist across relaunch | PASS / FAIL | "Re-launch skipped onboarding; characters intact" |
| Bar #6 | Bot debug logs reach renderer Logs panel | PASS / FAIL | "Streaming [chat->] and [haiku?] tags visible in Logs panel" |
| Hotspots #1 | files land in %APPDATA%\Sei\ | PASS / FAIL | "Confirmed in File Explorer" |
| Hotspots #2 | bot forks in packaged build (asar-unpacked path resolves) | PASS / FAIL | "app.asar.unpacked\src\bot\index.js exists; bot fork succeeded" |
| Hotspots #13 | SmartScreen warning + per-user install | PASS / FAIL | "Confirmed: no admin prompt, install went to %LOCALAPPDATA%\Programs\Sei\" |
| Hotspots #14 | asar-unpacked src/bot/index.js exists | PASS / FAIL | "Get-Item returned file" |
| Hotspots #16 | dist:win produces installer | PASS / FAIL | "release\Sei Setup 0.1.0.exe (XX MB)" |
| Hotspots #17 | text renders in Noto Sans post-install | PASS / FAIL | "Computed font-family: 'Noto Sans'" |
| Hotspots #24 | <userData> = %APPDATA%\Sei\ | PASS / FAIL | "Confirmed" |
| Uninstall | NSIS uninstaller works AND preserves %APPDATA%\Sei\ user data | PASS / FAIL | "Uninstaller removed Programs\Sei; %APPDATA%\Sei\ untouched" |

## Defects Found (cross-reference 08-WINDOWS-DEFECTS.md)

- WIN-DEFECT-NN: <symptom>  (added to 08-WINDOWS-DEFECTS.md as Wave-3 entry)
- (or "None — all rows PASS")

## Post-Defect-Fix Re-Verification

(Filled AFTER executor commits fixes for OPEN defects and asks user to re-run failing rows.)

| Defect ID | Re-verified | Result |
|-----------|-------------|--------|
| WIN-DEFECT-01 | YYYY-MM-DD | PASS / STILL FAILING |
| ... | | |

## Next step

- If all Bars PASS: proceed to Wave 4 (Plan 08-04) documentation.
- If any Bar FAIL with OPEN defect: executor commits the fix, user re-verifies that single row, loop until all PASS.
```

14. Append any newly-discovered defects to `08-WINDOWS-DEFECTS.md` using the same row schema as Wave 2 (see Plan 08-02 Task 1 instructions for the table shape).

15. Paste filled `08-PACKAGED-SMOKE.md` + updated `08-WINDOWS-DEFECTS.md` content back to Claude in the resume signal. Claude will (a) commit the artifacts and (b) start fixing OPEN defects in Task 2.
  </how-to-verify>
  <resume-signal>Paste back:
1. The contents of `08-PACKAGED-SMOKE.md`
2. The contents of `08-WINDOWS-DEFECTS.md` (including any newly-discovered Wave-3 defects)
3. Build host details, install host details, network topology
4. For any FAIL row: include the full stack trace / error message from Sei's DevTools console or `%APPDATA%\Sei\logs\<id>-<timestamp>.log` — the executor's static fix work in Task 2 depends on actionable signal.</resume-signal>
</task>

<task type="auto" tdd="false">
  <name>Task 2: Executor commits packaged-smoke artifacts AND ships atomic fix commits for every OPEN defect</name>
  <read_first>
    - The user's pasted Task 1 results (08-PACKAGED-SMOKE.md content + 08-WINDOWS-DEFECTS.md updates)
    - .planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-WINDOWS-DEFECTS.md (full file — Wave 2 + Wave 3 entries)
    - For EACH OPEN defect: every file listed in the defect's "Affected files" column, read in full before editing
    - .planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-HOTSPOTS.md (cross-reference the defect's HOTSPOTS row for additional context)
  </read_first>
  <behavior>
    Two sub-phases:

    **Sub-phase A: commit Task 1 artifacts.**
    - Write `08-PACKAGED-SMOKE.md` from the user's paste, verbatim.
    - Update `08-WINDOWS-DEFECTS.md` to include any new Wave-3 defects from the user's paste.
    - Validate cross-references same as Plan 08-02 Task 2.

    **Sub-phase B: fix each OPEN defect.**
    - For each row in `08-WINDOWS-DEFECTS.md` with `Fix status: OPEN`:
      1. Read the symptom, root-cause hypothesis, and affected files.
      2. Read every affected file in full.
      3. Design the minimal targeted fix. The fix MUST be statically-determinable from the evidence the user provided (stack trace, log line, smoke checklist row) — if it isn't, mark the defect `Fix status: BLOCKED — need additional evidence: <specific question>` and surface in SUMMARY. Do NOT guess.
      4. Edit the file(s) with the Edit tool.
      5. Make an atomic commit: `fix(08-win): <short description>` (use the `git commit` HEREDOC pattern from CLAUDE.md, include Co-Authored-By footer).
      6. Update the defect row in `08-WINDOWS-DEFECTS.md`: `Fix status` → FIXED, `Fix commit` → <commit hash>.
    - The executor MAY produce many small commits. Each commit handles ONE defect. NEVER bundle multiple defects in one commit (per CONTEXT §"Defect handling").
    - After all OPEN defects are addressed (FIXED or BLOCKED), the executor surfaces the BLOCKED-only list in the SUMMARY and asks the user to provide additional evidence OR to re-verify the FIXED rows.

    Common-pattern fixes the executor SHOULD recognize (apply with confidence if defect matches):
    - Stale `app.sei.placeholder` literal anywhere outside `electron-builder.yml` → replace with `com.sei.app` (matches Plan 01 Task 2)
    - Hardcoded `/` separator in a path that should be `path.sep` or `path.join` → refactor to path.join
    - Hardcoded `~` or `$HOME` in a path → use `os.homedir()` (which handles `%USERPROFILE%` on Windows)
    - Missing `win32` branch in a platform switch → add the branch
    - electron-builder.yml glob using backslashes (electron-builder requires forward-slash globs even on Windows) → switch to forward slash
    - Renderer fetching `\` paths instead of `/` → switch to `/` (URLs always use `/`)
    - Missing file in asarUnpack glob → extend the glob
  </behavior>
  <action>
**Step 1 (Sub-phase A):** Take the user's pasted Task 1 output. Identify the two markdown blocks and Write them to the canonical paths:
- `08-PACKAGED-SMOKE.md` content → write to `.planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-PACKAGED-SMOKE.md`
- `08-WINDOWS-DEFECTS.md` updated content → write back to the same path (this OVERWRITES because new Wave-3 defects may have been added by the user; use Read first if needed to verify Wave-2 entries aren't dropped)

Cross-reference check (same as Plan 08-02 Task 2 Step 2):

```bash
grep -oE "WIN-DEFECT-[0-9]+" .planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-PACKAGED-SMOKE.md | sort -u > /tmp/packaged-smoke-refs
grep -oE "WIN-DEFECT-[0-9]+" .planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-WINDOWS-DEFECTS.md | sort -u > /tmp/defects-defined
comm -23 /tmp/packaged-smoke-refs /tmp/defects-defined
# Empty = consistent. Non-empty = report + ask user to clarify.
```

**Step 2 (Sub-phase B):** Enumerate OPEN defects:

```bash
grep -E "^\\| WIN-DEFECT-[0-9]+ .*\\| OPEN " .planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-WINDOWS-DEFECTS.md
```

For EACH row returned (or an empty list = no defects to fix; skip to Step 4):

  **Step 2a — Read affected files.**
  Parse the row's "Affected files" cell. For every relative path listed, use the Read tool to load the FULL file. Do not skim. Do not stop early. The fix must respect every existing pattern in the file.

  **Step 2b — Read the defect's HOTSPOTS context.**
  If the defect references a HOTSPOTS row number (e.g., "Plan 08-02 row 17"), open `08-HOTSPOTS.md` and read row 17 for additional pattern hints.

  **Step 2c — Design the fix.**
  Statically-determinable from the evidence:
  - Stack trace → file + line → look at the failing line + adjacent context → propose minimal change.
  - Smoke checklist row → which Bar / Hotspot did it map to → what's the expected vs actual behavior → minimal change.
  - If evidence is insufficient (e.g., defect says "Sei crashes on Windows launch" with no stack trace, no log): DO NOT GUESS. Update the defect row's `Fix status` to `BLOCKED — need additional evidence: <specific question for user>` and continue to the next defect.

  **Step 2d — Edit + verify.**
  Use the Edit tool. Re-run any linter / type-check the project has if applicable (`npx tsc --noEmit` for TypeScript files). The commit MUST leave the build in a passing state.

  **Step 2e — Commit.**
  Use the git HEREDOC pattern from CLAUDE.md. Example:

  ```bash
  git add <specific-files>
  git commit -m "$(cat <<'EOF'
  fix(08-win): <short description>

  WIN-DEFECT-NN: <one-line context from the defect row>

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

  Capture the commit hash from `git rev-parse HEAD`.

  **Step 2f — Update the defect row.**
  Edit `08-WINDOWS-DEFECTS.md` (Edit tool, not Write — Edit only changes the matching row):
  - `Fix status: OPEN` → `Fix status: FIXED`
  - `Fix commit:` (empty) → `Fix commit: <hash>`

  Do NOT commit this defect-log update separately; it can be batched into the next defect's fix commit OR a final `docs(08-win): record defect closures` commit at end.

**Step 3: Repeat Step 2 for each OPEN defect.** ONE commit per defect (or BLOCKED).

**Step 4: Final batch commit for defect-log housekeeping (if needed):**

```bash
git add .planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-PACKAGED-SMOKE.md
git add .planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-WINDOWS-DEFECTS.md
git commit -m "$(cat <<'EOF'
docs(08-win): record Wave-3 packaged smoke + defect closures

Wave-3 packaged smoke results + all OPEN defects from 08-WINDOWS-DEFECTS.md
now marked FIXED with commit hashes (BLOCKED entries remain for user-supplied
additional evidence).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

**Step 5: If any BLOCKED defects exist:** surface them in the SUMMARY with the specific evidence question. The user provides the evidence, then re-runs Plan 08-03 (or a continuation of it) to close them.

**Step 6: Ask the user to re-verify the FIXED rows on Windows.** Each fix commit needs a user-side smoke re-run for the failing smoke step. The user updates the "Post-Defect-Fix Re-Verification" table in `08-PACKAGED-SMOKE.md` with PASS or STILL FAILING. STILL FAILING means the fix was wrong — re-open the defect and design a new fix.
  </action>
  <verify>
    <automated>bash -c 'P=.planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-PACKAGED-SMOKE.md && W=.planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-WINDOWS-DEFECTS.md && test -f "$P" && test -f "$W" && grep -q "Packaged Smoke Checklist\\|Packaged Smoke" "$P" && grep -q "Bar #1\\|Bar #2\\|Bar #3\\|Bar #4\\|Bar #5\\|Bar #6" "$P" && grep -q "%APPDATA%\\\\Sei\\\\\\|%APPDATA%.Sei" "$P" && grep -q "SmartScreen" "$P" && grep -q "asar.unpacked\\|asar-unpacked\\|app.asar.unpacked" "$P" && grep -q "Defect Log\\|Windows-Only Defects" "$W" && ( ! grep -q "Fix status: OPEN" "$W" || grep -q "Fix status: BLOCKED" "$W" )'</automated>
  </verify>
  <acceptance_criteria>
    - `08-PACKAGED-SMOKE.md` exists with all 6 Bars (Bar #1 - Bar #6) referenced in the checklist
    - File mentions `%APPDATA%\Sei\` (Bar #5 — the canonical user-data root)
    - File mentions `SmartScreen` (Bar #1 — accepted v1 UX)
    - File mentions `app.asar.unpacked` (Hotspots #14 — bot fork resource)
    - `08-WINDOWS-DEFECTS.md` exists with the defect log table
    - Every row that started with `Fix status: OPEN` either ends as `Fix status: FIXED` (with a `Fix commit:` hash) OR `Fix status: BLOCKED` (with a specific evidence question recorded)
    - If any defect is BLOCKED, the SUMMARY surfaces the specific evidence question for the user
    - The Bar-#1 row mentions SmartScreen + NSIS welcome + install-dir-prompt sequence (matches CONTEXT §"Scope of 'works'" bar #1)
    - The Bar-#5 row evidence includes confirmation that `%APPDATA%\Sei\` persists across relaunch
  </acceptance_criteria>
  <done>Every OPEN Wave-2 + Wave-3 defect is either FIXED-with-commit or BLOCKED-with-question. The packaged build PASSes all 6 Bars on Windows (or, if any Bar still FAILs after fixes, the executor flags the regression loop to the user). Wave 4 (documentation) can begin.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Locally-built NSIS .exe → second clean Windows install | First packaged-artifact crossing — every defect not caught here will hit real users in v1. |
| Defect-fix commit → main branch | Executor making code changes based on partial Windows evidence; risk of fix introducing macOS regression. |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-08-08 | Tampering | executor's `fix(08-win):` commit accidentally breaks macOS behavior (e.g., changes a path-resolution branch and the darwin branch falls through wrong) | mitigate | Each fix commit is atomic and small (one defect). The executor must re-read the file in full BEFORE editing (per <read_first>) and verify the darwin branch still has its expected behavior. If a fix touches a platform-branched function, the executor MUST explicitly mention the macOS behavior in the commit message body. |
| T-08-09 | Information Disclosure | packaged smoke .exe gets uploaded to a public location (release page, file-share) and a defect file accidentally contains an API key fragment | mitigate | Task 1 step 6 instructs user to verify api_key.bin is binary-encrypted; no requirement to log the plaintext key. Task 2's grep validates committed PACKAGED-SMOKE.md does NOT contain `sk-ant-`. |
| T-08-10 | Spoofing | unsigned .exe spoofed as a different "Sei" by a malicious actor | accept | Phase 4 D-Q2 ruled out v1 code-signing. SmartScreen "unknown publisher" warning is the accepted user-side gate. Wave 4 RELEASE-NOTES documents this for end users. |
| T-08-11 | DoS | npm install / dist:win on Windows hits MAX_PATH=260 path-length limit with deeply-nested node_modules and silently corrupts artifacts | mitigate | Task 1 explicitly checks for path-length warnings in the build output. If the limit triggers, the documented fix is to enable Long Path Support on Windows 10/11 (regedit or group policy) — added as a defect row in `08-WINDOWS-DEFECTS.md` and addressed in `08-WINDOWS-GUIDE.md` (Wave 4). |
| T-08-12 | Repudiation | defect marked FIXED with commit hash, but the fix didn't actually pass on Windows (executor's static-fix reasoning was wrong, user didn't re-verify) | mitigate | Task 2 step 6 explicitly requires the user to re-verify each FIXED row on Windows and update the "Post-Defect-Fix Re-Verification" table. If they cannot or do not, the SUMMARY surfaces the un-re-verified fixes as a remaining-risk list. |
</threat_model>

<verification>
- `08-PACKAGED-SMOKE.md` exists with PASS/FAIL per Bar #1-#6 and per Wave-3 Hotspots row.
- `08-WINDOWS-DEFECTS.md` has zero `Fix status: OPEN` rows (all FIXED or BLOCKED).
- Every FIXED row has a `Fix commit: <hash>` — the hash matches `git log --oneline | grep 'fix(08-win):'`.
- If any BLOCKED rows exist, the SUMMARY surfaces the specific evidence question.
- Re-verification table in PACKAGED-SMOKE.md is populated for every FIXED row (PASS or STILL-FAILING).
</verification>

<success_criteria>
- All 6 Bars from CONTEXT §"Scope of 'works'" PASS on Windows.
- Zero OPEN defects remain (all FIXED or BLOCKED-with-question).
- Phase 9 (custom skins setup wizard) can confidently build on the now-known-good Windows substrate, including the deterministic `%APPDATA%\Sei\` user-data root.
- Wave 4 (Plan 08-04) documentation has the smoke evidence + defect log + fix commits to cite.
</success_criteria>

<output>
After completion, create `.planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-03-SUMMARY.md` documenting:
- Build host + install host + network topology
- Per-Bar PASS/FAIL/DEFERRED counts
- List of every `fix(08-win):` commit with hash + one-line summary
- Any BLOCKED defects with their evidence question (so user can resume)
- Confirmation that every Bar from CONTEXT §"Scope of 'works'" eventually reached PASS
- Pointer to Plan 08-04 (Wave 4 documentation)
</output>
