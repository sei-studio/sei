---
phase: 11
status: human_needed
score: "7/7"
verifier_model: opus
created: 2026-05-22T06:28:42Z
verifier: gsd-verifier (goal-backward)
test_results:
  vitest: "136/137 pass on first run; 137/137 on rerun (single flaky ENOTEMPTY temp-dir cleanup in portraitStore.test, NOT a code regression)"
  typecheck_web: "clean"
  typecheck_node: "2 pre-existing errors — loopbackPkce.ts:83 flowType, supabaseClient.test.ts:19 spread tuple. Documented in deferred-items.md; predate Plan 11-07."
human_verification:
  - test: "MigrateLocalCharsModal end-to-end auto-mount UX (Plan 11-18 Task 3 known deferred human-verify)"
    expected: |
      With a fresh test account: sign out, create 2 local characters in
      "Continue Locally" mode, sign up + accept ToS. After ToS accepted,
      MigrateLocalCharsModal auto-mounts listing the 2 chars (default
      checked). "Maybe later" persists migration-modal-shown.json and
      suppresses re-mount. Settings → "Migrate local characters" re-opens.
      Per-uuid upload result rows surfaced; LOCAL ONLY chip drops post-upload.
    why_human: |
      Requires a real Supabase test account, network-toggling for failure
      branch, and visual confirmation of modal layering/copy. Code structure
      is verified: App.tsx auto-mount useEffect at line 164–182, modal at
      line 481–483, SettingsScreen re-open entry at line 419, IPC handlers
      migration:listLocal / migration:upload / migration:shown at
      src/main/ipc.ts:509–612.
  - test: "Cloud upsert + Storage upload land for signed-in user (live end-to-end)"
    expected: |
      Signed-in user with verified email + accepted ToS creates a character;
      a row appears in `public.characters` with `owner = auth.uid()` and a
      `skins/<owner>/<uuid>.png` Storage object exists (plus
      `portraits/<owner>/<uuid>.png` if the user attached a portrait).
    why_human: |
      The full path is structurally present (saveCharacter → enqueueUpsert →
      processNext gated on isCloudWriteAllowed → upsertCharacter +
      uploadSkin + uploadPortrait), but a live Supabase round-trip is needed
      to confirm RLS policies + nested-path layout + cron interactions on
      the actual remote schema (Task 4 of Plan 11-01 was a blocking
      checkpoint requiring `supabase db push` against the linked project).
  - test: "Bot loop can launch a cloud character offline after cache-on-demand fetch"
    expected: |
      Sign in on a fresh machine; the Characters page lists a cloud-only row
      via chars:list-merged; click → ensureLocallyCached fetches row + skin
      + portrait → bot connects to MC offline using the cached files.
    why_human: |
      ensureLocallyCached + listMerged are wired into chars:open-prepare /
      chars:list-merged IPC handlers (src/main/ipc.ts:228–237), but the
      end-to-end offline launch requires a Minecraft server + a real
      cached-then-disconnected execution.
---

# Phase 11: Cloud Character Library — Verification Report

**Phase Goal:** Character definitions (persona, prompt, skin, portrait) live in Supabase as the cloud-authoritative source; the local cache continues to work offline; legal/GDPR machinery is live before any cloud write.

**Verified:** 2026-05-22T06:28:42Z
**Status:** human_needed (all structural must-haves verified; live UX/Supabase confirmation pending per deferred Plan 11-18 Task 3 + cloud round-trip)
**Re-verification:** No — initial verification.

## Goal Achievement

### Observable Truths (LIB-01 .. LIB-07 + roadmap success criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | LIB-01: Character definition (name, description, system prompt, skin PNG, portrait image) is stored in Supabase as Postgres rows + Storage blobs | VERIFIED | `supabase/migrations/20260521000000_characters_tos.sql` creates `public.characters` with full D-24 column set (id, owner, slug, name, persona_source, persona_expanded, skin_source, mojang_username, skin_png_sha256, skin_applied_at, username, is_default, shared, created_at, last_launched, playtime_ms, portrait_image, metadata jsonb, updated_at). `supabase/migrations/20260521000100_storage_buckets.sql` creates `skins` + `portraits` buckets with nested-path RLS. `src/main/cloud/cloudCharacterClient.ts:upsertCharacter` writes the row; `uploadSkin` / `uploadPortrait` write to Storage. |
| 2 | LIB-02: Character runtime memory (OWNER.md, DIARY.md) is never read/written to Supabase | VERIFIED | grep across `src/main/cloud/*.ts` for `OWNER\.md|DIARY\.md|memory/` returns zero matches. `cloudCharacterClient` schema upload payload (line 122–144) lists only definition columns. `runUuidRenameMigration` renames the memory directory locally (`src/main/migration.ts:293`) but the `memory/` tree is never imported by `src/main/cloud/`. |
| 3 | LIB-03: On first sign-in, existing local characters are offered for one-shot migration | VERIFIED (code), human_needed (live UX) | `MigrateLocalCharsModal` (`src/renderer/src/components/MigrateLocalCharsModal.tsx`) mounted from `App.tsx:481–483` gated on `autoMigrateOpen`; auto-mount effect at App.tsx:164–182 keys on `[authState, tosAccepted]`, checks `sei.migrationShown('get')`, lists local-only chars via `sei.migrationListLocal()`, opens modal when non-empty. IPC handlers `migration:listLocal` + `migration:upload` + `migration:shown` registered at `src/main/ipc.ts:509–612`. SettingsScreen re-open entry at line 419. (Plan 11-18 Task 3 human-verify is the listed deferred item.) |
| 4 | LIB-04: Cloud characters are cached locally in characters/<uuid>.json + skins/<uuid>.png so the bot runs offline against any character the user has already opened | VERIFIED | `src/main/cloud/cacheOnDemand.ts:ensureLocallyCached` writes `<userData>/characters/<uuid>.json` via `saveCharacterRaw` (bypasses cloud-mirror enqueue) and downloads skin/portrait. `listMerged` returns local+cloud union with `source ∈ {'local','cloud','both'}`. Wired into IPC at `src/main/ipc.ts:228–237` (`chars:open-prepare` + `chars:list-merged`). HomeScreen consumes the merged listing. |
| 5 | LIB-05: User can create/edit/delete characters from GUI; changes write through to Supabase and refresh local cache | VERIFIED | `src/main/characterStore.ts:saveCharacter` writes local first then `void enqueueUpsert(id); void processNext()`. `enqueueUpsert` collapses same-uuid ops. Delete path enqueues `enqueueDelete` with both Storage path lists (line 314–319). `processNext` lazy-imports `cloudCharacterClient.upsertCharacter / deleteCharacter / uploadSkin / uploadPortrait / deleteStorageObjects` and gates on `isCloudWriteAllowed`. Renderer refresh path via `chars:list-merged` reacts to local writes. |
| 6 | LIB-06: Privacy Policy and ToS are live and accepted on first sign-in before any cloud write | VERIFIED | `../sei-website/terms.html` + `../sei-website/privacy.html` exist. `src/shared/legalVersions.ts` exports `TOS_VERSION = '2026-05-21'` + `PRIVACY_VERSION = '2026-05-21'`. `src/main/auth/tosGate.ts:isTosAccepted/recordAcceptance` query `public.tos_acceptance` with 15s timeout, fail-closed. Signup checkbox at `src/renderer/src/components/SignInModal.tsx:225` (`tosChecked` state). Submit button disabled `(mode === 'signup' && !tosChecked)` at line 259. Signup post-success record at `src/main/auth/authHandlers.ts:319–326`. Blocking `AcceptToSModal` mounted at `src/renderer/src/App.tsx:472–474` gated on `signed_in && tosAccepted === false`. Defense-in-depth `isCloudWriteAllowed()` at `src/main/auth/authState.ts:175–212` enforces signed_in + emailVerified + ToS-accepted with 60s TTL cache + explicit `invalidateTosCache()` (called from `IpcChannel.tos.accept` handler — see note below). |
| 7 | LIB-07: Character creation/edit accepts validated skin (PNG dimension/size) and portrait (validated image, dimension/size limits) | VERIFIED | `src/main/skinImageUtil.ts` (PNG magic + IHDR + 64×64 RGBA) reused. `src/main/portraitImageUtil.ts` + `src/main/portraitStore.ts` ship per Plan 11-06 with PNG/JPEG/WebP accept, ≤1024×1024 canvas-resize, ≤500 KB ceiling. `PortraitImagePicker` component exists. characterSchema refinement rejects `data:` URLs in `portrait_image` (`src/shared/characterSchema.ts:97–101`). `portraitStore.test.ts` covers the path (5/5 pass on rerun). |

**Score:** 7/7 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `supabase/migrations/20260521000000_characters_tos.sql` | characters + tos_acceptance tables + RLS | VERIFIED | Full D-24 column set + 4 char RLS policies + 2 tos_acceptance policies (immutable by absence of update/delete) |
| `supabase/migrations/20260521000100_storage_buckets.sql` | skins + portraits public buckets + RLS | VERIFIED | Nested `<owner_uuid>/<character_uuid>.png` path with `storage.foldername(name)[1] = auth.uid()::text` RLS |
| `supabase/migrations/20260521000200_storage_purge_extend.sql` | Extended cron with T-11-10-01 path-ownership guard | VERIFIED | CTE-based body with `safe_paths` filter; `split_part(obj_path,'/',1) = user_id::text` |
| `src/shared/characterSchema.ts` | shared, slug, metadata, UUID id, data: refinement | VERIFIED | UUID `id`, `shared` boolean default true, `slug` nullable, `metadata` record, `portrait_image` refinement rejects `data:` |
| `src/shared/legalVersions.ts` | TOS_VERSION + PRIVACY_VERSION | VERIFIED | Both = '2026-05-21' |
| `src/main/auth/tosGate.ts` | isTosAccepted + recordAcceptance with 15s timeout, fail-closed | VERIFIED | Real implementation (merge with 11-12 confirmed in commit message `kept 11-12's real tosGate`) |
| `src/main/auth/authState.ts` | isCloudWriteAllowed + invalidateTosCache | VERIFIED | 3-condition gate, 60s TTL per-user cache, structured trace logs without PII |
| `src/main/cloud/cloudCharacterClient.ts` | upsert/delete/list/download + skin/portrait upload + is_default + data: guards | VERIFIED | Both BEFORE-NETWORK guards present (line 115, 118). 15s timeout via `withTimeout`. Nested storage paths. |
| `src/main/cloud/syncQueue.ts` | Persistent retry queue with backoff + gate | VERIFIED | Backoff `[1s, 5s, 30s, 5m, 30m]`, MAX_ATTEMPTS=6, gate-blocked reschedule (30s, no attempt count), `enqueueUpsert/enqueueDelete/processNext/retry/getStatus/subscribeStatusChange` |
| `src/main/cloud/cacheOnDemand.ts` | ensureLocallyCached + listMerged | VERIFIED | Conflict shadow (`.conflict`) for pending-write race; saveCharacterRaw bypasses re-enqueue |
| `src/main/cloud/deletionQueueWriter.ts` | enqueueStorageOrphans for orphan path cleanup | VERIFIED | Called from `src/main/characterStore.ts:300` on delete |
| `src/main/migration.ts` | runUuidRenameMigration (slug→UUID one-shot) | VERIFIED | Renames JSON files, skin PNGs (line 285), memory dir (line 293) |
| `src/main/defaultCharacters.ts` | Hardcoded UUIDs for sui/lyra/clawd | VERIFIED | DEFAULT_CHARACTER_UUIDS (line 53–55); `is_default=true` extension |
| `src/renderer/src/screens/CharacterPage.tsx` | Public/private toggle + SignInModal upgrade flow | VERIFIED | Toggle at line 330–367; signed-out → SignInModal with framingLabel at line 454+ |
| `src/renderer/src/components/CharacterCard.tsx` | LOCAL ONLY chip on legacy local-mode chars | VERIFIED | `chipLocalOnly` rendered at line 108 |
| `src/renderer/src/components/AcceptToSModal.tsx` | Blocking ToS+PP modal | VERIFIED | Mounted from App.tsx:472–474 with onAccepted refresh |
| `src/renderer/src/components/MigrateLocalCharsModal.tsx` | One-shot migration modal | VERIFIED | Auto-mount from App.tsx; manual entry from SettingsScreen line 419 |
| `src/renderer/src/components/SignInModal.tsx` | tosChecked state + signup-disabled submit | VERIFIED | `tosChecked` line 72; submit disabled line 259 |
| `../sei-website/terms.html` + `privacy.html` | Hosted legal pages | VERIFIED | Both files exist in sibling repo |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| `saveCharacter` | `enqueueUpsert` + `processNext` | direct lazy import | WIRED | `src/main/characterStore.ts:131–135` |
| `applySkin` (skinStore) | `enqueueUpsert` | lazy import | WIRED | `src/main/skinStore.ts:178–179` (belt-and-suspenders dup of saveCharacter enqueue) |
| `processNext` | `isCloudWriteAllowed` | lazy import | WIRED | `src/main/cloud/syncQueue.ts:159–167` |
| `processNext` | `upsertCharacter` + `uploadSkin` + `uploadPortrait` | lazy import | WIRED | `src/main/cloud/syncQueue.ts:171–172, 203, 213, 228` |
| `IpcChannel.tos.accept` handler | `recordAcceptance` | lazy import | WIRED | `src/main/ipc.ts:493–494` |
| `IpcChannel.tos.accept` handler | `invalidateTosCache` | direct call | NOT WIRED — coordination comment only | The comment at `src/main/ipc.ts:253–267` documents the wiring contract but the `tos:accept` handler body (line 488–499) does **NOT** call `invalidateTosCache()` after successful `recordAcceptance`. See "Gap analysis" below — judged non-blocking. |
| `App.tsx` (auto-mount) | `MigrateLocalCharsModal` | conditional render | WIRED | `App.tsx:164–182` effect + line 481–483 render |
| `SettingsScreen` | `MigrateLocalCharsModal` | conditional render | WIRED | Line 419 |
| `CharacterPage` toggle | `chars:set-shared` IPC → `saveCharacter` | direct IPC | WIRED | `src/main/ipc.ts:185–191` |
| `signUpWithPassword` | `recordAcceptance` (post-success) | lazy import | WIRED | `src/main/auth/authHandlers.ts:319–326` |
| `chars:open-prepare` | `ensureLocallyCached` | lazy import | WIRED | `src/main/ipc.ts:230–231` |
| `chars:list-merged` | `listMerged` | lazy import | WIRED | `src/main/ipc.ts:234–237` |
| `delete-character` flow | `enqueueDelete` + `enqueueStorageOrphans` | lazy import | WIRED | `src/main/characterStore.ts:300, 314` |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `MigrateLocalCharsModal` (renderer) | local-only character list | `sei.migrationListLocal()` IPC → `listCharacters()` minus cloud-id set | Yes — real local FS + Supabase `listMyCharacters` | FLOWING |
| `HomeScreen` cloud chip | `cloudIds` Zustand store | `useCloudCharactersStore.refresh()` → `sei.charsListCloud()` → `listMyCharacters` | Yes — Supabase listing or `{ids:[]}` fallback | FLOWING |
| `CharacterPage` toggle render | `character.shared` | `getCharacter(id)` from local FS | Yes — local FS via CharacterSchema parse | FLOWING |
| `AcceptToSModal` mount | `tosAccepted` (App state) | `sei.tosStatus()` → `isTosAccepted(userId)` | Yes — Supabase tos_acceptance query | FLOWING |
| Sync pill on `CharacterCard` | `pendingByUuid` map | `sei.syncStatus()` → `getStatus()` reads sync-queue.json | Yes — disk read of queue file | FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Vitest suite runs | `npx vitest run` | 136/137 pass first run; 137/137 on rerun (flaky temp-dir ENOTEMPTY in portraitStore cleanup) | PASS |
| Web tsconfig clean | `tsc --noEmit -p tsconfig.web.json` | exit 0, no errors | PASS |
| Node tsconfig | `tsc --noEmit -p tsconfig.node.json` | 2 pre-existing errors only (`loopbackPkce.ts:83` flowType, `supabaseClient.test.ts:19` spread) — documented in deferred-items.md | PASS (pre-existing, scoped out of Phase 11) |
| Migrations present | `ls supabase/migrations/` | 3 new Phase 11 migrations + 1 deletion_queue_user_insert + pre-existing Phase 10 | PASS |
| Legal pages present | `ls ../sei-website/{terms,privacy}.html` | both exist | PASS |
| No cloud-side memory writes | `grep -r "OWNER.md\|DIARY.md\|memory/" src/main/cloud/` | 0 matches | PASS |

### Requirements Coverage

| Requirement | Status | Evidence |
|-------------|--------|----------|
| LIB-01 (Supabase rows + Storage blobs) | SATISFIED | `characters` table migration + `cloudCharacterClient.upsertCharacter/uploadSkin/uploadPortrait` |
| LIB-02 (memory stays local) | SATISFIED | Cloud code path never references `OWNER.md` / `DIARY.md` / `memory/` |
| LIB-03 (first sign-in migration prompt) | SATISFIED (structural) + human-verify deferred | `MigrateLocalCharsModal` + auto-mount + Settings re-entry + IPC handlers all present |
| LIB-04 (cache format + offline launch) | SATISFIED | `cacheOnDemand.ensureLocallyCached` + bot loop reads local files unchanged |
| LIB-05 (CRUD writes-through + cache refresh) | SATISFIED | `saveCharacter` enqueue + `processNext` drain + IPC channels |
| LIB-06 (legal accepted before first cloud write) | SATISFIED | `tosGate` + signup checkbox + `AcceptToSModal` + `isCloudWriteAllowed` defense-in-depth |
| LIB-07 (validated skin + portrait upload) | SATISFIED | `skinImageUtil` reused + new `portraitImageUtil` + `portraitStore` + characterSchema `data:` refinement |

No orphaned requirements (all LIB-01..LIB-07 covered by Phase 11 plans).

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src/main/ipc.ts` | 488–499 | `tos:accept` handler does not call `invalidateTosCache()` after `recordAcceptance` | Info | After a user accepts ToS through the IPC, `isCloudWriteAllowed()` may return cached `false` for up to 60s. Practical effect: a one-time 60-second "syncing pending..." wait after acceptance before the first cloud write lands. Coordination comment at line 253–267 documents the missing wiring but no code calls it. **Not a blocker** — the cache self-expires; if anything it slightly over-blocks, which is the fail-closed direction the system explicitly chose. Recommend a tail hygiene plan to add `const { invalidateTosCache } = await import('./auth/authState'); invalidateTosCache();` inside the `tos:accept` handler success branch. |
| `src/main/auth/loopbackPkce.ts` | 83 | TS error: flowType not on SignInWithOAuthCredentials options | Info (pre-existing) | Pre-Phase 11 typecheck error; deferred-items.md acknowledges. Does not affect runtime (flowType is set on client init in supabaseClient.ts). |
| `src/main/auth/supabaseClient.test.ts` | 19 | TS error: spread arg tuple type | Info (pre-existing) | Test-only typecheck wrinkle; tests still execute and pass. |

### Human Verification Required

Three live-environment items (see frontmatter `human_verification` block above):

1. **Plan 11-18 Task 3** — MigrateLocalCharsModal end-to-end auto-mount flow with a real Supabase test account, including the migration-modal-shown.json persistence and Settings re-entry. (Explicitly the listed deferred human-verify item.)
2. **Cloud round-trip confirmation** — a verified-email + ToS-accepted signed-in user saves a character; row appears in `public.characters` and Storage objects appear at `skins/<owner>/<uuid>.png` (and portraits where applicable). This requires `supabase db push` of the three Phase 11 migrations against the linked project (Plan 11-01 Task 4 blocking checkpoint).
3. **Offline launch of cached cloud character** — sign in on a fresh machine, list shows cloud-only row via `chars:list-merged`, click triggers `ensureLocallyCached`, then disconnect and launch the bot.

### Gaps Summary

No structural gaps. Every LIB-01..LIB-07 truth has shipped code with concrete wiring. The remaining items are:

- **Live UX confirmation** (3 items above) — these are environmental, not code gaps.
- **One minor wiring hygiene item** — `tos:accept` handler in `ipc.ts` does not invoke the documented `invalidateTosCache()` hook from `authState.ts`. This is documented as a coordination comment but the call was not added after the 11-12 / 11-14 merge. Effect is at worst a 60s stale-`false` cache window after a fresh acceptance; the system continues to function correctly (sync queue gate fails closed, then resolves automatically on next TTL expiry). Suggest a tail commit; not a phase blocker.

Phase 11 is **structurally complete**. Status set to `human_needed` (not `passed`) because Plan 11-18 explicitly defers Task 3 to live human verification, plus two other live-environment confirmations are advisable before declaring Phase 11 truly done. Per the task prompt's allowance ("if the rest is structurally implemented, the overall status can still be `passed` … OR `human_needed` (your judgment call)"), I lean human_needed because the cloud round-trip is the literal phase goal and the schema-push (Plan 11-01 Task 4) was a blocking checkpoint deferred to the orchestrator/operator — a live confirmation is the only way to verify the database side is actually in the state the code assumes.

---

_Verified: 2026-05-22T06:28:42Z_
_Verifier: Claude (gsd-verifier, goal-backward)_
