# Stack Research — Sei v1.0 Commercializable MVP (additions to v0.1.1 baseline)

**Domain:** Electron desktop AI companion with cloud accounts, sharing, multi-provider LLM proxy, paid credits, vision capture, and mod ingestion
**Researched:** 2026-05-19
**Confidence:** HIGH on most areas (Supabase, Vercel AI SDK, Lemon Squeezy, mineflayer/Modrinth ecosystem); MEDIUM on player-POV screenshot architecture (no single battle-tested OSS reference for the "headless bot wants the human's POV" pattern — a small custom Fabric mod is the path).

**Scope discipline:** This file only documents stack ADDITIONS for v1.0. Existing stack (Electron three-process, mineflayer + plugins, `@anthropic-ai/sdk`, Zod, React 19, electron-vite/builder, signed/notarized .dmg/.exe) carries over from v0.1.1 unchanged — see the previous STACK.md sections preserved in git history. Where a v1.0 addition supersedes or wraps a v0.1.1 dependency, that's called out explicitly.

---

## Decision Summary (TL;DR for the roadmapper)

| Feature | Recommendation | One-line rationale |
|---|---|---|
| Cloud DB + auth + storage | **Supabase** (Postgres + Auth + Storage in one) | One free tier covers all three needs; 50k MAU auth fits a free-tier-first launch; works from an Electron client with anon-key + RLS |
| Auth in Electron | **Supabase Auth via PKCE loopback** (open external browser, capture on `http://127.0.0.1:<port>/callback`) | The only reliable Google-OAuth-in-Electron flow; works with email/password natively; avoids embedded webviews |
| Image/skin storage | **Supabase Storage** bucket (S3-compatible) | Already on Supabase; 1 GB free fits character images comfortably; signed URLs for share links |
| Payments (one-time + sub) without business entity | **Lemon Squeezy** (Merchant of Record) | Accepts individual sellers (no LLC required), files VAT/sales tax globally on your behalf, supports one-time + subscription on the same product, license-key issuance built-in for activating proxy credits |
| AI proxy gateway | **Custom thin Node proxy on Vercel/Fly/Railway** that wraps **LiteLLM-style provider routing** and re-uses **Vercel AI SDK** server-side | Total control over usage metering, license-key gating, and which providers consume the dev's personal Anthropic key; off-the-shelf gateways (Helicone, Portkey) bake in pricing/policy assumptions you don't want for a $5/$20 personal-key model |
| Multi-provider client (in app) | **Vercel AI SDK v6** with `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`, `@ai-sdk/xai`, `@openrouter/ai-sdk-provider`, `ollama-ai-provider` | Single abstraction; supports `providerOptions.anthropic.cacheControl` and per-provider caching flags; standardizes tool-use across all six providers |
| Prompt caching | Anthropic: `cache_control: ephemeral` breakpoints on system + persona; OpenAI/Gemini-implicit/xAI: stable prefix order (auto-cached); Gemini explicit: `CachedContent` for the persona block | Anthropic and explicit-Gemini need code; OpenAI/Grok/DeepSeek/implicit-Gemini cache automatically when prefix is stable |
| Player-POV screenshots | **Custom thin Fabric client mod** that opens a local WebSocket on `127.0.0.1:<port>` and serves PNG frames on request; Sei discovers + handshakes; **fallback** to OS-window capture (`screenshot-desktop` already in v0.1.1 stack) when mod not installed | Only way to actually get the human's POV; ReplayMod/Fabrishot don't expose a programmatic stream; the existing v0.1.1 Fabric auto-install wizard already established the "we install Fabric mods for the user" pattern |
| Mod ingestion | `adm-zip` for `.jar` extraction + `fabric.mod.json` / `META-INF/mods.toml` parsing, **Modrinth REST API** for canonical mod metadata, **`minecraft-data`** for vanilla baseline, optional Forge/Fabric registry dumps via a one-shot data-generator mod | No clean runtime API for "list all modded items" exists outside the running JVM — pipeline parses metadata + scrapes Modrinth + diffs against `minecraft-data` baseline, then asks Haiku to emit Zod actions |

---

## 1. Cloud Database, Auth, and Storage — Supabase

### Recommendation: Supabase (managed Postgres + Auth + Storage + Realtime)

| Component | Version | Free-tier limit (2026) | Used For |
|---|---|---|---|
| `@supabase/supabase-js` | `^2.105.x` (Node ≥20 required, already met) | — | DB queries, auth, storage from Electron client |
| Supabase project (hosted) | — | 500 MB Postgres, 1 GB file storage, 5 GB egress, **50,000 MAU** auth, 2 active projects, pauses after 1 week idle | Character library + accounts + shared images |

**Why Supabase beats the alternatives for this exact use case:**

| Alternative | Why not |
|---|---|
| **Firebase** | Auth in Electron requires the [custom-token dance](https://medium.com/@mirceagab/setting-up-firebase-authentication-in-an-electron-app-react-typescript-tailwind-electron-forge-92f1f424ebfa) (`signInWithPopup`/`signInWithRedirect` don't work — you have to roll a Cloud Function that mints custom tokens after browser-based Google auth, then sign in via `signInWithCustomToken()`). Doable but adds a server hop. Firestore document model is also less natural for a search/browse character list than relational Postgres. |
| **Neon** | Postgres-only — no auth, no storage. You'd bolt Auth.js + S3 onto it, which is more moving parts. Free tier is also smaller (0.5 GB per project, scale-to-zero cold starts 1–3s) and you get only the DB. |
| **Turso/libSQL** | Edge SQLite + embedded replicas is genuinely tempting for an Electron app (local-first reads). But: no managed auth, no managed storage, and the character library is a SHARED read/write workload, not a per-user replica use case. Defer Turso for the per-user OWNER.md/DIARY.md mirror if/when sync becomes a v1.1 ask. |
| **PocketBase** | Self-hosted single Go binary — beautiful for a hobbyist, but you don't want to operate a server for a free-tier launch, and the dev is explicitly hosting the AI proxy themselves already; doubling the ops surface is the wrong trade. |
| **Firebase + Clerk** | Two products, two bills, two SDKs. Supabase Auth is "good enough" for email+Google and stays in the same project as the DB. |

**Confidence:** HIGH. Supabase free tier specs verified against [supabase.com/pricing](https://supabase.com/pricing) and multiple 2026 third-party reviews.

### Schema sketch (for the requirements step downstream)

```sql
-- characters: the shared, browsable library
create table characters (
  id uuid primary key default gen_random_uuid(),
  owner uuid references auth.users(id) on delete set null,
  name text not null,
  description text not null,    -- short blurb shown in cards
  prompt text not null,         -- expanded persona prompt
  skin_url text,                -- supabase storage signed URL
  avatar_url text,              -- generated/uploaded image
  created_at timestamptz default now(),
  shared boolean default false, -- visible in Browse?
  fork_of uuid references characters(id)
);
create index on characters (shared, created_at desc);
create index on characters using gin (to_tsvector('english', name || ' ' || description));

-- account-credit ledger driven by Lemon Squeezy webhooks
create table credit_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id),
  source text check (source in ('one_time_5', 'subscription_20', 'manual')),
  granted_at timestamptz default now(),
  expires_at timestamptz,
  cents_remaining integer not null
);
```

RLS: `characters` readable when `shared = true OR owner = auth.uid()`; writable only by owner. `credit_grants` server-side only — Electron client never reads/writes directly, must go through the proxy.

---

## 2. Auth Flow in Electron — Supabase + Loopback PKCE

### Recommendation: PKCE flow opened in the **system browser**, with a one-shot loopback HTTP server in the Electron main process catching the callback.

**Pattern:**
1. Electron main spawns a localhost listener on a random port (e.g., `http://127.0.0.1:54312/callback`).
2. Calls `supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: 'http://127.0.0.1:54312/callback', skipBrowserRedirect: true } })`, then `shell.openExternal(authUrl)`.
3. Google → Supabase → 302 to loopback with `?code=...`.
4. Main exchanges the code via `supabase.auth.exchangeCodeForSession(code)` and persists session in Electron's `safeStorage`-encrypted file (not `localStorage` — utilityProcess can't reach it).
5. Pushes the session into the renderer + utilityProcess via the existing IPC layer.

**Why loopback, not custom URL scheme (`sei://`):**
- Cross-platform with no protocol-handler installer step
- Google's [OAuth-for-native-apps guide](https://developers.google.com/identity/protocols/oauth2/native-app) explicitly endorses loopback + PKCE
- Custom schemes have OS-level conflicts (Linux especially) and require platform-specific Electron handlers

**Email/password:** works out of the box via `supabase.auth.signInWithPassword()` — no special Electron handling needed.

| Library | Version | Purpose |
|---|---|---|
| `@supabase/supabase-js` | `^2.105.x` | client (already listed) |
| (built-in Node `http`) | — | loopback callback server (don't add Express; keep it 20 lines) |

**Not recommended:**
- **`@clerk/*`** — no first-party Electron SDK; the closest is `@clerk/clerk-sdk-node` server-only, which contradicts a client-direct architecture. Two community Medium posts but no official path; budget risk.
- **Auth.js (NextAuth)** — designed around HTTP server middleware; awkward without a Next/Node backend you're forced to deploy. Use it only if you already have a backend to host it (we don't, beyond the AI proxy).
- **Firebase Auth** — covered above; the custom-token detour adds a Cloud Function dependency.
- **`electron-oauth-helper`** — works, but conflates the OAuth dance with Electron BrowserWindow plumbing; for Supabase, you only need the PKCE callback to land — Supabase's own client handles token exchange.

**Confidence:** HIGH for the pattern (Google docs + multiple Supabase community discussions confirm); MEDIUM on smooth implementation — Supabase has documented edge cases around `getSession()` returning 401 after deep-link auth in Electron (see [discussion #17722](https://github.com/orgs/supabase/discussions/17722) and [#27181](https://github.com/orgs/supabase/discussions/27181)). Plan a dedicated half-day spike.

---

## 3. Payments — Lemon Squeezy (Merchant of Record)

### Recommendation: **Lemon Squeezy** as Merchant of Record. Single product with TWO price options: one-time $5 and recurring $20/month.

**The "no business entity" constraint is the single biggest stack decision in v1.0.** It rules out DIY Stripe in any serious form.

### Why Lemon Squeezy beats every alternative *for this specific constraint*:

| Option | Verdict | Reasoning |
|---|---|---|
| **Lemon Squeezy** (chosen) | YES | Accepts individual sellers without an LLC. Acts as MoR — they handle sales tax/VAT in every jurisdiction. Built-in license-key issuance per purchase is the perfect activation token for the proxy. Checkout overlay works inside an Electron BrowserWindow or `shell.openExternal` to hosted checkout. 5% + $0.50 fee. |
| **Polar.sh** | Backup | Open-source MoR, 4% + $0.40 headline (closer to 6% all-in for international subs). Younger; February 2026 reports of support delays and slow feature shipping. Pick if Lemon Squeezy goes sideways, or for the OSS optics. |
| **Paddle** | No | Also MoR, also good, but the underwriting bar is meaningfully higher than Lemon Squeezy — they vet revenue trajectory and won't onboard a $0-revenue solo dev quickly. |
| **Stripe (personal/sole-proprietor)** | Defer | Stripe DOES accept US sole proprietors with SSN/ITIN. But the dev becomes the merchant of record — **you** owe sales tax in every state you sell to ($100k/200tx Wayfair thresholds vary), VAT in the EU, GST in AU/IN, etc. For a side project with no entity, this is a compliance landmine. Revisit AFTER incorporating. |
| **Stripe Atlas** | Defer | Atlas is an incorporation service. If/when the project hits product-market fit, Atlas → Delaware C-Corp → direct Stripe is the long-term endgame. But it's a $500 fee + ongoing franchise tax to remove a problem Lemon Squeezy already removes for 5%. Not worth doing pre-revenue. |
| **Gumroad** | No | Used to be the indie-friendly MoR. Recent platform direction (community/AI features, fee changes) has been disruptive. Lemon Squeezy is the spiritual successor for this niche. |

**License-key flow (the actual implementation pattern):**

1. User clicks "Buy proxy credits" → Electron opens Lemon Squeezy checkout overlay (their JS SDK works in Electron renderer with `frame: false` BrowserWindow, OR redirect to hosted checkout via `shell.openExternal`).
2. Lemon Squeezy → webhook (`order_created`, `subscription_payment_success`) → your AI proxy backend.
3. Webhook handler inserts a row into Supabase `credit_grants` keyed to the user's Supabase `auth.users.id` (matched via metadata you pass to the checkout URL: `?checkout[custom][supabase_user_id]=<uuid>`).
4. Electron app, on next proxy call, sends the Supabase JWT; proxy decodes, looks up credit balance, allows/denies.

**License keys themselves are optional here** — you can use Lemon Squeezy's license-key product just to get a verifiable activation token if you don't want to require Supabase login for paying customers. But since cloud features ALREADY require Supabase auth, the webhook → ledger pattern is simpler than juggling license keys.

| Library | Version | Purpose |
|---|---|---|
| Lemon Squeezy JS API client (`@lemonsqueezy/lemonsqueezy.js`) | `^4.x` (latest 2026) | Server-side: webhook signature verify, fetch order info |
| (built-in Node `crypto`) | — | Verify webhook HMAC signature |

**Confidence:** HIGH. Confirmed via [Lemon Squeezy docs](https://docs.lemonsqueezy.com/help/checkout/checkout-overlay), the 2026 update [blog post](https://www.lemonsqueezy.com/blog/2026-update), and multiple comparison reviews.

### Critical compliance note for the roadmap
The product description in Lemon Squeezy must accurately state that purchases buy **proxied AI inference credits**, not "an Anthropic subscription." Routing through a personal Anthropic key for paying users is fine commercially (it's your relationship to a vendor like AWS), but mis-describing it as reselling Claude could trigger Anthropic ToS issues. The roadmap should flag this for a one-time legal/ToS check.

---

## 4. AI Proxy Gateway — Custom Thin Node Proxy

### Recommendation: Build a small custom Node proxy (Hono or Fastify, deployed on Fly.io / Railway / Vercel Functions), NOT an off-the-shelf gateway.

**Why custom beats Helicone/Portkey/LiteLLM-hosted for this use case:**

The Sei proxy has one weird requirement: it routes paying users' inference to the dev's **personal** Anthropic key with a **credit ledger and percentage-based usage UX** ($5 = some % of monthly cap, $20/mo = different %). Off-the-shelf gateways assume the customer brings their own key OR pays for inference at marked-up rates set by the gateway. None of them model "I (the dev) own the upstream key and want to ration it across my users."

| Option | Verdict | Reason |
|---|---|---|
| **Custom thin Node proxy** (chosen) | YES | ~300 lines; full control over JWT verification (Supabase), credit decrement, Anthropic key rotation, and the "% bar" UX |
| **LiteLLM** (self-hosted Python) | Backup option for the routing layer | If multi-provider routing inside the proxy becomes hairy, run LiteLLM as the upstream and call it from your thin Node JWT/credit-check layer. LiteLLM has explicit prompt caching support across Anthropic/OpenAI/Gemini/Vertex/Bedrock/DeepSeek (auto-injection of `cache_control` even for providers that don't natively use that schema). Adds Python runtime to your ops. |
| **OpenRouter as the upstream** | NO for paid tier | Tempting because they unify caching and 100+ models — but you'd be paying OpenRouter's markup AND eating Anthropic costs out of the $5/$20. The point of routing to your personal key is the unmarked-up Anthropic rate. OpenRouter is the right answer for the **user-BYOK** path (see §5). |
| **Helicone** | NO | Built for observability + cost tracking when you bring your own key. Their caching is L1 (in-memory) over your key. Doesn't model the credit-ledger UX you need. |
| **Portkey** | NO | Enterprise-priced ($2k–10k/mo), overkill. Semantic caching is cute but not relevant to Sei's tool-use workload (deterministic system prompts). |

### Proxy implementation skeleton

| Library | Version | Purpose |
|---|---|---|
| `hono` | `^4.x` | Tiny web framework, runs on Node/Vercel/Cloudflare/Fly equally well |
| `@supabase/supabase-js` | `^2.105.x` | Decode JWT, query `credit_grants` |
| `@anthropic-ai/sdk` | `^0.91.x` (already in v0.1.1) | Server-side calls to Anthropic with personal key |
| `litellm` (Python) | latest | OPTIONAL fallback for routing if upstream-provider sprawl gets messy |

**Caching strategy in the proxy:**
- The proxy is just a pass-through to Anthropic for paid users. It **must forward** the `anthropic-beta: prompt-caching-2024-07-31` header and the `cache_control` blocks the client sends. Don't strip them.
- Cache benefit accrues to YOU (the upstream key) — 90% input-token savings on the persona system prompt × every user × every turn. This is what makes $20/mo arithmetic work.

**Confidence:** HIGH on the architecture. MEDIUM on the deployment platform — Fly.io is the safest choice (always-on, predictable cost), Vercel Functions are tempting for free-tier but the 60s timeout limit could bite long streaming responses.

---

## 5. Multi-Provider LLM Abstraction — Vercel AI SDK v6

### Recommendation: **Vercel AI SDK v6** as the single in-app abstraction across all providers (Anthropic, OpenAI, Gemini, Grok, OpenRouter, Ollama/OpenAI-compatible).

This is a planned shift FROM v0.1.1's direct `@anthropic-ai/sdk` usage. The justification: v0.1.1 had one provider; v1.0 has six, with different tool-call schemas, different caching APIs, and different streaming formats. Reimplementing six adapters costs more than adopting the SDK.

### Stack

| Library | Version (latest 2026) | Purpose |
|---|---|---|
| `ai` | `^6.x` (v6, the current 2026 line) | Core SDK — `generateText`, `streamText`, `generateObject`, tool-use |
| `@ai-sdk/anthropic` | `^3.0.78` | Anthropic provider (Claude family) |
| `@ai-sdk/openai` | `^3.x` | OpenAI provider (GPT-4o, GPT-5, GPT-5.1) |
| `@ai-sdk/google` | `^3.x` | Gemini provider |
| `@ai-sdk/xai` | `^3.x` | Grok |
| `@openrouter/ai-sdk-provider` | `^1.x` | OpenRouter (community provider, official from OpenRouter team) |
| `ollama-ai-provider-v2` | `^1.x` | Local OpenAI-compatible (Ollama, LM Studio, llama.cpp server) |
| `zod` | `^3.22.x` (already in v0.1.1) | Tool-use schema validation (still works perfectly with AI SDK) |

### Why Vercel AI SDK beats the alternatives

| Alternative | Why not |
|---|---|
| Direct SDKs per provider (current v0.1.1 approach) | Six different tool-use schemas, six different streaming protocols. Burns weeks on adapter code. |
| **LangChain.js** | Too heavyweight, opaque, slower release cycle. The v0.1.1 STACK already explicitly rejected it. |
| Custom OpenAI-compatible-only abstraction | Forces Anthropic's tool schema to be lossy-translated to ChatCompletions; you lose Anthropic prompt caching markers. |
| **LiteLLM JS port** | Doesn't exist as a first-class JS library — LiteLLM is Python. |

### Per-provider prompt caching — explicit API surfaces

This is THE detail the quality gate asks for. Each provider has a different mechanism; Vercel AI SDK normalizes the *trigger* but caching still happens upstream.

| Provider | Mechanism | How you express it through AI SDK v6 |
|---|---|---|
| **Anthropic** | Explicit `cache_control: { type: 'ephemeral' }` breakpoints. 5-min default TTL, 1-hour beta (`anthropic-beta: extended-cache-ttl-2025-04-11`). Minimum 1024 tokens. | `providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } }` on the message/part you want as the cache boundary. Returns `cache_creation_input_tokens` + `cache_read_input_tokens` in `providerMetadata.anthropic`. |
| **OpenAI** | **Fully automatic.** Prompts ≥1024 tokens are auto-cached by prefix hash; first 256 tokens of prefix routed to a sticky machine; GPT-5.1 + GPT-4.1 get 24h retention, others 5–10 min. No header needed. | Just keep the system prompt prefix byte-stable across calls. Optionally pass `prompt_cache_key` via `providerOptions.openai` to improve hit rate when prefixes diverge later. |
| **Gemini** | TWO mechanisms: (a) **implicit** auto-caching, like OpenAI, on Gemini 2.5+ — 75% discount on 2.0, 90% on 2.5; (b) **explicit `CachedContent`** — you POST the persona prompt to `cachedContents.create`, get a resource name, reference it in subsequent generation calls. TTL default 60 min, configurable. | Implicit: just keep prefix stable. Explicit: not yet first-class in AI SDK v6 — use `@google/generative-ai` direct call to `createCachedContent`, then pass `cachedContent: name` via `providerOptions.google`. |
| **Grok (xAI)** | Implicit prefix caching, OpenAI-compatible API. | Stable prefix, nothing else to do. |
| **OpenRouter** | Forwards `cache_control` to Anthropic family; auto-handles implicit for OpenAI/DeepSeek/Gemini 2.5; uses **provider-sticky routing** to maximize hit rate when a request would otherwise be load-balanced. | Same `providerOptions.anthropic.cacheControl` works through the OpenRouter provider. |
| **Ollama / OpenAI-compatible local** | Depends on the runtime. llama.cpp's HTTP server has prompt-cache reuse if `cache_prompt: true`. Ollama has internal KV-cache reuse but no user-facing knob. | No SDK-level concept; just stable prefix. |

### Caching strategy for Sei's prompts specifically

The persona system prompt + memory context (~3k–8k tokens) is the highest-value cache target — it changes only when memory compacts. Action-registry tool schemas (~2k tokens) also stable.

```ts
// Pseudo-code for the message construction
const messages = [
  { role: 'system', content: PERSONA_PROMPT + "\n" + OWNER_MD + "\n" + DIARY_MD,
    providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } },
  { role: 'system', content: TOOL_REGISTRY_DESCRIPTIONS,
    providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } },
  { role: 'user', content: currentGameEventDigest }
];
```

Two cache breakpoints (Anthropic allows up to 4). For OpenAI/Gemini/Grok the same byte-stable ordering yields automatic prefix caching for free.

**Confidence:** HIGH for SDK + provider list (verified against [ai-sdk.dev](https://ai-sdk.dev/providers/ai-sdk-providers/anthropic), npm version data, OpenAI/Anthropic/Gemini official caching docs). MEDIUM for Gemini explicit `CachedContent` integration with AI SDK — may need a direct `@google/generative-ai` call to create the cache, then reference by name.

---

## 6. Player-POV Screenshot Capture — Custom Fabric Mod + Fallback

This is the hardest stack decision because there is NO existing battle-tested library for "headless mineflayer bot wants the human player's client screen." The bot has no access to the human's GPU/renderer. Options surveyed:

| Option | Verdict | Why |
|---|---|---|
| **Custom thin Fabric mod, local WebSocket bridge** (PRIMARY) | YES | The human is already running a Fabric client (v0.1.1's auto-install wizard guarantees this for the launch path). Add one more tiny Fabric mod that opens a localhost WebSocket and returns PNG frames on `{type: "screenshot"}`. Bot's utilityProcess connects to `ws://127.0.0.1:<port>`. Authoritative reference: [Jeroen-45/screenshot-bot](https://github.com/Jeroen-45/screenshot-bot) — Fabric mod that exposes exactly this pattern (socket server + screenshot + chat commands). MIT-licensed, ~400 lines of Kotlin/Java. Either fork it or use its design as a template. |
| **OS desktop screen capture** (FALLBACK — already in v0.1.1) | YES as fallback | `screenshot-desktop` already in v0.1.1 toolbox. Works without any mod. Captures whatever's on the user's primary monitor. Use when the Sei Fabric mod isn't detected (e.g., user is on a non-Fabric instance for v1.x). Limitations: captures whole desktop or requires window-title heuristics; needs macOS Screen Recording permission. |
| **ReplayMod / Mineshot / Fabrishot** | NO | These are interactive screenshot mods for humans triggering captures via keybind. No programmatic streaming output. Would require modifying them. |
| **Mineflayer + prismarine-viewer renderer** | NO | This is the BOT'S server-side world view, not the human player's POV. Wrong camera. Considered and discarded — the user's request explicitly says player-POV. |
| **Spectator mode bot piloting** | NO | Server-side reconstruction; doesn't match what the human sees (no resource pack rendering, no GUI). |

### Stack additions

| Component | Version | Purpose |
|---|---|---|
| Custom Fabric mod ("Sei Bridge") | New (≈400 LOC Java/Kotlin, Fabric Loader 0.15+, MC 1.20.x–1.21.x) | Localhost WebSocket server inside the user's MC client; responds to screenshot requests by capturing `MinecraftClient.getInstance()` framebuffer, encoding PNG, and sending bytes |
| `ws` (npm) | `^8.x` | WebSocket client in the utilityProcess to talk to the mod |
| (existing `screenshot-desktop` from v0.1.1) | `^1.15.3` | Fallback path |

### Mod design notes (for the implementing phase)

- **Discovery handshake:** Sei probes `ws://127.0.0.1:25599` (or a range) on bot startup. If the mod isn't running, fall back silently.
- **Auth:** the mod accepts ONLY localhost connections. Optional shared secret in `~/.minecraft/config/sei-bridge.json` written by the auto-install wizard so the bot can prove identity even if multiple WS-using mods are present.
- **Gating** (16-block radius + line-of-sight) is enforced on the Sei side using mineflayer's world view, NOT in the mod — the mod is dumb and just answers requests.
- **Distribution:** publish the mod to Modrinth so it survives if Sei pivots, and so users can verify the open source.

**Confidence:** MEDIUM-HIGH. The pattern is proven by Jeroen-45/screenshot-bot. Risk is in MC-version churn — Fabric mappings change every MC release, mod will need a refresh per MC line. Budget for that in the roadmap.

---

## 7. Mod Ingestion Pipeline — adm-zip + Modrinth API + minecraft-data baseline

The goal: given a folder of `.jar` mods, automatically diff them against vanilla and emit (a) a human-readable summary the personality LLM can reference and (b) new Zod action skills the bot can call.

**There is no clean off-the-shelf "list all items added by all mods" library.** You build a pipeline from three components:

| Component | Version | Role |
|---|---|---|
| `adm-zip` | `^0.5.x` | Read `.jar` archives (they're zips) and extract `fabric.mod.json`, `META-INF/mods.toml` (Forge/NeoForge), and `assets/<modid>/lang/en_us.json` (item display names) |
| Modrinth REST API | v3, public | Canonical mod metadata: name, description, mod loader, MC version compatibility, dependencies. Look up by hash of the .jar file. Free, no auth required. |
| CurseForge API | v1, requires API key | Same purpose as Modrinth but for mods NOT on Modrinth. Many older mods are CF-only. Get a free API key from console.curseforge.com. |
| `minecraft-data` | `^3.x` (already a transitive dep of mineflayer) | Vanilla baseline. Includes per-version item/block lists for diffing — "everything in the modded item registry that ISN'T in `minecraft-data.items` is a modded item." |
| (Optional) **Probe mod** running once in the user's MC client | Custom, similar to the Sei Bridge above | The MOST reliable item-list source: a tiny Fabric mod that, on first launch with mods installed, dumps `Registries.ITEM.getKeys()` to `~/.minecraft/sei-mods-dump.json`. Solves the "what items did this modpack ACTUALLY register" problem that static .jar parsing can miss (e.g., items added by KubeJS or other data-driven mods). |
| Haiku (existing) | — | The LLM "adapter ingestion" step: given the diff + lang strings + Modrinth descriptions, emit (1) summary markdown for memory and (2) new Zod action definitions for the registry |

### Pipeline shape

```
1. scan ~/.minecraft/mods/  → list of .jar paths
2. for each .jar:
     a. extract fabric.mod.json / mods.toml → modid, name, version, MC compat
     b. extract lang/en_us.json → item_id → display_name mapping
     c. hash .jar (SHA-1) → POST to Modrinth /version_file/{hash} → canonical metadata
     d. fallback: same with CurseForge fingerprint API
3. (optional) trigger probe mod once → reads sei-mods-dump.json
4. diff observed modded items vs minecraft-data baseline for the target MC version
5. bundle (mod list + new items + new blocks + lang strings) → send to Haiku with
   a "generate adapter" prompt → receive (summary.md, new_actions.ts)
6. validate generated Zod schemas parse → register into closed action registry
7. write outputs to .planning/adapters/<modpack-hash>/ for caching
```

### Stack additions

| Library | Version | Purpose |
|---|---|---|
| `adm-zip` | `^0.5.x` | Read .jar contents |
| `node-fetch` or built-in `fetch` (Node 20+) | — | Modrinth/CurseForge calls |
| (existing `zod`, existing `@anthropic-ai/sdk`) | — | Adapter generation |

**Not recommended:**
- Running Java/JVM in the Electron app to introspect mod registries directly — too heavy, defeats the bundle-size goal.
- Forge/NeoForge tooling like ForgeGradle — only useful at mod-dev time, not at runtime introspection.
- Trying to parse Java bytecode for `Registry.register(...)` calls — possible (`javap`-style libs exist) but fragile; many mods use reflection or data-pack-driven registration.

**Why this pipeline beats "ask the LLM to read the mod page":** the lang files give you the exact in-game display names the user sees. Modrinth/CF descriptions give you intent ("this mod adds 50 new copper tools"). Combining both lets the personality LLM say "I notice you have Create installed — want me to help you set up a rotational power network?" with correct item names.

**Confidence:** MEDIUM. Pipeline shape is sound but the LLM-generated Zod action quality is unproven. Roadmap should bake in a human-review step before generated actions go live.

---

## Full v1.0 Dependency Additions (`package.json` deltas)

```bash
# Cloud / auth / storage
npm install @supabase/supabase-js

# Payments — only used server-side in the proxy, NOT in the Electron app
# (renderer opens checkout URL via shell.openExternal)
# (no client dep needed unless using the JS checkout overlay programmatically)

# Multi-provider LLM abstraction
npm install ai \
            @ai-sdk/anthropic \
            @ai-sdk/openai \
            @ai-sdk/google \
            @ai-sdk/xai \
            @openrouter/ai-sdk-provider \
            ollama-ai-provider-v2

# Player-POV WebSocket client
npm install ws

# Mod ingestion
npm install adm-zip

# AI proxy backend (separate deploy — not in the Electron app's package.json)
# In the proxy repo:
#   npm install hono @supabase/supabase-js @anthropic-ai/sdk @lemonsqueezy/lemonsqueezy.js
```

### Removed / superseded
- The direct `@anthropic-ai/sdk` import in the Electron utilityProcess is REPLACED by `ai` + `@ai-sdk/anthropic` for in-app calls. The proxy backend still uses `@anthropic-ai/sdk` directly (server-side, where the SDK's lower-level cache header control is preferable).

### Notably NOT added
- Stripe SDK — payments go through Lemon Squeezy
- Firebase — Supabase wins for this stack
- LangChain.js — Vercel AI SDK already covers orchestration
- Clerk / Auth.js — Supabase Auth covers it
- Helicone / Portkey — custom proxy covers it
- node-llama-cpp — already rejected in v0.1.1; Ollama path covers local
- Tauri — already rejected in v0.1.1

---

## Stack-Level Risks to Flag for the Roadmap

1. **Supabase OAuth in Electron — half-day spike.** PKCE-loopback works but there are documented edge cases (`getSession()` 401, refresh token handling). De-risk early before building any UI on top.
2. **Lemon Squeezy product framing.** The product description MUST accurately convey "AI inference credits proxied to the developer's API account," not "Claude subscription." One-time legal/ToS check before launching paid tier.
3. **AI proxy deployment cost & cold starts.** Vercel Functions free tier has a 60s timeout — fine for non-streaming, dangerous for long tool-use chains. Fly.io always-on micro VM is the safer default (~$3/mo).
4. **Vercel AI SDK + Anthropic cache_control round-trip.** Open AI SDK issue #5883 has historical reports of cacheControl options being dropped. Verify with a curl trace on first integration.
5. **Sei Bridge Fabric mod per-MC-version maintenance.** Mappings change. Budget ~1 day per MC release line going forward.
6. **Mod ingestion LLM accuracy.** Generated Zod actions may have wrong namespaces or hallucinate item IDs. Required: schema-validation gate + manual approval UI before they enter the registry.
7. **Gemini explicit CachedContent integration with AI SDK v6 is fresh.** May need a direct `@google/generative-ai` call for the cache-create step. Verify with a docs-fetch when implementing.
8. **Supabase free-tier project pause-after-1-week-idle.** Won't affect production once you have users, but local dev can hit it; document a "ping" script for the team.

---

## Sources

### Cloud DB / Auth / Storage
- [@supabase/supabase-js on npm](https://www.npmjs.com/package/@supabase/supabase-js) — version 2.105.x
- [Supabase Pricing](https://supabase.com/pricing) — free tier specs
- [Supabase Free Tier 2026 — Cotera](https://cotera.co/articles/supabase-pricing-guide)
- [Supabase Auth — Login with Google](https://supabase.com/docs/guides/auth/social-login/auth-google)
- [Supabase OAuth-in-Electron discussion #17722](https://github.com/orgs/supabase/discussions/17722)
- [Supabase OAuth-in-Electron discussion #27181](https://github.com/orgs/supabase/discussions/27181)
- [Google OAuth for iOS & Desktop Apps](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Firebase Auth in Electron tips](https://medium.com/firebase-developers/using-firebase-in-electron-tips-and-tricks-24ac5b44bf5a) — for the "why not Firebase" justification
- [Turso libSQL docs](https://docs.turso.tech/libsql) — alternative considered
- [Neon vs Turso for Solo Developers](https://solodevstack.com/blog/neon-vs-turso-solo-developers)

### Payments
- [Lemon Squeezy 2026 update](https://www.lemonsqueezy.com/blog/2026-update)
- [Lemon Squeezy Checkout Overlay docs](https://docs.lemonsqueezy.com/help/checkout/checkout-overlay)
- [Lemon Squeezy Licensing](https://docs.lemonsqueezy.com/help/licensing)
- [Stripe Required Verification Information (sole proprietor)](https://docs.stripe.com/connect/required-verification-information-taxes)
- [Polar.sh Merchant of Record intro](https://polar.sh/docs/merchant-of-record/introduction)
- [Stripe vs Paddle vs Lemon Squeezy vs Polar — fintechspecs](https://fintechspecs.com/blog/stripe-vs-paddle-vs-lemon-squeezy-vs-polar-merchant-of-record-b2b-saas/)

### AI gateway / proxy
- [LiteLLM Prompt Caching](https://docs.litellm.ai/docs/completion/prompt_caching)
- [LiteLLM Auto-Inject Prompt Caching](https://docs.litellm.ai/docs/tutorials/prompt_caching)
- [Helicone vs Portkey comparison — Respan](https://www.respan.ai/market-map/compare/helicone-vs-portkey)
- [OpenRouter Prompt Caching guide](https://openrouter.ai/docs/guides/best-practices/prompt-caching)

### Multi-provider SDK & caching APIs
- [Vercel AI SDK Anthropic provider](https://ai-sdk.dev/providers/ai-sdk-providers/anthropic) — v3.0.78
- [Vercel AI SDK Automatic Caching](https://vercel.com/docs/ai-gateway/models-and-providers/automatic-caching)
- [Vercel AI SDK Dynamic Prompt Caching cookbook](https://ai-sdk.dev/cookbook/node/dynamic-prompt-caching)
- [Anthropic Prompt Caching docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [OpenAI Prompt Caching guide](https://developers.openai.com/api/docs/guides/prompt-caching)
- [Gemini Context Caching API](https://ai.google.dev/api/caching)
- [Gemini Context Caching overview (Vertex)](https://cloud.google.com/blog/products/ai-machine-learning/vertex-ai-context-caching)
- [OpenRouter AI SDK provider](https://ai-sdk.dev/providers/community-providers/openrouter)

### Player-POV screenshots
- [Jeroen-45/screenshot-bot Fabric mod](https://github.com/Jeroen-45/screenshot-bot) — reference architecture
- [Fabrishot on Modrinth](https://modrinth.com/mod/fabrishot) — surveyed and rejected (not programmatic)
- [WebSocket Commands mod](https://modrinth.com/mod/websocket-commands) — design inspiration for the WS server

### Mod ingestion
- [fabric.mod.json Specification](https://fabricmc.net/wiki/documentation:fabric_mod_json_spec)
- [Modrinth API docs](https://docs.modrinth.com/api/)
- [PrismarineJS/minecraft-data API](https://github.com/PrismarineJS/node-minecraft-data/blob/master/doc/api.md)
- [NeoForged Registries](https://docs.neoforged.net/docs/concepts/registries/)

---

*Stack research for: Sei v1.0 — Commercializable MVP additions*
*Researched: 2026-05-19*
*Companion files (out of scope for this run): FEATURES.md, ARCHITECTURE.md, PITFALLS.md to be written by sibling researchers or downstream phases*
