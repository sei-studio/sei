---
quick_id: 260602-hbr
title: Simplify playtime estimate to a constant tokens/min + usage-% progress bar
status: complete
created: 2026-06-02
completed: 2026-06-02
requirements: [PROXY-05]
commits: [68c1aef, 9d00ab5, 885682e]
---

# Quick Task 260602-hbr — Summary

## What changed

Replaced the personalized per-user playtime estimator with a single flat
`tokens/min` multiplier, and made the **primary** credits display a
**usage-percent progress bar** (used ÷ available, starting at 0%) with a small
"~Xh left" estimate beside it and an "estimate, actual playtime can vary"
tooltip.

### Backend (commit `68c1aef`)
- `CreditsStatus` gains **`usage_pct`** (percent only — PROXY-05 keeps token/
  dollar units server-side) and **drops `tokens_per_min`**.
- `proxyClient.creditsGet()` now reads **`ledger_grants`** (sum of
  `credits_micro` = total available, refund rows negative) instead of the
  rolling-24h `ledger_consumption` read. `usage_pct = used / available` where
  `used = available − balance` (clamped ≥ 0), rounded to `REMAINING_PCT_STEP`.
  The whole `MIN_SIGNAL_ROWS`/`PEAK_CALLS_PER_MIN`/`STARTUP_TOKENS` derivation
  is gone. `remaining_tokens` (= balance ÷ 2) stays for the playtime estimate.

### Renderer policy (commit `9d00ab5`)
- `playtimeEstimate.ts`: `DEFAULT_TOKENS_PER_MIN` is now a **flat 7700
  tokens/min** (≈ $0.92/hr at the 2 µ$/tok blend → ~4 h on a full Quest grant,
  ~18 h on a full Party grant, matching the "~5 hrs / ~20 hrs" copy). Removed
  `PEAK_CALLS_PER_MIN` / `STARTUP_TOKENS` / `SESSIONS_PER_HOUR`.

### Frontend (commit `885682e`)
- New **`UsageBar`** (reuses the existing `PercentBar`): usage-% fill +
  "~Xh left" estimate + tooltip. `CreditsScreen` swaps `PlaytimePill` →
  `UsageBar`; `IconRail` drops the `tokens_per_min` selector; the store gains
  `usage_pct` and drops `tokens_per_min` (Test 11 allow-list tightened to
  `remaining_tokens` only). **`PlaytimePill` deleted.**

## Edge cases verified (proxyClient.test.ts)
- **Fresh grant → 0%** (balance == granted).
- **Subscription + Quest-pack top-up is ADDITIVE** on `available` (the named
  case): sub $16.65 + pack $3.825 = $20.475 granted, $10.475 used → 50%, plan
  stays `unlimited` — a top-up grows the denominator (bar moves left), never a
  reset.
- **Multiple Quest packs** all sum into available.
- **Refund** (negative grant row) shrinks available symmetrically.
- **No grants** → 0% (no divide-by-zero). **Fully depleted** → 100%.
- **Mid-reservation** balance counts the in-flight reservation as used.

## Verification
- `npx vitest run` → **497 passed**. (The 2 "failed" files are the pre-existing
  Deno-baseline edge-function tests that import `jsr:@std/assert` and only run
  under `deno test` — unrelated to this task.)
- `tsc -p tsconfig.web.json` → clean.
- `tsc -p tsconfig.node.json` → only the 2 documented pre-existing baseline
  errors (`loopbackPkce.ts` flowType, `supabaseClient.test.ts` spread) — both
  untouched here.
- **No DB migration** — `usage_pct` is computed in the proxy from the existing
  RLS-scoped `ledger_grants` read.

## Notes
- PROXY-05: the bar surfaces a percent; the only other text is a time estimate.
  No token/dollar counts cross to the renderer for display.
- A session-level auto-commit landed the prior Polar **proxy** work as
  `0f9af60` (proxy/ files only) between commits 1 and 2 — unrelated to this
  task; the three task commits above are clean and atomic.
