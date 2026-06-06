---
quick_id: 260525-rfj
type: execute
wave: 1
depends_on: [260525-qy0]
files_modified:
  - supabase/migrations/20260528001100_rate_buckets_reports_ip_customer_portal.sql
  - supabase/functions/trial-claim/index.ts
  - supabase/functions/trial-claim/index.test.ts
  - supabase/functions/submit-report/index.ts
  - supabase/functions/submit-report/index.test.ts
  - proxy/src/rateLimit/customerPortalMinuteGate.ts
  - proxy/src/rateLimit/customerPortalMinuteGate.test.ts
  - proxy/src/rateLimit/buckets.ts
  - proxy/src/middleware/sentinel.ts
  - proxy/src/app.ts
  - proxy/src/app.test.ts
  - src/main/cloud/proxyClient.ts
  - src/main/cloud/proxyClient.test.ts
  - supabase/config.toml
autonomous: true
requirements: [H1, H2, H3, M9, M10, M11]
user_setup:
  - service: supabase-dashboard
    why: "config.toml [auth.rate_limit] is local-dev only — production hosted Supabase ignores it; operator must mirror in Dashboard."
    dashboard_config:
      - task: "Mirror local [auth.rate_limit] values in Supabase Dashboard → Auth → Rate Limits"
        location: "Supabase Dashboard → Authentication → Rate Limits"
        values: "email_sent=4, sms_sent=30, anonymous_users=30, token_refresh=150, sign_in_sign_ups=30, token_verifications=30; disable enable_anonymous_sign_ins"
      - task: "Enable Cloudflare Turnstile or hCaptcha on Auth"
        location: "Supabase Dashboard → Authentication → Bot Protection"

must_haves:
  truths:
    - "trial-claim rejects a JWT whose user.email_confirmed_at is null with 403"
    - "trial-claim rejects emails containing a `+` alias segment before `@` with 403"
    - "trial-claim returns the SAME 202 envelope { status: 'received' } for first-claim, already-claimed, and post-grant — the client cannot distinguish claim state from the response shape or status"
    - "trial-claim still grants $1 micro-credits exactly once per user via the existing UNIQUE indexes (ledger_grants_trial_per_user_uidx + trial_claims PK)"
    - "submit-report rejects reports from accounts younger than 24h with a friendly 403"
    - "submit-report enforces a 10-reports-per-IP-per-24h cap via the new `reports_ip_daily` bucket; over-cap returns 429 with Retry-After"
    - "POST /billing/customer-portal enforces 5/minute per-userId via the new `customer_portal_minute` bucket; over-cap returns 429 with Retry-After BEFORE any Lemon Squeezy API call"
    - "supabase/config.toml carries an [auth.rate_limit] block + a comment documenting the operator dashboard-mirror requirement"
    - "renderer-side trialClaim() consumer in src/main/cloud/proxyClient.ts treats the uniform 202 envelope as 'claim attempt complete' — no leak of claim state to the UI"
  artifacts:
    - path: "supabase/migrations/20260528001100_rate_buckets_reports_ip_customer_portal.sql"
      provides: "rate_buckets.bucket_kind CHECK extension for 'reports_ip_daily' + 'customer_portal_minute'"
      contains: "reports_ip_daily"
    - path: "supabase/functions/trial-claim/index.ts"
      provides: "email_confirmed_at gate + plus-alias reject + uniform 202 envelope"
      contains: "email_confirmed_at"
    - path: "supabase/functions/submit-report/index.ts"
      provides: "account-age gate + per-IP daily bucket"
      contains: "reports_ip_daily"
    - path: "proxy/src/rateLimit/customerPortalMinuteGate.ts"
      provides: "Hono middleware that enforces 5/min per-user before the LS API call"
      exports: ["customerPortalMinuteGate", "CUSTOMER_PORTAL_MINUTE_LIMIT"]
    - path: "supabase/config.toml"
      provides: "[auth.rate_limit] block + operator-runbook comment"
      contains: "[auth.rate_limit]"
  key_links:
    - from: "supabase/functions/trial-claim/index.ts"
      to: "userData.user.email_confirmed_at"
      via: "post-getUser() guard before trial_claims INSERT"
      pattern: "email_confirmed_at"
    - from: "supabase/functions/submit-report/index.ts"
      to: "rate_buckets RPC with kind='reports_ip_daily'"
      via: "extract first IP from x-forwarded-for, then admin.rpc('check_and_increment_bucket', …)"
      pattern: "x-forwarded-for"
    - from: "proxy/src/app.ts"
      to: "proxy/src/rateLimit/customerPortalMinuteGate.ts"
      via: "Hono middleware chain on GET /billing/customer-portal BEFORE fetchCustomerPortalUrl()"
      pattern: "customerPortalMinuteGate"
    - from: "src/main/cloud/proxyClient.ts"
      to: "supabase/functions/trial-claim 202 envelope"
      via: "treat 202 + { status: 'received' } as terminal — caller refreshes ledger_balance to detect grant"
      pattern: "received"
---

<objective>
Cluster D — Trial-abuse + auth rate-limit hardening. Six findings from the
260525 audit (H1 / H2 / H3 / M9 / M10 / M11) close together because they
share two seams: (a) the trial-claim Edge Function (email gate + neutral
envelope), and (b) the rate-buckets table + RPC pattern (new bucket kinds
for reports-per-IP and customer-portal-per-user). One migration covers both
new bucket kinds; four code commits cover the per-seam logic; one config
commit lands the local [auth.rate_limit] block (with an explicit
USER-action operator runbook for the dashboard mirror that production
actually reads).

Purpose: Close the Gmail-plus-aliasing trial-grant loop (attacker creates
attacker+1@gmail.com, attacker+2@gmail.com, … each gets a JWT before
email-confirmation, each claims a $1 trial). Close the enumeration oracle
on trial-claim (409 vs 200 leaks "this mc_username is taken"). Close two
unbounded-call surfaces (report spam from one IP, customer-portal abuse
from one userId).

Output: 1 migration + 4 code changes + 1 config change. 5 task-commits
total. Zero new vitest/deno regressions against the Cluster-C baseline
(14/300 vitest, 36/36 deno).
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
</execution_context>

<context>
@CLAUDE.md
@.planning/STATE.md

# Pattern references — already-shipped Cluster C migration mirrors the
# bucket-kind CHECK extension idiom we re-use in Task 1.
@supabase/migrations/20260528000900_moderation_per_user_buckets.sql
@supabase/migrations/20260527000000_persona_free_bucket.sql

# Pattern reference — Hono middleware bucket gate (mirror in Task 4).
@proxy/src/rateLimit/personaDailyGate.ts
@proxy/src/rateLimit/buckets.ts

# Pattern reference — submit-report two-client + service_role insert idiom.
# trial-claim already follows the same shape.
@supabase/functions/submit-report/index.ts
@supabase/functions/trial-claim/index.ts

# Renderer-side consumer of the trial-claim envelope (Task 2's downstream
# coupling — proxyClient currently splits on status 409 and code 'already_claimed').
@src/main/cloud/proxyClient.ts

<interfaces>
<!-- Key types/functions executor should use directly. -->

From proxy/src/rateLimit/buckets.ts:
```typescript
export type BucketKind = 'rpm' | 'itpm' | 'otpm' | 'daily_dollar' | 'persona_daily';
// Task 4 extends this union with: 'customer_portal_minute'
// Task 3 also extends with: 'reports_ip_daily'  (consumed by submit-report Edge Function, not the proxy — but the
// proxy's union type must stay consistent with the DB CHECK constraint to keep
// type-level intent in lockstep across the codebase. New union after Tasks
// 1+3+4: 'rpm' | 'itpm' | 'otpm' | 'daily_dollar' | 'persona_daily' |
//        'reports_ip_daily' | 'customer_portal_minute')

export type LimitResult =
  | { allowed: true }
  | { allowed: false; kind: BucketKind; retry_after_seconds: number };

export async function checkAndIncrementBucket(
  userId: string,           // also used as the bucket "key" — in Task 3 we pass the
                            // forwarded client IP STRING, since the rate_buckets table
                            // schema's `user_id` column is a uuid-text key per the RPC
                            // signature (Postgres `text` for user-id; the IP-keyed bucket
                            // re-uses the same column with the IP as the key value —
                            // verify against 20260524000100_rate_buckets_rpc.sql before
                            // implementing).
  kind: BucketKind,
  increment: bigint,
  limit: bigint,
  windowSeconds: number,
): Promise<LimitResult>;
```

From proxy/src/middleware/sentinel.ts:
```typescript
// sendError shape — current `kind` field union must be widened to include
// 'customer_portal_minute' so the 429 envelope serializes correctly.
export function sendError(c: Context, body: { code: string; kind?: BucketKind; retry_after_seconds?: number }): Response;
```

From src/main/cloud/proxyClient.ts (Task 2 downstream coupling):
```typescript
// Current return type — KEEP this signature stable after the envelope change.
// The ok:true branch is preserved by the server when the user actually got
// a grant; we synthesize it by reading ledger_balance after a 202.
export async function trialClaim(
  mcUsername: string,
): Promise<{ ok: true; credits_micro: number } | { ok: false; code: ProxyErrorCode }>;
```

Bucket-keying contract (verify before implementing Task 3):
- `check_and_increment_bucket(p_user_id text, ...)` accepts ANY text identifier.
- For per-IP bucketing we pass the IP string (the leftmost x-forwarded-for entry).
- For per-userId bucketing (Task 4) we pass the UUID string.
- The combination (user_id, bucket_kind) is the natural key in rate_buckets.
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Migration — extend rate_buckets.bucket_kind CHECK with reports_ip_daily + customer_portal_minute</name>
  <files>supabase/migrations/20260528001100_rate_buckets_reports_ip_customer_portal.sql</files>
  <action>
Create the next-slot migration (20260528001100 — Cluster C's last was
20260528001000). Mirror the exact idiom from
20260528000900_moderation_per_user_buckets.sql:

```sql
-- ============================================================================
-- 260525-rfj Task 1 — per-IP and per-user-customer-portal bucket kinds.
--
-- Adds two new bucket_kind values to rate_buckets.bucket_kind:
--
--   reports_ip_daily      — closes audit finding M9 (Cluster D).
--     10 reports / IP / 86400s. Keyed on the leftmost x-forwarded-for entry
--     (RFC 7239 left-is-originating). Consumed by submit-report Edge
--     Function (see Task 3). Complements the existing 5-per-reporter-id
--     hourly cap so a single griefer rotating accounts behind one IP still
--     gets throttled.
--
--   customer_portal_minute — closes audit finding M11 (Cluster D).
--     5 calls / user / 60s. Consumed by proxy's GET /billing/customer-portal
--     (see Task 4). Prevents a depleted-balance user from drumming the LS
--     API for portal URLs in a tight loop (each call costs us an upstream
--     LS quota slot + ~200ms of proxy CPU).
--
-- Rationale for schema-only change:
--   The check_and_increment_bucket RPC (20260524000100) accepts ANY text
--   kind — the table-level CHECK constraint is the sole gate on new bucket
--   kinds. Per-kind limits live in the callers (Edge Function for
--   reports_ip_daily, proxy middleware for customer_portal_minute) —
--   consistent with 20260527000000 / 20260528000900.
--
-- Idempotency:
--   Drop-then-add of the CHECK constraint matches the established pattern.
--   Per Supabase migration semantics, this migration runs exactly once via
--   schema_migrations; manual re-run would fail at the drop.
-- ============================================================================

alter table public.rate_buckets
  drop constraint rate_buckets_bucket_kind_check;

alter table public.rate_buckets
  add constraint rate_buckets_bucket_kind_check
  check (bucket_kind in (
    'rpm','itpm','otpm','daily_dollar','persona_daily',
    'sightengine_daily','openai_moderation_daily',
    'reports_ip_daily','customer_portal_minute'
  ));
```

CRITICAL: the new union MUST preserve EVERY pre-existing kind from the
prior migration (20260528000900 already includes sightengine_daily and
openai_moderation_daily — re-verify by reading that file before writing this
one). Missing kinds would silently break Cluster-C buckets in fresh DBs.

Also update the BucketKind union type in proxy/src/rateLimit/buckets.ts —
extend the export from
  `'rpm' | 'itpm' | 'otpm' | 'daily_dollar' | 'persona_daily'`
to
  `'rpm' | 'itpm' | 'otpm' | 'daily_dollar' | 'persona_daily' | 'reports_ip_daily' | 'customer_portal_minute'`

And update the sentinel.ts inline kind union (line ~41) to match. This
keeps TypeScript in lockstep with the DB CHECK and lets Task 4's middleware
typecheck.

NOTE: Cluster C's Task added `sightengine_daily` + `openai_moderation_daily`
to the DB but NOT to the proxy/src TypeScript union (those buckets are
Deno-side only). For Cluster D we DO add the proxy union extension because
`customer_portal_minute` is consumed from the proxy. We do NOT need to add
the moderation kinds to the proxy union retroactively.
  </action>
  <verify>
    <automated>cd /Users/ouen/slop/sei && grep -c "reports_ip_daily" supabase/migrations/20260528001100_rate_buckets_reports_ip_customer_portal.sql | grep -v '^0$' && grep -c "customer_portal_minute" supabase/migrations/20260528001100_rate_buckets_reports_ip_customer_portal.sql | grep -v '^0$' && grep -c "sightengine_daily" supabase/migrations/20260528001100_rate_buckets_reports_ip_customer_portal.sql | grep -v '^0$' && grep -c "customer_portal_minute" proxy/src/rateLimit/buckets.ts | grep -v '^0$'</automated>
  </verify>
  <done>
Migration file exists at supabase/migrations/20260528001100_rate_buckets_reports_ip_customer_portal.sql. CHECK constraint
union contains ALL nine prior kinds + the two new kinds. BucketKind union
in proxy/src/rateLimit/buckets.ts and sentinel.ts inline union both include
the two new kinds. `npm run --prefix proxy lint` (if it runs typecheck)
passes; otherwise `npx --yes tsc -p proxy/tsconfig.json --noEmit` passes.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: trial-claim — email_confirmed_at gate + plus-alias reject + uniform 202 envelope (H2 + M10) + renderer adapter</name>
  <files>supabase/functions/trial-claim/index.ts, supabase/functions/trial-claim/index.test.ts, src/main/cloud/proxyClient.ts, src/main/cloud/proxyClient.test.ts</files>
  <behavior>
NEW deno test cases (extend the 9-case matrix in index.test.ts):

  10. Valid JWT, user.email_confirmed_at == null
        → 403 { ok: false, code: 'email_not_confirmed', message: ~friendly~ }
        AND trial_claims.insert NOT called
        AND ledger_grants.insert NOT called

  11. Valid JWT, email contains '+' alias (e.g. 'attacker+1@gmail.com')
        → 403 { ok: false, code: 'aliased_email', message: ~friendly~ }
        AND trial_claims.insert NOT called

  12. Valid JWT, plain email (no '+'), email_confirmed_at set, valid mc_username, no prior claim
        → 202 { status: 'received' }
        AND trial_claims.insert + ledger_grants.insert BOTH called
        AND credits_micro is NOT in the response body
        AND ok:true is NOT in the response body

  13. Valid JWT, plain email, confirmed, trial_claims raises 23505
        → 202 { status: 'received' }  (same envelope as case 12 — uniform)
        AND ledger_grants.insert NOT called

  14. Valid JWT, plain email, confirmed, trial_claims OK, ledger_grants raises 23505
        → 202 { status: 'received' }  (uniform — no 409 leak)
        AND NO compensating DELETE on trial_claims

UPDATE existing cases 5/7/9 to expect the new 202 envelope. Cases 1–4 + 6 + 8
keep their current status codes (preflight/method/auth/bad-request/insert-failure
are non-leak channels — the enumeration oracle is specifically the 200-vs-409
split on the claim path).

NEW vitest test cases (src/main/cloud/proxyClient.test.ts):

  - 'returns ok:true after a successful 202' — when the Edge Function returns
    202 { status: 'received' }, proxyClient.trialClaim re-reads
    ledger_balance via supabase-js, sees the trial grant, and returns
    `{ ok: true, credits_micro: 1_000_000 }`.
  - 'returns ok:false code:PROXY_ALREADY_CLAIMED after a 202 with no balance
    change' — the same 202 envelope but ledger_balance shows the prior
    balance was already non-zero (user previously claimed); proxyClient
    detects no delta and returns `code: PROXY_ALREADY_CLAIMED`. Implementation
    detail: read balance BEFORE the call, read AGAIN after, compare; if
    delta == 0 and trial_claims row exists, classify as already-claimed.
  - 'returns ok:false code:PROXY_NETWORK on email_not_confirmed 403' —
    surface as PROXY_NETWORK for now (do NOT add a new sentinel code; the
    renderer doesn't yet have UI copy for "verify email"). A follow-up
    quick-task can wire a dedicated PROXY_EMAIL_NOT_CONFIRMED sentinel once
    the renderer has copy.
  - REMOVE the 'returns PROXY_ALREADY_CLAIMED when the Edge Function returns
    409' test — 409 is no longer emitted by the new server contract.
  </behavior>
  <action>
Server-side (supabase/functions/trial-claim/index.ts):

1. After the existing getUser() check (line ~112), BEFORE the body parse,
   add the email-confirmation gate:

```typescript
const user = userData.user;
// H2 mitigation (Cluster D): block trial grant until email is confirmed.
// Without this, the Gmail-plus-aliasing loop lets attacker+1@gmail.com /
// attacker+2@gmail.com … each receive a session JWT before clicking the
// confirmation link, and each session can claim a $1 trial. We refuse
// service until Supabase's confirmation flow has stamped
// `email_confirmed_at` on the auth.users row.
if (!user.email_confirmed_at) {
  return jsonError(403, {
    ok: false,
    code: 'email_not_confirmed',
    message: 'Please verify your email to claim the trial.',
  });
}
// H2 plus-alias heuristic: Gmail treats `name+anything@gmail.com` as
// equivalent to `name@gmail.com`, so attackers spin up infinite aliases
// from one inbox. We reject any `+` segment before `@` at the trial-claim
// boundary specifically — the abuse cost ($1 per alias × ∞) outweighs
// the rare legitimate `+`-alias user. Trial-claim is single-shot per
// account anyway; users who hit this can sign up with a non-aliased
// address.
//
// Trade-off documented: this is heuristic, not policy. The regex is
// scoped to the local-part (left of `@`) so `@foo+bar.com` (unusual but
// valid per RFC 5321) is not affected. Anchored to start with at least
// one non-`+` char so `+@example.com` (invalid per RFC anyway) is also
// rejected as ill-formed.
const PLUS_ALIAS_RE = /^[^+@]+\+[^@]*@/;
if (typeof user.email === 'string' && PLUS_ALIAS_RE.test(user.email)) {
  return jsonError(403, {
    ok: false,
    code: 'aliased_email',
    message: 'Please use your primary email (without +aliases) to claim the trial.',
  });
}
```

2. Replace the THREE existing leak-channel returns with the uniform 202
   envelope:

   a. Line ~149 (`return jsonError(409, { ok: false, code: 'already_claimed' });`
      inside the trial_claims 23505 branch) → `return uniformReceived();`
   b. Line ~183 (the ledger_grants 23505 branch returning 409
      `already_claimed`) → `return uniformReceived();`
   c. Line ~202 (the success return — currently `200` with
      `{ ok: true, credits_micro: 1_000_000 }`) → `return uniformReceived();`

   Define the helper near the top of the file (under jsonError):

```typescript
/**
 * M10 mitigation (Cluster D): uniform 202 envelope across all three
 * claim-disposition branches (fresh-grant success, mc_username already
 * claimed, user already received a prior trial). The client cannot
 * infer claim state from the response shape or status — true idempotency
 * still comes from the trial_claims PK + ledger_grants partial UNIQUE
 * index. The client refreshes ledger_balance after a 202 to determine
 * whether a credit landed.
 *
 * 202 Accepted is the correct semantic: "your claim attempt has been
 * processed; the ledger is the source of truth for outcome." Same shape
 * + status as submit-report's success envelope (consistency).
 */
function uniformReceived(): Response {
  return new Response(
    JSON.stringify({ status: 'received' }),
    { status: 202, headers: JSON_HEADERS },
  );
}
```

   Leave the 500-class branches (claim_insert_failed, grant_insert_failed)
   AS-IS — those are infrastructure errors, not claim-state leaks, and the
   renderer needs to distinguish them from success/already-claimed for retry
   logic.

   The compensating DELETE on the ledger_grants non-23505 error path stays
   exactly as it is. The 500-`grant_failed` envelope stays. Only the
   "happy/409-409" trio collapses into the uniform 202.

3. Update supabase/functions/trial-claim/index.test.ts:
   - Extend the case matrix per <behavior> (add cases 10–14).
   - Update existing cases 5/7/9 to assert status 202 + body
     `{ status: 'received' }`.
   - Add an `email_confirmed_at` field to the test's `getUserResult` factory:
     default to `'2026-05-25T00:00:00Z'` (confirmed); the new case-10 test
     passes `null`.
   - Add an `email` field to the same factory: default to
     `'test@example.com'`; the new case-11 test passes `'attacker+1@gmail.com'`.

Renderer-side (src/main/cloud/proxyClient.ts):

4. Update trialClaim() to handle the new envelope. Current shape (lines
   148–171) — strip the 409 branch + the `code: 'already_claimed'`
   inspection. New flow:

```typescript
export async function trialClaim(
  mcUsername: string,
): Promise<{ ok: true; credits_micro: number } | { ok: false; code: ProxyErrorCode }> {
  const session = await getSessionOrNull();
  if (!session) return { ok: false, code: PROXY_NO_SESSION };

  const supabase = getClient();

  // Read balance BEFORE the claim attempt so we can detect a delta after
  // the uniform 202 envelope (M10 — server no longer tells us whether the
  // claim landed; the ledger is the source of truth).
  const { data: pre } = await supabase
    .from('ledger_balance')
    .select('balance_micro')
    .eq('user_id', session.userId)
    .maybeSingle();
  const preBalance = BigInt((pre?.balance_micro ?? 0) as number | string);

  const res = await callEdgeFunction('trial-claim', {
    jwt: session.jwt,
    body: { mc_username: mcUsername },
  });

  // Network/abort path unchanged (status === 0).
  if (!res.ok) {
    // 403 → email_not_confirmed or aliased_email. No dedicated sentinel
    // yet (the renderer has no copy for these), so surface as PROXY_NETWORK
    // — the user retries, sees same outcome, and (for email_not_confirmed)
    // the existing email-confirmation flow surfaces the actionable hint.
    return { ok: false, code: PROXY_NETWORK };
  }

  // Edge Function returned 2xx — the uniform envelope is status:'received'.
  // Decide success vs already-claimed by re-reading ledger_balance.
  const { data: post } = await supabase
    .from('ledger_balance')
    .select('balance_micro')
    .eq('user_id', session.userId)
    .maybeSingle();
  const postBalance = BigInt((post?.balance_micro ?? 0) as number | string);

  const delta = postBalance - preBalance;
  if (delta > 0n) {
    // Credit landed — first-time claim, regardless of which server branch
    // (fresh-grant) produced it.
    return { ok: true, credits_micro: Number(delta) };
  }
  // No delta — either prior trial (server's third uniform 202 branch) or
  // mc_username already taken by a different user (second branch). The
  // renderer's "already claimed" copy is the right surface either way.
  return { ok: false, code: PROXY_ALREADY_CLAIMED };
}
```

5. Update src/main/cloud/proxyClient.test.ts — replace the 409-branch test
   (lines ~165 and ~179) with the three new vitest cases described in
   <behavior>. The existing PROXY_NO_SESSION test stays.

6. Bump the proxyClient.ts top-of-file comment (the "Wire-level: POST
   /functions/v1/trial-claim with `{ mc_username }`" block on line ~131)
   to reflect the new envelope — note the 202 uniformity and the ledger-
   read decision.

No changes to:
  - src/main/ipc.ts (the IPC handler is a pure passthrough — the new
    return shape from trialClaim is structurally identical)
  - src/preload/index.ts (passthrough)
  - src/shared/ipc.ts TrialClaim return-union (still
    `'already_claimed' | 'no_session' | 'network'`)
  - The renderer-side store / UI (no consumer yet)
  </action>
  <verify>
    <automated>cd /Users/ouen/slop/sei/supabase/functions/trial-claim && deno test --allow-env --no-check 2>&1 | tail -20 && cd /Users/ouen/slop/sei && npx --yes vitest run src/main/cloud/proxyClient.test.ts 2>&1 | tail -20</automated>
  </verify>
  <done>
- supabase/functions/trial-claim/index.ts has the email_confirmed_at guard,
  the PLUS_ALIAS_RE guard, the uniformReceived() helper, and all three
  claim-disposition branches return 202 { status: 'received' }.
- supabase/functions/trial-claim/index.test.ts has cases 10–14 plus updated
  5/7/9 assertions; deno test passes all cases.
- src/main/cloud/proxyClient.ts trialClaim() reads ledger_balance pre/post
  and decides via delta; no 409 branch remains; the top-of-file comment
  is updated.
- src/main/cloud/proxyClient.test.ts has the three new vitest cases; the
  removed 409-test no longer exists; vitest passes (zero new failures on
  top of the 14/300 baseline).
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 3: submit-report — account-age gate + per-IP daily bucket (M9)</name>
  <files>supabase/functions/submit-report/index.ts, supabase/functions/submit-report/index.test.ts</files>
  <behavior>
NEW deno test cases (additive to the existing countReportsInLastHour suite
and any handler-level cases already present):

  - 'rejects reports from accounts younger than 24h with 403' — handler
    receives valid JWT; userData.user.created_at is 5 minutes ago; expects
    403 { ok: false, code: 'account_too_new', message: friendly }; admin
    INSERT not called; bucket RPC not called.
  - 'accepts reports from accounts older than 24h' — created_at is
    25 hours ago; happy-path 202 still works.
  - 'rejects when per-IP bucket is over cap' — bucket RPC returns
    allowed:false; expects 429 with Retry-After header and the existing
    FRIENDLY_RATE_LIMITED_MESSAGE body (re-used copy).
  - 'increments per-IP bucket with leftmost x-forwarded-for' — request
    carries `x-forwarded-for: '203.0.113.7, 10.0.0.1'`; assert
    check_and_increment_bucket was called with p_user_id='203.0.113.7'
    and p_bucket_kind='reports_ip_daily'.
  - 'falls back to a sentinel IP key when x-forwarded-for is absent' —
    Supabase Edge Functions ALWAYS populate x-forwarded-for in production,
    but during local `supabase functions serve` the header may be missing.
    Sentinel key: 'unknown'. Test asserts the RPC is still called (do NOT
    fail-open by skipping the bucket).
  </behavior>
  <action>
1. Add the constants near the top of supabase/functions/submit-report/index.ts
   (under RATE_LIMIT_PER_HOUR):

```typescript
/** M9 mitigation (Cluster D): minimum account age in ms before reports
 * are accepted from this account. 24h. Slows down sign-up→report→delete
 * abuse cycles without locking out new legitimate users for long.
 */
const MIN_ACCOUNT_AGE_MS = 24 * 60 * 60 * 1000;

/** M9 per-IP bucket: 10 reports / IP / 24h. Complements the existing
 * 5-per-reporter-id hourly cap. Bucket-kind extension lives in
 * 20260528001100_rate_buckets_reports_ip_customer_portal.sql.
 */
const REPORTS_PER_IP_PER_DAY = 10n;
const REPORTS_PER_IP_WINDOW_SECONDS = 86_400;
```

2. After the existing `reporterId = userData.user.id` line (~148), add the
   account-age gate:

```typescript
// M9: account-age gate. user.created_at is ALWAYS populated by Supabase
// on auth.users INSERT; we assert it for defensive belt-and-suspenders.
const createdAt = userData.user.created_at
  ? new Date(userData.user.created_at).getTime()
  : null;
if (createdAt === null || Number.isNaN(createdAt)) {
  // Defensive: should never happen for a JWT-verified user, but failing
  // closed here keeps the gate intact rather than fail-open.
  return new Response(
    JSON.stringify({ ok: false, code: 'account_too_new', message: 'Account verification failed. Please try again later.' }),
    { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );
}
if (Date.now() - createdAt < MIN_ACCOUNT_AGE_MS) {
  return new Response(
    JSON.stringify({
      ok: false,
      code: 'account_too_new',
      message: 'New accounts must wait 24 hours before submitting reports.',
    }),
    { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );
}
```

3. AFTER the existing 5/hour reporter_id rate-limit check (line ~221, the
   `if (recent && countReportsInLastHour ...)` block) but BEFORE the admin
   INSERT, add the per-IP bucket check:

```typescript
// M9: per-IP daily cap. Extract the originating client IP from the
// leftmost x-forwarded-for entry (RFC 7239). Supabase Edge Functions
// populate this header on every request in production; locally it may
// be missing during `supabase functions serve`, so we fall back to a
// sentinel 'unknown' key — this groups all local-dev traffic into one
// bucket which is the desired conservative behavior.
const xff = req.headers.get('x-forwarded-for') ?? '';
const ipKey = xff.split(',')[0]?.trim() || 'unknown';

const { data: ipBucket, error: ipBucketErr } = await admin.rpc(
  'check_and_increment_bucket',
  {
    p_user_id: ipKey,
    p_bucket_kind: 'reports_ip_daily',
    p_increment: '1',
    p_limit: REPORTS_PER_IP_PER_DAY.toString(),
    p_window_seconds: REPORTS_PER_IP_WINDOW_SECONDS,
  },
);
if (ipBucketErr) {
  // Fail-closed (mirrors the existing rate_check_failed branch).
  return new Response(
    JSON.stringify({
      ok: false,
      code: 'rate_check_failed',
      message: 'Could not verify report eligibility. Please try again.',
    }),
    { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );
}
const ipRow = (ipBucket as Array<{ allowed: boolean; retry_after_seconds: number }> | null)?.[0];
if (ipRow && ipRow.allowed === false) {
  const headers = {
    ...corsHeaders,
    'Content-Type': 'application/json',
    'Retry-After': String(ipRow.retry_after_seconds ?? 3600),
  };
  return new Response(
    JSON.stringify({
      ok: false,
      code: 'rate_limited',
      message: FRIENDLY_RATE_LIMITED_MESSAGE,
    }),
    { status: 429, headers },
  );
}
```

4. Update supabase/functions/submit-report/index.test.ts. The existing test
   file uses pure-function tests for countReportsInLastHour; we need to add
   handler-level tests. The pattern is in
   supabase/functions/trial-claim/index.test.ts (makeHandler factory). If
   submit-report doesn't yet have a makeHandler factory, FOLLOW the same
   refactor pattern as trial-claim did in plan 13-12 Task 2:
     - Wrap the existing `handler` body in `export function makeHandler(deps?: { createClient?: typeof createClient }): ...`
     - The exported `handler` becomes `export const handler = makeHandler();`
     - Tests pass a stubbed createClient that mocks userClient.auth.getUser
       (returning user.created_at), admin.from(...).select(...).gte(...)
       (existing 5/hour reporter check), admin.rpc('check_and_increment_bucket',…)
       (new per-IP check), and admin.from('reports').insert(...).

   If the existing index.ts already exports `handler` directly without a
   factory, do this refactor; it's the minimal change to enable handler-
   level testing without spinning up Deno.serve. The refactor is
   confined to this file — no callers to update because submit-report is
   invoked over HTTP, not as a module import.

5. KEEP the existing countReportsInLastHour pure-function tests untouched.
  </action>
  <verify>
    <automated>cd /Users/ouen/slop/sei/supabase/functions/submit-report && deno test --allow-env --no-check 2>&1 | tail -25</automated>
  </verify>
  <done>
- submit-report/index.ts has MIN_ACCOUNT_AGE_MS + REPORTS_PER_IP_PER_DAY
  constants, the account-age gate after reporterId extraction, and the
  per-IP bucket check after the 5/hour reporter check.
- The x-forwarded-for extraction takes the LEFTMOST entry; missing header
  falls back to 'unknown' (fail-closed via single shared bucket).
- submit-report/index.test.ts has handler-level cases for account-too-new,
  >24h-account-OK, ip-bucket-over-cap, leftmost-XFF-extraction, and
  XFF-absent-sentinel. All deno tests pass.
- The pre-existing 5/hour reporter test surface is unchanged.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 4: customer-portal — per-user minute bucket (M11)</name>
  <files>proxy/src/rateLimit/customerPortalMinuteGate.ts, proxy/src/rateLimit/customerPortalMinuteGate.test.ts, proxy/src/app.ts, proxy/src/app.test.ts</files>
  <behavior>
NEW vitest test cases (customerPortalMinuteGate.test.ts — new file,
mirrors personaDailyGate.test.ts pattern if it exists; otherwise mirror
the inline test patterns from gate.test.ts):

  - 'allows the first 5 calls per user within 60s' — bucket RPC returns
    allowed:true for 5 calls; expect middleware to call next() each time.
  - 'rejects the 6th call with 429 + Retry-After' — bucket RPC returns
    allowed:false with retry_after_seconds=42; expect Response with
    status 429, Retry-After: '42' header, body's code=rate_limited and
    kind='customer_portal_minute'.
  - 'passes userId from c.var to checkAndIncrementBucket' — assert the
    spy received the right userId, kind='customer_portal_minute',
    increment=1n, limit=5n, window=60.

NEW vitest cases in app.test.ts (add to the existing customer-portal
section):

  - 'GET /billing/customer-portal — rejected by customerPortalMinuteGate
    returns 429' — mockCheckAndIncrementBucket returns
    `{ allowed: false, kind: 'customer_portal_minute', retry_after_seconds: 30 }`
    on the customer_portal_minute call; expect the upstream LS API mock
    (mockFetch) NOT to be called.
  - 'GET /billing/customer-portal — allowed gate falls through to LS API'
    — bucket allowed; assert mockFetch called once with the LS subscriptions
    endpoint. The pre-existing happy-path test (if any) gets this
    expectation added — otherwise add a new combined test.
  </behavior>
  <action>
1. Create proxy/src/rateLimit/customerPortalMinuteGate.ts — mirror the
   exact shape of personaDailyGate.ts (~30 lines):

```typescript
// 5/minute per-user gate for GET /billing/customer-portal. Runs AFTER
// verifyJwt (so c.var.userId is populated) and BEFORE the LS API call
// in app.ts so a flood of requests does not hammer Lemon Squeezy's
// API quota or our proxy's CPU.
//
// Reuses check_and_increment_bucket with the dedicated
// `customer_portal_minute` bucket kind (migration 20260528001100).

import type { MiddlewareHandler } from 'hono';
import { checkAndIncrementBucket } from './buckets.js';
import { sendError } from '../middleware/sentinel.js';

export const CUSTOMER_PORTAL_MINUTE_LIMIT = 5n;
const CUSTOMER_PORTAL_MINUTE_WINDOW_SECONDS = 60;

export const customerPortalMinuteGate: MiddlewareHandler<{
  Variables: { userId: string };
}> = async (c, next) => {
  const userId = c.get('userId');
  const result = await checkAndIncrementBucket(
    userId,
    'customer_portal_minute',
    1n,
    CUSTOMER_PORTAL_MINUTE_LIMIT,
    CUSTOMER_PORTAL_MINUTE_WINDOW_SECONDS,
  );
  if (!result.allowed) {
    c.header('Retry-After', String(result.retry_after_seconds));
    return sendError(c, {
      code: 'rate_limited',
      kind: result.kind,
      retry_after_seconds: result.retry_after_seconds,
    });
  }
  await next();
};
```

2. Wire into proxy/src/app.ts on the GET /billing/customer-portal route
   (currently lines ~80–95). Insert customerPortalMinuteGate between
   verifyJwt and the inline async handler:

```typescript
import { customerPortalMinuteGate } from './rateLimit/customerPortalMinuteGate.js';

// existing route — add gate to middleware chain:
app.get('/billing/customer-portal', verifyJwt, customerPortalMinuteGate, async (c) => {
  // … existing handler body unchanged …
});
```

   IMPORTANT: the gate runs BEFORE the env.LEMON_SQUEEZY_API_KEY check
   currently at the top of the handler. This means an over-rate user gets
   429 even when the proxy isn't configured with an LS key. That's correct
   — we still want rate-limiting in misconfigured/test environments.

3. Create proxy/src/rateLimit/customerPortalMinuteGate.test.ts. Mirror the
   personaDailyGate.test.ts shape (if it exists — `ls
   proxy/src/rateLimit/*.test.ts` to confirm; if not, mirror gate.test.ts).
   Mock checkAndIncrementBucket at the import seam:

```typescript
import { describe, it, expect, vi } from 'vitest';

vi.mock('./buckets.js', () => ({
  checkAndIncrementBucket: vi.fn(),
}));

import { checkAndIncrementBucket } from './buckets.js';
import { customerPortalMinuteGate, CUSTOMER_PORTAL_MINUTE_LIMIT } from './customerPortalMinuteGate.js';

// helper to fake a Hono Context just enough for the middleware:
function makeCtx(userId: string) {
  const headers = new Headers();
  const ctx = {
    get: (k: string) => (k === 'userId' ? userId : undefined),
    header: (k: string, v: string) => headers.set(k, v),
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), { status: status ?? 200, headers }),
  };
  return { ctx, headers };
}
// … 3 test cases per <behavior> …
```

4. Update proxy/src/app.test.ts:
   - Confirm the existing `vi.mock('./rateLimit/buckets.js', …)` block
     covers the customerPortalMinuteGate import path (it does — the gate
     re-uses checkAndIncrementBucket from the same module).
   - Add two new test cases under the existing /billing/customer-portal
     describe block (or add the describe block if none exists). Use
     mockCheckAndIncrementBucket as the spy.

5. Sanity-check that the sentinel.ts kind union accepts
   'customer_portal_minute' — Task 1 already extended it.
  </action>
  <verify>
    <automated>cd /Users/ouen/slop/sei && npx --yes vitest run proxy/src/rateLimit/customerPortalMinuteGate.test.ts proxy/src/app.test.ts 2>&1 | tail -25</automated>
  </verify>
  <done>
- proxy/src/rateLimit/customerPortalMinuteGate.ts exists, exports the
  middleware + limit constant.
- proxy/src/app.ts GET /billing/customer-portal route has customerPortalMinuteGate
  in its middleware chain between verifyJwt and the handler.
- New gate test file passes 3 cases (allow / reject / param shape).
- Two new app.test.ts cases pass (429 path skips LS fetch; allowed path
  hits LS fetch). Existing app.test.ts cases still pass.
- Zero new vitest failures on top of the 14/300 baseline.
  </done>
</task>

<task type="auto">
  <name>Task 5: config.toml — [auth.rate_limit] block + operator runbook comment (H1)</name>
  <files>supabase/config.toml</files>
  <action>
Append the [auth.rate_limit] and [auth] blocks to supabase/config.toml,
with a LARGE, IMPOSSIBLE-TO-MISS comment block explaining the
LOCAL-DEV-ONLY scope and the operator's dashboard-mirror obligation.

```toml

# ============================================================================
# H1 mitigation (Cluster D, 260525-rfj) — auth rate-limit conservative defaults.
#
# CRITICAL: THIS BLOCK IS LOCAL-DEV ONLY.
# Production hosted Supabase IGNORES this file entirely. The operator MUST
# mirror these values in Supabase Dashboard → Authentication → Rate Limits
# after deploying:
#
#   email_sent             = 4
#   sms_sent               = 30
#   anonymous_users        = 30
#   token_refresh          = 150
#   sign_in_sign_ups       = 30
#   token_verifications    = 30
#   enable_anonymous_sign_ins = false
#
# AND enable Cloudflare Turnstile (or hCaptcha) on the Auth surface
# (Supabase Dashboard → Authentication → Bot Protection). Without bot
# protection the rate limits are a speed bump, not a wall — a worker pool
# can fan out under the per-IP limit with rotating egress IPs.
#
# The Cluster D audit (260525) found Supabase was running with default
# limits (10/hour email, 30/hour sign-up). Defaults are tuned for app
# discoverability, NOT for paid-service trial-grant abuse. The values
# above are tuned for Sei's specific threat model: trial-claim is a
# $1-per-claim attack surface, so email_sent=4/hour throttles the
# confirmation-email arm of the Gmail-plus-aliasing loop, complementing
# the email_confirmed_at gate at trial-claim/index.ts (Task 2).
# ============================================================================

[auth]
enable_anonymous_sign_ins = false

[auth.rate_limit]
email_sent             = 4
sms_sent               = 30
anonymous_users        = 30
token_refresh          = 150
sign_in_sign_ups       = 30
token_verifications    = 30
```

DO NOT modify or remove the pre-existing `[functions.delete-me]` /
`[functions.lemon-webhook]` blocks. Append-only.

Verification: the `supabase start` local stack will pick this up on next
restart. The operator runbook step is captured in this plan's `user_setup`
frontmatter so the post-merge handoff documentation surfaces it.
  </action>
  <verify>
    <automated>cd /Users/ouen/slop/sei && grep -c "\[auth.rate_limit\]" supabase/config.toml | grep -v '^0$' && grep -c "email_sent" supabase/config.toml | grep -v '^0$' && grep -c "Dashboard" supabase/config.toml | grep -v '^0$' && grep -c "enable_anonymous_sign_ins" supabase/config.toml | grep -v '^0$'</automated>
  </verify>
  <done>
- supabase/config.toml contains the [auth.rate_limit] block with all six
  numeric fields at the prescribed values.
- supabase/config.toml contains the [auth] block with
  enable_anonymous_sign_ins = false.
- The block is preceded by the LARGE operator-runbook comment naming the
  Dashboard mirror as a required follow-up step.
- The pre-existing [functions.delete-me] and [functions.lemon-webhook]
  blocks are untouched.
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| client→trial-claim Edge Function | Untrusted JWT crosses here; sei_user_id + email_confirmed_at come from the verified user row |
| client→submit-report Edge Function | Untrusted JWT + body cross here; account-age + per-IP gates run BEFORE the privileged INSERT |
| client→proxy /billing/customer-portal | Untrusted JWT crosses here; per-user minute gate runs BEFORE the LS API call |
| operator-managed Supabase Dashboard | Production rate-limit config; config.toml does NOT mirror to production (USER-action required) |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-rfj-01 | Spoofing | trial-claim (Gmail-plus-aliasing) | mitigate | email_confirmed_at != null check + plus-alias regex on user.email — Task 2 |
| T-rfj-02 | Information Disclosure | trial-claim (enumeration oracle) | mitigate | Uniform 202 { status: 'received' } across all three claim-disposition branches — Task 2 |
| T-rfj-03 | Denial of Service | submit-report (report spam) | mitigate | 10/IP/24h per-IP bucket via reports_ip_daily — Task 3 |
| T-rfj-04 | Spoofing | submit-report (sign-up→report→delete cycle) | mitigate | 24h minimum account age check on userData.user.created_at — Task 3 |
| T-rfj-05 | Denial of Service | proxy /billing/customer-portal (LS API quota drain) | mitigate | 5/userId/60s bucket via customer_portal_minute — Task 4 |
| T-rfj-06 | Denial of Service | auth flow (email-flood, signup-flood) | mitigate | [auth.rate_limit] block in config.toml + operator dashboard mirror — Task 5 + user_setup |
| T-rfj-07 | Tampering | Renderer-side trialClaim() consumer | accept | The new ledger-balance-delta logic in proxyClient.ts is best-effort; a network failure between the 202 and the post-balance read leaves the user-visible state ambiguous — server-side trial_claims PK is the authoritative idempotency guarantee, so worst case is the renderer shows "already claimed" once when it should show "success" (the credits ARE granted; balance shows them on next refresh). Tracked but not blocking. |
| T-rfj-08 | Information Disclosure | submit-report (x-forwarded-for trust) | accept | We trust Supabase's edge to populate x-forwarded-for accurately. A client-set XFF would be ignored upstream and our `unknown` sentinel catches missing-header dev cases. If Supabase changes their forwarding semantics, we'd need to switch to a dashboard-attested header — out of scope for Cluster D. |
| T-rfj-09 | Information Disclosure | submit-report (per-IP bucketing of NAT'd clients) | accept | Shared corporate / coffee-shop IPs will hit the 10/IP/24h cap collectively. Acceptable: the per-reporter 5/hour cap is the primary defense; the per-IP cap is a defense-in-depth that catches sign-up-rotation abuse. Legitimate users behind NAT will see the cap rarely. |
</threat_model>

<verification>
**Per-task automated verification** is captured inside each `<task><verify>` block. The phase-level smoke is:

```bash
# 1. Migration syntax-sanity (file naming + bucket-kind union complete)
ls /Users/ouen/slop/sei/supabase/migrations/20260528001100_*.sql
grep -E "in \(.*reports_ip_daily.*customer_portal_minute.*\)" /Users/ouen/slop/sei/supabase/migrations/20260528001100_*.sql

# 2. Edge Function deno tests
cd /Users/ouen/slop/sei/supabase/functions/trial-claim && deno test --allow-env --no-check
cd /Users/ouen/slop/sei/supabase/functions/submit-report && deno test --allow-env --no-check

# 3. Proxy vitest — gate + app
cd /Users/ouen/slop/sei && npx --yes vitest run proxy/src/rateLimit/customerPortalMinuteGate.test.ts proxy/src/app.test.ts

# 4. Renderer vitest — proxyClient new ledger-delta logic
cd /Users/ouen/slop/sei && npx --yes vitest run src/main/cloud/proxyClient.test.ts

# 5. Full vitest sweep — confirm baseline preserved (14/300 expected failures, no new ones from this cluster)
cd /Users/ouen/slop/sei && npx --yes vitest run 2>&1 | tail -10
```

**Regression budget:**
- Deno: 36/36 must still pass (Cluster C baseline). Cluster D adds 5+ new cases.
- Vitest: 14/300 baseline failures preserved. Cluster D MUST NOT introduce new failures. New tests authored in Cluster D MUST pass.
</verification>

<success_criteria>
1. Migration `20260528001100_rate_buckets_reports_ip_customer_portal.sql` exists and the bucket-kind CHECK union includes ALL 9 prior kinds + the 2 new kinds.
2. `trial-claim/index.ts`: every 2xx response path returns 202 `{ status: 'received' }`; 403 paths exist for email_not_confirmed + aliased_email; deno test passes new cases 10–14.
3. `submit-report/index.ts`: 403 path exists for accounts < 24h old; 429 path exists for per-IP bucket; deno test passes new cases.
4. `proxy/src/rateLimit/customerPortalMinuteGate.ts` exists; `proxy/src/app.ts` wires it into the customer-portal route; new vitest cases pass.
5. `supabase/config.toml` carries the `[auth.rate_limit]` block AND a comment naming the dashboard mirror as a required operator follow-up.
6. `src/main/cloud/proxyClient.ts` trialClaim() uses ledger-balance-delta to decide success vs already-claimed; the 409-branch test is removed; new vitest cases pass.
7. Full vitest sweep: 14/300 baseline preserved, zero new failures.
8. Full deno test sweep: pre-existing 36/36 preserved; new submit-report + trial-claim cases pass.
9. 5 atomic commits (one per task).
10. STATE.md note added by the close-out step (orchestrator handles this, not the plan itself).
</success_criteria>

<output>
After completion, the orchestrator will append a `260525-rfj-SUMMARY.md` to
the quick directory capturing the closed findings (H1/H2/H3 audit IDs
notwithstanding — Cluster D's specific findings are H1/H2/M9/M10/M11 per the
audit + the deferred trial-claim Proxy-H1 item) and the deferred follow-ups
(PROXY_EMAIL_NOT_CONFIRMED sentinel for renderer copy + the dashboard mirror
USER-action).
</output>
