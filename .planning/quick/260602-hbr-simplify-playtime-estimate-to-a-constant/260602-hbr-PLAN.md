---
quick_id: 260602-hbr
title: Simplify playtime estimate to a constant tokens/min + usage-% progress bar
status: in-progress
created: 2026-06-02
requirements: [PROXY-05]
---

# Quick Task 260602-hbr

## Goal

Replace the complex per-user rolling-24h playtime estimator with a single
constant `tokens/min` multiplier, and change the **primary** credits usage
display from the "~Xh left" pill to a **usage-percent progress bar**
(used ÷ available, starting at 0%) with a small "~Xh left" estimate beside it
and a tooltip noting it is only an estimate.

## Context / current state

- `proxyClient.creditsGet()` runs a rolling **24h `ledger_consumption`** read
  + a `MIN_SIGNAL_ROWS=20` / `PEAK_CALLS_PER_MIN` / `STARTUP_TOKENS` derivation
  to personalize `tokens_per_min`. Its ONLY consumer is the playtime string —
  so the whole 24h window goes away.
- `ledger_balance` view = `SUM(ledger_grants.credits_micro) − SUM(consumption)`.
  Grants are RLS-readable per-user (`ledger_grants_select_own`). So
  **available = SUM(grants)**, **used = available − balance**, both consistent.
  Topping up (sub + one or more Quest packs) is additive → just grows the
  denominator. Refund grants are negative rows → reduce available symmetrically.
- `PercentBar.tsx` already exists (accessible 0..100 bar) — reuse it.
- PROXY-05 mandates "a friendly % usage indicator — percent only, **no token
  counts**". A usage-% bar is compliant; keep token counts server-side. The
  `~Xh left` string is a time estimate (not a token/dollar), already allowed.
- Primary display lives in `CreditsScreen` USAGE block (`<PlaytimePill lg>`).
  `PlaytimePill` is imported ONLY by CreditsScreen; no `*.test` depends on it.
  `IconRail` computes its tooltip via `tokensRemainingToPlaytime(...)` directly.

## Decisions

- **Constant rate:** `DEFAULT_TOKENS_PER_MIN = 7700` (flat multiplier). At the
  2 µ$/tok blend that is ≈ $0.92/hr of burn — the project's documented marketing
  calibration — yielding ~4 h on a full Quest grant and ~18 h on a full Party
  grant (matches the "~5 hrs / ~20 hrs" copy within the "usage varies" tolerance).
- **Drop `tokens_per_min` end-to-end** (IPC + store + IconRail). The renderer's
  `tokensRemainingToPlaytime(tokens)` falls back to the constant. `remaining_tokens`
  stays (still the playtime numerator). This is the literal "drop the personalized
  estimate" ask.
- **Add `usage_pct` to CreditsStatus** computed server-side (percent only crosses
  the boundary — PROXY-05 clean).
- Compute usage client-side from a `ledger_grants` sum (no DB migration; mirrors
  the existing consumption-sum pattern).

## Tasks

### Task 1 — Backend: usage_pct + drop personalized rate
**Files:** `src/shared/ipc.ts`, `src/main/cloud/proxyClient.ts`
- IPC: add `usage_pct?: number` (0..100, used/available) to `CreditsStatus`;
  remove `tokens_per_min?`; update docstring.
- `creditsGet()`:
  - Remove `since24hIso` + the `ledger_consumption` query from the Promise.all.
  - Add `ledger_grants` read (`select('credits_micro').eq('user_id', …)`);
    sum → `granted` (BigInt).
  - Remove the entire `tokens_per_min` derivation block (MIN_SIGNAL_ROWS,
    PEAK_CALLS_PER_MIN_MAIN, STARTUP_TOKENS_MAIN, SESSIONS_PER_HOUR_MAIN, loop).
  - `used = max(0, granted − balance)`; `usage_pct = granted>0 ?
    clamp(round(Number(used*100n/granted), step), 0, 100) : 0`.
  - Keep `remaining_tokens = balance / 2`. Stop returning `tokens_per_min`.
- **verify:** `npx tsc -p tsconfig.node.json` clean; grep shows no
  `ledger_consumption`/`MIN_SIGNAL_ROWS`/`since24h` left in creditsGet.
- **done:** creditsGet returns `usage_pct`, no 24h read.

### Task 2 — Renderer policy: flat constant
**Files:** `src/renderer/src/lib/playtimeEstimate.ts` (+ `.test.ts`)
- Drop `PEAK_CALLS_PER_MIN`/`STARTUP_TOKENS`/`SESSIONS_PER_HOUR`; set
  `DEFAULT_TOKENS_PER_MIN = 7700` (flat). Rewrite JSDoc.
- Test: delete the derivation-constants describe block + their imports; add a
  test pinning the constant + a representative hours conversion. Keep the
  rounding tests (they pass explicit rates).
- **verify:** `vitest run playtimeEstimate` green.

### Task 3 — Frontend: UsageBar + store + swap
**Files:** `useCreditsStore.ts` (+test), new `UsageBar.tsx`/`.module.css`
(+test), `CreditsScreen.tsx`, `IconRail.tsx`, delete `PlaytimePill.*`
- Store: add `usage_pct` (default 0), drop `tokens_per_min`; update INITIAL +
  push/seed/refresh; tighten Test 11 ALLOWED_TOKEN_KEYS to `{remaining_tokens}`.
- `UsageBar`: `PercentBar(usage_pct)` + `~Xh left` side text +
  `title="This is just an estimate — actual playtime can vary."` tooltip.
- `CreditsScreen`: `<PlaytimePill>` → `<UsageBar size="lg">`.
- `IconRail`: drop `tokens_per_min` selector; call `tokensRemainingToPlaytime(remainingTokens)`.
- Delete `PlaytimePill.tsx` + `.module.css`.
- **verify:** new UsageBar test green; tsc web clean.

### Task 4 — Verify (edge cases + full suite)
- proxyClient.test: replace the deleted "new model" block; add usage_pct tests
  incl. **subscription + 2 grants (sub+pack) topup** → additive denominator.
- Run root vitest + renderer vitest + `tsc` (web + node). All green.

## must_haves
- truths:
  - "usage_pct = used/available, 0% on a fresh grant, additive across sub+packs"
  - "playtime uses one flat constant (7700 tok/min), no 24h window"
- artifacts:
  - "src/renderer/src/components/UsageBar.tsx renders PercentBar + ~Xh left + tooltip"
  - "CreditsScreen primary display is UsageBar, not PlaytimePill"
- key_links:
  - "src/main/cloud/proxyClient.ts creditsGet returns usage_pct"
  - "src/shared/ipc.ts CreditsStatus has usage_pct, no tokens_per_min"
