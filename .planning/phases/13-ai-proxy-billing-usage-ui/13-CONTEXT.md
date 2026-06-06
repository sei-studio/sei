# Phase 13: AI Proxy + Billing + Usage UI - Context

**Gathered:** 2026-05-22
**Status:** Ready for planning
**Mode:** Smart discuss (autonomous) with provider locks + multi-round clarification

<domain>
## Phase Boundary

Light up paid revenue via a Fly.io-hosted Hono proxy that sits between Sei bots and Anthropic, enforces per-user JWT + token-bucket + RPM/TPM/daily-$ caps, and surfaces remaining capacity to users via a friendly % bar in the GUI. Lemon Squeezy is the Merchant of Record for both a $5 one-time pack and a $20/mo subscription. Includes a one-time **free trial gate keyed to Minecraft username string** (LAN-only constraint, see [[sei-lan-only-mvp]]).

Phase 13 delivers in TWO sub-deliveries per ROADMAP rationale:

- **Sub-delivery (a) — Proxy MVP via `baseURL` override** (~10 lines of changes to Sei's existing `anthropicClient.js`). Ships BEFORE the Phase 14 multi-provider refactor lands. Lets early revenue-validating users start paying.
- **Sub-delivery (b) — `LlmProvider` variant** that re-touches the proxy mode after Phase 14 lands. Same proxy backend; client-side abstraction shift only.

Phase 13 delivers:

- Fly.io app `sei-proxy/` (Hono on Node 22, region `iad`, 256MB scale-to-zero 0-2)
- Supabase JWT verification via JWKS endpoint (jose library, 1h JWKS cache)
- Anthropic upstream call via `POST /v1/messages` pass-through with SSE streaming
- Server-driven `X-Sei-Remaining-Pct: <0..100>` response header on every Anthropic response
- Free trial gate: `trial_claims (mc_username pk, sei_user_id, claimed_at)` table — INSERT … ON CONFLICT DO NOTHING enforces uniqueness at first bot summon
- Lemon Squeezy two-product structure: $5 one-time pack + $20/mo subscription
- Supabase Edge Function `lemon-webhook` (HMAC-verified, idempotent via `lemon_event_id` unique)
- Ledger: `ledger_grants` + `ledger_consumption` tables, `credits_micro` bigint (millionths of a dollar to avoid floats), FIFO drain
- Token-bucket pre-deduction: 1.25× worst-case reservation (cache-write protection) BEFORE forwarding to Anthropic, atomic SQL row-lock against user balance
- Per-user rate caps via Supabase `rate_buckets` table (pg_cron TTL cleanup): trial 20 RPM/30K TPM/$1-day-for-first-7-days-then-$5-day; subscriber 60 RPM/200K TPM/$20/day
- Cache savings refunded to user ledger (compute actual cost from `usage.input/cache_creation/cache_read/output × respective rates`; refund reservation − actual)
- Pricing icon directly above Settings icon in the existing left vertical rail; hover tooltip + click → CreditsScreen
- CreditsScreen with only three blocks: % bar / Top-up / Unlimited tile — NO token counts, NO dollar amounts shown
- Hard-stop modal on 402 (ledger empty) or 0% (remaining_pct) with persona-aware copy + Top-up + Subscribe + "switch to local API key" links
- BYOK bypass: `backendKind === 'local'` users see NO pricing icon and NO CreditsScreen (PROXY-11)
- Refund policy + Anthropic ToS pre-launch checklist (`terms.html §8`)

Out of scope for Phase 13:
- Multi-provider abstraction (Phase 14)
- Microsoft OAuth identity binding for stronger trial gate (deferred — flag if abuse observed)
- Per-tier discount pricing / annual subscriptions (v1.x)
- Usage history charts, monthly statements (v1.x)
- Team / family billing accounts (v1.x)
- Refund self-service portal (v1.0 = manual via dmca@sei.app or support inbox)
- Tax handling beyond Lemon Squeezy MoR (LS handles VAT/GST)

</domain>

<decisions>
## Implementation Decisions

### Proxy Architecture (PROXY-07, PROXY-08, PROXY-10)

- **D-38:** Single Fly.io app named `sei-proxy` with code in repo at `proxy/` directory. Hono framework, Node 22, region `iad` (us-east), 256MB shared-cpu-1x instance, auto-scale 0-2 with scale-to-zero idle behavior. Deployed via `fly deploy` from `proxy/`. **Rationale:** scale-to-zero pricing matches Sei's bursty traffic; Hono runs on multiple targets (Cloudflare Workers / Vercel) if we ever migrate. Hosting "revisit after MVP traffic data" noted in deferred-items.
- **D-39:** JWT verification using `jose` library against Supabase JWKS endpoint (`<supabase>/auth/v1/.well-known/jwks.json`). JWKS cached in proxy memory for 1h. JWT must have `aud=authenticated`, valid `exp`, and `sub` becomes the canonical `user_id` for ledger lookups. No shared secret. **Rationale:** avoids per-request network hop to Supabase auth.getUser; JWKS rotation handled by the 1h refresh.
- **D-40 (proxy upstream shape):** Sub-delivery (a) — Sei's existing `anthropicClient.js` gets a `cloudMode: { baseURL, authToken }` configuration. When cloud mode is active, the SDK calls `POST {baseURL}/v1/messages` with `Authorization: Bearer <jwt>`. Proxy verifies JWT → pre-deducts → forwards verbatim to Anthropic with the org API key → streams response back. Streaming SSE is pass-through. Sub-delivery (b) lands in Phase 14 — same proxy backend, just an `LlmProvider` interface on the client side.
- **D-41:** `X-Sei-Remaining-Pct: <integer 0-100>` response header added on every successful Anthropic response. Computed proxy-side as `min(daily_remaining / daily_cap, monthly_remaining / monthly_cap) × 100`, rounded to nearest 5%. Client store (`useCreditsStore`) reads this on every response and updates UI. No separate poll endpoint; the % bar refreshes naturally as the user uses the bot.

### Trial Gate (LAN-Only Constraint)

- **D-42:** Free trial entitlement is gated on the Minecraft username STRING (not Mojang UUID — Sei v1.0 only supports LAN worlds in offline-mode per [[sei-lan-only-mvp]]). New table `trial_claims (mc_username text primary key, sei_user_id uuid not null, claimed_at timestamptz default now())`. No UPDATE/DELETE policies. INSERT only via Edge Function `trial-claim` with service_role using `ON CONFLICT (mc_username) DO NOTHING RETURNING`. If RETURNING is empty → already claimed. Trial credit grant = $1 (Tier-1 conservative). Bot-summon flow: user has signed in but ledger is empty → Sei main calls `POST /trial/claim {jwt, mc_username}` → on success, grant trial credits to ledger.
- **D-42a (threat model — offline-mode abuse):** A determined abuser can rename their MC launcher username between Sei accounts (`launcher → set username to X2 → make new Sei account → claim trial`). Documented as known limitation; raises abuse cost above $0 but not bulletproof. Mitigation deferred to Phase 14+ Microsoft OAuth flow if abuse becomes real.
- **D-42b (GUI/in-game username match):** Independent of trial gate, the bot summon enforces "Sei-registered MC username must appear in `bot.players` of the LAN world." If mismatch, bot exits with hardcoded message "Make sure your GUI username matches your in-game name." This is UX-quality, not anti-abuse.

### Cache Sharing + Pricing (Anthropic API Behavior)

- **D-43:** All Sei users route through one Anthropic API key. **Prompt caching is shared across users at the org level** — bundled-persona prompts (Sui/Lyra/Clawd) hit cache across all users, giving Sei massive savings on the common case. Custom personas cache per-user. **Cache savings flow back to the user's balance**, not to Sei's margin — pre-deduction is at 1.25× worst-case, actual cost computed from `usage.input/cache_creation/cache_read/output × respective rates`, refund delta back to ledger atomically.
- **D-44:** When Anthropic returns 429 (org-level rate limit exceeded), proxy responds to client with 503 `{error: 'service_at_capacity', retry_after_seconds: 30}`. Client surfaces "Sei is at capacity, try again in a moment" — graceful back-pressure, not silent retry. Proxy logs to Sentry/equivalent for alerting on tier-up needs.

### Lemon Squeezy Integration (PROXY-01, PROXY-02, PROXY-03)

- **D-45:** Two Lemon Squeezy products:
  - **"Sei Credits — $5 Pack"** (one-time, `variant_id_pack` env var). One-time payment grants ~$5 worth of micro-dollar credits (after Lemon Squeezy fee — LS takes ~5%, so ~$4.75 of usable credits).
  - **"Sei Unlimited — $20/month"** (recurring, `variant_id_subscription` env var). Monthly credit allocation; cancellable anytime.
  
  Checkout opened via `shell.openExternal('https://sei.lemonsqueezy.com/buy/<variant_id>?checkout[custom][user_id]=<jwt_sub>')`. The `user_id` custom field attributes the purchase in webhook payload.
- **D-46:** Webhook handling via Supabase Edge Function `lemon-webhook` deployed at a stable URL (`/functions/v1/lemon-webhook`). HMAC-verifies signature using `LEMON_SQUEEZY_WEBHOOK_SECRET` env var. Handles events: `order_created`, `subscription_created`, `subscription_updated`, `subscription_payment_success`, `subscription_cancelled`, `subscription_expired`. Idempotent via `lemon_event_id text unique` constraint on `ledger_grants`. Failed-to-attribute purchases (`custom.user_id` missing or invalid) → email alert to dmca@sei.app + Discord webhook for manual reconciliation.

### Ledger Shape (PROXY-09)

- **D-47:** **Two-table ledger** with micro-dollar precision:
  - `ledger_grants (id uuid pk, user_id uuid fk users, kind text check (kind in ('trial','pack','subscription')), credits_micro bigint not null, source text, lemon_event_id text unique, granted_at timestamptz default now(), expires_at timestamptz null)` — every grant is a row; FIFO drain.
  - `ledger_consumption (id uuid pk, user_id uuid fk users, micro bigint not null, anthropic_call_id text, reservation_state text check (reservation_state in ('reserved','settled','refunded')), deducted_at timestamptz default now())` — every deduction or refund is a row.
  - Materialized view `ledger_balance` per user, refreshed on insert via trigger.
  - All amounts in **micro-dollars** (`bigint`) — millionths of a dollar. Avoids float drift. $5 = 5_000_000 micro-dollars.
- **D-47a:** RLS: user can SELECT own rows in `ledger_grants` and `ledger_consumption`. INSERT/UPDATE/DELETE only via service_role (proxy + Edge Functions).

### Pre-Deduction + Rate Limits (PROXY-09)

- **D-50:** **Pre-deduct worst-case 1.25× reservation** BEFORE forwarding to Anthropic:
  - `reservation_micro = ceil((estimated_input_tokens × input_rate × 1.25) + (request.max_tokens × output_rate)) × 1_000_000`
  - Atomic SQL: `INSERT INTO ledger_consumption (user_id, micro, reservation_state) SELECT ?, ?, 'reserved' WHERE (SELECT balance_micro FROM ledger_balance WHERE user_id = ?) >= ?` — row-lock via FOR UPDATE on `ledger_balance`. If row count = 0 → 402 Payment Required.
  - After Anthropic response received: compute actual using `usage.input × 1.0 + usage.cache_creation × 1.25 + usage.cache_read × 0.10 + usage.output × output_rate` → micro-dollars.
  - UPDATE the reservation row to `reservation_state='settled', micro=actual_micro` → balance auto-refunds difference (reservation - actual). Refund = `reservation_micro - actual_micro`, always ≥ 0 because reservation was worst-case.
- **D-50a (input token estimation):** Use `@anthropic-ai/tokenizer` server-side to count input tokens before the request. Accuracy ~95% for English. Slight under-estimate is OK because the 1.25× multiplier absorbs error margin.
- **D-51:** **Per-user rate caps** enforced via `rate_buckets` table:
  - Columns: `(user_id, bucket_kind text check (kind in ('rpm','itpm','otpm','daily_dollar')), count bigint, window_start timestamptz)`. UPSERT incrementing `count` if `window_start` is still within the window, else reset.
  - **Sei is already on Anthropic Tier 2** (1K RPM / 450K input TPM cache-reads-excluded / 90K output TPM per model; no org-wide daily-$ cap). User-level caps below are user safety circuits, NOT tier-defense.
  - **Trial tier:** 20 RPM, 30K input TPM, $5/day from launch (no ramp needed — Tier 2 is already secured).
  - **Subscriber tier:** 60 RPM, 200K input TPM, $20/day. Activates when active subscription found in `subscription_status` table.
  - One-time pack users use trial tier until pack depleted, then subscription tier if they upgrade.
  - **Cache-read tokens do NOT count against `itpm` user cap** (matches Anthropic's tier accounting — bundled-persona cache hits effectively give users unbounded input throughput on the persona prefix).
  - `pg_cron` job nightly drops `rate_buckets` rows where `window_start < now() - 25h`.
- **D-52:** **429 response shape:** `{error: 'rate_limited', kind: 'rpm'|'itpm'|'otpm'|'daily_dollar', retry_after_seconds: <int>}`. Client renderer reads `retry_after_seconds` and renders an inline "rate-limited — try again in N seconds" banner with a countdown; chat-input is disabled for the duration. **NOT a modal** — the modal is reserved for actual credit depletion (D-56).

### Pricing UI + Hard-Stop (PROXY-04, PROXY-05, PROXY-06, PROXY-11)

- **D-54:** **Pricing icon** is a new icon button in the existing left vertical icon rail, positioned directly ABOVE the Settings icon (per PROXY-04 literal wording). Visual: a stylized credit/percentage glyph that fills based on `remaining_pct` (mirrors the % bar visually — a 75%-full ring icon or similar). Hover ≥200ms shows tooltip `{remaining_pct}% credits left · click for details`. Click opens `CreditsScreen`.
- **D-55:** **CreditsScreen content** — three blocks only:
  - (a) Big % bar (server-driven from `X-Sei-Remaining-Pct` via `useCreditsStore`) — no numbers ANYWHERE in the UI. PROXY-05 is enforced strictly: no token counts visible on this screen or anywhere else.
  - (b) "Top-up" tile (CTA → `shell.openExternal` $5 pack Lemon Squeezy URL with `user_id` custom param).
  - (c) "Unlimited" tile (CTA → $20/mo subscription URL; label flips to "Manage" + "Cancel" affordance when an active subscription is in `subscription_status`).
  - Plan name (e.g., "Trial" / "Pack" / "Unlimited"), and for subscribers, "Next renewal: <date>".
  - **NO dollar amounts. NO token counts. % only.**
- **D-56:** **Hard-stop modal** triggered when:
  - Proxy returns 402 Payment Required (ledger empty mid-request), OR
  - `X-Sei-Remaining-Pct: 0` arrives on an Anthropic response, OR
  - Client receives a non-recoverable balance-empty signal.
  
  Modal blocks bot interaction. Title: "You're out of credits". Body: persona-aware copy generated server-side (e.g., for Sui: "Sui's hungry for more conversation — top up to keep her chatting?"). Three CTAs: "Top up $5" (opens pack checkout) / "Go unlimited $20/mo" / link "Sign out → use your own API key instead". Modal cannot be dismissed without one of these actions or explicitly closing the bot.
- **D-57:** **BYOK bypass (PROXY-11):** The pricing icon, CreditsScreen, hard-stop modal, and all credit-related UI are conditionally rendered: only when the user's active backend is `cloud-proxy` (a new `backendKind` enum value). When `backendKind === 'local'` (user has BYO API key configured in `apiKeyStore`), these UI elements are entirely hidden — the user's bot routes directly to Anthropic with their own key, never hits the proxy. Settings screen still shows a "Switch to managed billing" CTA so BYOK users can opt into the cloud path.

### Refund Policy + Anthropic ToS Gate (PROXY-12, PROXY-13)

- **D-48:** **Refund policy** published in `../sei-website/terms.html §8 Refunds and Cancellations`:
  - **Credit packs:** Unused credits refundable within 14 days of purchase. Once consumed, no refunds.
  - **Subscriptions:** Cancellable anytime; access continues until end of paid period; no proration.
  - Refunds processed via Lemon Squeezy support email or dmca@sei.app inbox; manual for v1.0.
  - Re-bumps TOS_VERSION + PRIVACY_VERSION in `src/shared/legalVersions.ts` (triggers single AcceptToSModal cycle when 13 ships).
- **D-49:** **Anthropic ToS pre-launch checklist gate:** Final plan in Phase 13 is a `checkpoint:human-verify` operator runbook (12-18-style) requiring confirmation:
  - Lemon Squeezy product description uses framing "proxied AI inference credits powered by Sei" — NOT "Anthropic API access" or "Claude access" (avoids reseller-classification concerns).
  - Sei marketing copy on the Lemon Squeezy product page mentions "powered by Anthropic Claude" as attribution.
  - Anthropic API usage stays within Anthropic's commercial terms (no resale of raw API keys; we sell "Sei service" backed by API access).
  - Operator confirms via signing a paper checklist or Notion page; no autonomous gate.

### Claude's Discretion

- **Pricing icon visual design** — exact glyph + fill animation is at planner's discretion; should match the existing icon-rail aesthetic.
- **Persona-aware hard-stop copy generation** — server-side; planner decides whether to hardcode per-persona strings or template `${persona.name} is hungry for more conversation`.
- **Anthropic 429 backoff cooldown** — planner decides exact retry-after duration (30s suggested).
- **rate_buckets cleanup cadence** — `pg_cron` nightly is the default; planner can adjust if pg_cron is unavailable on the Supabase plan.
- **Tier-2 → Tier-3 monitor** — Sei is already on Tier 2 (1K RPM / 450K iTPM / 90K oTPM per model, cache-reads excluded). Tier 3 unlocks at ~$400 cumulative spend + 14 days. Planner adds a Sentry-equivalent alert on sustained Anthropic 429s so the operator knows when to push for Tier 3 upgrade.
- **Webhook idempotency window** — if a Lemon Squeezy webhook is retried after >7 days, the unique constraint still catches it but ledger insertion would be ancient. Planner decides whether to add a freshness check.
- **Cache write reservation precision** — 1.25× is the recommended worst-case. Planner can refine based on observed cache_creation ratios.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase 13 requirements & scope
- `.planning/REQUIREMENTS.md` §AI Proxy + Billing (PROXY-01..PROXY-13) — locked requirements text
- `.planning/ROADMAP.md` §Phase 13 — goal, dependencies, success criteria, two-sub-delivery rationale, Pitfall 2 (all four caps are launch gates)
- `.planning/PROJECT.md` — three-process Electron architecture; Lemon Squeezy as MoR; "no LLC for v1.0"

### Phase 10/11/12 carryover (mandatory)
- `.planning/phases/10-auth-foundation/10-CONTEXT.md` — Supabase JWT structure, RLS patterns
- `.planning/phases/11-cloud-character-library/11-CONTEXT.md` — D-26 (ToS acceptance), Edge Function patterns, sync queue pattern
- `.planning/phases/12-character-sharing-ui-moderation/12-CONTEXT.md` — D-35 (DMCA), D-37 description, Edge Function precedents, Database Webhook pattern (NOT pg_notify)
- `.planning/phases/12-character-sharing-ui-moderation/12-15-SUMMARY.md` — terms.html structure (Phase 13 adds §8 Refunds; preserves §7 DMCA anchor)

### External APIs / Hosting
- Fly.io: https://fly.io/docs/launch/launch-from-templates/
- Hono framework: https://hono.dev/
- Supabase JWT structure + JWKS: https://supabase.com/docs/guides/auth/jwts
- `jose` library: https://github.com/panva/jose
- Anthropic Messages API + prompt caching: https://docs.anthropic.com/en/api/messages
- Anthropic rate limits + tier system: https://docs.anthropic.com/en/api/rate-limits
- Lemon Squeezy API + webhooks: https://docs.lemonsqueezy.com/api/
- `@anthropic-ai/tokenizer`: https://github.com/anthropics/anthropic-tokenizer-typescript

### Sei-side surfaces touched
- `src/bot/anthropicClient.js` — gets `cloudMode: { baseURL, authToken }` parameter (Sub-delivery (a))
- `src/main/apiKeyStore.ts` — gets a new `backendKind: 'cloud-proxy'` value alongside `'local'`
- `src/main/auth/edgeFunctionClient.ts` — pattern for calling proxy endpoints
- `src/renderer/src/lib/ipcClient.ts` — IPC channel pattern

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets (from Phases 10-12)
- `src/main/auth/edgeFunctionClient.ts` — `callEdgeFunction` wrapper with timeout (15s) + AbortController; reuse for proxy calls
- `src/main/cloud/cloudCharacterClient.ts` — typed cloud client pattern; mirror for `proxyClient.ts`
- `supabase/functions/_shared/cors.ts` — CORS helper for Edge Functions
- `supabase/functions/delete-me/index.ts` — Edge Function precedent (auth verification + service_role)
- `supabase/functions/_shared/moderationProviders.ts` — pattern for typed external API wrappers (mirror for Lemon Squeezy)
- `src/renderer/src/components/Button.tsx` — shared button primitive
- `src/renderer/src/components/MigrateLocalCharsModal.tsx` — modal phase-machine pattern
- `src/renderer/src/lib/stores/useSyncStore.ts` — zustand store with subscription pattern (mirror for `useCreditsStore`)
- `src/renderer/src/lib/stores/useAuthStore.ts` — auth state + pendingIntent pattern

### Established Patterns
- Three-layer IPC contract: `src/shared/ipc.ts` → `src/main/ipc.ts` → `src/preload/index.ts`
- Zod validation at every IPC boundary
- All external calls wrapped with AbortController + timeout (CLAUDE.md invariant)
- Edge Functions follow CORS preflight + two-client pattern (anon-user + service_role)
- Modal pattern: `'loading' | 'idle' | 'submitting' | 'success' | 'error'` phase machine
- All cloud writes go through ToS gate via `isCloudWriteAllowed()` from Plan 11-14
- Lazy imports in IPC handlers to keep main process boot fast

### Integration Points
- `proxy/` (new directory at repo root) — entire Fly.io app lives here
- `src/bot/anthropicClient.js` — Sub-delivery (a) baseURL override
- `src/main/apiKeyStore.ts` — adds `backendKind: 'cloud-proxy'`
- `src/renderer/src/components/IconRail.tsx` (or equivalent) — pricing icon insertion above Settings
- `src/renderer/src/screens/SettingsScreen.tsx` — "Switch to managed billing" CTA for BYOK users
- `supabase/migrations/` — new migration for `ledger_grants`, `ledger_consumption`, `subscription_status`, `rate_buckets`, `trial_claims`
- `supabase/functions/` — three new Edge Functions: `lemon-webhook`, `trial-claim`, `usage-export` (optional)
- `../sei-website/terms.html` — §8 Refunds and Cancellations
- `src/shared/legalVersions.ts` — TOS_VERSION + PRIVACY_VERSION re-bump

</code_context>

<specifics>
## Specific Ideas

- Trial credits = $1 (5000 micro-dollar units) — small enough to not break Tier-1 budget, large enough to feel meaningful.
- Pricing icon glyph: a stylized "C" or wallet shape that fills bottom-up based on `remaining_pct`. Planner can pick.
- Hard-stop modal copy templates (per bundled persona):
  - Sui: "Sui's hungry for more conversation — top up to keep going?"
  - Lyra: "Lyra would love to keep chatting — top up?"
  - Clawd: "Clawd needs more tokens to keep being chaotic — top up?"
  - Custom persona: `${persona.name} needs more credits to keep talking.`
- Settings "Switch to managed billing" CTA copy: "Use Sei's managed cloud — purchase credits, get usage dashboards, no API key required."

</specifics>

<deferred>
## Deferred Ideas

- Microsoft OAuth identity binding for stronger trial gate (re-evaluate if abuse observed)
- Hosting re-evaluation after MVP traffic data (Fly.io vs Hetzner VPS vs Cloudflare Workers)
- Multi-provider abstraction (Phase 14)
- Per-tier discount pricing / annual subscriptions (v1.x)
- Usage history charts, monthly statements (v1.x)
- Team / family billing accounts (v1.x)
- Refund self-service portal (v1.0 = manual)
- Discord/community billing perks (v1.x)
- Crypto / BTC payments (probably never)
- Per-region pricing
- Per-model pricing tiers (v1.x — when Phase 14 lands multi-provider)
- Public usage transparency report
- Affiliate / referral credits

</deferred>
