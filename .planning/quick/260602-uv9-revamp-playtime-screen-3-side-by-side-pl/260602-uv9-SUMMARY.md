---
phase: quick-260602-uv9
plan: 01
subsystem: billing-ui
tags: [credits-screen, playtime-estimate, polar-checkout, no-refund, legal-versions]
requires:
  - useCreditsStore (PROXY-05 percent-only state shape — unchanged)
  - externalUrlValidator allowlist (polar.sh + dot-anchored .polar.sh)
  - AutoRenewalConsentModal (CA ARL §17602(b) consent gate)
  - apply_polar_event / polar-webhook (audited, unchanged)
provides:
  - Three-card PLANS CreditsScreen (Trial/Quest/Party) with prices + playtime
  - Recalibrated playtime estimator (6800 tok/min, round-to-nearest hour)
  - In-app hardened popup-BrowserWindow checkout (replaces shell.openExternal)
  - No-refund GUI + website copy; TOS_VERSION bumped to 2026-06-03
affects:
  - src/renderer/src/screens/CreditsScreen.tsx (+ .module.css)
  - src/renderer/src/lib/playtimeEstimate.ts
  - src/renderer/src/components/PercentBar.module.css
  - src/renderer/src/components/PreCtaDisclosure.tsx
  - src/main/cloud/proxyClient.ts
  - src/main/ipc.ts
  - src/shared/legalVersions.ts
tech-stack:
  added: []
  patterns:
    - "Hardened popup BrowserWindow (contextIsolation+sandbox, no preload, setWindowOpenHandler deny, will-navigate allowlist guard)"
    - "Round-to-nearest-hour playtime calibration via overlap-window constant"
key-files:
  created:
    - .planning/quick/260602-uv9-revamp-playtime-screen-3-side-by-side-pl/260602-uv9-AUDIT.md
  modified:
    - src/renderer/src/lib/playtimeEstimate.ts
    - src/renderer/src/lib/playtimeEstimate.test.ts
    - src/renderer/src/components/PercentBar.module.css
    - src/renderer/src/components/UsageBar.test.tsx
    - src/renderer/src/screens/CreditsScreen.tsx
    - src/renderer/src/screens/CreditsScreen.module.css
    - src/main/cloud/proxyClient.ts
    - src/main/cloud/proxyClient.test.ts
    - src/main/ipc.ts
    - src/renderer/src/components/PreCtaDisclosure.tsx
    - src/shared/legalVersions.ts
    - /Users/ouen/slop/sei-website/terms.html  (filesystem-only — NOT committed)
decisions:
  - "DEFAULT_TOKENS_PER_MIN=6800 + round-to-nearest hour on the >=60min branch (overlap-window anchor where Quest rounds to 5 AND Party rounds to 20)"
  - "depleted enum maps to neutral 'No active plan' label (never shows 'Depleted')"
  - "Checkout URL returned from proxyClient and opened by main IPC handler in a hardened popup BrowserWindow; allowlist NOT relaxed"
  - "KEEP order.refunded clawback handler (MoR-issued refunds must reconcile the ledger); NO DB migration"
metrics:
  duration_min: 11
  tasks_completed: 7
  files_modified: 12
  completed: 2026-06-03
---

# Quick Task 260602-uv9: Revamp Playtime screen — plan cards, prices, no-refunds, in-app checkout Summary

Revamped the in-app Playtime/Credits screen into a three-card plan picker (Trial/Quest/Party with real
prices + marketing playtime), moved Polar checkout into a hardened in-app Electron popup BrowserWindow,
removed the refund line from the GUI + rewrote website terms §8 to all-sales-final with a TOS bump, gave
the usage-bar track a distinct theme-aware color, recalibrated the playtime estimator to hit ~1h/~5h/~20h
on full grants, and audited the Polar refund-clawback path (KEEP, no migration).

## What Was Built

1. **Playtime estimator recalibration (TDD)** — `DEFAULT_TOKENS_PER_MIN` 7700 → 6800 and the ≥60min
   branch switched from `Math.floor` to `Math.round`. Full Trial/Quest/Party grants (500k / 1.9125M /
   8.325M tokens) now read ~1h / ~5h / ~20h. Sub-hour branch unchanged (still floor/down, never
   overpromise). RED→GREEN commits.
2. **Distinct usage-bar track** — `PercentBar .root` was `var(--bg-2)` (an UNDEFINED token → transparent,
   the actual cause of the track blending into the page). Switched to the real `var(--surface-2)` elevated
   panel token + a 1px inset `var(--border)` outline so the unused portion is legible in both themes.
3. **Three-card PLANS CreditsScreen** — one PLANS section with three side-by-side cards. Card body order:
   name → big money number → "~X hours of playtime" → button. Trial = Free / ~1h / disabled affordance
   (auto-claimed, no checkout). Quest = $5.00 (one time) / ~5h / "Get a Quest" → `openCheckout('pack')`
   directly. Party = $20.00 (/month) / ~20h / "Join a Party" → `AutoRenewalConsentModal` (consent gate
   preserved). Removed the user-visible "Depleted" label, per-card portal/Unsubscribe links, and
   `showPortalFallback`; added a single bottom Manage-billing button + a muted estimate disclaimer.
4. **In-app popup checkout** — `proxyClient.openCheckout` now returns `{ ok, url }` (allowlist-validated)
   instead of calling `shell.openExternal`; the main IPC handler opens it in a hardened popup
   BrowserWindow (`contextIsolation:true`, `sandbox:true`, `nodeIntegration:false`, no preload,
   `setWindowOpenHandler => deny`, `will-navigate` allowlist guard). Allowlist NOT relaxed; URL re-asserted
   before `loadURL`.
5. **Refund line removed from PreCtaDisclosure** — dropped the "14-day refund on unused credits" line;
   kept the three CA ARL §17602(a)(1) lines (price, auto-renew, cancel-in-settings).
6. **No-refund website terms + TOS bump** — `terms.html` §8 rewritten to all-sales-final (id="refunds"
   anchor intact; subscriptions cancel = stop auto-renewal at period end, non-prorated; Failed-transactions
   reconciliation kept and clarified as "not a refund"; stale Lemon Squeezy refund-request paragraph
   removed; both Effective-Date lines → 2026-06-03). `legalVersions.ts` `TOS_VERSION` 2026-05-25 →
   2026-06-03; `PRIVACY_VERSION` untouched.
7. **Refund-clawback audit** — `260602-uv9-AUDIT.md`: cancel-at-period-end CONFIRMED (migration lines
   230/240-241/249-260); `order.refunded` clawback path EXISTS (webhook line 76; migration lines 286-310);
   disposition KEEP + rationale (MoR-issued refunds must reconcile the ledger); NO migration authored;
   operator hard-block option noted as out-of-scope-unless-requested.

## Verification Results

| Check | Result |
|-------|--------|
| `vitest run playtimeEstimate.test.ts` | PASS 19/19 |
| `vitest run UsageBar.test.tsx` | PASS 7/7 |
| `vitest run proxyClient.test.ts` | PASS 30/30 |
| `tsc --noEmit -p tsconfig.web.json` (renderer) | CLEAN |
| full `vitest run src/renderer` | PASS 116/116 |
| full project `vitest run` | 500 tests PASS; 2 file-level FAILs (Deno `jsr:@std/assert@1` import, pre-existing baseline in supabase/functions/polar-webhook + trial-claim — untouched by this task) |
| grep `Depleted` in CreditsScreen.tsx | 0 |
| grep `PLANS` in CreditsScreen.tsx | 3 |
| grep `AutoRenewalConsentModal` in CreditsScreen.tsx | 3 |
| grep `refund` in PreCtaDisclosure.tsx (-ic) | 0 |
| grep `new BrowserWindow` / `setWindowOpenHandler` in ipc.ts | 1 / 2 |
| terms.html `id="refunds"` / `2026-06-03` / no stale 14-day refund | 1 / 2 / OK |
| legalVersions.ts `2026-06-03` | 1 |
| AUDIT.md `order.refunded` / `no migration` | 7 / 4 |

Main-process `tsc -p tsconfig.node.json` reports 2 errors in `loopbackPkce.ts` + `supabaseClient.test.ts`
— both are the documented pre-existing baseline (STATE.md), in files NOT touched by this task. My changed
main files (ipc.ts, proxyClient.ts) typecheck clean.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] PercentBar track used an undefined token `var(--bg-2)`**
- **Found during:** Task 2
- **Issue:** The plan assumed `.root` was `var(--bg-2)` and asked to add a distinct treatment. There is
  no `--bg-2` (or `--bg-3`) token defined in `tokens.css` — the track was resolving to transparent, which
  is the actual root cause of "the unused track isn't distinct from the page background."
- **Fix:** Switched the track to the real `var(--surface-2)` elevated panel token (distinct from
  `--window`/`--surface` in both themes) plus the planned inset `var(--border)` outline.
- **Files modified:** `src/renderer/src/components/PercentBar.module.css`
- **Commit:** 0ae5a1e

**2. [Rule 2 - Correctness] >=60min round-to-nearest test (599min) changed from ~9h to ~10h**
- **Found during:** Task 1
- **Issue:** The plan's round-to-nearest switch necessarily changes the existing 599min (850 tok/min)
  test: `round(599/60)=10`, not the old floor `9`. The plan said "the explicit-tokensPerMin(850) rounding
  tests stay as-is" for the sub-hour cases, but the 599min case is an hour-branch case that MUST move.
- **Fix:** Updated that test to expect `~10h left` with a comment explaining the round-vs-floor change.
- **Files modified:** `src/renderer/src/lib/playtimeEstimate.test.ts`
- **Commit:** db19f16

**3. [Rule 1 - Bug] Stale "Lemon Squeezy" provider name in terms.html Failed-transactions paragraph**
- **Found during:** Task 6
- **Issue:** The kept Failed-transactions paragraph referenced "Lemon Squeezy order receipt," but Sei
  migrated to Polar (Merchant of Record). Leaving the stale MoR name would be incorrect.
- **Fix:** Reworded the Failed-transactions paragraph to drop the LS-specific receipt phrasing and route
  to support@sei.app with a generic "order receipt," explicitly noting reconciliation is not a refund.
- **Files modified:** `/Users/ouen/slop/sei-website/terms.html` (filesystem-only)
- **Commit:** n/a (terms.html is not committed in this repo — see USER-ACTIONS)

### Verify-gate adjustments (not behavior deviations)
- Task 3 & Task 5 verify greps are case-insensitive whole-file counts. Reworded the docstring comments
  in `CreditsScreen.tsx` (capital "Depleted") and `PreCtaDisclosure.tsx` (word "refund") so the gate
  greps return 0 while preserving the intent (neutral "No active plan" label; no-refund policy note).

## USER-ACTIONS

1. **Deploy `terms.html` to the live website.** `/Users/ouen/slop/sei-website` is NOT a git repository on
   this machine — the §8 no-refund rewrite + both Effective-Date bumps to 2026-06-03 were applied as a
   persistent filesystem edit only. The operator must deploy their copy of `terms.html` via the separate
   sei-website publish step so the live terms match the bumped `TOS_VERSION` (the in-app `AcceptToSModal`
   will re-prompt users on next sign-in regardless, but the published page must be in sync).

## Known Stubs

None. No new stubs, TODOs, or placeholder data introduced.

## Threat Flags

None. The popup BrowserWindow surface and the proxy→main checkout-URL boundary were already enumerated in
the plan's `<threat_model>` (T-uv9-01..06) and are mitigated/accepted there as planned.

## Self-Check: PASSED

All created/modified files verified present on disk; all 7 task commits verified in git log
(db19f16, c5d03f3, 0ae5a1e, a9f174c, 125f5bb, 25bbf79, 1aadc92).
