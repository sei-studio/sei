---
phase: 13-ai-proxy-billing-usage-ui
reviewed: 2026-05-23T06:04:11Z
depth: standard
files_reviewed: 24
files_reviewed_list:
  - proxy/src/app.ts
  - proxy/src/index.ts
  - proxy/src/env.ts
  - proxy/src/supabase.ts
  - proxy/src/auth/jwks.ts
  - proxy/src/auth/verifyJwt.ts
  - proxy/src/anthropic/forward.ts
  - proxy/src/anthropic/pricing.ts
  - proxy/src/anthropic/tokenize.ts
  - proxy/src/anthropic/usage.ts
  - proxy/src/ledger/balance.ts
  - proxy/src/ledger/preDeduct.ts
  - proxy/src/ledger/settle.ts
  - proxy/src/middleware/sentinel.ts
  - proxy/src/rateLimit/buckets.ts
  - proxy/src/rateLimit/gate.ts
  - supabase/functions/lemon-webhook/index.ts
  - supabase/functions/trial-claim/index.ts
  - supabase/migrations/20260524000000_phase_13_ledger.sql
  - supabase/migrations/20260524000100_rate_buckets_rpc.sql
  - src/main/cloud/proxyClient.ts
  - src/main/auth/proxyJwtFetcher.ts
  - src/bot/brain/anthropicClient.js
  - src/bot/index.js
findings:
  blocker: 4
  warning: 7
  info: 4
  total: 15
status: findings_found
---

# Phase 13: Code Review Report — AI Proxy + Billing + Usage UI

**Reviewed:** 2026-05-23T06:04:11Z
**Depth:** standard
**Files Reviewed:** 24
**Status:** findings_found

## Summary

Phase 13 introduces a substantial new surface (Fly.io proxy, Edge Functions, ledger,
rate limits, billing webhooks, credits UI). The headline correctness, HMAC and JWT
validation primitives are sound and the byte-verbatim cache-control forwarding
invariant is honoured.

However, the review surfaced **four BLOCKERs** that affect billing or session
behaviour in production:

1. The 30-minute JWT rotation pump (`setupJwtRotation`) is never wired into any
   production caller — it is dead code. Long-running cloud-proxy bots therefore
   depend entirely on Supabase TOKEN_REFRESHED firing through `botSupervisor.updateJwt`.
2. Even if `setupJwtRotation` were called, the bot-side handler only writes
   `process.env.CLOUD_PROXY_JWT` (a name no module reads) — it does not call
   `setAuthToken`, so the live `sdk.authToken` is never updated.
3. The streaming branch of `forwardToAnthropic` does not check the upstream HTTP
   status before piping the body as SSE, so an Anthropic 4xx/5xx (non-429) is
   delivered to the client as HTTP 200 with malformed SSE, and the user is charged
   at the full reservation amount for an upstream error.
4. The `rateLimitGate` middleware calls `c.req.json()`. A malformed JSON body
   makes Hono fall through to the generic `app.onError` handler, returning a
   `500 internal_error` envelope instead of the documented `400 invalid_json_body`,
   leaking the wrong sentinel to clients (and reaching the gate at all means a
   future shift of order could double-deduct without producing the documented
   error envelope).

In addition there are seven WARNINGs (ITPM cache-read double counting, stale
state across account switches, missing `c.json` headers contract drift on the
streaming success path, several minor hardening gaps) and four INFOs.

## Blocker Issues

### BL-01: JWT rotation pump is dead code — `setupJwtRotation` has no production caller

**File:** `src/main/auth/proxyJwtFetcher.ts:129-153`
**Issue:** `setupJwtRotation` is exported, fully implemented, and unit-tested,
but no production module ever calls it. A repo-wide grep for `setupJwtRotation`
yields only the file itself and its test file. The supervisor (`botSupervisor.ts`)
never instantiates the pump on summon, so a cloud-proxy bot relies entirely on
Supabase's auto-refresh + `jwtBridge` to drive `updateJwt`. If TOKEN_REFRESHED
does not land before the 1h JWT expiry (slow refresh, Supabase outage, or any
gap in jwtBridge), every cloud-mode bot call begins 401'ing and the documented
30-minute rotation safety net never kicks in.
**Fix:** Call `setupJwtRotation` at supervisor summon time (inside `_summon` when
`aiBackendKind === 'cloud-proxy'`) with the active session's `port1` as the
target, and store the teardown closure on the `ActiveSession` so `_stopActive`
clears the interval. Concretely:

```ts
// inside _summon, after port1 is created and after the bot has spawned:
if (aiBackendKind === 'cloud-proxy') {
  const { setupJwtRotation } = await import('./auth/proxyJwtFetcher');
  session.teardownJwtRotation = setupJwtRotation(port1);
}
// inside _stopActive:
session.teardownJwtRotation?.();
```

### BL-02: Bot's `cloud-jwt-update` handler writes env var the SDK never reads

**File:** `src/bot/index.js:492-503`
**Issue:** When a `cloud-jwt-update` message arrives on the parentPort,
the bot writes the new JWT to `process.env.CLOUD_PROXY_JWT`. Two problems:

1. `anthropicClient.js:buildSdkOptions` reads the token from
   `config.anthropic.cloudMode.authToken` ONCE at SDK construction. The Anthropic
   SDK reads it from `process.env.ANTHROPIC_AUTH_TOKEN` (not `CLOUD_PROXY_JWT`),
   and only at construction.
2. Even if the env-var name matched, an env-var write does not propagate to a
   live SDK instance (`sdk.authToken` is the mutable surface, per the comment
   block at `anthropicClient.js:26-37`).

So if `setupJwtRotation` were wired, the rotation messages would silently land
in an unused env slot and the live SDK would keep using the stale token until
the next `data.type === 'jwt'` message (from jwtBridge) updated it. Combined
with BL-01, JWT rotation for cloud-proxy bots is non-functional via the
documented 13-14 path.
**Fix:** In `src/bot/index.js`, the `cloud-jwt-update` branch must call the same
SDK setter as the `type === 'jwt'` branch:

```js
} else if (data && data.kind === 'cloud-jwt-update' && typeof data.jwt === 'string') {
  try { _running?.setAuthToken?.(data.jwt) } catch {}
}
```

Drop the `process.env.CLOUD_PROXY_JWT = data.jwt` line entirely — it has no
consumer.

### BL-03: Streaming branch ignores upstream status — non-200 (non-429) charged at reservation

**File:** `proxy/src/anthropic/forward.ts:195-247`
**Issue:** After the 429 check at line 156, the code falls through to either the
non-streaming branch (line 169) or the streaming `streamSSE(c, ...)` branch
(line 195). The streaming branch never validates `upstream.status`. If Anthropic
returns 400 (bad request), 403 (auth failure), 500 (upstream error), or any
non-200 with a JSON body but with the SSE request flag set, the proxy:

1. Sets `X-Sei-Remaining-Pct` (line 166) implying success.
2. Opens `streamSSE` which always emits HTTP 200 with `text/event-stream`.
3. Pipes the upstream JSON body byte-for-byte as if it were SSE.
4. Reads no `message_start`/`message_delta` events → falls into the
   `settleAtReservation` branch (line 242), charging the user the full
   worst-case reservation for an upstream error response.

The client sees `HTTP 200 text/event-stream` containing `{"type":"error",...}` —
neither SSE nor JSON, breaking error UX and burning user credits.

**Fix:** Mirror the non-streaming branch's status handling before opening
streamSSE. Treat any non-200 upstream as a refund-path failure:

```ts
if (upstream.status !== 200) {
  clearTimeout(timeoutId);
  await deps.settleAsRefunded(reservation.reservationId);
  // Translate common cases; default to upstream_error.
  if (upstream.status === 400) return sendError(c, { code: 'upstream_error', detail: 'bad_request' });
  if (upstream.status === 401 || upstream.status === 403) {
    console.error('proxy upstream auth failure', upstream.status);
    return sendError(c, { code: 'internal_error' });
  }
  return sendError(c, { code: 'upstream_error' });
}
// only now: c.header('X-Sei-Remaining-Pct', ...); streamSSE(...);
```

### BL-04: Malformed JSON → 500 internal_error from rateLimitGate (not 400 invalid_json_body)

**File:** `proxy/src/rateLimit/gate.ts:33`, `proxy/src/app.ts:39`
**Issue:** The middleware chain order is `verifyJwt → rateLimitGate → forwardToAnthropic`.
`rateLimitGate` calls `await c.req.json()`. On a malformed body, `c.req.json()`
throws, the throw bubbles up to Hono's `app.onError` (`proxy/src/app.ts:56-59`),
and the client gets `500 internal_error` instead of the documented
`400 invalid_json_body` (the latter is only reachable through forward.ts:84-93,
which never runs because the gate throws first). The forward.test.ts case
"9. malformed JSON body → 400 invalid_json_body" passes only because it mounts
forward.ts directly without the gate; the integration suite in app.test.ts has
no malformed-JSON case so the regression is undetected.

Concretely:
- Client POSTs `{not valid json` with valid Bearer JWT.
- gate.ts:33 throws SyntaxError.
- app.ts:56 catches → returns `{"error":"internal_error"}` with 500.

Two consequences:
- The renderer's `proxyErrors` vocabulary (`PROXY_NETWORK`/`PROXY_TIMEOUT`/etc.) has
  no mapping for "I sent garbage" → user sees a generic network failure.
- A change in middleware order could mask a much worse bug because the gate's
  body parse is the first place an attacker-controlled body can throw — every
  middleware below assumes a valid body shape.

**Fix:** Wrap the JSON parse in `gate.ts` and short-circuit with the canonical
400 envelope:

```ts
let body: MessagesBody;
try {
  body = (await c.req.json()) as MessagesBody;
} catch {
  return c.json({ error: 'invalid_json_body' }, 400);
}
```

Add an integration test in `app.test.ts` for malformed-JSON-with-valid-JWT → 400.

## Warning Issues

### WR-01: ITPM rate-limit double-counts cache_read tokens

**File:** `proxy/src/anthropic/tokenize.ts:36-47`, `proxy/src/rateLimit/buckets.ts:111-120`
**Issue:** `buckets.ts` documents that `estInputTokens` already excludes
`cache_read_input_tokens` to match Anthropic Tier 2 ITPM accounting. The
implementation in `tokenize.ts` does no such thing — it counts the entire
serialized `system`, every `message.content`, and `tools` payload, including any
content that will resolve to a cache-read at Anthropic. A user with a heavy
cached persona prefix is over-charged on the ITPM bucket every call, throttling
them faster than Anthropic itself would. The documentation/implementation drift
is hidden because every gate test mocks `estimateInputTokens`.

**Fix:** Two acceptable directions:
- Cheaper: subtract a configurable "cache-read estimate" from the increment in
  the gate path (still imperfect; we don't know cache hits until upstream answers).
- Honest: only charge against ITPM after settle, when actual usage is known. Move
  ITPM accounting out of the pre-flight gate and into `settle` so cache_read
  exclusion is exact. This changes the gate's "fail-early" property — discuss
  before implementing.

At minimum, fix the comment in `buckets.ts:111-120` to reflect that the
exclusion is NOT in effect.

### WR-02: `useCreditsStore` state leaks across account switches

**File:** `src/renderer/src/lib/stores/useCreditsStore.ts:118-119`
**Issue:** `init()` early-returns if `initialized` is true. If a user signs out
and signs in to a different account, the credits store keeps the previous
account's `remaining_pct`, `plan`, `trial_claimed`, and `ai_backend_kind` until
either (a) the renderer reloads, (b) a server push lands (no push will fire on
signed-out → signed-in until a proxy call is made), or (c) someone calls
`refresh()` manually. The PricingIcon, CreditsScreen, and HardStopModal can
show the previous user's data to the new user.

**Fix:** Subscribe `useCreditsStore` to auth changes. On SIGNED_OUT, call
`useCreditsStore.getState().reset()`. On SIGNED_IN, call `init()` again (after
`reset` cleared `initialized`). Mirror the pattern used by `useSyncStore` if it
has one, or add an explicit listener in `App.tsx` next to the existing
`useAuthStore` subscription.

### WR-03: `subscription_updated` defaults unknown statuses to `'active'`

**File:** `supabase/functions/lemon-webhook/index.ts:286-298`
**Issue:** When `subscription_updated` arrives with a `status` value not in
`VALID_SUB_STATUSES` (e.g. `trialing`, `paused`, or any future LS state), the
handler silently falls back to `'active'`. The comment ("a stale `active` is
better than a 5xx retry storm") frames this as DoS mitigation, but it grants
subscriber-tier benefits to anyone in an LS state Sei does not yet model. A
buggy LS dashboard edit, a future LS state, or a misconfigured Sei deploy can
all elevate users to subscriber pricing without payment.

**Fix:** Default to the current row's status if one exists (preserve last known
state), or default to `'past_due'` (still 5xx-safe; matches "you owe us money"
semantics). Never silently bump unknown to `active`.

```ts
const status = (VALID_SUB_STATUSES as readonly string[]).includes(rawStatus)
  ? rawStatus
  : 'past_due';
```

### WR-04: `cancelSubscription` opens LS portal without a session check

**File:** `src/main/cloud/proxyClient.ts:340-353`
**Issue:** Every other method in `proxyClient.ts` calls `getSessionOrNull()` and
short-circuits with `PROXY_NO_SESSION`. `cancelSubscription` does not, opening
the LS billing portal even for signed-out users. LS will prompt them to
re-authenticate against the LS account, but a signed-out Sei user is unlikely
to have an LS session either — they'll see a blank/login portal page with no
context. More importantly, this is the only place the symmetric "must be signed
in" contract is broken; future readers will assume it generalizes.

**Fix:** Mirror the other methods — gate on `getSessionOrNull()`. The portal
URL is public anyway, but the early-return keeps the contract uniform.

### WR-05: SettingsScreen "Switch to managed billing" does not restart an active bot

**File:** `src/renderer/src/screens/SettingsScreen.tsx:56-64`
**Issue:** `handleSwitchToCloud`/`handleSwitchToLocal` call `proxyConfigure(...)`
then `useCreditsStore.refresh()` — they do not stop and re-summon the active
bot. The currently running utilityProcess SDK was constructed with the OLD
backend (BYOK or cloud-proxy) and continues to use it until the user manually
stops and re-summons. A user clicking "Switch to managed billing" with a
running bot will see no behavioural change, draining their BYOK key while the
UI shows the cloud-proxy credits surface.

**Fix:** Before calling `proxyConfigure`, check `useDataStore.summon.kind` and
either:
(a) Block the switch with a confirmation modal: "Stop your bot first.",
(b) Stop the bot automatically and re-summon (heavier UX), or
(c) Show a banner after switching: "Restart your bot for the change to take effect."

### WR-06: `proxyJwtFetcher` AbortController never aborts anything

**File:** `src/main/auth/proxyJwtFetcher.ts:88-99`
**Issue:** The function constructs an `AbortController` and a 5s setTimeout that
calls `controller.abort()`, but the signal is never passed to `refreshSession`
(supabase-js does not accept one — the code's own comment acknowledges this).
The controller and signal are completely unobserved. The 5s timer just fires
`controller.abort()` on a controller with no listeners. There is no actual wall-
clock budget — if `refreshSession` hangs, the await hangs.

**Fix:** Either replace with `Promise.race([refreshSession(), timeoutReject(5000)])`
to enforce a real timeout, or remove the controller entirely (cargo-culted code
that masquerades as a timeout). The current shape is worse than no timeout
because future readers will believe one is in place.

```ts
const refreshP = supabase.auth.refreshSession();
const timeoutP = new Promise<never>((_, rej) =>
  setTimeout(() => rej(new ProxyAuthError('PROXY_REFRESH_FAILED', 'timeout')), 5_000),
);
const { data: refreshed, error } = await Promise.race([refreshP, timeoutP]);
```

### WR-07: `ledger_balance` view exposes the full user-id list to any authenticated user

**File:** `supabase/migrations/20260524000000_phase_13_ledger.sql:103-116`
**Issue:** The view is `select user_id, ... from auth.users u`. The outer
`auth.users u` enumeration is visible to any authenticated caller via
`grant select on public.ledger_balance to authenticated`. While the inner
subqueries respect RLS on `ledger_grants`/`ledger_consumption` (other users'
balances always sum to 0), the view leaks the *existence* of every user_id in
`auth.users`. `select user_id from public.ledger_balance` returns the full
user-id set.

**Fix:** Add a WHERE clause on the view to restrict to `auth.uid()`:

```sql
create view public.ledger_balance as
select u.id as user_id, ...
from auth.users u
where u.id = auth.uid();
```

For service_role callers (proxy preDeduct + remainingPct), the bypass means
they still see all rows. Confirm with `set local role authenticated` test before
deploy; in particular, double-check this does not break `remainingPct` which
selects with `.eq('user_id', userId)` from service_role (it should still work
because service_role bypasses RLS but the where clause uses `auth.uid()` which
returns NULL for service_role — verify).

## Info Issues

### IN-01: `daily_dollar` bucket never refunds the over-reservation delta

**File:** `proxy/src/rateLimit/buckets.ts:122-133`, `proxy/src/ledger/settle.ts`
**Issue:** The daily_dollar bucket is incremented by the worst-case reservation
(1.25× input × 1 + max_tokens × output_rate). Settle reconciles ledger_balance
by recording the lower actual amount, but the rate_buckets row is never
adjusted. A user with high-variance reservations (heavy cache_creation, low
actual output) will hit the daily $5/$20 ceiling on reservations alone even
though the ledger shows plenty of headroom. Probably acceptable as a v1
trade-off (a refund path on the bucket is non-trivial under concurrent calls)
but worth documenting alongside D-51.

**Fix (optional, defer):** Either accept the trade-off and document it in
CONTEXT, or add a `decrement_bucket` RPC that's called from `settle` to remove
`reservation - actual` from the daily_dollar bucket atomically.

### IN-02: `pricing.ts` variable naming — `usd` holds µ$, not USD

**File:** `proxy/src/anthropic/pricing.ts:57-62`, `:84-86`
**Issue:** `const usd = usage.input_tokens * p.input + ...` — the value is in
micro-dollars (because `p.input` is dollars-per-million-tokens, so
`tokens × $/M = µ$`). The variable name `usd` is misleading; the math is
correct but the readability is poor. Same in `estimateReservationMicro`.

**Fix:** Rename to `microUsd` or `micro` to match the surrounding terminology.

### IN-03: `BigInt(Math.ceil(usd))` in pricing can drift for very large costs

**File:** `proxy/src/anthropic/pricing.ts:62`, `:86`
**Issue:** `Math.ceil` operates on a JavaScript Number. For costs exceeding
`Number.MAX_SAFE_INTEGER` (2^53 ≈ 9e15 µ$ ≈ $9 trillion), the conversion loses
precision before BigInt picks it up. The codebase repeatedly cites "BigInt
end-to-end to avoid drift", but the actual cost computation funnels through a
float intermediate. In practice no single call will reach $9 trillion, so this
is not a v1 concern, but it contradicts the documented invariant.

**Fix (defer):** If exactness matters, compute using BigInt throughout:
`BigInt(usage.input_tokens) * BigInt(Math.round(p.input * 1_000_000)) / 1_000_000n`,
ceil'ing manually. Too much complexity for v1; document the float intermediate
as an accepted limitation in pricing.ts.

### IN-04: Discord webhook URL secret-logging hardening could be tightened

**File:** `supabase/functions/lemon-webhook/index.ts:136-148`
**Issue:** The Discord webhook code never logs `url` directly, but the message
body passed to Discord includes the LS `webhook_id` and `event_name` — fine.
However, a future caller who passes user-controlled strings to
`postDiscordAlert(...)` would surface them to Discord verbatim. Add a comment
noting that all callers must escape user-controlled fields before formatting
into the message string.

**Fix:** Add a JSDoc warning on `postDiscordAlert` describing the trust boundary
(no user-controlled strings without sanitization).

---

_Reviewed: 2026-05-23T06:04:11Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
