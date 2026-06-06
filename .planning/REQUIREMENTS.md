# Requirements: Sei v1.0 (Client)

**Milestone:** v1.0 — Commercializable MVP
**Defined:** 2026-05-19 · **Last updated:** 2026-06-06
**Core Value:** A Minecraft companion that feels like a real character — it remembers you, reacts to the world, and acts with personality, not like a scripted bot.

**Milestone goal:** Promote Sei from a working local prototype (v0.1.1) to a commercializable MVP — accounts, a shared character library, hosted AI billing, broader model support, in-game vision, and universal Minecraft compatibility.

> **Scope:** This file tracks **client** requirements (the desktop launcher, bot runtime, and GUI). The hosted cloud backend — proxy server, auth/billing/moderation infrastructure, database schema, edge functions — lives in a separate private repo; see [Cloud Backend](#cloud-backend-private-repo) below.

**Locked decisions:**
- **Vision capture:** Bot-POV via `prismarine-viewer` headless renderer. No OS screen capture, no Fabric mod for vision.
- **Mod adapter pipeline:** Keybind/item scan → LLM filter → LLM "recipe writer" mapping each surviving action to existing closed-registry handlers → declarative recipes only. No code execution from generated content.
- **Cloud sync scope:** Character *definition* (persona, prompt, skin, portrait) is cloud-authoritative. Runtime memory (`OWNER.md`, `DIARY.md`) stays local-only.
- **Auth:** System browser + 127.0.0.1 loopback + PKCE for OAuth (embedded BrowserWindow OAuth is off the table).

---

## v1.0 Client Requirements

### Auth (AUTH)

- [x] **AUTH-01**: User can sign up / sign in with email + password
- [x] **AUTH-02**: User can sign in with Google via system browser + 127.0.0.1 loopback + PKCE (no embedded BrowserWindow OAuth)
- [x] **AUTH-03**: Session tokens persist between launches via Electron `safeStorage`; the Linux `basic_text` fallback is surfaced as a one-time warning
- [x] **AUTH-04**: "Continue without account" is a first-class path on first launch — the local-only experience from v0.1.1 remains available without signing in
- [x] **AUTH-05**: Sign out clears the cloud session but does not delete local character files, local memory, or locally-cached character definitions
- [x] **AUTH-06**: User can delete their account from the app; deletion purges cloud rows and storage objects within the documented window
- [x] **AUTH-07**: User can export their cloud data (characters + sharing metadata) as a JSON download

### Cloud Character Library (LIB)

- [x] **LIB-01**: Character definition (name, description, system prompt, skin PNG, portrait image) is stored in the cloud, not in local memory files
- [x] **LIB-02**: Character runtime memory (`OWNER.md`, `DIARY.md`, in-session context) stays in local `<userData>/memory/<id>/` and is never synced to the cloud
- [x] **LIB-03**: On first sign-in, existing v0.1.1 local characters are offered for one-shot migration to the cloud (user confirms which to upload)
- [x] **LIB-04**: Cloud characters are cached locally in the existing `characters/<id>.json` + `skins/<id>.png` format so the bot can run offline against any character the user has already opened
- [x] **LIB-05**: User can create / edit / delete characters from the GUI; changes write through to the cloud and refresh the local cache
- [x] **LIB-06**: Privacy Policy and Terms of Service are accepted on first sign-in before any cloud write
- [x] **LIB-07**: Character creation/edit flow accepts a validated skin PNG (dimension/size limits) and a validated portrait image (dimension/size limits)

### Character Sharing (SHARE)

- [x] **SHARE-01**: Characters page is split into two tabs — **Home** (mine + recently used) and **Browse** (all public, with search)
- [x] **SHARE-02**: Browse supports text search across character name and description
- [x] **SHARE-03**: Browse displays each public character as a card with avatar, skin chip, name, short description, and creator attribution
- [x] **SHARE-04**: From Browse, user can preview a character and "Add to Mine" — downloads the full definition into their local library
- [x] **SHARE-05**: User can toggle their own characters between private (default) and public; making one public requires an explicit content-policy confirmation
- [x] **SHARE-06**: Public uploads are gated on the backend image-moderation scan (skin + portrait); the client blocks publication on a flagged verdict
- [x] **SHARE-07**: Public uploads are gated on the backend prompt-moderation scan at upload time; a flagged prompt blocks publication with an actionable error in the client
- [x] **SHARE-08**: Every public character has a Report button that submits to the moderation queue
- [x] **SHARE-09**: The DMCA contact is published in-app and in the ToS before Browse goes live
- [x] **SHARE-10**: Public character listings show last-updated time and creator attribution; creator profiles are out of scope for v1.0

### AI Billing + Cloud-AI Routing (PROXY)

*Client-side requirements for the cloud-AI path. The proxy server that enforces auth, rate limits, and spend caps is in the private backend repo.*

- [x] **PROXY-01**: User can purchase a one-time credit pack from inside the app; checkout opens in the browser via `shell.openExternal`
- [x] **PROXY-02**: User can purchase a monthly subscription from inside the app; checkout opens in the browser via `shell.openExternal`
- [x] **PROXY-03**: After a successful purchase, the in-app balance reflects the grant within seconds
- [x] **PROXY-04**: A "pricing / credits" icon sits above the settings icon in the main GUI; clicking it opens the pricing/usage screen
- [x] **PROXY-05**: The usage indicator shows a friendly % only — **no token counts** anywhere in the UI
- [x] **PROXY-06**: Running out of credits triggers a hard stop with a clear modal offering top-up or subscription; no silent failure or overage
- [x] **PROXY-07**: When cloud-AI mode is selected, the bot points its base URL at the hosted proxy (`api.sei.gg`) instead of calling the provider directly
- [x] **PROXY-08**: The client authenticates every proxied request with a per-user token from the signed-in session
- [x] **PROXY-09**: The client surfaces the proxy's rate-limit / spend-cap responses to the user (clear error, no silent stall)
- [x] **PROXY-10**: The % usage bar is driven solely by the server-returned remaining-percentage on each response
- [x] **PROXY-11**: Local-API-key users (BYO Anthropic / OpenAI / etc.) never hit the proxy and never see the credits UI
- [x] **PROXY-12**: Refund / cancellation policy is published in the ToS before the first live charge
- [x] **PROXY-13**: The product/billing copy is reviewed against the upstream provider's API ToS before going live ("proxied inference credits" framing)

### Multi-Provider Model Support (PROV)

- [x] **PROV-01**: The bot's LLM call site is an `LlmProvider` interface with `call()`, cached-system construction, and a `capabilities` descriptor
- [x] **PROV-02**: Provider adapters ship for Anthropic, OpenAI, Gemini, xAI (Grok), OpenRouter, and OpenAI-compatible local endpoints (Ollama, LM Studio, etc.)
- [ ] **PROV-03**: Prompt caching works per provider where supported, and cache-hit rate is logged for verification *(deferred to backlog — see Phase 14 reduced scope)*
- [x] **PROV-04**: Ollama is routed through the native `/api/chat` endpoint, not `/v1/chat/completions` (the OpenAI-compatible endpoint silently drops tool calls in streaming mode)
- [ ] **PROV-05**: Every tool-call response is re-validated against the original Zod schema before dispatch *(deferred to backlog)*
- [ ] **PROV-06**: Per-provider golden test + per-provider $/hr benchmark in CI *(deferred to backlog)*
- [x] **PROV-07**: Each provider exposes a `capabilities.vision` boolean; downstream features gate on this flag
- [ ] **PROV-08**: Onboarding model picker is presented as a list (not a grid), with capability chips per row *(deferred to backlog)*
- [x] **PROV-09**: Local Ollama is auto-detected at startup (probe local endpoint, populate from `/api/tags`)
- [x] **PROV-10**: Graceful fallback when the selected provider/model is unreachable or rate-limited (clear error in chat log, no silent stall)

### In-Game Vision (VIS) — active

- [ ] **VIS-01**: Bot-POV rendering uses a `prismarine-viewer` headless render driven by the bot's loaded chunk data; output is a PNG from the bot's eye position and look direction
- [ ] **VIS-02**: A `visualize` Zod action is added to the closed registry; the LLM can call it to request a fresh render and receive an image content block in its next turn
- [ ] **VIS-03**: Vision is gated by `capabilities.vision` on the active provider; when the active model is non-VLM, `visualize` is hidden from the registry and idle auto-render is disabled
- [ ] **VIS-04**: When the active model is a VLM AND the bot is within 16 blocks of its owner AND there is clear line of sight, the bot may auto-attach a render every idle tick (defaults OFF; explicit per-character opt-in with a cost-projection warning)
- [ ] **VIS-05**: A custom line-of-sight helper is used (not raw `bot.world.raycast`) that correctly handles non-full blocks (slabs, signs, levers, fences, panes), fluids, and entity bounding boxes
- [ ] **VIS-06**: Renders are downscaled to a max of 512×512 before being sent to the LLM
- [ ] **VIS-07**: Vision calls are subject to a per-hour cap enforced by the proxy (cloud-AI users) to bound runaway cost
- [ ] **VIS-08**: Graceful degradation when the bot's chunks aren't loaded enough to render meaningfully ("I can't see clearly right now")

### Mod & Version Adapter (MOD) — not started

- [ ] **MOD-01**: User can point Sei at a mods folder and trigger a one-time ingestion run
- [ ] **MOD-02**: Ingestion scans `.jar` files (extends the existing `src/main/modScanner.ts`, which already parses `fabric.mod.json` + `META-INF/mods.toml`); extracts item registries, lang strings (`en_us.json`), keybinds, and recipes
- [ ] **MOD-03**: Modded items are diffed against the bundled vanilla baseline (`minecraft-data`) to isolate the new content
- [ ] **MOD-04**: A "filter" LLM call drops irrelevant keybinds (minimap, waypoint, FOV toggle, etc.) and surfaces only gameplay-relevant actions
- [ ] **MOD-05**: A "recipe writer" LLM call emits, per surviving action, a declarative mapping to existing closed-registry handlers — output is DATA (handler name + arg recipe), never code
- [ ] **MOD-06**: Recipes are validated against a Zod schema; invalid recipes are rejected, not retried indefinitely
- [ ] **MOD-07**: A review UI presents the proposed adapter (knowledge summary + per-action recipes + un-mappable items flagged "known but not invokable"); user accepts or rejects per item
- [ ] **MOD-08**: Approved adapters persist as JSON under `<userData>/mod-adapters/<modpack-id>/`; bot restart is required to pick up new adapters
- [ ] **MOD-09**: Generated recipes load at bot start and register *after* the built-in registry; the closed-registry invariant is preserved (no code execution, no hot-loading of code paths)
- [ ] **MOD-10**: Modded block/item textures are extracted from jars (`assets/<modid>/textures/...`) and optionally from the player's selected resource pack(s), then repacked into the `prismarine-viewer` atlas so bot-POV renders reflect the modded world
- [ ] **MOD-11**: A mod knowledge summary is injected into the system prompt as cached prefix content so the bot understands modded item names and can reference them in conversation
- [ ] **MOD-12**: A confidence / coverage indicator shows what % of detected mod actions were successfully mapped vs flagged un-invokable

---

## Cloud Backend (Private Repo)

Server-side requirements — the proxy server, Supabase auth/database/storage, edge functions, billing, and image/prompt moderation pipelines — are **tracked in the private `sei-proxy` repo**, not here. This client integrates with that backend over HTTPS at `api.sei.gg`; the requirements above describe only the client side of that integration (routing, UI, gating on server verdicts).

---

## Future Requirements (Deferred)

Not in v1.0. Captured because they came up during research.

- Cloud-synced runtime memory (`OWNER.md` / `DIARY.md`) — privacy + race conditions; keep local-only for v1.0
- Comments / likes / favorites on shared characters — moderation cost
- Creator profile pages and tag filters on Browse
- Streaming VLM (continuous vision) — cost prohibitive
- Multiple simultaneous bots per app instance
- Sandboxed mod-adapter handlers for actions that don't reduce to vanilla mineflayer calls — gated behind a v1.x security-review phase
- Per-mod custom packet plugins — surfaced as "known but not invokable" in the v1.0 review UI; revisit in v1.x
- Trending / staff-picks row on Browse
- Per-character `recommended_model` hint
- Saliency-gated idle vision (new entity, owner moved >5 blocks) rather than time-gated
- Mac App Store / Microsoft Store submissions (changes IAP rules — direct-distribution only for v1.0)
- The deferred PROV-03/05/06/08 items above (per-provider caching observability, Zod re-validation at the adapter boundary, $/hr CI benchmark, list-style model picker)

## Out of Scope

Explicit exclusions for v1.0:

- **Player-POV screenshots / Fabric companion mod for vision** — replaced by bot-POV via `prismarine-viewer` (locked decision)
- **Cloud sync of bot runtime memory** — `OWNER.md` / `DIARY.md` and in-session context stay local; the cloud holds character *definition* only
- **Hot-loaded / LLM-generated handler code** — the closed-action-registry invariant is preserved by design; adapters are data, not code
- **Embedded BrowserWindow for OAuth** — system browser + loopback + PKCE only
- **Token counts in the usage UI** — the indicator is a friendly % bar, full stop
- **Comments / social features on shared characters** — moderation cost too high for an indie launch

---

## Traceability

Each requirement maps to exactly one phase.

| Category | Count | Phase |
|----------|-------|-------|
| AUTH-01..07 | 7 | Phase 10 |
| LIB-01..07 | 7 | Phase 11 |
| SHARE-01..10 | 10 | Phase 12 |
| PROXY-01..13 | 13 | Phase 13 |
| PROV-01..10 | 10 | Phase 14 |
| VIS-01..08 | 8 | Phase 15 |
| MOD-01..12 | 12 | Phase 16 |

---

*Last updated: 2026-06-06 — split client vs cloud-backend requirements; server internals moved to the private repo. PROV deferred items reflect Phase 14 reduced scope.*
