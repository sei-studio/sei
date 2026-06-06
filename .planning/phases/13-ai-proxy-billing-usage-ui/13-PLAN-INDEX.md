# Phase 13 — Plan Index

**Created:** 2026-05-22
**Plans:** 23 (Waves 1–5)
**Phase goal:** Light up paid revenue — Lemon Squeezy MoR for $5 pack + $20/mo subscription, Hono-on-Fly.io proxy enforcing per-user JWT + token-bucket pre-deduction + RPM/TPM/daily-$ caps, and a friendly server-driven % bar that never shows token counts.

## Wave Structure

| Wave | Plans | Theme | Parallel? |
|------|-------|-------|-----------|
| 1 | 13-01, 13-02, 13-03 | Infrastructure foundations (DB migration, IPC stubs, proxy scaffold) | Fully parallel |
| 2 | 13-04, 13-05, 13-06, 13-07, 13-08, 13-09, 13-10 | Proxy core logic (TDD) | Mostly parallel; 13-10 (wiring) sequential at end |
| 3 | 13-11, 13-12, 13-13, 13-14, 13-15 | Edge Functions + Sei main client + bot baseURL override | Mostly parallel; 13-13 modifies src/main/ipc.ts (no Wave-3 overlap) |
| 4 | 13-16, 13-17, 13-18, 13-19, 13-20, 13-21 | Renderer UI + integration | **App.tsx overlap between 13-18 and 13-19 — sequential within wave** (see note) |
| 5 | 13-22, 13-23 | Legal publication + operator rollout | Sequential (22 → 23) |

## Plan Table

| ID | Wave | Title | Autonomous | Requirements | Files-modified count |
|----|------|-------|-----------|--------------|---------------------|
| 13-01 | 1 | Supabase migration — ledger_grants, ledger_consumption, subscription_status, rate_buckets, trial_claims, user_balance_lock, ledger_balance VIEW, reserve_credits + settle_consumption RPCs, RLS, pg_cron | yes | PROXY-03, PROXY-09 | 1 |
| 13-02 | 1 | aiBackendKind + IPC channel stubs (proxy.configure, trial.claim, credits.get/openCheckout, subscription.status/cancel, push channels) | yes | PROXY-11 | 5 |
| 13-03 | 1 | proxy/ Fly.io scaffold (package.json, fly.toml, Dockerfile, Hono shell with /health + 501 stub) | yes | PROXY-07 | 10 |
| 13-04 | 2 | verifyJwt middleware (TDD) — jose + Supabase JWKS, 1h cache, 4 error envelopes | yes | PROXY-08 | 3 |
| 13-05 | 2 | preDeduct + pricing + tokenize + remainingPct (TDD) — atomic reserve_credits RPC call, BigInt math | yes | PROXY-09 | 6 |
| 13-06 | 2 | settle + settleAsRefunded + settleAtReservation (TDD) — cache-savings refund, idempotent | yes | PROXY-09 | 2 |
| 13-07 | 2 | rate_buckets RPC + checkAllBuckets wrapper (TDD) — RPM/ITPM/daily-$ enforcement, 30s tier cache | yes | PROXY-09 | 3 |
| 13-08 | 2 | forwardToAnthropic (TDD) — raw-fetch SSE pass-through, X-Sei-Remaining-Pct pre-stream injection, 503 on upstream 429 | yes | PROXY-07, PROXY-10 | 2 |
| 13-09 | 2 | sentinel.ts error vocabulary + usage.ts SSE extractor (TDD), forward.ts refactor | yes | PROXY-07 | 4 |
| 13-10 | 2 | rateLimitGate Hono middleware + app.ts full chain wiring + integration test | yes | PROXY-07, PROXY-08, PROXY-09, PROXY-10 | 3 |
| 13-11 | 3 | lemon-webhook Edge Function — HMAC verify, idempotent ledger inserts, 6 event types | yes | PROXY-03 | 3 |
| 13-12 | 3 | trial-claim Edge Function — JWT verify, mc_username regex, atomic claim + grant, compensating delete | yes | PROXY-09 | 3 |
| 13-13 | 3 | proxyClient.ts — typed wrapper for trial-claim + Lemon checkout URL composer + IPC handler wiring | yes | PROXY-01, PROXY-02, PROXY-09 | 4 |
| 13-14 | 3 | proxyJwtFetcher.ts — 5min-before-expiry refresh + 30min rotation pump via MessagePort | yes | PROXY-08 | 3 |
| 13-15 | 3 | anthropicClient.js cloudMode baseURL override (~10 lines) + botSession.ts gate | yes | PROXY-07 | 2 |
| 13-16 | 4 | useCreditsStore zustand (TDD) — useSyncStore-style with push-seq race guard | yes | PROXY-05, PROXY-10 | 2 |
| 13-17 | 4 | PricingIcon SVG + IconRail conditional render above Settings (BYOK bypass via unmount) | yes | PROXY-04, PROXY-05, PROXY-11 | 2 + App.tsx |
| 13-18 | 4 | CreditsScreen three-block layout + PercentBar primitive + App.tsx routing | yes | PROXY-04, PROXY-05 | 3 + App.tsx |
| 13-19 | 4 | HardStopModal — client-side persona-aware copy, ESC suppressed, BYOK escape hatch + App.tsx mount | yes | PROXY-06 | 3 + App.tsx |
| 13-20 | 4 | SettingsScreen "Cloud AI" row — Switch to managed billing / Manage subscription / Switch to own API key | yes | PROXY-11 | 1 |
| 13-21 | 4 | openExternal allowlist + sei.lemonsqueezy.com | yes | PROXY-01, PROXY-02 | 1 |
| 13-22 | 5 | terms.html §8 Refunds + privacy.html co-bump + legalVersions.ts TOS+PRIVACY → 2026-05-23 | **no** (checkpoint:human-verify) | PROXY-12 | 3 |
| 13-23 | 5 | Operator runbook — LS products, Anthropic Tier 2 verify, fly deploy, supabase deploy, smoke, ToS sign-off, go-live | **no** (multiple checkpoints) | PROXY-01..03, PROXY-07, PROXY-09, PROXY-12, PROXY-13 | 1 (SUMMARY only) |

## Same-Wave File Overlap Note

**Wave 4 — App.tsx is modified by 13-17 (one-line route), 13-18 (route + screen mount), and 13-19 (HardStopModal mount).**

Resolution: these three plans must execute **sequentially within Wave 4** in the order 13-17 → 13-18 → 13-19. Each plan's App.tsx diff is small (~3 lines: import + route case or modal mount) and additive; the orchestrator should serialize their App.tsx edits. The other Wave 4 plans (13-16, 13-20, 13-21) have no overlap and can run in parallel with any of the above.

Also: 13-17 modifies `src/renderer/src/components/icons.tsx` which is also touched by no other Wave 4 plan — clean. 13-21 modifies `src/main/ipc.ts` which 13-13 (Wave 3) finalized in its own wave — no Wave 4 overlap.

## Requirements Coverage Audit

Every PROXY-NN requirement appears in at least one plan's `requirements_addressed`:

- PROXY-01: 13-13, 13-21, 13-23
- PROXY-02: 13-13, 13-21, 13-23
- PROXY-03: 13-01, 13-11, 13-23
- PROXY-04: 13-17, 13-18
- PROXY-05: 13-16, 13-17, 13-18
- PROXY-06: 13-19
- PROXY-07: 13-03, 13-08, 13-09, 13-10, 13-15, 13-23
- PROXY-08: 13-04, 13-10, 13-14
- PROXY-09: 13-01, 13-05, 13-06, 13-07, 13-10, 13-12, 13-13, 13-23
- PROXY-10: 13-08, 13-10, 13-16
- PROXY-11: 13-02, 13-17, 13-20
- PROXY-12: 13-22, 13-23
- PROXY-13: 13-23

No requirement is missing a plan owner. ✓

## Source Audit (CONTEXT decisions)

| Decision | Plan(s) implementing | Status |
|----------|---------------------|--------|
| D-38 (Fly.io + Hono + region iad + 256MB scale 0-2) | 13-03 | covered |
| D-39 (jose JWKS 1h cache + aud='authenticated') | 13-04 | covered |
| D-40 (cloudMode baseURL + authToken on anthropicClient.js) | 13-15 | covered |
| D-41 (X-Sei-Remaining-Pct header server-driven, round to 5) | 13-05, 13-08, 13-16 | covered |
| D-42 (trial gate on mc_username, $1 grant) | 13-01, 13-12 | covered |
| D-42a (offline-mode abuse known limitation) | 13-01 (on delete set null) | documented |
| D-42b (GUI/in-game username match) | out of Phase 13 scope (bot UX) | n/a |
| D-43 (cache savings refund) | 13-05, 13-06 | covered |
| D-44 (Anthropic 429 → 503 service_at_capacity) | 13-08 | covered |
| D-45 (LS two-product + custom_data) | 13-13, 13-23 | covered |
| D-46 (lemon-webhook + idempotency via lemon_event_id) | 13-01, 13-11 | covered |
| D-47 (ledger_grants + ledger_consumption + ledger_balance) — VIEW not MV | 13-01 | covered (with documented deviation) |
| D-47a (RLS select_own) | 13-01 | covered |
| D-48 (refund policy in terms.html §8) | 13-22 | covered |
| D-49 (Anthropic ToS framing checklist) | 13-23 step 10 | covered |
| D-50 (1.25× reservation + atomic SQL with FOR UPDATE) | 13-01, 13-05 | covered |
| D-50a (input tokens via @anthropic-ai/tokenizer) | 13-05 | covered |
| D-51 (rate caps with cache-read exclusion; user already on Tier 2) | 13-01, 13-07 | covered |
| D-52 (429 response shape with kind + retry_after) | 13-07, 13-09 | covered |
| D-54 (pricing icon above Settings) | 13-17 | covered |
| D-55 (CreditsScreen three blocks; no numbers) | 13-18 | covered |
| D-56 (hard-stop modal triggered on 402 / 0% / non-recoverable empty) | 13-19 | covered |
| D-57 (BYOK bypass — conditional unmount of credits UI) | 13-02, 13-17, 13-18, 13-19, 13-20 | covered |

## Open-Question Resolutions Applied

1. ✅ Persona-aware hard-stop copy renders CLIENT-side (13-19)
2. ✅ ledger_balance = regular VIEW (not MV) — research recommendation (13-01 with documented deviation)
3. ✅ Net credit grants: $5 pack → 4_750_000 µ$; $20 sub → 18_500_000 µ$ (13-11)
4. ✅ TOS_VERSION + PRIVACY_VERSION = 2026-05-23 (13-22)
5. ✅ Subscription cancellation via LS customer portal (`https://sei.lemonsqueezy.com/billing` via shell.openExternal) — Sei does NOT host a cancel endpoint (13-13, 13-20)

Tier-1 → Tier-2 ramp logic is OBSOLETE — Sei is already on Tier 2; trial cap is $5/day from launch. (Applied in 13-01, 13-05, 13-07.)

## Threat Model Notes

Every plan ships a `<threat_model>` block with STRIDE register. Cross-cutting threats addressed:

- **JWT replay**: 13-04 (jose exp check)
- **Atomic ledger races (TOCTOU)**: 13-01 (FOR UPDATE row lock), 13-05 (RPC wrapper), 13-06 (idempotent settle)
- **Webhook signature bypass**: 13-11 (HMAC over raw body before JSON.parse)
- **BYOK leakage**: 13-02 (aiBackendKind), 13-17 (unmount not CSS-hide), 13-20 (symmetric escape)
- **Cache-content disclosure**: 13-08 (raw fetch + cache_control passthrough)
- **Anthropic API key exfil**: 13-03 (Fly secrets), 13-08 (never logged), 13-23 (org-key verification)
- **Rate-limit bypass via header forging**: 13-04 (verifyJwt is first), 13-10 (rateLimitGate before preDeduct)
- **Subscription cancellation race**: 13-11 (subscription_status upsert with status field)

## Notes for Executors

- All Wave 2 proxy plans build on Wave 1's `proxy/` scaffold (13-03). Run `npm install && npm test` inside `proxy/` to see all Wave 2 tests light up incrementally.
- Wave 3 Edge Functions are Deno; tests run with `deno test --allow-env --no-check` inside each function directory.
- Wave 4 renderer plans MUST run `npx tsc --noEmit -p tsconfig.web.json` clean after every plan.
- Wave 5 plans are gated by `checkpoint:human-verify` and require operator intervention with Fly.io / Lemon Squeezy / Supabase / Anthropic dashboards.

## PLAN COMPLETE
