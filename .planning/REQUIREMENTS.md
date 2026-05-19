# Requirements: Sei v1.0

**Milestone:** v1.0 — Commercializable MVP
**Defined:** 2026-05-19
**Core Value:** A Minecraft companion that feels like a real character — it remembers you, reacts to the world, and acts with personality, not like a scripted bot.

**Milestone goal:** Promote Sei from a working local prototype (v0.1.1) to a commercializable MVP — accounts, shared character library, hosted AI billing, broader model support, vision, and universal Minecraft compatibility.

**Locked decisions (research → user):**
- **Payments platform:** Lemon Squeezy as Merchant of Record (handles VAT, accepts individual seller — solves the no-business-entity constraint). "Form LLC before scale" is a roadmap-deferred note, not a v1.0 blocker.
- **Vision capture:** Bot-POV via `prismarine-viewer` headless renderer. No OS screen capture, no Fabric mod for vision.
- **Mod adapter pipeline:** Keybind scan → LLM filter (drop irrelevant like minimap/waypoints) → LLM "recipe writer" mapping each surviving action to existing closed-registry handlers → declarative recipes only. No code execution from generated content.
- **Cloud sync scope:** Character *definition* (persona, prompt, skin, portrait) is cloud-authoritative. Runtime memory (`OWNER.md`, `DIARY.md`) stays local-only.
- **Hosting:** Supabase (DB + Auth + Storage) free tier; thin Node proxy on Fly.io (not Vercel). Vercel-flavored anything is off the table.

---

## v1.0 Requirements

### Auth (AUTH)

- [ ] **AUTH-01**: User can sign up / sign in with email + password via Supabase Auth
- [ ] **AUTH-02**: User can sign in with Google via system browser + 127.0.0.1 loopback + PKCE (Google forbids BrowserWindow OAuth)
- [ ] **AUTH-03**: Session tokens persist between launches via Electron `safeStorage`; Linux fallback to `basic_text` is surfaced as a one-time warning
- [ ] **AUTH-04**: "Continue without account" is a first-class path on first launch — the local-only experience from v0.1.1 must remain available without signing in
- [ ] **AUTH-05**: Sign out clears cloud session but does not delete local character files, local memory, or locally-cached character definitions
- [ ] **AUTH-06**: User can delete their account from the app; deletion purges Supabase rows and Storage objects within 30 days
- [ ] **AUTH-07**: User can export their cloud data (characters + sharing metadata) as a JSON download

### Cloud Character Library (LIB)

- [ ] **LIB-01**: Character definition (name, description, system prompt, skin PNG, portrait image) is stored in Supabase (Postgres rows + Storage blobs), not in user memory files
- [ ] **LIB-02**: Character runtime memory (`OWNER.md`, `DIARY.md`, in-session context) stays in local `<userData>/memory/<id>/` and is never synced to the cloud
- [ ] **LIB-03**: On first sign-in, existing v0.1.1 local characters are offered for one-shot migration to the cloud (user confirms which to upload)
- [ ] **LIB-04**: Cloud characters are cached locally in the existing `characters/<id>.json` + `skins/<id>.png` format so the bot can run offline against any character the user has already opened
- [ ] **LIB-05**: User can create / edit / delete characters from the GUI; changes write through to Supabase and refresh the local cache
- [ ] **LIB-06**: Privacy policy and Terms of Service are live and accepted on first sign-in before any cloud write
- [ ] **LIB-07**: Character creation/edit flow accepts skin upload (validated PNG, dimension/size limits) and portrait image (validated image, dimension/size limits)

### Character Sharing (SHARE)

- [ ] **SHARE-01**: Characters page is split into two tabs — **Home** (my characters + recently used) and **Browse** (all public, with search)
- [ ] **SHARE-02**: Browse supports text search across character name and description
- [ ] **SHARE-03**: Browse displays each public character as a card with avatar, skin chip, name, short description, and creator attribution
- [ ] **SHARE-04**: From Browse, user can preview a character and "Add to Mine" — downloads the full definition into their local library
- [ ] **SHARE-05**: User can toggle their own characters between private (default) and public; making a character public requires an explicit content-policy confirmation
- [ ] **SHARE-06**: Public uploads pass an automated CSAM scan on every image (skin + portrait) before being published
- [ ] **SHARE-07**: Public uploads run the system prompt through a prompt-moderation filter at upload time; flagged prompts block publication with an actionable error
- [ ] **SHARE-08**: Every public character has a Report button that submits to a moderation queue
- [ ] **SHARE-09**: DMCA agent is registered (US Copyright Office, ~$6 online) and DMCA contact is published in app + ToS before Browse goes live
- [ ] **SHARE-10**: Public character listings show last-updated time and (later) creator attribution; creator profiles are out of scope for v1.0

### AI Proxy + Billing (PROXY)

- [ ] **PROXY-01**: User can purchase a $5 one-time credit pack from inside the app; checkout opens Lemon Squeezy via `shell.openExternal`
- [ ] **PROXY-02**: User can purchase a $20/month subscription from inside the app; checkout opens Lemon Squeezy via `shell.openExternal`
- [ ] **PROXY-03**: Lemon Squeezy webhooks credit the user's account in the Supabase ledger; ledger is FIFO for one-time grants; subscription renews monthly until cancelled
- [ ] **PROXY-04**: A "pricing / credits" icon sits above the settings icon in the main GUI; clicking opens the pricing/usage screen
- [ ] **PROXY-05**: Hovering the pricing icon shows a friendly % usage indicator — percent only, **no token counts** anywhere in the UI
- [ ] **PROXY-06**: Out of credits triggers a hard stop with a clear modal offering top-up or subscription; no silent failure or overage
- [ ] **PROXY-07**: A thin Node proxy (Hono on Fly.io) sits between the bot and Anthropic; the bot points its base URL at the proxy when cloud-AI mode is selected
- [ ] **PROXY-08**: Proxy authenticates every request via per-user JWT minted by Supabase; no shared secret
- [ ] **PROXY-09**: Proxy enforces token-bucket pre-deduction (reserve worst-case cost before forwarding) plus RPM cap, TPM cap, and daily $ cap per user — all four are launch gates
- [ ] **PROXY-10**: Proxy returns server-driven `remaining_pct` on each response; this is the only source of truth for the % bar
- [ ] **PROXY-11**: Local-API-key users (BYO Anthropic / OpenAI / etc.) never hit the proxy and never see the credits UI
- [ ] **PROXY-12**: Refund / cancellation policy is published in ToS before the first live charge
- [ ] **PROXY-13**: Lemon Squeezy product description is reviewed against Anthropic's API ToS before going live (framing: "proxied inference credits")

### Multi-Provider Model Support (PROV)

- [ ] **PROV-01**: Bot's LLM call site is refactored from direct `@anthropic-ai/sdk` use into an `LlmProvider` interface with `call()`, `buildCachedSystem()`, and a `capabilities` descriptor
- [ ] **PROV-02**: Provider adapters ship for: Anthropic, OpenAI, Gemini, xAI (Grok), OpenRouter, and any OpenAI-compatible local endpoint (Ollama, LM Studio, etc.)
- [ ] **PROV-03**: Prompt caching works correctly per provider where supported (Anthropic explicit `cache_control`, OpenAI auto-cached prefix, Gemini implicit on 2.5+ / explicit `CachedContent`, OpenRouter sticky-routing); cache hit rate is logged for verification
- [ ] **PROV-04**: Ollama is routed through the native `/api/chat` endpoint, not `/v1/chat/completions` — the OpenAI-compatible endpoint silently drops tool calls in streaming mode
- [ ] **PROV-05**: Every tool-call response from every provider is re-validated against the original Zod schema before dispatch; Gemini in particular silently drops schema constraints
- [ ] **PROV-06**: Per-provider golden test (one canonical prompt → expected tool call) runs in CI; per-provider $/hr benchmark is recorded
- [ ] **PROV-07**: Each provider exposes a `capabilities.vision` boolean; downstream features gate on this flag
- [ ] **PROV-08**: Onboarding model picker is presented as a **list** (not a grid), with capability chips (vision / cached / local) per row
- [ ] **PROV-09**: Local Ollama is auto-detected at startup (probe `localhost:11434`, populate dropdown from `/api/tags`)
- [ ] **PROV-10**: Graceful fallback when the selected provider/model is unreachable or rate-limited (clear error in chat log, no silent stall)

### In-Game Vision (VIS)

- [ ] **VIS-01**: Bot-POV rendering uses `prismarine-viewer` headless render driven by the bot's loaded chunk data; output is a PNG frame from the bot's eye position and look direction
- [ ] **VIS-02**: A `visualize` Zod action is added to the closed registry; the LLM can call it to request a fresh render and receive an image content block in its next turn
- [ ] **VIS-03**: Vision is gated by `capabilities.vision` on the active provider; when the active model is non-VLM, `visualize` is hidden from the action registry and idle auto-render is disabled
- [ ] **VIS-04**: When the active model is a VLM AND the bot is within 16 blocks of its owner AND there is a clear line of sight, the bot may auto-attach a render every idle tick (defaults OFF; explicit opt-in per character with a cost-projection warning)
- [ ] **VIS-05**: A custom line-of-sight helper is used (not raw `bot.world.raycast`) that correctly handles non-full blocks (slabs, signs, levers, fences, panes), fluids, and entity bounding boxes
- [ ] **VIS-06**: Renders are downscaled to a max of 512×512 before being sent to the LLM
- [ ] **VIS-07**: Vision calls are subject to a per-hour cap enforced by the proxy (cloud-AI users) to bound runaway cost
- [ ] **VIS-08**: Graceful degradation when the bot's chunks aren't loaded enough to render meaningfully ("I can't see clearly right now")

### Mod & Version Adapter (MOD)

- [ ] **MOD-01**: User can drop a mods folder (or point at one) and trigger a one-time ingestion run, similar to the v0.1.1 character-prompt-from-description flow
- [ ] **MOD-02**: Ingestion scans `.jar` files (existing `src/main/modScanner.ts` already parses `fabric.mod.json` + `META-INF/mods.toml` via in-house ZIP central-directory reader — extend rather than rewrite); extracts item registries, lang strings (`en_us.json`), keybinds, and recipes
- [ ] **MOD-03**: Modded items are diffed against the bundled vanilla baseline (`minecraft-data`) to isolate the new content
- [ ] **MOD-04**: A "filter" LLM call drops irrelevant keybinds (minimap, waypoint, FOV toggle, etc.) and surfaces only gameplay-relevant actions
- [ ] **MOD-05**: A "recipe writer" LLM call emits, for each surviving action, a declarative mapping to existing closed-registry handlers — output is DATA (handler name + arg recipe), never code
- [ ] **MOD-06**: Recipes are validated against a Zod schema for the recipe format; invalid recipes are rejected, not retried indefinitely
- [ ] **MOD-07**: A review UI presents the proposed mod adapter (knowledge summary + per-action recipes + un-mappable items flagged "known but not invokable"); user accepts or rejects per item
- [ ] **MOD-08**: Approved adapters persist as JSON under `<userData>/mod-adapters/<modpack-id>/`; bot restart is required to pick up new adapters
- [ ] **MOD-09**: Generated recipes load at bot start and register *after* the built-in registry; the closed-registry invariant is preserved (no code execution, no hot-loading of new code paths)
- [ ] **MOD-10**: Modded block and item textures are extracted from mod jars (`assets/<modid>/textures/...`) and (optional) from the player's selected resource pack zip(s); textures are repacked into the prismarine-viewer atlas so bot-POV renders reflect the modded world
- [ ] **MOD-11**: Mod knowledge summary (descriptions, item categories, playstyle notes) is injected into the system prompt as cached prefix content so the bot understands modded item names and can reference them in conversation
- [ ] **MOD-12**: Confidence / coverage indicator shows what % of detected mod actions were successfully mapped vs flagged un-invokable

---

## Future Requirements (Deferred)

Not in v1.0. Captured because they came up during research and deserve to be tracked.

- Cloud-synced runtime memory (`OWNER.md` / `DIARY.md`) — privacy + race conditions; keep local-only for v1.0
- Comments / likes / favorites on shared characters — moderation cost
- Creator profile pages and tag filters on Browse
- Streaming VLM (continuous vision) — cost prohibitive
- Multiple simultaneous bots per app instance
- AST-sandboxed mod adapter handlers for actions that don't reduce to vanilla mineflayer calls (Pixelmon battle moves, Refined Storage GUI interactions, Create wrench rotation, etc.) — gated behind a v1.x security-review phase
- Per-mod custom packet plugins (Pixelmon battle protocol, etc.) — surface as "known but not invokable" in v1.0 review UI; revisit in v1.x
- Form LLC + migrate from Lemon Squeezy MoR to direct Stripe — once revenue / volume justifies it
- Auto-updater for app distribution
- Trending / staff-picks row on Browse — solves cold-start discovery
- Per-character `recommended_model` hint
- Saliency-gated idle vision (new entity, owner moved >5 blocks) rather than time-gated
- Mac App Store / Microsoft Store submissions (changes IAP rules — direct-distribution only for v1.0)

## Out of Scope

Explicit exclusions for v1.0:

- **Player-POV screenshots / Fabric companion mod for vision** — replaced by bot-POV via prismarine-viewer (locked decision). PROJECT.md's earlier "OS-level window capture" wording is superseded.
- **Direct Stripe with personal account** — replaced by Lemon Squeezy as Merchant of Record. EU VAT from cent one + chargeback risk on a personal bank account is unacceptable pre-incorporation.
- **Cloud sync of bot runtime memory** — `OWNER.md` / `DIARY.md` and in-session context stay local. Cloud holds character *definition* only.
- **AST-sandboxed / hot-loaded LLM-generated handler code** — the closed-action-registry invariant is preserved by design. Adapters are data, not code.
- **Embedded BrowserWindow for OAuth** — Google blocks this. System browser + loopback + PKCE only.
- **Token counts in the usage UI** — the indicator is a friendly % bar, full stop. Token displays trigger the Cursor-pricing-change-2025 backlash pattern.
- **Hosted on Vercel-flavored infrastructure** — proxy lives on Fly.io.
- **Comments / social features on shared characters** — moderation cost too high for an indie launch.

---

## Traceability

Filled in by the roadmapper after phase decomposition. Each requirement maps to exactly one phase.

| REQ-ID | Phase |
|--------|-------|
| AUTH-01 | Phase 10 |
| AUTH-02 | Phase 10 |
| AUTH-03 | Phase 10 |
| AUTH-04 | Phase 10 |
| AUTH-05 | Phase 10 |
| AUTH-06 | Phase 10 |
| AUTH-07 | Phase 10 |
| LIB-01 | Phase 11 |
| LIB-02 | Phase 11 |
| LIB-03 | Phase 11 |
| LIB-04 | Phase 11 |
| LIB-05 | Phase 11 |
| LIB-06 | Phase 11 |
| LIB-07 | Phase 11 |
| SHARE-01 | Phase 12 |
| SHARE-02 | Phase 12 |
| SHARE-03 | Phase 12 |
| SHARE-04 | Phase 12 |
| SHARE-05 | Phase 12 |
| SHARE-06 | Phase 12 |
| SHARE-07 | Phase 12 |
| SHARE-08 | Phase 12 |
| SHARE-09 | Phase 12 |
| SHARE-10 | Phase 12 |
| PROXY-01 | Phase 13 |
| PROXY-02 | Phase 13 |
| PROXY-03 | Phase 13 |
| PROXY-04 | Phase 13 |
| PROXY-05 | Phase 13 |
| PROXY-06 | Phase 13 |
| PROXY-07 | Phase 13 |
| PROXY-08 | Phase 13 |
| PROXY-09 | Phase 13 |
| PROXY-10 | Phase 13 |
| PROXY-11 | Phase 13 |
| PROXY-12 | Phase 13 |
| PROXY-13 | Phase 13 |
| PROV-01 | Phase 14 |
| PROV-02 | Phase 14 |
| PROV-03 | Phase 14 |
| PROV-04 | Phase 14 |
| PROV-05 | Phase 14 |
| PROV-06 | Phase 14 |
| PROV-07 | Phase 14 |
| PROV-08 | Phase 14 |
| PROV-09 | Phase 14 |
| PROV-10 | Phase 14 |
| VIS-01 | Phase 15 |
| VIS-02 | Phase 15 |
| VIS-03 | Phase 15 |
| VIS-04 | Phase 15 |
| VIS-05 | Phase 15 |
| VIS-06 | Phase 15 |
| VIS-07 | Phase 15 |
| VIS-08 | Phase 15 |
| MOD-01 | Phase 16 |
| MOD-02 | Phase 16 |
| MOD-03 | Phase 16 |
| MOD-04 | Phase 16 |
| MOD-05 | Phase 16 |
| MOD-06 | Phase 16 |
| MOD-07 | Phase 16 |
| MOD-08 | Phase 16 |
| MOD-09 | Phase 16 |
| MOD-10 | Phase 16 |
| MOD-11 | Phase 16 |
| MOD-12 | Phase 16 |

---

*Last updated: 2026-05-19 — v1.0 requirements drafted from research synthesis + user decisions on vision POV (bot-POV via prismarine-viewer) and mod adapter safety model (declarative keybind-driven recipes).*
