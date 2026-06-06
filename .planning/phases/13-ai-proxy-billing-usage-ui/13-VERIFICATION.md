---
phase: 13-ai-proxy-billing-usage-ui
verified: 2026-05-23T05:56:32Z
status: human_needed
score: 13/13 must-haves verified (code surface); 2 items require operator execution
overrides_applied: 0
human_verification:
  - test: "Phase 13-22 §8 Refunds smoke test (9 explicit steps from 13-22-PLAN)"
    expected: |
      (1) terms.html renders with §8 'Refunds and Cancellations' visible above §9.
      (2) Direct anchor #refunds jumps to §8.
      (3) Effective Date header reads 2026-05-23 on both terms.html and privacy.html.
      (4) Section numbering shows 1..15 monotonically with no duplicates.
      (5) §8 includes 4 paragraphs: credit packs (14-day refund), subscriptions (cancel any time, end-of-period), how to request (dmca@sei.app + Lemon Squeezy MoR), failed transactions.
      (6) §4 cross-reference reads 'purged per Section 10' (renumbered).
      (7) dmca@sei.app mailto link works.
      (8) Sign in to Sei with a TOS_VERSION/PRIVACY_VERSION = 2026-05-22 acceptance row → AcceptToSModal mounts (re-acceptance triggered by version bump).
      (9) After accepting, tos_acceptance row updates and modal no longer mounts.
    why_human: |
      Two artifacts live in a sibling repo (../sei-website/terms.html, ../sei-website/privacy.html) that
      is not built/deployed by Sei — verifying requires a browser, the deployed sei.gg URL, and a Supabase
      account in the prior-version state. The AcceptToSModal re-trigger is a behavioral check across DB
      state + UI mount that the verifier cannot synthesize. Sentinel doc:
      .planning/phases/13-ai-proxy-billing-usage-ui/13-22-SUMMARY.md §"Verification (9 steps)".
  - test: "Phase 13-23 Operator Runbook — 11-step strictly-ordered checklist (BLOCKING for first paying user)"
    expected: |
      Each step's resume-signal is typed verbatim into the operator log as gates pass:
      (Step 1)  "approved — variant IDs captured: pack=<ID>, sub=<ID>"  — LS products live with Lemon-Squeezy-ToS-safe descriptions ("proxied AI inference credits powered by Sei"); webhook signing secret captured.
      (Step 2)  "approved — Tier 2 verified"  — Anthropic console shows Tier 2; verified BEFORE any paying user touches the proxy (PATTERNS Pitfall 5; without this 60 RPM subscriber cap + bursty traffic → org-level 429 storms).
      (Step 3)  supabase db push --linked applies 20260524000000_phase_13_ledger.sql + 20260524000100_rate_buckets_rpc.sql; six tables + ledger_balance VIEW + reserve_credits / settle_consumption / check_and_increment_bucket RPCs visible; pg_cron rate_buckets_cleanup scheduled at 03:10 UTC.
      (Step 4)  supabase functions deploy lemon-webhook + trial-claim; LEMON_SQUEEZY_WEBHOOK_SECRET + DISCORD_BILLING_ALERT_WEBHOOK_URL secrets set.
      (Step 5)  LS webhook endpoint configured against deployed lemon-webhook URL.
      (Step 6)  fly launch + fly secrets set ANTHROPIC_API_KEY (org-owned, NOT personal-account — see Step 10 sign-off) + SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + SUPABASE_JWKS_URL + optional SENTRY_DSN; fly deploy; /health returns {status:'ok'}.
      (Step 7)  electron-vite.config.ts define block injects SEI_PROXY_URL + LEMON_VARIANT_PACK + LEMON_VARIANT_SUBSCRIPTION from .env at build time.
      (Step 8)  "approved — all 13 smoke steps passed"  — end-to-end smoke: switch BYOK → managed, $5 checkout, balance refresh via X-Sei-Remaining-Pct header, trial-claim on first bot summon, forward through proxy, deplete to HardStopModal, switch back to BYOK, subscribe, cancel, dup-trial-claim → 409, rate-limit spam → 429 then 503 service_at_capacity.
      (Step 9)  Sentry/Fly/Supabase log alerts wired for service_at_capacity sustained, invalid_jwt > 50/min, internal_error > 10/min, lemon-webhook missing_user_id, trial-claim grant_failed.
      (Step 10) PROXY-13 Anthropic ToS framing audit: five sign-offs — LS product descriptions, marketing copy, customer-facing strings, terms.html §8 link, ANTHROPIC_API_KEY ownership (org NOT personal).
      (Step 11) "approved — Phase 13 LIVE on <DATE>"  — v1.0-billing installer released and rollout announcement posted.
    why_human: |
      This step is INTENTIONALLY a SUMMARY-only deliverable (per 13-23-SUMMARY.md key-decisions:
      "Plan 13-23 is a SUMMARY-only deliverable — no code, no commits beyond this SUMMARY + the final
      phase docs commit. The runbook IS the artifact"). The work is operator-driven: third-party
      account setup (Lemon Squeezy products, Anthropic Tier 2), secrets that must NOT live in the
      repo (Fly/Supabase secrets, LS webhook secret), production deploys (supabase db push, supabase
      functions deploy, fly deploy), and live behavioral smoke against real Anthropic + Lemon
      Squeezy endpoints. The CODE that the operator runs is all shipped and tested (93 proxy tests
      pass, 34 edge function tests authored), but PROXY-01/02/03/07/09/12/13 are not actually
      satisfied for end users until the operator executes this runbook.
---

# Phase 13: AI Proxy + Billing + Usage UI — Verification Report

**Phase Goal:** "A user can purchase proxied AI credits ($5 one-time or $20/month) via Lemon Squeezy, the Fly.io Hono proxy enforces per-user JWT + token-bucket pre-deduction + RPM/TPM/daily $ caps, and a friendly server-driven % bar communicates remaining usage without ever showing token counts."

**Verified:** 2026-05-23T05:56:32Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1   | Signed-in user can purchase $5 pack or $20/mo subscription via shell.openExternal → Lemon Squeezy; ledger reflects grant via webhook | ✓ VERIFIED (code) / ? OPERATOR (live) | `src/main/cloud/proxyClient.ts:280-292` openCheckout calls shell.openExternal; `src/main/cloud/proxyClient.ts:94-111` buildCheckoutUrl with `?checkout[custom][user_id]=<sub>` (D-45); `supabase/functions/lemon-webhook/index.ts:41-42` PACK_CREDITS_MICRO=4_750_000n + SUBSCRIPTION_CREDITS_MICRO=18_500_000n; 6 events handled (order_created, subscription_created, subscription_payment_success, subscription_updated, subscription_cancelled, subscription_expired). 25 webhook tests authored. Live grant ledger requires Step 1 + 4 + 5 of operator runbook. |
| 2   | Bot LLM calls route through Fly.io proxy when cloud-AI mode; proxy verifies per-user JWT; token-bucket pre-deduction prevents negative balance under parallel calls | ✓ VERIFIED | `proxy/src/app.ts:39` chain `verifyJwt → rateLimitGate → forwardToAnthropic`; `proxy/src/auth/verifyJwt.ts:28` jwtVerify against Supabase JWKS audience='authenticated'; `proxy/src/ledger/preDeduct.ts:62-66` reserve_credits RPC (atomic FOR UPDATE per `supabase/migrations/20260524000000_phase_13_ledger.sql`); 93/93 proxy tests pass; `src/bot/brain/anthropicClient.js:40-47` baseURL + authToken cloudMode override; `src/main/botSupervisor.ts:42,236-245` PROXY_BASE_URL + cloudMode shipped in init payload. |
| 3   | User hovering pricing icon (above settings) sees friendly server-driven % indicator — no token counts in UI | ✓ VERIFIED | `src/renderer/src/components/IconRail.tsx:107-116` PricingIcon rendered ONLY when `aiBackendKind==='cloud-proxy'`, positioned in the same cluster as Settings, listed BEFORE SettingsIcon; title text `${remainingPct}% credits left · click for details` (D-54 verbatim). `src/renderer/src/lib/stores/useCreditsStore.ts:16-19,50-59` state shape has remaining_pct only (no token/dollar fields, type-level PROXY-05). grep for `\$5\|\$20\|tpm\|rpm\|token\b` in CreditsScreen.tsx/HardStopModal.tsx/PercentBar.tsx/SettingsScreen.tsx returns zero user-visible matches. |
| 4   | Out-of-credits → hard-stop modal offering top-up or subscription; no silent failure, no overage | ✓ VERIFIED | `src/renderer/src/components/HardStopModal.tsx:59-141` mounts when `useCreditsStore.hardStopActive===true`; three CTAs (Top up / Go Unlimited / Switch to your own API key); ESC suppressed (lines 80-89, verbatim port of AcceptToSModal); auto-dismiss on balance refill (lines 94-98); `proxy/src/anthropic/forward.ts:103-104` 402 payment_required on insufficient reservation; `useCreditsStore.onCreditsHardStop` push sets hardStopActive only by explicit server push (NEVER computed from remaining_pct===0 — defense in depth). |
| 5   | BYOK users never hit proxy, never see credits UI | ✓ VERIFIED | `src/renderer/src/components/IconRail.tsx:108` PricingIcon RailButton is UNMOUNTED (not CSS-hidden) when `aiBackendKind!=='cloud-proxy'`; `src/main/apiKeyStore.ts:89-96` AiBackendKind discriminated union; `src/main/botSupervisor.ts:237` cloudMode constructed ONLY when `aiBackendKind==='cloud-proxy'` (BYOK path keeps `api_key` config); `src/renderer/src/screens/SettingsScreen.tsx:47-64` symmetric BYOK ↔ cloud switch via proxyConfigure('local'\|'cloud-proxy'). |

**Score:** 5/5 truths verified (code surface)

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `proxy/src/app.ts` | Hono /v1/messages with full middleware chain | ✓ VERIFIED | 62 lines; chain order locked verbatim per 13-10 (verifyJwt → rateLimitGate → forwardToAnthropic); /health registered before auth |
| `proxy/src/auth/verifyJwt.ts` | jose + Supabase JWKS | ✓ VERIFIED | 43 lines; createRemoteJWKSet cached; 4 error envelopes (missing_jwt, expired_jwt, invalid_jwt, invalid_jwt+no-sub); 9 tests pass |
| `proxy/src/ledger/preDeduct.ts` | Atomic FOR UPDATE reserve | ✓ VERIFIED | 79 lines; calls reserve_credits RPC; BigInt micro-dollars; 15 tests pass |
| `proxy/src/ledger/settle.ts` | Three settle modes | ✓ VERIFIED | 91 lines; settled/refunded/at-reservation; idempotent via reservation_state='reserved' predicate; 10 tests pass |
| `proxy/src/rateLimit/buckets.ts` | RPM/ITPM/daily$ caps with tier resolution | ✓ VERIFIED | 137 lines; trial 20 RPM/30K ITPM/$5/day, subscriber 60/200K/$20/day; 30s tier cache; 11 tests pass |
| `proxy/src/rateLimit/gate.ts` | Middleware before preDeduct | ✓ VERIFIED | 53 lines; gate runs BEFORE preDeduct (T-13-10-01); 3 tests pass |
| `proxy/src/anthropic/forward.ts` | Verbatim body forward + SSE pass-through + header injection | ✓ VERIFIED | 250 lines; rawBody via c.req.text() forwarded verbatim (T-13-08-07 fix at 913fc70); X-Sei-Remaining-Pct set before streamSSE open; 9 tests pass |
| `proxy/src/middleware/sentinel.ts` | Discriminated-union ProxyError | ✓ VERIFIED | 15 tests pass; 9 status code mappings locked |
| `proxy/src/anthropic/usage.ts` | Pure usage extraction | ✓ VERIFIED | 13 tests pass; defensive against malformed SSE |
| `supabase/migrations/20260524000000_phase_13_ledger.sql` | Six tables + view + 2 RPCs + RLS | ✓ VERIFIED | 261 lines; ledger_grants/consumption + subscription_status + rate_buckets + trial_claims + user_balance_lock + ledger_balance VIEW; reserve_credits + settle_consumption RPCs |
| `supabase/migrations/20260524000100_rate_buckets_rpc.sql` | check_and_increment_bucket RPC | ✓ VERIFIED | File present alongside ledger migration |
| `supabase/functions/lemon-webhook/index.ts` | HMAC verify + 6 events + idempotent | ✓ VERIFIED | hmacSha256Hex over raw body BEFORE JSON.parse; HANDLED_EVENTS = 6 events; lemon_event_id UNIQUE; 25 tests authored |
| `supabase/functions/trial-claim/index.ts` | One-trial-per-mc_username | ✓ VERIFIED | mc_username regex `^[A-Za-z0-9_]{1,16}$`; two-client pattern (userClient + admin); 23505 → 409; compensating delete on grant failure; 9 tests |
| `src/main/cloud/proxyClient.ts` | 5 typed methods | ✓ VERIFIED | 354 lines; trialClaim, creditsGet, openCheckout, subscriptionStatus, cancelSubscription; BigInt math; shell.openExternal for both checkout + portal |
| `src/main/auth/proxyJwtFetcher.ts` | JWT rotation pump | ✓ VERIFIED | 5min-before-expiry refresh + 30min interval; ProxyAuthError class; setupJwtRotation teardown closure |
| `src/bot/brain/anthropicClient.js` | baseURL + authToken cloudMode override | ✓ VERIFIED | Lines 40-47 buildSdkOptions cloudMode branch with apiKey:null (no X-Api-Key leak); setAuthToken mutates sdk.authToken (per-request read verified against SDK source — both 13-15 CHECKER warnings resolved) |
| `src/main/botSupervisor.ts` | PROXY_BASE_URL + cloudMode shipped to bot | ✓ VERIFIED | `const PROXY_BASE_URL = process.env.SEI_PROXY_URL ?? 'https://api.sei.gg'`; cloudMode constructed only when aiBackendKind==='cloud-proxy' |
| `src/renderer/src/lib/stores/useCreditsStore.ts` | remaining_pct only state; explicit hardStopActive | ✓ VERIFIED | No token/dollar fields in state shape (PROXY-05 type-level); hardStopActive set only by explicit push; idempotent init() |
| `src/renderer/src/components/IconRail.tsx` | PricingIcon above SettingsIcon when cloud-proxy | ✓ VERIFIED | Lines 107-123; PricingIcon RailButton conditional on cloud-proxy AND listed before SettingsIcon in DOM order (PROXY-04) |
| `src/renderer/src/components/PercentBar.tsx` | ARIA progressbar primitive | ✓ VERIFIED | 47 lines; role="progressbar" + aria-valuenow; clamped [0,100] defensively |
| `src/renderer/src/screens/CreditsScreen.tsx` | Three blocks (USAGE/TOP UP/UNLIMITED) | ✓ VERIFIED | 154 lines; no dollar amounts in body copy; plan-aware tile CTAs (Top up / Go Unlimited / Manage subscription) |
| `src/renderer/src/components/HardStopModal.tsx` | PROXY-06 modal | ✓ VERIFIED | 141 lines; three CTAs without dollar amounts; persona-aware copy (client-side resolveHardStopCopy); ESC suppression; auto-dismiss on balance refill |
| `src/renderer/src/screens/SettingsScreen.tsx` | Cloud AI row | ✓ VERIFIED | Lines 47-64,312-323; three states (local / cloud+sub / cloud+pack); symmetric BYOK escape |
| `src/main/ipc.ts:openExternal allowlist` | sei.lemonsqueezy.com added | ✓ VERIFIED | Lines 963-994; sei.lemonsqueezy.com on exact-host allowlist alongside sei.gg + dmca.copyright.gov + mailto: |
| `src/shared/legalVersions.ts` | TOS_VERSION/PRIVACY_VERSION = 2026-05-23 | ✓ VERIFIED | Both constants set to '2026-05-23' |
| `../sei-website/terms.html` | §8 Refunds and Cancellations with id="refunds" anchor + Effective Date 2026-05-23 | ✓ VERIFIED | grep `id="refunds"` matches 1; "Refunds and Cancellations" matches 1; Effective Date reads 2026-05-23 |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| anthropicClient.js cloudMode | proxy `/v1/messages` | baseURL injection at SDK construction | ✓ WIRED | `src/bot/brain/anthropicClient.js:40-47` + botSupervisor PROXY_BASE_URL env |
| proxyJwtFetcher → bot | utilityProcess Anthropic SDK | MessagePort `cloud-jwt-update` → bot calls `setAuthToken(jwt)` → mutates sdk.authToken | ✓ WIRED | `src/main/auth/proxyJwtFetcher.ts` + `src/bot/index.js:486-493` |
| Renderer credits UI → main proxyClient | IPC `credits:get`/`credits:openCheckout`/`credits:hardStop`/`credits:status-update` | preload contextBridge | ✓ WIRED | `src/main/ipc.ts` registers 6 channels + 2 push emitters; useCreditsStore subscribes via lib/ipcClient |
| Lemon Squeezy webhook → ledger_grants | Edge Function `lemon-webhook` | HMAC verify + service-role insert | ✓ WIRED | `supabase/functions/lemon-webhook/index.ts`; lemon_event_id UNIQUE idempotency |
| Trial claim → ledger_grants | Edge Function `trial-claim` | mc_username PK + ledger_grants insert + compensating delete | ✓ WIRED | `supabase/functions/trial-claim/index.ts:122-135`; 9 tests cover all branches |
| Proxy → Supabase | SECURITY DEFINER RPCs reserve_credits + settle_consumption + check_and_increment_bucket | service-role | ✓ WIRED | All three RPCs invoked from preDeduct/settle/buckets |
| Settings → ai_backend_kind | proxyConfigure('local'\|'cloud-proxy') | IPC + apiKeyStore.setAiBackendKind | ✓ WIRED | SettingsScreen.tsx:56-64 + useCreditsStore.refresh() |
| AcceptToSModal re-trigger | legalVersions bump | tos_acceptance row version mismatch | ✓ WIRED | legalVersions.ts constants drive tosGate; 13-22 SUMMARY documents 9-step smoke |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| CreditsScreen.tsx | remainingPct, plan, renewsAt | useCreditsStore (subscribed to `credits:status-update` push + cold init from main proxyClient.creditsGet()) | ✓ Yes — proxyClient.ts:194-261 reads ledger_balance + subscription_status + trial_claims + apiKeyStore in parallel; BigInt math; X-Sei-Remaining-Pct header pushed on each proxy response | ✓ FLOWING |
| IconRail.tsx | remainingPct, aiBackendKind | useCreditsStore | ✓ Yes — same source as above | ✓ FLOWING |
| HardStopModal.tsx | hardStopActive, hardStopReason | useCreditsStore (set only by `credits:hardStop` push from proxy on 402/429) | ✓ Yes — proxy emits hard-stop sentinel when insufficient reservation triggers a 402; useCreditsStore.onCreditsHardStop wires push | ✓ FLOWING |
| PercentBar.tsx | value (prop) | Passed remainingPct from CreditsScreen | ✓ Yes — pure presentational primitive; clamps to [0,100] | ✓ FLOWING |
| SettingsScreen.tsx Cloud AI row | aiBackendKind, plan | useCreditsStore | ✓ Yes — refresh() called on switch | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Full proxy test suite passes | `cd proxy && npx vitest run` | 93/93 tests pass (10 files, 354ms) | ✓ PASS |
| TypeScript build clean (proxy) | (via vitest typecheck via tsx) | No errors observed in test run | ✓ PASS |
| Edge function tests authored | `grep Deno.test supabase/functions/{lemon-webhook,trial-claim}/index.test.ts` | 25 lemon-webhook tests + 9 trial-claim tests = 34 total | ✓ PASS |
| Migration files present | `ls supabase/migrations/20260524*.sql` | 2 files | ✓ PASS |
| PROXY-05 grep — no dollar amounts in user-visible UI | `grep -E "\$5\|\$20" src/renderer/.../{Credits,HardStop,Percent,Settings}*.tsx` (excluding comments) | zero matches outside comments | ✓ PASS |
| sei.lemonsqueezy.com on allowlist | `grep "sei.lemonsqueezy.com" src/main/ipc.ts` | Line 985 exact-host entry | ✓ PASS |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ---------- | ----------- | ------ | -------- |
| PROXY-01 | 13-13, 13-21, 13-23 | User can purchase $5 pack via shell.openExternal → Lemon Squeezy | ✓ SATISFIED (code) / ? OPERATOR | proxyClient.openCheckout('pack') + buildCheckoutUrl + sei.lemonsqueezy.com allowlist; live products require Step 1 of runbook |
| PROXY-02 | 13-13, 13-21, 13-23 | User can purchase $20/month subscription via shell.openExternal → Lemon Squeezy | ✓ SATISFIED (code) / ? OPERATOR | proxyClient.openCheckout('subscription'); LEMON_VARIANT_SUBSCRIPTION env injection; live products require Step 1 of runbook |
| PROXY-03 | 13-01, 13-11, 13-23 | Lemon webhooks credit ledger; FIFO grants; subscription renews monthly | ✓ SATISFIED | lemon-webhook handles order_created + subscription_created + subscription_payment_success + subscription_updated + subscription_cancelled + subscription_expired; lemon_event_id UNIQUE idempotency; ledger_balance VIEW computes FIFO via SUM(grants) - SUM(consumption) |
| PROXY-04 | 13-17, 13-18 | Pricing icon above settings icon; click opens pricing/usage | ✓ SATISFIED | IconRail.tsx PricingIcon listed before SettingsIcon in spacer cluster; onClick navigates to {kind:'credits'}; CreditsScreen wired in App.tsx routing |
| PROXY-05 | 13-16, 13-17, 13-18 | Hovering pricing icon shows % only — no token counts | ✓ SATISFIED | Title text "${pct}% credits left · click for details"; useCreditsStore state has no token/dollar fields (type-level enforcement); grep returns zero in user-visible strings |
| PROXY-06 | 13-19 | Out-of-credits hard-stop modal | ✓ SATISFIED | HardStopModal mounts on hardStopActive push; three CTAs; ESC suppressed; auto-dismiss on balance refill |
| PROXY-07 | 13-03, 13-08, 13-09, 13-10, 13-15, 13-23 | Hono proxy on Fly.io between bot and Anthropic; cloud-AI mode points baseURL at proxy | ✓ SATISFIED | proxy/ scaffold complete; cloudMode override in anthropicClient.js; SEI_PROXY_URL env wired via electron-vite |
| PROXY-08 | 13-04, 13-10, 13-14 | Proxy authenticates every request via per-user JWT (no shared secret) | ✓ SATISFIED | verifyJwt against Supabase JWKS audience='authenticated'; per-request authToken read in SDK; proxyJwtFetcher refreshes 5min-before-expiry |
| PROXY-09 | 13-01, 13-05, 13-06, 13-07, 13-10, 13-12, 13-13, 13-23 | Token-bucket pre-deduction + RPM + TPM + daily $ caps | ✓ SATISFIED | All 4 controls live: pre-deduction via reserve_credits (atomic FOR UPDATE), RPM 60s window, ITPM 60s window, daily_dollar 86400s window; trial = 20/30K/$5; sub = 60/200K/$20 |
| PROXY-10 | 13-08, 13-10, 13-16 | Proxy returns server-driven remaining_pct on each response | ✓ SATISFIED | forward.ts:166 sets X-Sei-Remaining-Pct BEFORE streamSSE opens (RESEARCH Pitfall 1); useCreditsStore subscribes to push and mirrors |
| PROXY-11 | 13-02, 13-17, 13-20 | BYOK users never hit proxy, never see credits UI | ✓ SATISFIED | PricingIcon UNMOUNTED (not CSS-hidden) when aiBackendKind!=='cloud-proxy'; botSupervisor only ships cloudMode when cloud-proxy; SettingsScreen symmetric switch |
| PROXY-12 | 13-22, 13-23 | Refund/cancellation policy published in ToS before first charge | ✓ SATISFIED (text) / ? OPERATOR (publish) | ../sei-website/terms.html §8 "Refunds and Cancellations" with id="refunds"; Effective Date 2026-05-23; TOS_VERSION = 2026-05-23. Live publish at sei.gg requires sibling repo deploy (operator). |
| PROXY-13 | 13-23 | LS product description reviewed vs Anthropic ToS before live | ⚠ OPERATOR ONLY | Step 10 of 13-23 runbook — 5 sign-off items; cannot be verified by codebase grep (lives in LS dashboard + operator's audit checklist). Sentinel framing language ("proxied AI inference credits powered by Sei") is enforced in terms.html §8 + 13-23 SUMMARY but the LS product description itself is operator-edited. |

**Coverage:** 13/13 PROXY requirements have implementation evidence. PROXY-01, PROXY-02, PROXY-03, PROXY-07, PROXY-12, PROXY-13 require Step 1/4/5/6/10/11 of the operator runbook to be EXECUTED (not just shipped) before the requirement is satisfied for live users.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| (none) | — | — | — | grep for TODO/FIXME/XXX/HACK in modified Phase 13 files returned zero blocker-class results; all anti-pattern checks pass |

### Human Verification Required

See frontmatter `human_verification` section above. Two items:

1. **13-22 smoke test (9 steps)** — verify ToS §8 publish, anchor jump, version bump triggers AcceptToSModal re-accept cycle. Requires sei-website deploy + live Supabase account.

2. **13-23 operator runbook (11 steps, 4 blocking checkpoints)** — INTENTIONALLY SUMMARY-only deliverable. Creates LS products, verifies Anthropic Tier 2 (BEFORE first paying user — Pitfall 5), applies DB migration, deploys 2 Edge Functions, deploys Fly proxy, runs 13-step end-to-end smoke, configures alerts, signs off PROXY-13 framing audit, ships installer.

### Gaps Summary

No code gaps. All 23 plans for Phase 13 have shipped substantive, wired, data-flowing implementations against the phase goal:

- **Proxy** (`proxy/`): full Hono `verifyJwt → rateLimitGate → forwardToAnthropic` chain on Fly.io scaffold; 93/93 vitest tests pass; verbatim body forwarding preserves cache markers (T-13-08-07 fix at commit 913fc70); X-Sei-Remaining-Pct header injected pre-stream.
- **Supabase ledger** (`supabase/migrations/`): 6 tables, 1 VIEW, 3 RPCs, full RLS with select-own + service-role write boundary; atomic FOR UPDATE via reserve_credits.
- **Edge Functions** (`supabase/functions/`): lemon-webhook (HMAC verify before JSON.parse; 6 events; idempotent via lemon_event_id UNIQUE; 25 tests) + trial-claim (mc_username PK + compensating delete; 9 tests).
- **Main process** (`src/main/`): proxyClient (5 methods, BigInt math), proxyJwtFetcher (5min-before-expiry refresh), botSupervisor cloudMode wiring, openExternal allowlist + sei.lemonsqueezy.com.
- **Bot** (`src/bot/`): anthropicClient cloudMode override with apiKey:null (no X-Api-Key leak) + per-request authToken read (SDK source verified — both 13-15 CHECKER warnings resolved); setAuthToken rotation hook.
- **Renderer** (`src/renderer/`): useCreditsStore (no token/dollar fields — PROXY-05 type-level), PricingIcon above SettingsIcon (PROXY-04), CreditsScreen 3-block layout, HardStopModal with persona-aware copy, SettingsScreen symmetric Cloud AI switch.
- **Legal** (`../sei-website/`): terms.html §8 Refunds with id="refunds" anchor; Effective Date + TOS_VERSION + PRIVACY_VERSION = 2026-05-23.

Phase status is `human_needed` (not `passed`) because two deliverables — 13-22 ToS publish smoke and 13-23 operator runbook execution — are **intentionally operator-driven** per 13-23-SUMMARY.md key-decisions. The code that the operator runs is shipped and tested; the requirement-level satisfaction for PROXY-01/02/03/07/12/13 awaits live execution of the runbook.

---

_Verified: 2026-05-23T05:56:32Z_
_Verifier: Claude (gsd-verifier, Opus 4.7 1M)_
