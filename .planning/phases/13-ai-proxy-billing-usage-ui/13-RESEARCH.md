# Phase 13: AI Proxy + Billing + Usage UI - Research

**Researched:** 2026-05-22
**Domain:** Fly.io Hono proxy + Supabase JWT/ledger + Lemon Squeezy MoR + Anthropic Messages API pass-through
**Confidence:** HIGH for Anthropic API surface, Lemon Squeezy webhooks, Supabase JWKS, Fly.io scale-to-zero. MEDIUM for atomic-ledger SQL pattern (multiple valid shapes — recommendation locked).

## Summary

Phase 13 binds five external systems together: Supabase (JWT issuer + Postgres ledger), Anthropic (upstream Messages API with prompt caching), Lemon Squeezy (Merchant-of-Record checkout + webhook), Fly.io (scale-to-zero Node host), and the Electron client (Sei main + utilityProcess). CONTEXT.md (D-38..D-57) has already locked every provider; this research pins down **how** to wire them — precise API contracts, SSE pass-through mechanics, atomic SQL for the ledger, and the friction points that cause silent production bugs.

The biggest research-derived risks are (1) **SSE header injection** — Hono's `streamSSE` writes headers before the body opens, so `X-Sei-Remaining-Pct` MUST be computed pre-stream and attached via `c.header()` before the helper is invoked; (2) **idempotent webhook ingestion** — Lemon Squeezy retries on 5xx and on network drops, so the `lemon_event_id` unique constraint is the ONLY safe deduplication; (3) **ITPM accounting subtlety** — Anthropic's ITPM rate-limit counts `cache_creation_input_tokens` but NOT `cache_read_input_tokens` on Haiku 4.5 (the model Sei uses), which means our per-user TPM cap should mirror Anthropic's accounting to avoid double-charging cached reads.

**Primary recommendation:** Lock all six external contracts (JWT verify, SSE pass-through, atomic reservation, webhook signature, checkout URL, ledger schema) in Wave 1 migrations + a `proxy/` skeleton that compiles and deploys to Fly.io before any Sei-side client code lands. Sub-delivery (a) — the `anthropicClient.js` `baseURL` override — is a ~10-line surgical edit that should be the LAST plan in Phase 13, gated on the proxy being live and validated end-to-end against a test account.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Proxy Architecture (PROXY-07, PROXY-08, PROXY-10):**
- D-38: Single Fly.io app `sei-proxy`, code in `proxy/` at repo root. Hono, Node 22, region `iad`, 256MB shared-cpu-1x, auto-scale 0-2 with scale-to-zero.
- D-39: JWT verification via `jose` library against Supabase JWKS endpoint (`<supabase>/auth/v1/.well-known/jwks.json`). JWKS cached 1h in proxy memory. Required claims: `aud=authenticated`, valid `exp`, `sub` becomes canonical `user_id`. No shared secret.
- D-40: Sub-delivery (a) adds `cloudMode: { baseURL, authToken }` to `anthropicClient.js`. Sub-delivery (b) re-touches as `LlmProvider` variant after Phase 14.
- D-41: `X-Sei-Remaining-Pct: <0..100>` response header on every successful Anthropic response. Computed proxy-side as `min(daily_remaining / daily_cap, monthly_remaining / monthly_cap) × 100`, rounded to nearest 5%. Client `useCreditsStore` reads on every response.

**Trial Gate:**
- D-42: Free trial keyed on Minecraft username string (LAN-only constraint). New table `trial_claims (mc_username pk, sei_user_id, claimed_at)`. INSERT only via Edge Function `trial-claim` with service_role using `ON CONFLICT DO NOTHING RETURNING`. Trial credit grant = $1 micro-dollars.
- D-42a: Threat model acknowledges launcher-rename abuse; mitigation deferred to Microsoft OAuth in Phase 14+.
- D-42b: GUI/in-game username mismatch surfaces a hardcoded UX message; orthogonal to trial gate.

**Cache + Pricing:**
- D-43: All users share one Anthropic API key. Prompt caching is shared at the org level — bundled-persona prompts hit cache across users. Cache savings flow back to the user's balance (reservation refund).
- D-44: When Anthropic returns 429, proxy responds 503 `{error: 'service_at_capacity', retry_after_seconds: 30}`. Logged for tier-up alerting.

**Lemon Squeezy:**
- D-45: Two products — `$5 Pack` (one-time, `variant_id_pack`) and `$20/month Unlimited` (recurring, `variant_id_subscription`). Checkout opens via `shell.openExternal('https://sei.lemonsqueezy.com/buy/<variant_id>?checkout[custom][user_id]=<jwt_sub>')`.
- D-46: Webhook = Supabase Edge Function `lemon-webhook`. HMAC-verifies signature using `LEMON_SQUEEZY_WEBHOOK_SECRET`. Events handled: `order_created`, `subscription_created`, `subscription_updated`, `subscription_payment_success`, `subscription_cancelled`, `subscription_expired`. Idempotent via `lemon_event_id text unique` on `ledger_grants`. Failed-to-attribute → email + Discord webhook.

**Ledger:**
- D-47: Two tables. `ledger_grants` (kind ∈ {trial, pack, subscription}, credits_micro bigint, lemon_event_id text unique). `ledger_consumption` (micro bigint, reservation_state ∈ {reserved, settled, refunded}). Materialized view `ledger_balance` per user. All amounts in micro-dollars (millionths of a dollar). $5 = 5_000_000.
- D-47a: RLS — user can SELECT own rows. Writes only via service_role.

**Pre-Deduction + Rate Limits:**
- D-50: 1.25× worst-case reservation pre-deducted BEFORE forwarding to Anthropic. Atomic SQL row-lock against balance. After response: compute actual cost from `usage.input × 1.0 + usage.cache_creation × 1.25 + usage.cache_read × 0.10 + usage.output × output_rate`. UPDATE reservation row to settled with actual_micro. Refund delta back to ledger.
- D-50a: Input tokens estimated server-side via `@anthropic-ai/tokenizer` (~95% accuracy English).
- D-51: Rate caps in `rate_buckets` table. Trial first 7 days: 20 RPM / 30K ITPM / $1 day. Day 8+: same RPM/TPM, $5/day, gated on Anthropic Tier-2 unlock. Subscriber: 60 RPM / 200K ITPM / $20/day. `pg_cron` nightly cleanup of rows where `window_start < now() - 25h`.
- D-52: 429 response shape `{error: 'rate_limited', kind, retry_after_seconds}`. Client surfaces inline countdown banner (NOT modal).

**Pricing UI:**
- D-54: Pricing icon directly above Settings icon in left vertical rail. Hover ≥200ms → tooltip `{remaining_pct}% credits left · click for details`. Click → `CreditsScreen`.
- D-55: `CreditsScreen` three blocks only — (a) % bar, (b) Top-up tile, (c) Unlimited tile. NO dollar amounts. NO token counts.
- D-56: Hard-stop modal on 402, 0%, or non-recoverable empty signal. Persona-aware copy. CTAs: top-up / subscribe / "use your own API key".
- D-57: BYOK bypass — `backendKind === 'local'` users see NO pricing icon, NO `CreditsScreen`. Settings shows "Switch to managed billing" CTA.

**Refund + ToS:**
- D-48: Refund policy in `terms.html §8`. Credit packs refundable within 14 days if unused. Subscriptions cancellable, no proration. Manual via dmca@sei.app for v1.0. Re-bump TOS_VERSION + PRIVACY_VERSION.
- D-49: Anthropic ToS pre-launch checklist gate — `checkpoint:human-verify` runbook. Framing = "proxied AI inference credits powered by Sei", NOT "Anthropic API access".

### Claude's Discretion
- Pricing icon visual design (glyph + fill animation)
- Persona-aware hard-stop copy (hardcoded per-persona vs template)
- Anthropic 429 backoff cooldown (30s suggested)
- `rate_buckets` cleanup cadence
- Tier-1 → Tier-2 ramp logistics (first 7 days at $1, then $5)
- Webhook idempotency freshness window
- Cache write reservation precision (1.25× default)

### Deferred Ideas (OUT OF SCOPE)
- Microsoft OAuth identity binding for stronger trial gate
- Hosting re-evaluation after MVP traffic
- Multi-provider abstraction (Phase 14)
- Per-tier discount pricing / annual subscriptions
- Usage history charts, monthly statements
- Team/family billing accounts
- Refund self-service portal
- Discord/community billing perks
- Crypto / BTC payments
- Per-region pricing
- Per-model pricing tiers
- Public usage transparency report
- Affiliate / referral credits
- Mac App Store / Microsoft Store distribution (changes IAP rules — direct-distribution only for v1.0)
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| PROXY-01 | $5 one-time pack checkout via `shell.openExternal` | Lemon Squeezy checkout URL pattern (§Lemon Squeezy Integration) |
| PROXY-02 | $20/month subscription checkout via `shell.openExternal` | Same — subscription variant_id differs |
| PROXY-03 | Webhook credits ledger; FIFO one-time grants; recurring renewals | `lemon-webhook` Edge Function + event mapping table (§Lemon Squeezy Integration) |
| PROXY-04 | Pricing icon above Settings icon; click opens screen | UI integration point (§Sei Client Surfaces) |
| PROXY-05 | Hover shows friendly % usage; NO token counts ANYWHERE | `X-Sei-Remaining-Pct` server-driven header pattern |
| PROXY-06 | Out-of-credits hard stop with clear modal | 402 response + hard-stop modal trigger conditions (§Sei Client Surfaces) |
| PROXY-07 | Hono proxy on Fly.io; bot points baseURL at proxy in cloud mode | `proxy/` Fly.io app skeleton (§Fly.io Deployment Shape) |
| PROXY-08 | Per-user JWT auth; no shared secret | `jose` JWT verification via Supabase JWKS (§JWT Verification) |
| PROXY-09 | Token-bucket pre-deduction + RPM/TPM/daily $ caps — all launch gates | Atomic SQL reservation + `rate_buckets` UPSERT (§Atomic Pre-Deduction) |
| PROXY-10 | Server-driven remaining_pct only source of truth for % bar | Header injection pattern (§Hono SSE Pass-Through) |
| PROXY-11 | Local-API-key users never hit proxy, never see credits UI | `backendKind === 'local'` gate (§BYOK Bypass) |
| PROXY-12 | Refund/cancellation policy in ToS before first live charge | terms.html §8 + TOS_VERSION bump |
| PROXY-13 | Lemon Squeezy product description reviewed against Anthropic ToS | checkpoint:human-verify runbook (D-49) |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

- **Three-process Electron:** main ↔ renderer (contextIsolation) ↔ utilityProcess. Mineflayer must run in utilityProcess only. Phase 13 adds NO new utilityProcess code — the cloudMode override flips `baseURL` inside the existing `anthropicClient.js`, which already runs in utilityProcess.
- **Closed action registry:** LLM never generates code. Phase 13 does not touch the action registry.
- **Every external call has a timeout:** Anthropic SDK call has `timeoutMs` per-request. The proxy's upstream `fetch` to Anthropic MUST also wrap an AbortSignal with a wall-clock timeout. Lemon Squeezy webhook → service_role inserts should follow the same 15s default established in `edgeFunctionClient.ts`.
- **GSD workflow:** read `.planning/STATE.md` + ROADMAP phase before starting; commit planning docs alongside code; never skip phases.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| JWT verification | API/Backend (Fly.io proxy) | — | Bearer token sourced from client (utilityProcess), verified server-side against Supabase JWKS. Pure backend concern. |
| Anthropic Messages pass-through | API/Backend (Fly.io proxy) | — | Hides the org API key; injects rate-limit + balance gates; rewrites SSE stream with `X-Sei-Remaining-Pct`. |
| Token estimation | API/Backend (Fly.io proxy) | — | `@anthropic-ai/tokenizer` runs server-side BEFORE upstream call. Client never sees estimates (NO token counts in UI). |
| Pre-deduction reservation | Database/Storage (Postgres) | API/Backend (proxy initiates) | Atomic row-lock against `ledger_balance` MV. Postgres `FOR UPDATE` semantics are the trust boundary. |
| Rate cap enforcement | Database/Storage (Postgres) | API/Backend (proxy reads + UPSERTs) | `rate_buckets` window UPSERT under transaction is the only way to be safe under parallel calls. |
| Lemon Squeezy webhook | API/Backend (Supabase Edge Function) | Database (service_role INSERT) | Edge Function holds the HMAC secret and writes via service_role. Mirrors `submit-report` precedent. |
| Trial claim | API/Backend (Supabase Edge Function) | Database | Edge Function with service_role does `ON CONFLICT DO NOTHING RETURNING`. Mirrors `delete-me` two-client pattern. |
| Checkout URL construction | Frontend Server (Electron main) | Browser (shell.openExternal) | Main process owns the JWT (D-39 sub claim); constructs URL with `?checkout[custom][user_id]=<sub>`; `shell.openExternal` hands off to OS browser. |
| `useCreditsStore` (% bar source of truth) | Browser (renderer zustand) | API/Backend (header source) | Renderer reads `X-Sei-Remaining-Pct` via IPC bridge from utilityProcess → main → renderer. |
| BYOK bypass gate | Frontend Server (Electron main) | Browser (renderer conditional render) | `apiKeyStore.backendKind` is authoritative; renderer subscribes via `capabilities:get` IPC and conditionally hides icon/screen. |
| Persona-aware hard-stop copy | API/Backend (proxy) OR Frontend (renderer) | — | CONTEXT D-56 says "server-side persona-aware copy" but the proxy doesn't know the persona. RECOMMENDATION: render client-side from the persona currently loaded, with fallback copy when no persona is active (first-launch / pre-signup edge). See Open Question 1. |

## Standard Stack

### Core (Proxy — `proxy/` Fly.io app)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| hono | `^4.12.x` [VERIFIED: npm view hono → 4.12.22] | HTTP framework | Locked by CONTEXT D-38. Runs on Node 22 + multiple targets (Workers/Vercel) for future migration. |
| jose | `^6.2.x` [VERIFIED: npm view jose → 6.2.3] | JWT verification | Locked by CONTEXT D-39. Maintained, audited, supports JWKS rotation natively. |
| @anthropic-ai/tokenizer | `^0.0.4` [VERIFIED: npm view → 0.0.4] | Input token estimation | Locked by CONTEXT D-50a. Note: stuck at 0.0.x — see Pitfall 8. |
| @supabase/supabase-js | `^2.105.x` [VERIFIED: matches existing Sei dependency] | Postgres + Storage client | Already a Sei dependency; reuse for proxy's ledger writes via service_role. |

### Supporting (Sei client side — already deps)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| @anthropic-ai/sdk | `^0.98.x` [VERIFIED: npm view → 0.98.0] | Anthropic Messages API client (existing) | Already in `src/bot/brain/anthropicClient.js`. Sub-delivery (a) adds `baseURL` + `authToken` plumbing. |
| zod | `^4.4.x` [VERIFIED: npm view → 4.4.3] | IPC boundary validation (existing) | Validate `proxy:configure`, `trial:claim`, `credits:get`, `credits:openCheckout`, `subscription:cancel` IPC payloads. |

### Supporting (Edge Functions — Deno runtime)

| Library | Purpose | Notes |
|---------|---------|-------|
| `@supabase/supabase-js` (npm: import from URL) | Service role client | Pattern from `delete-me/index.ts` |
| `corsHeaders` from `_shared/cors.ts` | Established CORS helper | Reuse verbatim |

### No Alternatives Worth Discussing
- Webhook signature verification: Node's `node:crypto.timingSafeEqual` + `createHmac('sha256', secret).update(rawBody).digest('hex')`. No npm dependency needed.
- HTTP server in Edge Function: `Deno.serve` (precedent: `submit-report`).
- JWKS caching: jose's `createRemoteJWKSet` has built-in caching with `cooldownDuration` and `cacheMaxAge` — no separate cache library needed.

**Installation (proxy/):**
```bash
cd proxy
npm init -y
npm install hono@^4.12.x jose@^6.2.x @anthropic-ai/tokenizer@^0.0.4 @supabase/supabase-js@^2.105.x
npm install -D @types/node typescript tsx
```

**Version verification:**
| Package | Verified Version | Date |
|---------|------------------|------|
| hono | 4.12.22 | 2026-05-22 |
| jose | 6.2.3 | 2026-05-22 |
| @anthropic-ai/tokenizer | 0.0.4 | 2026-05-22 |
| @anthropic-ai/sdk | 0.98.0 | 2026-05-22 |
| @lemonsqueezy/lemonsqueezy.js | 4.0.0 | 2026-05-22 (not strictly needed — webhook verification uses node:crypto directly; the SDK is only useful for outbound API calls and Phase 13 doesn't need any) |
| zod | 4.4.3 | 2026-05-22 |

## Architecture Patterns

### System Architecture Diagram

```
                 ┌─────────────────────────────────────────────────────────┐
                 │  Sei Electron App                                       │
                 │                                                         │
                 │  ┌─────────────┐    ┌──────────────┐    ┌─────────────┐ │
  user click ──► │  │  renderer   │ ◄──┤    main      ├──► │utilityProc  │ │
                 │  │ (CreditsScr)│    │ (IPC, JWT,   │    │ (mineflayer │ │
                 │  │ useCredits  │    │  apiKeyStore)│    │  + anthropic│ │
                 │  │  Store      │    │              │    │  Client.js) │ │
                 │  └──────┬──────┘    └──────┬───────┘    └──────┬──────┘ │
                 │         │                  │                   │        │
                 └─────────┼──────────────────┼───────────────────┼────────┘
                           │                  │                   │
              shell.open   │                  │ trial:claim       │ POST /v1/messages
              External     │                  │ via Edge Function │ (Bearer JWT)
                           ▼                  ▼                   ▼
                ┌──────────────────┐   ┌──────────────┐   ┌──────────────────────┐
                │ system browser   │   │  Supabase    │   │  Fly.io sei-proxy    │
                │ Lemon Squeezy    │   │ Edge Function│   │  (Hono, Node 22)     │
                │ /buy/<variant>?  │   │ trial-claim  │   │                      │
                │ user_id=<sub>    │   └──────┬───────┘   │  1. jose JWT verify  │
                └────────┬─────────┘          │           │     (JWKS 1h cache)  │
                         │                    │           │  2. tokenize input   │
                         │ POST webhook       │           │  3. atomic SQL pre-  │
                         │ X-Signature        │           │     deduction +      │
                         ▼                    ▼           │     rate cap check   │
                ┌────────────────────────────────────┐    │  4. forward to       │
                │ Supabase Edge Function             │    │     Anthropic        │
                │ lemon-webhook                      │    │  5. on response:     │
                │                                    │    │     - compute actual │
                │ - HMAC verify                      │    │       from usage     │
                │ - service_role INSERT              │    │     - settle ledger  │
                │   ledger_grants (lemon_event_id    │    │     - inject X-Sei-  │
                │   unique → idempotent)             │    │       Remaining-Pct  │
                └────────┬───────────────────────────┘    │  6. SSE pass-through │
                         │                                └──────┬───────────────┘
                         ▼                                       │
                ┌──────────────────────────────────────────┐     │ org key
                │ Supabase Postgres                        │     ▼
                │                                          │  ┌──────────────────┐
                │  ledger_grants ─── FK ──┐                │  │ api.anthropic.com│
                │  ledger_consumption ────┤                │  │ /v1/messages     │
                │  rate_buckets           ├──► auth.users  │  │ (Haiku 4.5)      │
                │  trial_claims           │                │  └──────────────────┘
                │  subscription_status ───┘                │
                │                                          │
                │  ledger_balance (materialized view)      │
                │  pg_cron: rate_buckets nightly cleanup   │
                └──────────────────────────────────────────┘
```

### Recommended Project Structure (proxy/)

```
proxy/
├── fly.toml              # Fly.io app config (region iad, 256MB, scale 0-2)
├── Dockerfile            # Node 22 alpine base
├── package.json
├── tsconfig.json
├── .dockerignore
├── src/
│   ├── index.ts          # Hono app entrypoint
│   ├── auth/
│   │   ├── jwks.ts       # jose createRemoteJWKSet with 1h cache
│   │   └── verifyJwt.ts  # middleware: extract Bearer, verify, attach userId to context
│   ├── anthropic/
│   │   ├── forward.ts    # POST /v1/messages handler; SSE pass-through
│   │   ├── tokenize.ts   # @anthropic-ai/tokenizer wrapper
│   │   └── pricing.ts    # micro-dollar cost calculator
│   ├── ledger/
│   │   ├── reserve.ts    # atomic pre-deduction SQL
│   │   ├── settle.ts     # post-call reservation settle/refund
│   │   └── balance.ts    # remaining_pct computation
│   ├── ratelimit/
│   │   └── buckets.ts    # rate_buckets UPSERT
│   ├── supabase.ts       # service_role client singleton
│   └── env.ts            # env var schema (zod)
└── README.md             # local dev + deploy instructions
```

### Pattern 1: Fly.io Deployment Shape

**What:** Fly.io app for the Hono proxy with scale-to-zero behavior, deployed from `proxy/` directory via `fly deploy`.

**When to use:** Sei's only proxy app, ever (for this milestone). No multi-region for v1.0.

**`proxy/fly.toml`** [CITED: https://fly.io/docs/launch/autostop-autostart/]:
```toml
app = 'sei-proxy'
primary_region = 'iad'

[build]
  # Dockerfile in repo

[env]
  NODE_ENV = 'production'
  PORT = '8080'

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = 'stop'
  auto_start_machines = true
  min_machines_running = 0
  processes = ['app']

  [http_service.concurrency]
    type = 'requests'
    soft_limit = 20
    hard_limit = 50

[[vm]]
  size = 'shared-cpu-1x'
  memory = '256mb'
  cpu_kind = 'shared'
  cpus = 1

[checks]
  [checks.health]
    grace_period = '10s'
    interval = '30s'
    method = 'get'
    timeout = '5s'
    path = '/health'
```

**`proxy/Dockerfile`** (minimal):
```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY dist/ ./dist/
EXPOSE 8080
CMD ["node", "dist/index.js"]
```

**Secrets** (set via CLI, never committed):
```bash
fly secrets set ANTHROPIC_API_KEY=sk-ant-... -a sei-proxy
fly secrets set SUPABASE_URL=https://<project>.supabase.co -a sei-proxy
fly secrets set SUPABASE_SERVICE_ROLE_KEY=... -a sei-proxy
fly secrets set SUPABASE_JWKS_URL=https://<project>.supabase.co/auth/v1/.well-known/jwks.json -a sei-proxy
```

**Custom domain** (deferred to operator — domain `proxy.sei.app` or similar):
```bash
fly certs create proxy.sei.app -a sei-proxy
# Then add the CNAME record per Fly.io's instructions to point to api.sei.gg
```

[CITED: Fly.io scale-to-zero requires `auto_stop_machines = 'stop'`, `auto_start_machines = true`, AND `min_machines_running = 0` together. Defaults from `fly launch` already match this shape.]

### Pattern 2: JWT Verification with jose + Supabase JWKS

**What:** Verify Supabase-issued JWTs against the JWKS endpoint with in-memory caching.

**When to use:** Every authenticated route in the proxy (i.e., everything except `/health`).

**Code** [CITED: https://supabase.com/docs/guides/auth/signing-keys; jose docs]:
```typescript
// src/auth/jwks.ts
import { createRemoteJWKSet } from 'jose'

const jwksUrl = new URL(process.env.SUPABASE_JWKS_URL!)
// jose's createRemoteJWKSet has built-in caching. Defaults:
//   cooldownDuration: 30_000ms (don't refetch on JWKS miss faster than this)
//   cacheMaxAge: 600_000ms (10 min default)
// CONTEXT D-39 specifies 1h cache — set cacheMaxAge accordingly.
export const JWKS = createRemoteJWKSet(jwksUrl, {
  cacheMaxAge: 60 * 60 * 1000, // 1 hour
  cooldownDuration: 30_000,
})
```

```typescript
// src/auth/verifyJwt.ts
import { jwtVerify } from 'jose'
import type { MiddlewareHandler } from 'hono'
import { JWKS } from './jwks'

export const verifyJwt: MiddlewareHandler<{ Variables: { userId: string } }> = async (c, next) => {
  const auth = c.req.header('Authorization')
  if (!auth?.startsWith('Bearer ')) {
    return c.json({ error: 'missing_jwt' }, 401)
  }
  const token = auth.slice('Bearer '.length)

  try {
    const { payload } = await jwtVerify(token, JWKS, {
      audience: 'authenticated',
      // issuer not strictly checked — Supabase JWKS is the trust root
    })
    if (typeof payload.sub !== 'string') {
      return c.json({ error: 'invalid_jwt', detail: 'no sub claim' }, 401)
    }
    c.set('userId', payload.sub)
    await next()
  } catch (err: any) {
    const code = err?.code as string | undefined
    if (code === 'ERR_JWT_EXPIRED') {
      return c.json({ error: 'expired_jwt' }, 401)
    }
    return c.json({ error: 'invalid_jwt', detail: err?.message }, 401)
  }
}
```

**Error response shapes (final, locked):**
- 401 `{ "error": "missing_jwt" }` — no Authorization header
- 401 `{ "error": "invalid_jwt", "detail": "..." }` — signature/audience/sub failure
- 401 `{ "error": "expired_jwt" }` — exp claim in the past

[CITED: jose's `ERR_JWT_EXPIRED` is the documented code for expired tokens. Other validation failures raise `JWTInvalid` / `JWSSignatureVerificationFailed` etc. — all caught by the generic `invalid_jwt` branch.]

### Pattern 3: Anthropic SSE Pass-Through with Header Injection

**What:** Forward `POST /v1/messages` to Anthropic verbatim, while injecting `X-Sei-Remaining-Pct` on the response.

**When to use:** The main proxy route. Both streaming and non-streaming requests pass through this.

**Critical insight:** Hono's `streamSSE` and `stream` helpers commit response headers BEFORE the first chunk is written. This means `X-Sei-Remaining-Pct` MUST be computed using the PRE-reservation balance (which is well-defined) before the upstream call opens its stream. We cannot wait for the upstream `usage` to settle before sending the header.

**Recommended strategy:**

1. Pre-reservation: compute estimated cost + 1.25× reservation.
2. Insert reservation row + check balance atomically. If insufficient → 402.
3. Compute `remaining_pct` based on the POST-reservation balance (i.e., what the user will have left if the upstream call uses 100% of the reservation).
4. Set `X-Sei-Remaining-Pct` header on the Hono response.
5. Open upstream `fetch` to Anthropic with stream body.
6. Pipe upstream body to client.
7. Asynchronously, on stream close: parse the final `message_delta` event to extract `usage`, compute actual cost, settle reservation (refund delta back into ledger).
8. The NEXT user request will see the refunded balance reflected in its `X-Sei-Remaining-Pct`.

**Code** [CITED: https://hono.dev/docs/helpers/streaming; https://docs.anthropic.com/en/docs/build-with-claude/streaming]:
```typescript
// src/anthropic/forward.ts
import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { reserve, settle } from '../ledger'
import { remainingPct } from '../ledger/balance'
import { estimateInputTokens } from './tokenize'
import { computeMicroDollarCost } from './pricing'

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'

export async function forwardToAnthropic(c: Context<{ Variables: { userId: string } }>) {
  const userId = c.get('userId')
  const body = await c.req.json()

  // 1. Estimate input
  const estimatedInput = await estimateInputTokens(body)
  const maxOutput = body.max_tokens ?? 1024

  // 2. Reserve (atomic SQL; row-locked balance check). Throws 402 if insufficient.
  const reservation = await reserve(userId, estimatedInput, maxOutput)
  if (reservation.status === 'insufficient') {
    return c.json({ error: 'payment_required' }, 402)
  }
  if (reservation.status === 'rate_limited') {
    return c.json({
      error: 'rate_limited',
      kind: reservation.kind,
      retry_after_seconds: reservation.retryAfter,
    }, 429)
  }

  // 3. Compute remaining_pct from post-reservation balance
  const pct = await remainingPct(userId)
  c.header('X-Sei-Remaining-Pct', String(pct))

  // 4. Upstream fetch
  const upstream = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000), // 120s wall-clock; matches Sei invariant
  })

  // 5. Handle Anthropic 429 specially (D-44)
  if (upstream.status === 429) {
    // Refund the reservation since we never used it
    await settle(reservation.id, /* actual_micro = */ 0, 'refunded')
    return c.json({
      error: 'service_at_capacity',
      retry_after_seconds: 30,
    }, 503)
  }

  // 6. Non-streaming response shortcut
  if (!body.stream) {
    const respJson = await upstream.json() as any
    const actualMicro = computeMicroDollarCost(respJson.usage, body.model)
    await settle(reservation.id, actualMicro, 'settled')
    // Refresh header after settle for the response
    const finalPct = await remainingPct(userId)
    c.header('X-Sei-Remaining-Pct', String(finalPct))
    return c.json(respJson, upstream.status as any)
  }

  // 7. Streaming pass-through with usage capture
  return streamSSE(c, async (stream) => {
    let finalUsage: any = null
    const reader = upstream.body!.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = decoder.decode(value, { stream: true })
      buf += chunk
      // SSE events are separated by \n\n. Parse + forward each event.
      let idx
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        // Capture final usage from message_delta event
        if (raw.includes('event: message_delta')) {
          const dataLine = raw.split('\n').find(l => l.startsWith('data: '))
          if (dataLine) {
            try {
              const parsed = JSON.parse(dataLine.slice(6))
              if (parsed.usage) finalUsage = parsed.usage
            } catch {}
          }
        }
        // Forward raw SSE bytes
        await stream.write(raw + '\n\n')
      }
    }
    // 8. After stream closes: settle reservation
    if (finalUsage) {
      const actualMicro = computeMicroDollarCost(finalUsage, body.model)
      await settle(reservation.id, actualMicro, 'settled')
    } else {
      // No usage received → assume worst case, settle at reservation amount (no refund)
      await settle(reservation.id, reservation.micro, 'settled')
    }
  })
}
```

**Anthropic SSE event sequence** [CITED: https://docs.anthropic.com/en/docs/build-with-claude/streaming]:
```
event: message_start
data: {"type":"message_start","message":{"id":"msg_...","usage":{"input_tokens":N, "cache_creation_input_tokens":N, "cache_read_input_tokens":N, "output_tokens":1}}}

event: content_block_start
data: {...}

event: content_block_delta
data: {...}

event: content_block_stop
data: {...}

event: message_delta
data: {"type":"message_delta","delta":{...},"usage":{"output_tokens":N}}

event: message_stop
data: {"type":"message_stop"}
```

**CRITICAL:** Anthropic returns input-side usage on the `message_start` event and output-side usage on the `message_delta` event. The PROXY MUST merge both to compute total cost. The example above only captures `message_delta`; production code must also capture `message_start.message.usage` for input counts.

**Revised capture logic:**
```typescript
let inputUsage: any = null
let outputUsage: any = null

// inside the SSE loop:
if (raw.includes('event: message_start')) {
  const parsed = JSON.parse(dataLine.slice(6))
  inputUsage = parsed.message?.usage // input_tokens, cache_creation_input_tokens, cache_read_input_tokens
}
if (raw.includes('event: message_delta')) {
  const parsed = JSON.parse(dataLine.slice(6))
  outputUsage = parsed.usage // output_tokens (cumulative)
}

// after stream:
const merged = {
  input_tokens: inputUsage?.input_tokens ?? 0,
  cache_creation_input_tokens: inputUsage?.cache_creation_input_tokens ?? 0,
  cache_read_input_tokens: inputUsage?.cache_read_input_tokens ?? 0,
  output_tokens: outputUsage?.output_tokens ?? 0,
}
```

### Pattern 4: Micro-Dollar Cost Computation

**What:** Convert Anthropic's `usage` object into micro-dollar (millionths-of-a-dollar) cost.

**Pricing (Haiku 4.5, verified 2026-05-22)** [CITED: https://www.anthropic.com/news/claude-haiku-4-5, https://platform.claude.com/docs/en/about-claude/pricing]:
- Input: $1.00 / 1M tokens = 1.0 micro-dollar per input token
- Output: $5.00 / 1M tokens = 5.0 micro-dollars per output token
- Cache write (5-min ephemeral): 1.25× input rate = 1.25 micro-dollars per token
- Cache read: 0.10× input rate = 0.1 micro-dollars per token

```typescript
// src/anthropic/pricing.ts
type Usage = {
  input_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  output_tokens: number
}

// Per-million pricing (Haiku 4.5)
const PRICING = {
  'claude-haiku-4-5': { input: 1.0, output: 5.0 },
} as const

export function computeMicroDollarCost(usage: Usage, model: string): bigint {
  const p = PRICING[model as keyof typeof PRICING] ?? PRICING['claude-haiku-4-5']
  // Micro-dollars per token:
  //   input            = p.input × 1.0
  //   cache_creation   = p.input × 1.25
  //   cache_read       = p.input × 0.10
  //   output           = p.output × 1.0
  const microPerInput = BigInt(Math.round(p.input * 100)) // p.input × 1M tokens → $; per-token = p.input µ$
  // Simpler: multiply through with floats then cast to bigint at end
  const usd =
    usage.input_tokens * p.input +
    usage.cache_creation_input_tokens * p.input * 1.25 +
    usage.cache_read_input_tokens * p.input * 0.10 +
    usage.output_tokens * p.output
  // usd is in $ per 1M tokens × token-count = micro-dollars directly
  return BigInt(Math.ceil(usd))
}
```

**Note on micro-dollar units:** since pricing is given as $/1M tokens, multiplying a token count by the per-million rate yields **micro-dollars directly** (no scaling needed). $5 = 5_000_000 µ$. A 1000-input-token call at Haiku 4.5 costs 1000 × 1.0 = 1000 µ$ = $0.001.

### Pattern 5: Atomic Pre-Deduction (Postgres)

**What:** Reserve worst-case cost BEFORE upstream call, atomically against current balance, with row-lock to prevent TOCTOU races under parallel requests.

**When to use:** Every proxy request, immediately after JWT verify and tokenization.

**The challenge:** Two parallel requests from the same user must NOT both see "balance sufficient" and both reserve. Naive read-then-insert is racy. Need transactional `SELECT FOR UPDATE` semantics, or a single atomic `INSERT … WHERE … RETURNING` that checks balance in the WHERE clause.

**Recommended pattern (single-statement atomic insert):**

```sql
-- migration: 20260523_ledger_pre_deduction.sql
-- ledger_balance is a VIEW (not materialized) computed live from grants - consumption
-- This avoids the staleness problem of a refreshed MV under high concurrency.
CREATE VIEW ledger_balance AS
SELECT
  u.id AS user_id,
  COALESCE(
    (SELECT SUM(credits_micro) FROM ledger_grants WHERE user_id = u.id),
    0
  )::bigint -
  COALESCE(
    (SELECT SUM(micro) FROM ledger_consumption WHERE user_id = u.id AND reservation_state IN ('reserved', 'settled')),
    0
  )::bigint AS balance_micro
FROM auth.users u;
```

**The atomic reserve operation** (called from proxy via service_role):

```sql
-- Returns the inserted row ID on success, or zero rows on insufficient balance.
WITH balance_check AS (
  SELECT balance_micro FROM ledger_balance WHERE user_id = $1
)
INSERT INTO ledger_consumption (user_id, micro, reservation_state, anthropic_call_id)
SELECT $1, $2, 'reserved', NULL
FROM balance_check
WHERE balance_micro >= $2
RETURNING id;
```

[ASSUMED: This pattern relies on Postgres's serializable behavior under default READ COMMITTED + a single statement. Under READ COMMITTED, two concurrent INSERTs both see the same balance_check value, so under high concurrency this could race. **The truly safe pattern uses an explicit transaction with row-level locking on a per-user "balance summary" row.**]

**Truly safe pattern (recommended for production):**

```sql
-- Add a per-user balance summary row that gets row-locked.
CREATE TABLE user_balance_lock (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  -- This row is intentionally empty of data; it exists only as a lock target.
  -- Inserted lazily on first reservation.
  last_updated timestamptz DEFAULT now()
);
```

```typescript
// src/ledger/reserve.ts
import { supabaseAdmin } from '../supabase'

export async function reserve(userId: string, estInput: number, maxOutput: number) {
  // Compute reservation
  const inputRate = 1.0    // µ$ per input token (Haiku 4.5)
  const outputRate = 5.0   // µ$ per output token
  const reservationMicro = BigInt(
    Math.ceil(estInput * inputRate * 1.25 + maxOutput * outputRate)
  )

  // Run in a transaction (Supabase RPC wraps this — see RPC below)
  const { data, error } = await supabaseAdmin.rpc('reserve_credits', {
    p_user_id: userId,
    p_reservation_micro: reservationMicro.toString(),
  })
  if (error) throw error
  if (!data || data.length === 0) return { status: 'insufficient' as const }
  return {
    status: 'ok' as const,
    id: data[0].id,
    micro: reservationMicro,
  }
}
```

**The RPC** (atomic, row-locked):

```sql
CREATE OR REPLACE FUNCTION reserve_credits(
  p_user_id uuid,
  p_reservation_micro bigint
) RETURNS TABLE(id uuid) AS $$
DECLARE
  v_balance bigint;
  v_reservation_id uuid;
BEGIN
  -- Ensure lock row exists (idempotent insert)
  INSERT INTO user_balance_lock (user_id) VALUES (p_user_id)
    ON CONFLICT (user_id) DO NOTHING;

  -- Acquire row lock on user_balance_lock
  PERFORM 1 FROM user_balance_lock WHERE user_id = p_user_id FOR UPDATE;

  -- Now safe to read balance — no concurrent reserver can read it
  SELECT balance_micro INTO v_balance FROM ledger_balance WHERE user_id = p_user_id;

  IF v_balance IS NULL OR v_balance < p_reservation_micro THEN
    RETURN; -- empty result set = insufficient
  END IF;

  -- Insert reservation
  INSERT INTO ledger_consumption (user_id, micro, reservation_state)
  VALUES (p_user_id, p_reservation_micro, 'reserved')
  RETURNING ledger_consumption.id INTO v_reservation_id;

  RETURN QUERY SELECT v_reservation_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

[VERIFIED: Postgres `SELECT … FOR UPDATE` on a user-keyed lock row is the canonical pattern for per-user serialization. Used widely in financial systems. The `user_balance_lock` table is essentially a mutex per user.]

**Settling (post-call):**

```sql
CREATE OR REPLACE FUNCTION settle_reservation(
  p_reservation_id uuid,
  p_actual_micro bigint,
  p_anthropic_call_id text
) RETURNS void AS $$
BEGIN
  UPDATE ledger_consumption
  SET
    micro = LEAST(micro, p_actual_micro), -- never go higher than reservation
    reservation_state = 'settled',
    anthropic_call_id = p_anthropic_call_id
  WHERE id = p_reservation_id AND reservation_state = 'reserved';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

The `LEAST(micro, p_actual_micro)` ensures the actual is never above the reservation (which would be a bug — reservation was worst-case). The difference (`reservation - actual`) becomes the implicit refund as `balance_micro` is recomputed on next read.

### Pattern 6: Rate Bucket UPSERT

**What:** Per-user, per-bucket-kind sliding window counter.

**Schema:**
```sql
CREATE TABLE rate_buckets (
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  bucket_kind text NOT NULL CHECK (bucket_kind IN ('rpm', 'itpm', 'otpm', 'daily_dollar')),
  count bigint NOT NULL DEFAULT 0,
  window_start timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, bucket_kind)
);
```

**The UPSERT pattern** (called from the same `reserve_credits` RPC OR as a separate gate):

```sql
CREATE OR REPLACE FUNCTION check_and_increment_bucket(
  p_user_id uuid,
  p_bucket_kind text,
  p_increment bigint,
  p_limit bigint,
  p_window_seconds int
) RETURNS TABLE(allowed boolean, retry_after_seconds int) AS $$
DECLARE
  v_current_count bigint;
  v_window_start timestamptz;
  v_now timestamptz := now();
BEGIN
  -- Upsert with window-reset semantics: if window expired, start fresh.
  INSERT INTO rate_buckets (user_id, bucket_kind, count, window_start)
  VALUES (p_user_id, p_bucket_kind, p_increment, v_now)
  ON CONFLICT (user_id, bucket_kind) DO UPDATE
    SET
      count = CASE
        WHEN rate_buckets.window_start + (p_window_seconds || ' seconds')::interval < v_now
          THEN EXCLUDED.count
        ELSE rate_buckets.count + EXCLUDED.count
      END,
      window_start = CASE
        WHEN rate_buckets.window_start + (p_window_seconds || ' seconds')::interval < v_now
          THEN v_now
        ELSE rate_buckets.window_start
      END
    RETURNING count, window_start INTO v_current_count, v_window_start;

  IF v_current_count > p_limit THEN
    -- Roll back the increment
    UPDATE rate_buckets
      SET count = count - p_increment
      WHERE user_id = p_user_id AND bucket_kind = p_bucket_kind;
    RETURN QUERY SELECT
      false,
      EXTRACT(EPOCH FROM (v_window_start + (p_window_seconds || ' seconds')::interval - v_now))::int;
  ELSE
    RETURN QUERY SELECT true, 0;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

**Window seconds per bucket:**
- `rpm` → 60 (1 minute)
- `itpm` / `otpm` → 60 (1 minute)
- `daily_dollar` → 86400 (24 hours)

**Limits per tier:**
| Tier | rpm | itpm | otpm (optional) | daily_dollar (µ$) |
|------|-----|------|-----------------|-------------------|
| Trial day 1-7 | 20 | 30_000 | n/a | 1_000_000 ($1) |
| Trial day 8+ | 20 | 30_000 | n/a | 5_000_000 ($5) |
| Subscriber | 60 | 200_000 | n/a | 20_000_000 ($20) |

**pg_cron cleanup** [CITED: https://supabase.com/docs/guides/cron — pg_cron is available on Supabase free tier, minimum 1-minute interval]:

```sql
SELECT cron.schedule(
  'rate_buckets_cleanup',
  '0 3 * * *', -- daily at 3am UTC
  $$ DELETE FROM rate_buckets WHERE window_start < now() - interval '25 hours' $$
);
```

### Pattern 7: Lemon Squeezy Webhook (Edge Function)

**Endpoint:** `https://<project>.supabase.co/functions/v1/lemon-webhook`

**Configure in Lemon Squeezy dashboard:** add this URL as a webhook, select all `order_*` + `subscription_*` events, generate signing secret, set `LEMON_SQUEEZY_WEBHOOK_SECRET` env var via `supabase secrets set`.

**Signature header:** `X-Signature: <hex digest>` [CITED: https://docs.lemonsqueezy.com/help/webhooks/signing-requests]

**Verification (Deno-native, using Web Crypto):**

```typescript
// supabase/functions/lemon-webhook/index.ts
import { createClient } from '@supabase/supabase-js'
import { corsHeaders } from '../_shared/cors.ts'

async function verifySignature(rawBody: string, signature: string, secret: string): Promise<boolean> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const computed = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody))
  const computedHex = Array.from(new Uint8Array(computed))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
  // Timing-safe-equal: compare lengths first, then char-by-char with XOR accumulator
  if (computedHex.length !== signature.length) return false
  let diff = 0
  for (let i = 0; i < computedHex.length; i++) {
    diff |= computedHex.charCodeAt(i) ^ signature.charCodeAt(i)
  }
  return diff === 0
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  const signature = req.headers.get('X-Signature')
  if (!signature) return new Response(JSON.stringify({ error: 'missing_signature' }), { status: 401 })

  // CRITICAL: must use the RAW body for signature verification.
  // req.json() consumes the body — read it as text first, then parse.
  const rawBody = await req.text()
  const ok = await verifySignature(rawBody, signature, Deno.env.get('LEMON_SQUEEZY_WEBHOOK_SECRET')!)
  if (!ok) return new Response(JSON.stringify({ error: 'invalid_signature' }), { status: 401 })

  const payload = JSON.parse(rawBody)
  const eventName: string = payload.meta?.event_name
  const eventId: string = payload.meta?.webhook_id ?? `${eventName}-${payload.data?.id}` // fallback
  const userId: string | undefined = payload.meta?.custom_data?.user_id

  if (!userId) {
    // Log + email + Discord alert for manual reconciliation
    console.error(`lemon-webhook: missing custom_data.user_id for event ${eventName} (lemon_event_id=${eventId})`)
    // ... send alert via Resend or similar
    return new Response(null, { status: 202 }) // accept (don't make LS retry)
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  // Idempotent: lemon_event_id is unique constraint on ledger_grants
  switch (eventName) {
    case 'order_created': {
      // One-time $5 pack
      const totalUsd = payload.data?.attributes?.total / 100 // cents → dollars
      // After Lemon Squeezy fee (~5% + $0.50). For $5 pack: $5 - $0.25 - $0.50 = $4.25 net
      // Round-number target: $4.75 of usable credits (per CONTEXT specifics)
      const creditsMicro = 4_750_000 // $4.75 — credit grant per CONTEXT additional context "~$4.75 of usable credits"
      const { error } = await admin.from('ledger_grants').insert({
        user_id: userId,
        kind: 'pack',
        credits_micro: creditsMicro,
        source: 'lemon_squeezy',
        lemon_event_id: eventId,
      })
      if (error && error.code !== '23505' /* unique violation */) {
        return new Response(JSON.stringify({ error: 'insert_failed', detail: error.message }), { status: 500 })
      }
      break
    }
    case 'subscription_created':
    case 'subscription_payment_success': {
      // Monthly $20 subscription. Grant $20 worth of credits (after fee accounting)
      // After fees (~5% + 0.5% subscription premium + $0.50 = ~$1.50): $20 - $1.50 = $18.50 net
      const creditsMicro = 18_500_000 // $18.50 — see Open Question 3
      const { error } = await admin.from('ledger_grants').insert({
        user_id: userId,
        kind: 'subscription',
        credits_micro: creditsMicro,
        source: 'lemon_squeezy',
        lemon_event_id: eventId,
      })
      if (error && error.code !== '23505') {
        return new Response(JSON.stringify({ error: 'insert_failed', detail: error.message }), { status: 500 })
      }
      // Also upsert subscription_status row
      await admin.from('subscription_status').upsert({
        user_id: userId,
        status: 'active',
        renews_at: payload.data?.attributes?.renews_at,
        lemon_subscription_id: payload.data?.id,
      })
      break
    }
    case 'subscription_updated': {
      await admin.from('subscription_status').upsert({
        user_id: userId,
        status: payload.data?.attributes?.status, // 'active' | 'cancelled' | 'expired' | etc.
        renews_at: payload.data?.attributes?.renews_at,
        lemon_subscription_id: payload.data?.id,
      })
      break
    }
    case 'subscription_cancelled':
    case 'subscription_expired': {
      await admin.from('subscription_status').upsert({
        user_id: userId,
        status: payload.data?.attributes?.status,
        ends_at: payload.data?.attributes?.ends_at,
        lemon_subscription_id: payload.data?.id,
      })
      break
    }
  }

  return new Response(JSON.stringify({ ok: true }), { status: 202, headers: corsHeaders })
})
```

**Payload shape reference** [CITED: https://docs.lemonsqueezy.com/help/webhooks/example-payloads]:

```json
{
  "meta": {
    "event_name": "order_created",
    "webhook_id": "<unique-uuid>",
    "custom_data": {
      "user_id": "<sei-supabase-jwt-sub>"
    }
  },
  "data": {
    "type": "orders",
    "id": "<order-id>",
    "attributes": {
      "total": 500,           // cents
      "currency": "USD",
      "status": "paid",
      "first_order_item": { "variant_id": <variant>, ... },
      "user_email": "...",
      "created_at": "2026-05-22T..."
    }
  }
}
```

```json
{
  "meta": {
    "event_name": "subscription_payment_success",
    "webhook_id": "<unique-uuid>",
    "custom_data": { "user_id": "<sub>" }
  },
  "data": {
    "type": "subscriptions",
    "id": "<sub-id>",
    "attributes": {
      "status": "active",
      "renews_at": "2026-06-22T...",
      "variant_id": <variant>,
      ...
    }
  }
}
```

**Idempotency:** `ledger_grants.lemon_event_id` is `unique`. Duplicate INSERT raises Postgres error code `23505` (unique_violation). The handler treats this as success (return 202).

### Pattern 8: Lemon Squeezy Checkout URL

**One-time pack:**
```
https://sei.lemonsqueezy.com/buy/<variant_id_pack>?checkout[custom][user_id]=<jwt_sub>
```

**Subscription:**
```
https://sei.lemonsqueezy.com/buy/<variant_id_subscription>?checkout[custom][user_id]=<jwt_sub>
```

The `checkout[custom][user_id]` query param is encoded into the order's `meta.custom_data.user_id` field on every subsequent webhook event for that order (one-time) or subscription (recurring).

[CITED: https://docs.lemonsqueezy.com/help/checkout/passing-custom-data]

**URL construction** (in `src/main/cloud/proxyClient.ts` or similar):

```typescript
function buildCheckoutUrl(kind: 'pack' | 'subscription', jwtSub: string): string {
  const variant = kind === 'pack'
    ? process.env.LEMON_VARIANT_PACK     // injected via electron-vite
    : process.env.LEMON_VARIANT_SUBSCRIPTION
  const url = new URL(`https://sei.lemonsqueezy.com/buy/${variant}`)
  url.searchParams.set('checkout[custom][user_id]', jwtSub)
  return url.toString()
}
```

`shell.openExternal(url)` hands off to the OS browser — the only safe way per Phase 10 D-10 invariant.

### Pattern 9: Trial Claim Edge Function

**Endpoint:** `https://<project>.supabase.co/functions/v1/trial-claim`

**Body:** `{ "mc_username": "<minecraft-name-string>" }` (NOTE: user_id comes from verified JWT, NOT body — same T-12-05-01 mitigation as `submit-report`)

**Code** (mirrors `submit-report` two-client pattern):

```typescript
// supabase/functions/trial-claim/index.ts
import { createClient } from '@supabase/supabase-js'
import { corsHeaders } from '../_shared/cors.ts'

const TRIAL_CREDITS_MICRO = 1_000_000 // $1

export async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'missing_jwt' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }

  const userClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  )
  const { data: userData, error: userErr } = await userClient.auth.getUser()
  if (userErr || !userData.user) {
    return new Response(JSON.stringify({ error: 'invalid_jwt' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }
  const userId = userData.user.id

  let body: { mc_username?: unknown }
  try { body = await req.json() } catch {
    return new Response(JSON.stringify({ error: 'bad_request' }), { status: 400 })
  }
  if (typeof body.mc_username !== 'string' || body.mc_username.length < 1 || body.mc_username.length > 32) {
    return new Response(JSON.stringify({ error: 'bad_request', detail: 'invalid_mc_username' }), { status: 400 })
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  // Atomic: insert claim; if mc_username already claimed → no rows returned
  const { data: claim, error: claimErr } = await admin
    .from('trial_claims')
    .insert({ mc_username: body.mc_username, sei_user_id: userId })
    .select()
    .single()

  if (claimErr) {
    if (claimErr.code === '23505') {
      // Already claimed
      return new Response(JSON.stringify({ ok: false, code: 'already_claimed' }), { status: 409 })
    }
    return new Response(JSON.stringify({ ok: false, code: 'insert_failed', detail: claimErr.message }), { status: 500 })
  }

  // Grant trial credits
  const { error: grantErr } = await admin.from('ledger_grants').insert({
    user_id: userId,
    kind: 'trial',
    credits_micro: TRIAL_CREDITS_MICRO,
    source: 'trial_claim',
    lemon_event_id: null, // trial grants don't have a lemon event
  })
  if (grantErr) {
    // Compensating delete — release the trial claim so user can retry
    await admin.from('trial_claims').delete().eq('mc_username', body.mc_username)
    return new Response(JSON.stringify({ ok: false, code: 'grant_failed' }), { status: 500 })
  }

  return new Response(JSON.stringify({ ok: true, credits_micro: TRIAL_CREDITS_MICRO }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

if (import.meta.main) Deno.serve(handler)
```

**Trigger point** (Sei main process):
- Listen for `bot:summon-success` event from utilityProcess after the bot has successfully joined the LAN world AND `bot.players[mc_username]` confirms the user is present.
- IF `useCreditsStore.balance_micro === 0` AND `useCreditsStore.trial_claimed === false`, call `trial:claim` with the username from the bot's join handshake.

**Why not at sign-up:** CONTEXT D-42 + Pitfall — at sign-up the user has no MC username to claim against. The username string is only knowable from a successful bot join (`bot.players` map after LAN connection).

### Pattern 10: IPC Channels + zustand Store

**New IPC channels** (registered in `src/shared/ipc.ts` → handlers in `src/main/ipc.ts` → bindings in `src/preload/index.ts`):

| Channel | Direction | Payload | Returns |
|---------|-----------|---------|---------|
| `proxy:configure` | renderer→main | `{ enabled: boolean }` | `{ ok: true }` — sets `backendKind` |
| `trial:claim` | main→Edge (internal) | `{ mc_username }` | `{ ok, credits_micro? }` |
| `credits:get` | renderer→main | — | `{ remaining_pct: number, balance_micro: number, plan: 'trial'\|'pack'\|'unlimited', renews_at?: string, trial_claimed: boolean }` |
| `credits:remaining-pct-updated` | utilityProcess→main→renderer | `{ pct: number }` | (event broadcast) |
| `credits:open-checkout` | renderer→main | `{ kind: 'pack'\|'subscription' }` | `{ ok: true }` — calls shell.openExternal |
| `subscription:cancel` | renderer→main | — | `{ ok, redirect_url }` — opens LS customer portal externally |
| `credits:hard-stop` | utilityProcess→main→renderer | `{ reason: 'depleted'\|'rate_limited', persona_name?: string }` | (event broadcast) |

**zustand store shape** (`src/renderer/src/lib/stores/useCreditsStore.ts`):

```typescript
interface CreditsState {
  remaining_pct: number          // 0..100, rounded to nearest 5
  plan: 'trial' | 'pack' | 'unlimited' | 'depleted'
  renews_at: string | null       // ISO date if subscription
  trial_claimed: boolean
  loading: boolean
  hardStop: { reason: 'depleted' | 'rate_limited'; personaName?: string } | null

  // Actions
  refresh: () => Promise<void>             // calls credits:get
  setRemainingPct: (pct: number) => void  // called from credits:remaining-pct-updated event
  openCheckout: (kind: 'pack' | 'subscription') => Promise<void>
  dismissHardStop: () => void
}
```

**Update flow:**
1. utilityProcess receives proxy response with `X-Sei-Remaining-Pct: 65` header.
2. utilityProcess sends `credits:remaining-pct-updated` IPC message to main.
3. Main rebroadcasts to renderer via the existing renderer-bridge.
4. Renderer's `useCreditsStore` updates `remaining_pct`.
5. CreditsScreen + pricing icon re-render reactively.

### Anti-Patterns to Avoid

- **DO NOT** use `req.json()` BEFORE signature verification in the Lemon Squeezy webhook handler — must read raw body as text first, verify, THEN parse. Calling `req.json()` consumes the body.
- **DO NOT** trust `reporter_id` / `user_id` from request bodies in Edge Functions. Always source from `auth.getUser()` (T-12-05-01 mitigation pattern from `submit-report`).
- **DO NOT** show token counts ANYWHERE in the UI (PROXY-05 — bright-line rule). The proxy may log internally, but the renderer's hard contract is `remaining_pct: number` and nothing else.
- **DO NOT** rely on Anthropic's `usage` field being correct on streaming errors. If the stream closes without a `message_delta` final usage event, settle at full reservation amount (no refund) and log for review.
- **DO NOT** retry Lemon Squeezy webhook handlers on 5xx — Lemon Squeezy will retry automatically per their docs. Returning 202 even on partial-success is safer than 500 (forces idempotency to handle the retry cleanly).
- **DO NOT** use the materialized `ledger_balance` MV pattern from CONTEXT D-47 verbatim. Materialized views REQUIRE manual refresh — under high concurrency with `REFRESH MATERIALIZED VIEW CONCURRENTLY` they have meaningful lag. Use a regular VIEW (or compute live in the RPC) — see Open Question 2.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| JWT verification | Manual base64 decode + signature check | `jose.jwtVerify()` + `createRemoteJWKSet()` | JWKS rotation, audience validation, expiration handling, ES256 support all built in |
| Webhook signature | Custom HMAC code | Web Crypto API (`crypto.subtle.sign`) in Deno; `node:crypto.createHmac` in Node | Battle-tested, timing-safe-equal available |
| Token estimation | Regex / char counting | `@anthropic-ai/tokenizer` | Anthropic-published, matches their server-side tokenizer |
| SSE parsing | Custom event-stream parser | Hono's `streamSSE` for outbound + manual buffer split on `\n\n` for inbound (no library needed for SSE-pass-through, but Hono helper handles outbound headers correctly) | Robust against partial chunks |
| Atomic ledger writes | App-level mutex / Redis lock | Postgres `SELECT FOR UPDATE` row-lock + RPC function | Transactional guarantees; no shared infrastructure to operate |
| Rate-limit window counting | Redis-style sliding window in app code | Postgres UPSERT into `rate_buckets` | Single source of truth (no Redis to run); pg_cron handles cleanup |
| Per-tier pricing tables | Hardcoded constants scattered through code | Single `src/anthropic/pricing.ts` module exporting `PRICING[model]` | Centralizes the only place that changes when Anthropic updates pricing |

**Key insight:** This phase is almost entirely about wiring well-defined building blocks together. The temptation will be to "simplify" things (e.g., skip the row-lock and trust READ COMMITTED, or skip the JWKS cache and verify every JWT against the static secret). DON'T. Every shortcut listed here is the source of a known production bug in similar systems.

## Runtime State Inventory

> Phase 13 is greenfield deployment — new Fly.io app, new Supabase tables, new Lemon Squeezy products. The only "runtime state" concerns are listed below.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | New Supabase tables: `ledger_grants`, `ledger_consumption`, `rate_buckets`, `trial_claims`, `subscription_status`, `user_balance_lock`. | New migrations in `supabase/migrations/`. No existing data to migrate (Phase 13 is the first phase to introduce these tables). |
| Live service config | Lemon Squeezy products (`Sei Credits $5 Pack`, `Sei Unlimited $20/mo`) must be created in the Lemon Squeezy dashboard, NOT in git. Variant IDs are captured and stored as env vars in Sei's electron-vite build config (`LEMON_VARIANT_PACK`, `LEMON_VARIANT_SUBSCRIPTION`). | Operator runbook step (checkpoint:human-verify) — create products, capture variant IDs, set env vars. |
| OS-registered state | None — Fly.io app is fresh, no migrating from a prior platform. | None. |
| Secrets/env vars | New secrets to set: `ANTHROPIC_API_KEY` (Fly), `SUPABASE_SERVICE_ROLE_KEY` (Fly), `SUPABASE_JWKS_URL` (Fly), `LEMON_SQUEEZY_WEBHOOK_SECRET` (Supabase Edge Function), `LEMON_VARIANT_PACK` + `LEMON_VARIANT_SUBSCRIPTION` (Sei build env), `DISCORD_BILLING_ALERT_WEBHOOK_URL` (Edge Function). | `fly secrets set` + `supabase secrets set` + electron-vite `define` config. |
| Build artifacts | `proxy/dist/` built by `tsc` before `fly deploy`. `.gitignore` `dist/` to avoid committing build output. | Add `proxy/dist/` to repo `.gitignore`. |

**Existing TOS_VERSION + PRIVACY_VERSION values:** Phase 12-15 already bumped to `2026-05-22`. Phase 13 ships `terms.html §8` (Refunds and Cancellations) → MUST bump to `2026-05-23` (or later — pick a unique date) to trigger one more `AcceptToSModal` cycle per the established pattern from 12-15.

## Common Pitfalls

### Pitfall 1: SSE Header Injection Timing
**What goes wrong:** Trying to inject `X-Sei-Remaining-Pct` after the stream opens fails silently — Hono buffers headers until first body write, and once any byte has been written, headers cannot be changed.
**Why it happens:** Developer naturally wants to send the "real" remaining_pct AFTER the upstream response settles, but by then the SSE stream has already opened.
**How to avoid:** Compute remaining_pct from the POST-reservation balance (i.e., what the user will have if they consume the full reservation). This is always a lower bound on actual remaining and is correct for showing the user. Refunds from the settle step apply to the NEXT request's header value.
**Warning signs:** UI % bar lags by exactly one request, or shows stale values during long streams.

### Pitfall 2: Webhook Signature with Parsed Body
**What goes wrong:** `req.json()` consumes the request body. If signature verification happens after parsing, you have nothing left to hash.
**Why it happens:** Most Edge Function templates start with `await req.json()` as the first body line.
**How to avoid:** Always `const rawBody = await req.text()` first, verify signature against rawBody, THEN `JSON.parse(rawBody)`.
**Warning signs:** Webhook always returns 401 invalid_signature even with the correct secret.

### Pitfall 3: TOCTOU Race on Parallel Reservations
**What goes wrong:** Two concurrent requests from the same user both see `balance_micro = 1000`, both pass the check, both reserve 800 → user is now at -600.
**Why it happens:** Postgres default READ COMMITTED + single-statement INSERT-WHERE doesn't serialize concurrent readers.
**How to avoid:** Use a per-user lock row (`user_balance_lock`) with `SELECT … FOR UPDATE` inside a transaction (the `reserve_credits` RPC pattern above).
**Warning signs:** Occasional negative `balance_micro` values in `ledger_balance`. Production reports of users "burning through credits faster than they should."

### Pitfall 4: Missing `custom_data.user_id`
**What goes wrong:** Lemon Squeezy webhook arrives without the user_id field — perhaps the checkout link was missing the query param, or the user manually visited the buy page.
**Why it happens:** Customers find products via search engines, copy-paste links without query params, or marketing landing pages don't preserve custom_data.
**How to avoid:** Always log + alert (Discord webhook + email) when `meta.custom_data.user_id` is missing. Don't 500 — return 202 so Lemon Squeezy doesn't retry endlessly. Surface in a manual reconciliation queue.
**Warning signs:** "I paid but didn't get credits" support emails.

### Pitfall 5: Anthropic Rate Limit Tier Mismatch
**What goes wrong:** Per-user caps (D-51) assume Anthropic Tier 2 is unlocked (which gives the org 1,000 RPM / 450K ITPM / 90K OTPM on Haiku 4.5). At launch we'll be on Tier 1 (50 RPM / 50K ITPM / 10K OTPM on Haiku 4.5). [VERIFIED: https://platform.claude.com/docs/en/api/rate-limits]
**Why it happens:** D-51's "60 RPM" subscriber tier already exceeds the org's Tier 1 ceiling of 50 RPM. With even a few concurrent subscribers, we'll hit Anthropic 429s.
**How to avoid:**
- Pre-launch: spend $40 cumulative on the org Anthropic account to unlock Tier 2 BEFORE the first paying user.
- Document this as a `checkpoint:human-verify` step in the launch runbook.
- Set conservative per-user limits at launch: 10 RPM / 30K ITPM until at least 5 subscribers are active. Increase as Anthropic tier advances.
**Warning signs:** Sentry/logs showing `service_at_capacity` (proxy's translation of Anthropic 429) on quiet days.

### Pitfall 6: Lemon Squeezy Fee Accounting
**What goes wrong:** Granting $5 of credits for a $5 sale means we eat the LS fee (5% + $0.50 = $0.75 for a $5 sale → net $4.25 to us; we'd be giving away $0.75 per pack).
**Why it happens:** Optimistic accounting at planning time.
**How to avoid:** Grant $4.75 of usable credits per $5 pack and $18.50 per $20 subscription. Document this in the product description ("powered by Sei"). Operator decides whether to round to a friendly number ($4.75 vs $4.50). See Open Question 3.
**Warning signs:** Negative margins per transaction. (Reverse: granting too little of usable credits feels bait-and-switchy if Sei advertises "$5 of credits".)

### Pitfall 7: Trial Claim at Sign-Up vs Bot Summon
**What goes wrong:** Trying to claim the trial at sign-up — but the user has no MC username yet, so we can't gate it on the username string per D-42.
**Why it happens:** Sign-up feels like the "natural" gate for new-user credits.
**How to avoid:** Claim at FIRST successful bot summon, after `bot.players[mc_username]` confirms the LAN world has the matching player. This requires bot.players to be populated (the bot must be IN the LAN world for at least one tick).
**Warning signs:** Users with empty ledgers complaining they "signed up but never got their trial credits."

### Pitfall 8: @anthropic-ai/tokenizer Stuck at 0.0.x
**What goes wrong:** The official tokenizer hasn't been versioned past 0.0.4 in years. Its tokenizer model may not match newer Claude models (Haiku 4.5 might tokenize differently than what the 0.0.4 release was trained on).
**Why it happens:** Anthropic's official tokenizer is community-maintenance-mode; the actual tokenization happens server-side and is not exposed.
**How to avoid:** Accept ~95% accuracy as documented. Compensate with the 1.25× reservation multiplier (already in D-50). After enough real traffic, calibrate the multiplier from observed `usage.input_tokens / estimated_input_tokens` ratios.
**Warning signs:** Persistent under-reservation (frequent 402s near the end of long requests).

### Pitfall 9: Mac App Store / Microsoft Store Distribution
**What goes wrong:** Plan to ship Sei to Mac App Store later → both stores require in-app purchase via their store, not Lemon Squeezy.
**Why it happens:** Apple/Microsoft mandate IAP for "digital content" on their stores.
**How to avoid:** Phase 13 explicitly ships direct-download only via electron-builder. Document Mac App Store / Microsoft Store as deferred to v1.x and noted as a known incompatibility. CONTEXT.md additional context already flagged this.
**Warning signs:** N/A — known deferred item.

### Pitfall 10: Persona-Aware Hard-Stop with No Persona Loaded
**What goes wrong:** Hard-stop modal tries to render persona-aware copy, but the user just signed up and hasn't selected a persona yet, OR they're between bot sessions with no persona loaded.
**Why it happens:** First-launch + ledger-empty edge case.
**How to avoid:** Fallback copy: "You're out of credits — top up to keep your bot running." No persona name interpolation. Implement a `personaName ?? 'Your bot'` ternary in the modal copy template.
**Warning signs:** `undefined` substituted into modal text in screenshots.

### Pitfall 11: Anthropic Tier Tracking
**What goes wrong:** No programmatic way to detect "Anthropic Tier 1 → Tier 2 transition" beyond reading the dashboard. The proxy can't auto-bump its per-user `daily_dollar` cap.
**Why it happens:** Anthropic doesn't expose tier info via API; it's a dashboard-only setting.
**How to avoid:** Manual operator action — after Anthropic's tier auto-bump, operator runs a SQL one-liner to update `rate_buckets` policy or a config table. Document in launch runbook.
**Warning signs:** Subscribers throttled despite paying $20/mo.

## Code Examples

(All code examples in §Architecture Patterns are verified against the canonical sources listed in §Sources. The Hono SSE pattern is the only one not fully verified end-to-end against a running Anthropic SSE stream — the planner should treat the SSE forwarder as a Wave 1 build-and-test target, not a copy-paste-and-ship.)

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Supabase static JWT secret | Asymmetric JWT signing keys via JWKS | 2025 | Phase 13 MUST use JWKS endpoint, not the legacy `JWT_SECRET` env var. [CITED: https://supabase.com/blog/jwt-signing-keys] |
| Lemon Squeezy webhook idempotency via timestamps | Lemon Squeezy now includes `meta.webhook_id` for explicit dedup | 2024+ | Use `webhook_id` as the `lemon_event_id` unique key — more robust than synthesizing from event_name + data.id. |
| Anthropic 1-hour cache TTL | 1-hour AND 5-minute ephemeral caches available; pricing differs (1.25× write for 5-min, 2× for 1-hour) | 2024+ | Sei uses 5-minute `cache_control: { type: 'ephemeral' }` per existing `anthropicClient.js` — pricing multiplier is 1.25× which matches our reservation multiplier. |
| Fly.io machines API for scaling | `auto_stop_machines = 'stop'` declarative in fly.toml | Current default | No code-driven scaling needed. Set in fly.toml. |

**Deprecated/outdated:**
- Supabase legacy `JWT_SECRET` shared-secret JWT verification → replaced by JWKS asymmetric. Don't use.
- Lemon Squeezy `subscription_created` payload-with-payment shape (old API) → replaced by `subscription_payment_success` as a separate event. Phase 13 webhook handles BOTH — `subscription_created` to set up `subscription_status`, `subscription_payment_success` to grant credits each renewal.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Single-statement INSERT-WHERE-balance-check is NOT race-safe under READ COMMITTED | Pattern 5 | If actually race-safe under Postgres's snapshot semantics, the user_balance_lock row is unnecessary overhead. Risk: minor; the lock pattern is correct either way. |
| A2 | `webhook_id` field in `meta` is unique per Lemon Squeezy webhook event | Pattern 7 (idempotency) | If `webhook_id` is missing or repeats on retries, duplicate grants. Mitigation: fallback to `${event_name}-${data.id}` synthesis. |
| A3 | Anthropic SSE `message_start` carries cache_creation/cache_read in usage | Pattern 3 (SSE pass-through) | If usage only arrives on `message_delta`, the proxy will miss cache_read accounting for streaming. Likely correct per Anthropic docs, but planner should test against a real cache-hit stream in Wave 1. |
| A4 | Lemon Squeezy fee for $20/mo subscription is ~$1.50 net | Pattern 7 (subscription_payment_success grant) | If actual fee is higher (international, etc.), we eat margin. Planner should compute net credit grant from actual `payload.data.attributes.subtotal - fee` if Lemon Squeezy exposes fee fields in webhook payload — verify in Wave 1. |
| A5 | Anthropic tier auto-advances when cumulative credit purchase + 7 days pass | Pitfall 5 | If tier-up requires manual support ticket, our launch math (Tier 2 unlock at $40) is wrong. Operator runbook should verify by spending $40 in test purchases pre-launch. |
| A6 | `@anthropic-ai/tokenizer` ~95% accuracy for English | Pitfall 8 | Could be lower for Sui/Lyra personas if they use non-English characters. Calibrate from production data. |
| A7 | Persona-aware copy renders client-side from loaded persona, NOT server-side | Architectural Responsibility Map | CONTEXT D-56 says "server-side persona-aware copy" but the proxy doesn't know the persona. RECOMMENDATION: render client-side. See Open Question 1. |
| A8 | Lemon Squeezy `total` field is in cents (integer) | Pattern 7 | Standard for payment APIs but worth verifying with first real webhook. |
| A9 | Subscription `subscription_payment_success` fires on initial purchase AND on every renewal | Pattern 7 | If it only fires on renewals (not initial), we'd miss the first month's grant. Lemon Squeezy docs suggest it fires on BOTH; verify in Wave 1 with a test subscription. |
| A10 | `pg_cron` cleanup at `0 3 * * *` (3am UTC) doesn't conflict with Phase 10's `deletion_queue` cron | Pattern 6 | Different schedules; check `supabase/migrations/20260520*` for existing cron times to avoid clobbering. |

## Open Questions

1. **Where does persona-aware hard-stop copy render?**
   - What we know: CONTEXT D-56 says "persona-aware copy generated server-side." The proxy returns 402 with `{ error: 'payment_required' }`, no persona info.
   - What's unclear: Does the proxy receive persona context? It currently doesn't.
   - Recommendation: Render client-side from the persona currently loaded in the bot. Server-side just returns a flag (`{ error: 'payment_required', hard_stop: true }`); client maps persona → copy template. Fallback to generic "You're out of credits" when no persona is loaded.

2. **VIEW vs MATERIALIZED VIEW for `ledger_balance`?**
   - What we know: CONTEXT D-47 says "Materialized view `ledger_balance` per user, refreshed on insert via trigger." Triggers refreshing a MV per-insert is expensive and creates lock contention.
   - What's unclear: Why a MV and not a regular VIEW?
   - Recommendation: Use a regular VIEW (live sum). For per-user load (one user's grants + consumption), sum performance is fine for v1.0 scale. Revisit if per-user row counts exceed 10K. Document this as a deviation from CONTEXT D-47 — needs planner approval. (Alternative: keep an explicit `user_balance` table updated by trigger, which is faster to read than a VIEW but adds write amplification. Trade-off should be planner-decided.)

3. **Net credit grant per pack/subscription — exact value?**
   - What we know: CONTEXT additional context says "LS takes ~5%, so ~$4.75 of usable credits" for the $5 pack. The $20/mo subscription has a +0.5% subscription premium so net is closer to $18.50.
   - What's unclear: Should we grant the exact net amount, or round to a friendly number ($5 → $4.75, $20 → $18.50)? Should the product description say "$5 buys ~$4.75 of credits" or just "$5 pack" with the conversion hidden in the ToS?
   - Recommendation: Grant the rounded values $4_750_000 µ$ / $18_500_000 µ$ as documented in the code examples above. Document fee math in ToS §8 alongside the refund policy. Operator runbook step: confirm copy with legal pre-launch.

4. **TOS_VERSION bump — what date string?**
   - What we know: Phase 12-15 already bumped to 2026-05-22.
   - What's unclear: Phase 13 ToS update for §8 Refunds needs a NEW date. Pick a date past Phase 12-15's value (e.g., when Phase 13 ships, or a fixed offset like 2026-05-30).
   - Recommendation: Bump to the date Phase 13 plan-01 runs, OR commit to a placeholder like `2026-06-15` and update via final-plan `chore` commit before deploy. Planner decision.

5. **Subscription cancellation surface?**
   - What we know: CONTEXT D-55 mentions "label flips to 'Manage' + 'Cancel'" when subscription active. Lemon Squeezy provides a customer portal URL per subscription.
   - What's unclear: Do we host an in-app cancel UI, or just `shell.openExternal` the LS customer portal?
   - Recommendation: Open LS customer portal externally. Less code to maintain; LS handles ToS-required cancellation flows correctly.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node 22 | proxy/ build + runtime | ✓ (Fly.io provides; local dev: `node` v25.8.2 here) | 25.8.2 | Pin to 22 in Dockerfile |
| npm | proxy/ install | ✓ | 11.11.1 | — |
| fly CLI (`flyctl`) | deploy proxy | ✗ | — | Operator must `brew install flyctl` per Fly.io docs |
| supabase CLI | Edge Function deploy + migrations | ✗ | — | Operator must install via `brew install supabase/tap/supabase` OR use Supabase MCP (which the agent already has access to per repo config) |
| Anthropic API key | upstream calls | ✓ (existing in Sei users' configs) | — | Sei org needs its OWN org-level key for the proxy's upstream calls — separate from BYOK users' keys |
| Lemon Squeezy account + products | webhook ingestion + checkout URLs | ✗ — pre-launch operator task | — | None — required for launch |
| Supabase project | Edge Functions + Postgres + JWKS | ✓ (existing from Phase 10) | — | — |
| DMCA agent registration | (already published — Phase 12-15+) | ✓ | — | — |

**Missing dependencies with no fallback:**
- `flyctl` for proxy deployment (operator install task)
- `supabase` CLI for Edge Function deployment (operator install task OR use Supabase MCP)
- Lemon Squeezy account + product setup (operator pre-launch task → runbook checkpoint)
- Org-level Anthropic API key with at least Tier 1 ($5+ deposit; Tier 2 strongly preferred for launch)

**Missing dependencies with fallback:** None — Phase 13 is greenfield, all critical deps are operator-install or external accounts.

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | jose JWT verification against Supabase JWKS; no shared secret; audience='authenticated' enforced |
| V3 Session Management | yes (downstream) | Supabase session lifecycle (Phase 10); proxy is stateless |
| V4 Access Control | yes | Per-user JWT `sub` claim is the ledger key; RLS prevents cross-user reads via supabase-js; service_role used by Edge Functions only |
| V5 Input Validation | yes | zod at IPC boundaries; Edge Function body validation; reason enum allowlist (mirrors `submit-report`); UUID format check on user_id |
| V6 Cryptography | yes | HMAC-SHA256 via Web Crypto API; timing-safe-equal comparison; never hand-roll |

### Known Threat Patterns for {Hono + Supabase + Lemon Squeezy + Anthropic} stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| JWT replay after expiration | Spoofing | jose validates `exp` automatically; reject `expired_jwt` with 401 |
| Webhook replay attack | Spoofing | HMAC signature verification + idempotency via `lemon_event_id` unique constraint |
| Spoofed user_id in webhook | Spoofing | Trust ONLY `meta.custom_data.user_id` which round-trips from checkout — but verify it's a real UUID and exists in `auth.users` before granting. Alert + don't grant if user_id is missing or invalid. |
| Negative balance via parallel reservations | Tampering | `user_balance_lock` per-user mutex row + `SELECT FOR UPDATE` (Pattern 5) |
| Replay of cancelled subscription webhook | Tampering | `subscription_status` UPSERT idempotent on (user_id) — last write wins by event timestamp (or reject if `payload.data.attributes.updated_at` < stored value) |
| API key exfiltration via logs | Information Disclosure | Never log full JWTs, API keys, or signature secrets. `console.error` allowed for user_id + event_name + status — nothing more. |
| Hostile MC username at trial-claim (SQL injection via mc_username) | Tampering | Parameterized queries via supabase-js .insert(); zod-validate length 1-32; reject any character outside `[a-zA-Z0-9_]` (Mojang username rules) |
| Cross-site request forgery on checkout URL | Tampering | `shell.openExternal` is OS-mediated; no CSRF surface inside Electron |
| Denial-of-service via rapid 402s | DoS | Anthropic per-user rate caps already gate this; proxy returns 402 cheaply without calling upstream |
| Org-level Anthropic key leakage in proxy logs | Information Disclosure | Set `ANTHROPIC_API_KEY` via `fly secrets set`; never log request headers; never log the env var |
| Race condition: webhook arrives before user_id exists in auth.users | (data integrity) | Lemon Squeezy webhook handler MUST verify `auth.users` has the user_id before granting — if not, treat as orphan and queue for manual review |

## Sources

### Primary (HIGH confidence)
- Anthropic Messages API rate limits (verified via WebFetch 2026-05-22): https://platform.claude.com/docs/en/api/rate-limits
- Anthropic Haiku 4.5 pricing: https://www.anthropic.com/news/claude-haiku-4-5 + https://platform.claude.com/docs/en/about-claude/pricing
- Anthropic prompt caching pricing multipliers (verified via WebSearch): 5-min cache write = 1.25×, 1-hour cache write = 2×, cache read = 0.10× input rate
- Supabase JWT signing keys / JWKS endpoint: https://supabase.com/docs/guides/auth/signing-keys + https://supabase.com/blog/jwt-signing-keys
- Hono streaming helpers (verified via WebFetch): https://hono.dev/docs/helpers/streaming
- Lemon Squeezy webhook signature verification: https://docs.lemonsqueezy.com/help/webhooks/signing-requests
- Lemon Squeezy custom_data passing: https://docs.lemonsqueezy.com/help/checkout/passing-custom-data
- Fly.io autostop/autostart: https://fly.io/docs/launch/autostop-autostart/
- Supabase pg_cron: https://supabase.com/docs/guides/cron
- npm registry version verifications (npm view performed 2026-05-22 against hono, jose, @anthropic-ai/tokenizer, @anthropic-ai/sdk, @lemonsqueezy/lemonsqueezy.js, zod)

### Secondary (MEDIUM confidence)
- Lemon Squeezy fee structure (5% + $0.50, +0.5% subscriptions, +1.5% international/PayPal): https://docs.lemonsqueezy.com/help/getting-started/fees (WebSearch summary; precise net-credit math should be re-verified by operator pre-launch)
- Anthropic SSE event sequence (`message_start` → `content_block_*` → `message_delta` → `message_stop`): https://docs.anthropic.com/en/docs/build-with-claude/streaming (WebSearch summary; planner should fetch the canonical docs page for the exact event-by-event JSON shapes in Wave 1)

### Tertiary (LOW confidence — needs Wave 1 validation against live API)
- Exact JSON shape of `subscription_payment_success` vs `subscription_created` payload (the differences matter for whether we grant on both or just one — see Open Question 9 / Assumption A9)
- Anthropic's exact tier-up automatic-advancement behavior (some sources suggest manual; the rate-limits doc says "automatically as you reach certain thresholds")

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all versions npm-verified, all libraries locked by CONTEXT, no alternative discovery needed
- Architecture patterns: HIGH for JWT/webhook/Fly.io/pricing; MEDIUM for SSE pass-through (verified pattern but not run against live Anthropic stream); MEDIUM for atomic ledger (correct pattern, multiple valid shapes)
- Pitfalls: HIGH — these are well-documented production failure modes in similar systems

**Research date:** 2026-05-22
**Valid until:** 2026-06-21 (30 days; Lemon Squeezy and Anthropic API are stable; pricing should be re-verified if launch slips beyond this)

## RESEARCH COMPLETE
