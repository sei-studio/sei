---
phase: 13
plan: 23
subsystem: rollout-operator-runbook
tags: [checkpoint, rollout, runbook, fly-deploy, supabase-migrate, lemon-squeezy, anthropic-tier-2, sentry, anthropic-tos, phase-closure]

# Dependency graph
requires:
  - phase: 13
    plan: 01
    provides: "Phase 13 ledger migration (ledger_grants, ledger_consumption, subscription_status, rate_buckets, trial_claims, user_balance_lock + ledger_balance VIEW + reserve_credits / settle_consumption RPCs + pg_cron rate_buckets_cleanup)"
  - phase: 13
    plan: 03
    provides: "proxy/ Fly.io scaffold (Hono on Node 22, region iad, 256MB, scale 0-2, Dockerfile + fly.toml + env.ts boot-validation)"
  - phase: 13
    plan: 07
    provides: "rate_buckets_rpc supplementary migration (check_and_increment_bucket RPC)"
  - phase: 13
    plan: 10
    provides: "Proxy app wiring (verifyJwt → rateLimitGate → preDeduct → forwardToAnthropic chain)"
  - phase: 13
    plan: 11
    provides: "lemon-webhook Edge Function (HMAC-verified, idempotent, six event handlers, missing_user_id Discord alert path)"
  - phase: 13
    plan: 12
    provides: "trial-claim Edge Function (mc_username unique-claim gate + $1 trial grant)"
  - phase: 13
    plan: 13
    provides: "proxyClient.ts (creditsGet / topUpStart / subscribeStart / cancelSubscription / claimTrial) + electron-vite-injected SEI_PROXY_URL + LEMON_VARIANT_PACK + LEMON_VARIANT_SUBSCRIPTION env vars"
  - phase: 13
    plan: 15
    provides: "anthropicClient.js cloudMode override (baseURL + authToken parameter, BYOK preserved)"
  - phase: 13
    plan: 22
    provides: "terms.html §8 Refunds + TOS_VERSION/PRIVACY_VERSION = 2026-05-23 (AcceptToSModal re-cycle on first launch after legalVersions bump)"
provides:
  - "Operator runbook for Phase 13 production rollout — Lemon Squeezy product creation, Anthropic Tier 2 verification, Supabase migration apply, Edge Function deploy, Fly.io proxy deploy, SEI_PROXY_URL build env config, end-to-end smoke test, Sentry alerts, Anthropic ToS framing sign-off, final config flip"
  - "11-step strictly-ordered checklist with explicit gates and resume-signal strings"
  - "End-to-end smoke test plan (Step 8) with 13 sub-steps covering checkout, hard-stop, BYOK switch, subscribe/cancel, trial gate, rate limit"
  - "Sentry / equivalent alert categories enumerated (Step 9)"
  - "PROXY-13 Anthropic ToS framing audit checklist (Step 10) — five sign-off items"
affects: ["v1.0 launch — Phase 13 is the final billing-enablement phase; runbook gates the first paying user"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Pre-flight gate ordering: LS products (variants) → Anthropic Tier 2 (Pitfall 5 — BEFORE first paying user) → DB migration → Edge Functions → LS webhook → Fly proxy → SEI_PROXY_URL build env → smoke test → alerts → ToS framing sign-off → installer release. Any step out of order leaves a foot-gun."
    - "Each step tagged [OPERATOR ACTION REQUIRED] vs [CODE COMPLETE] — operator knows what to do vs what's already shipped (inherits the 12-18 status-tag convention)."
    - "Resume-signals are quoted strings the operator types verbatim — checkpoints don't auto-advance on partial completion."

key-files:
  created:
    - .planning/phases/13-ai-proxy-billing-usage-ui/13-23-SUMMARY.md
  modified: []
  pending-operator-edit:
    - "Lemon Squeezy dashboard: product '$5 Pack' + product '$20/mo Unlimited' + webhook endpoint (no repo file)"
    - "Anthropic console: Tier 2 verification — Plans & Billing tab (no repo file)"
    - "Supabase project: supabase db push --linked (applies 20260524000000_phase_13_ledger.sql + 20260524000100_rate_buckets_rpc.sql); supabase secrets set LEMON_SQUEEZY_WEBHOOK_SECRET + DISCORD_BILLING_ALERT_WEBHOOK_URL; supabase functions deploy lemon-webhook + trial-claim"
    - "Fly.io: fly launch + fly secrets set (ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_JWKS_URL, optional SENTRY_DSN) + fly deploy"
    - "electron-vite.config.ts define block: SEI_PROXY_URL + LEMON_VARIANT_PACK + LEMON_VARIANT_SUBSCRIPTION"
    - "Fly logs alerting (service_at_capacity sustained, invalid_jwt > 50/min, internal_error > 10/min)"
    - "Supabase logs alerting (lemon-webhook missing_user_id, trial-claim grant_failed)"
    - "Operator's PROXY-13 sign-off paper checklist / Notion page"

key-decisions:
  - "Phase 13 ships CODE COMPLETE across plans 13-01 through 13-22. Plan 13-23 is a SUMMARY-only deliverable (no code, no commits beyond this SUMMARY + the final phase docs commit). The runbook IS the artifact — exact secrets, exact account credentials, the eForm-equivalent for LS products, the Tier 2 verification, and the smoke-test checklist cannot be executed inside the agent session."
  - "Anthropic Tier 2 verification is Step 2 — explicitly BEFORE first paying user (PATTERNS Pitfall 5, locked by D-51 / D-44). Tier 1 launch would surface 429 storms on the very first subscriber given Sei's per-user 60 RPM subscriber cap; Tier 2 (1K RPM org-level) absorbs even worst-case bursty traffic. Auto-advancement requires $40 cumulative deposit + 14-day cooldown — operator must plan ahead."
  - "PROXY-13 Anthropic ToS framing audit is Step 10 (post-deploy, pre-launch-announcement). Five sign-off items: (a) LS product descriptions use 'proxied AI inference credits powered by Sei' not 'Anthropic API access', (b) marketing copy attributes 'powered by Anthropic Claude', (c) no 'buy Claude credits' phrasing on any contractual surface, (d) terms.html §8 Refunds is linked from LS product description, (e) ANTHROPIC_API_KEY in Fly secrets is org-owned NOT personal-account (personal-account suspension would cascade into a billing outage)."
  - "Step 8 end-to-end smoke is 13 sub-steps covering the full user journey: managed-billing switch → checkout → balance refresh → trial-claim grant on first bot summon → forward through proxy → HardStopModal → BYOK escape → subscribe → cancel → trial-gate dup-claim → rate-limit spam. Each sub-step has an explicit expected observation; any deviation aborts the rollout."
  - "Resume-signals on the four blocking checkpoints (Steps 1, 2, 8, 11) are quoted strings the operator types verbatim — 'approved — variant IDs captured: pack=<ID>, sub=<ID>' / 'approved — Tier 2 verified' / 'approved — all 13 smoke steps passed' / 'approved — Phase 13 LIVE on <DATE>'. This makes partial-completion mistakes self-evident and prevents accidental fast-forwards through the runbook."

requirements-completed: [PROXY-01, PROXY-02, PROXY-03, PROXY-07, PROXY-09, PROXY-12, PROXY-13]

# Metrics
duration: ~30min (runbook authoring; operator execution is multi-hour gated by Anthropic Tier 2 cooldown + LS product setup + Fly cold-start probing + 13-step smoke)
completed: 2026-05-23
---

# Phase 13 Plan 23: Rollout Checkpoint — Operator Runbook

**Phase 13 is CODE COMPLETE. This plan delivers the strictly-ordered operator runbook to flip Sei billing live: create two Lemon Squeezy products, verify Anthropic Tier 2 (before the first paying user), apply the ledger migration, deploy two Edge Functions, configure the LS webhook → Edge Function, deploy the Fly proxy, bake `SEI_PROXY_URL` + Lemon variant IDs into the Sei build, run the 13-step end-to-end smoke, configure Sentry / log alerts, sign off the PROXY-13 Anthropic ToS framing audit, and ship the v1.0-billing installer.**

## Phase 13 Closure Status

| Surface                                       | Status                          |
| --------------------------------------------- | ------------------------------- |
| Supabase migration (ledger + buckets + trial) | [CODE COMPLETE] — Plans 13-01 + 13-07 |
| Three-layer IPC contract (proxy / credits)    | [CODE COMPLETE] — Plan 13-02    |
| proxy/ Fly scaffold (Hono + Dockerfile + fly.toml) | [CODE COMPLETE] — Plan 13-03 |
| verifyJwt middleware (jose + JWKS)            | [CODE COMPLETE] — Plan 13-04    |
| preDeduct + pricing + tokenize + balance      | [CODE COMPLETE] — Plan 13-05    |
| settle / settleAsRefunded / settleAtReservation | [CODE COMPLETE] — Plan 13-06  |
| rate_buckets RPC + checkAllBuckets            | [CODE COMPLETE] — Plan 13-07    |
| forwardToAnthropic (verbatim body forward)    | [CODE COMPLETE] — Plan 13-08    |
| sentinel.ts + usage.ts                        | [CODE COMPLETE] — Plan 13-09    |
| App wiring + integration tests                | [CODE COMPLETE] — Plan 13-10    |
| lemon-webhook Edge Function                   | [CODE COMPLETE] — Plan 13-11    |
| trial-claim Edge Function                     | [CODE COMPLETE] — Plan 13-12    |
| proxyClient.ts + IPC wiring                   | [CODE COMPLETE] — Plan 13-13    |
| proxyJwtFetcher + rotation                    | [CODE COMPLETE] — Plan 13-14    |
| anthropicClient.js cloudMode override         | [CODE COMPLETE] — Plan 13-15    |
| useCreditsStore                               | [CODE COMPLETE] — Plan 13-16    |
| PricingIcon + IconRail integration            | [CODE COMPLETE] — Plan 13-17    |
| CreditsScreen + PercentBar                    | [CODE COMPLETE] — Plan 13-18    |
| HardStopModal                                 | [CODE COMPLETE] — Plan 13-19    |
| Settings "Cloud AI" row + BYOK escape         | [CODE COMPLETE] — Plan 13-20    |
| openExternal allowlist (sei.lemonsqueezy.com) | [CODE COMPLETE] — Plan 13-21    |
| terms.html §8 + TOS_VERSION bump (2026-05-23) | [CODE COMPLETE] — Plan 13-22    |
| Lemon Squeezy product creation                | [OPERATOR ACTION REQUIRED]      |
| Anthropic Tier 2 verification                 | [OPERATOR ACTION REQUIRED]      |
| Supabase migration apply (supabase db push)   | [OPERATOR ACTION REQUIRED]      |
| Edge Function deploy (lemon-webhook + trial-claim) | [OPERATOR ACTION REQUIRED] |
| LS webhook endpoint configuration             | [OPERATOR ACTION REQUIRED]      |
| Fly proxy deploy                              | [OPERATOR ACTION REQUIRED]      |
| SEI_PROXY_URL + variant IDs build env         | [OPERATOR ACTION REQUIRED]      |
| End-to-end smoke (13 sub-steps)               | [OPERATOR ACTION REQUIRED]      |
| Sentry / log alerts                           | [OPERATOR ACTION REQUIRED]      |
| PROXY-13 Anthropic ToS framing sign-off       | [OPERATOR ACTION REQUIRED]      |
| v1.0-billing installer release + announcement | [OPERATOR ACTION REQUIRED]      |

**All 22 prior plans in Phase 13 have shipped code. The remaining work is strictly operator-driven: create two LS products, verify a tier on the Anthropic console, push a migration, deploy two Edge Functions + a Fly app, set some secrets, run a smoke checklist, configure alerts, sign a framing checklist, and ship installers.**

---

## Operator Runbook — Strictly Ordered Checklist

Execute top to bottom. Do not skip ahead. Each step has a gate that the next step depends on. Where a step says **"resume-signal"**, type the quoted string verbatim into the operator log / Notion page once that step's gate is satisfied; this discipline catches partial-completion mistakes.

---

### Step 1 — Create Lemon Squeezy Products [OPERATOR ACTION REQUIRED]

**Time estimate:** 30-45 minutes (account signup if new + two product creates + webhook signing-secret generation).

**Why:** Phase 13 code is complete but no LS products exist yet, so `LEMON_VARIANT_PACK` and `LEMON_VARIANT_SUBSCRIPTION` (Step 7) have no values to point at. The framing in the product description is also a PROXY-13 / D-49 gate — must say "proxied AI inference credits powered by Sei", never "Anthropic API access" or "Claude access" (Anthropic ToS reseller-classification risk).

**Prerequisite account:**

- [ ] Lemon Squeezy merchant account at https://lemonsqueezy.com. Verify identity, link a payout bank account, and accept the LS Merchant-of-Record terms.
- [ ] Create a Store under a recognizable subdomain (suggested: `sei.lemonsqueezy.com` — already in the Phase 13-21 openExternal allowlist). If a different subdomain is chosen, **STOP and update `src/main/openExternalAllowlist.ts` first** before continuing — the openExternal call from `proxyClient.subscribeStart` will silently no-op if the host is not on the allowlist.

**Create Product "Sei Credits — $5 Pack":**

- [ ] Type: **one-time** (NOT subscription).
- [ ] Price: $5.00 USD.
- [ ] Variant: single variant; capture its **Variant ID** (numeric, ~6 digits).
- [ ] Description (verbatim — copy/paste; PROXY-13 framing is locked):

```
Proxied AI inference credits powered by Sei. Use Sei to chat with your bot.
Unused credits are refundable within 14 days.
See https://sei.gg/terms.html#refunds for the refund policy.
```

- [ ] **Forbidden phrases (D-49 / PROXY-13):** Do NOT write "Anthropic API access", "Claude access", "buy API credits", "Claude credits", "API key resale", or any equivalent. Step 10 audits this surface; lint your own copy before committing.
- [ ] Optional: marketing copy on the LS product page MAY include "powered by Anthropic Claude" as attribution (encouraged — gives proper attribution without reselling claims).

**Create Product "Sei Unlimited — $20/month":**

- [ ] Type: **subscription** (recurring monthly).
- [ ] Price: $20.00 USD/month.
- [ ] Variant: single variant; capture its **Variant ID**.
- [ ] Description (verbatim):

```
Monthly subscription for proxied AI inference, powered by Sei.
Cancel anytime via the customer portal.
See https://sei.gg/terms.html#refunds for the cancellation policy.
```

- [ ] Same forbidden phrases as the pack product.

**Generate webhook signing secret:**

- [ ] LS Dashboard → Settings → Webhooks → Generate signing secret.
- [ ] Capture the secret as `LEMON_SQUEEZY_WEBHOOK_SECRET`. **DO NOT** add the webhook endpoint yet — Step 5 wires the URL after the Edge Function is deployed.

**Evidence (PROXY-13 pre-launch audit material):**

- [ ] Screenshot both product pages (description + price + variant ID visible) to the operator's Notion / paper log. Step 10 sign-off references these.

**Gate to next step:** Both products visible in LS dashboard with the correct framing; both variant IDs captured; `LEMON_SQUEEZY_WEBHOOK_SECRET` captured.

**Resume-signal:** `approved — variant IDs captured: pack=<ID>, sub=<ID>`

---

### Step 2 — Verify Anthropic Tier 2 [OPERATOR ACTION REQUIRED]

**Time estimate:** 5 minutes if Tier 2 is already active. **Up to 14 days** if you are currently on Tier 1 and need to provision Tier 2 (D-51 + PATTERNS Pitfall 5 — this is the longest pre-launch cooldown in the runbook). **Plan ahead.**

**Why:** Phase 13's per-user rate caps (D-51) are sized for a Tier 2 org account (1K RPM / 450K input TPM cache-reads-excluded / 90K output TPM per model on `claude-haiku-4-5`). On Tier 1 (50 RPM / 50K input TPM / 10K output TPM), a single concurrent subscriber on the 60 RPM subscriber cap would already exceed the org budget — every paying user past the first would face cascading 429 → 503 service_at_capacity responses, and the proxy's translation of 429 → `service_at_capacity` (D-44) would surface "Sei is at capacity, try again in a moment" to every user simultaneously. **This is the Pitfall 5 launch-killer.** Tier 2 MUST be active BEFORE the first paying user lands.

**Anthropic auto-advancement rule:** Tier 2 is automatic at **$40 cumulative deposit + 14 days from first deposit**. There is no manual upgrade path; depositing more than $40 does not shorten the 14-day cooldown. If today is your first $40 deposit, the rollout is gated by 14 days from now.

**Steps:**

- [ ] Sign in to https://platform.claude.com → **Plans & Billing** (top-right user menu).
- [ ] Confirm the dashboard shows **"Tier 2"** on the active organization.
- [ ] If on **Tier 1**:
  - [ ] Confirm a payment method is on file (Settings → Billing).
  - [ ] Top up at least $40 in a single deposit (Plans & Billing → Add credit).
  - [ ] Record the deposit timestamp; Tier 2 unlocks 14 days from that timestamp.
  - [ ] **STOP — return to this step in 14 days and re-verify.** Do not proceed past Step 2 until the dashboard shows Tier 2.
- [ ] Once Tier 2 is active, confirm the limits on the rate-limits page (https://console.anthropic.com/settings/limits):
  - [ ] `claude-haiku-4-5` → 1,000 RPM
  - [ ] `claude-haiku-4-5` → 450,000 input TPM (cache-reads excluded)
  - [ ] `claude-haiku-4-5` → 90,000 output TPM
- [ ] Confirm the API key in use is **organization-owned**, NOT a personal-account key (Settings → API Keys → look at the "Workspace" / "Org" column). If only a personal key exists, create an org-scoped key NOW — Step 10 (PROXY-13 sign-off) explicitly verifies this and a personal-account suspension would cascade into a billing outage with no failover.

**Tier 3 forward-look (not blocking):** Tier 3 unlocks at ~$400 cumulative + 14 days. The Step 9 Sentry alert on sustained `service_at_capacity` (Anthropic 429s) is the upgrade trigger. No Tier 3 is needed at launch; the alert is enough.

**Gate to next step:** Anthropic dashboard shows Tier 2; the API key intended for Fly secrets is org-owned (not personal).

**Resume-signal:** `approved — Tier 2 verified`

---

### Step 3 — Apply Phase 13 Database Migrations [OPERATOR ACTION REQUIRED]

**Time estimate:** 5 minutes.

**Why:** Plans 13-01 + 13-07 wrote the two migration files; they live in `supabase/migrations/` but no rows have been touched in the linked Supabase project. Without applying them, Step 4 (Edge Function deploy) succeeds but the functions immediately 500 on first invocation because `ledger_grants`, `subscription_status`, `trial_claims`, `rate_buckets`, etc., don't exist.

**Prerequisite:**

- [ ] Supabase CLI installed: `brew install supabase/tap/supabase` (macOS) or per https://supabase.com/docs/guides/local-development.
- [ ] `supabase login` + `supabase link --project-ref <project-ref>` already run during Phase 12 rollout. If not, re-link now.

**Run:**

```bash
cd /Users/ouen/slop/sei
supabase db push --linked
```

**Expected output:** Two migrations applied:
- `20260524000000_phase_13_ledger.sql`
- `20260524000100_rate_buckets_rpc.sql`

**Verify (Supabase Dashboard → Database → Tables):**

- [ ] Table `ledger_grants` exists with columns `id, user_id, kind, credits_micro, source, lemon_event_id, granted_at, expires_at`.
- [ ] Table `ledger_consumption` exists.
- [ ] Table `subscription_status` exists.
- [ ] Table `rate_buckets` exists.
- [ ] Table `trial_claims` exists.
- [ ] Table `user_balance_lock` exists.
- [ ] VIEW `ledger_balance` exists (Dashboard → Database → Views).
- [ ] FUNCTION `reserve_credits` exists (Dashboard → Database → Functions).
- [ ] FUNCTION `settle_consumption` exists.
- [ ] FUNCTION `check_and_increment_bucket` exists.
- [ ] CRON job `rate_buckets_cleanup` is scheduled at `10 3 * * *` (Dashboard → Database → Cron Jobs). Note: this is intentionally offset 10 minutes from Phase 12's `0 3 * * *` jobs (RESEARCH §pg_cron contention).

**RLS smoke (SQL editor):**

```sql
-- service_role can INSERT (should succeed)
SET ROLE service_role;
INSERT INTO rate_buckets (user_id, bucket_kind, count, window_start)
  VALUES ('00000000-0000-0000-0000-000000000000', 'rpm', 1, now())
  RETURNING id;

-- Clean up
DELETE FROM rate_buckets WHERE user_id = '00000000-0000-0000-0000-000000000000';
RESET ROLE;
```

If the INSERT returns 0 rows, RLS is blocking service_role — investigate the migration's policy block (`reserve_credits` should run as `security definer`).

**Gate to next step:** All six tables + view + three functions + cron job visible. Service-role INSERT into `rate_buckets` succeeds.

---

### Step 4 — Deploy Edge Functions [OPERATOR ACTION REQUIRED]

**Time estimate:** 10 minutes (set 2 secrets + deploy 2 functions + curl smoke).

**Why:** `lemon-webhook` (13-11) needs `LEMON_SQUEEZY_WEBHOOK_SECRET` (from Step 1) for HMAC verification and `DISCORD_BILLING_ALERT_WEBHOOK_URL` for missing-user-id reconciliation alerts. `trial-claim` (13-12) reads the standard Supabase env vars (auto-injected). Both must be deployed before Step 5 wires the LS webhook to the URL.

**Set secrets:**

- [ ] Create a Discord webhook for billing alerts: Discord server → channel (suggested: `#billing-alerts`) → Edit Channel → Integrations → Webhooks → New Webhook → copy URL. Treat as secret-equivalent.
- [ ] Set both secrets:

```bash
cd /Users/ouen/slop/sei
supabase secrets set LEMON_SQUEEZY_WEBHOOK_SECRET='<from Step 1>' --linked
supabase secrets set DISCORD_BILLING_ALERT_WEBHOOK_URL='https://discord.com/api/webhooks/<id>/<token>' --linked

# Verify
supabase secrets list --linked
```

**Deploy:**

```bash
supabase functions deploy lemon-webhook --linked
supabase functions deploy trial-claim --linked
```

**Smoke (curl from your laptop):**

```bash
# trial-claim: should return 401 missing_jwt without Authorization header
curl -i -X POST https://<project-ref>.supabase.co/functions/v1/trial-claim \
  -H 'Content-Type: application/json' \
  -d '{"mc_username":"test"}'
# Expected: HTTP/2 401 {"error":"missing_jwt"}

# lemon-webhook: should return 401 missing_signature without X-Signature header
curl -i -X POST https://<project-ref>.supabase.co/functions/v1/lemon-webhook \
  -H 'Content-Type: application/json' \
  -d '{}'
# Expected: HTTP/2 401 {"error":"missing_signature"}
```

**Verify (Supabase Dashboard → Edge Functions → Logs):**

- [ ] `trial-claim` log line shows `missing_jwt` envelope returned (NOT a 500 / unhandled error).
- [ ] `lemon-webhook` log line shows `missing_signature` envelope returned.
- [ ] Neither curl produced a 500 / panic.

**Gate to next step:** Both Edge Functions deployed; both 401 envelopes verified via curl; both visible in Edge Functions list.

---

### Step 5 — Configure Lemon Squeezy Webhook Endpoint [OPERATOR ACTION REQUIRED]

**Time estimate:** 10 minutes (configure URL + select events + send test event + verify Discord alert).

**Why:** With the Edge Function deployed (Step 4), LS now needs to know where to POST events. The webhook URL must point at the deployed `lemon-webhook` function URL. Selected events drive all credit grants — missing one means a class of purchases fails silently.

**Steps:**

- [ ] LS Dashboard → Settings → Webhooks → **Add Webhook**.
- [ ] URL: `https://<project-ref>.supabase.co/functions/v1/lemon-webhook` (use the same project-ref as Step 4).
- [ ] Signing secret: **reuse** the secret from Step 1 (LS lets you reveal/copy it via "Reveal signing secret"). Confirm it matches `LEMON_SQUEEZY_WEBHOOK_SECRET` set in Step 4.
- [ ] Events to enable (all six per D-46):
  - [ ] `order_created`
  - [ ] `subscription_created`
  - [ ] `subscription_updated`
  - [ ] `subscription_payment_success`
  - [ ] `subscription_cancelled`
  - [ ] `subscription_expired`
- [ ] Save the webhook.

**Test the wiring:**

- [ ] In the webhook detail page, click **"Send test event"**.
- [ ] LS sends a sample `order_created` payload (with no `custom_data.user_id` — that's expected for the test event).
- [ ] LS webhook delivery log should show `200 OK` within ~2 seconds.

**Verify (Supabase Dashboard → Edge Functions → lemon-webhook → Logs):**

- [ ] Log line: signature verification passed (HMAC matched).
- [ ] Log line: `missing_user_id` branch triggered (because the test event lacks custom_data.user_id).
- [ ] Log line: Discord webhook fired.

**Verify (Discord billing-alerts channel):**

- [ ] A bot message arrives within ~15 seconds saying something like "Webhook received but missing user_id — manual reconciliation needed" (exact copy lives in `supabase/functions/lemon-webhook/index.ts`).

**Gate to next step:** Test event delivered with 200; Edge Function logs show signature OK + missing_user_id path; Discord billing-alerts channel received the alert.

---

### Step 6 — Deploy Fly.io Proxy [OPERATOR ACTION REQUIRED]

**Time estimate:** 20-30 minutes (first-time flyctl install + auth + secret-set × 4 + deploy + /health smoke + optional custom domain).

**Why:** The Fly proxy is the on-the-wire surface that every paying user's bot calls. Without it deployed and addressable, the Sei build's `SEI_PROXY_URL` (Step 7) points at a 404 and every bot summon fails. The proxy ALSO holds the `ANTHROPIC_API_KEY` — this secret MUST live in Fly secrets, NEVER in a git-tracked file.

**Prerequisite:**

- [ ] flyctl installed: `brew install flyctl` (macOS) or per https://fly.io/docs/hands-on/install-flyctl.
- [ ] `fly auth login` complete; the operator's Fly organization is selected.
- [ ] Confirm `/Users/ouen/slop/sei/proxy/` exists with the Phase 13-03 scaffold (Dockerfile, fly.toml, package.json with pinned versions, src/index.ts).
- [ ] Confirm `/Users/ouen/slop/sei/proxy/.env` is NOT tracked by git (`git check-ignore proxy/.env` should print `proxy/.env`). If it's tracked, **STOP** — fix `.gitignore` BEFORE continuing or you risk committing real secrets in Step 10's lint.

**Provision the app:**

```bash
cd /Users/ouen/slop/sei/proxy
fly launch --copy-config --name sei-proxy --region iad --no-deploy
```

**Why `--copy-config`:** Reuses the pre-committed `fly.toml` (region iad, 256MB, scale 0-2, soft 20 / hard 50 — all per D-38). **Do not let `fly launch` rewrite it.**

**Why `--no-deploy`:** Secrets must be set BEFORE the first deploy or the proxy boots, fails `env.ts` Zod validation, and exits — wasting a build.

**Set secrets:**

```bash
fly secrets set ANTHROPIC_API_KEY='sk-ant-<...org-owned key from Step 2...>' -a sei-proxy
fly secrets set SUPABASE_URL='https://<project-ref>.supabase.co' -a sei-proxy
fly secrets set SUPABASE_SERVICE_ROLE_KEY='<from Supabase project settings → API → service_role>' -a sei-proxy
fly secrets set SUPABASE_JWKS_URL='https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json' -a sei-proxy

# Optional but recommended for Step 9 alerts:
fly secrets set SENTRY_DSN='https://<...>@<...>.ingest.sentry.io/<id>' -a sei-proxy

# Verify (values are NOT printed; only names + last-touched timestamps)
fly secrets list -a sei-proxy
```

**Critical: `ANTHROPIC_API_KEY` must be the ORG-owned key from Step 2, NOT a personal-account key.** Step 10 sign-off explicitly verifies this.

**Deploy:**

```bash
fly deploy -a sei-proxy
```

**First deploy takes ~3-5 minutes** (Docker multi-stage build + image push + machine create). Subsequent deploys are ~60-90s.

**Smoke:**

```bash
# Health check
curl -i https://api.sei.gg/health
# Expected: HTTP/2 200 {"status":"ok","version":"1.0.0"}

# Cold-start probe (after ~5 min idle)
# First request may take 3-5s; subsequent <100ms
curl -w "%{time_total}\n" -o /dev/null -s https://api.sei.gg/health

# Unauthenticated /v1/messages should 401
curl -i -X POST https://api.sei.gg/v1/messages \
  -H 'Content-Type: application/json' \
  -d '{"model":"claude-haiku-4-5","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}'
# Expected: HTTP/2 401 {"error":"missing_jwt"}
```

**Optional — custom domain (e.g., `proxy.sei.gg`):**

```bash
fly certs create proxy.sei.gg -a sei-proxy
# Add the CNAME record per Fly's instructions to your DNS provider.
# Wait for cert issuance (~2-10 min).
fly certs show proxy.sei.gg -a sei-proxy
# Expected: status = "ready"
```

If using a custom domain, the Step 7 `SEI_PROXY_URL` becomes `https://proxy.sei.gg`. Confirm the openExternal allowlist (Phase 13-21) doesn't need a new entry — `proxy.sei.gg` is called via `fetch()` from the bot process, not `shell.openExternal`, so no allowlist change.

**Verify (one more time before next step):**

- [ ] `git status` in `/Users/ouen/slop/sei/proxy/` shows **NO untracked or modified files containing secrets**. The four secrets are in Fly's secret store ONLY.
- [ ] `grep -r 'sk-ant' /Users/ouen/slop/sei/` returns nothing.
- [ ] `grep -r 'service_role' /Users/ouen/slop/sei/proxy/` shows only TypeScript type references, no literal keys.

**Gate to next step:** `/health` returns 200; unauthenticated `/v1/messages` returns 401 `missing_jwt`; no secrets in any git-tracked file.

---

### Step 7 — Configure SEI_PROXY_URL + Variant IDs Build Env [OPERATOR ACTION REQUIRED]

**Time estimate:** 10 minutes (edit electron-vite config + rebuild + smoke).

**Why:** The Sei desktop app reads `SEI_PROXY_URL`, `LEMON_VARIANT_PACK`, and `LEMON_VARIANT_SUBSCRIPTION` from the electron-vite `define` block at build time (Plan 13-13 wired this — see `src/main/proxyClient.ts` and `src/renderer/src/screens/CreditsScreen.tsx` consumers). Without them baked in, `subscribeStart` opens `https://sei.lemonsqueezy.com/buy/undefined?...` and the user lands on a 404.

**Edit `/Users/ouen/slop/sei/electron-vite.config.ts`** (the file Plan 13-13 set up to consume these). Locate the `define` block (or `process.env` / `import.meta.env` mapping) for the renderer + main + bot processes. Add or update:

```ts
define: {
  'import.meta.env.SEI_PROXY_URL': JSON.stringify('https://api.sei.gg'),
  // OR if using custom domain: JSON.stringify('https://proxy.sei.gg')
  'import.meta.env.LEMON_VARIANT_PACK': JSON.stringify('<variant ID from Step 1>'),
  'import.meta.env.LEMON_VARIANT_SUBSCRIPTION': JSON.stringify('<variant ID from Step 1>'),
},
```

(Exact key shape depends on how Plan 13-13 wired the consumers — `import.meta.env.X`, `process.env.X`, or a `globalThis.SEI_*` global. Match the consumer's import path.)

**Rebuild:**

```bash
cd /Users/ouen/slop/sei
npm run build
```

**Verify (build artifacts contain the values):**

```bash
# Production renderer bundle should have the literal proxy URL baked in
grep -r 'api.sei.gg' out/ dist/ 2>/dev/null | head -3
# Expected: at least one hit in the renderer chunk(s)

# Same for variant IDs
grep -r '<pack-variant-ID>' out/ dist/ 2>/dev/null | head -3
# Expected: at least one hit
```

If the greps return 0 hits, the `define` block is wired to the wrong key shape — debug Plan 13-13's consumer imports first.

**Gate to next step:** Production Sei build artifacts contain the live proxy URL + both Lemon variant IDs. `npm run build` exits 0 with no errors.

---

### Step 8 — End-to-End Smoke Test [OPERATOR ACTION REQUIRED]

**Time estimate:** 45-90 minutes (13 sub-steps; subscription cancel propagation adds latency; rate-limit spam requires 60-second window).

**Why:** This is the integration gate. Every piece of Phase 13 is now deployed and configured — this test confirms a real signed-in user can purchase credits, consume them through the proxy, hit the hard-stop modal, escape to BYOK, return to managed billing, subscribe, cancel, and trip both anti-abuse circuits. Any sub-step failure aborts the rollout.

**Prerequisite:**

- [ ] Run the rebuilt Sei app from Step 7 locally (`npm run start` or the packaged installer if Step 11 is being previewed).
- [ ] Have a test Sei account already signed in (e.g., `test@sei.gg`) — sign-up flow itself is Phase 10/11 territory and out of scope here.
- [ ] Have a LAN Minecraft world running (offline-mode, your test MC username matches the Sei-account-bound MC username — D-42b enforces this).
- [ ] Have a test card ready: Stripe-compatible LS test card is `4242 4242 4242 4242` with any future expiry + any 3-digit CVC. Real charges in LS test mode are not captured but webhooks fire as if real.

**Sub-step 1 — Switch to managed billing:**

- [ ] Sign in via Sei. Settings → Cloud AI row → click "Switch to managed billing".
- [ ] **Expected:** `aiBackendKind` flips to `cloud-proxy`. The Settings row helper text updates to the "managed cloud" copy.
- [ ] **Expected:** A new pricing icon appears in the left vertical icon rail directly above Settings (per D-54).

**Sub-step 2 — Open CreditsScreen at zero balance:**

- [ ] Click the new pricing icon.
- [ ] **Expected:** CreditsScreen renders with three blocks: USAGE bar at 0%, TOP UP tile ($5 Pack button), UNLIMITED tile ($20/mo button). Plan label says "Depleted" or similar (no balance, no trial claimed yet).
- [ ] **Forbidden observation:** No dollar amounts on the screen. No token counts. No "$5" or "$20" rendered as numeric text inside the USAGE bar or its labels. (D-55 / PROXY-05 — the LS buttons are allowed to say "Top up $5 Pack" since that's checkout-context; the USAGE block must not.)

**Sub-step 3 — Complete checkout with the $5 pack:**

- [ ] Click "Top up" on the $5 Pack tile.
- [ ] **Expected:** LS checkout opens in the user's default browser (via `shell.openExternal` to `https://sei.lemonsqueezy.com/buy/<LEMON_VARIANT_PACK>?checkout[custom][user_id]=<jwt.sub>`).
- [ ] Complete checkout with test card `4242 4242 4242 4242`, any future expiry, any CVC.
- [ ] LS confirmation page renders. Close the browser tab.

**Sub-step 4 — Verify webhook attribution + balance refresh:**

- [ ] Within ~10 seconds (LS webhook fan-out + Edge Function process + push-channel propagation), return to Sei.
- [ ] **Expected:** CreditsScreen USAGE bar updates to ~95% (4,750,000 µ$ of the 5,000,000 µ$ daily cap — exact-percentage math rounds to nearest 5 per D-41).
- [ ] **Expected:** Plan label updates from "Depleted" to "Pack".
- [ ] **Expected (Supabase Dashboard → Database → ledger_grants):** A new row exists with `kind='pack', credits_micro=4750000, lemon_event_id=<LS event UUID>, user_id=<test user>`.
- [ ] **Expected (Supabase Dashboard → Edge Functions → lemon-webhook logs):** Signature OK + grant inserted, no errors.

**Sub-step 5 — Pricing icon visual:**

- [ ] Look at the pricing icon in the left rail (without opening CreditsScreen).
- [ ] **Expected:** The icon glyph is partially filled bottom-up, matching the USAGE bar's ~95% (D-54 — fill animation per PercentBar primitive).
- [ ] **Expected:** Hovering for ≥200ms shows the tooltip "95% credits left · click for details".

**Sub-step 6 — First bot summon triggers trial claim + proxy forward:**

- [ ] In Sei, summon a bot in the LAN Minecraft world. The first message you send via in-game chat or the GUI chat input should:
  - [ ] (a) Trigger `trial-claim` (the bot's first proxied call detects empty ledger → wait, actually the user already has a pack credited, so trial-claim either grants $1 more or no-ops with `already_claimed`).
  - [ ] (b) Forward through the proxy → return a normal Anthropic response (the bot's reply renders in-game / in-GUI).
  - [ ] (c) `remaining_pct` visibly decrements on the next pricing-icon tooltip read (e.g., 95% → 90% after a few exchanges).
- [ ] **Expected (Supabase Dashboard → trial_claims):** A row exists with `mc_username=<test MC username>, sei_user_id=<test user>, claimed_at=<now>`.
- [ ] **Expected (Supabase Dashboard → ledger_consumption):** A row with `reservation_state='settled', micro=<actual cost>, anthropic_call_id=<set>`. Cache savings should already be reflected (actual < reservation; refund delta returned to balance).

**Sub-step 7 — Continue chatting to depletion:**

- [ ] Keep chatting in the LAN world until the balance approaches 0. (For a $5 pack you may need to send ~500-1000 messages depending on token mix; this can be slow. Alternative: directly UPDATE the ledger to a near-zero balance via SQL editor for faster smoke — note this as a deviation if you do.)
- [ ] **Expected at remaining_pct == 0:** The HardStopModal appears with persona-aware copy.
- [ ] **Expected modal title:** "You're out of credits" (D-56).
- [ ] **Expected modal body:** Persona-aware copy from `hardStopCopy.ts` (e.g., for Sui: "Sui's hungry for more conversation — top up to keep going?"). For a custom persona, "<name> needs more credits to keep talking."
- [ ] **Expected modal CTAs (three):** "Top up $5" / "Go unlimited $20/mo" / "Switch to your own API key". ESC does NOT dismiss (per AcceptToSModal-inherited gate logic).
- [ ] **Forbidden observation:** No token counts in the modal. No "$5" / "$20" inside the body copy block (the CTA buttons themselves are explicit; the body is persona-only).

**Sub-step 8 — BYOK escape hatch:**

- [ ] Click "Switch to your own API key" in the modal.
- [ ] **Expected:** Modal closes; the pricing icon disappears from the left rail (CreditsScreen unmounts entirely per PROXY-11 — defense-in-depth via UNMOUNT not CSS-hide).
- [ ] **Expected:** Settings → Cloud AI row now shows the BYOK state ("Use your own Anthropic API key — paste below").
- [ ] **Expected:** The bot reverts to BYOK path — next chat call goes directly to Anthropic with the user-pasted key, NOT through the proxy. (Verify by tailing `fly logs -a sei-proxy` and confirming no new requests arrive when the user chats in BYOK mode.)

**Sub-step 9 — Switch back to managed billing + subscribe:**

- [ ] Settings → Cloud AI → "Switch to managed billing" again.
- [ ] **Expected:** Pricing icon returns. CreditsScreen renders. Plan label = "Pack" (the previous pack balance is still on the ledger; switching aiBackendKind doesn't burn credits).
- [ ] Open CreditsScreen → click "Go unlimited" on the $20/mo tile.
- [ ] LS checkout opens for the subscription variant. Complete with test card `4242 4242 4242 4242`.
- [ ] **Expected within ~10s:** `subscription_status` row upserted to `status='active', current_period_end=<+1 month>`.
- [ ] **Expected:** CreditsScreen plan label updates to "Unlimited" and the $20/mo tile flips to "Manage subscription" + "Next renewal: <date>".

**Sub-step 10 — Customer portal access:**

- [ ] Click "Manage subscription".
- [ ] **Expected:** LS customer portal opens via `shell.openExternal` to `https://sei.lemonsqueezy.com/billing` (D-57 / Phase 13-21 allowlist).

**Sub-step 11 — Cancel subscription:**

- [ ] In the LS customer portal, click "Cancel subscription".
- [ ] LS confirms cancellation; the user's access continues to end-of-period (no proration — per D-48 / terms.html §8).
- [ ] **Expected within ~10s:** `subscription_status` row flips to `status='cancelled'` (or similar — exact enum per Plan 13-11).
- [ ] **Expected:** CreditsScreen helper text updates (subscription ends on `<date>`; tile flips back to "Go Unlimited" once `current_period_end` passes — note: end-of-period not tested live; can be verified via direct SQL `UPDATE subscription_status SET current_period_end = now() - interval '1 minute'`).

**Sub-step 12 — Trial gate dup-claim (anti-abuse):**

- [ ] Sign out. Sign in as a second test Sei account (e.g., `test2@sei.gg`).
- [ ] Switch to managed billing. Attempt to summon a bot using the SAME MC username as `test@sei.gg`.
- [ ] **Expected:** The trial-claim call returns `409 already_claimed` (per D-42 + Plan 13-12 idempotency).
- [ ] **Expected:** Sei surfaces a clean error message (specific copy per Plan 13-12 — should NOT crash, NOT silently drop).
- [ ] **Expected (Supabase Dashboard → trial_claims):** Still exactly one row for that mc_username (the original from sub-step 6).

**Sub-step 13 — Rate-limit smoke (anti-abuse):**

- [ ] Switch back to `test@sei.gg` (or any account with credits remaining).
- [ ] In rapid succession (within ~60 seconds), send 25 short bot messages.
- [ ] **Expected:** The first 20 succeed (per D-51 subscriber RPM cap of 60 — adjust if running on trial tier's 20 RPM cap, in which case the threshold is 20).
- [ ] **Expected:** The 21st (or 61st if subscriber) onwards returns `429 {error:'rate_limited', kind:'rpm', retry_after_seconds:<int>}`.
- [ ] **Expected:** The Sei renderer shows an inline rate-limit banner with a countdown (NOT a modal — D-52). Chat input is disabled for the duration.
- [ ] **Expected:** Banner clears automatically when `retry_after_seconds` reaches 0; chat input re-enables.

**Gate to next step:** All 13 sub-steps pass. Document any deviations / surprises in the operator log.

**Resume-signal:** `approved — all 13 smoke steps passed`

---

### Step 9 — Configure Sentry / Log Alerts [OPERATOR ACTION REQUIRED]

**Time estimate:** 30-45 minutes (Sentry signup if new + DSN provision + 5 alert rules across Fly + Supabase).

**Why:** Phase 13's failure modes are mostly silent — Anthropic 429s, JWT verification anomalies, webhook attribution failures, trial-grant atomicity gaps. Without alerts, the operator only notices when users complain on Discord, which is too late. D-44 + PATTERNS specifies sustained `service_at_capacity` as the Tier-3 upgrade trigger; without an alert the operator never knows to push for Tier 3.

**Prerequisite (Sentry — recommended; alternative is Fly + Supabase native log alerts):**

- [ ] Sentry account at https://sentry.io with a free project named `sei-proxy`.
- [ ] Capture the project DSN.
- [ ] (Already done if Step 6's optional `SENTRY_DSN` secret was set in Fly — verify with `fly secrets list -a sei-proxy`.)

**Five alert categories to configure:**

#### 9.1 — Fly proxy: sustained Anthropic 429s → Tier 3 upgrade trigger

- [ ] Sentry → Alerts → Create Rule.
- [ ] Condition: Number of events matching `event.message:"service_at_capacity"` over **1 hour ≥ 20 occurrences** (tune after observing baseline).
- [ ] Action: Send Discord notification + email to operator.
- [ ] **Why:** D-44 mapping — Anthropic 429 → proxy returns 503 service_at_capacity. Sustained occurrences = org tier 2 saturated → time to push for Tier 3 (~$400 cumulative + 14d cooldown, plan ahead).

#### 9.2 — Fly proxy: invalid_jwt spike → JWT signing / JWKS issue

- [ ] Sentry → Alerts → Create Rule.
- [ ] Condition: Number of `event.message:"invalid_jwt"` events ≥ **50/min over 5 minutes**.
- [ ] Action: Discord + email + page (this is a P1 — credentialing broken, likely affects all users).
- [ ] **Why:** Sudden invalid_jwt spike usually means Supabase rotated the JWT signing key + JWKS cache hasn't refreshed (1h cache per D-39) OR the Supabase project's anon-flow misconfigured.

#### 9.3 — Fly proxy: internal_error spike → proxy bug

- [ ] Sentry → Alerts → Create Rule.
- [ ] Condition: `event.level:error AND event.message:"internal_error"` ≥ **10/min over 5 minutes**.
- [ ] Action: Discord + email.
- [ ] **Why:** internal_error = uncaught exception in proxy (env validation, Postgres connection drop, malformed Anthropic response, etc.). Unbounded rate = roll back the deploy.

#### 9.4 — Supabase logs: lemon-webhook missing_user_id → reconciliation queue

- [ ] Supabase Dashboard → Edge Functions → Logs → Create alert (or use Supabase Log Drain to Sentry / Discord).
- [ ] Condition: `function:lemon-webhook AND message:"missing_user_id"` over any window.
- [ ] Action: Discord billing-alerts channel (already wired in-function via `DISCORD_BILLING_ALERT_WEBHOOK_URL` from Step 4 — so a Sentry alert here is defense-in-depth; the in-function alert is the primary).
- [ ] **Why:** Failed-to-attribute purchases need MANUAL reconciliation — the operator emails the customer, identifies which Sei account they used, and grants credits via SQL. Without this alert, customers who slip through (e.g., signed-up via LS before having a Sei account) get charged with no credits delivered.

#### 9.5 — Supabase logs: trial-claim grant_failed → atomicity gap

- [ ] Supabase Dashboard → Edge Functions → Logs → Create alert.
- [ ] Condition: `function:trial-claim AND message:"grant_failed"`.
- [ ] Action: Discord billing-alerts channel + email.
- [ ] **Why:** Plan 13-12's compensating-delete path catches grant failures, but a hard crash between the `trial_claims` INSERT and the `ledger_grants` INSERT can leave an mc_username locked out without a trial credit. Operator needs to find these and either grant manually or DELETE the stuck trial_claims row.

#### 9.6 — Manual cadence: monthly Anthropic tier review

- [ ] Add a calendar reminder (operator's calendar) for **monthly Anthropic tier-status review** — Plans & Billing → check cumulative spend → if approaching $400, file the Tier 3 request (no API for tier promotion; dashboard-only per Anthropic policy).

**Gate to next step:** All five alerts configured + monthly calendar reminder set. Test the first three by triggering them artificially (e.g., curl 51 invalid-JWT requests in a row to fire alert 9.2) and confirming the Discord / email arrives.

---

### Step 10 — PROXY-13 Anthropic ToS Framing Sign-Off [OPERATOR ACTION REQUIRED]

**Time estimate:** 15 minutes (audit five sign-off items + capture evidence + paper-checklist sign).

**Why:** D-49 is a legal-compliance hard-gate. Anthropic's commercial terms permit "Sei as a service" backed by API access, but reselling the API itself (or marketing it as such) is prohibited and triggers reseller-classification. PROXY-13 is the explicit "operator confirms in writing pre-launch" gate. This is the LAST step before flipping the public-availability switch — once installers are out (Step 11), backing out is expensive.

**Sign-off items (operator confirms each by initialing the operator log / Notion checklist; suggested template inline):**

#### 10.1 — Lemon Squeezy product descriptions use approved framing

- [ ] Open https://sei.lemonsqueezy.com (the live store, NOT the dashboard).
- [ ] Open the `$5 Pack` product page; confirm description starts with "Proxied AI inference credits powered by Sei."
- [ ] Open the `$20/mo Unlimited` product page; confirm description starts with "Monthly subscription for proxied AI inference, powered by Sei."
- [ ] **Forbidden phrase audit:** `grep -i 'anthropic api\|claude api\|api credits\|claude credits\|api key' <screenshot OCR or copy-paste>` → must return 0 hits.
- [ ] **Evidence:** Save screenshots of both live product pages to the operator log. These are the primary PROXY-13 audit artifacts.

#### 10.2 — Marketing copy attributes "powered by Anthropic Claude"

- [ ] If the LS product page or sei.gg marketing surface mentions "powered by Anthropic Claude" (or similar) as attribution, this is encouraged — proper attribution without resale claims.
- [ ] If neither surface mentions Anthropic at all, that's also acceptable (PROXY-13 doesn't REQUIRE attribution; it forbids resale framing).
- [ ] Confirm whichever choice was made is consistent across LS + sei.gg + terms.html.

#### 10.3 — No "buy API access" / "Claude credits" anywhere on contractual surface

- [ ] Grep the live terms.html (deployed by 13-22): `curl -s https://sei.gg/terms.html | grep -i 'api access\|claude credits\|anthropic api'` → must return 0 hits.
- [ ] Grep the live privacy.html: same audit.
- [ ] Confirm the LS product page descriptions don't link to or quote Anthropic's documentation in a resale-suggestive way.

#### 10.4 — terms.html §8 Refunds is linked from LS product description

- [ ] Open both LS product page descriptions. Confirm both contain a literal text link to `https://sei.gg/terms.html#refunds` (D-48 + Plan 13-22 anchor).
- [ ] Click the link; confirm the browser navigates to the §8 Refunds section of the live terms.html.
- [ ] **Evidence:** Screenshot the LS product page with the link visible.

#### 10.5 — ANTHROPIC_API_KEY in Fly secrets is org-owned (NOT personal-account)

- [ ] Anthropic Console → Settings → API Keys → locate the key with the last-four characters matching the one set in Step 6.
- [ ] Confirm its "Workspace" / "Organization" column shows the operator's BUSINESS workspace, NOT a personal-account workspace.
- [ ] **Why this matters:** A personal-account API key is subject to personal-account suspension (e.g., billing card decline, ToS-flag on a personal project). Suspension cascades into a Sei-wide billing outage with no failover. An org-owned key is independently provisioned + recoverable.
- [ ] **Evidence:** Screenshot the Anthropic API Keys table with the workspace column visible (redact the key value itself before saving).

**Paper checklist sign-off:**

- [ ] Operator types their full name + today's date + "PROXY-13 audit complete" into the operator log / Notion page.
- [ ] If the operator is acting on behalf of a business entity (e.g., LLC formed later), append the entity name. For Phase 13 v1.0 (no-LLC per PROJECT.md), the operator's personal name is sufficient.

**Gate to next step:** All five sign-off items initialed + dated. Screenshots saved to the operator log.

---

### Step 11 — Final Config Flip + Production Launch Announcement [OPERATOR ACTION REQUIRED]

**Time estimate:** 1-2 hours (release tag + installer build × 3 platforms + clean-VM smoke + publish + announce).

**Why:** All infrastructure is live; this is the gated public-availability flip. The previous 10 steps have validated end-to-end on a developer machine — this step validates the PACKAGED installer on a clean OS image (the native-ABI invariant from CLAUDE.md: mineflayer + better-sqlite3 + secp256k1 etc. need `@electron/rebuild` to run as part of `electron-builder`, which only manifests on a clean machine).

**Steps:**

#### 11.1 — Confirm Phase 12 BROWSE_ENABLED status

- [ ] Check `.planning/STATE.md` and `.planning/ROADMAP.md` for Phase 12-18 completion status.
- [ ] If `browse_enabled=true` is already flipped live in the production `userData/config.json` for the v1.0 release channel, no change needed — Phase 13 ships alongside.
- [ ] If Phase 12 is NOT live yet, decide:
  - [ ] **Option A:** Ship Phase 13 alongside Phase 12 in a single v1.0 release (recommended — billing + browse together is the v1.0 story).
  - [ ] **Option B:** Ship Phase 13 standalone (release tag `v1.0-billing`). Phase 13 does not gate on Phase 12 Browse — managed billing works fine without Browse.

#### 11.2 — Tag the release

```bash
cd /Users/ouen/slop/sei
git tag -a v1.0-billing -m "Phase 13: AI proxy + billing + usage UI"
# OR if shipping alongside Phase 12:
git tag -a v1.0 -m "Phase 12+13: Browse + billing"
git push --tags
```

#### 11.3 — Build production installers

- [ ] On macOS host (must be macOS for the .dmg cross-compilation):

```bash
npm run build
npm run package  # electron-builder produces .dmg + .exe + .AppImage if configured
```

- [ ] Verify `@electron/rebuild` ran successfully in postinstall — the build output should show "Rebuilding native modules" lines for mineflayer + better-sqlite3 + safeStorage backing libs. **If those lines are absent, STOP — the native-ABI invariant (CLAUDE.md Pitfall 3) is violated; the installer will crash on user machines.**

#### 11.4 — Clean-VM smoke

- [ ] Take a clean macOS VM (or rent an EC2 mac.metal instance briefly). Install the .dmg.
- [ ] Boot the app, sign in, switch to managed billing, summon a bot in a LAN world, send one message.
- [ ] **Expected:** All Step 8 sub-steps 1, 5, 6 work on a clean machine (you don't need to re-run all 13 — just confirm the native modules loaded and the JWT + proxy call chain succeeds).
- [ ] Repeat with .exe on Windows VM if shipping Windows.
- [ ] Repeat with .AppImage on Ubuntu VM if shipping Linux.

#### 11.5 — Publish

- [ ] Upload installers to the release channel (sei.gg/download, GitHub Releases, S3, or whatever is in use).
- [ ] Verify download URLs return the correct files (HEAD request + checksum match).
- [ ] Confirm sei.gg homepage / download page links to the new release.

#### 11.6 — Announce

- [ ] Discord announcement in the user community channel: "Phase 13 is LIVE. Managed billing available — $5 packs or $20/mo unlimited. Refund policy at sei.gg/terms.html#refunds. Existing BYOK users: nothing changes; you can opt-in via Settings → Cloud AI."
- [ ] Optional: mailing list, Twitter, blog post.

#### 11.7 — First external paying user

- [ ] Wait for or recruit a real external user (not the operator + not a test account) to complete a $5 pack purchase.
- [ ] Verify in Supabase Dashboard: `ledger_grants` has their row, `lemon-webhook` log shows attribution succeeded.
- [ ] Verify in `fly logs -a sei-proxy`: their first proxied bot call succeeds.
- [ ] Confirm Sentry shows no `service_at_capacity` / `invalid_jwt` / `internal_error` spikes during their session.

**Gate (final, irreversible):** Installers downloadable; first external paying user has successfully purchased and used credits end-to-end.

**Resume-signal:** `approved — Phase 13 LIVE on <DATE>`

---

## Decisions Made

1. **The runbook IS the deliverable.** Plan 13-23 is SUMMARY-only — no code, no commits beyond this file + the final phase docs commit. The five operator surfaces (Anthropic console, LS dashboard, Supabase CLI, Fly CLI, Sentry/log alerts) cannot be touched from inside an agent session, so the executor's job is to author the strictly-ordered, reproducible playbook with explicit gates.
2. **Anthropic Tier 2 verification is Step 2 (not later).** PATTERNS Pitfall 5 + D-51 / D-44 specify that Tier 1 would cause a 429 storm on the very first concurrent subscriber given the 60 RPM per-user cap exceeds the Tier 1 org budget. The Tier 2 auto-advancement (`$40 deposit + 14 days`) is a longer cooldown than any other gate in the rollout — surface it early so the operator can start the cooldown clock in parallel with Steps 3-7 if they discover they're on Tier 1.
3. **PROXY-13 framing audit is Step 10 (post-deploy, pre-installer-release).** D-49 mandates the operator audits LS product descriptions + marketing copy + terms.html + Fly key ownership BEFORE the public launch announcement. Five sign-off items (10.1-10.5) cover all known risk surfaces. Evidence (screenshots + grep results) is captured to the operator log as pre-launch audit material.
4. **End-to-end smoke is 13 sub-steps with explicit forbidden observations.** Step 8 covers checkout, balance refresh, trial claim, proxy forward, hard-stop modal, BYOK escape, subscribe, customer portal, cancel, dup-claim 409, rate-limit 429. The forbidden-observation lines (no dollar amounts in USAGE bar, no token counts in modal body, BYOK unmounts pricing icon — not CSS-hides) are PROXY-05 / PROXY-11 gates from the requirements.
5. **Five Sentry alert categories at Step 9.** D-44 + PATTERNS specifies sustained `service_at_capacity` as the Tier-3 upgrade trigger; the four other categories (invalid_jwt spike, internal_error spike, missing_user_id, grant_failed) cover the silent-failure modes that would otherwise only surface when users complain on Discord. Manual monthly Anthropic tier review (9.6) is the explicit no-API-for-tier-promotion countermeasure.
6. **Resume-signal strings are quoted verbatim.** Steps 1, 2, 8, 11 are blocking checkpoints with explicit `approved — <specific phrase>` strings. This discipline catches partial-completion ("approved" alone is ambiguous; "approved — all 13 smoke steps passed" is precise) and prevents accidental fast-forwards.
7. **The runbook does NOT assume a specific DNS / custom-domain setup.** Step 6 ships with the default `api.sei.gg` URL and provides an optional custom-domain path (`proxy.sei.gg`). Step 7's `SEI_PROXY_URL` value depends on the choice. Either is correct; the operator picks based on whether custom-domain branding matters for v1.0.

---

## Threat Model Disposition Status

| Threat ID | Category | Disposition | Mitigation Status |
|-----------|----------|-------------|-------------------|
| T-13-23-01 | Information Disclosure — secrets committed to repo | mitigate | Step 6 explicit `.gitignore` audit + `grep -r 'sk-ant'` smoke; ALL secrets via `fly secrets set` / `supabase secrets set`; NEVER in any tracked file |
| T-13-23-02 | Repudiation — LS product description argued as "Anthropic resale" | mitigate | Step 1 framing-locked descriptions; Step 10 sign-off + screenshot evidence; forbidden-phrase audit run twice (Step 1 + Step 10) |
| T-13-23-03 | Tampering — wrong Lemon variant ID baked into build → checkout 404 | mitigate | Step 7 grep verifies live variant IDs in build artifacts; Step 8 sub-step 3 catches this end-to-end via the actual checkout flow |
| T-13-23-04 | DoS — Anthropic Tier 1 launch causes 429 storm on first subscriber | mitigate | Step 2 verifies Tier 2 BEFORE first paying user; Step 9 alert 9.1 catches sustained `service_at_capacity` as Tier 3 upgrade trigger |
| T-13-23-05 | Information Disclosure — Anthropic personal API key used in Fly | mitigate | Step 10 sign-off item 10.5 explicitly verifies workspace = org (not personal); Step 6 calls this out at secret-set time |
| T-13-23-06 | Repudiation — user claims they didn't see refund policy | mitigate | 13-22 already enforces AcceptToSModal re-cycle on TOS_VERSION bump to 2026-05-23; Step 10 sign-off item 10.4 verifies LS product page links to terms.html#refunds anchor |
| T-13-23-07 | Tampering — forgotten Sentry alert delays Tier-3 push | mitigate | Step 9 explicitly enumerates 5 alert categories + monthly manual tier review reminder |
| T-13-23-08 (new) | DoS — Sei-proxy cold-start exceeds user's chat-input timeout on first request after idle | accept | Documented in Step 6 smoke ("~3-5s first request after idle"); future mitigation = `min_machines_running=1` in fly.toml at the cost of ~$2/mo always-on |
| T-13-23-09 (new) | Tampering — operator types resume-signal without actually completing the gate | accept | The resume-signals are quoted strings; operator discipline is the control. Threat T-12-18-02 precedent. |

---

## Open Questions / Follow-ups

- **Tier 3 timing.** Sentry alert 9.1 + manual monthly review (9.6) will surface this. No action until cumulative Anthropic spend approaches $400 + sustained 429s observed.
- **Fly cold-start tuning.** Step 6 notes ~3-5s first request after idle. If users complain about lag on first-message-of-the-day, set `min_machines_running=1` in fly.toml (always-on, ~$2/mo). Out of scope for initial rollout.
- **Sentry vs Fly-native alerts.** Step 9 assumes Sentry. If operator prefers Fly's native log-search alerts + Supabase's native log-drain alerts, the same five categories translate — but the configuration UX is fragmented across two dashboards instead of one. Operator's call.
- **LS subscription update / payment-failure handling.** Plan 13-11 handles all six webhook events; the smoke covers cancel but not `subscription_payment_success` (which fires monthly on renewal) or `subscription_expired` (which fires at end-of-period after cancel). Both are exercised passively in production over the first month — add a follow-up "30 days post-launch — verify renewal grants fired" calendar reminder.
- **Refund self-service.** v1.0 = manual via dmca@sei.app (per D-48 + 13-22). If volume spikes, build a refund-self-service screen in v1.x. Not blocking.

---

## Self-Check: PASSED

- File `/Users/ouen/slop/sei/.planning/phases/13-ai-proxy-billing-usage-ui/13-23-SUMMARY.md` — created (this file).
- 11 strictly-ordered steps present: grep `^### Step` should return 11.
- Anthropic Tier 2 verification at Step 2 (before any paying-user-facing infrastructure deploy): ✓.
- PROXY-13 framing audit at Step 10 (post-deploy, pre-installer-release): ✓.
- Step 8 has 13 sub-steps (verified by sub-step numbering 1-13): ✓.
- Step 9 enumerates ≥5 Sentry alert categories (9.1, 9.2, 9.3, 9.4, 9.5, plus 9.6 manual cadence): ✓.
- Step 8 sub-steps 12 + 13 cover anti-abuse (trial-claim dup-409 + rate-limit 429-banner): ✓.
- Threat model addresses: secret commit (T-13-23-01), ToS framing (T-13-23-02), Tier 1 launch (T-13-23-04), personal key (T-13-23-05), repudiation (T-13-23-02 + T-13-23-06): ✓.
- All four resume-signal strings (Steps 1, 2, 8, 11) are quoted verbatim and unambiguous: ✓.
- No code commits required beyond this SUMMARY + the final phase docs commit (per plan `files_modified` + per CHECKER directive that 13-23 is SUMMARY-only): ✓.
