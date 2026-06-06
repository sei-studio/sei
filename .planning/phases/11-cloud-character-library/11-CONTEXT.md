# Phase 11: Cloud Character Library - Context

**Gathered:** 2026-05-21
**Status:** Ready for planning

<domain>
## Phase Boundary

Move character DEFINITIONS (persona, prompt, skin PNG, portrait image) from local files to Supabase as the cloud-authoritative source for signed-in users, with offline-safe cache-on-demand semantics and GDPR/legal machinery (ToS + Privacy Policy) live before the first cloud write.

Phase 11 delivers:

- Supabase Postgres schema + RLS + Storage buckets for cloud-backed characters
- Local-first, mirror-cloud-immediately write path for cloud-backed characters (LIB-01, LIB-05)
- Read-only treatment of bundled defaults (`sui` / `lyra` / `clawd`) — never uploaded to a user's cloud library; updates ship via app releases (D-22)
- One-shot "local → cloud" upload prompt at first sign-in for users who created chars in "Continue Locally" mode (replaces LIB-03 framing — see D-20)
- Cache-on-demand sync model in the existing `<userData>/characters/<id>.json` + `<userData>/skins/<id>.png` format (LIB-04)
- Image validation rules for skin + portrait upload (LIB-07)
- ToS + Privacy Policy hosted in the sibling `sei-website` repo; acceptance recorded in Supabase before any cloud write (LIB-06)
- Runtime memory (`OWNER.md`, `DIARY.md`) explicitly stays local-only — invariant enforced by code path audit (LIB-02)

Out of scope for Phase 11:
- Browse UI, search, "Add to Mine" (Phase 12)
- CSAM scan, prompt-moderation, DMCA agent (Phase 12 — but see D-30 below for the moderation timing concern)
- Public/private toggle UI in the signed-out flow — the upgrade-via-SignInModal path is in place (D-17), but Browse-side visibility lights up in Phase 12
- Account deletion + data export (already shipped in Phase 10)
- The Phase 12 `shared: true → false` demotion UX (Phase 11 ships the schema column + default-true semantics; the toggle UI ships in Phase 12)

</domain>

<decisions>
## Implementation Decisions

### State model — local vs cloud

- **D-15:** When a user is signed in, every **newly-created** character is cloud-backed (Supabase Postgres row + Storage objects). There is no "private local-only" state for new signed-in characters. **Exception:** legacy local-mode chars that existed before the user signed up persist as local files until the user explicitly promotes them. Signed-out ("Continue Locally") users keep the v0.1.1 file-only behavior unchanged.
- **D-16:** Every character has a single `shared` boolean flag, default = **`true`** for signed-in users' new chars. Toggle lives on the character page. `shared = false` keeps the cloud row + Storage objects but hides the character from Browse (which lights up in Phase 12). Schema column ships in Phase 11; the Browse-side effect activates in Phase 12.
- **D-17:** Signed-out users see the same public/private toggle on character pages, defaulted to private and disabled. Attempting to slide to public opens the existing **`SignInModal`** with `framingLabel = "Sign in to share this character"` (reuses the Phase 10 D-10 inline-upgrade pattern). On successful sign-in, the character is uploaded with `shared = true`.
- **D-18:** Write order for cloud-backed characters = **local-first, mirror-cloud-immediately**. The save lands in `<userData>/characters/<uuid>.json` + `<userData>/skins/<uuid>.png` synchronously (GUI feels instant). Cloud upload fires in parallel. A small inline status pill on the character card reflects state — "syncing / synced / sync failed — retry". Offline → cloud upload enqueues for retry on reconnect. Last-write-wins on cloud; no merge UI.
- **D-19:** Cache strategy is **cache-on-demand** (per LIB-04 wording). On a new machine after sign-in, the Characters page lists cloud chars via Supabase; opening a character downloads + caches `<uuid>.json` + `<uuid>.png`. Previously-opened chars survive offline. No eager prefetch on sign-in.

### Migration UX (LIB-03 reinterpreted)

- **D-20:** The "v0.1.1 migration" framing is reinterpreted — v0.1.1 has no real user base. The actual surface ships as a **one-shot local→cloud upload prompt at first sign-in** for v1.0 users who started in "Continue Locally" and later signed up. Modal lists user-created local chars (excludes bundled defaults). Per-char checkbox. Requires ToS+PP acceptance (D-26) if not yet accepted. Skipped chars stay as local files marked with a "local only" chip in Home; they remain promotable later via the public/private toggle. Modal does not re-appear after dismissal — a "Migrate later" entry-point in Settings lets the user re-open the prompt.
  - **REQUIREMENTS.md follow-up:** LIB-03 wording references v0.1.1 specifically; planner should propose a one-line edit to widen the wording to "local-mode characters" (or leave as-is and mark LIB-03 satisfied by D-20).

### Identity model

- **D-23 (ID model):** UUID is the canonical character ID across cloud + local cache. Local cache filenames become `<userData>/characters/<uuid>.json` + `<userData>/skins/<uuid>.png`. The Phase 11 plan must include a one-shot rename of existing files (slug → uuid) keyed by the bundled-defaults UUID constants. Slug becomes a separate human-friendly field on the row (kept for default-character keying and any human-readable URLs).
- **D-22 (bundled defaults are special):** `sui` / `lyra` / `clawd` are read-only at the user level — no edit, no delete. The existing `'sui' is undeletable` rule in `ipc.ts` extends to all defaults. They are **never uploaded** to a user's cloud library (no Supabase row, no Storage objects, regardless of `shared` value). Updates ship via app releases only. Stable UUIDs for the three bundled defaults are hardcoded in `defaultCharacters.ts`.
- **D-24 (cloud row shape):** Full row mirror — every `CharacterSchema` field gets a column where the type fits (`id`, `owner`, `slug`, `name`, `persona_source`, `persona_expanded`, `skin_source`, `mojang_username`, `skin_png_sha256`, `skin_applied_at`, `username`, `is_default`, `shared`, `created_at`, `last_launched`, `playtime_ms`, `portrait_image`). A `metadata jsonb` escape hatch covers fields added later without a migration. Includes `last_launched` and `playtime_ms` (cross-device stats).

### Legal gating (LIB-06)

- **D-25:** Privacy Policy and Terms of Service pages live in the sibling repo at `../sei-website/` — Phase 11 plan adds `terms.html` and `privacy.html` to that repo (linked from the app via `shell.openExternal`). The implementation plan must include both repo edits.
- **D-26:** Acceptance is captured **at sign-up** — checkbox embedded in the email signup form, and in the OAuth first-time-callback flow for Google. For existing Phase 10 alpha accounts with no acceptance row, a blocking modal at next launch post-update forces acceptance before any cloud write OR sign-in completes.
- **D-27:** Acceptance recorded in a new Supabase table `tos_acceptance(user_id, tos_version, privacy_version, accepted_at)`. RLS: user can insert + select own rows only. Version bump → app prompts for re-acceptance via the same blocking modal flow.

### Image validation (LIB-07)

- **D-28:** Skin keeps the existing 64×64 RGBA rule — reuses `src/main/skinImageUtil.ts` unchanged. Portrait: accepts PNG / JPEG / WebP, max 1024×1024 (client-side canvas downscale if input is larger), max 500 KB ceiling after resize. Client-side validation surfaces inline errors. **Server-side CSAM scan is deferred to Phase 12** (SHARE-06) — see D-30 for the timing concern.
- **D-29:** Skin storage is uniform — every cloud-backed character's skin gets PNG bytes uploaded to Supabase Storage at `skins/<uuid>.png`, regardless of original source (`upload` / `username` / `none`). No source-based branching. The local `skin.source` field is preserved in the cloud row for UI provenance but doesn't affect storage strategy. (Bundled defaults never reach the cloud per D-22, so the question of source-based branching doesn't arise.)

### Moderation timing — flagged for Phase 12

- **D-30 (flagged, NOT a Phase 11 decision):** With `shared` default = `true` per D-16, every new signed-in user's character is uploaded as public at creation. Phase 11 ships before Phase 12's moderation gates (SHARE-06 CSAM scan, SHARE-07 prompt-moderation). The Phase 12 planner must include a **retroactive scan of all characters uploaded during the Phase 11 → Phase 12 window** before lighting up Browse. Note in Phase 12 CONTEXT.md when discussed.

### Claude's Discretion

The user explicitly left these for the planner / executor to decide:

- **CRUD architecture (Edge Function vs direct supabase-js + RLS):** Default to direct `@supabase/supabase-js` calls with RLS policies for character CRUD (parallels the v0.1.1 character store's "thin layer" philosophy and avoids Edge Function cold-start cost for high-frequency ops). Use the existing `supabase/functions/` convention from Phase 10 only when an admin-privileged action is needed (e.g., cross-bucket Storage cleanup on delete).
- **Sync retry queue shape:** Likely a simple persistent queue in `<userData>/sync-queue.json` (mirroring `apiKeyStore.ts` atomic-write pattern). Bounded retries with exponential backoff. Surface failure to the inline sync pill.
- **"local only" chip styling:** Match existing chip patterns in the character card UI.
- **Migration modal copy:** Plain language; lead with "These characters are saved on this machine only. Upload any to your cloud library to access them from other devices?".
- **Slug→UUID rename of existing files:** One-shot startup migration similar to Phase 10's pattern (`runFirstLaunchMigration()`); idempotent; logged.
- **Delete-character cascade:** Direct supabase delete (RLS owner-only) + Storage object cleanup (`skins/<uuid>.png`, `portraits/<uuid>.png`). If Storage deletion fails post-row-delete, log + don't block UI; orphan cleanup runs nightly via the same `deletion_queue` cron pattern established in Phase 10.
- **Conflict on stale local cache:** Last-write-wins from cloud on character open. If local has unflushed pending writes (in retry queue), preserve them locally and flag a `<row>.json.conflict` shadow file for the user to inspect; surface a banner. Rare edge case; planner can defer to a follow-up phase if implementation cost is high.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents (researcher, planner) MUST read these before planning or implementing.**

### Phase 11 requirements & scope
- `.planning/REQUIREMENTS.md` §Cloud Character Library (LIB-01..LIB-07) — locked requirements text
- `.planning/ROADMAP.md` §Phase 11 — goal, dependencies, success criteria
- `.planning/PROJECT.md` — three-process Electron architecture, target users, constraints

### Phase 10 carryover (mandatory read — Phase 11 builds directly on these)
- `.planning/phases/10-auth-foundation/10-CONTEXT.md` §decisions — D-06 (two-state model `local`/`signed_in`), D-10 (inline-upgrade SignInModal pattern + `framingLabel` prop), D-13 (`supabase/functions/` folder convention), D-14 (export schema with reserved `characters[]` field — Phase 11 fills it)
- `supabase/functions/_shared/cors.ts` — established CORS helper for any new Edge Functions
- `supabase/functions/delete-me/index.ts` — precedent for Edge Function pattern, auth verification, compensating-write structure
- `supabase/migrations/20260520000000_deletion_queue.sql` + `supabase/migrations/20260520120000_deletion_queue_dedup.sql` — established migration pattern + nightly cleanup job structure (reuse for orphan Storage cleanup)

### Stack & implementation guidance
- `.planning/research/STACK.md` §1 (Cloud DB/Auth/Storage — Supabase) — version pins, free-tier limits, schema sketch (NOTE: schema sketch is illustrative; D-24 in this CONTEXT.md is the locked schema shape)
- `.planning/research/STACK.md` §1 RLS sketch — character row readable when `shared = true OR owner = auth.uid()`; writable only by owner

### Pitfalls (mandatory)
- `.planning/research/PITFALLS.md` §Pitfall 11 — GDPR obligations from first EU signup → why ToS+PP acceptance is gated before first cloud write
- `.planning/research/PITFALLS.md` §Pitfall 12 — public character library = dev hosts unknown content → drives the moderation-timing concern in D-30
- `.planning/research/PITFALLS.md` §Pitfall 13 — account deletion regresses offline-mode users → reinforces cache-on-demand + local-mode-first-class invariant

### External assets (must edit)
- `../sei-website/` (sibling repo) — Phase 11 plan adds `terms.html` and `privacy.html` here; `index.html` / `pitch.html` may need footer links updated

### Existing code (templates and integration points)
- `src/shared/characterSchema.ts` — `CharacterSchema`, `PersonaSchema`, `SkinSchema`, `SkinSourceSchema`, `CharacterIndexSchema`, `UserConfigSchema`; extend with `shared: boolean` + UUID-keyed `id` semantics
- `src/main/characterStore.ts` — local file CRUD; extend for UUID filename convention + add the cloud-mirror call site (post-`saveCharacter` / `expandAndSaveCharacter`)
- `src/main/skinStore.ts` — local PNG write + path-traversal safety via `IdSchema`; the UUID rename touches `paths.skinPngPath` and `skinServer` resolution; cloud upload of skin bytes happens alongside local write
- `src/main/skinServer.ts` — local HTTP skin server; URL format moves from `/skins/<username>.png` to `/skins/<uuid>.png` (or stays username-keyed with UUID-backed character lookup — planner decides)
- `src/main/skinImageUtil.ts` — existing PNG validation for skins; reuse unchanged. Extend the module (or add a sibling `portraitImageUtil.ts`) for portrait validation per D-28
- `src/main/paths.ts` — extend with `portraitPath(uuid)` + a sync-queue path; UUID changes the existing slug-keyed paths
- `src/main/migration.ts` — existing first-launch migration entry point; add the slug→UUID rename pass
- `src/main/auth/supabaseClient.ts` — existing singleton; reuse for all character CRUD calls
- `src/main/auth/authState.ts` — two-state machine; Phase 11 cloud-write code paths must check state before any cloud call
- `src/main/auth/jwtBridge.ts` — JWT to utilityProcess; not required for character CRUD (CRUD runs in main), but bot loop's character-read may need cloud awareness — planner should audit
- `src/main/auth/exportBuilder.ts` — fills `account` field today; extend with `characters[]` (LIB-04 + D-14 schemaVersion 1 contract)
- `src/main/auth/edgeFunctionClient.ts` — pattern for invoking Edge Functions with the user's JWT (reuse only if a Phase 11 cloud-side admin action requires it)
- `src/main/defaultCharacters.ts` — `seedDefaultCharacters()` runs on first launch; add the hardcoded UUIDs for `sui` / `lyra` / `clawd`; mark defaults read-only at the IPC layer
- `src/main/ipc.ts` — extend handlers: chars.* gain cloud-mirror call sites; `IdSchema` regex adapts for UUIDs (UUID is `[0-9a-f-]{36}` — must update the regex); new handlers for `auth:accept-tos`, `tos:status`, migration prompt, sync status
- `src/renderer/src/screens/CharacterPage.tsx` — add the `shared` public/private toggle UI; signed-out path opens SignInModal with `framingLabel`
- `src/renderer/src/screens/HomeScreen.tsx` — add "local only" chip rendering for legacy local-mode chars; surface inline sync pill on each cloud-backed card
- `src/renderer/src/screens/SettingsScreen.tsx` — add the "Migrate local characters" entry under the Account panel (re-opens the migration modal)
- `src/renderer/src/components/Banner.tsx` — reuse for the ToS+PP re-acceptance banner for legacy accounts (D-26)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`src/main/characterStore.ts`** — direct extension point; the cloud-mirror call site slots in after the existing atomic write. `expandAndSaveCharacter` already runs the persona-expansion LLM call; the cloud mirror runs after that returns so the expanded prompt makes it to Supabase in one shot.
- **`src/main/skinStore.ts`** — atomic-write + index-update pattern mirrors cleanly into Supabase Storage uploads. Existing `IdSchema` defense-in-depth must adapt: UUID regex replaces kebab-slug regex.
- **`src/main/skinImageUtil.ts`** — PNG magic + IHDR + 64×64 RGBA validation reused as-is for skins. Portrait validation lives next door (new file or extension).
- **`supabase/functions/_shared/cors.ts`** + **`supabase/functions/delete-me/index.ts`** — Edge Function pattern is established; the planner should reuse only if a privileged action is needed.
- **`supabase/migrations/`** — two migrations exist (deletion_queue + dedup). Phase 11 adds: `characters` table, `tos_acceptance` table, RLS policies, Storage bucket setup, nightly orphan-cleanup job mirroring `deletion_queue` pattern.
- **`@supabase/supabase-js` (^2.105.x)** — already a dependency. Direct CRUD pattern is the default (D-30 Claude's Discretion).
- **Existing IPC pattern (`src/main/ipc.ts`)** — `IdSchema` validation, handler registration; extend with new channels: `chars:set-shared`, `tos:status`, `tos:accept`, `migration:list-local`, `migration:upload`, `sync:status`.
- **Existing `SignInModal` with `framingLabel`** — Phase 10 D-10 plumbing already wired; signed-out → public-toggle flow plugs in without new components.

### Established Patterns
- **Three-process Electron**: main owns Supabase calls; renderer reads cloud state via IPC. JWT to utilityProcess via MessagePortMain. Character data flow: main ↔ Supabase, then main ↔ renderer + main ↔ utilityProcess.
- **Atomic file writes**: tmp+rename throughout `apiKeyStore.ts`, `characterStore.ts`, `skinStore.ts`. Reuse for sync-queue + portrait files.
- **Error classification**: `apiKeyStore` and `sessionStore` throw typed errors (`KEYCHAIN_UNAVAILABLE`, `SESSION_*`); add `CLOUD_SYNC_*` family for cloud-mirror failures with a clean renderer surface.
- **`runFirstLaunchMigration()` chain in `src/main/index.ts`** — entry point for the slug→UUID rename + the ToS+PP retroactive prompt for Phase 10 alphas.
- **`is_default` flag in `CharacterSchema`** — already exists; the read-only-at-user-level rule extends current behavior (`sui`-undeletable) to a generic `!is_default` precondition on edit/delete IPC handlers.

### Integration Points
- **`src/main/index.ts`** — `runFirstLaunchMigration()` chain: add slug→UUID rename + ToS+PP retroactive prompt for legacy accounts.
- **`src/main/ipc.ts`** — `chars:save` extends with cloud-mirror call (post-local-write, fire-and-forget with sync queue); `chars:delete` extends with cloud-delete + Storage cleanup; new channels per the Reusable Assets list.
- **`src/main/skinServer.ts`** — URL routing follows the UUID rename; planner audits whether the bot's skin-fetch URL changes too (mineflayer connect path).
- **`src/main/auth/exportBuilder.ts`** — extend `buildExport` to fill `characters[]` from Supabase (per D-14 schemaVersion 1 contract).
- **`src/renderer/src/App.tsx`** — the first-sign-in migration prompt routing happens here, gated on a new "first-time signed-in with local chars present" condition surfaced by `auth:state`.
- **`src/renderer/src/screens/CharacterPage.tsx`** — public/private toggle, sync status, "local only" chip.
- **`src/renderer/src/screens/SettingsScreen.tsx`** — "Migrate local characters" entry in Account panel.
- **`supabase/migrations/<timestamp>_characters.sql`** — `characters` table + RLS; `tos_acceptance` table + RLS; Storage bucket policies (skins, portraits); nightly orphan-cleanup job.

</code_context>

<specifics>
## Specific Ideas

- The public/private toggle on the character page should feel low-friction — slider or simple two-state pill, not a destructive-styled action. Toggling private is reversible (just hides); the user shouldn't feel they're "deleting" anything.
- "local only" chip should be unobtrusive — a subtle gray pill, not a warning color. Local chars are valid first-class citizens until the user chooses to promote.
- The migration modal copy should lead with the user-benefit framing ("access from other devices"), not compliance framing.
- ToS+PP modal for legacy alpha accounts should be unambiguous: "We've added a Privacy Policy and Terms of Service. Please review and accept to continue." with the two links + a checkbox + a single primary action.
- The sync status pill should disappear once `synced`, not linger. Avoid the WhatsApp "double-checkmark" feel for a single-user offline-pop workflow.

</specifics>

<deferred>
## Deferred Ideas

- **REQUIREMENTS.md wording fix for LIB-03** — current text says "v0.1.1 local characters"; the implementation in D-20 widens the scope to "any pre-sign-up local-mode characters". A one-line roadmap edit. Not a Phase 11 implementation deliverable; flagged for a follow-up commit.
- **Cloud-fetched defaults table** — option (b) from the defaults-delivery discussion. Out of scope for Phase 11 per D-22 ("app-update only"). Could surface in a future phase if defaults need to be updated without an app release.
- **Conflict resolution UI for stale local cache** — if a user edits a character on Machine A while offline, then opens it on Machine B, last-write-wins overwrites the unflushed Machine A edits when Machine A reconnects. The Claude's Discretion entry sketches a `<row>.json.conflict` shadow + banner; full UX deferred to a v1.x conflict-resolution phase if it materializes as a real issue.
- **Per-character `recommended_model` hint** — referenced in REQUIREMENTS.md "Future Requirements"; out of scope for Phase 11.
- **Retroactive moderation scan for Phase 11 → Phase 12 window** — Phase 12 planner deliverable per D-30; flagged here so it's not lost.

</deferred>

---

*Phase: 11-cloud-character-library*
*Context gathered: 2026-05-21*
