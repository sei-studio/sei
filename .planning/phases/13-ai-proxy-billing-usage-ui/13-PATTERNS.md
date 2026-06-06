# Phase 13: AI Proxy + Billing + Usage UI — Pattern Map

**Mapped:** 2026-05-22
**Scope source:** `.planning/phases/13-ai-proxy-billing-usage-ui/13-CONTEXT.md` + `.planning/REQUIREMENTS.md` §PROXY-01..13
**Files analyzed:** 28 new/modified across `proxy/`, `supabase/`, `src/main/`, `src/renderer/`, `../sei-website/`, `src/shared/`

---

## File Classification

| New / Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `proxy/package.json` | config | n/a | (no exact analog — Sei is Electron, proxy is plain Node) | none |
| `proxy/fly.toml` | config (infra) | n/a | (no analog — first Fly.io app) | none |
| `proxy/src/index.ts` | controller / router | request-response + streaming | `supabase/functions/delete-me/index.ts` (handler shape) + `submit-report/index.ts` (handler export pattern) | role-match |
| `proxy/src/auth/verifyJwt.ts` | middleware | request-response | `supabase/functions/delete-me/index.ts:36-50` (JWT-via-userClient pattern); structurally `src/main/auth/supabaseClient.ts` (singleton) | partial — jose replaces supabase-js for the proxy |
| `proxy/src/ledger/preDeduct.ts` | service | CRUD (atomic) | `supabase/functions/submit-report/index.ts:185-245` (service_role gated INSERT with prior eligibility check) | role-match |
| `proxy/src/ledger/settle.ts` | service | CRUD | `supabase/functions/submit-report/index.ts:223-245` (service_role UPDATE/INSERT) | role-match |
| `proxy/src/rateLimit/buckets.ts` | service | CRUD | `supabase/functions/submit-report/index.ts:185-221` (rolling-window count → 429) | exact (semantics match RPM/TPM/$ caps) |
| `proxy/src/anthropic/forward.ts` | service | streaming pass-through | `src/bot/brain/anthropicClient.js:37-70` (Anthropic SDK call surface) | partial — proxy does raw fetch + SSE pass-through, not SDK |
| `proxy/src/anthropic/usage.ts` | utility | transform | `src/bot/brain/anthropicClient.js:60-69` (usage object shape) | partial — same shape, different consumer |
| `proxy/src/middleware/sentinel.ts` | middleware | request-response | `src/main/cloud/cloudErrors.ts` (sentinel prefix vocabulary) + `submit-report/index.ts` error envelopes | role-match |
| `supabase/migrations/<ts>_phase_13_ledger.sql` | migration | DDL | `supabase/migrations/20260523000000_moderation_and_reports.sql` (multi-section; tables + RLS + triggers + pg_cron); `20260521000000_characters_tos.sql` (composite-PK immutable-table pattern for `trial_claims`) | exact |
| `supabase/functions/lemon-webhook/index.ts` | controller (Edge Function) | event-driven | `submit-report/index.ts` (HMAC-equivalent gated INSERT, service_role; idempotency precedent via unique columns) + `delete-me/index.ts` (two-client pattern) | role-match — first webhook-receiver in repo |
| `supabase/functions/trial-claim/index.ts` | controller (Edge Function) | request-response | `submit-report/index.ts` (rate-limit + JWT-derived id + service_role INSERT) | exact |
| `supabase/functions/usage-export/index.ts` (optional) | controller (Edge Function) | request-response | `delete-me/index.ts` (two-client pattern); `src/main/auth/exportBuilder.ts` (export envelope) | role-match |
| `src/main/apiKeyStore.ts` (modify) | utility / store | n/a | self — extend existing `backendKind()` return union or add a sibling export | self-extension |
| `src/bot/brain/anthropicClient.js` (modify, sub-delivery a) | service | streaming | self — add ~10-line `cloudMode: { baseURL, authToken }` branch onto existing `new Anthropic(...)` constructor at line 21 | self-extension |
| `src/main/proxyClient.ts` (new) | service | request-response | `src/main/cloud/cloudCharacterClient.ts` (typed wrapper + `withTimeout` + sentinel error vocabulary) + `src/main/auth/edgeFunctionClient.ts` (15s AbortController + envelope) | exact |
| `src/main/auth/proxyJwtFetcher.ts` (new) | utility | request-response | `src/main/auth/edgeFunctionClient.ts:17` (`getSupabaseUrl` + `jwt` param threading) + `src/main/auth/supabaseClient.ts` (session token retrieval) | role-match |
| `src/shared/ipc.ts` + `src/main/ipc.ts` + `src/preload/index.ts` (modify) | IPC contract | request-response | self — extend existing three-layer contract; new channels in `IpcChannel.proxy.*`, `IpcChannel.credits.*`, `IpcChannel.trial.*`, `IpcChannel.subscription.*` mirror `IpcChannel.sync.*` shape (`src/shared/ipc.ts:540+`) | self-extension |
| `src/renderer/src/lib/stores/useCreditsStore.ts` (new zustand) | store | request-response + push | `src/renderer/src/lib/stores/useSyncStore.ts` (whole file — `interface FooState + FooActions + idempotent init() + push-seq race guard`) | exact |
| `src/renderer/src/components/PricingIcon.tsx` (new) | component | render-only | `src/renderer/src/components/IconRail.tsx:31-53` (`RailButton` already exists — PricingIcon is a RailButton consumer, NOT a new sibling primitive) | exact |
| `src/renderer/src/screens/CreditsScreen.tsx` (new) | screen | request-response | `src/renderer/src/screens/SettingsScreen.tsx` (BackRow + section layout + button-row idiom + zustand `useAuthStore` selector) | exact |
| `src/renderer/src/screens/CreditsScreen.module.css` (new) | style | n/a | `src/renderer/src/screens/SettingsScreen.module.css:1-40` (`.root` / `.title` / `.section` / `.row`) | exact |
| `src/renderer/src/components/HardStopModal.tsx` (new) | component | blocking modal | `src/renderer/src/components/AcceptToSModal.tsx` (ESC-suppressed blocking modal, no scrim click, fixed actions — same archetype) + `MigrateLocalCharsModal.tsx:47` (Phase enum) | exact |
| `src/renderer/src/screens/SettingsScreen.tsx` (modify) | screen | n/a | self — add a row to the existing PROFILE / ACCOUNT section (lines 313-378) mirroring the existing "Migrate local characters" row at line 264-269 | self-extension |
| `../sei-website/terms.html` (modify) | document | n/a | self — see Phase 12 plan 14 §7 DMCA section; mirror its anchor + heading layout for §8 Refunds | self-extension |
| `src/shared/legalVersions.ts` (modify) | config | n/a | self — bump both `TOS_VERSION` and `PRIVACY_VERSION` constants (lines 16-17); AcceptToSModal cycle re-triggers automatically | self-extension |

---

## Pattern Assignments

### `proxy/package.json` (config)

**Analog:** none — Sei is Electron; the proxy is a standalone Node service. Project root `package.json` is for the desktop app.

**Copy:**
- Node engine pin (`"engines": { "node": ">=22" }`) consistent with the Fly.io decision (D-38).
- ESM `"type": "module"` matches the existing codebase convention.
- Pin dependency versions exactly (no `^`/`~`) — operator runbook for Fly redeploys should be reproducible.

**Change:**
- Dependencies are the proxy stack only: `hono`, `jose`, `@anthropic-ai/tokenizer`, `@supabase/supabase-js`. NOT mineflayer, NOT Electron, NOT anthropic SDK (proxy uses raw `fetch` to upstream, not the SDK).
- Add a `start` script that runs `node src/index.ts` via tsx or compiled output.

**Pitfalls:**
- Do NOT depend on `@anthropic-ai/sdk` in the proxy. The proxy is a pass-through; using the SDK would re-introduce SSE parsing and break the verbatim streaming requirement (D-40).
- `@anthropic-ai/tokenizer` is server-side only — it must not be added to Sei's renderer or main process (it ships a WASM blob and bloats the Electron bundle).

---

### `proxy/fly.toml` (config — infra)

**Analog:** none — first Fly.io deployment in the project.

**Copy:** N/A — operator follows the Fly.io docs cited in CONTEXT §canonical_refs. The planner should treat this as a tutorial-followed-by-the-operator artifact rather than a code-copy task.

**Change:** Settings from D-38: app name `sei-proxy`, region `iad`, `vm.memory = 256mb`, `vm.cpu_kind = shared`, `vm.cpus = 1`, `min_machines_running = 0`, `max_machines_running = 2`. Health-check path `/health` (proxy must expose this).

**Pitfalls:**
- Scale-to-zero (`min_machines_running = 0`) means the FIRST request after idle eats a cold-start (~2-5s). The 15s `callEdgeFunction` timeout in `edgeFunctionClient.ts` is already too tight if `proxyClient.ts` mirrors it 1:1 — bump proxy timeout to 30s (or split: 5s connect + 30s read).
- Secrets (`ANTHROPIC_API_KEY`, `SUPABASE_JWKS_URL`, `LEMON_SQUEEZY_WEBHOOK_SECRET`) must be set via `fly secrets set ...`, never committed.

---

### `proxy/src/index.ts` (controller — entry)

**Analog:** `supabase/functions/delete-me/index.ts` (the canonical handler shape — CORS preflight → method gate → Bearer check → two-client → action → response).

**Copy — handler skeleton (delete-me lines 25-50):**

```ts
// Mirror this gate sequence at the top of the Hono route:
// 1. OPTIONS → CORS preflight
// 2. method !== POST → 405
// 3. missing Bearer → 401 'missing_jwt'
// 4. verifyJwt() — invalid → 401 'invalid_jwt'
// 5. ... domain logic ...
```

The Hono equivalent registers a single `app.post('/v1/messages', handler)` plus an OPTIONS preflight that returns `corsHeaders` adapted for the proxy origin (not the Edge Function `'null'` origin — see below).

**Change:**
- Hono Router replaces `Deno.serve`. Hono's `c.req` / `c.json()` / `c.body()` shape replaces the raw `Request`/`Response`.
- Streaming SSE pass-through requires `c.body(stream)` with `Content-Type: text/event-stream` — NOT `c.json()`. See `anthropic/forward.ts`.
- The two-client pattern (anon+user vs service_role) does NOT apply directly — the proxy uses `jose` for JWT verification (D-39) and `@supabase/supabase-js` with the service_role key for ledger writes. There is no per-request `userClient` because the proxy never proxies user-scoped supabase queries.
- Add `X-Sei-Remaining-Pct` response header on every successful Anthropic response (D-41).

**Pitfalls:**
- Edge Function `corsHeaders` uses `Access-Control-Allow-Origin: 'null'` (see `_shared/cors.ts` — desktop-app callers from `file://` send `Origin: null`). The proxy is called from Sei's `anthropicClient.js` (Node-side, no browser origin) — `Origin: null` is still correct. Do NOT copy a permissive `'*'` value; the JWT verification is the trust boundary, but origin-pinning is defense-in-depth.
- Errors MUST go through `middleware/sentinel.ts` so the client sees one of the canonical shapes (`rate_limited`, `payment_required`, `service_at_capacity`, etc.). The renderer keys hard-stop / banner UI off these strings.
- A pre-flight 200 must be `'ok'` plain text per `_shared/cors.ts` — do not return a JSON body for OPTIONS.

---

### `proxy/src/auth/verifyJwt.ts` (middleware)

**Analog:**
- `supabase/functions/delete-me/index.ts:36-50` — for the JWT-verification position in the request lifecycle and the 401 envelope shapes.
- `src/main/auth/supabaseClient.ts` — for the singleton-once pattern (instantiate the JWKS client once at module load, not per request).

**Copy — envelope shape (delete-me lines 46-49):**

```ts
const { data: userData, error: userErr } = await userClient.auth.getUser();
if (userErr || !userData.user) {
  return new Response(JSON.stringify({ error: 'invalid_jwt' }), { status: 401, headers: corsHeaders });
}
const userId = userData.user.id;
```

Translate to jose:

```ts
const { payload } = await jwtVerify(token, JWKS, { audience: 'authenticated' });
// payload.sub is the user_id used for ledger lookups (D-39).
```

**Change:**
- Use `jose.createRemoteJWKSet(new URL(SUPABASE_JWKS_URL))` ONCE at module load with `cacheMaxAge: 3600_000` (1h — per D-39).
- Verify `aud === 'authenticated'` and presence of `exp`; jose handles `exp` automatically when the JWT carries it.
- Return the verified `sub` (canonical `user_id`) so the route handler can pass it to `preDeduct.ts` / `buckets.ts`.

**Pitfalls:**
- Do NOT call Supabase Auth API per request — that defeats the entire reason for adopting jose (D-39 rationale: "avoids per-request network hop").
- JWKS endpoint URL is `${SUPABASE_URL}/auth/v1/.well-known/jwks.json` — bake into env var so a future Supabase project swap is one variable.
- jose throws `JWTExpired`, `JWTInvalid`, `JWKSNoMatchingKey` — catch broadly and return the canonical `{ error: 'invalid_jwt' }` envelope. Do NOT leak the inner error message to the client.

---

### `proxy/src/ledger/preDeduct.ts` (service)

**Analog:** `submit-report/index.ts:185-245` (service_role gated INSERT with prior eligibility check + fail-closed on DB error).

**Copy — fail-closed shape (submit-report lines 198-210):**

```ts
if (rateErr) {
  // Fail-closed — if we can't check, we don't INSERT.
  return new Response(
    JSON.stringify({ ok: false, code: 'rate_check_failed', ... }),
    { status: 500, ... },
  );
}
```

This is the pattern for "if the gating SELECT failed, refuse the action" — preDeduct must do the same when the `ledger_balance` row-lock query errors.

**Core pattern — atomic deduction (D-50):**

```ts
// Single-statement INSERT-IF-BALANCE-GTE — Postgres row-lock holds across both reads.
// Reservation row count = 0 → 402 Payment Required.
const { data, error } = await admin.rpc('reserve_credits', {
  p_user_id: userId,
  p_micro: reservationMicro,
  p_call_id: anthropicCallId,
});
```

The atomic SQL goes in the migration (`ledger_grants` + `ledger_consumption` migration); this file is the TS wrapper that calls the RPC and maps results to typed responses.

**Change:**
- All amounts in `bigint` micro-dollars (D-47). Use `BigInt` literals or string-form to round-trip JSON safely.
- Returns `{ ok: true, reservationId, balanceAfterMicro }` or `{ ok: false, code: 'payment_required' }` — sentinel routes through `middleware/sentinel.ts`.

**Pitfalls:**
- JavaScript `Number` cannot represent micro-dollars accurately past `2^53` — micro = millionths, $9_007_199 = MAX_SAFE_INTEGER ceiling. We're nowhere near that for a single user but the ledger row math (`sum(grants) - sum(consumption)`) WILL exceed it across a heavy organization. Use `BigInt` end-to-end.
- The atomic check MUST happen in one SQL statement (RPC or `INSERT ... WHERE ...`). A "SELECT balance, then INSERT" pair has a TOCTOU race that lets a user double-spend across concurrent requests.
- 1.25× multiplier (D-50) is on top of `estimated_input_tokens × input_rate + max_tokens × output_rate`. Cache-write tokens are billed at 1.25× the input rate by Anthropic; that's where the 1.25× comes from — do NOT confuse the cache-write multiplier with a safety margin (they are the same number coincidentally and the planner may want to bump it to ~1.4× for safety after observing real cache_creation ratios — see CONTEXT §Claude's Discretion).

---

### `proxy/src/ledger/settle.ts` (service)

**Analog:** `submit-report/index.ts:223-245` (service_role UPDATE with error envelope).

**Core pattern — replace reservation with actual:**

```ts
// After Anthropic response: UPDATE the reservation row to settled with actual cost.
// The difference (reservation_micro - actual_micro) auto-refunds to ledger_balance.
const { error } = await admin
  .from('ledger_consumption')
  .update({ reservation_state: 'settled', micro: actualMicro })
  .eq('id', reservationId);
```

**Change vs analog:**
- Two-row write atomicity matters less here because the worst-case is a small over-charge (reservation stays as 'reserved' until settled). A periodic janitor sweep (see migration §pg_cron) marks orphaned reservations as 'refunded' after a 60s TTL.

**Pitfalls:**
- If the Anthropic SSE stream is interrupted mid-response (network drop), the proxy MUST still settle with whatever usage tokens were already observed in the partial stream. Otherwise the reservation pins credits forever. Catch the abort path and settle on best-effort tokens-counted-so-far.
- The cache-savings refund (D-43) is implicit in the reservation−actual delta; do NOT add a separate "refund" code path. The single UPDATE handles it.

---

### `proxy/src/rateLimit/buckets.ts` (service)

**Analog:** `submit-report/index.ts:185-221` (rolling-window count → 429 with structured retry message).

**Copy — 429 shape (submit-report lines 212-221):**

```ts
return new Response(
  JSON.stringify({ ok: false, code: 'rate_limited', message: FRIENDLY_RATE_LIMITED_MESSAGE }),
  { status: 429, ... },
);
```

D-52 specifies the proxy's 429 envelope:

```ts
{ error: 'rate_limited', kind: 'rpm'|'itpm'|'otpm'|'daily_dollar', retry_after_seconds: <int> }
```

**Change vs analog:**
- Four bucket kinds, not one: `rpm` / `itpm` / `otpm` / `daily_dollar`. UPSERT incrementing `count` if `window_start` is still within the window; otherwise reset.
- Tier-aware (D-51): trial = 20 RPM / 30K input TPM / $1/day-first-7-days-then-$5; subscriber = 60 RPM / 200K TPM / $20/day. Tier read from `subscription_status` table on each request (cache for ~30s in proxy memory to avoid hot-path DB read).
- pg_cron nightly cleanup defined in the migration — proxy code does not sweep.

**Pitfalls:**
- All four caps are LAUNCH GATES (REQUIREMENTS PROXY-09 + ROADMAP Pitfall 2). Do not ship if one bucket is unimplemented.
- `retry_after_seconds` must be computed (not hardcoded) — for RPM it's `60 - (now - window_start)`; for daily_dollar it's the seconds-until-midnight in the user's tz proxy (UTC for v1 is fine).
- Anthropic 429 (org-level cap hit) is a DIFFERENT response: D-44 specifies 503 `service_at_capacity` to the client. Do not conflate.

---

### `proxy/src/anthropic/forward.ts` (service — streaming pass-through)

**Analog:** `src/bot/brain/anthropicClient.js:37-70` (the existing Anthropic SDK call surface — shows what the request/response shapes look like).

**Copy:** request body shape from `anthropicClient.js:51-57`:

```js
const req = {
  model,
  max_tokens: maxTokens,
  system: systemBlocks,
  tools: _tools,
  messages,
};
```

The proxy receives this verbatim from the client (since `cloudMode` in sub-delivery (a) just re-points the SDK's `baseURL`) and forwards it to Anthropic with the org API key.

**Core pattern — verbatim pass-through with SSE streaming:**

```ts
const upstream = await fetch('https://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: {
    'x-api-key': ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  },
  body: rawBody,  // verbatim from client
  signal: abortController.signal,
});

// Stream SSE chunks back to client, parsing `event: message_stop` to extract usage.
return new Response(upstream.body, {
  status: upstream.status,
  headers: {
    ...sseHeaders,
    'X-Sei-Remaining-Pct': remainingPct.toString(),
  },
});
```

**Change vs analog:**
- The existing `anthropicClient.js` uses the SDK with a 30s default timeout via `sdk.messages.create(req, { signal, timeout })`. The proxy uses raw `fetch` (NOT the SDK) so streaming is verbatim and there's no SDK-internal SSE parser that could mangle the upstream bytes.
- Cancellation: when client disconnects (`req.signal.aborted`), the proxy must abort the upstream fetch to free Anthropic capacity.

**Pitfalls:**
- DO NOT use the Anthropic SDK in the proxy. The SDK auto-buffers SSE for usage extraction; that buffering breaks the verbatim pass-through and adds latency. Use raw `fetch` and a TransformStream that tees the bytes (one copy to the client, one to a usage-extractor).
- Anthropic returns 429 with `Retry-After` header when the org tier is hit — translate to 503 `service_at_capacity` (D-44), do NOT propagate as 429 (the client treats 429 as user-level — D-52).
- `anthropic-version` header is required. Use the same version Sei's SDK currently pins to (check the SDK's `package.json` peer dep, then hardcode here).

---

### `proxy/src/anthropic/usage.ts` (utility — transform)

**Analog:** `src/bot/brain/anthropicClient.js:60-69` — the SDK-parsed usage object shape.

**Copy — usage object reference:**

The Anthropic response includes `usage.input_tokens`, `usage.cache_creation_input_tokens`, `usage.cache_read_input_tokens`, `usage.output_tokens`. These are the fields D-50 references for actual-cost computation.

**Core pattern — compute actual micro-dollars (D-50):**

```ts
function computeActualMicro(usage: AnthropicUsage, model: ModelPricing): bigint {
  const inputCents = BigInt(usage.input_tokens) * model.inputRateMicroPerToken;
  const cacheCreate = BigInt(usage.cache_creation_input_tokens ?? 0) * model.inputRateMicroPerToken * 125n / 100n;
  const cacheRead = BigInt(usage.cache_read_input_tokens ?? 0) * model.inputRateMicroPerToken * 10n / 100n;
  const output = BigInt(usage.output_tokens) * model.outputRateMicroPerToken;
  return inputCents + cacheCreate + cacheRead + output;
}
```

**Pitfalls:**
- For streaming responses, usage arrives in the FINAL `message_stop` SSE event — proxy must accumulate until that event arrives before settling.
- Tokenizer estimation uses `@anthropic-ai/tokenizer.countTokens()` server-side (D-50a). Don't rely on the client to send token estimates — pre-deduct is the trust boundary.
- Model-specific rates: hardcode the table for v1.0 (haiku 3.5 + sonnet 4.5 + opus 4.7) — pull into a `pricing.ts` constants module so a future tier change is one PR.

---

### `proxy/src/middleware/sentinel.ts` (middleware)

**Analog:** `src/main/cloud/cloudErrors.ts` (sentinel prefix convention — `CLOUD_*` strings that the renderer ERROR_COPY map routes on).

**Copy — sentinel pattern:** the existing project uses string-prefix sentinels for cross-process error vocabulary. Proxy reuses this idea for client-facing error codes.

**Core pattern — canonical error envelopes:**

```ts
type ProxyError =
  | { error: 'rate_limited'; kind: 'rpm'|'itpm'|'otpm'|'daily_dollar'; retry_after_seconds: number }
  | { error: 'payment_required' }
  | { error: 'service_at_capacity'; retry_after_seconds: number }
  | { error: 'invalid_jwt' }
  | { error: 'missing_jwt' }
  | { error: 'upstream_error'; detail?: string };
```

Status codes are mapped per code at the response-formatter step (sentinel.ts). Renderer keys hard-stop / banner / disabled-input UI off these codes.

**Pitfalls:**
- Do NOT add an `'unknown'` fallthrough that swallows everything. Every error path must be enumerated — a renderer that sees an unknown code shows the wrong UI (e.g., a hard-stop modal for a transient network blip).
- The 402 `payment_required` code triggers the hard-stop modal (D-56). It must ONLY be emitted when the ledger is genuinely empty — not when a request fails for any other reason. Mis-emission corrupts the user's perception of their balance.

---

### `supabase/migrations/<ts>_phase_13_ledger.sql` (DDL)

**Analog:**
- `supabase/migrations/20260523000000_moderation_and_reports.sql` — multi-section migration with tables + RLS + triggers + pg_net/pg_cron extension. **This is the closest structural twin** (5 sections × ~30 lines each, ordered intentionally per Pitfall comments).
- `supabase/migrations/20260521000000_characters_tos.sql:53-68` — composite-PK immutable-table pattern (no UPDATE/DELETE policies) for `trial_claims`.

**Copy — section header convention:**

```sql
-- ============================================================
-- Section 1 of 6 — ledger_grants: grants table + RLS
-- ============================================================
```

Mirror the comment headers in the moderation migration — these double as a runbook for the operator applying the migration manually.

**Copy — RLS pattern (characters_tos.sql:32-44):**

```sql
alter table public.ledger_grants enable row level security;
create policy "ledger_grants_select_own" on public.ledger_grants
  for select using (user_id = auth.uid());
-- No insert/update/delete policies — all writes via service_role from
-- proxy + lemon-webhook + trial-claim Edge Functions.
```

Naming convention: `<table>_<verb>_<scope>` (e.g., `ledger_grants_select_own`).

**Copy — trigger boilerplate (characters_tos.sql:46-50):**

```sql
create or replace function public.tg_set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
```

Already exists; reuse the function rather than redefining.

**Tables to ship in this migration (per D-47 + D-51 + D-42):**

1. `ledger_grants (id uuid pk, user_id uuid fk users on delete cascade, kind text check ('trial'|'pack'|'subscription'), credits_micro bigint, source text, lemon_event_id text unique, granted_at timestamptz default now(), expires_at timestamptz null)`
2. `ledger_consumption (id uuid pk, user_id uuid fk users on delete cascade, micro bigint, anthropic_call_id text, reservation_state text check ('reserved'|'settled'|'refunded'), deducted_at timestamptz default now())`
3. `ledger_balance` materialized view per user + AFTER INSERT trigger on both ledger tables that calls `refresh materialized view concurrently public.ledger_balance` (concurrently — required for live workload; needs a unique index on the MV).
4. `subscription_status (user_id uuid pk fk users on delete cascade, lemon_subscription_id text, kind text check ('trial'|'pack'|'unlimited'), active boolean, current_period_end timestamptz, cancelled_at timestamptz)`
5. `rate_buckets (user_id uuid, bucket_kind text check ('rpm'|'itpm'|'otpm'|'daily_dollar'), count bigint, window_start timestamptz, primary key (user_id, bucket_kind))` + pg_cron job `nightly-rate-buckets-cleanup` that deletes rows `where window_start < now() - interval '25 hours'`.
6. `trial_claims (mc_username text primary key, sei_user_id uuid not null references auth.users(id) on delete set null, claimed_at timestamptz default now())` — RLS enabled, NO update/delete policies (immutable; mirrors `tos_acceptance`).

**Atomic-reserve RPC:**

```sql
create or replace function public.reserve_credits(p_user_id uuid, p_micro bigint, p_call_id text)
returns json language plpgsql security definer as $$
declare v_balance bigint;
begin
  select balance_micro into v_balance from public.ledger_balance where user_id = p_user_id for update;
  if v_balance is null or v_balance < p_micro then
    return json_build_object('ok', false, 'code', 'payment_required');
  end if;
  insert into public.ledger_consumption (user_id, micro, anthropic_call_id, reservation_state)
    values (p_user_id, p_micro, p_call_id, 'reserved') returning id into ... ;
  return json_build_object('ok', true, 'reservation_id', ..., 'balance_after_micro', v_balance - p_micro);
end $$;
grant execute on function public.reserve_credits(uuid, bigint, text) to service_role;
```

**Pitfalls:**
- The materialized view + trigger refresh approach is fast-write-slow-read; for Phase 13's expected QPS (well under 100/sec) it's fine. If proxy traffic grows, the planner should switch to a `ledger_balance` regular view computed from `sum(grants) - sum(consumption)`.
- `lemon_event_id text unique` on `ledger_grants` is the idempotency anchor for the webhook (D-46). Without `unique`, a retried webhook double-credits the user.
- `pg_cron` requires the extension enabled at project level. Confirm Supabase plan supports it; the moderation migration already enables `pg_net` so we know extension-grants work. If pg_cron is unavailable, fall back to a Database Webhook → Edge Function janitor (slower but works).
- `rate_buckets` does NOT have an `id` PK — composite `(user_id, bucket_kind)` is the natural key. UPSERTs use `on conflict (user_id, bucket_kind)`.
- `trial_claims.sei_user_id` uses `on delete set null` (not cascade) so a deleted account doesn't free the username for re-claim — abuse mitigation per D-42a.
- RLS: every new table gets `enable row level security` + a `select_own` policy AND nothing else. Don't forget — Phase 12 has Pitfall 4 documented for `reports` (RLS enabled with zero insert policies) — same pattern here.

---

### `supabase/functions/lemon-webhook/index.ts` (Edge Function)

**Analog:**
- `supabase/functions/submit-report/index.ts` — for HMAC-style signature verification precedent (the function has rate-limit gating + service_role privileged action — same trust-boundary shape).
- `supabase/functions/delete-me/index.ts:34-50` — for the two-client pattern (anon-userClient unused here since the webhook has no caller JWT, adminClient does all DB writes).

**Copy — handler skeleton (delete-me lines 25-50, sans Bearer check):**

```ts
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  // NO Bearer check — webhook is authenticated by HMAC of the body, not a JWT.
  // ...HMAC verify here...
  // ...service_role INSERT...
});
```

**Core pattern — HMAC verify + idempotent INSERT:**

```ts
const signature = req.headers.get('X-Signature');
const rawBody = await req.text();  // MUST be raw bytes; JSON.parse + restringify breaks HMAC
const expected = await hmacSha256(LEMON_SECRET, rawBody);
if (!timingSafeEqual(signature, expected)) return new Response('bad signature', { status: 401 });

const event = JSON.parse(rawBody);
// Idempotency: ledger_grants.lemon_event_id has UNIQUE constraint.
const { error } = await admin.from('ledger_grants').insert({
  user_id: event.meta.custom_data.user_id,
  kind: event.meta.event_name === 'subscription_created' ? 'subscription' : 'pack',
  credits_micro: computeCreditsForVariant(event.data.attributes.variant_id),
  source: 'lemon_squeezy',
  lemon_event_id: event.meta.event_id,
});
if (error && error.code === '23505') {
  // unique_violation — already processed. Return 200 so Lemon doesn't retry.
  return new Response(JSON.stringify({ ok: true, idempotent: true }), { status: 200, ... });
}
```

**Change vs analog:**
- No JWT (webhook is server-to-server). Trust boundary is HMAC signature on the raw body.
- 6 event types to handle (D-46): `order_created`, `subscription_created`, `subscription_updated`, `subscription_payment_success`, `subscription_cancelled`, `subscription_expired`. Each updates `ledger_grants` and/or `subscription_status`.
- Failed-to-attribute purchases (missing/invalid `custom_data.user_id`) → email alert + Discord webhook for manual reconciliation (D-46). Mirror the report-fanout pattern from `submit-report` (which trips `tg_notify_report_inserted` via pg_net) but inline — there's only one webhook fan-out target.

**Pitfalls:**
- HMAC verification MUST happen on the RAW body bytes. Calling `req.json()` first and re-stringifying changes whitespace/key-order and the HMAC will not match. Use `req.text()` first, then `JSON.parse` after verification.
- Lemon Squeezy event IDs are UUIDs — store as `text unique` not `uuid` in case Lemon ever changes format.
- Subscription `subscription_payment_success` events fire monthly; each one grants a fresh `credits_micro` row. Without the unique constraint on `lemon_event_id` a retry double-credits.
- A webhook retry after >7 days is plausible if Lemon ever has an outage. The unique constraint still catches it, but the planner may want a "ledger row created >24h after lemon event timestamp → log to alert channel" diagnostic (CONTEXT §Claude's Discretion).
- `corsHeaders` from `_shared/cors.ts` has `Allow-Origin: 'null'`. Lemon Squeezy's webhook delivery is server-to-server (no browser origin) so `null` works, but ensure Allow-Headers includes `x-signature` (the lemon header name).

---

### `supabase/functions/trial-claim/index.ts` (Edge Function)

**Analog:** `supabase/functions/submit-report/index.ts` — best match. Rate-limit + JWT-derived id + service_role INSERT is exactly the shape we need.

**Copy — JWT-derived id + rate-limit + service_role INSERT (submit-report verbatim shape):**

```ts
// 1. CORS preflight + method gate (lines 107-112)
// 2. Bearer check → 401 (lines 114-120)
// 3. userClient.auth.getUser() → 401 if invalid (lines 137-143)
// 4. Body parse + validate (lines 150-173)
// 5. service_role INSERT (lines 229-245)
```

**Core pattern — INSERT ... ON CONFLICT DO NOTHING RETURNING (D-42):**

```ts
const userId = userData.user.id;  // from verified JWT — NEVER from body
const { mc_username } = await req.json();
// Body validation: trim + length 1-16 + ASCII alphanumeric/underscore (same regex
// as characterSchema mojang_username validation — keep in lockstep).

const { data: claimed, error } = await admin
  .from('trial_claims')
  .insert({ mc_username, sei_user_id: userId })
  .select()
  .single();

if (error && error.code === '23505') {
  // unique_violation — already claimed.
  return new Response(JSON.stringify({ ok: false, code: 'already_claimed' }), { status: 409, ... });
}
// ON SUCCESS: insert a $1 trial grant into ledger_grants.
await admin.from('ledger_grants').insert({
  user_id: userId,
  kind: 'trial',
  credits_micro: 1_000_000n,  // $1 (CONTEXT §Specifics).
  source: 'trial_gate',
});
```

**Pitfalls:**
- `mc_username` validation must match the existing per-character `mojang_username` regex in `src/shared/characterSchema.ts` (`^[A-Za-z0-9_]{1,16}$`). Don't invent a new shape.
- This Edge Function is the trust boundary for the trial gate. RLS on `trial_claims` blocks user-level INSERT (no policy); only this function (service_role) can insert. Defense-in-depth.
- T-12-05-01 spoofing mitigation applies: `sei_user_id` comes from the verified JWT, NEVER from the body.
- A retry of the same call by the same user (network blip + re-submit) returns the `already_claimed` 409. Renderer should treat 409 as a no-op (trial credits already in their ledger).
- Atomicity gap: between the trial_claims INSERT and the ledger_grants INSERT, the function process could die. The ledger_grants INSERT must be idempotent — add a `unique (user_id, kind)` partial index `where kind = 'trial'` so a retry doesn't double-grant.

---

### `supabase/functions/usage-export/index.ts` (Edge Function — optional)

**Analog:** `supabase/functions/delete-me/index.ts` (auth verification + service_role) + `src/main/auth/exportBuilder.ts` (export envelope shape — JSON download with metadata header).

**Copy:** delete-me's two-client pattern. Then a service_role SELECT across `ledger_grants` + `ledger_consumption` + `subscription_status` for the authenticated user, returning a JSON blob.

**Change:** Returns a downloadable JSON file rather than a 204 — content-disposition header for browser-style download. (Renderer save-file dialog is in main process via existing `sei.exportData()` IPC.)

**Pitfalls:**
- This Edge Function is OPTIONAL per CONTEXT. The planner may defer it to v1.x if Phase 13 scope grows.
- Re-uses the existing AUTH-07 export precedent. Don't invent a parallel export pipeline — extend `exportBuilder.ts` if possible to include billing rows.

---

### `src/main/apiKeyStore.ts` (modify)

**Analog:** self — extend the existing module.

**Copy / change:**

The current `backendKind()` function (lines 64-69) returns the safeStorage backend ('kwallet' | 'basic_text' | etc.). PROXY-11 wants a different concept: which AI backend is active (`'cloud-proxy'` | `'local'`). Two clean approaches:

**Option A (preferred):** Rename the existing function to `safeStorageBackendKind()` and introduce a NEW function `aiBackendKind(): Promise<'cloud-proxy' | 'local'>`. Add a tiny persisted setting in `configStore.ts` keyed `ai_backend_kind`. Default: `'local'` (BYOK).

**Option B:** Don't rename. Add a new exported constant + setter in this file that lives alongside the existing safeStorage logic.

The planner should choose Option A — the name collision is genuine and Option B accumulates technical debt.

**Pitfalls:**
- The renderer keys credit-UI visibility off `aiBackendKind === 'cloud-proxy'` (D-57). All UI gates (PricingIcon, CreditsScreen, HardStopModal) must read from a single store-backed source of truth, not duplicate logic.
- BYOK users switching to cloud-proxy via Settings CTA must trigger a re-init of `anthropicClient.js` config — emit a status push so the renderer's `useCreditsStore` initializes.

---

### `src/bot/brain/anthropicClient.js` (modify — sub-delivery a)

**Analog:** self — extend the existing factory function (lines 20-25).

**Copy / change (~10 lines per CONTEXT D-40):**

```js
// Before (line 21):
const sdk = new Anthropic({ apiKey: config.anthropic.api_key })

// After:
const sdkOpts = config.anthropic.cloudMode
  ? {
      baseURL: config.anthropic.cloudMode.baseURL,         // e.g. https://api.sei.gg
      authToken: config.anthropic.cloudMode.authToken,     // JWT minted via Supabase
      apiKey: 'unused-but-required-by-sdk',                // SDK still requires the field
    }
  : { apiKey: config.anthropic.api_key };
const sdk = new Anthropic(sdkOpts);
```

(The SDK's `authToken` option sets `Authorization: Bearer <token>` — exactly what the proxy's `verifyJwt.ts` expects.)

**Pitfalls:**
- JWT rotation: a Sei session JWT typically expires in 1h. The bot process can run for many hours. `proxyJwtFetcher.ts` must refresh the JWT before expiry and the bot must accept new tokens mid-session — easiest is a periodic `sdk.authToken = newJwt` reassignment (the SDK reads the field per request).
- Sub-delivery (a) is INTENTIONALLY ~10 lines. Resist the urge to refactor to an `LlmProvider` interface here — that's Phase 14's sub-delivery (b). Keep this change minimal so the proxy can ship before the Phase 14 refactor.
- Anthropic SDK does NOT pass through arbitrary response headers. The `X-Sei-Remaining-Pct` header (D-41) must be read by `proxyClient.ts` (which calls the proxy directly) OR the SDK's raw-response hook (`onResponse`) — investigate which is cleaner. NOTE: this is the trickiest part of sub-delivery (a) — the planner may need to write a thin custom client instead of using the SDK for the proxy path.

---

### `src/main/proxyClient.ts` (new)

**Analog:**
- `src/main/cloud/cloudCharacterClient.ts` — typed wrapper + `withTimeout` + sentinel error vocabulary. **Best structural match** (whole file).
- `src/main/auth/edgeFunctionClient.ts` — 15s AbortController + discriminated-union response shape.

**Copy — withTimeout helper (cloudCharacterClient.ts:56-69) verbatim:**

```ts
async function withTimeout<T>(label: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const handle = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fn(controller.signal);
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') {
      throw new Error(`${PROXY_TIMEOUT}: ${label}`);
    }
    throw err;
  } finally {
    clearTimeout(handle);
  }
}
```

**Copy — sentinel error vocabulary (cloudErrors.ts pattern):**

Define a module `src/main/cloud/proxyErrors.ts` (or inline in proxyClient.ts) with:

```ts
export const PROXY_TIMEOUT = 'PROXY_TIMEOUT';
export const PROXY_PAYMENT_REQUIRED = 'PROXY_PAYMENT_REQUIRED';
export const PROXY_RATE_LIMITED = 'PROXY_RATE_LIMITED';
export const PROXY_SERVICE_AT_CAPACITY = 'PROXY_SERVICE_AT_CAPACITY';
export const PROXY_INVALID_JWT = 'PROXY_INVALID_JWT';
```

**Copy — discriminated union response (edgeFunctionClient.ts:26-28):**

```ts
export type ProxyResponse =
  | { ok: true; data: unknown; remainingPct: number }
  | { ok: false; code: ProxyErrorCode; status: number; message: string; retryAfterSeconds?: number };
```

**Methods to expose (per CONTEXT integration points):**
- `trialClaim(mc_username)` — calls `/functions/v1/trial-claim` via `callEdgeFunction`. NOT a proxy method — re-uses Edge Function infrastructure.
- `creditsRemaining()` — last-known `X-Sei-Remaining-Pct` from any prior call (the store reads this; proxyClient just exposes the latest).
- `openCheckout(variantId)` — composes the Lemon Squeezy URL with `checkout[custom][user_id]=<jwt_sub>` and calls `shell.openExternal`. (Doesn't actually hit the proxy.)
- `cancelSubscription()` — calls Lemon Squeezy customer portal via `shell.openExternal`, OR an Edge Function `subscription-cancel` if we choose API-side cancellation.

**Change vs `cloudCharacterClient.ts`:**
- Some methods go through `callEdgeFunction` (trial-claim, lemon-webhook is server-side only). Others are direct fetches to the proxy URL (proxy upstream calls). Plus methods that just compose URLs and `shell.openExternal`.
- The mix is intentional — proxyClient is the front-door coordination point.

**Pitfalls:**
- Do NOT bypass the existing `callEdgeFunction` wrapper for Edge Function calls (trial-claim, etc.). It already has the 15s timeout + AbortController + discriminated-union envelope. Re-using it keeps the error-handling story uniform.
- Anthropic-pass-through calls from the bot DO NOT go through `proxyClient.ts` — they go through `anthropicClient.js` directly (which has its own SDK timeout). proxyClient is only for ledger/billing IPC, not for the message loop.
- Token rotation: `proxyClient` needs a fresh JWT for every call. Get it via `src/main/auth/supabaseClient.ts` `getClient().auth.getSession()`.

---

### `src/main/auth/proxyJwtFetcher.ts` (new)

**Analog:**
- `src/main/auth/edgeFunctionClient.ts:17` — uses `getSupabaseUrl()` + a `jwt` param. The pattern of "fetch a fresh JWT, pass it as Bearer" is exactly what we need; just exposed as a fetcher rather than as a parameter.
- `src/main/auth/supabaseClient.ts` — has the session retrieval logic (`getClient().auth.getSession()`).

**Copy / change:**

```ts
import { getClient } from './supabaseClient';

const JWT_REFRESH_THRESHOLD_MS = 5 * 60 * 1000;  // refresh 5min before expiry

export async function getProxyJwt(): Promise<string> {
  const supabase = getClient();
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session) throw new Error('PROXY_NO_SESSION');

  const expiresAtMs = (data.session.expires_at ?? 0) * 1000;
  if (Date.now() > expiresAtMs - JWT_REFRESH_THRESHOLD_MS) {
    // Force refresh — token approaching expiry
    const { data: refreshed, error: refreshErr } = await supabase.auth.refreshSession();
    if (refreshErr || !refreshed.session) throw new Error('PROXY_REFRESH_FAILED');
    return refreshed.session.access_token;
  }
  return data.session.access_token;
}
```

**Pitfalls:**
- supabase-js refreshSession has retry logic but no timeout — wrap in 5s AbortController if it ever becomes a hot path.
- The proxy verifies `aud === 'authenticated'` (D-39). Supabase JWTs have this by default; do NOT mint a custom token with a different aud.
- For long-running bot sessions, the bot process needs to receive new tokens. Send via the existing MessagePortMain (the bot's parentPort) — see `src/bot/index.js:60-80` for the existing pattern.

---

### `src/shared/ipc.ts` + `src/main/ipc.ts` + `src/preload/index.ts` (modify)

**Analog:** self — extend the existing three-layer contract.

**Copy — IpcChannel namespacing convention (`src/shared/ipc.ts:540+`):**

```ts
export const IpcChannel = {
  // ... existing namespaces ...
  proxy: {
    configure:    'proxy:configure',         // BYOK ↔ cloud-proxy toggle
  },
  trial: {
    claim:        'trial:claim',
  },
  credits: {
    get:          'credits:get',
    openCheckout: 'credits:openCheckout',
    statusUpdate: 'credits:status:update',   // push channel — remaining_pct changes
  },
  subscription: {
    status:       'subscription:status',
    cancel:       'subscription:cancel',
  },
} as const;
```

**Copy — Zod validation at the IPC boundary (`src/main/ipc.ts:52-91`):**

Every new handler must validate its args with a Zod schema (`PlaintextSchema`, `IdSchema`, etc. are precedents). For Phase 13:
- `trial.claim` — `z.object({ mc_username: z.string().regex(/^[A-Za-z0-9_]{1,16}$/) })`
- `credits.openCheckout` — `z.object({ kind: z.enum(['pack', 'subscription']) })`
- `subscription.cancel` — no args, but the handler still validates with `z.undefined()` so a tampered renderer can't sneak a payload through.

**Copy — Preload binding pattern (`src/preload/index.ts:23-100`):**

Add one entry per new channel:

```ts
trialClaim: (mc_username: string) => ipcRenderer.invoke(IpcChannel.trial.claim, { mc_username }),
creditsGet: () => ipcRenderer.invoke(IpcChannel.credits.get),
creditsOpenCheckout: (kind: 'pack' | 'subscription') => ipcRenderer.invoke(IpcChannel.credits.openCheckout, { kind }),
subscriptionStatus: () => ipcRenderer.invoke(IpcChannel.subscription.status),
subscriptionCancel: () => ipcRenderer.invoke(IpcChannel.subscription.cancel),
proxyConfigure: (kind: 'local' | 'cloud-proxy') => ipcRenderer.invoke(IpcChannel.proxy.configure, { kind }),
onCreditsStatusUpdate(cb: (status: { remainingPct: number; planKind: 'trial'|'pack'|'unlimited' }) => void) {
  const handler = (_e: Electron.IpcRendererEvent, status) => cb(status);
  ipcRenderer.on(IpcChannel.credits.statusUpdate, handler);
  return () => ipcRenderer.off(IpcChannel.credits.statusUpdate, handler);
},
```

**RendererApi entries:**
Mirror in `src/shared/ipc.ts` `RendererApi` interface (see lines 400-526 for existing entries).

**Pitfalls:**
- The credits push channel (`credits:status:update`) is server-driven (X-Sei-Remaining-Pct from the proxy). The renderer never polls — main owns the push.
- Lazy imports in IPC handlers (CONTEXT §Established Patterns) — `proxyClient.ts` is imported inside the handler closure, not at module top, so main boot stays fast.
- The Zod schemas for these channels go directly in `ipc.ts` near `IdSchema` / `ApplySkinArgsSchema` (lines 52-91). Don't scatter validation into the handlers themselves.

---

### `src/renderer/src/lib/stores/useCreditsStore.ts` (new zustand)

**Analog:** `src/renderer/src/lib/stores/useSyncStore.ts` — whole-file structural twin. Same shape: `interface FooState + FooActions + idempotent init() with push-seq race guard`.

**Copy — entire useSyncStore.ts skeleton (lines 23-116), substitute domain:**

```ts
interface CreditsState {
  remainingPct: number;
  planKind: 'trial' | 'pack' | 'unlimited' | null;
  hardStopActive: boolean;        // true when remainingPct === 0 or last call returned 402
  rateLimitedUntil: number | null; // ms epoch — banner countdown source
  initialized: boolean;
  unsubscribe?: () => void;
}

interface CreditsActions {
  init(): Promise<void>;                  // idempotent — mirrors useSyncStore.init exactly
  refresh(): Promise<void>;                // pull from main
  openCheckout(kind: 'pack' | 'subscription'): Promise<void>;
  cancelSubscription(): Promise<void>;
  acknowledgeHardStop(): void;             // dismisses local UI state (does NOT change server)
}

export const useCreditsStore = create<CreditsState & CreditsActions>((set, get) => ({
  // ... mirror useSyncStore.ts:64-116 verbatim, substituting credits domain ...
}));
```

**Copy — push-seq race guard (useSyncStore.ts:77-91):**

This is the lines-77-91 pattern: subscribe FIRST, then await initial seed; bump a `pushSeq` counter on every push; only apply the initial seed if `pushSeq === seqBefore`. **CRITICAL** — without this guard, a push that arrives during the await overwrites with stale data.

**Pitfalls:**
- The store is the SOLE source of truth for `remainingPct` and `planKind` in the renderer. Components MUST NOT recompute remainingPct from token counts (PROXY-05: no token counts anywhere).
- `hardStopActive: true` controls HardStopModal mounting in App.tsx. Don't compute this from `remainingPct === 0` in render — set it explicitly when a 402 lands so the store has explicit semantics.
- `rateLimitedUntil` is a millisecond epoch; the banner component computes the countdown via `setInterval(..., 1000)`. Do NOT store the countdown value itself in the store (that'd trigger a re-render every second).

---

### `src/renderer/src/components/PricingIcon.tsx` (new)

**Analog:** `src/renderer/src/components/IconRail.tsx:31-53` — the existing `RailButton` primitive. PricingIcon is a CONSUMER of RailButton, not a sibling.

**Approach:**

Modify `IconRail.tsx` to insert a new `<RailButton>` directly above the existing Settings button (line 99). The button is conditionally rendered based on `aiBackendKind === 'cloud-proxy'` (D-57):

```tsx
{aiBackendKind === 'cloud-proxy' ? (
  <RailButton
    active={view.kind === 'credits'}
    onClick={() => navigate({ kind: 'credits' })}
    title={`${remainingPct}% credits left · click for details`}
  >
    <PricingIcon size={28} remainingPct={remainingPct} />
  </RailButton>
) : null}
```

`PricingIcon` itself is then a pure SVG component in `components/icons.tsx` (NOT a new file) that takes `{ size: number; remainingPct: number }` and renders a fill-percentage glyph. Add it alongside `SettingsIcon` / `HomeIcon` / etc.

**Pitfalls:**
- The icon must render in BOTH light and dark themes — use CSS variables (`var(--text)`, `var(--accent)`) not hardcoded colors. Existing icons in `icons.tsx` are the template.
- The hover tooltip uses the `title` attribute on the RailButton (a native browser tooltip with ≥500ms delay). CONTEXT says ≥200ms — investigate whether a custom tooltip is warranted, or stick with native and update CONTEXT's 200ms to "browser default."
- BYOK gating: the conditional wrapper is the ENTIRE gate. Don't render-and-hide-with-CSS; that's a defense-in-depth fail (a curious user inspecting DOM sees billing UI they shouldn't).

---

### `src/renderer/src/screens/CreditsScreen.tsx` (new)

**Analog:** `src/renderer/src/screens/SettingsScreen.tsx` — whole-file structural twin. BackRow + h1 + sections + button-row idiom + zustand selectors.

**Copy — header layout (SettingsScreen.tsx:200-215):**

```tsx
<div className={styles.root}>
  <div className={styles.backRow}>
    <Button kind="quiet" size="sm" icon={<BackIcon size={14} />} onClick={() => navigate({ kind: 'home' })}>
      Back
    </Button>
  </div>
  <h1 className={styles.title}>Credits</h1>
  {/* sections... */}
</div>
```

**Copy — section pattern (SettingsScreen.tsx:313-378):**

Each block is a `<section className={styles.section}>` with a `<div className={styles.sectionTitle}>` header. Three blocks per D-55:

```tsx
<section className={styles.section}>
  <div className={styles.sectionTitle}>USAGE</div>
  <PercentBar value={remainingPct} />
  <p className={styles.planLabel}>{planName}</p>
  {renewalDate ? <p className={styles.muted}>Next renewal: {renewalDate}</p> : null}
</section>

<section className={styles.section}>
  <div className={styles.sectionTitle}>TOP UP</div>
  {/* tile with $5 pack CTA */}
</section>

<section className={styles.section}>
  <div className={styles.sectionTitle}>UNLIMITED</div>
  {/* tile with $20/mo CTA or Manage/Cancel for active subs */}
</section>
```

**Change vs SettingsScreen:**
- NO TextField inputs. NO inline-edit. CreditsScreen is read-only display + CTA buttons.
- NO token counts. NO dollar amounts. % bar only (D-55, PROXY-05).
- Selectors read from `useCreditsStore` not `useDataStore`/`useAuthStore`.

**Pitfalls:**
- The plan label ("Trial" / "Pack" / "Unlimited") is the ONLY "what plan am I on" affordance. Do NOT add a "you have N credits left" hint anywhere — PROXY-05 is enforced strictly.
- The Subscribe CTA flips to a Manage/Cancel pair when `subscription_status.active === true`. Two buttons not one — Cancel needs its own confirmation (per the existing SignOutConfirmModal precedent).
- Renewal date format: use `Intl.DateTimeFormat` with `'en-US', { month: 'short', day: 'numeric', year: 'numeric' }` — matches the rest of the app's date formatting.

---

### `src/renderer/src/screens/CreditsScreen.module.css` (new)

**Analog:** `src/renderer/src/screens/SettingsScreen.module.css:1-40` — copy `.root`, `.title`, `.section`, `.sectionTitle`, `.row` classes verbatim. They are project conventions.

**Add:**
- `.planLabel` — h2-style heading for the plan name.
- `.tile` — bordered box for the Top-up and Unlimited blocks (mirror existing AddCard tile pattern if it exists).
- `.percentBar` — the big % bar visual (see CONTEXT §specifics — planner picks glyph; CSS-only is preferred over SVG for crisp scaling).

---

### `src/renderer/src/components/HardStopModal.tsx` (new)

**Analog:** `src/renderer/src/components/AcceptToSModal.tsx` — same archetype (blocking modal, ESC-suppressed, no scrim click, fixed action set).

**Copy — modal structure (AcceptToSModal.tsx:91-137):**

```tsx
<div className={styles.scrim} role="dialog" aria-modal="true" aria-labelledby={titleId}>
  <div className={styles.modal}>
    <h2 id={titleId} className={styles.title}>You&rsquo;re out of credits</h2>
    <p className={styles.body}>{personaAwareCopy}</p>
    <div className={styles.footer}>
      <Button kind="accent" onClick={onTopUp}>Top up $5</Button>
      <Button kind="primary" onClick={onSubscribe}>Go unlimited $20/mo</Button>
      <Button kind="ghost" onClick={onSwitchToLocal}>Use your own API key instead</Button>
    </div>
  </div>
</div>
```

**Copy — ESC suppression (AcceptToSModal.tsx:54-62) verbatim:**

```tsx
useEffect(() => {
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') e.preventDefault();
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}, []);
```

**Copy — Phase enum (MigrateLocalCharsModal.tsx:47):**

If the modal has any internal state machine (e.g., "checking-out" while the external browser is opening), use the `type Phase = 'idle' | 'submitting' | 'success'` pattern from MigrateLocalCharsModal.

**Persona-aware copy (CONTEXT §specifics + D-56):**
Templates per bundled persona (Sui/Lyra/Clawd) + a generic template for custom personas. Source the persona from the active bot character via `useDataStore`:

```ts
const persona = useDataStore(s => s.activeCharacter);
const copy = persona.is_default
  ? HARD_STOP_COPY_BY_PERSONA[persona.id] ?? GENERIC_COPY
  : `${persona.name} needs more credits to keep talking.`;
```

**Pitfalls:**
- D-56 says the modal CANNOT be dismissed without one of the three actions OR explicitly closing the bot. ESC must be suppressed unconditionally (mirrors AcceptToSModal exactly — NOT MigrateLocalCharsModal which only suppresses during `submitting`).
- "Use your own API key instead" toggles `aiBackendKind` to `'local'` and dismisses the modal. This is the BYOK escape hatch. Make sure the dismissal also clears `useCreditsStore.hardStopActive`.
- Top-up and Subscribe buttons open external URLs via `shell.openExternal` (CONTEXT D-45). The modal stays mounted — the user is expected to complete checkout in the browser, then the lemon-webhook fires, then `useCreditsStore.refresh()` picks up the new balance and the modal auto-dismisses when `remainingPct > 0`.

---

### `src/renderer/src/screens/SettingsScreen.tsx` (modify)

**Analog:** self.

**Copy / change:**

Add a new row in the existing ACCOUNT section (lines 224-311), positioned BEFORE the dangerSeparator (line 291). Conditional rendering: ONLY for users with `aiBackendKind === 'local'` (i.e., BYOK users — show the upgrade CTA).

```tsx
{aiBackendKind === 'local' ? (
  <div className={styles.row}>
    <span className={styles.rowLabel}>Cloud AI</span>
    <Button kind="ghost" size="md" onClick={() => void sei.proxyConfigure('cloud-proxy')}>
      Switch to managed billing
    </Button>
  </div>
) : null}
<p className={styles.rowHelper}>
  Use Sei&rsquo;s managed cloud — purchase credits, no API key required.
</p>
```

(Copy text from CONTEXT §specifics.)

**Pitfalls:**
- The CTA does NOT immediately open checkout — it just flips the backend to cloud-proxy and triggers the trial-claim flow on next bot summon. Onboarding is implicit; the trial gate gives them $1 of credit to try.
- BYOK users see this CTA. Cloud-proxy users see the inverse — a "Use your own API key instead" row that flips back to `'local'`. Mirror symmetrically so both backends have an explicit escape hatch.

---

### `../sei-website/terms.html` (modify)

**Analog:** existing `terms.html` structure from Phase 12 (12-15-SUMMARY references it).

**Copy:** the existing `<section id="dmca">` block from Phase 12 plan 14 as the pattern for §8. Mirror the heading style + anchor id (`<section id="refunds">`).

**Add — §8 Refunds and Cancellations** (D-48 text):

> **8. Refunds and Cancellations.**
> **Credit packs:** Unused credit packs are refundable within 14 days of purchase. Once credits have been consumed, the consumed portion is not refundable.
> **Subscriptions:** You may cancel your monthly subscription at any time. Access continues through the end of the current paid billing period. No partial-month proration is offered.
> **How to request:** Email refunds@sei.gg or dmca@sei.app. Lemon Squeezy processes all refunds as Merchant of Record.

**Pitfalls:**
- Re-bumps TOS_VERSION + PRIVACY_VERSION (D-48 — see next entry). The AcceptToSModal cycle re-triggers automatically.
- Anchor id `refunds` must be stable — future GUI may link directly to `https://sei.gg/terms.html#refunds`.

---

### `src/shared/legalVersions.ts` (modify)

**Analog:** self.

**Copy / change:**

Bump both constants to the date that the §8 Refunds amendment ships (e.g., `2026-06-01` or whatever the planner picks):

```ts
export const TOS_VERSION = '2026-06-01';     // was '2026-05-22'
export const PRIVACY_VERSION = '2026-06-01'; // was '2026-05-22'
```

Privacy version bumps too even though §8 only touches terms.html — to keep both surfaces in lockstep and avoid two separate modal cycles. (Per the existing convention from Phase 11.)

**Pitfalls:**
- The "Effective Date" line in `../sei-website/terms.html` + `privacy.html` must match these constants exactly. The `legalVersions.ts` comment at lines 14-15 already states this — make sure the docs follow.
- A bump triggers AcceptToSModal on next launch for every signed-in user (D-26 from Phase 11). Time the bump deliberately — don't ship it midweek if Phase 13 has additional follow-up commits that might re-bump.

---

## Cross-File Conventions to Preserve

Project-wide invariants the planner must thread through every Phase 13 plan:

### 1. Every external call has an AbortController + timeout

CLAUDE.md invariant. Examples:
- `src/main/auth/edgeFunctionClient.ts:38-39` — 15s default.
- `src/main/cloud/cloudCharacterClient.ts:56-69` — `withTimeout` helper.
- `supabase/functions/_shared/moderationProviders.ts:22, 52-53` — 10s on provider calls.

Phase 13: proxy upstream call to Anthropic = 30s (longer; LLM responses can be slow). Proxy-side JWKS fetch = 5s. Edge Function calls from main = 15s (the existing default). Lemon Squeezy webhook handler should NOT time-bound itself (HMAC verify + INSERT is fast); only the outbound alert webhook for failed attribution needs a timeout.

### 2. Edge Function CORS + two-client pattern

Every Edge Function:
- Imports `corsHeaders` from `_shared/cors.ts` (the `'null'` origin pin — defense in depth for desktop callers).
- OPTIONS preflight → `'ok'` plain text + `corsHeaders`.
- Method !== POST → 405.
- Missing/invalid Bearer → 401 with `error: 'missing_jwt' | 'invalid_jwt'` envelope.
- Two clients: `userClient` (anon key + caller JWT, for `auth.getUser()` only) + `adminClient` (service_role, for all privileged writes).

`trial-claim` follows verbatim. `lemon-webhook` skips the Bearer check (HMAC instead of JWT) but otherwise follows the shape.

### 3. Three-layer IPC contract

`src/shared/ipc.ts` → `src/main/ipc.ts` → `src/preload/index.ts`. New channels go in all three sites in lockstep:
- `IpcChannel` constant (shared).
- `RendererApi` interface entry (shared).
- `ipcMain.handle(IpcChannel.foo, async (...) => {...})` (main).
- `foo: (...) => ipcRenderer.invoke(IpcChannel.foo, ...)` (preload).

A new channel that exists in only some of these is a desync bomb.

### 4. Zod validation at every external boundary

Every IPC handler validates its args with a Zod schema BEFORE doing anything else. See `src/main/ipc.ts:52-91` for canonical examples (`IdSchema`, `ApplySkinArgsSchema`). For Phase 13:
- `trial.claim` → MC username regex `^[A-Za-z0-9_]{1,16}$`.
- `credits.openCheckout` → `kind: z.enum(['pack', 'subscription'])`.
- `subscription.cancel` → `z.undefined()` (defense in depth even for no-arg calls).

The Edge Function (`trial-claim/index.ts`) ALSO validates the same fields — defense in depth, like the moderation enum lockstep convention in `submit-report/index.ts:65-71`.

### 5. Modal phase machine

`'loading' | 'idle' | 'submitting' | 'success' | 'error'`. See `MigrateLocalCharsModal.tsx:47` for the canonical type. HardStopModal does NOT need a phase machine (it has only "idle" + the external-browser-opening transient which can be elided). AcceptToSModal-style blocking modals use just `submitting` boolean + `error` string.

### 6. Zustand store shape (FooState + FooActions + idempotent init)

`useSyncStore.ts` is the gold-standard template:
- `interface FooState` — readable state, plus `initialized: boolean` and `unsubscribe?: () => void`.
- `interface FooActions` — methods (must be async if they cross IPC).
- `create<State & Actions>((set, get) => ({ ... }))`.
- `init()` is idempotent — `if (get().initialized) return;` is the first line.
- Push-seq race guard: subscribe FIRST, then await seed; bump `pushSeq` on every push; skip the seed if a push landed during the await.

`useCreditsStore.ts` MUST follow this shape exactly.

### 7. DB migration conventions

Per the Phase 12 moderation migration:
- Multi-section comment headers (`-- Section N of M — ...`).
- Composite RLS policy names: `<table>_<verb>_<scope>` (e.g., `ledger_grants_select_own`).
- `tg_set_updated_at` trigger function is REUSED — do not redefine.
- Append-only tables (immutable: `tos_acceptance`, `trial_claims`, `reports`) get RLS enabled with `select_own` + maybe `insert_own` only. No UPDATE/DELETE policies. Documented in a SQL comment.
- `pg_net` for cross-process notifications (NOT `pg_notify` — Pitfall 2 in Phase 12 RESEARCH). `pg_cron` for scheduled cleanup; require it as an extension at the top of the migration.

### 8. `callEdgeFunction` is the established Edge-Function client

`src/main/auth/edgeFunctionClient.ts` is the canonical wrapper:
- 15s default timeout via AbortController.
- Returns a discriminated union — NEVER throws.
- JSON-stringifies body when present.
- Maps `AbortError` → `{ ok: false, status: 0, message: 'timeout' }`.

`proxyClient.ts` for Edge Function endpoints (trial-claim, usage-export, etc.) MUST use `callEdgeFunction` directly. For the proxy's `/v1/messages` endpoint, use a separate (longer-timeout, streaming-aware) client — but mirror the discriminated-union envelope shape so callers can pattern-match identically.

### 9. Lazy imports in IPC handlers

CONTEXT §Established Patterns. Example:

```ts
ipcMain.handle(IpcChannel.trial.claim, async (_event, args: unknown) => {
  const parsed = TrialClaimArgsSchema.parse(args);
  const { trialClaim } = await import('./proxyClient');  // lazy
  return trialClaim(parsed.mc_username);
});
```

This keeps main boot fast — the proxy client + Lemon Squeezy URL builder + Supabase auth dependencies are not pulled until first use.

### 10. Cloud writes gated by `isCloudWriteAllowed()`

From Phase 11 plan 14 (`tosGate.ts`). Every operation that writes to Supabase MUST check this gate first. For Phase 13:
- `trial-claim` Edge Function — IS a cloud write; gated implicitly (requires signed-in user with valid JWT, which the gate also requires).
- `proxy` calls — NOT a cloud write per se (it's an inference request), but the trial-claim that grants the initial credits IS gated.
- `lemon-webhook` — NOT a user-initiated cloud write; service_role bypasses the gate by design (the user already accepted ToS before reaching checkout — payment is downstream of the gate).

### 11. Cache-control on the last system block (Anthropic prompt caching)

`src/bot/brain/anthropicClient.js:10-15, 91-99` — the existing pattern for prompt caching. D-43 leans on this: cache is org-shared, savings refund to the user. The proxy MUST NOT touch the `cache_control` markers — pass them through verbatim. Stripping or modifying them would destroy the cache-share economics that make Phase 13 viable.

---

## No Analog Found

Files with no close analog in the codebase. Planner should use external research / Fly.io + Hono docs (CONTEXT §canonical_refs) rather than mining the codebase:

| File | Reason |
|---|---|
| `proxy/fly.toml` | First Fly.io deployment |
| `proxy/package.json` | Standalone Node service (not Electron, not Edge Function) |
| `proxy/src/anthropic/forward.ts` (streaming pass-through specifically) | No existing SSE pass-through code; bot uses SDK with synchronous unwrap |

---

## Metadata

**Analog search scope:**
- `supabase/functions/` (all Edge Functions)
- `supabase/migrations/` (all 7 existing migrations)
- `src/main/` (whole tree, especially auth/ and cloud/)
- `src/bot/brain/anthropicClient.js`
- `src/shared/` (ipc.ts, characterSchema.ts, legalVersions.ts)
- `src/preload/index.ts`
- `src/renderer/src/components/` (37 files surveyed)
- `src/renderer/src/screens/` (8 screens)
- `src/renderer/src/lib/stores/` (7 stores)

**Files read in detail (no re-reads):**
1. `.planning/phases/13-ai-proxy-billing-usage-ui/13-CONTEXT.md` (full)
2. `.planning/REQUIREMENTS.md` (full)
3. `supabase/functions/delete-me/index.ts`
4. `supabase/functions/submit-report/index.ts`
5. `supabase/functions/_shared/cors.ts`
6. `supabase/functions/_shared/moderationProviders.ts` (head)
7. `supabase/migrations/20260521000000_characters_tos.sql`
8. `supabase/migrations/20260523000000_moderation_and_reports.sql`
9. `src/main/auth/edgeFunctionClient.ts`
10. `src/main/auth/loopbackPkce.ts`
11. `src/main/apiKeyStore.ts`
12. `src/main/cloud/cloudCharacterClient.ts`
13. `src/bot/brain/anthropicClient.js`
14. `src/bot/index.js` (head)
15. `src/renderer/src/lib/stores/useSyncStore.ts`
16. `src/renderer/src/components/AcceptToSModal.tsx`
17. `src/renderer/src/components/MigrateLocalCharsModal.tsx` (head)
18. `src/renderer/src/components/IconRail.tsx`
19. `src/renderer/src/screens/SettingsScreen.tsx`
20. `src/renderer/src/screens/SettingsScreen.module.css` (head)
21. `src/shared/legalVersions.ts`
22. `src/shared/ipc.ts` (RendererApi section + IpcChannel section)
23. `src/main/ipc.ts` (head)
24. `src/preload/index.ts` (head)
