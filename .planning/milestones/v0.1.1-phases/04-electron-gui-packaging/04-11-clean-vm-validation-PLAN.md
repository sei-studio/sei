---
phase: 04-electron-gui-packaging
plan: 11
type: execute
wave: 9
depends_on: [01, 02, 03, 04, 05, 06, 07, 08, 09, 10]
files_modified:
  - .planning/phases/04-electron-gui-packaging/RELEASE-NOTES.md
autonomous: false
requirements: [PKG-03]
must_haves:
  truths:
    - "Packaged macOS .dmg installs and runs on a clean macOS VM with no developer environment"
    - "Packaged Windows .exe installs and runs on a clean Windows VM (SmartScreen 'unknown publisher' warning observed and documented)"
    - "Packaged Linux AppImage runs on a clean Ubuntu LTS VM (basic_text safeStorage backend warning surfaces if no kwallet/libsecret)"
    - "First-launch UX completes onboarding → adds character → summons → live logs flow → stop terminates cleanly on each platform. **Constraint (per WARNING-9):** the live-summon leg of this truth requires either (a) bare-metal hosts on the same physical LAN as the Minecraft host, OR (b) a virtualized VM on a *bridged* network adapter with multicast known to forward (NOT default NAT), OR (c) a fallback validation: the executor temporarily wires a 'force LAN port' env var or hardcoded port into the smoke build and points the bot at a pre-configured Minecraft host on the same network — rolled back before the v1.0 tag. NAT'd VMs that silently fall back to the LAN-modal Searching state do NOT satisfy this truth."
    - "Release notes document SmartScreen UX, fresh-data behavior (no auto-migrate from CLI cwd), Linux best-effort caveats, and macOS first-launch right-click bypass if appId/cert combo triggers Gatekeeper edge cases"
  artifacts:
    - path: .planning/phases/04-electron-gui-packaging/RELEASE-NOTES.md
      provides: "v1.0 release notes — install instructions, known caveats, future signing/CI roadmap"
  key_links:
    - from: RELEASE-NOTES.md
      to: electron-builder.yml
      via: "documents that appId is now locked and changes break Keychain entries"
      pattern: "appId"
---

<changes_made>
**Revision pass (Warning 9):** PKG-03 live-summon validation has an environmental truth gap — Minecraft LAN multicast (`224.0.2.60:4445`) is bridged inconsistently across virtualization stacks. NAT'd VMs on most defaults (VirtualBox NAT, Parallels Shared, UTM Shared) do NOT forward multicast to/from the host, so a clean-VM smoke could ship a working build that LOOKS broken (LAN pill stays NOT CONNECTED forever) — and conversely could ship a broken build that the smoke missed because the smoke gracefully fell back to LAN-modal-Searching state. Plan 11 now documents this constraint in `must_haves.truths` and gives executors two acceptable validation paths: bare-metal (or bridged-network VM) for a real live-summon, OR a pre-configured Minecraft host with a known port and an interim "force connect" code path for the validation run only (rolled back before release).
</changes_made>

<objective>
Run the packaged builds on clean VMs (PKG-03), verify first-launch UX matches expectations, and write the v1.0 release notes documenting the unsigned-Windows SmartScreen warning, fresh-data behavior, Linux best-effort caveats, and the bundle-ID lock-in.

Purpose: PKG-03 — packaged builds tested on clean VMs (no dev environment) before each release. This is the last gate before shipping.

Output: Test results documented in SUMMARY; user-facing release notes file. No code changes.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@CLAUDE.md
@.planning/phases/04-electron-gui-packaging/04-CONTEXT.md
@.planning/phases/04-electron-gui-packaging/04-RESEARCH.md
@electron-builder.yml
@package.json
</context>

<tasks>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task 1: Build local installers and smoke-test on clean VMs</name>
  <what-built>
    Plans 01–10 produced a complete Electron app + packaging config + signed/notarized macOS build pipeline. This task is the human-driven validation that the .dmg / .exe / AppImage actually work on machines that have NEVER had Node, Electron, or any dev tools installed.

    Why human-verify (not autonomous):
    - Requires real or virtualized clean OS environments (parallels / utm / VirtualBox / cloud VM).
    - Requires interactively walking the onboarding flow + opening Minecraft to LAN + observing live logs.
    - SmartScreen / Gatekeeper warnings are by-design UX checkpoints; only a human can confirm "I clicked through and it worked."
  </what-built>
  <how-to-verify>
**Step 1. Build all three installers locally.**

```bash
# After Task 2 BLOCKING in plan 10 resolved (appId locked + Apple cert installed):
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="<your TEAM_ID>"

npm run dist:mac
npm run dist:win
npm run dist:linux
```

Expected outputs in `release/`:
- `Sei-1.0.0-universal.dmg` (signed + notarized)
- `Sei Setup 1.0.0.exe` (NSIS, **unsigned** per RESEARCH Q2)
- `Sei-1.0.0.AppImage`

If `dist:win` fails on macOS due to wine/mono missing: build it from a Windows machine, or skip with `npm run dist:mac && npm run dist:linux` and note in SUMMARY that Windows must be built from Windows.

**Step 2. macOS clean VM smoke.**

Provision a clean macOS VM (e.g., a fresh Ventura 13.x install with no Xcode, no Homebrew, no Node). Copy the .dmg over.

Verification flow:
1. Double-click `Sei-1.0.0-universal.dmg`. The DMG mounts; you see the app icon + Applications shortcut.
2. Drag Sei.app to Applications.
3. Open Sei.app from Applications. The first launch should show NO Gatekeeper warning if the cert + notarization succeeded. (If Gatekeeper says "unknown developer," your cert wasn't recognized — fix in plan 10's BLOCKING task and re-build.)
4. Loading screen → Onboarding step 0 (Welcome to Sei.).
5. Walk through all 5 onboarding steps. On step 4, paste your real Anthropic API key.
6. After Finish, navigate to Home. Sui card should be visible (per migration logic — but on a clean VM, no legacy config exists, so no migration ran. Sui card may be absent if migration didn't fire. **Acceptable for v1**: Home shows just the AddCard. Note in SUMMARY that fresh installs start with zero characters and the user must Add one.)
7. Open Minecraft on the host machine. Open a singleplayer world to LAN with cheats on.
   **WARNING-9 — multicast caveat:** if the VM is on default NAT (VirtualBox NAT, Parallels Shared, UTM Shared, etc.), the LAN pill will stay NOT CONNECTED because multicast does not bridge across NAT. To satisfy PKG-03's live-summon truth, do ONE of:
   (a) re-run the smoke on bare metal on the same LAN as the Minecraft host, OR
   (b) switch the VM to a bridged network adapter and confirm `tcpdump -i <iface> 'host 224.0.2.60'` sees Minecraft's broadcasts, OR
   (c) document in SUMMARY that this VM environment cannot exercise the live-summon path; arrange a separate bare-metal validation run before tagging v1.0.
   Skipping live-summon and only verifying LAN-modal Searching state is INSUFFICIENT for PKG-03 — note the deferred validation in SUMMARY.md.
8. Click + New, create a character (name "Bob", description, persona prompt). Click Create.
9. On Bob's CharacterPage, click Summon into Minecraft. Either:
   - LAN green → bot connects, Logs tab enables, log lines stream.
   - LAN not green → LAN modal opens in Searching mode (this is the realistic case for a NAT'd VM).
10. If summon succeeded: stop, then delete Bob, confirm modal works.
11. Close Sei. Reopen. Onboarding should NOT show again (config persisted). API key should still work.

**Step 3. Windows clean VM smoke.**

Provision a clean Windows 10/11 VM. Copy `Sei Setup 1.0.0.exe` over.

Verification flow:
1. Double-click `Sei Setup 1.0.0.exe`. **EXPECTED:** SmartScreen blue "Windows protected your PC" dialog (because the .exe is unsigned per RESEARCH Q2). Click "More info" → "Run anyway".
2. NSIS installer welcome screen. Choose install path. Install.
3. Launch Sei from Start menu.
4. Onboarding works identically to macOS.
5. **Critical:** verify safeStorage on Windows uses DPAPI (not basic_text). The Linux fallback warning banner should NOT appear.
6. Same end-to-end summon flow as macOS step 8–11.

**Step 4. Linux clean VM smoke.**

Provision a clean Ubuntu 22.04 LTS desktop VM. Copy `Sei-1.0.0.AppImage` over.

Verification flow:
1. `chmod +x Sei-1.0.0.AppImage` then `./Sei-1.0.0.AppImage`.
2. **CRITICAL:** observe whether the KEYCHAIN_FALLBACK_PLAINTEXT banner appears at the top of the window (UI-SPEC §Banner shipped in plan 09). On Ubuntu Desktop, gnome-keyring is usually installed → no warning. On a minimal install (server with desktop env added), kwallet/libsecret may be missing → warning appears.
3. Walk through onboarding. Verify the API key persists after restart.
4. Same summon flow as steps above.

**Step 5. Document outcomes.**

For each platform record:
- Build size (e.g., macOS ~150MB universal)
- First-launch warnings (Gatekeeper / SmartScreen / Linux backend)
- Onboarding completion success/failure
- Summon-flow completion success/failure (or N/A if VM networking blocked LAN multicast)
- Any unexpected console errors visible in DevTools (Cmd-Shift-I / Ctrl-Shift-I)

Report results in the resume signal.
  </how-to-verify>
  <resume-signal>Paste a 3-line-per-platform report: macOS / Windows / Linux. Include any blocker issues for plan 11 task 2 to address.</resume-signal>
</task>

<task type="auto" tdd="false">
  <name>Task 2: Write release notes documenting the v1 caveats</name>
  <read_first>
    - .planning/phases/04-electron-gui-packaging/04-RESEARCH.md §"Resolved During Plan-Phase" (Q1, Q2, Q3, Q4)
    - .planning/phases/04-electron-gui-packaging/04-RESEARCH.md §"Pitfall 3" (Linux basic_text fallback)
    - electron-builder.yml (final appId, identity)
    - Task 1 outcome (what actually worked on each VM)
  </read_first>
  <behavior>
    - Create `.planning/phases/04-electron-gui-packaging/RELEASE-NOTES.md` documenting:
      1. Install instructions per platform.
      2. SmartScreen "unknown publisher" walkaround on Windows (per RESEARCH Q2).
      3. Fresh-install behavior — no auto-migration from CLI's cwd config (per RESEARCH Q4).
      4. Linux AppImage best-effort caveats — KEYCHAIN_FALLBACK_PLAINTEXT warning if no secret store.
      5. macOS first-launch (Gatekeeper allows it because notarized; document the right-click → Open fallback if cert combo edge-case triggers).
      6. **Bundle-ID is locked.** Document the chosen appId. Future appId changes break installed users' Keychain entries.
      7. Future phase backlog: Windows signing, CI release pipeline, auto-update.
    - File is written for end users + the user themselves as project owner.
  </behavior>
  <action>
Create `.planning/phases/04-electron-gui-packaging/RELEASE-NOTES.md`:

```markdown
# Sei v1.0 — Release Notes

**Released:** YYYY-MM-DD (fill in on actual release)

Sei is a Minecraft AI companion. This is the first packaged release — onboarding,
character creation, and live summon-to-LAN flows all work as a polished desktop app.

---

## Install

### macOS (.dmg, signed + notarized)

1. Download `Sei-1.0.0-universal.dmg`.
2. Double-click. The DMG mounts. Drag Sei to Applications.
3. Launch from Applications. macOS may briefly verify with Gatekeeper (no extra clicks needed because the build is notarized).

If macOS shows "Sei is from an unidentified developer" (very rare with notarization), right-click Sei in Applications → Open → Open. After once, normal double-click works.

### Windows (.exe, **UNSIGNED v1**)

1. Download `Sei Setup 1.0.0.exe`.
2. Double-click. **Windows SmartScreen will warn:** "Windows protected your PC ... Unknown publisher."
3. Click "More info" → "Run anyway".
4. NSIS installer walks you through. Per-user install — no admin prompt required.

This is expected for v1. Sei ships unsigned on Windows for the first release. A future
maintenance release will add Authenticode signing once the company is formed.

### Linux (.AppImage, best-effort unsigned)

1. Download `Sei-1.0.0.AppImage`.
2. `chmod +x Sei-1.0.0.AppImage`
3. `./Sei-1.0.0.AppImage`

If your Linux desktop lacks `gnome-keyring` / `kwallet` / `libsecret`, Sei will show a
yellow banner at the top of the window:

> Your system has no secret store. Sei will save your API key but it won't be hardware-protected.

This means the API key blob in `~/.config/Sei/api_key.bin` is encrypted with a fallback
hardcoded key — effectively plaintext. To fix: install gnome-keyring (Ubuntu Desktop has
it by default) and Sei will pick up the protected store on next launch.

---

## What's in v1

- Setup form: Minecraft username, preferred name, provider, API key (stored via OS keychain on macOS/Windows).
- Multi-character launcher: create personas, summon them into your open-to-LAN world, see live logs.
- LAN auto-detect: Sei watches multicast for your LAN world; press Summon when ready.
- Personality engine: single-Haiku LLM with reasoning + dispatch combined.
- Memory: per-character memory dirs at `~/Library/Application Support/Sei/memory/<id>/` (macOS) or platform equivalent.
- Light + dark themes, with system-default first run.

---

## Known caveats

### Fresh install starts empty

If you previously used the `sei` CLI (which stored config in your dev clone's
`./config.json`), the GUI does NOT auto-detect or migrate that data. On first launch
you walk through onboarding from scratch. The CLI continues to work from your dev
clone for headless use.

This was a deliberate scope-control choice — a future release may add a one-shot
"import from CLI" if there's demand.

### LAN auto-detect requires same-network multicast

If you're running Sei in a virtual machine that can't see the host's multicast
broadcasts, the LAN pill stays "NOT CONNECTED" even when Minecraft is open to LAN.
Same-network NAT / corporate Wi-Fi sometimes block multicast, too. There's no manual
override — the cached LAN port is required for clean summon.

### Bundle ID is locked

The macOS bundle ID is `<the-locked-appId>`. This is permanent; changing it in a
future release would strand all existing users' Keychain entries (their saved API
key would become unreadable). Treat this as a hard contract.

### Auto-update not yet wired

Sei does not auto-update in v1. To get a new version: download the new installer.
Auto-update is on the roadmap.

### Per-character memory does not yet hot-reload

If you delete a character via the UI, their memory dir at `<userData>/memory/<id>/`
is removed. But if Sei is running and connected as that character, deletion is
refused — stop first. (Defense-in-depth: main process gates this; renderer also gates.)

---

## Roadmap

- v1.1: Windows code-signing (Azure Trusted Signing or EV cert).
- v1.x: Auto-update via electron-updater.
- v1.x: Edit-persona flow on CharacterPage (currently the Edit button is a placeholder).
- v1.x: Image-upload override for character portraits (procedural is the only option in v1).
- v2: Vision (OS screenshot → Haiku 3.5).
- v2: Multi-character concurrent summons.

---

## Reporting issues

GitHub Issues / project page (TBD). Logs are at `<userData>/logs/<characterId>-<timestamp>.log`.
On macOS that's `~/Library/Application Support/Sei/logs/`. Include them in any bug report.

---

## Build provenance

- Built locally per RESEARCH §Resolved Q3. No CI pipeline in v1.
- macOS: signed with `<your identity>` and notarized via `notarytool`.
- Windows: unsigned. SmartScreen warning expected.
- Linux: AppImage unsigned. Best-effort.

Source: tag `v1.0` in the project repo. Phase 4 plans 01–11 produced this build.
```

Replace placeholder fields (`<the-locked-appId>`, `<your identity>`, date) with actual values from `electron-builder.yml` and Task 1 results.
  </action>
  <verify>
    <automated>bash -c 'test -f .planning/phases/04-electron-gui-packaging/RELEASE-NOTES.md && grep -q "## Install" .planning/phases/04-electron-gui-packaging/RELEASE-NOTES.md && grep -q "macOS" .planning/phases/04-electron-gui-packaging/RELEASE-NOTES.md && grep -q "Windows" .planning/phases/04-electron-gui-packaging/RELEASE-NOTES.md && grep -q "Linux" .planning/phases/04-electron-gui-packaging/RELEASE-NOTES.md && grep -q "SmartScreen" .planning/phases/04-electron-gui-packaging/RELEASE-NOTES.md && grep -q "Unknown publisher\\|unknown publisher" .planning/phases/04-electron-gui-packaging/RELEASE-NOTES.md && grep -q "Fresh install starts empty\\|fresh install starts empty\\|no auto-detect" .planning/phases/04-electron-gui-packaging/RELEASE-NOTES.md && grep -q "Bundle ID is locked\\|bundle ID is locked\\|Bundle-ID is locked" .planning/phases/04-electron-gui-packaging/RELEASE-NOTES.md && grep -q "no secret store\\|basic_text\\|KEYCHAIN_FALLBACK_PLAINTEXT" .planning/phases/04-electron-gui-packaging/RELEASE-NOTES.md && grep -q "Auto-update\\|auto-update" .planning/phases/04-electron-gui-packaging/RELEASE-NOTES.md'</automated>
  </verify>
  <acceptance_criteria>
    - `RELEASE-NOTES.md` exists at `.planning/phases/04-electron-gui-packaging/`
    - File has section headers covering: install (macOS / Windows / Linux), SmartScreen warning, fresh-install caveat, bundle-ID lock, Linux secret-store fallback, auto-update roadmap
    - File mentions "unknown publisher" (SmartScreen UX)
    - File mentions Linux fallback (basic_text or "no secret store")
    - **WARNING-9 fix:** RELEASE-NOTES.md "LAN auto-detect" caveat documents the multicast-on-NAT'd-VM limitation explicitly (already present in the existing notes draft — confirm phrasing matches the constraint surfaced in `must_haves.truths`)
  </acceptance_criteria>
  <done>Release notes ready. Phase 4 ships.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| build artifact → end-user machine | Final crossing — once an installer ships, every threat model from prior plans is realized in production |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-04-44 | Information Disclosure | release notes accidentally include API key fragments / paths with usernames | mitigate | Reviewer reads RELEASE-NOTES.md before commit; no secrets / no system-specific paths |
| T-04-45 | Repudiation | unsigned Windows install attributed to "Sei" but with no chain of trust | accept | Documented in release notes; users follow SmartScreen "More info → Run anyway" knowingly |
| T-04-46 | Tampering | clean VM has stale Sei in /Applications from a prior test build | mitigate | Smoke flow includes installing from scratch; if any prior install present, delete + retest |
</threat_model>

<verification>
- All three installers built locally (output in `release/`)
- All three platforms smoke-tested (or documented blockers)
- RELEASE-NOTES.md drafted, reviewed, ready to ship with the artifacts
- Phase 4 done.
</verification>

<success_criteria>
- A user with no developer experience can download the macOS .dmg, install Sei, complete onboarding, summon a character into their LAN world, see live logs, and stop.
- Phase 5 (Debug log readability) and beyond can build on a known-stable shipping artifact.
</success_criteria>

<output>
After completion, create `.planning/phases/04-electron-gui-packaging/04-11-SUMMARY.md` documenting:
- Per-platform smoke results (build size, first-launch warnings observed, onboarding success, summon success, anomalies)
- Final release artifact paths in `release/`
- Confirmation that RELEASE-NOTES.md is final
- Any post-release follow-up needed (e.g., if Windows build had to be deferred to a Windows host)
- Phase 4 closeout: update STATE.md and ROADMAP.md to mark phase complete (do this manually — guidance: `Phase 4 → COMPLETE`, success criteria all checked, transition to Phase 5).
</output>
