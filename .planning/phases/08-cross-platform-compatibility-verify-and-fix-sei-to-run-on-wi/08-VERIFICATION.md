---
status: human_needed
phase: 8
phase_name: Windows cross-platform compatibility
verified: 2026-05-17
mode: autonomous-partial
---

# Phase 8 Verification — Partial Completion

## Summary

Phase 8 splits into autonomous-doable and live-Windows-required work. The autonomous orchestrator completed all work that can be done on macOS (Plan 08-01) and explicitly deferred the live-VM portion (Plans 08-02, 08-03) per user instruction "Static audit only, defer verification."

## Plan Status

| Plan | Wave | Autonomous | Status | Notes |
|------|------|------------|--------|-------|
| 08-01-static-audit-and-appid-lock | 1 | true | ✅ Complete | 08-HOTSPOTS.md (24-row audit) + electron-builder.yml appId locked to `com.sei.app` |
| 08-02-windows-dev-smoke | 2 | false | ⏸ Deferred | Requires Windows 10/11 x64 VM — user runs `npm run dev` smoke |
| 08-03-windows-packaged-smoke-and-defect-fix | 3 | false | ⏸ Deferred | Requires Windows VM — user runs `npm run dist:win` smoke + installer test |
| 08-04-documentation | 4 | true | ⏸ Blocked | Depends on Plans 02 + 03 outputs (smoke evidence required for README + RELEASE-NOTES citations) |

## Must-Haves Coverage (from CONTEXT.md "Scope of 'works'" 6-point bar)

All 6 bars route to Plan 08-03 verification (packaged smoke). None can be verified statically on macOS.

| Bar | Description | Verifiable Now? | Status |
|-----|-------------|-----------------|--------|
| #1 | NSIS installer installs cleanly on fresh Win10/11 VM | No — needs Windows | Deferred to live testing |
| #2 | Sei launches from Start Menu | No — needs Windows | Deferred to live testing |
| #3 | First-launch onboarding completes | No — needs Windows | Deferred to live testing |
| #4 | Summon bot to LAN, exchange chat, disconnect | No — needs Windows | Deferred to live testing |
| #5 | `%APPDATA%\Sei\` files persist across relaunch | No — needs Windows | Deferred to live testing |
| #6 | Bot debug logs reach renderer Logs panel | No — needs Windows | Deferred to live testing |

## What Was Verified Statically (Plan 08-01)

- 24 cross-platform-sensitive code paths cataloged in 08-HOTSPOTS.md (19 SAFE / 1 SUSPECT / 1 FIX-INLINE / 4 DEFER-TO-LIVE)
- No `child_process.spawn`/`exec` usage in `src/` — only `utilityProcess.fork` (cross-platform Electron API)
- No native deps requiring rebuild beyond Electron itself
- `src/main/paths.ts`, `src/bot/cli/index.js`, `src/main/windowChrome.ts`, `src/main/index.ts`, `src/main/ipc.ts` already correctly platform-branched
- `electron-builder.yml` `appId` locked to `com.sei.app` (Phase 4 04-10 BLOCKING closed)
- `productName: Sei` preserved — drives `%APPDATA%\Sei\` resolution on Windows

## Human-Needed Verification Items

When a Windows 10/11 x64 host is available, the user runs:

### Plan 08-02 (Dev smoke)
1. Clone repo on Windows, run `npm install`
2. Run `npm run dev` and complete onboarding flow
3. Summon a bot to a vanilla LAN world, exchange chat, disconnect
4. Verify each Wave-2 row in `08-HOTSPOTS.md` passes
5. Seed `08-DEV-SMOKE.md` with PASS/FAIL evidence
6. File any failures in `08-WINDOWS-DEFECTS.md`

### Plan 08-03 (Packaged smoke + defect fix)
1. Run `npm run dist:win` on Windows
2. Install the NSIS installer on a clean Windows profile
3. Run the same end-to-end smoke against the packaged build
4. Verify all 6 "Bar to clear" items from CONTEXT §"Scope of 'works'"
5. For any OPEN defects in `08-WINDOWS-DEFECTS.md`: ship atomic `fix(08-win):` commits, re-test
6. Repeat until all rows PASS

### Plan 08-04 (Documentation — blocked on 02/03)
- Run after Plan 08-03 PASSes all bars
- Writes README Windows section, RELEASE-NOTES Windows entry, and 08-WINDOWS-GUIDE.md from accumulated smoke evidence

## Resume Path

When ready to land Wave 2:
```
/gsd-execute-phase 8 --wave 2
```

## Verification Verdict

**Status:** `human_needed`

The autonomous portion of Phase 8 is complete and committed. The phase as a whole cannot reach `passed` until a Windows host is available to run Plans 08-02 + 08-03 + 08-04. This is by design — the phase's purpose is "verify Sei runs on Windows," which intrinsically requires a Windows runtime.

The autonomous workflow should route this as `human_needed` with the validation request "When ready: provide Windows 10/11 host and resume with `/gsd-execute-phase 8 --wave 2`."
