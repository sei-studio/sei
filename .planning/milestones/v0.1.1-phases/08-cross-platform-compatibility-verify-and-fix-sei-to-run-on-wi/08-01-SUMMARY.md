---
phase: 08-cross-platform-compatibility
plan: 01
subsystem: infra
tags: [windows, cross-platform, electron-builder, appid, audit, packaging]

# Dependency graph
requires:
  - phase: 04-electron-gui-packaging
    provides: electron-builder.yml v1 config with placeholder appId (BLOCKING in plan 04-10)
provides:
  - 08-HOTSPOTS.md (24-row static audit table — Wave 2/3 verification checklist seed)
  - electron-builder.yml locked to appId=com.sei.app (resolves Phase 4 04-10 BLOCKING)
  - deterministic %APPDATA%\Sei\ resolution on Windows via app.getPath('userData')
affects: [08-02 windows-dev-smoke, 08-03 windows-packaged-smoke, 08-04 documentation, phase-9 custom-skins (setup wizard contract on %APPDATA%\Sei\)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Static-audit-first: enumerate every cross-platform-sensitive file with status (SAFE/SUSPECT/FIX-INLINE/DEFER-TO-LIVE) before any live smoke pass"
    - "appId/productName separation: productName=Sei drives userData dir naming, appId=com.sei.app drives Keychain/DPAPI partition"

key-files:
  created:
    - .planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-HOTSPOTS.md
  modified:
    - electron-builder.yml

key-decisions:
  - "appId locked to com.sei.app (conventional reverse-DNS, no domain-ownership coupling)"
  - "productName=Sei preserved — drives %APPDATA%\\Sei\\ resolution; matches src/bot/cli/index.js APP='Sei'"
  - "mac.identity TODO kept open — separate Apple Developer cert concern, not Phase 8 scope"
  - "appId lock is irrevocable per threat T-08-01 (post-release change strands every Keychain/DPAPI entry)"

patterns-established:
  - "HOTSPOTS audit doc as Wave 2/3 verification checklist seed — every DEFER-TO-LIVE row maps directly to a live smoke item"
  - "Header comments must reflect file state, not stale plan history — updated electron-builder.yml header from PLACEHOLDER prose to LOCKED prose"

requirements-completed: []

# Metrics
duration: ~3min
completed: 2026-05-17
---

# Phase 8 Plan 01: Static Audit and AppId Lock Summary

**24-row cross-platform hotspots audit (19 SAFE / 1 SUSPECT / 1 FIX-INLINE / 4 DEFER-TO-LIVE) + electron-builder.yml appId locked from `app.sei.placeholder` to `com.sei.app`, closing Phase 4 04-10 BLOCKING and making `%APPDATA%\Sei\` the deterministic Windows data root.**

## Performance

- **Duration:** ~3 min
- **Started:** 2026-05-17T23:47:27Z
- **Completed:** 2026-05-17T23:49:58Z
- **Tasks:** 2
- **Files modified:** 2 (1 created, 1 modified)

## Accomplishments

- Produced `08-HOTSPOTS.md` enumerating every cross-platform-sensitive file in the codebase with explicit status + Wave-2/3 live-verify pointer
- Locked `electron-builder.yml` `appId: com.sei.app` (was `app.sei.placeholder`); removed the placeholder TODO comment line
- Confirmed via cross-repo grep that no other source/config file held a stale `app.sei.placeholder` literal — only planning docs that DESCRIBE the placeholder remain, and those are correct historical record
- Resolved Phase 4 04-10's BLOCKING task — Wave 3 packaged smoke now has a deterministic `<userData>` contract

## Hotspot Audit Breakdown

| Status | Count | Notes |
|--------|-------|-------|
| SAFE | 19 | paths.ts, botSupervisor (entry + env), windowChrome, main/index.ts (preload, renderer target, window-all-closed, linux warn), ipc.ts (warnings handler), cli electronUserDataDir, atomicWrite, electron-builder Windows target + asarUnpack, package.json postinstall + dist:win, no raw child_process, zero native deps |
| SUSPECT | 1 | src/renderer/src/styles/fonts.css — `/fonts/<file>.woff2` URLs must end up in `dist/renderer/fonts/` after build; verify on real Windows in Wave 2 (dev) + Wave 3 (packaged) |
| FIX-INLINE | 1 | electron-builder.yml appId placeholder — fixed in Task 2 of this plan |
| DEFER-TO-LIVE | 4 | The four CONTEXT §code_context open questions (npm install on Windows, font bundling, atomicWrite \n round-trip, app.getPath('userData') resolves to %APPDATA%\Sei\) |
| **Total rows** | **24** | (also includes Windows ARM64 = out-of-scope row; Wave 2/3 checklist summaries; "what audit did NOT touch" section) |

No FIX-INLINE rows beyond the appId lock — the cross-grep against `*.yml/*.ts/*.js/*.tsx/*.json/*.md` (excluding `node_modules` and `.planning/phases/04-...`) found `app.sei.placeholder` only in (a) the electron-builder.yml line we fix in Task 2 and (b) the Phase 8 planning documents that describe the placeholder as historical record (correct — they document the lock event itself).

## Task Commits

Each task was committed atomically:

1. **Task 1: Produce 08-HOTSPOTS.md** — `0707b44` (docs)
2. **Task 2: Lock electron-builder.yml appId to com.sei.app** — `02c8d4a` (fix)

**Plan metadata commit:** (this SUMMARY + STATE/ROADMAP/REQUIREMENTS update will be committed next)

## Files Created/Modified

- `.planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-HOTSPOTS.md` — 24-row audit table + Wave 2/3 checklist seed + "what audit did NOT touch" scope footer
- `electron-builder.yml` — appId placeholder → `com.sei.app`; header comment updated from stale "PLACEHOLDER" prose to "LOCKED for v1" prose pointing at HOTSPOTS row 12 + threat T-08-01

## Decisions Made

- **appId = com.sei.app** — conventional reverse-DNS, no Apple Developer / domain-ownership coupling, low collision risk on Apple Developer / Windows registries. Documented as irrevocable per threat T-08-01: any future change strands every existing Keychain entry on macOS and every DPAPI-scoped safeStorage entry on Windows.
- **productName: Sei preserved** — Electron's `app.getPath('userData')` uses productName when set, so Windows lands in `%APPDATA%\Sei\`, macOS in `~/Library/Application Support/Sei/`, Linux in `~/.config/Sei/`. This matches `src/bot/cli/index.js:electronUserDataDir` hardcoded `APP = 'Sei'` constant — no CLI code change needed; the two stay in sync structurally.
- **mac.identity TODO untouched** — the `# TODO(lock-before-signing) — set to user's actual Apple Developer identity:` comment at electron-builder.yml line 35-36 is a SEPARATE blocker (Apple Developer cert) and intentionally NOT closed by Phase 8. It remains a user-side concern for whenever signing becomes a priority.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Stale electron-builder.yml header comment**
- **Found during:** Task 2 (appId lock)
- **Issue:** The file header (lines 5-8) still described appId as a "PLACEHOLDER" and pointed at the now-closed Plan 04-10 BLOCKING checkpoint. With Task 2 actually locking the value, the header comment would mislead future readers into thinking the value is still pending user choice.
- **Fix:** Replaced the placeholder/BLOCKING prose with a concise "appId is LOCKED for v1" note + pointer to HOTSPOTS row 12 + threat T-08-01 (the irrevocability rationale).
- **Files modified:** electron-builder.yml (header comment block only; appId line + everything else unchanged)
- **Verification:** Full automated verify (`grep -q "^appId: com.sei.app$"`, etc.) still passes; mac.identity TODO still present at line 35.
- **Committed in:** `02c8d4a` (part of Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 bug — stale documentation)
**Impact on plan:** Minor cleanup tightly scoped to the file Task 2 already touches. No scope creep — same commit, same file.

## Issues Encountered

- None. Static-only plan; no external systems exercised.

## User Setup Required

None — no external service configuration required by this plan. The Wave 2 (Plan 08-02) and Wave 3 (Plan 08-03) live smoke plans will require a Windows 10+ VM with `npm install` and `npm run dist:win` access, but that is downstream.

## Pointers for Wave 2 / Wave 3 / Wave 4

- **Wave 2 (Plan 08-02 — dev smoke on Windows VM):** consume the "Wave 2" section of `08-HOTSPOTS.md` Deferred-to-Live Summary as the verification checklist
- **Wave 3 (Plan 08-03 — packaged smoke + defect fix):** consume the "Wave 3" section; specifically verify `<userData>` = `%APPDATA%\Sei\` (HOTSPOTS row 24) now that appId is locked
- **Wave 4 (Plan 08-04 — documentation):** cite HOTSPOTS as the snapshot reference for `08-WINDOWS-GUIDE.md`'s "platform-sensitive file list" section

## Next Phase Readiness

- Phase 4 04-10 BLOCKING is closed. Wave 3 packaged smoke can confirm `%APPDATA%\Sei\` is the data root with no further code changes.
- Phase 9 (custom bot skins setup wizard) has a stable `%APPDATA%\Sei\` contract to build its `customskinloader/` install path on top of.
- No blockers introduced. mac.identity TODO (Apple Developer cert) remains open — explicitly out of Phase 8 scope.

## Self-Check: PASSED

Verified before writing this section:
- `.planning/phases/08-cross-platform-compatibility-verify-and-fix-sei-to-run-on-wi/08-HOTSPOTS.md` exists (Task 1 artifact)
- `electron-builder.yml` contains `appId: com.sei.app` and no `app.sei.placeholder` (Task 2 artifact)
- Commit `0707b44` present in `git log` (Task 1)
- Commit `02c8d4a` present in `git log` (Task 2)

---
*Phase: 08-cross-platform-compatibility*
*Completed: 2026-05-17*
