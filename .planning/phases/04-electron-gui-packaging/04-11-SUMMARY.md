---
phase: 04-electron-gui-packaging
plan: 11
subsystem: packaging
tags: [release-notes, vm-validation, packaging, deferred]
status: paused-at-checkpoint
dependency_graph:
  requires:
    - 04-01..04-09-SUMMARY.md   # full Electron app surface
    - 04-10-SUMMARY.md          # electron-builder.yml + entitlements (appId still placeholder)
  provides:
    - "RELEASE-NOTES.md: v1.0 user-facing install instructions and known caveats"
  affects: []
tech_stack:
  added: []
  patterns:
    - "User-facing release notes documenting platform-specific install UX"
    - "SmartScreen walkthrough copy"
    - "KEYCHAIN_FALLBACK_PLAINTEXT user disclosure"
key_files:
  created:
    - .planning/phases/04-electron-gui-packaging/RELEASE-NOTES.md
  modified: []
decisions:
  - "Author RELEASE-NOTES.md with placeholder strings (`<the-locked-appId>`, `<your identity>`, release date) plus a top-of-file pre-ship checklist — keeps the artifact ready while the appId/identity remain deferred per plan 10's open checkpoint"
  - "Pause Task 1 (clean-VM smoke) at a human-action checkpoint — VM hardware is unavailable in this execution environment AND signed builds are gated on plan 10's deferred appId/identity lock"
  - "Do NOT execute `npm run dist:mac` against the placeholder appId — running it would either bind the placeholder to a Keychain entry on this dev machine (Pitfall T-04-41) or hard-fail without `mac.identity`; both are worse than skipping"
metrics:
  duration_minutes: 5
  tasks_completed: 1
  tasks_total: 2
  files_changed: 1
  commits:
    - 46a5178
  completed: 2026-05-08
---

# Phase 04 Plan 11: Clean-VM Validation Summary

**One-liner:** Authored the v1.0 user-facing `RELEASE-NOTES.md` (install instructions per platform, SmartScreen walkthrough, fresh-install caveat, LAN-multicast-on-NAT'd-VM caveat, Linux `basic_text` fallback disclosure, bundle-ID lock contract, roadmap), and paused the clean-VM smoke at a human-action checkpoint because (a) plan 10's appId/identity lock is deferred and (b) no clean macOS/Windows/Linux VMs are available to this executor.

## Outcome

Plan 04-11 is **partially complete**:

- **Task 2 (autonomous, RELEASE-NOTES.md):** done. File written, all 10 acceptance-grep gates pass, committed in `46a5178`.
- **Task 1 (`checkpoint:human-verify`, blocking):** paused. The structured human-action signal at the bottom of this SUMMARY documents what the user / phase-owner must do post-phase to satisfy PKG-03.

This is the expected terminal state for plan 11 in the current environment. The plan's own preamble flags it as `autonomous: false` precisely because the smoke flow needs real VM hardware that the executor cannot provision.

## What Was Built

### `.planning/phases/04-electron-gui-packaging/RELEASE-NOTES.md` (NEW)

A 232-line user-facing release-notes document. Sections:

1. **Pre-ship checklist** at the top — calls out the placeholder strings
   (`<the-locked-appId>`, `<your identity>`, release date) that must be filled
   in once plan 10's deferred checkpoint resolves. Acts as a hard gate against
   shipping the file unedited.
2. **Install** — per-platform steps for macOS (.dmg signed+notarized),
   Windows (.exe **unsigned** with SmartScreen walkthrough), Linux
   (.AppImage best-effort).
3. **What's in v1** — feature inventory mapped to the phase 4 deliverables
   (setup form, multi-character launcher, LAN auto-detect, single-Haiku
   personality engine, per-character memory dirs, themes).
4. **Known caveats** —
   - Fresh install starts empty (no CLI auto-migration per RESEARCH Q4).
   - Windows unknown-publisher SmartScreen warning (RESEARCH Q2).
   - LAN auto-detect requires same-network multicast — explicitly enumerates
     NAT'd VMs (VirtualBox NAT, Parallels Shared, UTM Shared) as
     non-functional, recommends bridged adapter or bare-metal — directly
     mirrors the `must_haves.truths` constraint added in WARNING-9.
   - Linux secret-store fallback is plaintext-equivalent
     (`KEYCHAIN_FALLBACK_PLAINTEXT` / `basic_text` backend).
   - Bundle ID is locked (T-04-41 contract, Keychain stranding consequences
     spelled out).
   - Auto-update not yet wired (D-63).
   - Edit-persona button placeholder, image-upload override deferred.
5. **Roadmap** — v1.x (Windows signing, auto-update, edit-persona,
   image-upload), v2 (vision, multi-summon).
6. **Reporting issues** — log file paths per platform.
7. **Build provenance** — build-locally policy, mac signing/notarization
   summary, Hardened Runtime entitlements list.

### Verify gate

Plan's automated `bash -c` grep gate runs against the file with zero misses:

```
PASS: ## Install
PASS: macOS
PASS: Windows
PASS: Linux
PASS: SmartScreen
PASS: Unknown publisher
PASS: Fresh install starts empty
PASS: Bundle ID is locked
PASS: no secret store
PASS: Auto-update
```

### Commit

- `46a5178` — `docs(04-11): write v1.0 RELEASE-NOTES with install steps and known caveats`

## Deviations from Plan

### Auto-fixed Issues

None.

### Scope Adjustments

**1. [Rule 3 — Environment-blocked] Task 1 paused, not executed**

- **Found during:** plan-load review.
- **Issue:** Task 1 is `checkpoint:human-verify` and presumes (a) clean
  macOS / Windows / Linux VMs exist and (b) plan 10's BLOCKING `appId` /
  Apple identity / notarization-secret checkpoint has resolved. As of plan
  10's SUMMARY (`afb7086` + the 2026-05-08 deferral note), the appId is
  still `app.sei.placeholder` and `mac.identity` is still commented out.
  Building `npm run dist:mac` in this state would either fail (no identity)
  or bind the placeholder bundle ID to whatever Keychain entry the dev
  machine sees (T-04-41 Pitfall — once bound, every signed-build user is
  stranded if the appId ever changes). The executor environment also does
  not have clean Windows or Linux VMs available, so even if the macOS dmg
  were buildable, the cross-platform smoke could not run.
- **Action:** did NOT run `npm run dist:mac` / `dist:win` / `dist:linux`.
  did NOT bind the placeholder appId to anything. Did write the
  RELEASE-NOTES.md fully so the artifact is ready the moment plan 10's
  deferral resolves. Document the pause as a `checkpoint:human-action`
  below for the orchestrator (and the user) to track.
- **Files modified:** none (this is the *absence* of an action).
- **Commit:** N/A.

**2. [Plan deliverable] RELEASE-NOTES.md uses placeholders, not final values**

- **Issue:** Task 2's `<action>` block instructs the executor to "Replace
  placeholder fields (`<the-locked-appId>`, `<your identity>`, date) with
  actual values from `electron-builder.yml` and Task 1 results." But (a)
  Task 1 was not run, and (b) `electron-builder.yml` still carries
  `appId: app.sei.placeholder` and a commented-out `mac.identity` per plan
  10's deferral.
- **Action:** kept the placeholders in the release notes verbatim and
  added a prominent **Pre-ship checklist** to the top of the file that
  explicitly lists the values to fill in before tagging `v1.0`. This is
  better than (a) inserting fake/guessed values that would silently ship
  if anyone forgets, or (b) committing nothing.
- **Files modified:** `.planning/phases/04-electron-gui-packaging/RELEASE-NOTES.md`.
- **Commit:** `46a5178`.

## Authentication Gates

None encountered during Task 2. Task 1 itself is not an auth gate — it's a
hardware/environment gate (no clean VMs available, signed builds gated on a
prior deferred checkpoint).

## Threat Surface Scan

No new attack surface introduced. RELEASE-NOTES.md is documentation only;
threat T-04-44 (secrets / system-specific paths in release notes) was
explicitly checked: the file contains no API key fragments, no real Apple
Developer Team IDs, no real usernames, and no machine-specific paths beyond
the standard per-platform `<userData>` locations that are public Electron API
documentation anyway.

## Known Stubs

- RELEASE-NOTES.md placeholders `<the-locked-appId>`, `<your identity>`, and
  `_PENDING — fill in on actual tag day_` are intentional stubs preserved for
  the post-phase tagging step. The pre-ship checklist at the top of the file
  enforces that they get replaced before shipping. **Do not tag v1.0 until
  these are filled in.**
- `electron-builder.yml` `appId: app.sei.placeholder` and the commented
  `# identity:` line — pre-existing stubs from plan 10, *not* introduced here.

## Self-Check: PASSED

- `.planning/phases/04-electron-gui-packaging/RELEASE-NOTES.md`: FOUND
- Commit `46a5178`: FOUND in `git log`
- Plan verify gate (10 grep patterns): ALL PASS
- No accidental file deletions in this plan's commits: VERIFIED CLEAN
- Working tree clean post-commit: VERIFIED

```
$ git log --oneline -3
46a5178 docs(04-11): write v1.0 RELEASE-NOTES with install steps and known caveats
9f60da5 docs(phase-04): update tracking after wave 8 .planning/ROADMAP.md .planning/STATE.md
[...]
```

## CHECKPOINT REACHED — Task 1 paused at human-action

**Type:** `checkpoint:human-action` (escalated from the plan's
`checkpoint:human-verify` because the prerequisite work — plan 10's
appId/identity lock — is also deferred, and clean VMs are not available in
this executor's environment).

**Plan:** 04-11
**Progress:** 1/2 tasks complete.

### Completed Tasks

| Task | Name                                                         | Commit    | Files                                                              |
| ---- | ------------------------------------------------------------ | --------- | ------------------------------------------------------------------ |
| 2    | Write release notes documenting the v1 caveats               | `46a5178` | `.planning/phases/04-electron-gui-packaging/RELEASE-NOTES.md` (new)|

### Current Task

**Task 1:** Build local installers and smoke-test on clean VMs.
**Status:** blocked.
**Blocked by:**
1. Plan 10 Task 2 (`appId` + `mac.identity` + Apple notarization secrets)
   is **deferred** until the user picks a final `sei.app` subdomain. Until
   that resolves, signing+notarizing a real `Sei-1.0.0-universal.dmg` is
   not possible.
2. Even with signed builds in hand, this executor does not have clean
   macOS / Windows / Linux VMs available to run the platform smoke flows
   (DMG mount → drag-to-Applications, NSIS SmartScreen, AppImage chmod+run,
   onboarding walk-through, summon-into-LAN bot connect, log streaming,
   stop). The smoke is by-design human-driven per the plan's
   `<task type="checkpoint:human-verify">` declaration.

### What the user / phase-owner must do (post-phase)

When ready to ship v1.0:

**Pre-flight (gate on plan 10's deferred checkpoint):**

1. Pick the final reverse-DNS `appId` (one of `gg.sei.app`, `studio.sei.app`,
   `bot.sei.app`) and lock it in `electron-builder.yml`. Remove the
   `# TODO(lock-before-signing)` line.
2. Populate `mac.identity: "Developer ID Application: <Name> (<TEAM_ID>)"`.
3. Verify with `security find-identity -v -p codesigning | grep "Developer ID Application"`.
4. Export notarization env vars (one of):
   - `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`, or
   - `APPLE_API_KEY` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER`.
5. Commit the locked `electron-builder.yml`.

**Build:**

```bash
npm run dist:mac
npm run dist:win     # may need to run from a Windows host if wine/mono missing on macOS
npm run dist:linux
```

Expected outputs in `release/`:

- `Sei-1.0.0-universal.dmg` (signed + notarized)
- `Sei Setup 1.0.0.exe` (unsigned per RESEARCH Q2 — this is intentional)
- `Sei-1.0.0.AppImage`

**Smoke per platform** (full procedure spelled out in
`04-11-clean-vm-validation-PLAN.md` Task 1 `<how-to-verify>`):

- **macOS clean VM:** Ventura 13.x or newer with no Xcode / Homebrew / Node.
  Mount DMG → drag to Applications → launch → onboarding (5 steps, real
  Anthropic API key on step 4) → Home → create character → Summon into LAN
  Minecraft world (see WARNING-9 multicast caveat below) → live logs → Stop
  → quit → reopen (onboarding does NOT show again).
- **Windows clean VM:** Win 10/11. Run installer → SmartScreen "More info →
  Run anyway" → NSIS welcome → install → launch → same onboarding/summon
  flow as macOS. **Verify** safeStorage uses DPAPI (no Linux `basic_text`
  banner appears).
- **Linux clean VM:** Ubuntu 22.04 LTS Desktop. `chmod +x ./Sei-*.AppImage`
  → run → check whether the yellow `KEYCHAIN_FALLBACK_PLAINTEXT` banner
  appears (Ubuntu Desktop has gnome-keyring → should NOT appear). Same
  onboarding/summon flow.

**WARNING-9 — multicast on virtualized hosts:** the plan's
`must_haves.truths` requires a *real* live-summon for PKG-03, not just the
LAN-modal Searching state. NAT'd VMs (VirtualBox NAT, Parallels Shared,
UTM Shared) do not bridge multicast and CANNOT exercise this code path.
Use one of:

- (a) bare-metal hosts on the same physical LAN as the Minecraft host, OR
- (b) a VM on a **bridged** network adapter where
  `tcpdump -i <iface> 'host 224.0.2.60'` confirms multicast is forwarding, OR
- (c) document a separate bare-metal validation run as a follow-up before
  tagging v1.0.

**Document outcomes** per platform: build size, first-launch warnings
observed, onboarding success/fail, summon flow success/fail (or N/A if VM
networking blocked multicast), any unexpected DevTools console errors.

**Replace placeholders in RELEASE-NOTES.md:**

- `<the-locked-appId>` → final `appId` from electron-builder.yml.
- `<your identity>` → the `Developer ID Application: ...` cert string used.
- `_PENDING — fill in on actual tag day_` → actual release date.

Then check off the pre-ship checklist at the top of RELEASE-NOTES.md and
tag `v1.0`.

### Awaiting

Plan 10's appId/identity deferral to resolve **AND** human-driven VM smoke
runs. Both are post-phase work for the project owner. Phase 4 itself can be
marked complete with this deferred PKG-03 follow-up on record — that
decision is the orchestrator's.

## Notes for Phase 4 Closeout

The plan's `<output>` block instructs the executor to update STATE.md and
ROADMAP.md to mark phase 4 complete. **Per orchestrator directive (parallel
worktree executor), STATE.md and ROADMAP.md were NOT modified by this
agent.** That update is the orchestrator's job after wave 9 merges back to
`main`.

When the orchestrator does close out phase 4:

- All success-criteria checkboxes can be checked **except** PKG-03 fully
  closed — that one carries the deferred clean-VM smoke as a documented
  follow-up.
- Phase 5 (Debug log readability per ROADMAP) becomes the next phase.
- The two deferred follow-ups owed before any v1.0 tag:
  1. Plan 10's appId/identity lock (RESEARCH Q1).
  2. Plan 11's clean-VM smoke (PKG-03).

Both are user-side / project-owner work.

## Checkpoint Resolution (2026-05-08)

**Decision:** Task 1 (clean-VM smoke validation) is **DEFERRED** to a
post-phase follow-up chain. The user has explicitly opted to defer rather
than provision the prerequisites now. `RELEASE-NOTES.md` retains its
placeholder strings (`<the-locked-appId>`, `<your identity>`, and the
`_PENDING — fill in on actual tag day_` release date) plus the top-of-file
**Pre-ship checklist** that gates v1.0 tagging — those placeholders are the
intentional safety interlock keeping an unconfigured release from shipping.

**Reason — Task 1 cannot run yet because it depends on three
independently-deferred prerequisites:**

1. **Plan 10's `appId` lock is itself deferred** until the user picks a
   final `sei.app` reverse-DNS subdomain (one of `gg.sei.app`,
   `studio.sei.app`, `bot.sei.app`). Until that resolves, signing or
   notarizing a real installer is impossible without binding the placeholder
   `app.sei.placeholder` bundle ID to a Keychain entry — Pitfall T-04-41,
   which would strand every signed-build user the moment the appId actually
   changes.
2. **Apple Developer signing identity + notarization secrets** are not yet
   provisioned. Required env vars (`APPLE_ID` +
   `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`, or the
   `APPLE_API_KEY` / `APPLE_API_KEY_ID` / `APPLE_API_ISSUER` triple) and a
   `Developer ID Application: …` cert in the Keychain are project-owner
   work that has to happen alongside the appId lock.
3. **Clean macOS / Windows / Linux validation hosts that satisfy WARNING-9
   are not available.** Per `04-RESEARCH.md` §Resolved Q1 + WARNING-9, the
   live-summon truth requires either bare-metal hosts on the same physical
   LAN as the Minecraft host, OR a VM on a *bridged* network adapter with
   multicast known to forward (NOT default NAT), OR a temporary
   force-LAN-port code path rolled back before v1.0. Default-NAT'd VMs
   (VirtualBox NAT, Parallels Shared, UTM Shared) silently fall back to the
   LAN-modal Searching state — that fallback does NOT exercise the live
   summon and does NOT satisfy PKG-03's truth.

**Follow-up chain (post-phase, project-owner driven, in order):**

(a) **User picks the final domain** (one of `gg.sei.app`,
    `studio.sei.app`, or `bot.sei.app`) →
(b) **Plan 10 follow-up locks `appId` and `mac.identity`** in
    `electron-builder.yml`, removes the `# TODO(lock-before-signing)`
    marker, and verifies the cert via
    `security find-identity -v -p codesigning | grep "Developer ID Application"` →
(c) **Plan 11 follow-up runs** `npm run dist:mac` /
    `npm run dist:win` / `npm run dist:linux` and validates each artifact
    on a clean VM (or bare-metal host) per the WARNING-9 multicast
    constraint above →
(d) **Tag v1.0** with the `RELEASE-NOTES.md` placeholders replaced
    (`<the-locked-appId>`, `<your identity>`, real release date) and the
    pre-ship checklist at the top of the file checked off.

**Phase 4 status:** PKG-03 carries this deferred follow-up explicitly on
the record. Every other phase 4 success criterion is satisfied. Phase 4
can be marked **COMPLETE — with PKG-03 deferred** for the orchestrator
closeout; the deferred work is logged here, in `04-10-SUMMARY.md`'s own
checkpoint deferral, and in the pre-ship checklist embedded at the top of
`RELEASE-NOTES.md` itself, so the gate is enforced at three independent
read-points.

**No source code, `STATE.md`, `ROADMAP.md`, or `RELEASE-NOTES.md` was
modified to record this resolution** — only this SUMMARY's append.
