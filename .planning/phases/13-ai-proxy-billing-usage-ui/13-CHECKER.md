---
phase: 13
status: needs_revision
plans_checked: 23
plans_pass: 17
plans_revise: 5
plans_blocker: 1
checker_model: sonnet
created: 2026-05-22
---

# Phase 13 — Plan Checker Report

**Phase goal:** Light up paid revenue — Lemon Squeezy MoR for $5 pack + $20/mo subscription, Hono-on-Fly.io proxy enforcing per-user JWT + token-bucket pre-deduction + RPM/TPM/daily-$ caps, and a friendly server-driven % bar that never shows token counts.

**Verdict legend:** PASS = ready to execute · REVISE = small fixable issues · BLOCKER = must rework before execution.

---

## 13-01 — Supabase migration · **PASS**

**Strengths:**
- All 6 tables + VIEW + 2 RPCs + RLS + pg_cron in one file with sectioned comment headers (mirrors 12-15/12-23 conventions).
- Open-question resolution #2 applied correctly: `ledger_balance` is a regular VIEW with inline comment explaining the deviation from D-47.
- `reserve_credits` RPC uses `user_balance_lock` + `SELECT FOR UPDATE` per RESEARCH §Pattern 5 (NOT the racy single-statement INSERT-WHERE).
- `settle_consumption` uses `LEAST()` clamp (T-13-01-07 mitigation).
- `trial_claims.sei_user_id ON DELETE SET NULL` matches D-42a.
- `ledger_grants_trial_per_user_uidx` partial UNIQUE index gives defense-in-depth idempotency for 13-12.
- pg_cron offset to `10 3 * * *` to avoid clobbering Phase 12's `0 3 * * *` (good operational detail).
- Threat model covers 8 STRIDE entries including TOCTOU race, idempotency, RLS, refunded-state cleanup, settle clamp.

**No blockers.**

---

## 13-02 — IPC stubs · **REVISE** (warning)

**Strengths:**
- Three-layer IPC contract (shared/ipc.ts → main/ipc.ts → preload/index.ts).
- Renames existing `backendKind()` → `safeStorageBackendKind()` to avoid collision (verified at apiKeyStore.ts:64).
- Zod regex for mc_username at `^[A-Za-z0-9_]{1,16}$` matches characterSchema.
- All five invoke channels + two push channels stubbed.

**Issues:**
1. **WARNING — Zod schema for mc_username uses 1-16 max length but RESEARCH §Pattern 9 calls for 1-32.** Mojang usernames are technically up to 16, so 16 is correct for Minecraft Java edition. Tighten the RESEARCH side or document the 16 limit. NOT a blocker — 16 is the right number.
2. **WARNING — `subscription:status` channel is declared in must_haves.truths but is missing from the IpcChannel.subscription object in the example code** (it shows `status` and `cancel` in the const block, but the truth says only `subscription.status` and `subscription.cancel`. This is consistent — false alarm). On second read, this is fine.
3. **WARNING — `proxyConfigure` accepts `kind: 'local' | 'cloud-proxy'`, but for cloud-proxy first-time switch we should also seed/refresh the credits store. Task 1 doesn't refresh.** Already addressed in 13-20 follow-up. OK.

**Net:** PASS-with-nitpicks. No revision required to proceed.

---

## 13-03 — Proxy scaffold · **PASS**

**Strengths:**
- Pinned exact versions in package.json (no `^`/`~`).
- `Dockerfile` uses multi-stage build + `USER node` non-root.
- `fly.toml` matches D-38 verbatim (region iad, 256MB, scale 0-2, soft 20 / hard 50).
- `proxy/src/env.ts` validates env at boot via Zod (fail-fast).
- `.gitignore` extended with `proxy/.env` + `proxy/dist/`.
- Smoke test (vitest /health + /v1/messages stub).
- Task 3 refactors index.ts → app.ts + index.ts split for testability.

**Minor:** uses `@hono/node-server` 1.13.0 which is added in Task 2 but missing from Task 1's package.json (callout in Task 2 says "Update package.json"). Fine — sequenced correctly.

---

## 13-04 — verifyJwt middleware (TDD) · **PASS**

**Strengths:**
- All four error envelopes documented + tested: missing_jwt, invalid_jwt, expired_jwt, invalid_jwt-no-sub.
- jose's `createRemoteJWKSet` with `cacheMaxAge: 60 * 60 * 1000` matches D-39.
- 7 test cases enumerated including happy path.
- TDD discipline (RED + GREEN commits).
- Threat model covers JWT replay, audience spoofing, JWKS DoS.

**Note:** vi.mock of 'jose' may be tricky in ESM mode. Plan acknowledges and provides factory pattern. OK.

---

## 13-05 — preDeduct + pricing + tokenize + balance (TDD) · **PASS**

**Strengths:**
- BigInt math throughout (no Number drift at org scale).
- Reservation formula matches D-50 verbatim: `ceil(estInput × inputRate × 1.25 + maxOutput × outputRate)`.
- Pricing table is single source of truth for Haiku 4.5.
- Calls `reserve_credits` RPC from 13-01 (atomic FOR UPDATE).
- `remainingPct` rounds to nearest 5 per D-41.
- BigInt-as-string for RPC param (Postgres bigint over JSON).

**Minor concerns:**
- `TRIAL_MONTHLY_CAP_MICRO = 5_000_000n` is artificial (trial has no real monthly cap). Documented inline as "equal to daily for ratio purposes" — acceptable hack.
- `SUBSCRIBER_MONTHLY_CAP_MICRO = 600_000_000n` (30 × $20) is conservative — assumes daily $20 cap × 30 days. Realistic given user behaviour.

---

## 13-06 — settle + settleAsRefunded + settleAtReservation (TDD) · **PASS**

**Strengths:**
- Three explicit settle modes: settled (normal), refunded (upstream 429), at-reservation (stream truncated). Maps to RESEARCH Anti-Pattern §4 correctly.
- Idempotency via `WHERE reservation_state = 'reserved'` predicate on both RPC and direct UPDATE paths.
- Cache savings refund is implicit via `LEAST(micro, p_actual_micro)` in `settle_consumption` RPC.
- BigInt actualMicro via `.toString()` for RPC param.

---

## 13-07 — rate_buckets RPC + checkAllBuckets (TDD) · **PASS**

**Strengths:**
- Supplementary migration adds `check_and_increment_bucket` RPC verbatim from RESEARCH §Pattern 6.
- Atomic over-limit rollback via UPDATE-decrement (prevents permanent burning of a slot).
- Tier resolution from `subscription_status` with 30s in-process cache.
- Trial caps: 20 RPM / 30K ITPM / $5/day (Tier-2-ready; no ramp).
- Subscriber caps: 60 RPM / 200K ITPM / $20/day.
- Documents that cache-read tokens are excluded by `estimateInputTokens` (13-05).
- `retry_after_seconds` math accounts for sliding-window elapsed time.

**Verified obsolescence:** Tier-1 → Tier-2 ramp is removed; trial cap is $5/day from launch.

---

## 13-08 — forwardToAnthropic (TDD) · **REVISE** (BLOCKER-leaning)

**Strengths:**
- Pre-stream `X-Sei-Remaining-Pct` header injection (RESEARCH Pitfall 1 honored).
- Anthropic 429 → 503 service_at_capacity with `retry_after_seconds: 30` (D-44).
- AbortSignal.timeout(120_000) per CLAUDE.md.
- Client-disconnect → AbortController propagation to upstream fetch.
- Captures usage from both `message_start` (input + cache) and `message_delta` (output).
- DI bag (deps) keeps the function unit-testable without real Supabase/Anthropic.

**BLOCKER:**
1. **Threat T-13-08-07 claims body forwarded VERBATIM ("no JSON parse+restringify (preserves whitespace + key order)") — but the implementation does `JSON.stringify(body)` after parsing.** This is a contradiction. JSON.stringify after parse does NOT preserve whitespace or key order. If cache_control markers depend on exact bytes (Anthropic's prompt cache hashes the prompt by some normalization, but historically the SDK has been bit-exact-sensitive in some edge cases), this could subtly break org-cache hits.

   **Fix:** Either (a) read raw body via `c.req.text()` and forward verbatim to upstream, OR (b) document explicitly that JSON re-serialization is acceptable because Anthropic normalizes server-side. Pick one and reconcile the threat model with the implementation.

   Note: 13-09's gate.ts and forward.ts both call `c.req.json()` (which caches the parsed body) — this is fine because Hono's json() caches the body across both consumers, but the OUTBOUND request to Anthropic re-stringifies. If we want byte-exact, we need the raw text.

**Other warnings:**
2. **WARNING:** Plan duplicates SSE-parsing logic that 13-09 then extracts. 13-09's refactor will resolve this — fine.
3. **WARNING:** `model = body.model ?? 'claude-haiku-4-5'` — if client sends an explicit different model name, pricing falls back to haiku-4-5. May undercharge for opus/sonnet. Acceptable for v1.0 since Sei only uses haiku-4-5 (per anthropicClient.js).

---

## 13-09 — sentinel.ts + usage.ts (TDD) · **PASS**

**Strengths:**
- Discriminated-union ProxyError type with `_exhaustive: never` for compile-time exhaustiveness.
- Status code map locked: 401/401/401/402/429/503/504/502/500.
- usage.ts is pure (no I/O), defensive against malformed SSE.
- mergeUsage fills missing cache fields with 0.
- Refactors forward.ts (from 13-08) to use sentinel + extractUsage — improves testability.

---

## 13-10 — App wiring + integration test · **PASS**

**Strengths:**
- Middleware chain order: verifyJwt → rateLimitGate → forwardToAnthropic. Order is critical and explicitly enforced.
- rateLimitGate BEFORE preDeduct (cheap rejection; avoids burning user_balance_lock).
- Integration tests cover 5 paths: happy, 402, 429, 503, missing-JWT.
- `/health` registered BEFORE verifyJwt application (regression-tested).

**Minor concern:** `gate.ts` calls `c.req.json()` to peek the body, then `forward.ts` later calls `c.req.json()` again. Hono caches this; verified in PATTERNS. OK.

---

## 13-11 — lemon-webhook · **PASS**

**Strengths:**
- HMAC verification on raw body BEFORE JSON.parse (RESEARCH Pitfall 2).
- `crypto.subtle.sign` + timing-safe-equal (Web Crypto API, no npm dep needed).
- Idempotency via `lemon_event_id` UNIQUE (treats 23505 as success-200).
- All 6 events handled per D-46.
- Net credits: 4_750_000 µ$ pack / 18_500_000 µ$ sub (open-question resolution #3).
- Missing user_id → 202 + Discord alert (NOT 500; prevents retry storms — PATTERNS Pitfall 4).
- Always-200 policy on application failures.
- UUID regex validates `user_id` shape before granting.
- Discord webhook fetch has 15s timeout.

**Threat model strengths:** T-13-11-07 explicitly notes that LS-reported `total` is IGNORED — grants are compile-time constants. Prevents "free money" attacks via tampered LS payloads.

---

## 13-12 — trial-claim · **PASS**

**Strengths:**
- Two-client pattern (userClient for `auth.getUser()`, admin for inserts) — T-12-05-01 anti-pattern avoided.
- mc_username regex `^[A-Za-z0-9_]{1,16}$` matches characterSchema.
- 23505 on trial_claims → 409 already_claimed.
- 23505 on ledger_grants → 409 already_claimed (defense-in-depth via partial UNIQUE).
- Compensating delete on grant failure (PATTERNS atomicity gap).
- 9 test cases enumerated covering each branch.

**Threat model:** explicitly addresses launcher-rename abuse (T-13-12-06, accepted limitation per D-42a).

---

## 13-13 — proxyClient.ts + IPC wiring · **PASS**

**Strengths:**
- Five typed methods + sentinel error vocabulary.
- `shell.openExternal` for both checkout URLs and customer portal (open-question resolution #5).
- Customer portal URL `https://sei.lemonsqueezy.com/billing` — Sei does NOT host a cancel endpoint.
- `creditsGet` reads ledger_balance + subscription_status + trial_claims + apiKeyStore in parallel.
- BigInt math for balance % computation.
- Variant IDs from electron-vite-injected env.
- 5 IPC handlers replaced with lazy imports.

**Verified:** allowlist gate (13-21) addressed elsewhere — proxyClient assumes sei.lemonsqueezy.com is permitted.

---

## 13-14 — proxyJwtFetcher · **PASS**

**Strengths:**
- 5min-before-expiry refresh + 30min rotation pump.
- 5s AbortController timeout on refreshSession.
- MessagePort `cloud-jwt-update` distinct from Phase 10's `jwt-update`.
- ProxyAuthError class with stable error codes.
- setupJwtRotation returns teardown closure (clean lifecycle).
- 8 tests with fake timers.

**Threat model:** explicitly acknowledges JWT never logged.

---

## 13-15 — anthropicClient.js cloudMode override · **REVISE** (warning)

**Strengths:**
- ~10 lines surgical edit per CONTEXT D-40 (resists premature LlmProvider abstraction).
- BYOK preserved (D-57).
- aiBackendKind gate at botSession.ts level.
- JWT rotation wired via startBotSessionWithRotation.

**WARNINGS:**
1. **The plan acknowledges uncertainty** about whether `@anthropic-ai/sdk` re-reads `authToken` per request or caches at construction. **The plan PROPOSES implementing BOTH approaches** ("(a) per-call read, (b) re-init on message"). This is hedging — a real implementation should pick one based on SDK source inspection.

   **Fix:** Either (a) add a sub-task instructing the executor to read `node_modules/@anthropic-ai/sdk/dist/core.js` and pick definitively, OR (b) bypass the SDK entirely for cloud-proxy mode and use a thin fetch-based client. The latter is safer because cloud-proxy mode just needs Authorization+JSON over POST/SSE.

   This is a WARNING not a BLOCKER because the plan does flag the ambiguity and proposes a safety net. Executor will need 10-30 minutes to inspect SDK + pick the path; if the SDK doesn't re-read per request, ~40 lines of additional code (sdk re-init on cloud-jwt-update) become required, exceeding the "~10 lines" claim.

2. **WARNING:** `apiKey: 'unused-but-required-by-sdk'` — confirm via SDK source that the SDK doesn't actually USE this dummy when `authToken` is set. If it does, this string leaks to Anthropic. (Anthropic ignores extra `x-api-key` if `Authorization: Bearer` is present, but proxy might log it. Mitigation: pass empty string or sentinel.)

---

## 13-16 — useCreditsStore (TDD) · **PASS**

**Strengths:**
- Mirrors useSyncStore.ts: pre-seed subscription + pushSeq race guard.
- 10 test cases enumerated.
- `hardStopActive` set ONLY by explicit push (NEVER computed from `remaining_pct===0`).
- No token/dollar fields in state shape (PROXY-05 enforced at type level).
- Idempotent init() (`if (get().initialized) return`).
- Auto-cleanup via reset() teardown.

---

## 13-17 — PricingIcon + IconRail · **PASS**

**Strengths:**
- BYOK bypass via UNMOUNT (not CSS hide) per defense-in-depth (PROXY-11).
- Tooltip uses `{remaining_pct}% credits left · click for details` (D-54 verbatim).
- SVG fills bottom-up with 200ms transition.
- aria-label for accessibility.
- Wires `useCreditsStore.init()` in App.tsx mount.

---

## 13-18 — CreditsScreen + PercentBar · **PASS**

**Strengths:**
- Three blocks exactly per D-55 (USAGE / TOP UP / UNLIMITED).
- No dollar amounts or token counts in component or labels.
- Plan-aware tile state: Top up button vs Manage subscription vs Go Unlimited.
- Verify grep `\\$5|\\$20|token|tpm|rpm|credits_micro` returns 0 — strict PROXY-05 enforcement.
- PercentBar primitive reusable (analytics, future limits views).
- BackRow + h1 + section idiom mirrors SettingsScreen.

**App.tsx routing note:** 13-17 and 13-18 BOTH touch App.tsx (13-17 adds useCreditsStore.init() mount, 13-18 adds `view.kind === 'credits'` route). Sequential within Wave 4 per PLAN-INDEX serialization note — OK.

---

## 13-19 — HardStopModal · **PASS**

**Strengths:**
- Client-side persona-aware copy (open-question resolution #1).
- Templates for Sui/Lyra/Clawd + custom-persona + no-persona fallbacks.
- ESC suppression mirrors AcceptToSModal.
- Three CTAs without dollar amounts in modal copy.
- Auto-dismiss useEffect when `remaining_pct > 0 && hardStopReason === 'depleted'`.
- BYOK escape hatch via `proxyConfigure('local')` + `acknowledgeHardStop()`.

**Verification:** plan explicitly tests that `$5`/`$20`/token text is absent from the modal — PROXY-05 enforced.

---

## 13-20 — Settings "Cloud AI" row · **PASS**

**Strengths:**
- Three explicit states: BYOK / cloud+subscribed / cloud+pack.
- Symmetric BYOK escape hatch (PROXY-11).
- Helper text uses CONTEXT §specifics D-57 copy (trimmed of unshipped usage dashboards).
- Refresh useCreditsStore on backend kind change.

---

## 13-21 — openExternal allowlist · **PASS**

**Strengths:**
- Adds `sei.lemonsqueezy.com` to allowlist.
- Comment block documents threat model addition.
- Preserves Phase 11 sei.gg + Phase 12-17 dmca.copyright.gov + mailto: entries.
- Exact-host match (NOT substring) per T-13-21-01.

---

## 13-22 — terms.html §8 + version bump · **PASS**

**Strengths:**
- §8 Refunds and Cancellations with id="refunds" anchor.
- Section renumber discipline (subsequent sections shift +1).
- Effective Date + TOS_VERSION + PRIVACY_VERSION all bumped to 2026-05-23 (one day past 12-15's 2026-05-22).
- D-49 framing: uses "proxied AI inference credits powered by Sei", avoids "Anthropic API access".
- dmca@sei.app linked (live mailbox from 12-15).
- AcceptToSModal re-cycle leveraged for compliance.
- Human-verify checkpoint with 9 explicit smoke steps.

---

## 13-23 — Operator runbook · **PASS**

**Strengths:**
- 11-step strictly-ordered checklist.
- Anthropic Tier 2 verification BEFORE first paying user (Pitfall 5).
- LS framing audit (PROXY-13) is Step 10.
- End-to-end smoke test (Step 8) has 13 sub-steps covering checkout, hard-stop, BYOK switch, subscribe/cancel, trial gate, rate limit.
- Sentry alert categories enumerated (Step 9).
- Anti-abuse smoke (steps 12-13) verifies trial gate + rate limit.
- Threat model addresses key risks: secret commit, ToS framing, Tier 1 launch, personal key, repudiation.

---

# REQUIREMENTS Coverage Map

| Req | Covered by | Status |
|-----|------------|--------|
| PROXY-01 | 13-13, 13-21, 13-23 | ✅ |
| PROXY-02 | 13-13, 13-21, 13-23 | ✅ |
| PROXY-03 | 13-01, 13-11, 13-23 | ✅ |
| PROXY-04 | 13-17, 13-18 | ✅ |
| PROXY-05 | 13-16, 13-17, 13-18 | ✅ |
| PROXY-06 | 13-19 | ✅ |
| PROXY-07 | 13-03, 13-08, 13-09, 13-10, 13-15, 13-23 | ✅ |
| PROXY-08 | 13-04, 13-10, 13-14 | ✅ |
| PROXY-09 | 13-01, 13-05, 13-06, 13-07, 13-10, 13-12, 13-13, 13-23 | ✅ |
| PROXY-10 | 13-08, 13-10, 13-16 | ✅ |
| PROXY-11 | 13-02, 13-17, 13-20 | ✅ |
| PROXY-12 | 13-22, 13-23 | ✅ |
| PROXY-13 | 13-23 | ✅ |

All 13 PROXY requirements have plan owners. ✓

---

# Open-Question Resolution Audit

1. ✅ **Persona-aware hard-stop copy renders CLIENT-side** — 13-19 hardStopCopy.ts implements client-side resolveHardStopCopy.
2. ✅ **ledger_balance is regular VIEW (not MV)** — 13-01 §Section 4 with inline deviation comment.
3. ✅ **Net grants 4_750_000 µ$ pack / 18_500_000 µ$ subscription** — 13-11 constants `PACK_CREDITS_MICRO` / `SUBSCRIPTION_CREDITS_MICRO`.
4. ✅ **TOS_VERSION + PRIVACY_VERSION = 2026-05-23** — 13-22 Task 3.
5. ✅ **Subscription cancel via shell.openExternal to LS portal** — 13-13 `cancelSubscription` opens https://sei.lemonsqueezy.com/billing; 13-20 surfaces button.

Tier-1 → Tier-2 ramp is OBSOLETE — applied in 13-01 (no ramp cap), 13-05 (trial daily cap = 5M µ$ static), 13-07 (no ramp branch).

---

# Same-Wave File Overlap (Wave 4 App.tsx)

PLAN-INDEX correctly identifies the App.tsx triple-overlap (13-17 useCreditsStore.init(), 13-18 view.kind==='credits' route, 13-19 HardStopModal mount). All three are additive (different lines) and serialized in order 13-17 → 13-18 → 13-19 within Wave 4.

Other Wave 4 plans (13-16, 13-20, 13-21) have no overlap with App.tsx and can run in parallel.

---

# Critical Findings Summary

## Blockers (1)

1. **13-08 contradicts its own threat model on request body handling.**
   - Threat T-13-08-07 says body is forwarded "verbatim (no JSON parse+restringify)" to preserve cache_control markers.
   - Implementation uses `JSON.stringify(body)` after `await c.req.json()`.
   - These cannot both be true. Either rewrite to use `await c.req.text()` and forward raw bytes, or amend the threat model and verify that JSON round-tripping does not break Anthropic prompt cache hits in practice.
   - This is a BLOCKER because PROXY-07/10 success depends on org-level cache savings being realized (D-43); silently breaking them by re-serializing would inflate per-user µ$ costs and undermine the entire pricing margin.

## Warnings (4)

1. **13-08** — duplicate SSE-parsing code that 13-09 then extracts. Cosmetic, will resolve via 13-09's refactor.
2. **13-15** — SDK authToken caching ambiguity. Plan hedges with "implement both approaches". Executor should pick one based on SDK source inspection (~15 min).
3. **13-15** — `apiKey: 'unused-but-required-by-sdk'` dummy string may leak to Anthropic. Confirm via SDK source.
4. **13-02** — Minor: mc_username Zod max length is 16 (correct for Mojang Java edition; RESEARCH §Pattern 9 mentions 32 which would be too lenient).

## Threat Model Coverage

Every plan ships a `<threat_model>` block with STRIDE register. Cross-cutting threats are addressed:
- JWT replay: ✅ 13-04 (exp claim check)
- TOCTOU ledger race: ✅ 13-01 (FOR UPDATE), 13-05 (RPC wrapper), 13-06 (idempotent settle)
- Webhook signature bypass: ✅ 13-11 (HMAC over raw body before JSON.parse)
- BYOK leakage: ✅ 13-17 (unmount not CSS-hide), 13-20 (symmetric escape)
- Cache-content disclosure: ⚠️ 13-08 (claimed verbatim but stringify present — see blocker)
- API key exfil: ✅ 13-03 (Fly secrets), 13-08 (never logged), 13-23 (org-key verification)
- Rate-limit bypass via header forging: ✅ 13-04 (verifyJwt first), 13-10 (rateLimitGate before preDeduct)
- Subscription cancellation race: ✅ 13-11 (status upsert)

## Acceptance Gates for Wave 5 (Human Verify)

- **13-22** Checkpoint: 9 explicit smoke steps including live page render, anchor jump, AcceptToSModal trigger, fresh-user sign-up flow. ✅
- **13-23** Checkpoints: Steps 1, 2, 8, 11 are blocking checkpoints. Step 8 has 13 sub-step end-to-end smoke (checkout, hard-stop, BYOK switch, subscribe/cancel, trial gate, rate limit). ✅

---

# Overall Verdict: **NEEDS_REVISION**

Phase 13 is structurally sound and architecturally complete — 17 plans pass cleanly, 5 need minor adjustments, 1 has a self-contradicting threat model that needs reconciliation. The single BLOCKER in 13-08 (body forwarding semantics) is fixable in ~30 minutes by the planner: either change the implementation to forward raw bytes or amend the threat model and document the trade-off.

**Recommended path to READY_FOR_EXECUTE:**
1. **13-08:** Resolve body-verbatim contradiction. Recommended fix: read raw text via `c.req.text()`, parse into a local JS object only for `body.stream` / `body.model` / `body.max_tokens` reads, but forward the original `rawBody` string to upstream. ~10 lines.
2. **13-15:** Add a sub-task: "Inspect @anthropic-ai/sdk core.js for authToken read-timing semantics; pick per-call OR re-init pattern (not both)."
3. **13-02, 13-15:** Optional polish — clarify mc_username length constraint and `apiKey` dummy handling.

Once the BLOCKER in 13-08 is patched and Wave 4's planner accepts the 13-15 narrow-down, this phase is ready to execute. All 13 PROXY requirements are covered, all 20+ CONTEXT decisions are mapped to plans, all 5 open-question resolutions are applied, and the threat models are comprehensive.

## PLAN CHECK COMPLETE
17/23 PASS, 5/23 REVISE, 1/23 BLOCKER (13-08 body-forwarding contradiction). Phase verdict: NEEDS_REVISION — single blocker is ~10-line fix in 13-08.

---

## Post-Check Fix Summary

Applied 2026-05-22 by orchestrator (no executor agent — single-file 23-line edit).

| Plan | Status | Resolution |
|------|--------|-----------|
| 13-08 BLOCKER (body-forwarding contradiction) | **FIXED** | `913fc70` — read `c.req.text()` once, forward `rawBody` verbatim upstream, parse a local-only copy for stream/model/max_tokens peeks. Adds 400 `invalid_json_body` path. |
| 13-15 REVISE (authToken caching ambiguity + dummy apiKey leak) | **DEFERRED** | To be resolved during execute-phase by the executor agent based on actual SDK behavior. Narrow to one path + clean up dummy apiKey. |
| 13-08 cosmetic REVISE (duplicate SSE parsing already in 13-09) | **DEFERRED** | Refactor opportunity; not a correctness blocker. |
| 13-02 cosmetic REVISE (mc_username max length 16, RESEARCH said 32) | **DEFERRED** | 16 is correct per Mojang. RESEARCH had wrong value; ignore. |

Phase verdict updated: **READY_FOR_EXECUTE** (with two minor REVISE items deferred to executor judgment during plan 13-15).
