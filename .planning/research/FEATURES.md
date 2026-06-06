# Feature Research — Sei v1.0 New Capabilities

**Domain:** Minecraft AI companion (Electron desktop app + mineflayer)
**Researched:** 2026-05-19
**Confidence:** MEDIUM-HIGH (verified against character.ai, Cursor, Poe, Replit, Mindcraft, Voyager, Anthropic/OpenAI/Gemini docs)

This document is scoped to the seven NEW capabilities for v1.0 listed in `.planning/MILESTONES.md`. Existing v0.1.1 features (Electron onboarding, OWNER.md/DIARY.md memory, Haiku reasoning, Zod actions, custom skins) are treated as fixed substrate.

---

## Feature 1 — Cloud Character Library (image, skin, desc/prompt)

Domain: character.ai-style shareable definitions. Sits beside, not on top of, the existing OWNER.md/DIARY.md memory (which stays per-user-local).

### Table Stakes

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Character record = `{id, name, avatar_image, skin_file_ref, short_desc, long_prompt, creator_id, created_at, updated_at}` | Standard c.ai data model | LOW | Maps cleanly onto current `persona` config; long_prompt is what v0.1.1 already calls personality |
| Avatar image (separate from skin) | Browse grids need a 2D thumbnail; the in-game skin is not browsable as an image | LOW-MEDIUM | Two assets, not one. Skin is `.png` 64x64 Minecraft format; avatar is arbitrary square crop |
| Edit own character / delete own character | Users assume CRUD on their own creations | LOW | Soft-delete recommended so shared references don't 404 |
| Visibility flag: `public` vs `unlisted` vs `private` | c.ai pattern; safety valve for users still iterating | LOW | Public = appears in Browse; unlisted = direct link only; private = only creator sees in their Home |
| Creator attribution on the character card | "Made by @username"; standard c.ai pattern | LOW | Don't strip on remix/copy — surfaces trust |
| Update existing local v0.1.1 persona → cloud character (migration on first sign-in) | v0.1.1 users have characters defined in `config.json`; not migrating loses them | MEDIUM | One-shot import flow during the auth phase |

### Differentiators

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Skin auto-paired with character | c.ai only has 2D avatars; Sei characters embody both 2D avatar + in-game skin | LOW | Big differentiator — make it obvious in browse UI ("preview in-world") |
| Per-character recommended model hint | Creator can tag "best with Haiku" / "needs vision" | LOW | Helps users avoid disappointment with cheap-model + complex-persona combos |
| Versioned character definitions | Edit doesn't break in-flight sessions / other users' chats | MEDIUM | c.ai is criticized when creator edits break existing chats. Defer to v1.1 |

### Anti-Features

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Cloud-synced memory (OWNER.md / DIARY.md in DB) | "Continue conversations across devices" | Memory is intimate + personal; mixing it with the public character DB invites privacy bugs, GDPR scope creep, moderation requests, and conflicts with the per-user-local v0.1.1 commitment | **Definition** in cloud DB; **memory** stays local-only. Document this boundary in the README |
| Real-time character editor with live preview | Power-user feature | Most users never get past the initial prompt | Plain text + Save. Match c.ai's minimal creation form |
| Comments / replies / DMs on characters | "Make it social" | Pulls product into moderation hell; c.ai itself only ships ratings, not comments | Star/rating only |
| Multi-author / "fork" semantics | GitHub mental model | Creates ownership disputes and confuses casual users | Single creator; users can "Remix" which creates a new independent record with attribution to the original |

**Dependencies on v0.1.1:** Existing character flow lives in onboarding (`config.json` per install). Cloud library replaces this as the source of truth once a user signs in, but local-only mode must still work without cloud (a "Local Character" option that skips the library). This is the main conflict surface — needs requirements clarity.

---

## Feature 2 — Email/Password + Google Auth in Electron (Optional)

### Table Stakes

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Email + password signup | Universal baseline | LOW (with managed auth provider like Clerk/Supabase/Auth0) | Roll-your-own auth is malpractice in 2026 |
| Google sign-in via **system browser + loopback redirect** (NOT embedded WebView) | Google deprecated OAuth in embedded browsers including Electron's Chromium for `accounts.google.com` flows | MEDIUM | Open default browser → user authenticates → redirect to `http://127.0.0.1:<random_port>/callback` → ephemeral local HTTP server captures the code → PKCE exchange |
| "Continue without an account" / Local-only mode | Stated v1.0 requirement; many users will refuse cloud | LOW | But must gate Browse/Sharing/Proxy behind sign-in clearly |
| Password reset email | Table stakes; users WILL forget | LOW | Free if using managed auth |
| Session persistence across app restarts | Otherwise feels broken | LOW | Encrypted token storage via `electron-store` + `safeStorage` (OS keychain) |
| Sign-out | Required for shared-machine users | LOW | Wipe local token + clear cached library data |

### Differentiators

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Single-click Google as primary CTA | Most users prefer it; lowers conversion friction | LOW | But email/pw must remain visible — some users won't link Google to a game |
| Account-linking later ("I started local, now want to sync") | Respects the user's journey | MEDIUM | Defer to v1.1 unless a one-shot importer is trivial |

### Anti-Features

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Embedded BrowserWindow for Google OAuth | Looks cleaner / "doesn't switch apps" | Google blocks it; users see `disallowed_useragent` and conclude the app is broken | System browser + `127.0.0.1` loopback. This is the IETF RFC 8252 recommendation and Google's only supported desktop flow |
| Device-code flow ("go to google.com/device, enter ABCD-1234") | Feels secure | Janky for a desktop app — copy/paste between two apps. Acceptable for CLI, wrong for Electron | Loopback redirect is more native |
| Magic-link only (no password) | Slack/Notion pattern | Adds 30+ seconds for every sign-in on a new device; users expect a password as fallback | Offer both |
| "Sign in with Minecraft / Microsoft" | Topical | Microsoft auth is for game ownership, not app accounts. Mixing them creates confusion about which account owns what data | Separate concerns; Sei auth is independent of MC login |

**Flow that feels native (verified pattern):**
1. User clicks "Sign in with Google"
2. App spawns local HTTP server on random port, generates PKCE verifier
3. `shell.openExternal()` opens `accounts.google.com/o/oauth2/v2/auth?...&redirect_uri=http://127.0.0.1:<port>/cb`
4. User authenticates in Chrome/Safari
5. Google redirects to local server → server captures code, shows a "You can close this tab" page
6. App exchanges code for tokens via PKCE
7. Electron window auto-focuses (`app.focus({ steal: true })`)

Total perceived time: 5-10 seconds, no app feels janky.

---

## Feature 3 — Character Sharing (Home vs Browse, c.ai-style)

### Table Stakes

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Two-tab nav: **Home** (mine + recent) and **Browse** (all + search) | Direct c.ai mirror; users have been trained on it | LOW | Home = "characters I created" + "characters I've used recently" (last N from local play history) |
| Grid of cards: avatar + name + 1-line desc + creator handle | Standard discovery UI | LOW | Card must show the in-game skin somehow — small preview chip or hover-swap |
| Free-text search across name + desc | Anything else feels broken | LOW | Fuzzy + case-insensitive; server-side via Postgres `ILIKE` or `pg_trgm` is fine at scale <100k |
| "Add to My Characters" / "Use" button on each card | The point of Browse | LOW | One click → it appears in Home, ready to spawn |
| Recently used / Recent activity on Home | c.ai users expect this | LOW | Pull from local play history |
| Report button | Required for any public sharing surface; legal/safety baseline | LOW | Stub it to email/discord initially; full moderation pipeline can wait |

### Differentiators

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| In-world preview on hover (rotating skin) | c.ai doesn't have a "3D preview"; Minecraft characters do | MEDIUM | Use a small `skinview3d` (three.js) widget — well-known library |
| Trending / staff picks row on Browse | Solves cold-start: most users don't know what to look for | LOW | Even hand-curated for the first 100 launches is fine |
| Tag filters (genre/tone, e.g. "friendly", "chaotic", "lore-keeper") | c.ai pattern; helps discovery | LOW-MEDIUM | Optional creator-set tags |

### Anti-Features

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Public global chat / DMs between users | "Make it social" | Moderation cost is enormous; off-mission | Discord link in app |
| Star ratings / reviews | Sounds useful | Low signal at small scale; c.ai's 1-4 star rating is internal feedback for the model, not a public rating | Use plays/saves count instead |
| Trending algorithm based on engagement metrics | "Like TikTok" | Premature optimization; gameable | Sort by recent + saves count; hand-curate Featured |
| Pre-launch moderation queue | "Be safe by default" | Will choke the creator pipeline | Post-launch moderation + Report flow + automated profanity check on name/desc only |

**Moderation surface (table stakes):**
- Profanity filter on character `name` and `short_desc` only (prompt body is harder to filter — c.ai itself has been sued over this; for v1.0 ship a post-hoc moderation queue triggered by report count)
- Report button → email/Discord webhook → manual review
- Creator account flag → can be silenced/hidden
- TOS prohibits minor/illegal content (cite character.ai's policy for language)

**What users try first (verified via c.ai discussions):**
1. Search for famous IPs (Naruto, Steve, Herobrine) — be ready for trademark complaints
2. Try to find their friend's character via creator name — make creator profile pages or at least filter by creator
3. Save a character then look for it later → MUST be in Home with one tap

**What gets reported as broken when missing (from c.ai forum signal):**
- "Search doesn't work" — fuzzy + recently-seen suggestions are critical
- "I can't find my character" — Home must show all `mine` regardless of activity
- "It removed my bot without telling me" — soft-delete + explicit moderation messages

---

## Feature 4 — Paid AI Proxy ($5 one-time / $20/month) with Friendly % Usage UX

### Table Stakes

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Stripe checkout (one-time + recurring) | Universal; trusted UX | MEDIUM | Stripe Customer Portal handles cancellations and refund requests — saves an entire support tier |
| Server-side proxy with per-user quota enforcement | Security: never expose pooled API key client-side | MEDIUM-HIGH | Lightweight Node/edge function that streams Anthropic responses, debits credit on completion |
| Percentage bar anchored above the settings icon | Stated requirement; matches Poe/Cursor convention | LOW | Render in the renderer process; updates over IPC from the proxy result metadata |
| "Out of credits" state with one-click upgrade | Otherwise feels punitive | LOW | Don't silently fail — show modal: "You're out — top up or switch to your own API key" |
| Receipt email from Stripe | Required for trust | FREE | Built into Stripe |
| Visible plan summary in Settings | Users will look for "what am I paying for" | LOW | Plan name + next renewal date + cancel link to Stripe portal |

### Differentiators

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| No token counts ever — only % | Stated requirement; matches the non-technical-user thesis | LOW | Easier than you'd think — debit by request cost, surface as % of monthly bucket |
| Predictable monthly bucket (sized for ~X hours of typical play) | Users want "how long will this last" not "how many tokens" | LOW (calibration) | Tune the dollar→% conversion AFTER you ship and have play data |
| Graceful degradation: when % runs out, prompt to BYOK or upgrade — bot stays usable for chat-only with lower-cost model | Avoids the "I bought this and it died" rage | MEDIUM | Need the multi-provider layer (feature 5) shipping first |

### Anti-Features

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Token counts / cost-per-message display | "Power users want it" | Conflicts directly with the "non-technical users" thesis; users freak out (Claude.ai has no in-app counter for this exact reason — see Anthropic help doc) | Defer to a hidden "Developer mode" toggle |
| Auto-refill / auto-upgrade when you hit 0% | Sounds friendly | Users panic about surprise charges (Cursor's overage charges generated months of forum backlash in 2025) | Manual top-up only; show modal at 90% |
| Rollover credits month-to-month | "I paid for them, they should last" | Adds an entire ledger system; Poe doesn't roll over either ("you'll get a refund/discount for any unused points") | Refund unused fraction OR set expectation upfront ("monthly bucket, doesn't carry over") |
| Refund window on the $5 one-time | "Standard SaaS" | One-time consumable behaves like an in-app purchase, not a subscription — App Store / Stripe norms allow 14-day no-questions on consumables if untouched | Refund only if 0 usage; document in TOS |

**Reference UX comparison (verified):**

| Product | Display | When Users Trust It |
|---------|---------|---------------------|
| Cursor 2.x | % bar in settings; tokens hidden; "Auto" model | Trust dropped briefly after the 2025 pricing change because % stopped corresponding to predictable usage — **lesson: % must stay stable across UI updates** |
| Poe | Compute points number + monthly cap | Users tolerate it because the unit is consistent across all models — **lesson: don't change the unit definition mid-flight** |
| Claude.ai | No in-product counter; surprise wall + 5h reset timer | Most-complained-about UX in r/ClaudeAI — **inverse lesson: show the % proactively** |
| Replit Agent | "Effort-based" credits; checkpoint-billed | Users complained about effort estimates not matching reality — **lesson: only debit on completion, not estimation** |
| Cursor (overage) | Auto pay-as-you-go after credits gone | Major backlash; people lost $$$ overnight | **Lesson: hard stop at 0% with explicit user opt-in to top up** |

**When users freak out (signal pattern):**
1. Surprise charges they didn't authorize (Cursor 2025)
2. Bar dropped 30% from one action (Replit)
3. Bar hit 0% mid-conversation with no warning (Claude.ai)
4. Different units between marketing ("$5 in credits") and UI ("47% used") — keep one unit

**Proxy architecture sketch (verified pattern):**
- Sei desktop → HTTPS POST to `proxy.sei.app/v1/messages` with user JWT
- Proxy server: verify JWT → check credit balance → forward to Anthropic with platform's pooled API key → stream back → on completion, debit cost from balance
- Webhook → Stripe events → bump balance on successful payment

---

## Feature 5 — Multi-Provider Model Picker (OpenAI / Anthropic / Gemini / Grok / OpenRouter / local)

### Table Stakes

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Unified `chat()` interface that takes provider+model+messages and returns tool calls | Otherwise every provider is special-cased throughout the bot loop | MEDIUM | Recommended adapter shape: `{ provider, model, supportsVision, supportsCache, supportsTools, contextWindow }` |
| Per-provider API key field with secure storage | Required for BYOK | LOW | OS keychain via `safeStorage` |
| "Test connection" button per provider | Otherwise users can't tell why nothing's working | LOW | One-shot ping with `models.list` or a 5-token completion |
| Stated requirement: change onboarding from **grid → list** | UX request from milestone doc | LOW | List with: model name, provider, 2-3 capability chips (vision, tools, fast/cheap), context size |
| Prompt caching enabled per-provider where supported | Performance + cost; system prompt is ~thousands of tokens after persona | MEDIUM | OpenAI auto (>1024 tokens); Anthropic explicit `cache_control` breakpoints; Gemini implicit on 2.5 + explicit cache objects; OpenRouter passthrough — adapter must hide these differences |
| Sane default (Haiku) | Otherwise the user freezes at the picker | LOW | Recommended model is bolded/pre-selected; "Auto" mode optional |

### Differentiators

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Capability chips (`Vision`, `Tools`, `Fast`, `Cheap`, `Local`) shown inline in the list | Cursor shows speed/cost; users learn what matters faster | LOW | Honest labeling beats benchmarks |
| Filter / search bar over the model list | Power users with OpenRouter will have 100+ models | LOW | Match Cursor; defer if OpenRouter is OOS for v1.0 |
| Local provider auto-detection (Ollama running on `:11434`) | Removes config friction for the small but loud local-LLM crowd | LOW-MEDIUM | Detect at startup; if Ollama responds, populate available models from `/api/tags` |
| "Recommended for [character]" hint based on character.recommended_model | Differentiator from Cursor — character-aware | LOW | Only nudge if user hasn't already picked |

### Anti-Features

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Show prompt-cache hit %, write/read tokens, latency per call | "Make caching visible" | Conflicts with "no token counts" thesis. Cursor showed cache stats and most users couldn't parse them | Hide it. Internal telemetry only |
| "Auto" model that switches mid-conversation | Cursor pattern | Persona consistency requires stable tokenizer behavior; switching mid-chat can break tool-use formatting and cache | Auto-select at conversation start only |
| Streaming responses split by sentence into Minecraft chat | Looks cool | Floods chat; griefable; spam-protected on most servers | Single complete message per response |
| Live latency / TPS benchmarks per model | "Compare them" | Adds an entire benchmarking subsystem; numbers go stale | Static "Fast/Medium/Slow" chip per model |

**Per-provider caching: surface or hide? Hide.**

Verified differences (from Anthropic / OpenAI / Gemini docs):

| Provider | Caching Style | Min Tokens | TTL | Cost |
|----------|---------------|------------|-----|------|
| OpenAI | Implicit, automatic | 1,024 | provider-managed | 50% off reads, no write cost |
| Anthropic | Explicit `cache_control` breakpoints | 1,024 (Haiku) / 2,048 (Sonnet) | 5 min default, 1h extra cost | 25% premium on writes, 90% off reads |
| Gemini 2.5 | Implicit (auto) + explicit cache objects | 32,768 | configurable | Storage costs $/hr |
| OpenRouter | Passthrough — depends on upstream model | varies | varies | varies |
| Local (Ollama) | KV cache via context reuse | n/a | session | free |

Adapter responsibility: each provider implementation calls cache primitives correctly given the same logical `messages` shape. The user never sees this.

---

## Feature 6 — In-Game Vision (Player-POV Screenshot, 16-Block Radius + LOS Gated)

### Table Stakes

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Screenshot capture at the bot's eye position, facing the bot's yaw/pitch | Otherwise it's "the player's screen" not "the bot's POV" — privacy + accuracy issue | HIGH | Player-POV requires either OS-level capture of the MC window (brittle, per `.planning/PROJECT.md`) OR a headless render — pick OS capture for v1.0 with graceful failure |
| 16-block radius gate before allowing visualize | Stated requirement; matches MC reach distance norms | LOW | Pure math on bot position vs target entity/block |
| Line-of-sight gate via raycast | Otherwise "vision" works through walls — breaks the persona-feels-real principle | MEDIUM | mineflayer's `bot.world.raycast(from, dir, maxDistance)` returns first hit; reject if hit != target |
| `visualize` action skill in the Zod registry | Stated requirement; this is the explicit skill the LLM can call | LOW | Returns text description after VLM call, not the image — keeps the LLM loop text-only |
| Idle auto-screenshot when active model is a VLM | Stated requirement | MEDIUM | Throttle hard (e.g. min 30s between, skip if FSM is doing P0-P2 work) |
| Graceful degradation: if screenshot capture fails (no permission / not VLM model / MC not focused), the bot says "I can't see right now" not crashes | Stated v0.1.1 design principle ("treat as optional, degrade gracefully") | LOW | Wrap the capture call; on failure, fall back to text world-state |

### Differentiators

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Silent screenshot, with a tiny chat-side indicator ("*Sui glances around*") | Players feel "watched" if you flash a toast every time; persona breaks if it's invisible | LOW | The mineflayer chat is the right surface — action message in the persona's voice |
| LOS-aware narration ("I can see the dragon over the trees" / "I hear something but can't see it") | Differentiator from screenshot-everything bots like Questie | MEDIUM | Pre-classify what's in range + visible vs in range + occluded vs out of range; feed all three to the persona LLM |
| Capture macOS Screen Recording permission gracefully | macOS is brittle (per `.planning/PROJECT.md`); flunked permission = silent failure today | LOW | Detect via `systemPreferences.getMediaAccessStatus('screen')`; on `denied`, surface a one-time "Vision needs Screen Recording permission" toast |

### Anti-Features

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Continuous video streaming to a VLM | "Real-time vision" like Questie advertises | Cost explodes ($/min); latency unacceptable for an action loop; rate limits | Single-frame on event or interval; cap to N/min |
| Show every screenshot in chat as an image attachment | "Transparent — see what the bot sees" | Floods chat; in-game chat doesn't render images anyway; the screenshot is *input*, not output | Don't surface the image; surface the text interpretation |
| Wallhack vision (no LOS check) | "More useful" | Breaks the persona-as-character thesis — feels like a cheat, not a friend | LOS gating is the differentiator |
| Force VLM as default | "Vision is the future" | Vision tokens are 5-10x more expensive; cheap models can be vision-incapable; pulls % bar down fast | Per-character opt-in via `recommended_model` |

**Reference precedents (verified):**

| System | Vision approach | Sei lesson |
|--------|-----------------|------------|
| Voyager (original) | Text-only world state; no vision | Showed that *text* world state can carry far — vision is incremental, not foundational |
| VoyagerVision (2025) | Agent-perspective screenshots added | Validates the "POV screenshot + multimodal LLM" path |
| STEVE-1 | Raw pixels + low-level controls | Different paradigm (RL); not applicable to LLM-tool-calling Sei |
| MineDojo | Headless render + recorded gameplay | The "headless render" alternative; expensive to set up |
| Mindcraft | Configurable vision modes: `off` / `prompted` / `always` | **Direct precedent** — three-mode toggle matches Sei's intended idle-auto + on-demand split |
| Questie.ai | Continuous screen capture + voice | Anti-feature pattern — too noisy/expensive |

**Screenshot UX — recommended: silent capture + in-chat narration of result, no toast**

Why: A toast on every capture breaks immersion. Doing nothing at all confuses the user about why the bot suddenly knows what's in front of it. The sweet spot is a single chat message in the bot's voice ("oh hey, that's a creeper") — the persona itself is the indicator.

---

## Feature 7 — Universal MC Mod/Version Compatibility (Adapter Ingestion)

This is the highest-risk feature and warrants its own roadmap research pass; the summary below is what's known.

### Table Stakes

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Drop-a-modpack flow → bot adapts (or honestly says "I don't know this modpack") | Stated requirement; the whole feature | HIGH | The honest fallback matters as much as the success case |
| Detect modloader (Forge / Fabric / Quilt / NeoForge) and version | Universal compat requires knowing the substrate | LOW-MEDIUM | `@xmcl/mod-parser` (npm) handles all major loaders; this is solved at the parsing layer |
| Diff modded items/recipes vs vanilla baseline | The "what's new in this modpack" delta is what the LLM needs to know about | MEDIUM | Parse mod JARs → extract item IDs / recipes / lang files → diff against bundled vanilla manifest |
| Emit a structured summary + a set of new Zod actions for the persona LLM | Stated requirement | HIGH | "Summary" goes into system prompt as knowledge; new Zod actions extend the tool registry |
| Per-version manifest for vanilla MC (1.18, 1.19, 1.20, 1.21+) | Required as the diff baseline | MEDIUM | Ship pre-built manifests for the N most common versions |

### Differentiators

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| One-time "ingestion" UX with a progress bar — runs once per modpack, not per session | Match the user mental model (similar to "indexing" in IDEs) | MEDIUM | Cache the result per-modpack-hash so server changes don't re-trigger |
| LLM-driven knowledge synthesis (read mod descriptions, infer behaviors) | The differentiator vs naive item-list parsing | HIGH | This is the part of the requirement that says "LLM-driven" — let an offline LLM call write the summary at ingestion time, not at chat time |
| Per-mod opt-out toggle in settings | Power-user respect | LOW | "Ignore this mod's items" — useful when a mod has 5,000 items the bot will never use |
| Confidence/coverage indicator: "Bot understands 80% of this modpack" | Sets expectations honestly | MEDIUM | Based on % of items with parseable metadata + lang strings |

### Anti-Features

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| "Train" / "fine-tune" on the modpack | Power-user mental model from ML | Massive cost; doesn't actually work that way for tool-use models | Knowledge-injection only, no training |
| Auto-execute every recipe the bot finds | "Be helpful" | Modded recipes are unbounded; bot will spam crafts | Recipe knowledge for *reasoning*; explicit crafting actions stay in Zod registry |
| Sync mods from the server when the bot joins | Sounds elegant | Mineflayer is a Java protocol client, not a mod loader — no way to load modded behavior | Require local modpack drop; if server has mods bot doesn't know, degrade to "I see something I don't recognize" |
| Block bot from joining if it doesn't recognize all mods | "Safety" | Bot is a chat companion, not a mod-required client — most mods don't affect protocol | Continue with degraded compat warning |

**What users expect after dropping a modpack (verified by adjacent product norms):**

Cited precedents in the modded MC ecosystem:
- **JEI / EMI**: Just-shows-up; no setup; user expects instant compat
- **Polymorph / YARCF**: Auto-resolves recipe conflicts at runtime — *no training step*
- **Scannable**: Surveys nearby blocks; works on any mod's blocks because it reads the registry directly
- **Mod metadata parsers (`@xmcl/mod-parser`, `bee-mod-parser`)**: Established Node.js libraries; the parsing problem is solved upstream

User expectation set by these:
1. **Instant compat** is the gold standard. Anything else feels broken.
2. A **one-time progress bar** is tolerated (compared to: "indexing your project" in JetBrains/VS Code).
3. **Per-mod opt-in is rejected** — users won't configure 100 mods.
4. A **"this mod isn't supported"** honest message is preferred to silent failure.

**Realistic v1.0 scope:**
- Item ID + lang name + recipe extraction → text summary into system prompt (HIGH coverage, MEDIUM complexity)
- Keybind/control diff → not directly applicable (mineflayer uses protocol, not keys) — frame as "things the player might do" awareness, not new bot actions
- New Zod actions auto-emitted: keep narrowly scoped — e.g. `craft(item_id_or_name)` becomes parameterized by the ingested item registry rather than emitting a new action per mod item
- Confidence threshold: if <50% items parseable, surface "I have limited knowledge of this modpack" up-front

---

## Feature Dependencies

```
[Auth (F2)] ──gates──> [Cloud Library (F1)]
                            └──enables──> [Sharing (F3)]
                            └──enables──> [AI Proxy (F4)]

[Multi-Provider (F5)] ──enables──> [Vision (F6)]   (needs VLM-capable adapter)
[Multi-Provider (F5)] ──enables──> [AI Proxy (F4)] (proxy is a 7th "provider" in the adapter)

[Cloud Library (F1)] ──independent_of──> [Local Memory (v0.1.1 OWNER.md/DIARY.md)]
        * keep these decoupled — see Anti-Feature in F1

[Mod Compat (F7)] ──independent──>  (orthogonal to cloud features)
```

### Dependency Notes

- **F3 requires F1 which requires F2:** Can't browse a cloud library that doesn't exist, can't have a cloud library without user accounts.
- **F4 requires F2 for billing identity, F5 for provider abstraction:** Proxy is "Anthropic-via-Sei-account" and should slot into the same adapter interface as user-BYOK Anthropic.
- **F5 enables F6, but F6 also gates per-character on VLM availability:** A character whose `recommended_model` is non-VLM should never trigger auto-screenshot.
- **F1 conflicts with the v0.1.1 memory commitment IF cloud-synced:** Resolved by the anti-feature decision — cloud holds **definition** only, local holds **memory**.
- **F7 is fully independent:** Modpack compat operates on local mod files; nothing in the cloud stack matters to it.

---

## MVP Definition

### Launch With (v1.0)

Ruthless minimum to validate the commercial thesis:

- [ ] **Auth (F2):** Email/pw + Google via system browser + loopback; "Continue without account" works
- [ ] **Cloud Library (F1):** Character record CRUD; image + skin + desc + prompt; v0.1.1 persona migration on first sign-in
- [ ] **Sharing (F3):** Home (mine + recent) and Browse (all + search + "Use" button); creator attribution; Report button
- [ ] **AI Proxy (F4):** Stripe one-time + monthly; % bar over settings; out-of-credits modal
- [ ] **Multi-Provider (F5):** Anthropic + OpenAI + Gemini + local Ollama; list-style picker; per-provider caching working internally
- [ ] **Vision (F6):** `visualize` skill + idle auto when VLM active; 16-block + LOS gate; macOS permission handling
- [ ] **Mod Compat (F7):** Modloader detection; vanilla diff; item+recipe knowledge injection; honest fallback when coverage <50%

### Add After Validation (v1.x)

- [ ] **Grok + OpenRouter adapters** — wait until OpenAI/Anthropic/Gemini/local are rock-solid
- [ ] **Tag filters + creator profile pages** on Browse — add when search complaints surface
- [ ] **Versioned character definitions** — add when first creator-edit-broke-my-chat complaint comes in
- [ ] **Account-linking (local → cloud)** — add when conversion signal warrants
- [ ] **LLM-synthesized mod knowledge** (beyond raw item parsing) — add when modded users start playing
- [ ] **Confidence/coverage indicator** for mod compat — same trigger

### Future Consideration (v2+)

- [ ] **Cloud-synced memory** — only if a clear privacy story and user demand justify it; current decision is local-only
- [ ] **Comments / social on characters** — moderation overhead is enormous
- [ ] **Voice / TTS** — out of scope per PROJECT.md
- [ ] **Multiple simultaneous bots** — out of scope per PROJECT.md
- [ ] **Streaming VLM (continuous vision)** — cost-prohibitive

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Auth (F2) — email/pw + Google | HIGH (gates everything) | MEDIUM | P1 |
| Cloud Library (F1) | HIGH | MEDIUM | P1 |
| Sharing UI (F3) — Home/Browse | HIGH | MEDIUM | P1 |
| AI Proxy (F4) — Stripe + % bar | HIGH (commercial thesis) | HIGH | P1 |
| Multi-Provider (F5) — core 3 + local | HIGH | MEDIUM-HIGH | P1 |
| Vision (F6) — visualize + idle auto | MEDIUM (delightful, not essential) | HIGH | P1 |
| Mod Compat (F7) — basic ingest | HIGH for modded users (~30% of MC) | HIGH | P1 (smallest MVP only) |
| Multi-Provider — Grok + OpenRouter | LOW-MEDIUM | LOW | P2 |
| Mod Compat — LLM-synthesized knowledge | MEDIUM | HIGH | P2 |
| Tag filters + creator pages | MEDIUM | LOW | P2 |
| Versioned characters | LOW | MEDIUM | P3 |
| Continuous VLM streaming | LOW (cost-killer) | HIGH | P3 |

**Priority key:**
- P1: Must have for v1.0 launch
- P2: Add when validated by usage signal
- P3: Future / unlikely

---

## Competitor Feature Analysis

| Feature | Character.ai | Cursor | Poe | Mindcraft | Sei v1.0 Approach |
|---------|--------------|--------|-----|-----------|-------------------|
| Character library | Yes — central | n/a | Bot library | Configs in repo | **Cloud DB + Browse/Home** |
| Browse/discovery | Featured + search | n/a | Bot directory | GitHub README | **Featured + search + creator attribution** |
| Multi-provider | No (own model) | Yes — wide list | Yes — wide list | Yes — broad | **Curated 4 + OpenRouter later** |
| Vision | Image input | Yes (Sonnet etc.) | Yes per-bot | Vision modes (off/prompted/always) | **POV screenshot, LOS-gated** |
| % usage UX | None visible | % bar (no tokens) | Compute points | n/a | **% bar above settings, no tokens** |
| Auth | Email + Google | Email + Google | Email + Google | n/a | **Email + Google (system browser)** |
| Pricing | $9.99/mo c.ai+ | $20/mo Pro | $20/mo basic | Self-host | **$5 one-time + $20/mo proxy** |
| Mod compat (MC) | n/a | n/a | n/a | Manual config | **Auto-ingest + diff vs vanilla** |

---

## Sources

- [Character.AI Content Moderation Policy](https://policies.character.ai/safety/content-moderation)
- [Character.AI: Why is Search Broken?](https://nerdbot.com/2025/06/03/why-is-character-ai-search-broken-causes-community-frustrations-and-step-by-step-solutions/)
- [Character.AI Statistics 2026](https://sqmagazine.co.uk/character-ai-statistics/)
- [Cursor Tokens & Pricing docs](https://cursor.com/learn/tokens-pricing)
- [Cursor Models & Pricing](https://cursor.com/docs/models)
- [Cursor 3.0 changelog (new interface)](https://cursor.com/changelog/3-0)
- [Cursor Pricing Explained — Vantage](https://www.vantage.sh/blog/cursor-pricing-explained)
- [Poe Compute Points Explained](https://carletontorpin.com/ai/poe-ai-compute-points-explained/)
- [Poe Purchases FAQ](https://help.poe.com/hc/en-us/articles/19945140063636-Poe-Purchases-FAQs)
- [Replit AI Billing](https://docs.replit.com/billing/ai-billing)
- [Replit Pricing 2026](https://www.nocode.mba/articles/replit-pricing)
- [Claude usage limits — Anthropic help center](https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work)
- [Voyager — MineDojo on GitHub](https://github.com/MineDojo/Voyager)
- [VoyagerVision (arXiv 2025)](https://arxiv.org/pdf/2507.00079)
- [STEVE-1 (arXiv)](https://arxiv.org/pdf/2306.00937)
- [Mindcraft on GitHub](https://github.com/mindcraft-bots/mindcraft)
- [Mindcraft-CE](https://mindcraft.riqvip.dev/)
- [Google OAuth 2.0 for Native Apps](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Loopback IP Address flow migration](https://developers.google.com/identity/protocols/oauth2/resources/loopback-migration)
- [RFC 8252 — OAuth 2.0 for Native Apps](https://datatracker.ietf.org/doc/html/rfc8252)
- [Prompt Caching: OpenAI vs Anthropic vs Gemini](https://dev.to/m_sea_bass/comparing-prompt-caching-openai-anthropic-and-gemini-2mfh)
- [PromptHub — Caching across providers](https://www.prompthub.us/blog/prompt-caching-with-openai-anthropic-and-google-models)
- [OpenRouter Prompt Caching guide](https://openrouter.ai/docs/guides/best-practices/prompt-caching)
- [@xmcl/mod-parser (npm)](https://www.npmjs.com/package/@xmcl/mod-parser)
- [bee-mod-parser GitHub](https://github.com/Nishant1500/bee-mod-parser)
- [Fabric Mod Metadata System (DeepWiki)](https://deepwiki.com/FabricMC/fabric-loader/4.3-mod-metadata-system)
- [Mineflayer raycast / API docs](https://github.com/PrismarineJS/mineflayer/blob/master/docs/api.md)
- [EMI (CurseForge)](https://www.curseforge.com/minecraft/mc-mods/emi)
- [Polymorph (CurseForge)](https://www.curseforge.com/minecraft/mc-mods/polymorph)

---
*Feature research for: Sei v1.0 commercial MVP (seven new capability areas)*
*Researched: 2026-05-19*
