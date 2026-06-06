---
phase: 13-ai-proxy-billing-usage-ui
plan: 17
subsystem: ui
tags: [renderer, react, zustand, svg, icon-rail, byok-bypass, accessibility]

# Dependency graph
requires:
  - phase: 13
    provides: "useCreditsStore (13-16) — `remaining_pct` + `ai_backend_kind` selectors backing the icon"
  - phase: 13
    provides: "creditsGet / onCreditsStatusUpdate IPC (13-02 + 13-13) — store-internal hydration path"
provides:
  - "PricingIcon SVG component (bottom-up fill, 200ms transition, currentColor)"
  - "Conditional RailButton above Settings, mounted ONLY when ai_backend_kind === 'cloud-proxy'"
  - "'credits' navigation kind on useUiStore.View (and subtitleForView mapping)"
  - "useCreditsStore.init() called once on App mount (mirrors useSyncStore pattern)"
affects: [13-18, 13-19, 13-22]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Defense-in-depth BYOK gating via conditional render (unmount) — never CSS-hide"
    - "Idempotent store.init() on App mount, fire-and-forget, [] deps, store-internal `initialized` flag"
    - "SVG glyph with currentColor + opacity for theme-aware bottom-up fill (transition on height/y)"

key-files:
  created: []
  modified:
    - src/renderer/src/components/icons.tsx
    - src/renderer/src/components/IconRail.tsx
    - src/renderer/src/lib/stores/useUiStore.ts
    - src/renderer/src/App.tsx

key-decisions:
  - "Conditional render `{cond && <RailButton/>}` (unmount) over CSS hide — BYOK users never have the credits affordance in their DOM tree (PROXY-11)."
  - "Tooltip via native `title` attribute (RailButton already accepts `title`) — keep the change surgical; D-54 copy verbatim."
  - "SVG layering: inner fill rect drawn before outer body stroke so the stroke frames the fill cleanly without a clipPath."
  - "Dropped the `aria-label` shown in the plan's example because RailButton's props interface does not accept it — `title` already conveys the % to screen readers via accessible-name fallback; T-13-17-04 is dispositioned `accept` in the plan's threat register so no a11y regression."

patterns-established:
  - "Cloud-only renderer surfaces: gate at the JSX `&&` operator, not via CSS — defense in depth so DOM inspection reveals nothing"
  - "Store-backed RailButton: read `remaining_pct` + `ai_backend_kind` via separate selectors so React only re-subscribes the rail when those slices change"

requirements-completed: [PROXY-04, PROXY-05, PROXY-11]

# Metrics
duration: 4min
completed: 2026-05-22
---

# Phase 13 Plan 17: Pricing Icon RailButton Summary

**Wallet-glyph PricingIcon RailButton inserted above Settings — bottom-up fill animates from remaining_pct, mounted only when ai_backend_kind === 'cloud-proxy', tooltip "{pct}% credits left · click for details" verbatim from D-54.**

## Performance

- **Duration:** ~4 min
- **Started:** 2026-05-23T05:15:41Z
- **Completed:** 2026-05-23T05:19:33Z
- **Tasks:** 3
- **Files modified:** 4

## Accomplishments
- New `PricingIcon` SVG in `icons.tsx`: 24-unit viewBox, outer rounded wallet body, flap, inner fill rect with `transition: height 200ms ease, y 200ms ease`. `currentColor` + 0.4 opacity so theme tokens drive palette.
- `IconRail.tsx`: new `RailButton` directly above the existing Settings button, wrapped in `{aiBackendKind === 'cloud-proxy' && (...)}` — fully unmounted for BYOK users (defense-in-depth per PROXY-11).
- Tooltip copy verbatim from D-54: `${remainingPct}% credits left · click for details`.
- `useUiStore.View` union gains `{ kind: 'credits' }`; `subtitleForView` in App.tsx maps it to "Credits".
- `useCreditsStore.init()` mounted once on App boot (parallel `useEffect` next to `useSyncStore.init()`).
- `npx tsc --noEmit -p tsconfig.web.json` clean once 13-16 (`useCreditsStore.ts`) landed mid-execution.

## Task Commits

Each task was committed atomically:

1. **Task 1: PricingIcon glyph + 'credits' view variant** — `a845039` (feat)
2. **Task 2: Insert PricingIcon RailButton above Settings (cloud-proxy only)** — `26ed68d` (feat)
3. **Task 3: Mount useCreditsStore.init() on app boot** — `5e2c385` (feat)

## Files Created/Modified
- `src/renderer/src/components/icons.tsx` — Added `PricingIcon` component (wallet + bottom-up fill rect + 200ms transition).
- `src/renderer/src/components/IconRail.tsx` — New conditional RailButton above Settings; selectors on `useCreditsStore` for `remaining_pct` and `ai_backend_kind`.
- `src/renderer/src/lib/stores/useUiStore.ts` — Added `{ kind: 'credits' }` to the `View` union.
- `src/renderer/src/App.tsx` — Added `useCreditsStore.init()` `useEffect` and a `'credits'` case to `subtitleForView`.

## Decisions Made
- **Unmount over CSS-hide for BYOK bypass** — Plan and PROXY-11 are explicit; coded as `{aiBackendKind === 'cloud-proxy' && <RailButton/>}`. A curious BYOK user opening DevTools sees no credits-related node in the rail at all.
- **`title` attribute (no separate `aria-label`)** — The plan's example showed both, but `RailButton`'s props interface only accepts `title`. Adding a new prop would have widened the change and made 13-18/13-19's parallel work on IconRail messier. `title` doubles as the accessible name; T-13-17-04 disposition is `accept`.
- **SVG layering, no clipPath** — Drew inner fill rect BEFORE the outer body stroke. Because the fill rect (x=5..19, y∈[6..20]) sits strictly inside the body (x=3..21, y=6..20), no clip mask is required and the body stroke is rendered on top, framing the fill cleanly.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical] Added `case 'credits'` to `subtitleForView` in `App.tsx`**
- **Found during:** Task 1 (View union extension)
- **Issue:** The plan said "If subtitleForView(view) exists, add `case 'credits': return 'Credits'`". It exists in App.tsx — without the case, the MacosWindow subtitle would silently fall through to `''` when navigating to credits.
- **Fix:** Added the case in App.tsx alongside the `useCreditsStore.init()` change (single commit since both edits in same file).
- **Files modified:** src/renderer/src/App.tsx
- **Verification:** `grep -n "case 'credits'" src/renderer/src/App.tsx` → match at line 514.
- **Committed in:** 5e2c385 (Task 3 commit).

**2. [Rule 3 - Blocking, transient] `useCreditsStore` import unresolved at start**
- **Found during:** Initial typecheck after Tasks 1-3 edits, before 13-16 GREEN gate landed.
- **Issue:** Plan 13-17 imports `useCreditsStore`, but 13-16 (the store itself) was an in-flight sibling plan and `src/renderer/src/lib/stores/useCreditsStore.ts` did not yet exist when I began. Caused `TS2307` on App.tsx + IconRail.tsx + (pre-existing parallel-agent) SettingsScreen.tsx, plus cascading `TS7006` (implicit `any` selectors).
- **Fix:** None required from this plan — 13-16 GREEN landed at `89326f8 feat(13-16): implement useCreditsStore with push-seq race guard` mid-execution. Final `npx tsc --noEmit -p tsconfig.web.json` is clean.
- **Files modified:** n/a — out of scope (13-16 sibling).
- **Verification:** Re-ran typecheck after 13-16 landed → no errors.
- **Committed in:** n/a (sibling plan).

---

**Total deviations:** 1 auto-fixed (1 missing critical). The second item is documented for transparency but resolved itself when the sibling plan landed.
**Impact on plan:** No scope creep. The subtitleForView extension is correctness-only.

## Issues Encountered

- **Parallel-agent worktree race on Task 1 commit.** When I ran `git commit` for Task 1, another parallel agent had already staged `src/renderer/src/screens/SettingsScreen.tsx` (a 13-20 in-flight change) in the worktree index. My `git commit` (no path args, just relied on `git add` having only staged my two files) swept the SettingsScreen.tsx staging in too, so commit `a845039` is wider than intended — it includes the 13-20 Cloud-AI button row. The added code is correct 13-20 work, not destructive, and the orchestrator can re-attribute it during phase-level verification. For Tasks 2 and 3 I switched to `git commit <file>` to scope each commit explicitly. Recommend the orchestrator file an issue against the parallel-execution harness to use `git update-index --skip-worktree` or per-agent worktrees to prevent index races.

## Threat Flags

None. The plan's `<threat_model>` covers all four surfaces introduced (T-13-17-01..04). No new endpoints, auth paths, file access, or schema boundaries were added.

## User Setup Required

None — UI-only change; no external service configuration required.

## Next Phase Readiness

- PricingIcon surface is ready for 13-18 (CreditsScreen) and 13-19 (HardStopModal) to consume — navigation kind `'credits'` is defined and the rail routes to it.
- 13-18 will likely add the `case 'credits'` render branch in App.tsx's main view switch; 13-17 stayed surgical on App.tsx to keep that conflict minimal.
- BYOK ↔ cloud-proxy toggle in Settings (13-20 in flight) was inadvertently bundled into Task 1's commit (see Issues Encountered) — verify scope at phase verification.

## Self-Check: PASSED

- FOUND: `src/renderer/src/components/icons.tsx` (PricingIcon exported, 3 occurrences)
- FOUND: `src/renderer/src/components/IconRail.tsx` (conditional `aiBackendKind === 'cloud-proxy'`, PricingIcon RailButton, D-54 tooltip)
- FOUND: `src/renderer/src/lib/stores/useUiStore.ts` (`{ kind: 'credits' }` in View union)
- FOUND: `src/renderer/src/App.tsx` (`useCreditsStore.getState().init()` + `case 'credits'`)
- FOUND: commits `a845039`, `26ed68d`, `5e2c385`
- `npx tsc --noEmit -p tsconfig.web.json` → no output (clean)

---
*Phase: 13-ai-proxy-billing-usage-ui*
*Completed: 2026-05-22*
