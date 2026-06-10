# Roadmap: Sei v1.0 — Commercializable MVP

**Milestone:** v1.0 — Commercializable MVP
**Phases:** 7 (Phase 10 → Phase 16, continuing from v0.1.1 which ended at Phase 9)
**Granularity:** coarse
**Coverage:** all v1.0 client requirements mapped (no orphans)
**Last updated:** 2026-06-06

## Milestone Goal

Promote Sei from a working local prototype (v0.1.1) to a commercializable MVP — accounts, a shared character library, hosted AI billing, broader model support, in-game vision, and universal Minecraft mod/version compatibility — without losing the local-only first-class experience or violating the closed-action-registry invariant.

> **Scope note:** This is the **client** roadmap. The hosted cloud backend (proxy server, auth/billing/moderation infrastructure) lives in a separate private repo and is referenced here only where the client integrates with it (e.g. "route LLM calls through the proxy"). Server-side requirements are tracked in that private repo.

## Locked Decisions (baked into this roadmap)

1. **Vision:** Bot-POV via `prismarine-viewer` headless renderer. No OS screen capture. No Fabric mod for vision.
2. **Mod adapters:** Keybind/item scan → LLM filter → LLM recipe writer → declarative recipes only. No code execution.
3. **Cloud scope:** Character *definition* only (persona, prompt, skin, portrait). Runtime memory (`OWNER.md`, `DIARY.md`) stays local.
4. **Modded textures:** Extracted from jars and folded into the `prismarine-viewer` atlas. Lives in Phase 16 (Mod Adapter), not Phase 15 (Vision).
5. **Proxy integration ships first as a `baseURL` override** to the existing Anthropic client — decouples the cloud-AI path from the full multi-provider refactor.

## Phases

- [x] **Phase 10: Auth Foundation** — Email/password + Google OAuth (system browser + loopback + PKCE); session persistence via `safeStorage`; local-only path preserved
- [x] **Phase 11: Cloud Character Library** — Cloud-authoritative character definitions (CRUD), v0.1.1 migration, local cache-on-demand, account delete/export, ToS + Privacy gate
- [x] **Phase 12: Character Sharing UI + Moderation** — Home/Browse tabs, search, "Add to Mine", Report flow; all moderation gates ship together *(code complete; awaiting operator rollout)*
- [x] **Phase 13: AI Proxy + Billing + Usage UI** — In-app credit purchase, cloud-AI routing through the proxy, friendly % usage bar; ships first as a `baseURL` override
- [x] **Phase 14: Multi-Provider Model Abstraction** — `LlmProvider` interface + adapters (Anthropic, OpenAI, Gemini, Grok, OpenRouter, OpenAI-compatible local). Reduced scope; deferred items tracked in phase backlog.
- [ ] **Phase 15: In-Game Vision via prismarine-viewer** — Bot-POV headless render; `visualize` Zod action; capability-gated; 16-block + custom LOS gate; per-hour vision cap *(active)*
- [ ] **Phase 16: Mod & Version Adapter Pipeline** — Keybind/item scan, LLM filter + recipe writer (declarative-only), human review UI, modded texture extraction into the viewer atlas *(not started)*

## Phase Details

### Phase 10: Auth Foundation

**Status:** Complete

**Goal:** Users can sign in to Sei with email/password or Google, sessions persist across launches, and the local-only path from v0.1.1 remains a first-class citizen.

**Depends on:** Nothing (foundational — gates Phases 11, 12, 13)

**Requirements:** AUTH-01 … AUTH-07

**Rationale:** Every commercial feature requires signed-in identity. Auth gates the Cloud Library, Sharing, and the per-user identity the proxy depends on. Token storage via `safeStorage` (mirroring the existing API-key store) is the prerequisite for cloud auth. Account deletion (AUTH-06) and data export (AUTH-07) ship in this phase to satisfy GDPR obligations from the first signup.

**Success Criteria** (what must be TRUE):
  1. A new user can sign up with email + password and sign in again across an app restart
  2. A new user can complete Google sign-in via the system browser (not BrowserWindow), with the loopback callback closing cleanly
  3. A v0.1.1 user can choose "Continue without an account" and reach the existing bot-summon flow with no cloud writes attempted
  4. A signed-in user can delete their account from settings; deletion purges cloud rows and storage objects within the documented window
  5. A signed-in user can export their account data as a single JSON download

**Plans:** 9/9 complete

---

### Phase 11: Cloud Character Library

**Status:** Complete

**Goal:** Character definitions (persona, prompt, skin, portrait) are cloud-authoritative; the local cache continues to work offline; the legal/GDPR gate is live before any cloud write.

**Depends on:** Phase 10 (auth — a Bearer token is required for every cloud write)

**Requirements:** LIB-01 … LIB-07

**Rationale:** Library precedes Sharing because Sharing operates over already-uploaded definitions. The boundary between cloud (definition) and local (runtime memory) is locked here. ToS + Privacy acceptance (LIB-06) is gated on this phase. The cache-on-demand model (existing `characters/<id>.json` + `skins/<id>.png` format) means the character/skin stores and bot supervisor need no changes.

**Success Criteria** (what must be TRUE):
  1. A signed-in user can create, edit, and delete characters from the GUI; changes write through to the cloud and the local cache reflects them immediately
  2. A first-time signed-in user with existing v0.1.1 characters is offered a one-shot migration; selected characters upload with skin + portrait
  3. A user can launch any cloud character they have previously opened while offline (cache-on-demand works)
  4. The user must accept Privacy Policy + ToS before the first cloud write succeeds
  5. Character runtime memory (`OWNER.md`, `DIARY.md`) is never read from or written to the cloud under any code path

**Plans:** 19/19 complete

---

### Phase 12: Character Sharing UI + Moderation

**Status:** Code complete; awaiting operator rollout

**Goal:** Users can discover, preview, and add public characters from a Browse tab; every moderation surface (Report flow, content-policy confirmation, DMCA contact) is live before the first character is published.

**Depends on:** Phase 11 (cloud library — Sharing operates over uploaded definitions)

**Requirements:** SHARE-01 … SHARE-10

**Rationale:** Sharing makes the cloud library valuable to non-creators. The client-side moderation surfaces (default-private uploads, an explicit public-toggle content-policy confirmation, per-card Report, published DMCA contact) ship in the same phase as Browse, not after. The automated image/prompt moderation scans run server-side in the private proxy repo; this phase wires the client to call them and to gate publication on their verdict. Creator profile pages and tag filters are deferred to v1.x.

**Success Criteria** (what must be TRUE):
  1. The Characters page presents a Home tab (mine + recently used) and a Browse tab (all public + text search across name and description)
  2. A user can preview a public character in Browse and "Add to Mine"; the full definition (persona + skin + portrait) downloads into their local library
  3. A user can toggle their own characters between private (default) and public; making one public requires an explicit content-policy confirmation, and the upload is blocked if a moderation gate flags it
  4. Every public character card shows a Report button that submits to the moderation queue
  5. The app and ToS publish the DMCA contact before Browse goes live

**Plans:** 18/18 complete (Browse stays behind a capabilities flag until the operator finishes the rollout runbook)

---

### Phase 13: AI Proxy + Billing + Usage UI

**Status:** Complete

**Goal:** A user can purchase proxied AI credits in-app, the bot routes LLM calls through the hosted proxy when cloud-AI mode is selected, and a friendly server-driven % bar communicates remaining usage without ever showing token counts.

**Depends on:** Phase 10 (auth — per-user identity for the proxy)

**Requirements:** PROXY-01 … PROXY-13

**Rationale (early-revenue pattern):** The client ships in two sub-deliveries. **First**, the cloud-AI path is wired as a `baseURL` + `Authorization` header override to the existing Anthropic client (~10 lines) — putting cloud-AI users on the critical path before the Phase 14 multi-provider refactor lands. **Second**, when Phase 14 lands, the proxy mode slots in as an `LlmProvider` variant (still Anthropic upstream, just routed). The proxy enforcement (per-user auth, rate/spend caps, balance) lives server-side in the private proxy repo; the client's job is to route, surface the % bar, and hard-stop cleanly when credits run out.

**Success Criteria** (what must be TRUE):
  1. A signed-in user can purchase credits via in-app checkout opened by `shell.openExternal`; the balance reflects the grant within seconds
  2. The bot's LLM calls route through the proxy when cloud-AI mode is selected; balance never goes negative even under parallel calls
  3. Hovering the pricing icon shows a friendly server-driven % usage indicator — no token counts appear anywhere in the UI
  4. When credits are depleted, the bot hard-stops with a clear modal offering top-up or subscription; no silent failure and no overage
  5. A user on a local API key never hits the proxy and never sees the credits UI

**Plans:** 23/23 complete

---

### Phase 14: Multi-Provider Model Abstraction

**Status:** Complete (reduced scope)

**Goal:** The bot loop's LLM call site is a provider-agnostic `LlmProvider` interface, with adapters for Anthropic, OpenAI, Gemini, Grok, OpenRouter, OpenAI-compatible local endpoints (Ollama, etc.), and a `capabilities` descriptor each downstream feature can gate on.

**Depends on:** Phase 13 (the proxy mode re-touches into this abstraction as the Anthropic variant)

**Requirements:** PROV-01 … PROV-10

**Rationale:** Multi-provider is the prerequisite for Vision (Phase 15 gates on `capabilities.vision`). Anthropic remains the default so existing configs boot unchanged. Ollama routes through the native `/api/chat` endpoint (the OpenAI-compatible endpoint silently drops tool calls under streaming). The user changes provider by editing `config.llm.provider` + the matching provider's `api_key`.

**Reduced scope:** Per a user directive, this phase shipped the `LlmProvider` factory + adapters only. Deferred to backlog: the list-vs-grid onboarding picker rework, per-provider $/hr CI benchmarks, per-provider caching observability, and Zod re-validation at the adapter boundary.

**Success Criteria** (what must be TRUE):
  1. The bot can complete a tool-use turn end-to-end against any supported provider without code branches outside the provider adapter
  2. Local Ollama is auto-detected at startup and populates from `/api/tags`
  3. Each provider exposes a `capabilities.vision` flag that downstream features gate on
  4. When the selected provider/model is unreachable or rate-limited, the bot surfaces a clear error in the chat log and does not silently stall

**Plans:** 1/1 complete

---

### Phase 15: In-Game Vision via prismarine-viewer

**Status:** Active (next phase — 0/7 plans executed)

**Goal:** The bot can render its own POV via `prismarine-viewer` headless rendering, the LLM can invoke a `visualize` Zod action when the active provider supports vision, idle auto-render is opt-in per character with a cost projection shown, and a custom line-of-sight helper handles non-full blocks, fluids, and entity bounding boxes correctly.

**Depends on:** Phase 14 (`capabilities.vision` must exist before `visualize` can conditionally register); Phase 13 (the per-hour vision cap is enforced by the proxy for cloud-AI users)

**Requirements:** VIS-01 … VIS-08

**Rationale:** Bot-POV via `prismarine-viewer` (not OS screen capture, not a Fabric mod) is the locked decision — it eliminates the macOS Screen-Recording permission UX and the player-monitor privacy leak. The custom LOS helper (VIS-05) is mandatory because raw `bot.world.raycast` misses non-full blocks (slabs, signs, levers, fences, panes) and fluids. Idle auto-render defaults OFF and is shown with a cost projection — vision tokens are far more expensive than text. The per-hour cap is enforced by the proxy for cloud users; BYO-key/local-VLM vision is uncapped. Modded textures in the viewer atlas are out of scope here — that lives in Phase 16.

**Success Criteria** (what must be TRUE):
  1. The LLM can call `visualize` and receive a fresh bot-POV PNG (downscaled to ≤512×512) as an image content block in its next turn — but only when the active provider's `capabilities.vision` is true
  2. When the active model is non-VLM, `visualize` is hidden from the action registry and idle auto-render is disabled (cannot be enabled)
  3. With idle auto-render enabled, the bot only auto-attaches a render when within 16 blocks of its owner AND the custom LOS helper confirms clear sight (slabs, signs, levers, fences, panes, fluids, entity bounding boxes handled correctly)
  4. Vision calls per hour are capped by the proxy for cloud-AI users; exceeding the cap returns a clear error, not a silent failure
  5. When the bot's chunks aren't loaded enough to render meaningfully, it says "I can't see clearly right now" rather than crashing or rendering a black frame

**Plans:** 5/7 plans executed

---

### Phase 16: Mod & Version Adapter Pipeline

**Status:** Not started (no plans yet)

**Goal:** A user can point Sei at a mods folder and receive a reviewable adapter (knowledge summary + per-action declarative recipes + flagged un-mappable items + extracted modded textures folded into the `prismarine-viewer` atlas) generated by a keybind/item-scan → LLM-filter → LLM-recipe-writer pipeline that produces DATA, never code.

**Depends on:** None architecturally (independent of the cloud stack); benefits from Phase 14 (uses the user's preferred provider for ingestion) and Phase 15 (modded textures plug into the viewer atlas)

**Requirements:** MOD-01 … MOD-12

**Rationale (last in queue, most architecturally tensioned):** This is the only phase that touches the closed-action-registry invariant, so it ships last. The pipeline preserves the invariant: adapters are DATA (handler name + arg recipe), never code — no `eval`, `new Function`, `vm.*`, or dynamic `require` in the adapter code path. The existing `src/main/modScanner.ts` (shipped in v0.1.1) already parses `fabric.mod.json` + `META-INF/mods.toml`; this phase extends it with item-registry / lang-string / keybind extraction. Bot restart is required to pick up new adapters (no in-flight registry mutation). Items that cannot map to existing handlers are flagged "known but not invokable" in the review UI.

**Success Criteria** (what must be TRUE):
  1. A user can point Sei at a mods folder, trigger ingestion, and watch a streaming progress UI as jars are scanned, items diffed against the vanilla baseline, and the LLM filter + recipe writer run
  2. The review UI presents the proposed adapter (knowledge summary + per-action recipes + un-mappable items flagged "known but not invokable") with per-item accept/reject; rejected items never persist
  3. After bot restart, accepted recipes register *after* the built-in registry and the bot can invoke them; the closed-registry invariant is preserved
  4. Modded block/item textures extracted from jars (and optionally a user-selected resource pack) appear correctly in bot-POV renders from Phase 15's `visualize`
  5. The confidence/coverage indicator honestly shows what % of detected mod actions were mapped vs flagged un-invokable

**Plans:** TBD

---

## Critical Path

```
Phase 10 (Auth) ─────────────────────────────────────┐
   └─gates─► Phase 11 (Cloud Library)                │
                └─gates─► Phase 12 (Sharing)         │
   └─gates─► Phase 13 (Proxy) — ships baseURL first  │
                └─re-touches in─► Phase 14 (Multi-Provider)
                                       └─gates─► Phase 15 (Vision)  ◄── active
Phase 16 (Mod Adapter) — independent; runs last; uses Phase 15 atlas
```

**Why Phase 13 before Phase 14:** the `baseURL` override is ~10 lines and lets the cloud-AI path land while the full provider abstraction is built. Phase 13 plans two sub-deliveries: (a) `baseURL` override, (b) re-touch as an `LlmProvider` variant after Phase 14.

**Why Phase 15 after Phase 14:** `capabilities.vision` must exist as a flag before `visualize` can conditionally register without hardcoded provider checks.

**Why Phase 16 last:** it is the only phase that tensions the closed-action-registry invariant, so it ships after the rest of the stack is stable. It also depends on Phase 15's atlas for modded-texture rendering.
