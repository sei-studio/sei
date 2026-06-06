# Phase 12: Character Sharing UI + Moderation - Context

**Gathered:** 2026-05-22
**Status:** Ready for planning
**Mode:** Smart discuss (autonomous) — provider locks per user choice

<domain>
## Phase Boundary

Light up cloud character discovery (Browse tab + search + Add-to-Mine) on top of the Phase 11 cloud library, with all three moderation gates (CSAM scan, prompt moderation, Report/DMCA flow) live BEFORE the first character is publicly visible. Includes the retroactive scan of the Phase 11→12 upload window flagged as D-30 in Phase 11.

Phase 12 delivers:

- Characters page split into Home tab (existing) + Browse tab (new) with server-backed text search across `name` and `persona_source`
- Browse cards (avatar + skin chip + name + 120-char persona snippet + creator attribution + Report button)
- Preview overlay + Add-to-Mine flow (downloads full definition into local library via existing `cacheOnDemand` from Plan 11-19)
- CSAM scan on every PORTRAIT image (NOT skins — see D-32 rationale) at upload time, synchronously blocking publication on flag
- Prompt moderation on `name + persona_source` (hard block) and `persona_expanded` (soft regenerate flow) at upload time
- One-shot retroactive scan of all `shared=true` characters uploaded during Phase 11→12 window (D-30 closure)
- Report button on Browse cards + preview overlay; submissions land in Supabase `reports` table → pg_notify → Edge Function emails dmca@sei.app + Discord webhook
- 3-distinct-reporters-in-24h auto-hide rule (`shared=false`, email creator, queue for human review)
- DMCA designated agent registered with US Copyright Office (sole proprietor, $6/3yr); contact published in app Settings, ToS §7, and Privacy link
- `BROWSE_ENABLED` boot-time feature flag in main process — only flips true after DMCA registered + backfill clean + mod Edge Functions deployed

Out of scope for Phase 12:
- Creator profile pages (deferred to v1.x — SHARE-10 explicitly defers attribution UI)
- Tag-based filtering and category browsing (v1.x)
- Comment threads / ratings on public characters
- Admin moderation UI (manual SQL for v1.0; report triage via email + Discord webhook + occasional SELECT)
- Sub-categorization of moderation severity tiers (binary clean/flagged for v1.0)
- Real-time Browse updates (poll/refresh on tab focus is enough)
- Moderation appeals UI for false-positive flagged uploads (creator emails dmca@sei.app for manual review)

</domain>

<decisions>
## Implementation Decisions

### Browse architecture (SHARE-01, SHARE-02, SHARE-03, SHARE-04)

- **D-31:** Characters page splits into Home + Browse via a **segmented control / tab bar at the top of `CharactersScreen.tsx`** (reuses existing `CharacterCard` component; Home tab unchanged). Browse renders a separate grid sourced from `useBrowseStore` (new).
- **D-31a:** Search is **server-side ILIKE over `characters.name` and `characters.persona_source`** via a Supabase RPC (`search_public_characters(query text, limit int, offset int)`). Debounced 250ms in the UI. No full-text `tsvector` index for v1.0 — listing volume will be in the hundreds, ILIKE is adequate.
- **D-31b:** Browse list pagination = **infinite scroll, 24 cards per page**, ordered `updated_at DESC`. Empty state: "No public characters yet — be the first to share one."
- **D-31c:** **`useBrowseStore` (new)** is the source of truth for the Browse listing (separate from `useCloudCharactersStore` introduced in Plan 11-17 which caches the signed-in user's own cloud-id-set). `useBrowseStore` exposes: `entries: BrowseEntry[]`, `query: string`, `loading: boolean`, `loadMore()`, `setQuery(q)`. Add-to-Mine button shows "Already in My Library" badge when the entry's UUID is in `useCloudCharactersStore.cloudIdSet`.
- **D-31d:** "description" surface = `persona_source` itself (Phase 11 D-24 schema has no separate `description` column and user confirmed `persona_source` is the description shown on the character page). Browse cards display the first ~120 chars of `persona_source` with ellipsis. **No schema migration needed for this.**

### Image moderation — CSAM (SHARE-06, partial Pitfall 12)

- **D-32:** CSAM scan runs on **PORTRAIT IMAGES ONLY**. Skins (both Mojang-fetched and user-uploaded) are NOT scanned in v1.0. Rationale: skins are 64×64 RGBA — too low-resolution for meaningful CSAM detection, and Mojang skins are pre-existing public content. **Risk accepted for v1.0**: malicious pixel-art patterns in skins are technically possible but practically rare. Document in deferred-items for v1.x revisit if abuse is observed.
- **D-32a:** Primary provider = **SightEngine `nudity-2.1` + `minor` model** (~$0.002/image, HTTP REST, fits an Edge Function). Apply for **PhotoDNA / NCMEC partnership in parallel** as a free backup once vetted (typically 4-8 weeks). Once PhotoDNA is live, swap providers with no plan-level change — the Edge Function abstracts behind one interface.
- **D-32b:** Scan timing = **synchronous block at upload**. The Edge Function `moderate-character-images` is invoked from `cloudCharacterClient.uploadPortrait` BEFORE the Storage object becomes publicly readable (use the existing private bucket pattern from Phase 11 + signed-URL-only public read after clean). Flag = upload rejected, friendly error: "Image flagged by automated review — please use a different portrait."
- **D-32c:** **Retroactive scan (D-30 closure):** A one-shot Edge Function `backfill-moderate-existing` walks all `characters WHERE shared=true AND moderation_status IS NULL`, scans each portrait, sets `moderation_status='clean'|'flagged'`. Flagged entries are auto `shared=false` + email creator. **MUST complete BEFORE `BROWSE_ENABLED` flips true** (see D-36). Planned for Phase 12 Wave 1.
- **D-32d:** New `characters` columns: `moderation_status text` (NULL | 'clean' | 'flagged'), `moderation_checked_at timestamptz`, `moderation_provider text` (e.g., 'sightengine-v2.1'). Migration in Wave 1.

### Prompt moderation (SHARE-07)

- **D-33:** Provider = **OpenAI `omni-moderation-latest`** (free; ~100ms). Called from a server-side Edge Function `moderate-character-prompt`. Categories that BLOCK: sexual/minors (any score), violence/graphic (>0.85), hate/threat (>0.85), self-harm/intent (>0.85).
- **D-33a:** Sei's own OpenAI API key lives in the Edge Function env var `OPENAI_API_KEY` (set via `supabase secrets set`). Cost expectation: cents/month at v1.0 scale (moderation API is free; the key just needs to belong to an account).
- **D-33b:** **Two-tier text checks:**
  - **Hard block:** `name + persona_source` concatenated → moderation call. Flag → upload rejected with category-specific error.
  - **Soft regenerate:** `persona_expanded` (LLM-derived) → separate moderation call. Flag → upload allowed but `persona_expanded` is regenerated server-side with a "moderation retry" persona-expansion prompt that explicitly steers away from the flagged category.
- **D-33c:** Friendly error copy template (no raw category names): "We can't publish this character because the persona description hits our content guidelines. Edit the persona and try again, or save it as private."

### Report flow (SHARE-08)

- **D-34:** Report button rendered on **Browse cards + character-preview overlay ONLY** (NOT on My Library cards — own characters can't be reported by their owner). UX: single tap → `Report this character?` confirm sheet with a reason picker (4 reasons: "Sexual content involving minors", "Hate speech / harassment", "Copyright infringement", "Other") + optional free-text field (capped 500 chars).
- **D-34a:** Submissions land in **Supabase `reports` table** (RLS: signed-in user can INSERT own rows; service_role only can SELECT/UPDATE/DELETE). Schema:
  ```
  reports(id uuid pk, reporter_id uuid fk users, character_id uuid fk characters,
          reason text, detail text, created_at timestamptz default now(),
          resolved_at timestamptz null, resolution text null)
  ```
- **D-34b:** Insert trigger fires `pg_notify('reports_new', report_id)` → Edge Function `notify-report` runs: sends email to `dmca@sei.app` + posts to Discord webhook (URL in env var `DISCORD_REPORT_WEBHOOK_URL`).
- **D-34c:** **Auto-hide threshold:** A Postgres trigger checks count of distinct `reporter_id` in last 24h for the reported character. If >=3 → auto `shared=false` on `characters` + email creator + post separate Discord alert. Auto-hide is reversible (admin SQL flips `shared=true` after review).
- **D-34d:** "Report" Edge Function rate-limits to **5 reports per reporter per hour** to prevent griefer-spam-reports against legit characters. Returns friendly 429.

### DMCA agent + legal (SHARE-09)

- **D-35:** DMCA designated agent registered as **sole proprietor** via `dmca.copyright.gov` eForm ($6 / 3 yrs). Real legal name + residential address (publicly listed in the Directory — no PO Box workaround exists in current Copyright Office rules). Email = `dmca@sei.app` (user-confirmed already set up).
- **D-35a:** **Three publishing surfaces** for DMCA contact:
  - **(a)** In-app: `SettingsScreen` → new "Legal" panel → "Report copyright infringement (DMCA)" entry that opens a modal with the full agent details (name, mailing address, email, registration receipt link).
  - **(b)** `../sei-website/terms.html` § "7. DMCA Notices" with full agent details (legal name, address, email, registration link).
  - **(c)** `../sei-website/privacy.html` adds a link "See Terms §7 for DMCA contact."
- **D-35b:** **Registration must complete + receipt URL captured BEFORE Browse flips on (BROWSE_ENABLED gate — D-36).** Surfaces (a)/(b)/(c) ship in Phase 12 plans but link to the registration receipt URL captured from the eForm.

### Feature-flag rollout (D-30, D-32c, D-35b)

- **D-36:** `BROWSE_ENABLED` is a boolean read from `<userData>/config.json` (defaults `false`) at main process boot; passed to renderer via the existing capabilities IPC channel. Renderer hides the Browse tab entirely when false (Home tab still renders). Flips `true` only when ALL of:
  - (a) DMCA agent registration confirmed (manual check)
  - (b) Backfill Edge Function complete + no FLAGGED rows remain in human-review queue
  - (c) `moderate-character-images` + `moderate-character-prompt` + `notify-report` Edge Functions deployed
  - (d) `reports` + new `characters.moderation_*` columns migrations applied
- **D-36a:** Dev/local development: `BROWSE_ENABLED=true` can be set in `.env.local` to test the Browse UI without the gating constraints. Production builds ship with `BROWSE_ENABLED=false` until the user manually flips it post-checklist.

### Description field clarification

- **D-37:** SHARE-02's "name and description" maps to `name` and `persona_source` columns. No new schema column. **Update REQUIREMENTS.md** to say "search across name and persona description" for clarity (planner task).

### Claude's Discretion

The user explicitly leaves these for the planner / executor:

- **Browse card visual layout** — reuse `CharacterCard` styling primitives where possible; planner can introduce a `BrowseCard` variant with Report button + creator attribution slot.
- **Search debounce timing** — 250ms is the default but planner can adjust based on Supabase RPC latency in practice.
- **Edge Function deployment pattern** — follow Phase 10/11 `supabase/functions/_shared/cors.ts` precedent. New functions: `moderate-character-images`, `moderate-character-prompt`, `backfill-moderate-existing`, `notify-report`.
- **Mod-status badge UX** — if a creator's character is auto-hidden, the character page should show a clear "Hidden — pending review" badge with a "Contact us" link. Planner decides exact copy.
- **Report submission form styling** — match existing modal patterns (e.g., `MigrateLocalCharsModal` from Plan 11-18).
- **Creator attribution placeholder** — for v1.0, "by anonymous" or user UUID fragment. Phase 12 does NOT introduce creator profile pages (deferred to v1.x per SHARE-10).
- **Per-user upload cap** — soft cap suggested (e.g., 50 public characters per user) to prevent spam; planner can defer if other rate-limit mechanisms suffice.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents (researcher, planner) MUST read these before planning or implementing.**

### Phase 12 requirements & scope
- `.planning/REQUIREMENTS.md` §Character Sharing (SHARE-01..SHARE-10) — locked requirements text
- `.planning/ROADMAP.md` §Phase 12 — goal, dependencies, success criteria
- `.planning/PROJECT.md` — three-process Electron architecture, target users, constraints

### Phase 11 carryover (mandatory read — Phase 12 builds directly on these)
- `.planning/phases/11-cloud-character-library/11-CONTEXT.md` §decisions — D-15..D-30 (cloud library decisions, esp. D-22 bundled defaults read-only, D-30 retroactive moderation timing flag)
- `.planning/phases/11-cloud-character-library/11-19-SUMMARY.md` — `cacheOnDemand` module for Add-to-Mine
- `.planning/phases/11-cloud-character-library/11-17-SUMMARY.md` — `useCloudCharactersStore` for Already-in-Library badge
- `.planning/phases/11-cloud-character-library/11-15-SUMMARY.md` — public/private toggle on CharacterPage (Phase 12 adds the moderation-pre-check on toggle-to-public)
- `.planning/phases/11-cloud-character-library/11-REVIEW.md` — fix HR-01 (chars:listCloud error handling) and HR-02 (cacheOnDemand in-flight guard) BEFORE planning Phase 12 since both impact Add-to-Mine UX

### Edge Function precedent
- `supabase/functions/_shared/cors.ts` — established CORS helper
- `supabase/functions/delete-me/index.ts` — auth verification + compensating-write structure precedent
- `supabase/migrations/` — existing migration pattern

### External APIs
- SightEngine docs: https://sightengine.com/docs/nudity-detection (nudity-2.1 + minor models)
- OpenAI Moderation API: https://platform.openai.com/docs/guides/moderation (omni-moderation-latest)
- PhotoDNA / NCMEC partnership: https://www.missingkids.org/HOPE/PhotoDNA (apply in parallel)
- US Copyright Office DMCA Designated Agent: https://dmca.copyright.gov/

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets (from Phases 10-11)
- `src/main/cloud/cloudCharacterClient.ts` — typed cloud client (Plan 11-07); add `moderateAndUpload*` wrappers in Wave 2
- `src/main/cloud/cacheOnDemand.ts` — for Add-to-Mine download (Plan 11-19); fix HR-02 in-flight guard before use
- `src/renderer/src/lib/stores/useCloudCharactersStore.ts` — cloud-id-set cache (Plan 11-17)
- `src/renderer/src/components/CharacterCard.tsx` — base card; extend for BrowseCard
- `src/renderer/src/components/SignInModal.tsx` — for upgrade-to-sign-in flow on Report (signed-out users shouldn't see Report)
- `supabase/functions/_shared/cors.ts` — Edge Function CORS helper

### Established Patterns
- All cloud writes go through `cloudCharacterClient` → `syncQueue` (D-18 from Phase 11)
- ToS gating via `isCloudWriteAllowed()` (Plan 11-14)
- IPC channels defined in `src/shared/ipc.ts`, handlers in `src/main/ipc.ts`, bindings in `src/preload/index.ts`
- Zustand stores match the existing style (e.g., `useSyncStore.ts`, `useCloudCharactersStore.ts`)
- Modals follow the `MigrateLocalCharsModal` / `AcceptToSModal` pattern

### Integration Points
- `App.tsx` mounts auto-prompted modals; Browse tab does NOT need a modal mount
- `CharactersScreen.tsx` (or `HomeScreen.tsx` if same file) gets the new tab control
- `SettingsScreen.tsx` Legal panel for DMCA contact entry
- `supabase/migrations/` — new migration for `characters.moderation_*` + `reports` table
- `supabase/functions/` — four new Edge Functions

</code_context>

<specifics>
## Specific Ideas

- "Already in My Library" badge replaces "Add to Mine" button when the user already has the char locally.
- Creator attribution for v1.0 = "by anonymous" or short user-UUID fragment (e.g., "by user-a1b2"). No profile pages.
- Browse empty state copy: "No public characters yet — be the first to share one."
- Mod-flagged upload error copy: "Image flagged by automated review — please use a different portrait."
- Prompt-mod block error: "We can't publish this character because the persona description hits our content guidelines. Edit the persona and try again, or save it as private."

</specifics>

<deferred>
## Deferred Ideas

- Creator profile pages with avatar + bio + their other published characters (v1.x; SHARE-10 explicitly defers)
- Tag-based filtering / categories (v1.x)
- Skin CSAM scanning (v1.x — raise priority if abuse observed)
- Moderation appeals UI for false positives (v1.x; v1.0 path = email dmca@sei.app for manual review)
- Admin moderation queue UI (v1.x; v1.0 = SQL + email + Discord)
- Real-time Browse updates / WebSocket subscriptions
- Comments / ratings on public characters
- Public moderation transparency report
- Per-user upload cap as a hard limit (v1.x; v1.0 relies on rate-limit Edge Function policies)
- Tag normalization / taxonomy
- "Featured this week" curation
- "Popular this week" sort by downloads (v1.x — needs download counter)

</deferred>
