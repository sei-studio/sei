# Research Summary — Sei v1.0 Commercializable MVP

**Project:** Sei — Minecraft AI companion framework
**Domain:** Electron desktop AI companion going commercial (cloud accounts, character sharing, hosted billing, multi-provider LLM, vision, mod compatibility)
**Researched:** 2026-05-19
**Confidence:** HIGH on stack and architecture integration; MEDIUM on vision capture approach and mod adapter safety model; see open decisions below.

---

## Executive Summary

Sei v1.0 takes a proven local prototype (signed/notarized Electron app, three-process architecture, single-layer Haiku + mineflayer, closed Zod action registry) and adds seven commercial capabilities: cloud accounts, character library + sharing, a hosted AI proxy with friendly credit UX, multi-provider model support, in-game vision, and universal mod compatibility. The research across all four domains is unusually consistent — the researchers landed on nearly identical phase orderings, and the stack choices (Supabase, Lemon Squeezy MoR, Vercel AI SDK, custom Fabric companion mod) are well-justified against documented alternatives.

The recommended approach is to treat Auth as the true Phase 1 blocker. Auth gates Cloud Library, which gates Sharing, which gates Proxy billing identity. The proxy itself can ship as a trivial `baseURL` override to the existing `anthropicClient.js` before the full multi-provider abstraction is done — this decouples the revenue-critical path from the larger provider refactor. Multi-provider and Vision are tightly coupled (vision is gated on provider capability flags) and should be sequenced together. Mod compatibility is entirely independent of the cloud stack and can run in parallel or last.

The two dominant risks are: (1) the payment/legal surface, which is non-negotiable before any live charge — the project must commit to Lemon Squeezy as Merchant of Record to avoid becoming a personal tax compliance department with EU VAT and Stripe-freeze exposure; and (2) the closed-action-registry invariant under mod adapter ingestion, which has two defensible but incompatible resolutions (declarative-only mappings vs. AST-sandboxed generated handlers) that must be decided at planning time. See Open Decisions below.

---

## Key Findings

### Recommended Stack Additions

The v0.1.1 stack (Electron three-process, mineflayer + plugins, `@anthropic-ai/sdk`, Zod, React 19, electron-vite/builder) carries forward unchanged. The following are the v1.0 additions only.

**Cloud / Auth / Storage:**
- `@supabase/supabase-js ^2.105.x` + Supabase hosted project — single free tier covers Postgres DB (character library), Auth (50k MAU), and Storage (1 GB) in one. Beats Firebase (Electron auth dance requires a Cloud Function hop), Neon (DB-only), PocketBase (self-hosted ops burden). Confidence: HIGH.
- Auth pattern: Supabase PKCE loopback — `shell.openExternal` to auth URL, `http://127.0.0.1:<port>/callback`, `exchangeCodeForSession`. Mirrors `skinServer.ts` lifecycle already in the codebase. Plan a half-day spike; documented Electron edge cases with `getSession()` returning 401.

**Payments:**
- **Lemon Squeezy** as Merchant of Record (no LLC required, accepts individual sellers, handles VAT/sales tax globally, 5% + $0.50). One product, two price options: $5 one-time and $20/month recurring. Stripe personal is ruled out: EU VAT applies from cent one (MOSS/OSS threshold eliminated 2025-01-01) and chargeback/freeze risk to a personal bank account is unacceptable. Backup: Polar.sh.
- Product description must accurately state "proxied AI inference credits via developer's API account" — not "Claude subscription." One-time ToS check before live payments.
- "Form LLC before scale" is a roadmap flag, not a v1.0 blocker when Lemon Squeezy is the MoR.

**AI Proxy:**
- Custom thin Node proxy (`hono ^4.x`) on Fly.io (always-on, ~$3/mo, no 60s timeout). Handles JWT verification, token-bucket credit pre-deduction, RPM/TPM/daily-$ caps, Anthropic forwarding with personal key. Off-the-shelf gateways (Helicone, Portkey) don't model "developer owns the upstream key, rations across users." Vercel Functions' 60s timeout risks long streaming tool-use chains.
- The proxy must NOT ship without: per-user JWT (not shared secret), token-bucket pre-deduction (not post-call), RPM cap, TPM cap, daily $ cap. All four are non-negotiable.

**Multi-Provider LLM:**
- `ai ^6.x` (Vercel AI SDK) + `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`, `@ai-sdk/xai`, `@openrouter/ai-sdk-provider`, `ollama-ai-provider-v2`. Replaces direct `@anthropic-ai/sdk` in the bot loop (proxy backend retains it).
- Prompt caching per provider: Anthropic = explicit `cache_control: ephemeral` breakpoints (already in v0.1.1); OpenAI/Grok = automatic with stable prefix; Gemini = implicit on 2.5+ or explicit `CachedContent`; Ollama = no cache. Cost-per-call benchmarking required per provider before adding to picker.

**Player-POV Vision (PRIMARY path — see Open Decision #1):**
- Custom Fabric companion mod ("Sei Bridge") — opens a localhost WebSocket on `ws://127.0.0.1:25599`, returns PNG frames on request from the utilityProcess. Reference: Jeroen-45/screenshot-bot (MIT, ~400 LOC). The 16-block + line-of-sight gate is enforced Sei-side using mineflayer world state. Fallback: OS window capture via existing `screenshot-desktop`.
- New deps: `ws ^8.x` (WebSocket client in utilityProcess).

**Mod Ingestion:**
- `adm-zip ^0.5.x` + Modrinth REST API v3 + `minecraft-data ^3.x`. Optional: `@xmcl/mod-parser` for modloader detection. Pipeline: scan mods dir → extract metadata → Modrinth lookup → diff vs vanilla → LLM generates summary + adapter declarations → validation gate → human review → persist → load at bot start. See Open Decision #2.

**All new Electron app deps:**
```
npm install @supabase/supabase-js ai @ai-sdk/anthropic @ai-sdk/openai @ai-sdk/google @ai-sdk/xai @openrouter/ai-sdk-provider ollama-ai-provider-v2 ws adm-zip
# Proxy repo only: hono @supabase/supabase-js @anthropic-ai/sdk @lemonsqueezy/lemonsqueezy.js
```

---

### Expected Features

**Must have (table stakes — launch blockers):**

| Feature | Area |
|---|---|
| Email/pw + Google sign-in via system browser + loopback + PKCE | Auth |
| "Continue without account" / local-only path as equal citizen | Auth |
| Session persistence via `safeStorage`; Linux `basic_text` backend warning | Auth |
| Character CRUD: name, desc, prompt, skin, avatar (definition only, not memory) | Cloud Library |
| v0.1.1 persona migration on first sign-in (one-shot import) | Cloud Library |
| Account deletion (purges DB rows within 30 days) + data export | Cloud Library |
| Privacy policy + ToS live before any public cloud writes | Legal/GDPR |
| Home tab (mine + recent) + Browse tab (all + search + "Add to Mine") | Sharing |
| Creator attribution on every card; report button on every public character | Sharing |
| DMCA agent registered + CSAM scan on image upload + prompt moderation at upload | Sharing |
| Default-private uploads with explicit public toggle + content confirmation | Sharing |
| $5 one-time + $20/month checkout via Lemon Squeezy (`shell.openExternal`) | Proxy |
| Per-user JWT from server; token-bucket pre-deduction; RPM + TPM + daily $ cap | Proxy |
| % bar above settings icon (server-driven, no token counts ever) | Proxy |
| Out-of-credits modal with hard stop + one-click top-up | Proxy |
| Refund policy in ToS; FIFO credit ledger; subscription cancels through period end | Proxy |
| Provider list: Anthropic + OpenAI + Gemini + local Ollama (core 4 for v1.0) | Multi-Provider |
| Per-provider caching working internally (transparent to user) | Multi-Provider |
| Ollama: native `/api/chat` endpoint, not `/v1/chat/completions` with streaming | Multi-Provider |
| Re-validate every tool-call response against original Zod before dispatch | Multi-Provider |
| Per-provider golden test + $/hr benchmark in CI | Multi-Provider |
| `visualize` Zod action + idle auto-screenshot when VLM active | Vision |
| Idle auto defaults OFF; opt-in with cost projection shown | Vision |
| 16-block radius + custom LOS helper (handles non-full blocks + fluids) | Vision |
| Graceful degradation: "I can't see right now" when mod absent or permission denied | Vision |
| Modloader detection + vanilla baseline diff + knowledge injection into system prompt | Mod Compat |
| Honest fallback when coverage <50% | Mod Compat |

**Should have (differentiators, not launch blockers):**
- In-world 3D skin preview on card hover (`skinview3d`) — c.ai has no 3D preview
- Trending / staff-picks row on Browse — solves cold-start discovery
- Per-character `recommended_model` hint — guards cheap-model + complex-persona mismatch
- Local Ollama auto-detection at startup (probe `:11434`, populate from `/api/tags`)
- Saliency-gated idle screenshots (new entity, owner moved >5 blocks) rather than time-gated
- Confidence/coverage indicator for mod compat

**Defer to v1.x:**
- Grok + OpenRouter adapters (wait until core 4 are rock-solid)
- Tag filters + creator profile pages on Browse
- LLM-synthesized mod knowledge beyond raw item parsing

**Defer to v2+:**
- Cloud-synced runtime memory (OWNER.md/DIARY.md) — privacy scope, race conditions; keep local-only
- Comments / social features — moderation cost
- Streaming VLM (continuous vision) — cost-prohibitive
- Multiple simultaneous bots

---

### Architecture Integration Points

The v0.1.1 three-process architecture is preserved exactly. Integration points are file-path-specific.

**Process boundary assignments (new work only):**

| Concern | Process | Key file(s) |
|---|---|---|
| Auth state + token storage | main | `src/main/authStore.ts` (new), `authService.ts` (new) |
| Cloud API (library, billing) | main | `src/main/cloudApi.ts` (new), `cloudCharacterSync.ts` (new) |
| OAuth loopback + checkout redirect | main | `authService.ts`, `billingService.ts` (new) |
| LLM provider abstraction | utilityProcess | `src/bot/brain/llm/provider.js` (new) + per-provider adapters |
| Screenshot WebSocket server | utilityProcess | `src/bot/brain/vision/screenshotIngest.js` (new) |
| `visualize` Zod action | utilityProcess | `src/bot/adapter/minecraft/behaviors/visualize.js` (new) |
| Mod adapter scan/diff/generate/validate | main | `src/main/modAdapter{Scan,Diff,Generator,Validator}.ts` (new) |
| Mod adapter execution | utilityProcess | `src/bot/adapter/minecraft/loadModAdapters.js` (new) |
| Companion mod installer | main | `src/main/companionModInstaller.ts` (new, mirrors `customSkinLoader.ts`) |

**Highest-impact modified files (every feature touches these):**
- `src/shared/ipc.ts` — add `IpcChannel.auth`, `cloudChars`, `usage`, `modAdapter`; widen provider enum
- `src/main/ipc.ts` — register all new handlers; gate cloud handlers on `authStore.isSignedIn()`
- `src/main/botSupervisor.ts:374` — extend init payload: `{ authToken, proxyConfig, modAdaptersDir, vlmCapable }`
- `src/bot/brain/orchestrator.js:266` — `createAnthropicClient(config)` → `createLlmProvider(config)`
- `src/bot/adapter/minecraft/registry.js` — `createDefaultRegistry({ extraAdapters })`; register `visualize` behind `capabilities.vision`

**Cloud character sync model:** definition slice (persona, skin, portrait) is cloud-authoritative, cached locally in the existing `characters/<id>.json` + `skins/<id>.png` format. Runtime memory (`OWNER.md`, `DIARY.md`) stays local-only, never synced. `characterStore`, `skinStore`, and `botSupervisor` require zero changes.

**Cheap early win:** proxy can ship as `baseURL` + `Authorization` header override to the existing `anthropicClient.js` before the full Phase E multi-provider refactor. This decouples the revenue path from the provider abstraction work.

---

### Critical Pitfalls

**P0 — Must prevent before shipping any live feature:**

1. **No MoR = personal VAT liability from first EU sale.** EU VAT applies from €0 (threshold eliminated 2025-01-01). Use Lemon Squeezy. Don't accept live charges without MoR or LLC.

2. **Proxy without per-user JWT + pre-deduction = one abuse weekend exceeds a month of revenue.** Per-user JWT (not shared binary secret), token-bucket pre-deduction before Anthropic call, RPM cap, TPM cap, daily $ cap. All four are non-negotiable gates before the proxy ships.

3. **Public sharing without moderation baseline = immediate legal exposure.** DMCA agent registered ($6 online) + CSAM scan on every image upload + prompt moderation at upload time. Ship these three with the sharing feature, not after.

4. **Google OAuth in a BrowserWindow.** Blocked since 2021. System browser + loopback + PKCE. No exceptions.

5. **GDPR non-compliance from first EU user.** Privacy policy + ToS before public cloud writes. Account deletion + data export ship with the first cloud-write feature.

**P1 — Must prevent in the relevant phase:**

6. **Mod adapter ingestion as code execution.** Prompt-injected mod README → malicious handler → RCE. See Open Decision #2.

7. **Vision idle auto-screenshot defaults ON.** The $5 one-time pack burns in a single play session on vision alone. Default OFF. 512×512 max image size. Hard cap vision calls/hour in proxy.

8. **Cross-provider tool schema drift.** Gemini silently drops schema constraints. Re-validate every tool-call response against original Zod before dispatch. Per-provider golden tests in CI.

9. **Ollama streaming + tool calls = silent failure.** Native `/api/chat`, not `/v1/chat/completions` with streaming. Integration smoke test: forced-tool-use prompt → assert `tool_calls` arrive.

10. **Offline regression on v0.1.1 upgrade.** Local-only path must remain first-class. Logout must not wipe local character files. Migration test required.

---

## Implications for Roadmap

All three researchers (STACK, ARCHITECTURE, PITFALLS) independently converged on the same phase order. The synthesis:

### Phase A — Auth Foundation

**Rationale:** Every commercial feature requires signed-in user identity. Auth also establishes the `safeStorage` token store that proxy mode depends on. Nothing else attempts cloud without this.

**Delivers:** Email/pw + Google OAuth (system browser + loopback + PKCE) · session persistence via `src/main/authStore.ts` · "Continue without account" local-only path · Linux `basic_text` warning · `auth:state` IPC channel

**Key files:** `src/main/authStore.ts`, `authService.ts`, `src/shared/authSchema.ts`, `src/shared/ipc.ts`

**Pitfalls to avoid:** BrowserWindow OAuth (P0 #4), safeStorage Linux (P1 #15), offline regression (P1 #13)

---

### Phase B — Cloud Character Library

**Rationale:** Character definitions moving to cloud is the prerequisite for sharing. Sync model (definition in cloud, runtime memory stays local) must be established before any sharing UI. Account deletion + data export ship in this phase — not later.

**Delivers:** Supabase schema (characters + credit_grants tables) · character CRUD (persona, skin, portrait) · v0.1.1 persona migration on first sign-in · cache-on-demand sync (existing local format unchanged) · account deletion + data export · privacy policy + ToS live

**Key files:** `src/main/cloudApi.ts`, `cloudCharacterSync.ts`, `src/shared/cloudCharacterSchema.ts`

**Pitfalls to avoid:** GDPR (P0 #5), cloud-as-replacement-not-cache (P1 #13 offline regression), never sync runtime memory (anti-pattern A.2)

---

### Phase C — Character Sharing UI

**Rationale:** Sharing makes the library valuable to non-creators. Must land after library is stable. Moderation baseline gates this phase — no public sharing without all three controls.

**Delivers:** Home + Browse two-tab nav · card grid with avatar, skin chip, creator attribution · "Add to Mine" (downloads full definition locally) · Remix (independent copy with attribution) · report button · DMCA agent registered · CSAM scan on image upload · prompt moderation at upload · default-private + explicit public toggle

**Key files:** `src/renderer/src/screens/BrowseScreen.tsx`, refactored `HomeScreen.tsx`

**Pitfalls to avoid:** public library content liability (P0 #3), all three moderation gates are non-negotiable

---

### Phase D — AI Proxy + Usage Indicator

**Rationale:** Revenue-critical path. Proxy can ship as a `baseURL` override to existing `anthropicClient.js` before the full Phase E refactor — this decouples billing from the larger abstraction work. All four proxy security controls ship together; none deferred.

**Delivers:** Lemon Squeezy checkout via `shell.openExternal` · webhook handler → `credit_grants` row in Supabase · per-user JWT · token-bucket pre-deduction · RPM + TPM + daily $ hard cap · server-driven `remaining_pct` header → `usage:state` IPC channel → % bar · out-of-credits modal (hard stop) · FIFO credit ledger + refund policy in ToS

**Key files:** `src/main/billingService.ts`, modified `src/bot/brain/anthropicClient.js` (baseURL + auth_header + usage forwarding), new `usage:state` channel

**Pitfalls to avoid:** MoR vs personal Stripe (P0 #1), proxy credit drain (P0 #2), ledger edge cases (P1 #14)

**Legal gate:** Lemon Squeezy account approved before any live charge.

---

### Phase E — Multi-Provider Abstraction

**Rationale:** Multi-provider is the prerequisite for vision (vision gates on `capabilities.vision` flag). Pure in-process refactor; no user-visible breaking changes if scoped correctly.

**Delivers:** `LlmProvider` interface with `call()`, `buildCachedSystem()`, `capabilities` · providers: anthropic (rename), openai, gemini, localOpenAI (Ollama) · Zod re-validation step in each adapter · per-provider caching strategy · Ollama routed to native `/api/chat` · per-provider integration smoke test + $/hr benchmark in CI · model picker list-style with capability chips · local Ollama auto-detection

**Key files:** `src/bot/brain/llm/` directory (new), `src/bot/brain/orchestrator.js:266` (provider swap)

**Pitfalls to avoid:** cross-provider schema drift (P1 #5), cache economics regression (P1 #6), Ollama streaming drop (P1 #7)

---

### Phase F — In-Game Vision

**Rationale:** Depends on Phase E capability flags. Sei Companion Mod can be built in parallel with Phase E (separate Fabric/Gradle artifact). Vision defaults OFF; idle auto-screenshot is paid-tier-only with explicit opt-in.

**Delivers:** Sei Bridge Fabric mod (WebSocket server, PNG frames, mod auto-installed via wizard) · `screenshotIngest.js` (WS server, 10s TTL frame buffer) · `visualize` Zod action · custom LOS helper (full-occlusion-only matcher, entity bounding-box, fluid visibility rule) · saliency-gated idle auto (default OFF) · 512×512 downscaling · hard cap on vision calls/hour in proxy · macOS permission explainer before OS prompt · graceful degradation

**Key files:** `mods/sei-companion/` (new Fabric project), `src/bot/brain/vision/screenshotIngest.js`, `src/bot/adapter/minecraft/behaviors/visualize.js`, `src/main/companionModInstaller.ts`

**Pitfalls to avoid:** vision token cost (P1 #8), LOS raycast bugs (P1 #10)

**Phase success criteria:** idle vision cost/hr < $0.50 on default settings; idle screenshot OFF on fresh install; LOS fixture passes for lever, sign, glass pane, slab, water, ladder.

**Note:** Open Decision #1 (player-POV vs bot-POV) must be resolved before this phase plans.

---

### Phase G — Mod Adapter Ingestion

**Rationale:** Fully independent of cloud stack. Safest to ship last because it tensions the closed-action-registry invariant. Open Decision #2 must be locked before this phase plans.

**Delivers:** `modAdapterScan.ts` (enumerate jars) · `modAdapterDiff.ts` (diff vs bundled vanilla manifest at `resources/mc-baseline/1.21.1-items.json`) · `modAdapterGenerator.ts` (Haiku call: diff + lang strings + Modrinth descriptions → knowledge summary + adapter declarations) · `modAdapterValidator.ts` (AST gate or declarative allowlist per Open Decision #2) · `ModAdapterReviewScreen.tsx` (user accepts/rejects each action) · `loadModAdapters.js` (reads adapters at bot start, registers after built-in 19 actions) · bot restart required to pick up new adapters · confidence/coverage indicator · streaming progress bar during ingestion

**Key files:** `src/main/modAdapter{Scan,Diff,Generator,Validator,Store}.ts` (new), `src/bot/adapter/minecraft/loadModAdapters.js`, renderer `ModAdapterReviewScreen.tsx`, `resources/mc-baseline/1.21.1-items.json`

**Pitfalls to avoid:** mod adapter RCE (P0 #6 — `grep 'eval\|new Function\|vm\.'` must return zero in the adapter code path)

---

### Phase Ordering Rationale

```
Auth (A) ─────────────────────────────────────────────────────────┐
    └──gates──► Cloud Library (B)                                  │
                    └──gates──► Sharing (C) ◄──── all three needed │
                    └──gates──► Proxy (D) ◄──────── for launch     │
                                                                    │
Proxy (D) ships early as baseURL override to existing anthropicClient.js
    └──full proxy mode after Multi-Provider (E) lands              │
                                                                    │
Multi-Provider (E) ──gates──► Vision (F)                           │
    capabilities.vision flag must exist before visualize registers  │
                                                                    │
Mod Compat (G) ──independent──► parallelize with B-C after E stable│
```

**Critical path to revenue:** A → D (proxy as baseURL override) → E → F

**Why proxy before full multi-provider:** the baseURL override is ~10 lines in `anthropicClient.js`. Revenue can validate with real users while the abstraction is being built.

**Why vision after multi-provider:** `capabilities.vision` must exist before `visualize` can conditionally register. Building vision before this flag causes hardcoded provider checks that break with every new provider.

**Why mod compat last:** most architecturally sensitive feature, independent of commercial thesis, longest build time (Fabric mod + pipeline).

---

### Research Flags

**Phases needing `/gsd-research-phase` during planning:**
- **Phase F (Vision):** Open Decision #1 must resolve first. Fabric mod development is also a different build environment (Gradle + Loom) — plan a scoping spike for toolchain, MC version targeting, and installer bundling.
- **Phase G (Mod Compat):** Open Decision #2 must resolve first. Phase plan must open with the resolution and include grep-for-disallowed-patterns as a success criterion.
- **Phase E (Multi-Provider):** Sharp edges per provider (Gemini explicit CachedContent + AI SDK v6, Ollama streaming bug). Plan one integration spike per provider before declaring done.

**Phases with standard patterns (skip research-phase):**
- **Phase A (Auth):** PKCE loopback is well-documented. Half-day spike for Supabase edge cases is sufficient.
- **Phase B (Cloud Library):** Standard cache-on-demand over existing local format. No novel architecture.
- **Phase C (Sharing):** Standard two-tab discovery UI. Moderation tooling is operational, not architectural, complexity.
- **Phase D (Proxy):** Hono + Supabase JWT + Lemon Squeezy webhooks are standard patterns. ~300 lines. Spec the ledger model; don't research it.

---

## Open Decisions for the User

These must be resolved before the relevant phase plans are written. The roadmapper should not silently pick a side.

### Open Decision #1 — Vision: Player-POV (Fabric mod) vs. Bot-POV (prismarine-viewer)

**Context:** The v1.0 milestone spec and ARCHITECTURE.md both describe player-POV via a Fabric companion mod. The PITFALLS researcher recommends bot-POV via `prismarine-viewer` headless render.

| | Player-POV (Fabric mod) — user's stated intent | Bot-POV (prismarine-viewer) — PITFALLS recommendation |
|---|---|---|
| **What it captures** | Exactly what the human sees — resource packs, GUI, HUD, effects | Bot's server-side world knowledge — no resource packs, no GUI |
| **Privacy** | Player's actual game screen (no other windows captured) | Zero access to player's machine state |
| **macOS permission** | May trigger Screen Recording permission | No OS permission needed |
| **"The bot can see me"** | Yes — describes what player is literally looking at | The bot describes the world around its own position |
| **Maintenance burden** | Fabric mappings change per MC release; mod needs rebuild per MC line | Updates with mineflayer; no separate release cycle |
| **Precedent in PROJECT.md** | "OS-level window capture — brittle but desired" | Not mentioned; researcher suggestion |
| **Implementation** | Custom Fabric mod ~400 LOC (Jeroen-45/screenshot-bot reference) | Node canvas-webgl; documented in mineflayer examples |

**Synthesis recommendation:** User's stated intent should win, but deserves deliberate confirmation. Bot-POV is less work and arguably a better "bot experience." Player-POV is a stronger differentiator. Fabric mod maintenance cost is real and ongoing (~1 day per MC release line).

**Decision needed before Phase F planning.**

---

### Open Decision #2 — Mod Adapters: Declarative-Only vs. AST-Sandboxed Generated Handlers

**Context:** ARCHITECTURE researcher and PITFALLS researcher both engage this directly and arrive at different resolutions.

**ARCHITECTURE researcher:** Generated handlers pass through an AST whitelist gate (acorn parse; reject `require`/`process`/`fs`/`eval`/`new Function`; whitelist `bot.<method>`, `args.<x>`, `return string|object`). Stored as JSON manifests with `zodSchemaSrc` + `handlerSrc` strings; compiled via `new Function(...)` inside a whitelisted closure. Restart required. Registry invariant preserved at the architecture level.

**PITFALLS researcher:** Adapters are declarative mappings only (`modded_item_id → vanilla_category`, `modded_keybind → existing_action`). These plug into a fixed set of generic handlers already in the closed registry. No new code paths. If true new actions are eventually needed, that is a separate manual-review-gated architectural evolution, not v1.0.

| | Declarative-Only (PITFALLS) | AST-Sandboxed Code (ARCHITECTURE) |
|---|---|---|
| **Security surface** | Minimal — LLM output is structured data, not code | Larger — `new Function` sandboxing is well-understood but not zero-risk |
| **Attack vector** | Prompt injection can only produce bad data (dropped by schema) | Prompt injection in mod README → malicious handler → RCE |
| **Bot capability** | Bot understands modded item names and can reference them; vanilla-equivalent actions | Bot can get genuinely novel actions (e.g. `use_chisel` for a specific mod) |
| **Implementation complexity** | Lower — no AST parser, no sandbox | Higher — acorn, allowlist, sandbox test suite |
| **Registry invariant** | Fully preserved | Preserved at architecture level; weakened in spirit |

**Synthesis recommendation:** For v1.0, declarative-only. "Adapters are data, not code" is simpler to implement, simpler to verify, and eliminates the most severe attack vector. User value of "bot knows modded item names and references them in conversation" is achievable with declarative mappings. AST-sandboxed handlers can be a deliberate v1.1 decision with proper security review if community demands richer mod-native behaviors.

**Decision needed before Phase G planning.**

---

### Non-Decision: Payments Platform

Lemon Squeezy as MoR is the clear winner. No decision needed — execute. Future note: form LLC before revenue exceeds ~$20K annual or before moving to direct Stripe.

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All choices verified against official docs + 2026 sources. Lemon Squeezy, Supabase, Vercel AI SDK, Fly.io confirmed viable for this exact use case. |
| Features | HIGH | Table stakes cross-referenced against c.ai, Cursor, Poe, Mindcraft. Anti-features validated against documented failure modes. |
| Architecture | HIGH | Architecture researcher read v0.1.1 source directly. All integration points are file-path-specific, not speculative. Dependency injection seams exist today. |
| Pitfalls — technical | HIGH | Gemini schema drops, Ollama streaming bug, raycast non-full-block miss all verified against GitHub issues and official docs. |
| Pitfalls — legal | MEDIUM | GDPR, DMCA, VAT guidance accurate at the pattern level; not a substitute for CPA/lawyer at scale. |

**Overall confidence: HIGH**

### Gaps to Address During Planning

1. **Fabric mod build toolchain:** Gradle + Fabric Loom is a different build environment from the TypeScript monorepo. Scoping spike needed: pipeline, MC version targeting (1.20.x vs 1.21.x), jar bundling into Electron installer.

2. **Gemini explicit `CachedContent` + AI SDK v6:** may require a direct `@google/generative-ai` call outside the SDK for cache creation. Verify during multi-provider spike.

3. **Vercel AI SDK `cacheControl` round-trip:** open issue #5883 reports options being dropped. Verify with curl trace before shipping Anthropic prompt caching in the new provider abstraction.

4. **Lemon Squeezy product framing:** one-time ToS check required before live payments — "proxied inference credits" framing vs Anthropic ToS. Not blocking, but must happen before proxy goes live.

5. **Supabase free-tier pause after 1-week idle:** document a "ping" script or upgrade to paid tier before launch to avoid CI disruptions.

6. **Open Decision #2 security review:** if AST-sandboxed handlers are chosen, a security review of the `new Function` sandbox is a mandatory Phase G success criterion.

---

## Sources

### Primary (HIGH confidence)
- `src/main/`, `src/bot/`, `src/shared/`, `src/renderer/` — v0.1.1 source read directly by architecture researcher
- [Supabase Pricing](https://supabase.com/pricing) — free tier specs (50k MAU, 500MB Postgres, 1GB storage)
- [Vercel AI SDK Anthropic provider](https://ai-sdk.dev/providers/ai-sdk-providers/anthropic) — v3.0.78 + cacheControl API
- [Anthropic Prompt Caching docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [OpenAI Prompt Caching guide](https://developers.openai.com/api/docs/guides/prompt-caching)
- [Gemini Context Caching API](https://ai.google.dev/api/caching)
- [Google OAuth for Native Apps](https://developers.google.com/identity/protocols/oauth2/native-app) — loopback + PKCE required
- [Lemon Squeezy Checkout Overlay docs](https://docs.lemonsqueezy.com/help/checkout/checkout-overlay)
- [Electron safeStorage docs](https://www.electronjs.org/docs/latest/api/safe-storage) — Linux `basic_text` fallback
- [Ollama tool calling + streaming issue #12557](https://github.com/ollama/ollama/issues/12557) — `/v1/chat/completions` drops tool calls in streaming confirmed
- [prismarine-world raycast issue #87](https://github.com/PrismarineJS/prismarine-world/issues/87) — non-full block miss confirmed
- [Jeroen-45/screenshot-bot](https://github.com/Jeroen-45/screenshot-bot) — Fabric mod reference for player-POV WebSocket bridge
- [Modrinth API docs](https://docs.modrinth.com/api/) — v3, SHA-1 hash lookup
- [Mastra: MCP tool compatibility layer](https://mastra.ai/blog/mcp-tool-compatibility-layer) — Gemini silent schema drop confirmed

### Secondary (MEDIUM confidence)
- [Supabase OAuth-in-Electron discussions #17722, #27181](https://github.com/orgs/supabase/discussions/17722) — `getSession()` 401 edge cases
- [EU OSS / VAT guide 2026](https://www.commenda.io/blog/europe-vat-guide-for-digital-content-creators) — €0 threshold confirmed
- [Mindcraft on GitHub](https://github.com/mindcraft-bots/mindcraft) — three-mode vision toggle as direct precedent
- [Cursor pricing + % bar UX](https://cursor.com/learn/tokens-pricing) — overage backlash and unit-change backlash as anti-pattern evidence
- [DMCA safe harbor requirements](https://patentpc.com/blog/building-a-content-moderation-strategy-that-retains-dmca-safe-harbor)
- [CSAM reporting obligations](https://removeyourmedia.com/2026/03/07/csam-reporting-obligations-what-platforms-must-do-to-stay-compliant/)

### Tertiary (LOW confidence — validate during implementation)
- Gemini explicit `CachedContent` + AI SDK v6 integration — may require direct API call; unverified
- Vercel AI SDK issue #5883 — `cacheControl` options dropped; needs curl-trace verification
- LM Studio auto-detection at `:1234` — not tested against production LM Studio build

---

*Research completed: 2026-05-19*
*Ready for roadmap: yes — pending resolution of Open Decision #1 (vision POV) and Open Decision #2 (mod adapter safety model)*
