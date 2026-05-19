# Roadmap: Sei v1.0 — Commercializable MVP

**Milestone:** v1.0 — Commercializable MVP
**Phases:** 7 (Phase 10 → Phase 16, continuing from v0.1.1 which ended at Phase 9)
**Granularity:** coarse
**Coverage:** 67/67 v1.0 requirements mapped (no orphans)
**Last updated:** 2026-05-19

## Milestone Goal

Promote Sei from a working local prototype (v0.1.1) to a commercializable MVP — accounts, shared character library, hosted AI billing, broader model support, in-game vision, and universal Minecraft mod/version compatibility — without losing the local-only first-class experience or violating the closed-action-registry invariant.

## Locked Decisions (baked into this roadmap)

1. **Vision:** Bot-POV via `prismarine-viewer` headless renderer. No OS screen capture. No Fabric mod for vision.
2. **Mod adapters:** Keybind-scan → LLM filter → LLM recipe writer → declarative recipes only. No code execution.
3. **Payments:** Lemon Squeezy as Merchant of Record (no LLC required for v1.0).
4. **Cloud scope:** Character DEFINITION only (persona, prompt, skin, portrait). Runtime memory (`OWNER.md`, `DIARY.md`) stays local.
5. **Modded textures:** Extracted from jars and folded into the prismarine-viewer atlas. Lives in Phase 16 (Mod Adapter), not Phase 15 (Vision).
6. **Proxy ships first as `baseURL` override** to existing `anthropicClient.js` — decouples revenue path from the full multi-provider refactor.

## Phases

- [ ] **Phase 10: Auth Foundation** — Email/password + Google OAuth (system browser + loopback + PKCE); session persistence via safeStorage; local-only path preserved
- [ ] **Phase 11: Cloud Character Library** — Supabase-backed character definitions (CRUD), v0.1.1 migration, account delete/export, ToS + Privacy Policy live
- [ ] **Phase 12: Character Sharing UI + Moderation** — Home/Browse tabs, search, "Add to Mine", CSAM scan + prompt moderation + DMCA agent — all moderation gates ship together
- [ ] **Phase 13: AI Proxy + Billing + Usage UI** — Lemon Squeezy checkout, Fly.io Hono proxy, per-user JWT, token-bucket pre-deduction, % usage bar; ships first as baseURL override
- [ ] **Phase 14: Multi-Provider Model Abstraction** — LlmProvider interface; Anthropic/OpenAI/Gemini/Grok/OpenRouter/Ollama adapters; per-provider caching; Zod re-validation; Ollama native endpoint
- [ ] **Phase 15: In-Game Vision via prismarine-viewer** — Bot-POV headless render; `visualize` Zod action; capability-gated; 16-block + custom LOS gate; per-hour proxy cap
- [ ] **Phase 16: Mod & Version Adapter Pipeline** — Keybind/item scan, LLM filter + recipe writer (declarative-only), human review UI, modded texture extraction into viewer atlas

## Phase Details

### Phase 10: Auth Foundation

**Goal:** Users can sign in to Sei with email/password or Google, sessions persist across launches, and the local-only path from v0.1.1 remains a first-class citizen.

**Depends on:** Nothing (foundational — gates Phases 11, 12, 13)

**Requirements:** AUTH-01, AUTH-02, AUTH-03, AUTH-04, AUTH-05, AUTH-06, AUTH-07

**Rationale:** Every commercial feature requires signed-in identity. Auth gates Cloud Library, Sharing, and the per-user JWT the Proxy depends on. Token storage via `safeStorage` (mirroring `apiKeyStore.ts`) is also the prerequisite for proxy auth headers. AUTH-06 (account deletion) and AUTH-07 (data export) ship in this phase, not later — per Pitfall 11 (GDPR obligations apply from first EU signup) and Pitfall 13 (offline-mode regression risk).

**Success Criteria** (what must be TRUE):
  1. A new user can complete sign-up with email + password and sign in again across an app restart
  2. A new user can complete Google sign-in via the system browser (not BrowserWindow), with the loopback callback closing cleanly
  3. A v0.1.1 user upgrading to v1.0 can choose "Continue without an account" and reach the existing bot summon flow with no cloud writes attempted
  4. A signed-in user can delete their account from settings; deletion purges Supabase rows and Storage objects within the documented 30-day window
  5. A signed-in user can export their account data as a single JSON download containing characters + sharing metadata

**Plans:** TBD
**UI hint:** yes

---

### Phase 11: Cloud Character Library

**Goal:** Character definitions (persona, prompt, skin, portrait) live in Supabase as the cloud-authoritative source; the local cache continues to work offline; legal/GDPR machinery is live before any cloud write.

**Depends on:** Phase 10 (auth — Bearer token required for every cloud write)

**Requirements:** LIB-01, LIB-02, LIB-03, LIB-04, LIB-05, LIB-06, LIB-07

**Rationale:** Library precedes Sharing because Sharing operates over already-uploaded definitions. The boundary between cloud (definition) and local (runtime memory) must be locked here — once Sharing ships, changing it is breaking. ToS + Privacy Policy (LIB-06) are gated on this phase per Pitfall 11. The cache-on-demand sync model (existing `characters/<id>.json` + `skins/<id>.png` format) means `characterStore`, `skinStore`, `skinServer`, and `botSupervisor` require zero changes.

**Success Criteria** (what must be TRUE):
  1. A signed-in user can create, edit, and delete characters from the GUI; changes write through to Supabase and the local cache reflects them immediately
  2. A first-time signed-in user with existing v0.1.1 characters is offered a one-shot migration; selected characters upload to Supabase with skin + portrait
  3. A user can launch any cloud character they have previously opened while their machine is offline (cache-on-demand works)
  4. The user is presented with and must accept Privacy Policy + ToS before the first cloud write succeeds
  5. Character runtime memory (`OWNER.md`, `DIARY.md`) is never read from or written to Supabase under any code path

**Plans:** TBD
**UI hint:** yes

---

### Phase 12: Character Sharing UI + Moderation

**Goal:** Users can discover, preview, and add public characters from a Browse tab; every moderation gate (CSAM scan, prompt moderation, DMCA agent, Report flow) is live before the first character is published.

**Depends on:** Phase 11 (cloud library — Sharing operates over uploaded definitions)

**Requirements:** SHARE-01, SHARE-02, SHARE-03, SHARE-04, SHARE-05, SHARE-06, SHARE-07, SHARE-08, SHARE-09, SHARE-10

**Rationale:** Sharing makes the cloud library valuable to non-creators. All three moderation gates (CSAM scan on every image, prompt-moderation at upload, DMCA agent registered with US Copyright Office) are launch gates per Pitfall 12 — they ship in the same phase as Browse, not after. Default-private uploads with explicit public-toggle confirmation reduce griefer surface and PII leakage. Creator profile pages and tag filters are explicitly deferred to v1.x.

**Success Criteria** (what must be TRUE):
  1. The Characters page presents a Home tab (my characters + recently used) and a Browse tab (all public + text search across name and description)
  2. A user can preview a public character in Browse and "Add to Mine"; the full definition (persona + skin + portrait) downloads into their local library
  3. A user can toggle their own characters between private (default) and public; making one public requires an explicit content-policy confirmation and the upload is blocked if CSAM scan or prompt moderation flags it
  4. Every public character card shows a Report button that submits to the moderation queue
  5. The app and ToS publish the DMCA contact, and the DMCA agent is registered with the US Copyright Office before Browse goes live

**Plans:** TBD
**UI hint:** yes

---

### Phase 13: AI Proxy + Billing + Usage UI

**Goal:** A user can purchase proxied AI credits ($5 one-time or $20/month) via Lemon Squeezy, the Fly.io Hono proxy enforces per-user JWT + token-bucket pre-deduction + RPM/TPM/daily $ caps, and a friendly server-driven % bar communicates remaining usage without ever showing token counts.

**Depends on:** Phase 10 (auth — per-user JWT requires Supabase identity)

**Requirements:** PROXY-01, PROXY-02, PROXY-03, PROXY-04, PROXY-05, PROXY-06, PROXY-07, PROXY-08, PROXY-09, PROXY-10, PROXY-11, PROXY-12, PROXY-13

**Rationale (early-revenue pattern):** This phase ships in TWO sub-deliveries. **First**, the proxy is wired as a `baseURL` + `Authorization` header override to the existing `anthropicClient.js` (~10 lines) — this puts revenue-validating users on the critical path BEFORE the full Phase 14 multi-provider refactor lands. **Second**, when Phase 14 lands, the proxy mode is re-touched to slot in as an `LlmProvider` variant (still Anthropic upstream, just routed). The planner should plan both sub-deliveries explicitly. All four proxy security controls (per-user JWT, token-bucket pre-deduction, RPM cap, TPM cap, daily $ cap) are launch gates per Pitfall 2 — none can be deferred. PROXY-13 (Anthropic ToS check on the "proxied inference credits" framing) is a one-time legal gate before the first live charge.

**Success Criteria** (what must be TRUE):
  1. A signed-in user can purchase a $5 one-time pack or a $20/month subscription via Lemon Squeezy opened by `shell.openExternal`; the Supabase credit ledger reflects the grant within seconds of the webhook
  2. The bot's LLM calls route through the Fly.io proxy when cloud-AI mode is selected, the proxy verifies the per-user JWT on every request, and token-bucket pre-deduction prevents balance from ever going negative even under parallel calls
  3. A user hovering the pricing icon (above the settings icon) sees a friendly server-driven % usage indicator — no token counts appear anywhere in the UI
  4. When credits are depleted, the bot hard-stops with a clear modal offering top-up or subscription; no silent failure and no overage
  5. A user using a local API key (BYO Anthropic / OpenAI / etc.) never hits the proxy and never sees the credits UI

**Plans:** TBD
**UI hint:** yes

---

### Phase 14: Multi-Provider Model Abstraction

**Goal:** The bot loop's LLM call site is a provider-agnostic `LlmProvider` interface; six provider adapters (Anthropic, OpenAI, Gemini, Grok, OpenRouter, Ollama / OpenAI-compatible local) are live with per-provider prompt caching working internally, every tool-call response is re-validated against the original Zod schema before dispatch, and the onboarding picker is a list (not grid) with capability chips.

**Depends on:** Phase 13 (the proxy mode re-touches into this abstraction as the Anthropic variant — but Phase 13 can ship its baseURL-override flavor before this phase lands)

**Requirements:** PROV-01, PROV-02, PROV-03, PROV-04, PROV-05, PROV-06, PROV-07, PROV-08, PROV-09, PROV-10

**Rationale:** Multi-provider is the prerequisite for Vision (Phase 15 gates on `capabilities.vision`). Two pitfalls are non-negotiable scope: PROV-04 routes Ollama through `/api/chat` (not `/v1/chat/completions` which silently drops tool calls under streaming per Pitfall 7), and PROV-05 re-validates every tool-call response against the original Zod schema (Gemini silently drops schema constraints per Pitfall 5). Per-provider golden test + $/hr benchmark in CI (PROV-06) is the cost-economics guardrail per Pitfall 6. The `capabilities` descriptor (PROV-07) is what Phase 15's `visualize` registration keys off.

**Success Criteria** (what must be TRUE):
  1. The bot can complete a tool-use turn end-to-end against any of the six providers without code branches outside the provider adapter
  2. Onboarding presents the model picker as a list (not a grid) with capability chips (vision / cached / local) per row; local Ollama auto-detected at startup populates from `/api/tags`
  3. Prompt caching is observably working per provider (Anthropic `cache_control`, OpenAI auto-cached prefix, Gemini implicit / explicit, OpenRouter sticky routing); cache-hit rate is logged for verification
  4. Every tool-call response from every provider is re-validated against the original Zod schema before dispatch; a malformed Gemini response is rejected at the adapter boundary, never reaches the registry
  5. When the selected provider/model is unreachable or rate-limited, the bot surfaces a clear error in the chat log and does not silently stall

**Plans:** TBD

---

### Phase 15: In-Game Vision via prismarine-viewer

**Goal:** The bot can render its own POV via `prismarine-viewer` headless rendering, the LLM can invoke a `visualize` Zod action when the active provider supports vision, idle auto-render is opt-in per character with cost projection shown, and a custom line-of-sight helper handles non-full blocks, fluids, and entity bounding boxes correctly.

**Depends on:** Phase 14 (`capabilities.vision` flag must exist before `visualize` can conditionally register); Phase 13 (per-hour vision cap is enforced by the proxy)

**Requirements:** VIS-01, VIS-02, VIS-03, VIS-04, VIS-05, VIS-06, VIS-07, VIS-08

**Rationale:** Bot-POV via `prismarine-viewer` (not OS screen capture, not a Fabric mod) is the locked decision — eliminates macOS Screen Recording permission UX and the player-monitor privacy leak (Pitfall 9). The custom LOS helper (VIS-05) is mandatory because raw `bot.world.raycast` misses non-full blocks (slabs, signs, levers, fences, panes) and fluids per Pitfall 10. Idle auto-render defaults OFF and is paid-tier-only with cost projection — vision tokens are 10-100x text tokens and a single play session can burn the $5 pack on vision alone per Pitfall 8. The per-hour proxy cap (VIS-07) is the hard ceiling independent of credit balance. Modded textures in the viewer atlas are EXPLICITLY out of scope here — that lives in Phase 16.

**Success Criteria** (what must be TRUE):
  1. The LLM can call `visualize` and receive a fresh bot-POV PNG (downscaled to ≤512×512) as an image content block in its next turn — but only when the active provider's `capabilities.vision` is true
  2. When the active model is non-VLM, `visualize` is hidden from the action registry and idle auto-render is disabled (cannot be enabled)
  3. With idle auto-render enabled by the user, the bot only auto-attaches a render when within 16 blocks of its owner AND the custom LOS helper confirms clear sight (handles slabs, signs, levers, fences, panes, fluids, and entity bounding boxes correctly)
  4. Vision calls per hour are capped by the proxy for cloud-AI users; exceeding the cap returns a clear error, not a silent failure
  5. When the bot's chunks aren't loaded enough to render meaningfully, the bot says "I can't see clearly right now" rather than crashing or rendering a black frame

**Plans:** TBD
**UI hint:** yes

---

### Phase 16: Mod & Version Adapter Pipeline

**Goal:** A user can point Sei at a mods folder and receive a reviewable adapter (knowledge summary + per-action declarative recipes + flagged un-mappable items + extracted modded textures folded into the prismarine-viewer atlas) generated by a keybind-scan → LLM-filter → LLM-recipe-writer pipeline that produces DATA, never code.

**Depends on:** None architecturally (independent of cloud stack); benefits from Phase 14 (uses whichever provider the user prefers for ingestion LLM calls) and Phase 15 (modded textures plug into the prismarine-viewer atlas built in Phase 15)

**Requirements:** MOD-01, MOD-02, MOD-03, MOD-04, MOD-05, MOD-06, MOD-07, MOD-08, MOD-09, MOD-10, MOD-11, MOD-12

**Rationale (last in queue, most architecturally tensioned):** This phase is the only one that touches the closed-action-registry invariant, so it ships last after the rest of the stack is stable. The locked-decision pipeline (keybind-scan → LLM filter drops irrelevant keybinds → LLM recipe writer emits declarative mappings to EXISTING closed-registry handlers → Zod-validated → human-reviewed) preserves the invariant: adapters are DATA (handler name + arg recipe), never code. **Foundation already exists:** `src/main/modScanner.ts` (shipped with v0.1.1 quick/260518-o1k as part of the launcher-isolation work) already parses `fabric.mod.json` + `META-INF/mods.toml` and resolves MC-version constraints; Phase 16 extends this scanner with item-registry / lang-string / keybind extraction rather than rewriting from scratch. Per Pitfall 3, a grep for `eval|new Function|vm\.` in the adapter code path must return zero hits. Bot restart is required to pick up new adapters (no in-flight registry mutation per anti-pattern A.4). Modded texture extraction (MOD-10) folds into the prismarine-viewer atlas built in Phase 15 — this is what makes bot-POV renders reflect the modded world. Items that cannot map to existing handlers are flagged "known but not invokable" in the review UI (deferred to a v1.x security-review phase per the Future Requirements list).

**Success Criteria** (what must be TRUE):
  1. A user can point Sei at a mods folder, trigger ingestion, and see a streaming progress UI as jars are scanned, items diffed against vanilla baseline, and the LLM filter + recipe writer run
  2. The review UI presents the proposed mod adapter (knowledge summary + per-action recipes + un-mappable items flagged "known but not invokable") with per-item accept/reject; rejected items never persist
  3. After bot restart, accepted recipes register *after* the built-in registry and the bot can invoke them; the closed-registry invariant is preserved (no `eval`, no `new Function`, no `vm.*`, no dynamic `require` anywhere in the adapter code path)
  4. Modded block and item textures extracted from mod jars (and optionally from a user-selected resource pack) appear correctly in bot-POV renders generated by Phase 15's `visualize`
  5. The confidence/coverage indicator honestly shows what % of detected mod actions were successfully mapped vs flagged un-invokable

**Plans:** TBD
**UI hint:** yes

---

## Progress Table

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 18. Auth Foundation | 0/0 | Not started | — |
| 19. Cloud Character Library | 0/0 | Not started | — |
| 20. Character Sharing UI + Moderation | 0/0 | Not started | — |
| 21. AI Proxy + Billing + Usage UI | 0/0 | Not started | — |
| 22. Multi-Provider Model Abstraction | 0/0 | Not started | — |
| 23. In-Game Vision via prismarine-viewer | 0/0 | Not started | — |
| 24. Mod & Version Adapter Pipeline | 0/0 | Not started | — |

## Coverage Verification

All 67 v1.0 requirements mapped to exactly one phase — no orphans, no duplicates.

| Category | Count | Phase |
|----------|-------|-------|
| AUTH-01..07 | 7 | Phase 10 |
| LIB-01..07 | 7 | Phase 11 |
| SHARE-01..10 | 10 | Phase 12 |
| PROXY-01..13 | 13 | Phase 13 |
| PROV-01..10 | 10 | Phase 14 |
| VIS-01..08 | 8 | Phase 15 |
| MOD-01..12 | 12 | Phase 16 |
| **Total** | **67** | — |

## Critical Path

```
Phase 10 (Auth) ─────────────────────────────────────┐
   └─gates─► Phase 11 (Cloud Library)                │
                └─gates─► Phase 12 (Sharing)         │
   └─gates─► Phase 13 (Proxy) — ships baseURL first  │
                └─re-touches in─► Phase 14 (Multi-Provider)
                                       └─gates─► Phase 15 (Vision)
Phase 16 (Mod Adapter) — independent; runs last; uses Phase 15 atlas
```

**Critical path to revenue:** 18 → 21 (baseURL override) → 22 → 23

**Why Phase 13 before Phase 14:** the baseURL override in `anthropicClient.js` is ~10 lines and lets revenue validate while the full provider abstraction is being built. Phase 13 explicitly plans two sub-deliveries: (a) baseURL override, (b) re-touch as `LlmProvider` variant after Phase 14 lands.

**Why Phase 15 after Phase 14:** `capabilities.vision` must exist as a flag before `visualize` can conditionally register without hardcoded provider checks.

**Why Phase 16 last:** it is the only phase that tensions the closed-action-registry invariant; safest to ship after the rest of the stack is stable. Also depends on Phase 15's atlas for modded texture rendering.
