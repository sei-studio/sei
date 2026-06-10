---
phase: 15-in-game-vision-via-prismarine-viewer
plan: 05
subsystem: ui
tags: [react, zustand, settings, modal, playtime-estimate, vision, proxy-05]

# Dependency graph
requires:
  - phase: 15-in-game-vision-via-prismarine-viewer (plan 03)
    provides: UserConfigSchema.vision_auto_render (persistence surface) + useUiStore.visionCapable (fail-closed VLM gate) — both consumed here
provides:
  - "VisionAutoRenderConfirmModal — plain-language 'uses more playtime' confirm popup (D-06), ZERO token/dollar/numeric estimates (PROXY-05)"
  - "Settings 'Auto-look (vision)' toggle row — ON opens the confirm modal then writes vision_auto_render:true; OFF writes false directly; disabled={!visionCapable} (D-05/D-10)"
  - "VISION_MULTIPLIER (1.4) in playtimeEstimate.ts — applied to the burn rate at the ~Xh display sites when auto-render is ON, shrinking the figure (D-07)"
affects: [15-07]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Pending-state confirm-on-enable: a boolean useState opens the confirm modal; only the confirm handler writes the cost-feature ON (turning OFF flips directly)"
    - "Cost communication via a shrunk derived figure (rate multiplier passed into an existing pure estimator) rather than a numeric warning at toggle time"
    - "Cloud-proxy-only display surfaces carry the vision shrink for free — D-11 (no BYO/local cost surface) falls out of the Phase-13 credits-UI gating"

key-files:
  created:
    - src/renderer/src/components/VisionAutoRenderConfirmModal.tsx
  modified:
    - src/renderer/src/screens/SettingsScreen.tsx
    - src/renderer/src/lib/playtimeEstimate.ts
    - src/renderer/src/lib/playtimeEstimate.test.ts
    - src/renderer/src/components/UsageBar.tsx
    - src/renderer/src/components/IconRail.tsx
    - src/renderer/src/components/UsageBar.test.tsx

key-decisions:
  - "VISION_MULTIPLIER = 1.4 (midpoint of the 1.3–1.5x research band) — honest 'vision costs noticeably more but not punitively' estimate"
  - "Both ~Xh display sites (UsageBar = CreditsScreen hero; IconRail = rail tooltip) read vision_auto_render via sei.getConfig() on mount and pass the multiplied rate; no new store field or push channel added"
  - "Non-VLM disable is wired to useUiStore.visionCapable (the 15-03 signal) — no ai_backend_kind fallback, no deferral; the toggle helper line explains why it is disabled"
  - "Turning auto-look OFF needs no confirm (disabling a cost feature is always safe); only the ON path opens VisionAutoRenderConfirmModal (D-05)"

patterns-established:
  - "Confirm-on-enable cost-feature toggle: pending boolean → modal → write-through-on-confirm, mirroring the pendingSwitch backend-switch pattern"

requirements-completed: [VIS-03, VIS-04, VIS-06]

# Metrics
duration: 6min
completed: 2026-06-10
---

# Phase 15 Plan 05: Settings auto-render toggle + cost communication Summary

**A single Settings "Auto-look (vision)" toggle gated on the 15-03 `visionCapable` signal that opens a plain-language confirm popup ("uses more playtime", zero numbers) before writing `vision_auto_render` to UserConfig, with the cost surfacing as a VISION_MULTIPLIER (1.4×) shrink of the "~Xh left" playtime figure on the cloud-proxy display sites.**

## Performance

- **Duration:** ~6 min
- **Started:** 2026-06-10T17:43:18Z
- **Completed:** 2026-06-10T17:48:30Z
- **Tasks:** 3 (Task 3 was TDD: RED + GREEN, no refactor needed)
- **Files modified:** 7 (1 created, 6 modified)

## Accomplishments

- **Confirm popup (D-06 / PROXY-05):** `VisionAutoRenderConfirmModal.tsx` cloned from `SwitchBackendConfirmModal`, reusing the shared `SignOutConfirmModal.module.css` (no new CSS). Body copy is plain language — auto-look "uses more playtime" — with ZERO token counts, dollar amounts, or numeric estimates (grep-gated). Escape-to-cancel, scrim-click cancel, submitting guard, `Button` ghost/primary.
- **Settings toggle (D-05 / D-10):** ONE "Auto-look (vision)" row in the APPEARANCE section reading `cfg.vision_auto_render`. Turning ON sets `pendingVisionEnable` → opens the confirm modal → `confirmEnableAutoRender` writes `vision_auto_render:true` through to UserConfig (optimistic + rollback). Turning OFF flips directly via `onDisableAutoRender`. The Button is `disabled={!visionCapable}` (the 15-03 store signal) with a helper line explaining the non-VLM disable.
- **Playtime shrink (D-07):** `VISION_MULTIPLIER = 1.4` exported from `playtimeEstimate.ts`. Both ~Xh display sites — `UsageBar` (CreditsScreen hero) and `IconRail` (rail tooltip) — read `vision_auto_render` on mount and pass `DEFAULT_TOKENS_PER_MIN * VISION_MULTIPLIER` as the rate when ON. A higher effective rate shrinks `rawMin = remainingTokens / tokensPerMin`, so the same balance reads as less playtime. OFF is byte-for-byte the prior figure.

## Task Commits

1. **Task 1: VisionAutoRenderConfirmModal (D-06)** — `9eb1987` (feat)
2. **Task 2: Settings toggle + confirm + non-VLM disable (D-05/D-10)** — `34f58c3` (feat)
3. **Task 3 (TDD): VISION_MULTIPLIER playtime shrink (D-07)** — `f21b97d` (test / RED), `3c8bd00` (feat / GREEN)

_TDD note: RED commit `f21b97d` added 3 failing tests (`VISION_MULTIPLIER` not yet exported → undefined / NaN rate); GREEN commit `3c8bd00` exported the constant, wired both call sites, and updated the one UsageBar source-string test that encoded the old call signature. No refactor commit needed._

## Files Created/Modified

**Created**
- `src/renderer/src/components/VisionAutoRenderConfirmModal.tsx` — the "Turn on auto-look?" confirm popup; plain "uses more playtime" copy, no numbers; reuses shared modal CSS + Button.

**Modified**
- `src/renderer/src/screens/SettingsScreen.tsx` — `visionCapable` selector; `pendingVisionEnable` state; `confirmEnableAutoRender` / `onDisableAutoRender` / `onToggleAutoRender` handlers; the toggle row + helper line; conditional modal render.
- `src/renderer/src/lib/playtimeEstimate.ts` — `export const VISION_MULTIPLIER = 1.4` with rationale (D-07, PROXY-05, D-11 notes).
- `src/renderer/src/lib/playtimeEstimate.test.ts` — 5 new tests: multiplier range [1.3,1.5], strictly >1, multiplied-rate shrinks vs base, analytic floor match, OFF unchanged (no regression).
- `src/renderer/src/components/UsageBar.tsx` — reads `vision_auto_render` via `sei.getConfig()` on mount; passes the multiplied `rate` to `tokensRemainingToPlaytime`.
- `src/renderer/src/components/IconRail.tsx` — same shrink applied to the rail "Playtime · ~Xh" tooltip (already cloud-proxy gated).
- `src/renderer/src/components/UsageBar.test.tsx` — updated Test 3's source-string assertion to the new rate-arg + vision-shrink contract.

## Exported Contracts (for downstream plans)

- `VISION_MULTIPLIER` (`playtimeEstimate.ts`) — `1.4`. Apply as `DEFAULT_TOKENS_PER_MIN * VISION_MULTIPLIER` only at cloud-proxy-visible ~Xh display sites when `vision_auto_render` is true (D-11: never where a BYO/local user could see it).
- `VisionAutoRenderConfirmModal` — `{ onCancel, onConfirm: () => void | Promise<void> }`; the canonical cost-heads-up popup for enabling vision.

## Cost-communication copy + multiplier (orchestrator data)

- **Popup title:** `Turn on auto-look?`
- **Popup body (exact):** "With auto-look on, your bot will glance around and take a look at its surroundings on its own from time to time. Seeing the world uses more playtime than leaving auto-look off. You can turn it back off any time."
- **Popup CTAs:** `Cancel` (ghost) / `Turn on auto-look` (primary; `Turning on…` while submitting).
- **VISION_MULTIPLIER applied to the playtime estimate:** `1.4`.
- **Screen that owns the ~Xh display:** `UsageBar` (the CreditsScreen "Playtime" hero) is the primary surface; `IconRail` renders the same figure as the rail "Playtime · ~Xh" tooltip. Both apply the shrink.

## Decisions Made

- **1.4× multiplier** — midpoint of the documented 1.3–1.5× band; honest heavier-usage hint (exact per-frame cost varies by resolution/quality + idle cadence, so a flat hint is the right granularity).
- **Read config on mount at the display sites** rather than adding a new reactive store field or a config-push channel — minimal surface, and both surfaces remount on navigation so a toggle flip in Settings is reflected next time the user opens Playtime/the rail recomputes.
- **OFF flips directly, ON confirms** — disabling a cost feature is always safe; only enabling warrants the heads-up (D-05).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Updated UsageBar Test 3 to the new call signature**
- **Found during:** Task 3 (GREEN — after wiring the multiplier into UsageBar)
- **Issue:** `UsageBar.test.tsx` Test 3 is a source-string assertion that pinned the exact literal `tokensRemainingToPlaytime(remainingTokens)` (the old no-rate call) and asserted no rate plumbing reached the component. Wiring the D-07 multiplier changed the call to `tokensRemainingToPlaytime(remainingTokens, rate)`, so the stale assertion failed (1 of 7).
- **Fix:** Updated Test 3 to assert the new, correct contract — the call now passes a `rate`, references `VISION_MULTIPLIER`, and reads `vision_auto_render`; the `tokens_per_min` (per-user plumbing) negative assertion was kept.
- **Files modified:** `src/renderer/src/components/UsageBar.test.tsx`
- **Verification:** `npx vitest run src/renderer/src/components/UsageBar.test.tsx` → 7/7 pass; full suite 594/594.
- **Committed in:** `3c8bd00` (Task 3 GREEN commit)

---

**Total deviations:** 1 auto-fixed (1 bug — stale test contract)
**Impact on plan:** The test update is a necessary consequence of the intended D-07 wiring (the test encoded the pre-D-07 contract). No scope creep.

## Issues Encountered

- The plan's "delete the stale `SettingsScreen.js` / `playtimeEstimate.js` shadow" step found nothing to delete: this repo's web typecheck runs `tsc --noEmit` (electron-vite), so no sibling `.js` were emitted. The `ls` gates correctly report "stale .js deleted" (none present), satisfying the acceptance criterion. (Documented per the project pitfall — if a future `tsc --build` dev loop re-creates them, they must be removed outside `src/bot`.)

## Threat Flags

None — no new security surface beyond the plan's `<threat_model>`. All four registered threats are mitigated as specified:
- **T-15-05-01 (PROXY-05 number leak):** popup body grep-gated to zero count/dollar/numeric patterns; the playtime shrink changes only the time figure.
- **T-15-05-02 (stale .js):** no stale `.js` shadows present (ls-gated).
- **T-15-05-03 (silent cost enable):** turning ON requires the confirm popup; cost also surfaces as the shrunk figure.
- **T-15-05-04 (non-VLM enable):** toggle `disabled={!visionCapable}` (the authoritative renderer-side signal); bot-side gates remain the enforcement boundary.

## Known Stubs

None — every surface is wired end-to-end. The toggle reads/writes real `UserConfig.vision_auto_render`, the disable gates on the real `useUiStore.visionCapable` push (15-03), and the multiplier is applied at both live ~Xh display sites reading the real config value.

## Next Phase Readiness

- **15-07 (idle auto-render gate):** the user-facing opt-in is now fully delivered — `vision_auto_render` is renderer-settable (with the cost heads-up + shrunk estimate), bridged to `config.vision.auto_render` at fork (15-03). 15-07 hooks the idle path gated on `config.vision.auto_render` + the LOS helper.
- No blockers. Full client vitest suite green (55 files / 594 tests); web tsc clean.

## Self-Check: PASSED

(verified below)

---
*Phase: 15-in-game-vision-via-prismarine-viewer*
*Completed: 2026-06-10*
