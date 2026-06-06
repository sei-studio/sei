---
phase: 11
plan: 19
subsystem: cloud / cache-on-demand
tags: [cache-on-demand, offline, sync, character-open, ipc, ui, tdd]
requires:
  - 11-07 (cloudCharacterClient — downloadCharacter / downloadSkin / downloadPortrait / listMyCharacters)
  - 11-09 (characterStore.saveCharacter wired to cloud-mirror enqueue — saveCharacterRaw is the non-enqueueing sibling cacheOnDemand uses)
  - 11-17 (useCloudCharactersStore — cloud-id cache pattern; informed the cloud-only HomeScreen render approach)
provides:
  - "src/main/cloud/cacheOnDemand.ts — ensureLocallyCached(uuid) + listMerged() — the cache-on-demand sync model (D-19)"
  - "src/main/characterStore.ts — saveCharacterRaw(): non-enqueueing local-write sibling of saveCharacter, used by cacheOnDemand to avoid re-uploading what we just downloaded"
  - "chars:open-prepare IPC channel — hydrates local cache for a uuid BEFORE renderer navigation; existsSync short-circuit means cached chars pay zero cost"
  - "chars:list-merged IPC channel — local + cloud union dedupe by id with source: 'local' | 'cloud' | 'both' annotation"
  - "HomeScreen renders cloud-only characters as CharacterCards with a blue CLOUD chip overlay, surfacing cross-device library content"
  - "CharacterPage mount effect falls back to charsOpenPrepare when refreshCharacter finds nothing — bookmarked cloud-only URLs work without a 'Character not found' flash"
  - "Pitfall 5 conflict shadow path lands as minimum viable: pending sync op + cloud download → <uuid>.json.conflict shadow file + log warning; local NEVER overwritten"
affects:
  - "src/main/characterStore.ts: saveCharacter now delegates the local atomic write to saveCharacterRaw; the cloud-mirror enqueue stays in saveCharacter (preserves D-18 behavior for normal save flow)"
  - "src/shared/ipc.ts: IpcChannel.chars.openPrepare + .listMerged constants; RendererApi.charsOpenPrepare / .charsListMerged signatures"
  - "src/main/ipc.ts: two new handlers in the chars block; lazy-imports cacheOnDemand to keep module-init free of network deps"
  - "src/preload/index.ts: two one-line contextBridge bindings"
  - "src/renderer/src/screens/HomeScreen.tsx: charsListMerged effect (signed_in only); handleOpen wraps navigation with charsOpenPrepare; cloud-only entries rendered alongside local ones with CLOUD chip + DOWNLOAD FAILED inline error chip"
  - "src/renderer/src/screens/CharacterPage.tsx: mount effect chains refreshCharacter → ensureLocallyCached → refreshCharacter; preparing state blocks the not-found stub during download; prepareError state surfaces the offline / not-found message inline"
tech-stack:
  added: []
  patterns:
    - "Lazy-import of cross-module deps inside handler bodies (matches the discipline established by syncQueue.ts so module-init cycles are impossible regardless of import order)"
    - "Non-mirroring local write sibling (`saveCharacterRaw`) for hydrate paths — generalizable for any future download-then-write flow that should NOT trigger cloud re-upload (e.g. import-from-file, restore-from-backup)"
    - "Cache-on-demand IPC pattern: open-prepare(uuid) → existsSync short-circuit → download → atomic-write → renderer navigates. The wrapper-around-navigation shape keeps the renderer dumb (no caching state) and the main process authoritative (single source of truth for what's on disk)"
    - "Cloud-only HomeScreen render: in-screen merged listing fetch + filter-out-already-local + dedupe on every characters change. Avoids touching CharacterCard.tsx (out of files_modified scope); CLOUD chip rendered as a HomeScreen-local absolute-positioned overlay to match LOCAL ONLY chip's visual shape"
key-files:
  modified:
    - src/main/characterStore.ts
    - src/shared/ipc.ts
    - src/main/ipc.ts
    - src/preload/index.ts
    - src/renderer/src/screens/HomeScreen.tsx
    - src/renderer/src/screens/CharacterPage.tsx
  created:
    - src/main/cloud/cacheOnDemand.ts
    - src/main/cloud/cacheOnDemand.test.ts
key-decisions:
  - "saveCharacterRaw factored out as an explicit non-mirroring sibling rather than a `{ skipCloudMirror: boolean }` option on saveCharacter. The split makes the intent unambiguous at every call site — the only legitimate caller of saveCharacterRaw is cacheOnDemand; everywhere else, the implicit cloud-mirror enqueue is the desired behavior. A boolean option would have invited future bugs where someone forgets to pass it."
  - "Conflict-path implementation goes through the dynamic import of `./syncQueue` rather than `../cloud/syncQueue` — relative to the SUT file, which is itself under src/main/cloud/. This lets vi.mock('./syncQueue') intercept the import in tests, matching the pattern used by syncQueue.test.ts mocking its own dependencies."
  - "HomeScreen renders cloud-only characters via a separate inline-styled CLOUD chip overlay rather than extending CharacterCard with a `sourceTag` prop. Reason: CharacterCard.tsx is NOT in this plan's files_modified list. Keeping the cloud-only chip rendering local to HomeScreen contains the diff and preserves CharacterCard's existing chip-row z-stacking without surprises."
  - "CharacterPage mount chain is refreshCharacter → ensureLocallyCached → refreshCharacter, with the first refresh covering the T-04-37 case (file on disk but not yet in store). The second refresh after openPrepare is required because saveCharacterRaw bypasses any in-process notification — the data store wouldn't auto-pick-up the new file without an explicit invalidate."
  - "Cloud-only CharacterCards in HomeScreen are filtered post-cloudOnly state update via `.filter((co) => !characters.some(...))` as belt-and-suspenders dedupe. The useEffect re-runs on `characters` change and should overwrite cloudOnly correctly, but the inline filter prevents a one-frame flicker during the state transition between openPrepare success and the next merged-listing fetch."
  - "Open-prepare error UX: HomeScreen surfaces an inline red `COULDN'T OPEN — OFFLINE?` chip and DOES NOT navigate on failure. CharacterPage's mount-effect fallback shows a less-alarming `Couldn't load this character. You may be offline...` because the URL-direct entry-point usually means the user actively chose this destination (vs. accidentally clicked Home)."
patterns-established:
  - "Cache-on-demand IPC pair: open-prepare + list-merged. Reusable for any future cloud-backed resource that needs offline-first semantics (e.g. future cloud-saved game-world chunks, cloud-shared inventory presets). The shape is: list-merged returns local + cloud union with source annotation; open-prepare(id) hydrates local cache for one id before consumer fetches it normally."
  - "Non-mirroring local write sibling (saveCharacterRaw) for hydrate flows. Generalizable to any future store that has a cloud-mirror enqueue baked into its main save function — when downloading from cloud, you want raw local write only."
  - "Pitfall 5 conflict shadow pattern: peek sync-queue state, if pending op for uuid exists when overwriting candidate arrives, write the new value to `<resource>.conflict` shadow file and preserve local. Generalizable for any local-first store that mirrors to cloud and could face cross-machine concurrent edits."
requirements-completed: [LIB-04]
duration: ~20min
completed: 2026-05-22
---

# Phase 11 Plan 19: Cache-on-Demand Sync Summary

**Makes the cache-on-demand sync model real: a signed-in user sees cloud characters created on other devices listed in Home, clicking one downloads + caches it locally, previously-opened chars work offline. LIB-04 satisfied; D-19 satisfied; Pitfall 5 conflict path lands as minimum viable.**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-05-22T06:07:00Z
- **Completed:** 2026-05-22T06:27:00Z
- **Tasks:** 2 (Task 1 ran as TDD: RED → GREEN; Task 2 ran straight)
- **Files created:** 2 (cacheOnDemand.ts + .test.ts)
- **Files modified:** 6
- **Commits:** 3

## Task Commits

Each task was committed atomically on `dev`:

1. **Task 1 RED** — `a1ce3a1` (test) — failing tests for ensureLocallyCached + listMerged, plus saveCharacterRaw on characterStore
2. **Task 1 GREEN** — `15cc730` (feat) — cacheOnDemand.ts module with ensureLocallyCached + listMerged + Pitfall 5 conflict shadow
3. **Task 2** — `10a24a3` (feat) — chars:open-prepare + chars:list-merged IPC + HomeScreen cloud-only render + CharacterPage cache-on-demand fallback

## What Landed

### Task 1 — cacheOnDemand module + saveCharacterRaw

- **`src/main/characterStore.ts`** — split `saveCharacter` into the cloud-mirroring outer function + `saveCharacterRaw` inner function. `saveCharacter` is now a thin wrapper: `saveCharacterRaw(c)` + (if `!c.is_default`) the existing fire-and-forget cloud-mirror enqueue. `saveCharacterRaw` is the explicit non-mirroring sibling consumed by cacheOnDemand to avoid re-uploading what we just downloaded.
- **`src/main/cloud/cacheOnDemand.ts`** — two exports:
  - `ensureLocallyCached(uuid)`: existsSync short-circuit on `<userData>/characters/<uuid>.json`; conflict path writes `<uuid>.json.conflict` shadow when sync queue has a pending op for this uuid (Pitfall 5); cache miss fetches via cloudCharacterClient.downloadCharacter (throws CLOUD_CHARACTER_NOT_FOUND if cloud returns null), writes via saveCharacterRaw, best-effort downloads + atomic-writes skin + portrait.
  - `listMerged()`: local + cloud union deduped by id with source annotation ('local' | 'cloud' | 'both'); local wins on the name field for 'both'; signed-out → local-only; cloud-list failure → local-only (LIB-04: never regress offline UX).
- **`src/main/cloud/cacheOnDemand.test.ts`** — 7 tests covering all 6 plan-mandated test cases plus a signed-out listMerged path:
  1. Cache hit → no-op (no network calls)
  2. Cache miss → writes character + skin + portrait
  3. Cloud returns null → CLOUD_CHARACTER_NOT_FOUND throw
  4. Not signed in → CLOUD_DOWNLOAD_FAILED throw
  5. Conflict path → `<uuid>.json.conflict` shadow + local untouched
  6. listMerged dedupes by id with correct source annotation
  7. listMerged signed-out → local-only

### Task 2 — IPC + HomeScreen + CharacterPage

- **`src/shared/ipc.ts`** — added `IpcChannel.chars.openPrepare = 'chars:open-prepare'` + `IpcChannel.chars.listMerged = 'chars:list-merged'`; RendererApi gets `charsOpenPrepare(uuid)` + `charsListMerged()`.
- **`src/main/ipc.ts`** — two handlers in the chars block, both lazy-importing cacheOnDemand. openPrepare validates uuid via IdSchema; listMerged is parameter-less.
- **`src/preload/index.ts`** — two contextBridge bindings.
- **`src/renderer/src/screens/HomeScreen.tsx`** — useEffect on `authKind + characters` fetches charsListMerged, filters to cloud-only entries, stores in local state. handleOpen wraps navigation with charsOpenPrepare → refreshCharacter → navigate. Cloud-only entries render as CharacterCards with a blue CLOUD chip overlay (absolute-positioned at left: 80px to match LOCAL ONLY chip shape). Open-prepare failures surface an inline red `COULDN'T OPEN — OFFLINE?` chip on the offending card and DO NOT navigate.
- **`src/renderer/src/screens/CharacterPage.tsx`** — mount effect now chains refreshCharacter → (if still missing) ensureLocallyCached → refreshCharacter. The `preparing` flag blocks the misleading "Character not found" stub during the one-time download for bookmarked cloud-only URLs; `prepareError` surfaces a softer "Couldn't load this character. You may be offline..." message on failure.

### Bot-loop audit (LIB-04 invariant)

- `grep -rE "supabase\.from|getClient\(" src/bot/` → **0 matches**. Bot loop reads from local files only, as LIB-04 mandates.

## Verification Results

| Check                                                                                   | Result            |
| --------------------------------------------------------------------------------------- | ----------------- |
| `test -f src/main/cloud/cacheOnDemand.ts`                                               | exists            |
| `grep -c "export async function saveCharacterRaw" src/main/characterStore.ts`           | 1                 |
| `grep -c "ensureLocallyCached" src/main/cloud/cacheOnDemand.ts`                         | 2                 |
| `grep -c "\.conflict" src/main/cloud/cacheOnDemand.ts`                                  | 3                 |
| `grep -rE "supabase\.from\|getClient\(" src/bot/`                                       | 0 matches         |
| `npx vitest run src/main/cloud/cacheOnDemand.test.ts`                                   | 7/7 pass          |
| `npx vitest run` (whole repo)                                                           | 137/137 pass      |
| `grep -c "chars:open-prepare\|chars:list-merged" src/shared/ipc.ts`                     | 2                 |
| `grep -c "IpcChannel.chars.openPrepare\|IpcChannel.chars.listMerged" src/main/ipc.ts`   | 2                 |
| `grep -c "charsOpenPrepare\|charsListMerged" src/preload/index.ts`                      | 2                 |
| `grep -c "charsListMerged\|charsOpenPrepare" src/renderer/src/screens/HomeScreen.tsx`   | 5                 |
| `grep -c "source === 'cloud'\|CLOUD" src/renderer/src/screens/HomeScreen.tsx`           | 9                 |
| `grep -c "charsOpenPrepare" src/renderer/src/screens/CharacterPage.tsx`                 | 3                 |
| `npx tsc --noEmit -p tsconfig.web.json`                                                 | exit 0            |
| `npx tsc --noEmit -p tsconfig.node.json`                                                | 2 pre-existing only (loopbackPkce.ts + supabaseClient.test.ts; documented in deferred-items.md across all Phase 11 SUMMARYs) |

## TDD Gate Compliance

Task 1 ran under `tdd="true"`:

- **RED** — commit `a1ce3a1` — 7 tests, all failing because cacheOnDemand.ts didn't exist
- **GREEN** — commit `15cc730` — implementation lands, 7/7 pass
- **REFACTOR** — none required; the GREEN commit is the minimal implementation that satisfies all 7 tests

## Threat-Model Compliance

All 4 threats from `<threat_model>` mitigated as planned:

| Threat ID | How |
|-----------|-----|
| T-11-19-01 (E — Bot reads from cloud) | Grep gate clean (0 matches in src/bot/); LIB-04 invariant holds. Bot loop reads only from local files via characterStore.getCharacter |
| T-11-19-02 (T — Stale local cache overwritten) | Conflict shadow path in ensureLocallyCached: pendingByUuid[uuid] check before any local-overwriting write; cloud version goes to `<uuid>.json.conflict` instead. Tested directly. |
| T-11-19-03 (D — Open-prepare blocks renderer) | downloadCharacter inherits the 15s AbortController timeout from Plan 11-07's withTimeout wrapper. Renderer shows `Downloading character from cloud…` during the await so the user sees progress instead of an apparent freeze. |
| T-11-19-04 (I — Public Storage URL enumeration) | Accepted per Pitfall 10 — 122-bit UUID entropy makes enumeration impractical. |

## Deviations from Plan

**None — plan executed exactly as written.**

Minor implementation choices documented in `key-decisions` above:
- `saveCharacterRaw` factored out as an explicit sibling (rather than a `{ skipCloudMirror }` option) for unambiguous intent at every call site.
- CLOUD chip rendered inline in HomeScreen rather than via a CharacterCard prop, because CharacterCard.tsx is NOT in this plan's files_modified list.
- Cloud-only card list filtered post-state-update for belt-and-suspenders dedupe to prevent a one-frame flicker during the openPrepare → refreshCharacter → re-fetch cycle.

## Auto-fix Rules

None triggered. All implementation work matched the plan's task specifications without bug-fixes, missing functionality, or blocking issues encountered.

## Pre-existing Deferred Items (carried forward across Phase 11)

Two pre-existing TypeScript errors observed since Plan 11-07 and tracked in `.planning/phases/11-cloud-character-library/deferred-items.md`:
- `src/main/auth/loopbackPkce.ts:83` — `flowType` not in OAuth options type (Supabase API drift)
- `src/main/auth/supabaseClient.test.ts:19` — spread-args tuple type mismatch in test setup

Both remain unchanged by this plan; both flagged for an auth-side cleanup phase.

## Self-Check: PASSED

- src/main/cloud/cacheOnDemand.ts: FOUND
- src/main/cloud/cacheOnDemand.test.ts: FOUND
- src/main/characterStore.ts: FOUND (saveCharacterRaw export)
- src/shared/ipc.ts: FOUND (openPrepare + listMerged constants + RendererApi signatures)
- src/main/ipc.ts: FOUND (two new handlers)
- src/preload/index.ts: FOUND (two bindings)
- src/renderer/src/screens/HomeScreen.tsx: FOUND (charsListMerged effect + CLOUD chip + handleOpen)
- src/renderer/src/screens/CharacterPage.tsx: FOUND (charsOpenPrepare in mount effect)
- Commit a1ce3a1: FOUND
- Commit 15cc730: FOUND
- Commit 10a24a3: FOUND

---

# Phase 11 — End-of-Phase Summary

**Phase 11 is COMPLETE. All 19 plans landed, all 7 phase-level requirements (LIB-01..LIB-07) satisfied.**

## Phase 11 Outcomes

Phase 11 moved character DEFINITIONS (persona, prompt, skin PNG, portrait image) from local files to Supabase as the cloud-authoritative source for signed-in users, with offline-safe cache-on-demand semantics and GDPR/legal machinery (ToS + Privacy Policy) live before the first cloud write. Final shape:

- **Schema + storage** — `characters` Postgres table with full D-24 row mirror, `tos_acceptance` table, two Storage buckets (skins + portraits) with nested-path RLS `<owner_uuid>/<character_uuid>.png` (Plans 11-01, 11-02, 11-12-schema).
- **Local-first, mirror-cloud-immediately writes** — characterStore.saveCharacter + skinStore.applyPng fire-and-forget enqueue to a persistent JSON sync queue (`<userData>/sync-queue.json`) with bounded exponential backoff (Plans 11-08, 11-09).
- **UUID rename migration** — first-launch slug→UUID rename pass with idempotency manifest (Plan 11-03); IdSchema at IPC boundary bumped to UUID v4 (Plan 11-09).
- **Bundled defaults read-only at user level** — `is_default` gate at every cloud-mirror call site + at cloudCharacterClient.upsertCharacter BEFORE any network call; defaults never reach cloud (D-22 invariant; Plans 11-07, 11-09).
- **Portrait pipeline** — D-28 file-on-disk model; canvas-resize + re-encode in renderer; main validates + atomic-writes to `<userData>/portraits/<uuid>.png` (Plan 11-06).
- **ToS / Privacy gate** — `tos_acceptance` table + tosGate module; checkbox-embedded sign-up flow + OAuth first-time-callback acceptance recording; blocking modal for legacy alpha accounts (Plans 11-11, 11-12, 11-13); defense-in-depth `isCloudWriteAllowed` gate (signed_in + emailVerified + tosAccepted) at every cloud-write site (Plan 11-14).
- **Public/private toggle UI** — character page two-state pill; signed-out users see the upgrade-to-share flow via SignInModal with framingLabel; pendingShareIntent auto-applies post-sign-in (Plan 11-15).
- **Sync pill driver** — per-card SYNCING / SYNC FAILED — RETRY pill driven by useSyncStore subscribed to sync:status:update push channel (Plan 11-16).
- **LOCAL ONLY chip** — discoverability for legacy local-mode characters via useCloudCharactersStore + per-card gray chip with defense-in-depth `initialized` gate (Plan 11-17).
- **One-shot local→cloud migration** — first-sign-in modal with per-row checkboxes + sequential upload + post-upload chip refresh; Settings re-open entry; flag persisted at `<userData>/migration-modal-shown.json` (Plan 11-18, D-20).
- **Cache-on-demand sync** — this plan (11-19): cloud characters listed in Home with CLOUD chip; click downloads row + skin + portrait once via ensureLocallyCached; CharacterPage falls back to download for bookmarked URLs; Pitfall 5 conflict shadow lands as minimum viable.
- **Cloud account-delete cascade** — delete-character cleans cloud row + Storage objects via deletion_queue insurance + direct attempt (Plan 11-11); account-delete sweeps all owner Storage objects (Plan 11-13).

## Open Items / Follow-ups for Phase 12+

These are flagged but NOT Phase 11 deliverables:

1. **Retroactive moderation scan** (D-30, RESEARCH §Pitfall 12, deferred per Phase 11 CONTEXT.md). With `shared` default = `true` in Phase 11, every signed-in user's character was uploaded as public at creation. **Phase 12 planner MUST include a retroactive scan of all characters uploaded during the Phase 11 → Phase 12 window before lighting up Browse.** Without this, the first Browse page-load could surface unmoderated user-generated content. Phase 12 SHARE-06 (CSAM scan) and SHARE-07 (prompt-moderation) are the gating dependencies; the retroactive scan is the bridge.

2. **Conflict-resolution UI** (CONTEXT §deferred). Plan 11-19 ships the `<uuid>.json.conflict` shadow file as the minimum viable response to cross-machine concurrent edits, but there is NO renderer-side banner or merge UI. The user must inspect the shadow file manually. A v1.x conflict-resolution phase should add:
   - Banner on character page when a `.conflict` sibling exists
   - Side-by-side diff modal
   - Pick-one-and-discard-the-other UX
   - Delete the shadow file on resolution

3. **REQUIREMENTS.md wording fix for LIB-03** (CONTEXT §deferred). Current text references "v0.1.1 local characters" specifically; the implementation in D-20 (Plan 11-18) widened the scope to any pre-sign-up local-mode characters. A one-line roadmap edit. Not a Phase 11 implementation deliverable; flagged for a follow-up commit during Phase 12 planning.

4. **Cloud-fetched defaults table** (CONTEXT §deferred). Phase 11 ships bundled defaults as app-release-only updates per D-22. A future phase could surface a cloud-fetched-defaults pattern if defaults need to be updated without an app release; out of scope for now.

5. **Per-character `recommended_model` hint** (REQUIREMENTS.md "Future Requirements"). Phase 11 ships the `metadata jsonb` escape hatch on the characters row that could carry this hint without a schema migration; UI is out of scope until Phase 14 (multi-provider model abstraction) lands the model-picker surface that would consume the hint.

6. **Pitfall 5 (cross-machine concurrent edit) full UX** — Phase 11 ships the shadow file + warn log only. Real users hitting this case will see no banner; the conflict file just accumulates on disk. Deferred per CONTEXT §deferred. Track frequency in field telemetry once we have it.

## Requirements Status After Phase 11

| ID     | Description                                                                            | Status                   |
| ------ | -------------------------------------------------------------------------------------- | ------------------------ |
| LIB-01 | Supabase Postgres schema + RLS + Storage buckets for cloud-backed characters           | complete (Plan 11-01)    |
| LIB-02 | Runtime memory (OWNER.md, DIARY.md) stays local-only                                   | complete (audit-verified across Plans 11-07, 11-19) |
| LIB-03 | First-launch upload prompt for local-mode characters (reinterpreted per D-20)          | complete (Plan 11-18)    |
| LIB-04 | Cache-on-demand sync; previously-opened chars survive offline                          | complete (Plans 11-17, 11-19) |
| LIB-05 | Local-first, mirror-cloud-immediately writes; sync pill drives the GUI state surface  | complete (Plans 11-09, 11-16) |
| LIB-06 | ToS + Privacy Policy hosted; acceptance recorded before any cloud write                | complete (Plans 11-11, 11-12, 11-13, 11-14) |
| LIB-07 | Image validation rules for skin + portrait upload                                      | complete (Plans 11-02 for portrait, reused 11-02-prior for skin) |

All 7 phase-level requirements are now marked complete. Phase 11 is ready for verification via `/gsd-verify-work 11`.

## Phase 11 Performance (cumulative across all 19 plans)

- **Plans landed:** 19 of 19
- **Tasks committed (Phase 11):** ~50+ atomic commits across the 19 plans (executor-mode, fine-grained TDD/feat splits)
- **Phase duration:** 2026-05-21 → 2026-05-22 (~2 active execution days; plans 11-01 through 11-19 executed sequentially with the parallel wave structure planned in /gsd-plan-phase output)

---

*Phase: 11-cloud-character-library*
*Plan 11-19 completed: 2026-05-22*
*Phase 11 completed: 2026-05-22*
