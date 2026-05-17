---
phase: 08-cross-platform-compatibility
plan: 04
type: execute
wave: 4
depends_on: [01, 02, 03]
files_modified:
  - README.md
  - .planning/phases/04-electron-gui-packaging/RELEASE-NOTES.md
  - .planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-WINDOWS-GUIDE.md
autonomous: true
requirements: []
must_haves:
  truths:
    - "`README.md` has a 'Windows install' section that mirrors the existing macOS-focused 'Quickstart' — covering Node 20 install, git clone, npm install, npm run dev for developers AND `npm run dist:win` for packaging — plus a 'Known limitations on Windows' subsection enumerating SmartScreen warning (Phase 4 D-Q2), multicast NAT bridging caveat (WARNING-9 from Phase 4 04-11), and the per-user install location"
    - "`.planning/phases/04-electron-gui-packaging/RELEASE-NOTES.md` gets a new 'Windows' install entry (or its existing Windows entry is updated) that cites Phase 8's smoke results and confirms the v1 unsigned-NSIS strategy"
    - "`08-WINDOWS-GUIDE.md` enumerates every platform-sensitive file from `08-HOTSPOTS.md` (every row, not just the Wave-2/Wave-3 deferred ones) with the convention it follows — becomes the canonical reference for Phase 9 (custom-skin setup wizard) and any future cross-platform contribution"
    - "Documentation cites the appId lock decision (`com.sei.app` per Plan 08-01 Task 2) and explains the irreversibility of changing it post-v1 release"
    - "No new code changes in this plan — documentation only; no risk of breaking the smoke pass that Wave 3 just established"
  artifacts:
    - path: README.md
      provides: "User-facing developer + packaging install instructions on Windows alongside macOS"
      contains: "## Windows"
    - path: .planning/phases/04-electron-gui-packaging/RELEASE-NOTES.md
      provides: "v1 release notes updated to reflect Phase 8 Windows validation evidence"
      contains: "Windows"
    - path: .planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-WINDOWS-GUIDE.md
      provides: "Canonical cross-platform reference — file-by-file conventions, the appId/productName contract, the asarUnpack glob explanation"
      contains: "## File-by-file cross-platform conventions"
  key_links:
    - from: README.md (Windows section)
      to: 08-WINDOWS-GUIDE.md
      via: "README links the guide as 'For contributors: see 08-WINDOWS-GUIDE.md for cross-platform conventions'"
      pattern: "08-WINDOWS-GUIDE.md"
    - from: 08-WINDOWS-GUIDE.md
      to: 08-HOTSPOTS.md
      via: "Guide cites HOTSPOTS as its primary source"
      pattern: "08-HOTSPOTS.md"
    - from: RELEASE-NOTES.md (Windows entry)
      to: 08-PACKAGED-SMOKE.md
      via: "Release notes cites smoke evidence date and SmartScreen UX from packaged-smoke"
      pattern: "08-PACKAGED-SMOKE"
---

<objective>
Write the user-facing and contributor-facing documentation that Phase 8 produces: a Windows install section in `README.md`, a Windows entry update in `.planning/phases/04-electron-gui-packaging/RELEASE-NOTES.md`, and a `08-WINDOWS-GUIDE.md` reference document. These are produced statically from `08-HOTSPOTS.md` (Wave 1), `08-DEV-SMOKE.md` (Wave 2), and `08-PACKAGED-SMOKE.md` + `08-WINDOWS-DEFECTS.md` (Wave 3). No code changes; no live-Windows requirement.

Purpose: Phase 8 closes with a documented Windows install story so (a) end users have install instructions matching the now-verified packaged-build behavior, (b) v1 release notes accurately reflect what's been validated, (c) Phase 9 (custom-skin setup wizard) has a canonical reference for `%APPDATA%\Sei\` paths and cross-platform conventions, and (d) future contributors don't re-discover the same cross-platform hotspots when adding code.

Output: 3 modified or created markdown files. All written from in-context evidence (HOTSPOTS + the Wave 2/3 smoke files); no live-Windows access needed.
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
@.planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-DEV-SMOKE.md
@.planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-PACKAGED-SMOKE.md
@.planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-WINDOWS-DEFECTS.md
@.planning/phases/04-electron-gui-packaging/RELEASE-NOTES.md
@README.md
@electron-builder.yml

<interfaces>
<!-- README current "Quickstart" is macOS-focused -->
The existing README §Quickstart (lines 11-19 approx) covers: `git clone`, `cd sei`, `npm i`, `npm link`, `sei` (CLI onboarding), then "Open to LAN" + `sei start`.

This is dev-mode CLI usage. Phase 4 added Electron GUI (`npm run dev` for dev launch, `npm run dist:mac/win/linux` for packaging). README mentions Electron in "Progress" section but the install path is not documented for GUI.

Phase 8's README addition does NOT replace the existing macOS Quickstart; it ADDs a Windows section AFTER the existing macOS section, plus a brief "Packaged install" subsection that points users to the v1 release notes for end-user .dmg/.exe downloads.

<!-- RELEASE-NOTES current Windows entry -->
RELEASE-NOTES.md §"Windows (.exe, **UNSIGNED v1**)" (Phase 4 04-11 Task 2 lines 191-198) already exists. Phase 8 updates this section to:
- Add a "Validated on" line citing 08-PACKAGED-SMOKE.md and the smoke-test date
- Add the locked appId (com.sei.app) reference for forensic clarity
- Keep the existing SmartScreen walkthrough
- Cross-link `08-WINDOWS-GUIDE.md` for power users wanting cross-platform invariants

<!-- 08-WINDOWS-GUIDE.md structure -->
The guide is the FOREVER-REFERENCE: a future Phase 9 author or any contributor opens this file when they need to know "where does <userData> resolve on Windows?" or "do I need a platform branch for this new code path?". Its source-of-truth is 08-HOTSPOTS.md plus the smoke files; the guide reorganizes that evidence by file/topic instead of by audit-row.
</interfaces>

<key_locked_decisions>
- planning_context "Wave 4 (Documentation): autonomous: true — README Windows section, RELEASE-NOTES Windows entry, 08-WINDOWS-GUIDE.md are all written from static evidence + CONTEXT.md."
- CONTEXT §"Document Windows install/run flow in README.md + RELEASE-NOTES.md (matches Phase 4 plan 04-11 pattern)" — the existing Phase 4 macOS pattern is the template.
- CONTEXT §specifics — "The README's current 'Install / Run' section is macOS-focused. A 'Windows install' section should mirror it, plus a 'Known limitations' subsection (SmartScreen warning is the main one)."
- CONTEXT §specifics — "electron-builder install-app-deps (the postinstall hook) MUST run on the Windows machine. If a user clones the repo on macOS, copies node_modules/ to Windows, things will break. Document this clearly in the Windows section of README."
- The appId lock (`com.sei.app`) from Plan 01 Task 2 + the productName (`Sei`) drive `%APPDATA%\Sei\` resolution. Documentation cites this pair as the v1 contract.
- The guide is NOT a how-to-debug document; it's a how-to-not-break-cross-platform reference. Aimed at future contributors (or Phase 9 author).
- No code changes in this plan. README.md + RELEASE-NOTES.md edits are surgical (add new sections; existing sections preserved).
</key_locked_decisions>
</context>

<tasks>

<task type="auto" tdd="false">
  <name>Task 1: Add Windows install + dev section to README.md (preserve existing macOS Quickstart)</name>
  <read_first>
    - README.md (full file — confirm exactly where the existing Quickstart ends and how to insert the Windows section without disrupting the Credits / Progress / Contributing sections that follow)
    - .planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-CONTEXT.md §specifics (the README-Windows-section bullet)
    - .planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-DEV-SMOKE.md (Wave 2 PASS evidence — cite which Node version + which Windows builds are validated)
    - .planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-PACKAGED-SMOKE.md (Wave 3 PASS evidence — cite smoke date)
    - .planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-WINDOWS-DEFECTS.md (any caveats users need to know about that came up during smoke — e.g., MAX_PATH long-path requirement, Defender exclusion)
  </read_first>
  <behavior>
    Add a new section to README.md AFTER the existing "Quickstart" section and BEFORE the "Progress" section. The section is `## Windows (developers + packagers)`. It MUST cover:

    1. **Prereqs:** Node 20 LTS (link to nodejs.org installer), Git for Windows (link to git-scm.com).
    2. **Dev mode (clone + `npm run dev`):** identical commands to macOS Quickstart but with the explicit reminder that `node_modules/` is platform-specific (don't copy from a macOS clone; run `npm install` fresh on Windows per CONTEXT §specifics).
    3. **Packaged build (`npm run dist:win`):** explicit step to produce `release\Sei Setup 0.1.0.exe` on a Windows host. Note: the exec must build ON Windows (not cross-compile from macOS) so toolchain quirks are validated.
    4. **Known limitations on Windows:**
       - SmartScreen "unknown publisher" warning on first .exe launch (Phase 4 D-Q2 — unsigned v1; click "More info" → "Run anyway").
       - LAN multicast bridging in VMs (WARNING-9 — NAT'd VMs may not see Minecraft LAN broadcasts; bare-metal or bridged-network VM required).
       - User-data root is `%APPDATA%\Sei\` — survives uninstall by design.
       - (If 08-WINDOWS-DEFECTS.md flagged Defender false-positive or long-path requirement, add a bullet for each.)
    5. **Pointer for contributors:** "For cross-platform code conventions, see `.planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-WINDOWS-GUIDE.md`."

    Do NOT remove or rewrite the existing macOS Quickstart, Progress, Credits, or Contributing sections. Do NOT change the project tagline / first paragraph. The Windows section is ADDITIVE.
  </behavior>
  <action>
**Step 1.** Read README.md in full (already in read_first). Identify the exact line after which the new section is inserted: the line `Then open a Minecraft world, click "Open to LAN", and run \`sei start\`. Re-run onboarding any time with \`sei config\`.` is the last line of the existing Quickstart. Insert the new section immediately after that line (a blank line then `## Windows`).

**Step 2.** Use the Edit tool to insert. The insertion content:

```markdown

## Windows (developers + packagers)

Sei is validated on Windows 10/11 x64 (per Phase 8 packaged-smoke evidence in `.planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-PACKAGED-SMOKE.md`). The GUI runs in dev mode via `npm run dev` and packages via `npm run dist:win`.

### Prerequisites

- Node.js 20 LTS — install from https://nodejs.org/en/download/ (.msi for Windows x64)
- Git for Windows — install from https://git-scm.com/download/win
- (For LAN summon) Minecraft Java Edition on the same physical LAN as your Sei host

### Dev mode

```powershell
git clone <repo-url> sei
cd sei
npm install           # IMPORTANT: run on Windows — node_modules/ is platform-specific.
                      # Do NOT copy node_modules/ from a macOS clone; it will not work.
npm run dev           # launches Electron in dev mode against src/main + src/renderer
```

The dev launch opens an Electron window with the Windows title-bar overlay chrome. Onboarding writes config to `%APPDATA%\Sei\config.json` and the API key to `%APPDATA%\Sei\api_key.bin` (DPAPI-encrypted via Electron `safeStorage`).

### Packaged build

```powershell
npm run dist:win      # electron-vite build && electron-builder --win
                      # Produces release\Sei Setup 0.1.0.exe (NSIS installer)
```

Build ON Windows. Cross-compiling from macOS via `electron-builder --win` is technically supported but is NOT the validated Phase 8 path; toolchain quirks (Defender false-positives, MAX_PATH limits, codepage handling) should be exercised on the target platform.

### Install + first launch

1. Run `Sei Setup 0.1.0.exe`.
2. **SmartScreen warns "Windows protected your PC."** Click `More info` → `Run anyway`. Sei v1 ships unsigned on Windows by design (no Authenticode cert yet); future maintenance release adds signing.
3. NSIS welcome → choose install directory → install. Per-user install at `%LOCALAPPDATA%\Programs\Sei\` by default — no admin prompt required.
4. Launch from Start Menu. Complete onboarding (API key, persona). Files land in `%APPDATA%\Sei\`.

### Known limitations on Windows

- **SmartScreen warning on first .exe launch.** Expected v1 UX. One-time click-through.
- **LAN multicast in VMs.** Minecraft's "Open to LAN" multicasts to `224.0.2.60:4445`. NAT'd VMs (VirtualBox default NAT, Parallels Shared, UTM Shared) do NOT bridge this. To use Sei's LAN auto-detect in a VM, switch to a bridged-network adapter, OR run Sei on bare metal on the same physical LAN as the Minecraft host.
- **User-data root is `%APPDATA%\Sei\`.** Files persist across uninstall by design (so re-install keeps your characters and memory). If you want a clean reset, delete `%APPDATA%\Sei\` manually OR use the CLI `sei reset` command.
- **Windows 10+ x64 only.** Windows 7/8 are unsupported (Electron 42 minimum). No ARM64 Windows target in v1.

### Contributors: cross-platform conventions

When adding code that touches the filesystem, environment variables, child processes, or platform-branched UI: read `.planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-WINDOWS-GUIDE.md` first. It enumerates every cross-platform-sensitive file with its current convention so you don't re-discover the same hotspots.
```

**Step 3.** Verify the insertion did not corrupt the rest of the file:

```bash
# These existing sections must still be present and intact:
grep -q "^## Quickstart$" README.md
grep -q "^## Progress$" README.md
grep -q "^## Credits$" README.md
grep -q "^## Contributing$" README.md
# AND the new section is present:
grep -q "^## Windows (developers + packagers)$" README.md
grep -q "^### Known limitations on Windows$" README.md
```

All five greps must return exit 0.
  </action>
  <verify>
    <automated>bash -c 'grep -q "^## Quickstart$" README.md && grep -q "^## Windows (developers + packagers)$" README.md && grep -q "^### Prerequisites$" README.md && grep -q "^### Dev mode$" README.md && grep -q "^### Packaged build$" README.md && grep -q "^### Install + first launch$" README.md && grep -q "^### Known limitations on Windows$" README.md && grep -q "^### Contributors: cross-platform conventions$" README.md && grep -q "%APPDATA%" README.md && grep -q "SmartScreen" README.md && grep -q "08-WINDOWS-GUIDE.md" README.md && grep -q "224.0.2.60:4445\\|LAN multicast" README.md && grep -q "node_modules" README.md && grep -q "DPAPI\\|safeStorage" README.md && grep -q "^## Progress$" README.md && grep -q "^## Credits$" README.md && grep -q "^## Contributing$" README.md'</automated>
  </verify>
  <acceptance_criteria>
    - README.md contains a new `## Windows (developers + packagers)` section
    - New section has subsections: `### Prerequisites`, `### Dev mode`, `### Packaged build`, `### Install + first launch`, `### Known limitations on Windows`, `### Contributors: cross-platform conventions`
    - File mentions `%APPDATA%`, `SmartScreen`, `224.0.2.60:4445` or `LAN multicast`, `node_modules`, `DPAPI` or `safeStorage`
    - File links to `08-WINDOWS-GUIDE.md`
    - Existing sections still present: `## Quickstart`, `## Progress`, `## Credits`, `## Contributing` (no rewrites)
  </acceptance_criteria>
  <done>README has a complete Windows section. End users can install + use Sei on Windows from README alone; contributors know where to find cross-platform conventions.</done>
</task>

<task type="auto" tdd="false">
  <name>Task 2: Update RELEASE-NOTES.md Windows entry with Phase 8 validation evidence</name>
  <read_first>
    - .planning/phases/04-electron-gui-packaging/RELEASE-NOTES.md (full file — find the existing Windows section)
    - .planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-PACKAGED-SMOKE.md (smoke date + Bar PASS evidence)
    - .planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-WINDOWS-DEFECTS.md (any user-facing caveats)
    - electron-builder.yml (confirm locked appId — `com.sei.app`)
  </read_first>
  <behavior>
    Find the existing `### Windows (.exe, **UNSIGNED v1**)` section in RELEASE-NOTES.md (Phase 4 Plan 04-11 Task 2 wrote it). Update it to:

    1. Keep all existing content (the SmartScreen walkthrough is the v1 UX contract — do NOT remove it).
    2. ADD a "Validated on" line below the install steps citing the Phase 8 packaged-smoke date and Windows builds tested.
    3. ADD a one-line reference to the locked appId (`com.sei.app`) for forensic clarity — this is the keychain-binding contract.
    4. ADD a cross-link to `08-WINDOWS-GUIDE.md` near the existing "Roadmap" section (or in a new "Cross-platform contributors" subsection if cleaner).

    Find the "Bundle ID is locked" subsection that already exists (Phase 4 04-11 Task 2 included a `<the-locked-appId>` placeholder). REPLACE the placeholder with `com.sei.app`.

    Do NOT touch other release notes content (macOS, Linux, roadmap roadmap, build provenance) except to fix the bundle-ID placeholder.
  </behavior>
  <action>
**Step 1.** Read RELEASE-NOTES.md to confirm layout. Phase 4 04-11 Task 2 wrote it with placeholder `<the-locked-appId>` — that's what we replace.

**Step 2.** Use the Edit tool to replace each instance:

**Edit 1: Replace the appId placeholder.** Search for `<the-locked-appId>` and replace with `com.sei.app`. There may be multiple occurrences — replace ALL of them (the placeholder appears in the "Bundle ID is locked" section + possibly elsewhere). Use Read first to locate every occurrence.

**Edit 2: Add Phase 8 validation evidence to the Windows section.** Locate the line `### Windows (.exe, **UNSIGNED v1**)`. AFTER the existing 4-step install procedure in that section AND BEFORE the closing paragraph "This is expected for v1...", INSERT:

```markdown

**Validated:** Phase 8 packaged smoke confirmed install + first-launch + bot summon + clean stop on Windows 10/11 x64 (see `.planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-PACKAGED-SMOKE.md` for full evidence).

**User-data root:** `%APPDATA%\Sei\` — persists across uninstall.

**Bundle ID:** `com.sei.app` (locked Phase 8 Plan 01 Task 2 — irreversible without stranding existing users' DPAPI-encrypted Keychain entries).
```

**Edit 3: Add a cross-link to the contributor guide.** Locate the existing "Build provenance" section near the bottom. AFTER the "Build provenance" section, INSERT a new section:

```markdown

## For cross-platform contributors

`.planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-WINDOWS-GUIDE.md` enumerates every cross-platform-sensitive file in the codebase with its current convention. Read it before adding code that touches the filesystem, environment variables, or platform-branched UI.
```

**Step 3.** Verify with greps:

```bash
F=.planning/phases/04-electron-gui-packaging/RELEASE-NOTES.md
! grep -q "<the-locked-appId>" "$F"      # placeholder removed
grep -q "com.sei.app" "$F"                # actual appId present
grep -q "Validated:" "$F"                 # Phase 8 evidence line added
grep -q "08-WINDOWS-GUIDE.md" "$F"        # contributor cross-link
grep -q "08-PACKAGED-SMOKE.md" "$F"       # smoke evidence reference
grep -q "### Windows" "$F"                # existing Windows section still there
grep -q "SmartScreen" "$F"                # existing SmartScreen walkthrough preserved
```
  </action>
  <verify>
    <automated>bash -c 'F=.planning/phases/04-electron-gui-packaging/RELEASE-NOTES.md && test -f "$F" && ! grep -q "<the-locked-appId>" "$F" && grep -q "com.sei.app" "$F" && grep -q "Validated:" "$F" && grep -q "08-WINDOWS-GUIDE.md" "$F" && grep -q "08-PACKAGED-SMOKE.md" "$F" && grep -q "### Windows" "$F" && grep -q "SmartScreen" "$F" && grep -q "Bundle ID:" "$F" && grep -q "%APPDATA%\\\\Sei\\\\\\|%APPDATA%.Sei" "$F"'</automated>
  </verify>
  <acceptance_criteria>
    - `RELEASE-NOTES.md` placeholder `<the-locked-appId>` is GONE (zero occurrences)
    - `com.sei.app` is present (the actual locked appId)
    - "Validated:" line referencing 08-PACKAGED-SMOKE.md added under the Windows section
    - "Bundle ID:" line referencing com.sei.app added under the Windows section
    - `%APPDATA%\Sei\` referenced in the Windows section
    - Cross-link `08-WINDOWS-GUIDE.md` present in the file
    - Existing `### Windows`, `SmartScreen`, macOS, Linux, Roadmap, Build provenance sections are untouched
  </acceptance_criteria>
  <done>RELEASE-NOTES.md reflects Phase 8's actual validation. The locked appId is documented; the keychain-binding contract is explicit.</done>
</task>

<task type="auto" tdd="false">
  <name>Task 3: Author 08-WINDOWS-GUIDE.md — canonical cross-platform reference</name>
  <read_first>
    - .planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-HOTSPOTS.md (the primary source — every row becomes a guide entry)
    - .planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-DEV-SMOKE.md (Wave 2 PASS evidence — cite what was verified live)
    - .planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-PACKAGED-SMOKE.md (Wave 3 PASS evidence)
    - .planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-WINDOWS-DEFECTS.md (defects fixed during Phase 8 — each becomes a "lessons learned" callout)
    - electron-builder.yml (productName: Sei + appId: com.sei.app — the userData-resolution contract)
    - src/main/paths.ts (the canonical userData accessor)
    - src/bot/cli/index.js L300-322 (the CLI mirror of electronUserDataDir)
  </read_first>
  <behavior>
    Author a single document `08-WINDOWS-GUIDE.md` that:

    1. **States the contract** — productName=`Sei` + appId=`com.sei.app` ⇒ `<userData>` = `%APPDATA%\Sei\` (Windows) / `~/Library/Application Support/Sei/` (macOS) / `~/.config/Sei/` (Linux).
    2. **Enumerates every cross-platform-sensitive file** from HOTSPOTS.md, reorganized by FILE (not by audit-row). Each entry describes:
       - File path
       - Convention used (e.g., "all paths funnel through `app.getPath('userData')` + `path.join`")
       - When you must add a platform branch (e.g., "only if the file format or invariant differs by platform — most filesystem code does NOT need a branch")
       - Existing platform branches (if any) with the rationale
    3. **Records Phase-8-era defects + fixes** as "Lessons learned" — each fixed defect from `08-WINDOWS-DEFECTS.md` becomes a one-line warning entry so future contributors don't repeat the mistake.
    4. **Documents the appId-lock contract** — irreversibility, what depends on it (keychain, Windows DPAPI store path).
    5. **Out-of-scope reminder** — what Phase 8 explicitly did NOT validate (Linux end-to-end, ARM64, performance) per CONTEXT §deferred.
    6. **For Phase 9 specifically** — a short "What Phase 9 inherits" section enumerating the cross-platform invariants Phase 9's setup wizard can rely on.

    The document is FOREVER-REFERENCE. It does not require a Windows machine to read or apply (static reference). It will be updated by future cross-platform work as new conventions emerge.
  </behavior>
  <action>
**Step 1.** Create `.planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-WINDOWS-GUIDE.md` with the following structure. Fill in concrete details from HOTSPOTS + the smoke files. Do not abbreviate.

```markdown
# 08-WINDOWS-GUIDE.md — Cross-Platform Conventions Reference

**Purpose:** Canonical reference for cross-platform-sensitive code in Sei. Read this before adding code that touches the filesystem, environment variables, child processes, or platform-branched UI. It is derived from:

- `08-HOTSPOTS.md` (Wave 1 static audit — primary source)
- `08-DEV-SMOKE.md` (Wave 2 live dev evidence)
- `08-PACKAGED-SMOKE.md` (Wave 3 live packaged evidence)
- `08-WINDOWS-DEFECTS.md` (defects discovered + fixed during Phase 8 — the "lessons learned" entries below)

**Last updated:** 2026-05-17 (Phase 8 Plan 04)

---

## 1. The userData-resolution contract

`electron-builder.yml` has two fields that together determine where Sei's per-user data goes on every platform:

| Field | Value | Purpose |
|-------|-------|---------|
| `productName` | `Sei` | Drives the on-disk directory name on every platform (Electron uses productName when set, else appId) |
| `appId` | `com.sei.app` | Bundle identifier — binds macOS Keychain entries (`safeStorage`), Windows DPAPI store (`safeStorage`), and `app.getPath('userData')` resolution on platforms where productName isn't honored |

Resulting `app.getPath('userData')` per platform:

| Platform | Resolved path |
|----------|---------------|
| Windows | `%APPDATA%\Sei\` (e.g. `C:\Users\<user>\AppData\Roaming\Sei`) |
| macOS | `~/Library/Application Support/Sei/` |
| Linux | `$XDG_CONFIG_HOME/Sei/` (default: `~/.config/Sei/`) |

**Hard contract: changing `appId` post-v1 release strands all existing users' Keychain entries.** Phase 8 locked it on 2026-05-17. Treat as irreversible.

The CLI (`src/bot/cli/index.js:308-322 electronUserDataDir`) mirrors this resolution WITHOUT importing Electron (so the CLI stays light). The constant `APP = 'Sei'` in CLI MUST stay in sync with `productName: Sei` in `electron-builder.yml`. If anyone ever changes productName, change the CLI constant too — searches for `const APP = 'Sei'` will find it.

---

## 2. File-by-file cross-platform conventions

Listed roughly in dependency order (foundation → user-visible). Source: `08-HOTSPOTS.md`.

### `src/main/paths.ts`

**Convention:** ALL `<userData>/...` reads/writes funnel through `app.getPath('userData')` + `path.join`. No raw string concatenation. Single point of override for tests via `_setUserDataOverride`.

**Platform branches:** None (Electron handles platform resolution internally).

**When to add a new path:** Add a new function to the `paths` export. Always use `path.join(userDataRoot(), 'subdir', filename)` — never string concat.

### `src/main/botSupervisor.ts`

**Convention:** `botEntryPath()` at L73-88 has two branches: packaged (asar-unpacked path) and dev (`path.join(__dirname, '../../src/bot/index.js')`). Both use `path.join`. The packaged branch resolves `process.resourcesPath` (Electron) which is cross-platform.

**Platform branches:** None — `app.isPackaged` distinguishes dev from packaged, NOT platform.

**asarUnpack dependency:** `electron-builder.yml` MUST list `src/bot/**/*` in `asarUnpack` because `utilityProcess.fork` cannot enter `.asar` archives (Pitfall 1 from Phase 4 research).

### `src/main/windowChrome.ts`

**Convention:** Three platform branches (`darwin`, `win32`, else) for BrowserWindow chrome options. Each branch picks a single chrome style appropriate to platform native expectations.

**Platform branches:**
- `darwin`: `{ titleBarStyle: 'hiddenInset' }` — macOS traffic-light buttons inset
- `win32`: `{ frame: false, titleBarOverlay: { color, symbolColor, height: 38 } }` — custom title bar with Windows-style min/max/close
- else (Linux): `{ frame: false }` — bare frameless

**When to add a branch:** Only if a new chrome option is needed for a NEW platform (e.g., ARM64 Windows). Don't fragment per-version (Win10 vs Win11) — Electron normalizes.

### `src/main/index.ts`

**Convention:** Two platform-aware branches.

**Platform branches:**
- L123: Linux-only basic_text safeStorage warning (only fires when `process.platform === 'linux' && backendKind() === 'basic_text'`). Windows always uses DPAPI, never falls back.
- L157: `app.on('window-all-closed')` quits the app on non-darwin (`process.platform !== 'darwin'`) — macOS keeps app alive when last window closes per platform convention.

**When to add a branch:** Only for genuinely platform-divergent lifecycle behavior. Most app logic stays cross-platform.

### `src/main/ipc.ts`

**Convention:** L88-93 `app.warnings` handler returns Linux-fallback flag. Renderer reads this to decide whether to show the basic_text banner.

**Platform branches:** Single linux+basic_text check; everywhere else returns false.

### `src/bot/cli/index.js` — `electronUserDataDir()`

**Convention:** Three branches mirror Electron's `app.getPath('userData')` WITHOUT importing Electron. Hardcoded `APP = 'Sei'` constant MUST match `productName: Sei` in `electron-builder.yml`.

**Platform branches:**
- `darwin`: `~/Library/Application Support/Sei/`
- `win32`: `%APPDATA%\Sei\` (fallback to `~\AppData\Roaming\Sei\`)
- else: `$XDG_CONFIG_HOME/Sei/` (fallback to `~/.config/Sei/`)

**When to add code:** If you need to read the userData root from a non-Electron context (CLI, scripts, tests), call this function — don't reinvent.

### `src/bot/brain/storage/atomicWrite.js`

**Convention:** `writeFile(tmp, contents, 'utf8')` + `rename(tmp, path)`. utf8 is byte-faithful — no implicit `\n` → `\r\n` conversion. All markdown writers in `src/bot/brain/memory/` write literal `\n`-separated content; readers `.split('\n')`. Round-trip is byte-identical mac ↔ Windows.

**Platform branches:** None. Node's `fs/promises` writeFile + rename is cross-platform-safe.

**Don't break the contract:** Never introduce `os.EOL` into a memory-file write. Never use `'binary'` mode (which on some platforms re-encodes line endings). Markdown files are LF-only by intent.

### `electron-builder.yml`

**Conventions worth knowing:**
- `asar: true` + `asarUnpack: ['src/bot/**/*']` — required for utilityProcess.fork.
- `mac.target: dmg arch:[universal]` — universal binary for both Intel and Apple Silicon.
- `win.target: nsis arch:[x64]` — NSIS installer, x64 only (no ARM Windows in v1).
- `nsis.perMachine: false` — per-user install, no admin prompt.
- `nsis.allowToChangeInstallationDirectory: true` — user picks install dir.
- NO `signtoolOptions` / NO `azureSignOptions` — v1 ships unsigned on Windows; SmartScreen warning is accepted UX.

**Don't accidentally:** Add a `publish:` key (auto-update is out of scope per Phase 4 D-63). Change `productName` without also updating `APP` in `src/bot/cli/index.js`. Add an arch-specific entry without verifying the smoke pass for that arch.

### `src/renderer/src/styles/fonts.css`

**Convention:** `@font-face { src: url('/fonts/<file>.woff2') }` — forward-slash URLs (HTTP/file-URL syntax, NOT filesystem syntax — cross-platform-safe at the protocol layer). Font files live at `src/renderer/public/fonts/` and Vite bundles them to `dist/renderer/fonts/` during build.

**Platform branches:** None.

**Phase 8 verification (Wave 2):** All 5 woff2 files (noto-sans-400, noto-sans-600, press-start-2p-400, jetbrains-mono-400, jetbrains-mono-500) load with 200 OK in DevTools Network tab on Windows dev. Packaged build (Wave 3) confirms `dist/renderer/fonts/` is bundled into the asar.

---

## 3. Lessons learned (defects fixed during Phase 8)

Each row below is a defect that was discovered during Phase 8 smoke testing and fixed in Wave 3. Each is documented so future contributors do not repeat the pattern.

(Populate this section from `08-WINDOWS-DEFECTS.md` rows with `Fix status: FIXED`. If Phase 8 found zero defects, write: "Wave 2 + Wave 3 smoke clean — zero Windows-only defects found. The audit (Wave 1) caught what was statically discoverable; the live smokes confirmed no runtime defects." )

Template per defect:

> **WIN-DEFECT-NN — `<short description>`**
> Symptom: `<one line>`
> Root cause: `<one line>`
> Fix: `<commit hash>` (`fix(08-win): <description>`)
> Future-proof: `<what to grep / what convention to follow to never repeat this>`

---

## 4. Out-of-scope reminders

Phase 8 explicitly did NOT validate:

- **Linux end-to-end.** AppImage build is best-effort per Phase 4 D-60. Smoke is at the audit-static level only.
- **ARM64 Windows.** Out per `arch: [x64]` and CONTEXT §deferred.
- **Performance comparison mac vs Windows.** Not in scope.
- **Code-signing the .exe.** Phase 4 D-Q2 ruled out for v1.
- **GitHub Actions CI matrix.** Deferred to a maintenance phase per CONTEXT §"No GitHub Actions Windows runner yet".
- **Windows 7/8.** Below Electron 42 minimum.

If a future need to validate any of these emerges, scope as its own phase (or a maintenance phase).

---

## 5. What Phase 9 (custom-skin setup wizard) inherits

Phase 9 builds on the Phase 8 substrate. Phase 9 can rely on:

1. `%APPDATA%\Sei\` exists and is writable post-onboarding (locked appId + productName).
2. `utilityProcess.fork` against `path.join(__dirname, '../../src/bot/index.js')` (dev) or asar-unpacked path (packaged) works on Windows.
3. The Windows title-bar overlay chrome is rendered correctly — Phase 9's wizard UI can sit in the same window without chrome regressions.
4. DPAPI safeStorage is the secret backend on Windows (no Linux-fallback banner expected).
5. atomicWrite round-trips byte-identical between Windows and macOS — Phase 9's persisted skin metadata (e.g. `skinId` per character) is safe to write via the same primitive.

Phase 9 MUST verify on Windows (specific to Phase 9's new code paths):

- Locating the Minecraft Java install directory across platforms (e.g., `%APPDATA%\.minecraft\` on Windows vs `~/Library/Application Support/minecraft/` on macOS). The pattern from `electronUserDataDir()` is the model — add a `minecraftInstallDir()` helper with the same three-branch shape.
- Fabric Loader installer behavior on Windows (download, run installer, profile registration). Spawn the JAR via Node's `child_process.spawn` with `'java'` in the user's PATH (or surface a "Java not installed" error mapped to a renderer ErrorClass).
- CustomSkinLoader mod placement at `%APPDATA%\.minecraft\mods\` (Windows) vs `~/Library/Application Support/minecraft/mods/` (macOS).

Phase 9's RESEARCH already documents this in its own CONTEXT — this section is just a pointer.

---

## 6. Update protocol

When future cross-platform work changes any convention in this guide:

1. Update the relevant section here AND in `08-HOTSPOTS.md` (if a hotspot row changes).
2. Bump the "Last updated" date at the top.
3. If a new platform branch is added (e.g., ARM64), add a row to the relevant file's table.
4. Never delete sections — convert obsolete ones to "Historical (no longer applicable)" notes with a date.
```

**Step 2.** When filling §3 (Lessons learned), READ the actual contents of `08-WINDOWS-DEFECTS.md` to extract FIXED rows. If the file shows zero FIXED rows (Wave 2 + Wave 3 smoke clean), use the explicit "zero defects" sentence from the template.

**Step 3.** Verify with greps after writing:

```bash
F=.planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-WINDOWS-GUIDE.md
test -f "$F"
grep -q "^# 08-WINDOWS-GUIDE.md" "$F"
grep -q "^## 1. The userData-resolution contract$" "$F"
grep -q "^## 2. File-by-file cross-platform conventions$" "$F"
grep -q "^## 3. Lessons learned" "$F"
grep -q "^## 4. Out-of-scope reminders$" "$F"
grep -q "^## 5. What Phase 9" "$F"
grep -q "^## 6. Update protocol$" "$F"
grep -q "src/main/paths.ts" "$F"
grep -q "src/main/botSupervisor.ts" "$F"
grep -q "src/main/windowChrome.ts" "$F"
grep -q "src/bot/cli/index.js" "$F"
grep -q "atomicWrite" "$F"
grep -q "com.sei.app" "$F"
grep -q "%APPDATA%" "$F"
grep -q "asarUnpack" "$F"
```
  </action>
  <verify>
    <automated>bash -c 'F=.planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-WINDOWS-GUIDE.md && test -f "$F" && grep -q "^# 08-WINDOWS-GUIDE.md" "$F" && grep -q "^## 1. The userData-resolution contract$" "$F" && grep -q "^## 2. File-by-file cross-platform conventions$" "$F" && grep -q "^## 3. Lessons learned" "$F" && grep -q "^## 4. Out-of-scope reminders$" "$F" && grep -q "^## 5. What Phase 9" "$F" && grep -q "^## 6. Update protocol$" "$F" && grep -q "src/main/paths.ts" "$F" && grep -q "src/main/botSupervisor.ts" "$F" && grep -q "src/main/windowChrome.ts" "$F" && grep -q "src/bot/cli/index.js" "$F" && grep -q "atomicWrite" "$F" && grep -q "com.sei.app" "$F" && grep -q "%APPDATA%" "$F" && grep -q "asarUnpack" "$F" && grep -q "productName: Sei\\|productName.*Sei" "$F"'</automated>
  </verify>
  <acceptance_criteria>
    - `08-WINDOWS-GUIDE.md` exists at the canonical phase path
    - File has all six required sections (1-6) per the template
    - Section 2 references at minimum: `src/main/paths.ts`, `src/main/botSupervisor.ts`, `src/main/windowChrome.ts`, `src/main/index.ts`, `src/main/ipc.ts`, `src/bot/cli/index.js`, `src/bot/brain/storage/atomicWrite.js`, `electron-builder.yml`, `src/renderer/src/styles/fonts.css`
    - Section 1 documents the productName+appId pair driving `%APPDATA%\Sei\` resolution
    - Section 3 either lists FIXED defects from `08-WINDOWS-DEFECTS.md` OR explicitly states zero-defects-found (if Wave 2/3 were clean)
    - File mentions `com.sei.app`, `%APPDATA%`, `asarUnpack`, `productName: Sei`
    - Section 5 enumerates Phase 9 inheritable invariants
  </acceptance_criteria>
  <done>Phase 8 ships a canonical cross-platform reference. Future contributors (and Phase 9 specifically) have a single document to read instead of re-deriving conventions from source.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| documentation files → end users + contributors | First write of the Windows install story; users follow these steps blindly. |
| README + RELEASE-NOTES → future Phase 9 author | The guide's "Phase 9 inherits" section becomes a hard contract Phase 9 builds against. |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-08-13 | Information Disclosure | documentation accidentally includes a real API key (sk-ant-...) or a user-specific path (`C:\Users\<realname>\...`) copied from smoke evidence | mitigate | Task 1/2/3 grep-validates the committed files do NOT contain `sk-ant-` or `C:\Users\` strings. Smoke evidence in 08-DEV-SMOKE.md / 08-PACKAGED-SMOKE.md is consumed as data but the published README/RELEASE-NOTES/GUIDE only inline generic placeholders like `%APPDATA%\Sei\` and `C:\Users\<user>\`. |
| T-08-14 | Tampering | documentation drifts from code over time (someone changes productName or appId without updating the guide) | mitigate | Section 6 "Update protocol" documents the requirement. Future cross-platform code changes that touch these conventions are responsible for updating the guide. Not enforceable at commit time; relies on reviewer diligence. |
| T-08-15 | Repudiation | README claims behavior that the smoke tests didn't actually validate (e.g., "works on Windows 11 ARM64") | mitigate | Documentation copies from the actual smoke evidence files (08-DEV-SMOKE.md, 08-PACKAGED-SMOKE.md). Any platform variant NOT covered by smoke evidence is explicitly listed in §4 "Out-of-scope reminders". |
</threat_model>

<verification>
- README.md has a complete Windows section.
- RELEASE-NOTES.md placeholder appId is replaced with `com.sei.app` and includes Phase 8 validation evidence.
- `08-WINDOWS-GUIDE.md` exists with all six required sections.
- No new code changes; the smoke pass from Wave 3 is preserved.
</verification>

<success_criteria>
- An end user who finds Sei via GitHub can install + use it on Windows from README alone.
- A contributor adding new code that touches the filesystem reads `08-WINDOWS-GUIDE.md` and follows the existing conventions instead of inventing new ones.
- Phase 9's author has a clean "what's inherited" contract — `%APPDATA%\Sei\`, DPAPI safeStorage, asarUnpack glob, atomic write semantics.
- Phase 8 is DONE. STATE.md + ROADMAP.md can be updated to mark Phase 8 complete (separate housekeeping after this plan's SUMMARY).
</success_criteria>

<output>
After completion, create `.planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-04-SUMMARY.md` documenting:
- Confirmation that README.md, RELEASE-NOTES.md, 08-WINDOWS-GUIDE.md are all updated/created
- Cross-link audit: every (README → GUIDE, RELEASE-NOTES → GUIDE, GUIDE → HOTSPOTS) reference resolves to an existing file
- Phase 8 closeout: update STATE.md (mark Phase 8 complete, set next action to `/gsd-plan-phase 9`) and ROADMAP.md (mark Phase 8 `[x]` in summary list). Cite the Wave-3 PASS evidence date.
- Pointer to Phase 9 (`/gsd-discuss-phase 9` or `/gsd-plan-phase 9` if context already captured per STATE.md notes — Phase 9 CONTEXT was captured pre-Phase-8 in `260517-frz-CONTEXT.md`).
</output>
