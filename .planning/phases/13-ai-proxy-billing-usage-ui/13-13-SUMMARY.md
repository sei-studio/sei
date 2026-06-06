---
phase: 13-ai-proxy-billing-usage-ui
plan: 13
subsystem: main-proxy-client
tags: [main, proxy-client, edge-function-wrapper, shell-openexternal, lemon-squeezy, sentinel, bigint, ipc-wiring]

# Dependency graph
requires:
  - phase: 10-auth-foundation
    provides: callEdgeFunction(name, { jwt, body }) wrapper with 15s timeout + AbortController; getClient() singleton SupabaseClient
  - phase: 13-ai-proxy-billing-usage-ui
    provides: 13-02 stub-contract surface — TrialClaimArgsSchema, CreditsCheckoutArgsSchema, CreditsStatus, SubscriptionStatusInfo, IpcChannel.{trial,credits,subscription}, apiKeyStore.getAiBackendKind
provides:
  - src/main/cloud/proxyClient.ts — 5 typed methods (trialClaim, creditsGet, openCheckout, subscriptionStatus, cancelSubscription) used by main/ipc.ts
  - src/main/cloud/proxyErrors.ts — 8 PROXY_* sentinel codes + ProxyErrorCode union
  - 5 wired IPC handlers in src/main/ipc.ts (trial.claim, credits.get, credits.openCheckout, subscription.status, subscription.cancel)
  - BigInt micro-dollar math with 5% step rounding (D-41 mirror on cold-load path)
  - Lemon Squeezy checkout URL composer with custom user_id field (D-45)
  - Customer-portal launch path (open-question resolution #5)
affects: [13-17-credits-screen, 13-18-hard-stop-modal, 13-19-pricing-icon, 13-20-settings-row, 13-21-openExternal-allowlist]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "PROXY_* sentinel vocabulary — mirrors CLOUD_* (Plan 11) prefix-routing convention so renderer ERROR_COPY maps stay a single switch"
    - "Promise.all fan-out over four independent reads (ledger_balance, subscription_status, trial_claims, apiKeyStore) — cold-load latency = max(query), not sum(query)"
    - "BigInt micro-dollar math — balance × 100n / cap then Number() the bounded [0,100] result; no float drift on user balances"
    - "IPC handler PROXY_* → RendererApi-code translation at the trust boundary — proxyClient stays sentinel-pure, the contract translation happens once in ipc.ts so renderer sees lowercase 'already_claimed' | 'no_session' | 'network'"

key-files:
  created:
    - src/main/cloud/proxyClient.ts
    - src/main/cloud/proxyErrors.ts
    - src/main/cloud/proxyClient.test.ts
  modified:
    - src/main/ipc.ts

key-decisions:
  - "13-13: Adapted callEdgeFunction call shape — plan pseudocode used `callEdgeFunction('trial-claim', session.jwt, body)` returning `{ data }` but the real Phase 10 signature is `callEdgeFunction(name, { jwt, body, timeoutMs? })` returning `{ ok, status, json }`. Used the real signature; behavior is identical (15s timeout + AbortController + non-throwing union)."
  - "13-13: PROXY_* → RendererApi code translation lives in src/main/ipc.ts (not proxyClient), so the proxyClient surface stays a pure typed-wrapper. The renderer contract (RendererApi.trialClaim returns code: 'already_claimed' | 'no_session' | 'network') is preserved verbatim from 13-02; we just plug in real branches."
  - "13-13: Variant IDs read via process.env.LEMON_VARIANT_* at call time (not at module load), so test harnesses can set process.env before importing — same convention vitest uses for Phase 10 supabase env-vars."
  - "13-13: cancelSubscription returns `{ ok: true, portalUrl: 'https://sei.lemonsqueezy.com/billing' }` — hardcoded URL because LS routes the user to their account view from the session cookie set during checkout. No server-side cancel endpoint (open-question resolution #5)."
  - "13-13: BigInt(balanceRow.data?.balance_micro ?? 0) — handles both number and string forms because supabase-js returns Postgres bigint as a string when the value would overflow JS Number, but as a number when it fits. BigInt(number|string) handles both; the unit test asserts the string branch."
  - "13-13: subscription_status.renews_at / ends_at coalesced to null via `?? null` — defensive even though the supabase row already has those as nullable; the renderer types declare them `string | null` not `string | undefined`."

patterns-established:
  - "proxyClient module pattern — mirrors cloudCharacterClient but with smaller surface (5 fns) + sentinel-coded error returns rather than thrown errors (Wave 3 renderer plans never have to try/catch around IPC)"
  - "PROXY_* sentinel translation at IPC boundary — proxyClient returns sentinel codes; ipc.ts maps to RendererApi-contract codes once. Keeps the proxyClient surface stable across future renderer contract churn"
  - "Variant ID read at call time (not module load) for testability"

requirements-completed: [PROXY-01, PROXY-02, PROXY-09]

# Metrics
duration: 4min
completed: 2026-05-22
---

# Phase 13 Plan 13: Main-process proxy client + IPC wiring Summary

**Five typed methods (trialClaim, creditsGet, openCheckout, subscriptionStatus, cancelSubscription) wrapped over the trial-claim Edge Function + supabase-js ledger reads + shell.openExternal Lemon Squeezy launches, with 8-sentinel PROXY_* error vocabulary; replaces the 5 Plan 13-02 IPC stubs with lazy-imported proxyClient calls.**

## Performance

- **Duration:** 4 min
- **Started:** 2026-05-22T21:49:20Z
- **Completed:** 2026-05-22T21:53:33Z
- **Tasks:** 3
- **Files created:** 3
- **Files modified:** 1

## Accomplishments

- Created `src/main/cloud/proxyErrors.ts` with 8 sentinel codes (`PROXY_TIMEOUT`, `PROXY_PAYMENT_REQUIRED`, `PROXY_RATE_LIMITED`, `PROXY_SERVICE_AT_CAPACITY`, `PROXY_INVALID_JWT`, `PROXY_ALREADY_CLAIMED`, `PROXY_NO_SESSION`, `PROXY_NETWORK`) + `ProxyErrorCode` discriminated union.
- Created `src/main/cloud/proxyClient.ts` with 5 typed methods, all returning sentinel-coded `{ ok, code }` unions (never throwing) so the renderer never has to try/catch around IPC.
  - `trialClaim(mc_username)` — calls the `trial-claim` Edge Function via `callEdgeFunction` (15s timeout + AbortController inherited from Phase 10), translates 409 / 2xx-with-`code:'already_claimed'` into `PROXY_ALREADY_CLAIMED`.
  - `creditsGet()` — `Promise.all` over four independent reads: `ledger_balance.balance_micro` (RLS-scoped), `subscription_status.status/renews_at/ends_at`, `trial_claims.mc_username`, `apiKeyStore.getAiBackendKind()`. Computes `remaining_pct` via BigInt math `(balance × 100n) / cap` clamped to [0,100] and rounded to 5% steps (D-41 mirror). Plan label derives from subscriber → unlimited / balance=0 → depleted / trial_claims row → trial / else → pack.
  - `openCheckout(kind)` — composes `https://sei.lemonsqueezy.com/buy/<variant>?checkout[custom][user_id]=<sub>` with variant ID from `process.env.LEMON_VARIANT_PACK` or `LEMON_VARIANT_SUBSCRIPTION` (electron-vite-injected at build, test-injectable at runtime).
  - `subscriptionStatus()` — single supabase-js read of `subscription_status` (RLS-scoped); returns `{ active, status, renews_at, ends_at }` with `none` placeholder for no-row.
  - `cancelSubscription()` — opens hardcoded `https://sei.lemonsqueezy.com/billing` customer portal via `shell.openExternal`; returns `{ ok, portalUrl }` so the renderer can show a "Opened in your browser" toast.
- Created `src/main/cloud/proxyClient.test.ts` — 16 hermetic unit tests across all 5 methods. Mocks `electron.shell.openExternal`, `edgeFunctionClient.callEdgeFunction`, `supabaseClient.getClient` (hand-rolled `.from().select().eq().maybeSingle()` mock chain), and `apiKeyStore.getAiBackendKind`. Covers no-session short-circuits, happy paths, 409 / `code:already_claimed` branches, BigInt-as-string parse, subscriber/depleted/trial label derivation, variant ID dispatch on `kind`, and customer-portal URL.
- Replaced the 5 Plan 13-02 IPC stubs in `src/main/ipc.ts` with lazy imports of `./cloud/proxyClient`:
  - `trial.claim` → `trialClaim(parsed.mc_username)` with `PROXY_*` → RendererApi-contract code translation (`PROXY_ALREADY_CLAIMED → 'already_claimed'`, `PROXY_NO_SESSION → 'no_session'`, else → `'network'`).
  - `credits.get` → `creditsGet()` directly (replaces the placeholder `{remaining_pct:100, plan:'trial'}` literal).
  - `credits.openCheckout` → `openCheckout(parsed.kind)` (still validates kind via `CreditsCheckoutArgsSchema` before lazy import).
  - `subscription.status` → `subscriptionStatus()`.
  - `subscription.cancel` → `cancelSubscription()`.
- `proxy.configure` handler stays unchanged — it was the only Plan 13-02 channel wired to real state (flips `aiBackendKind` via `setAiBackendKind`), and that wiring already covers the Wave 3 needs.

## Task Commits

1. **Task 1: proxyErrors.ts + proxyClient.ts** — `b5c90b6` (feat)
2. **Task 2: proxyClient.test.ts (16 tests)** — `61a67ae` (test)
3. **Task 3: Wire 5 IPC handlers through proxyClient** — `c80cb25` (feat)

## Files Created/Modified

- `src/main/cloud/proxyErrors.ts` (created) — 8 PROXY_* sentinel constants + ProxyErrorCode union; mirrors the CLOUD_* (Phase 11) prefix-routing convention.
- `src/main/cloud/proxyClient.ts` (created) — 5 typed methods + 3 internal helpers (`buildCheckoutUrl`, `getSessionOrNull`, `roundToStep`); uses `callEdgeFunction` from Phase 10 + `getClient` singleton + `shell.openExternal`; never throws.
- `src/main/cloud/proxyClient.test.ts` (created) — vitest suite with 16 passing tests; mocks `electron`, `edgeFunctionClient`, `supabaseClient`, `apiKeyStore`.
- `src/main/ipc.ts` (modified) — replaced 5 stub return literals with lazy `await import('./cloud/proxyClient')` calls; added 7-line PROXY_* → RendererApi-code translation in the `trial.claim` handler so the proxyClient surface stays sentinel-pure.

## Decisions Made

- **`callEdgeFunction` signature mismatch (Rule 3 — Blocking):** Plan pseudocode wrote `callEdgeFunction('trial-claim', session.jwt, body)` expecting a `{ data }` return. The real Phase 10 signature (per `src/main/auth/edgeFunctionClient.ts:30-81`) is `callEdgeFunction(name, { jwt, body, method?, timeoutMs? })` returning `{ ok, status, json }`. Adapted call site verbatim; behavior is identical because the wrapper handles 15s timeout + AbortController + non-throwing union all the same way. Documented in `proxyClient.ts` JSDoc.
- **PROXY_* → RendererApi-contract code translation lives in `ipc.ts`, not proxyClient:** `RendererApi.trialClaim` returns `code: 'already_claimed' | 'no_session' | 'network'` (lowercase). proxyClient returns the PROXY_* sentinels. Translation could live at either end. Chose the IPC boundary so proxyClient stays a pure typed-wrapper with one stable error vocabulary, and the contract translation happens at the trust boundary in `ipc.ts` (7 lines). Trade-off: a future renderer plan that wants to consume the sentinel directly would need to widen the RendererApi union — accepted because the renderer ERROR_COPY map already keys on the lowercase form (consistent with the Phase 12 `code: string` precedent).
- **Variant IDs read at call time, not module load:** `process.env.LEMON_VARIANT_PACK` / `LEMON_VARIANT_SUBSCRIPTION` are read inside `buildCheckoutUrl` rather than at module top. Lets tests set env-vars before importing the module; production gets the values from the electron-vite define block at build time. Same convention vitest already uses for Phase 10 Supabase env-vars.
- **BigInt(number | string) for `balance_micro`:** supabase-js returns Postgres `bigint` as a JS `number` when the value fits in safe-integer range (< 2^53) but as a string when it would overflow. `BigInt()` accepts both. Added a unit test (`'handles bigint balances expressed as a string from supabase-js'`) to lock this behavior.
- **Customer-portal URL hardcoded:** `cancelSubscription` opens `https://sei.lemonsqueezy.com/billing` directly. The plan considered minting a one-time portal URL via the LS API but open-question resolution #5 settled on the always-on portal URL — LS routes the user to their account view from the session cookie set during checkout. Returns `{ ok, portalUrl }` so the renderer toast can show the URL if the browser opened in a background tab.
- **Subscription label derivation order matters:** `isSubscriber ? 'unlimited' : balance === 0n ? 'depleted' : trialRow.data ? 'trial' : 'pack'` — subscriber wins over depleted. A subscriber whose monthly grant hasn't landed yet (e.g., LS webhook delay) still sees 'unlimited' rather than depleted. Acceptable trade-off; the grant lands within seconds of payment.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking] `callEdgeFunction` call signature mismatch**
- **Found during:** Task 1 implementation
- **Issue:** Plan code wrote `callEdgeFunction('trial-claim', session.jwt, { mc_username: mcUsername })` and read `res.data`. The actual Phase 10 signature (`src/main/auth/edgeFunctionClient.ts:30-81`) is `callEdgeFunction(name, { jwt, body, method?, timeoutMs? })` returning `{ ok, status, json }` — not `{ ok, data }`.
- **Fix:** Adapted to the real signature: `callEdgeFunction('trial-claim', { jwt: session.jwt, body: { mc_username: mcUsername } })` and read `res.json`. Functionally identical — same 15s timeout, same AbortController, same non-throwing union.
- **Files modified:** `src/main/cloud/proxyClient.ts`
- **Verification:** Tests assert the exact call shape — `expect(callEdgeFunction).toHaveBeenCalledWith('trial-claim', { jwt: 'jwt-xyz', body: { mc_username: 'SeiPlayer1' } })`.
- **Committed in:** `b5c90b6` (Task 1 commit)

**2. [Rule 1 — Bug] RendererApi.trialClaim code type narrower than PROXY_* sentinels**
- **Found during:** Task 3 implementation
- **Issue:** `proxyClient.trialClaim` returns `{ ok: false, code: ProxyErrorCode }` where `ProxyErrorCode` is the PROXY_* union. The `RendererApi.trialClaim` contract (declared in `src/shared/ipc.ts:623-628`) types `code: 'already_claimed' | 'no_session' | 'network'`. Direct return would fail tsc.
- **Fix:** Added a 7-line `PROXY_* → RendererApi` translation in the `trial.claim` IPC handler. proxyClient surface stays sentinel-pure; the contract translation is a single switch at the trust boundary.
- **Files modified:** `src/main/ipc.ts`
- **Verification:** `npx tsc --noEmit -p tsconfig.node.json` clean (only pre-existing `loopbackPkce.ts` + `supabaseClient.test.ts` errors remain, both noted in 12-08-SUMMARY).
- **Committed in:** `c80cb25` (Task 3 commit)

---

**Total deviations:** 2 auto-fixed (1 signature adaptation, 1 contract translation).
**Impact on plan:** None on behavior or surface. Deviation #1 reflects the plan pseudocode being out of sync with Phase 10's real `callEdgeFunction` shape — caught by tsc; behavior is identical. Deviation #2 is a 7-line translation at the IPC boundary that keeps proxyClient surface clean.

## Issues Encountered

- Pre-existing main-side type errors in `src/main/auth/loopbackPkce.ts:83` (`flowType` not in `SignInWithOAuthOptions`) and `src/main/auth/supabaseClient.test.ts:19` (spread-arg shape mismatch). Both noted in 13-02-SUMMARY and 12-08-SUMMARY as pre-existing — out of scope per SCOPE BOUNDARY, unchanged by this plan.
- Several untracked / modified files appeared during execution from parallel agents on other Phase 13 plans (`src/bot/brain/orchestrator.js`, `src/bot/config.js`, `src/main/auth/proxyJwtFetcher.ts`, `supabase/functions/lemon-webhook/deno.lock`, `.mcp.json`). Not touched by this plan.

## Threat Surface Scan

No new threat surface beyond what the plan's `<threat_model>` declares. All six declared mitigations honoured:

- **T-13-13-01 (Spoofing, kind='pack' as URL-launch vector):** `CreditsCheckoutArgsSchema = z.enum(['pack','subscription'])` parses at the IPC boundary before `proxyClient.openCheckout` is invoked; variant lookup is a literal `process.env.LEMON_VARIANT_PACK | LEMON_VARIANT_SUBSCRIPTION` switch; URL host is hardcoded `sei.lemonsqueezy.com`.
- **T-13-13-02 (Tampering, LEMON_VARIANT_* env):** Variant IDs come from `process.env` which electron-vite injects via the build-time define block. Runtime tampering would require process write access, in which case Sei is already compromised.
- **T-13-13-03 (Information Disclosure, JWT leakage):** proxyClient passes the JWT only to `callEdgeFunction` (which handles it the same way Phase 10 / 11 / 12 do — Authorization header, never logged). No `console.log` of session data in proxyClient.
- **T-13-13-04 (DoS, hostile mc_username):** Accepted — proxyClient has no retry loop; Edge Function (13-12) handles idempotency.
- **T-13-13-05 (Spoofing, phishing via openExternal):** URL fully composed in main-process module from hardcoded host + env-var variant + Supabase-authenticated user_id; renderer can only supply the `kind` enum. Plan 13-21 will add an allowlist gate.
- **T-13-13-06 (Tampering, RLS-readable balance):** RLS scopes `ledger_balance`, `subscription_status`, and `trial_claims` to `user_id = auth.uid()`. supabase-js cannot read other users' rows even if asked.

## User Setup Required

None at runtime — `LEMON_VARIANT_PACK` / `LEMON_VARIANT_SUBSCRIPTION` will be set in the electron-vite `.env` file by the deployment plan (out of scope for 13-13; expected to land alongside the Wave 4 / launch-ops plans).

## Next Phase Readiness

- All Wave 3 renderer plans (13-17 CreditsScreen, 13-18 HardStopModal, 13-19 PricingIcon, 13-20 Settings row) can now call `window.sei.creditsGet()` / `creditsOpenCheckout(kind)` / `subscriptionStatus()` / `subscriptionCancel()` / `trialClaim(mc_username)` and receive real proxyClient-backed responses. The renderer JSDoc-typed return shapes are unchanged from 13-02.
- Plan 13-21 (openExternal allowlist) should add `sei.lemonsqueezy.com` to the allowlist so the checkout + customer-portal launches survive the gate.
- Wave 2 plan 13-12 (trial-claim Edge Function) is the upstream contract proxyClient.trialClaim already depends on — must return either `{ ok: true, credits_micro: number }`, `{ ok: false, code: 'already_claimed' }`, or 409 status.
- The Wave 2 ledger plans (13-09 ledger schema, 13-10 ledger_balance view) define the `ledger_balance.balance_micro` column that `creditsGet` reads via supabase-js; views must be RLS-scoped to `user_id = auth.uid()`.

## Self-Check: PASSED

- File `src/main/cloud/proxyErrors.ts` FOUND (created)
- File `src/main/cloud/proxyClient.ts` FOUND (created)
- File `src/main/cloud/proxyClient.test.ts` FOUND (created)
- File `src/main/ipc.ts` FOUND (modified)
- Commit `b5c90b6` FOUND (Task 1 — proxyErrors.ts + proxyClient.ts)
- Commit `61a67ae` FOUND (Task 2 — proxyClient.test.ts 16 tests)
- Commit `c80cb25` FOUND (Task 3 — IPC wiring)
- `grep -c "shell.openExternal" src/main/cloud/proxyClient.ts` = 4 (≥2 ✓)
- `grep -c "callEdgeFunction('trial-claim'" src/main/cloud/proxyClient.ts` = 1 (=1 ✓)
- `grep -c "await import('./cloud/proxyClient" src/main/ipc.ts` = 5 (≥4 ✓)
- `npx vitest run src/main/cloud/proxyClient.test.ts` → 16 passed (≥8 ✓)
- `npx tsc --noEmit -p tsconfig.node.json` clean (only pre-existing loopbackPkce + supabaseClient.test errors)

---
*Phase: 13-ai-proxy-billing-usage-ui*
*Completed: 2026-05-22*
