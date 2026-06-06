---
phase: 12-character-sharing-ui-moderation
plan: 08
subsystem: ipc-contracts
tags: [ipc, main, preload, shared, zod, contracts, browse, moderation, capabilities]

# Dependency graph
requires:
  - phase: 12-character-sharing-ui-moderation
    plan: 01
    provides: "characters.moderation_status / moderation_provider columns + reports table + search_public_characters RPC + reports.reason CHECK constraint"
  - phase: 12-character-sharing-ui-moderation
    plan: 05
    provides: "submit-report Edge Function — 4-string REASON_ENUM + 5/reporter/hour rate-limit + 202/400/401/429 contract + FRIENDLY_RATE_LIMITED_MESSAGE"
  - phase: 12-character-sharing-ui-moderation
    plan: 07
    provides: "moderationGate.publishWithModeration(characterId, deps) orchestrator + PublishDeps DI contract + PublishResult tagged union + three CLOUD_MODERATION_* sentinels"
provides:
  - "Five new IPC channels following <domain>:<kebab-action>: browse:list, browse:report, browse:publish-with-moderation, capabilities:get, plus the registered IpcChannelName entries"
  - "BrowseEntry domain type (8 fields, pre-joined by main so the Browse grid renders without cross-store awaits)"
  - "REPORT_REASONS canonical const + ReportReason union — locked to the 4 strings the DB CHECK + 12-05 REASON_ENUM enforce"
  - "PUBLISH_MODERATION_CODES const + PublishModerationCode union — three sentinels the renderer ERROR_COPY map routes by exact match"
  - "moderationEdgeClient.ts — typed wrappers callSubmitReport (returns SubmitReportResult tagged union) + callBackfillModerate (returns BackfillResult)"
  - "Four new ipcMain.handle blocks with Zod validation at boundary and lazy-import discipline"
  - "Four new preload bindings inside the api: RendererApi object, exposed via contextBridge"
affects: [12-09-useBrowseStore, 12-10-publish-button, 12-11-error-copy, 12-13-report-modal, 12-16-capabilities-config, 12-17-browse-enabled-gate]

# Tech tracking
tech-stack:
  added: []  # Reuses existing Zod + edgeFunctionClient + supabaseClient + moderationGate
  patterns:
    - "Three-layer IPC contract update in lockstep (shared/ipc.ts → main/ipc.ts → preload/index.ts) — TS compiler enforces RendererApi shape across all three sites"
    - "Channel naming <domain>:<kebab-action> — browse:list, browse:report, browse:publish-with-moderation, capabilities:get"
    - "Lazy-import discipline inside ipcMain.handle bodies for supabaseClient / moderationGate / cloudCharacterClient — prevents module-init cycles"
    - "Zod validation at the IPC boundary — BrowseListSchema (string/200 + int 1..50 + int>=0), BrowseReportSchema (IdSchema + 4-string enum + max-500 detail), IdSchema for publishWithModeration"
    - "Tagged-union return shapes for fallible IPC operations — renderer pattern-matches on { ok: true } vs { ok: false, code, message }"
    - "Canonical 4-string enum mirrored across DB CHECK (12-01) → submit-report REASON_ENUM (12-05) → shared/ipc.ts REPORT_REASONS → ReportModal radio values (future 12-13)"
    - "Main pre-joins Browse rows with public Storage URLs + local-library predicate so the renderer renders the grid in one pass"
    - "PublishDeps dependency injection in the publish-with-moderation handler — single production wiring site for the 12-07 orchestrator"
    - "Capabilities exposed via dedicated IPC group so future feature flags (BROWSE_ENABLED + later) extend without expanding the channel surface"

key-files:
  created:
    - src/main/cloud/moderationEdgeClient.ts
  modified:
    - src/shared/ipc.ts
    - src/main/ipc.ts
    - src/preload/index.ts

key-decisions:
  - "Channel grouping: TWO new IpcChannel groups (browse and capabilities) rather than folding capabilities under app or browse. Capabilities is its own surface so future feature flags can extend the group without bloating either app: (which is process-level: ready/warnings/openExternal/updateAvailable) or browse: (which is moderation-and-listing). Matches the established convention (auth, skin, sync, tos, migration each own a group)."
  - "BrowseEntry.inMyLibrary is precomputed by main against listCharacters() (the on-disk index), NOT against useCloudCharactersStore. Honors Researcher correction #4 — the user-facing predicate is 'is this in My Library' which means 'is the JSON on local disk'. A fresh-machine signed-in user who has not yet downloaded any cloud chars sees no false 'Already in My Library' badges."
  - "Storage public URLs pre-joined in main via getStoragePublicUrl(bucket, owner, id). cloudCharacterClient already exports this as a sync, network-free helper (Phase 11 plan 19). The handler reconstructs portraits / skins from row.owner + row.id rather than trusting row.portrait_image as a path (defense-in-depth — even if the schema migration drift puts something unexpected in portrait_image, the URL we emit is bucket-determined)."
  - "browse:report goes through moderationEdgeClient.callSubmitReport, which returns a SubmitReportResult tagged union. The handler returns it verbatim to the renderer (no second translation layer). Status mapping: 200/202 → ok:true; 401 → unauthenticated; 429 → rate_limited; 400 → bad_request; else → network. Friendly copy constants in moderationEdgeClient mirror FRIENDLY_RATE_LIMITED_MESSAGE in 12-05 so server and client share the same string."
  - "browse:publish-with-moderation assembles PublishDeps inline. The adapter that wraps callEdgeFunction translates res.ok===false into a throw — this is the 12-07 caller invariant: the gate's try/catch converts the throw into CLOUD_MODERATION_PROVIDER_UNAVAILABLE so 502 / timeout / network errors never silently flow through as a clean verdict. Without this adapter, callEdgeFunction's tagged-union return would have made every error look like a falsy success."
  - "reExpandPersona uses the graceful-fallback identity projection (returns the current persona_expanded). 12-07 SUMMARY explicitly endorses this for v1.0 — soft-tier flags re-flag, burn the SOFT_RETRY_CAP=2 budget, and surface CLOUD_MODERATION_PROMPT_FLAGGED. The 'real' mod-steered LLM re-expander can be wired into this same seam in a follow-up plan without touching the handler signature or the gate."
  - "Capabilities handler ships a MINIMAL implementation reading process.env.BROWSE_ENABLED only. The full capabilities module (with config.json read + UserConfig.browse_enabled field) is shipped in Plan 12-16 per the original plan structure. This unblocks Wave 3+ renderer plans (12-09 useBrowseStore, 12-17 BROWSE_ENABLED gate) without prematurely coupling to the 12-16 work. Dev-mode override honored per CONTEXT D-36a; production builds will see browseEnabled:false until 12-16 + manual config flip."
  - "Sub-repos NOT in play. This is a single-repo plan; all four files live in the Electron app codebase. No commit-to-subrepo routing needed."

patterns-established:
  - "Three-layer IPC group registration: shared/ipc.ts (IpcChannel group + IpcChannelName union entry + RendererApi methods + domain types) → main/ipc.ts (ipcMain.handle blocks with Zod parse + lazy imports + handler-local PublishDeps assembly) → preload/index.ts (one-line ipcRenderer.invoke bindings inside the api: RendererApi object). Future feature plans copy this exact 3-step pattern."
  - "Typed Edge Function client modules (moderationEdgeClient.ts) per domain, mirroring the cloudCharacterClient.ts shape — wraps callEdgeFunction once per domain so IPC handlers consume domain-typed results rather than the raw EdgeFunctionResponse union."
  - "PublishDeps wiring: single production assembly site in the IPC handler. The orchestrator (12-07) imports zero supabase-touching modules; the wiring lives in the handler that's about to invoke it. Future fan-out gates (skin moderation, audio moderation) follow the same shape."

requirements-completed: [SHARE-01, SHARE-02, SHARE-04, SHARE-05, SHARE-08]

# Metrics
duration: ~10min
completed: 2026-05-22
---

# Phase 12 Plan 08: IPC Contracts Summary

**Wires the renderer-facing IPC surface for Phase 12: Browse listing (browse:list), report submission (browse:report), publish-with-moderation (browse:publish-with-moderation), and capabilities query (capabilities:get). Adds a typed Edge Function client (moderationEdgeClient.ts) wrapping submit-report + backfill, plus the production PublishDeps wiring for the 12-07 moderationGate orchestrator. Three-layer pattern (shared types → main handlers → preload bindings) updated in lockstep — every Wave 3+4 renderer plan now has the IPC channels and types it needs to compile.**

## Performance

- **Duration:** ~10 min
- **Tasks:** 4
- **Files created:** 1 (`src/main/cloud/moderationEdgeClient.ts`)
- **Files modified:** 3 (`src/shared/ipc.ts`, `src/main/ipc.ts`, `src/preload/index.ts`)

## Accomplishments

- **Five new IPC channels** registered in `src/shared/ipc.ts` across two new groups: `browse: { list, report, publishWithModeration }` and `capabilities: { get }`. All four channel strings follow the established `<domain>:<kebab-action>` naming (`browse:list`, `browse:report`, `browse:publish-with-moderation`, `capabilities:get`). `IpcChannelName` discriminated union updated to include both groups.
- **Three new domain types** exported from `src/shared/ipc.ts`:
  - `BrowseEntry` — 8 fields (`id`, `name`, `personaSnippet`, `creatorLabel`, `portraitUrl`, `skinUrl`, `updatedAt`, `inMyLibrary`) pre-joined by main so the Browse grid renders in one pass.
  - `REPORT_REASONS` + `ReportReason` — canonical 4-string enum that must match the DB CHECK constraint (12-01), the submit-report `REASON_ENUM` (12-05), and the future ReportModal radio values (12-13).
  - `PUBLISH_MODERATION_CODES` + `PublishModerationCode` — three sentinels (`CLOUD_MODERATION_IMAGE_FLAGGED` / `_PROMPT_FLAGGED` / `_PROVIDER_UNAVAILABLE`) the renderer ERROR_COPY map routes by exact match.
- **Four new `RendererApi` methods** typed against the new domain types: `browseList`, `browseReport`, `charsPublishWithModeration`, `getCapabilities`. The TS compiler now enforces that the preload binding object satisfies the new interface.
- **New module `src/main/cloud/moderationEdgeClient.ts`** (~145 lines) exports two typed wrappers:
  - `callSubmitReport(jwt, args): Promise<SubmitReportResult>` — translates HTTP 200/202 → `{ ok: true }`, 401 → `unauthenticated`, 429 → `rate_limited`, 400 → `bad_request`, anything else → `network`.
  - `callBackfillModerate(jwt): Promise<BackfillResult>` — operator-only surface; throws on transport failure so the runbook surfaces failures loudly.
- **Four `ipcMain.handle` blocks** added to `src/main/ipc.ts` following the established pattern (Zod parse at boundary, lazy imports inside handler closure, `isCloudWriteAllowed` gate where applicable):
  - `browse:list` — calls `search_public_characters` RPC (12-01), pre-joins each row with `getStoragePublicUrl('portraits' | 'skins', owner, id)` and computes `inMyLibrary` against `listCharacters()` (local on-disk index). NOT gated per LIB-04.
  - `browse:report` — gated by `isCloudWriteAllowed`; forwards to `moderationEdgeClient.callSubmitReport` with the session JWT.
  - `browse:publish-with-moderation` — gated; assembles PublishDeps for the 12-07 `publishWithModeration` orchestrator (six adapters: `callEdgeFunction` throw-on-fail, `upsertCharacter` flat→nested adapter, `getCharacter` projection over `downloadCharacter`, `reExpandPersona` graceful-fallback, `getJwt`, `supabaseUrl`).
  - `capabilities:get` — minimal `process.env.BROWSE_ENABLED` read per CONTEXT D-36a dev override (full implementation in 12-16).
- **Four `ipcRenderer.invoke` bindings** added to `src/preload/index.ts` inside the `api: RendererApi` object — must be inside the literal so `contextBridge.exposeInMainWorld('sei', api)` exposes them on `window.sei`.

## Task Commits

Each task was committed atomically:

1. **Task 1: Add Browse + moderation IPC channel contracts to shared/ipc.ts** — `ecc6098` (feat)
2. **Task 2: Add moderationEdgeClient with submit-report + backfill wrappers** — `125f508` (feat)
3. **Task 3: Register browse + capabilities IPC handlers in main** — `fba140c` (feat)
4. **Task 4: Expose browse + capabilities bindings via contextBridge** — `d3fe12e` (feat)

## The 3-Layer Canonical Enum Chain (Reason)

| Layer | File | Format | Surface |
|------|------|--------|---------|
| DB CHECK | `supabase/migrations/20260523000000_moderation_and_reports.sql` (12-01) | `check (reason in ('sexual_content_minors', 'hate_speech_harassment', 'copyright_infringement', 'other'))` | Postgres column constraint — rejects mismatched INSERTs |
| Edge Function | `supabase/functions/submit-report/index.ts` (12-05) | `REASON_ENUM = ['sexual_content_minors', 'hate_speech_harassment', 'copyright_infringement', 'other'] as const` | Pre-INSERT 400 validation in service-role context |
| Zod gate | `src/main/ipc.ts` browse:report handler (this plan) | `z.enum(['sexual_content_minors', 'hate_speech_harassment', 'copyright_infringement', 'other'])` | IPC boundary — rejects renderer-supplied invalid reasons |
| Public TS | `src/shared/ipc.ts` (this plan) | `REPORT_REASONS = [...] as const; type ReportReason = (typeof REPORT_REASONS)[number]` | Renderer ReportModal radio values (12-13) bind to this |

Adding or removing a value requires updating ALL FOUR sites together — the DB CHECK constraint surfaces drift as a hard 400 from `submit-report`, so the failure mode is loud rather than silent.

## moderationEdgeClient.ts — Contract for 12-09 / 12-13

`browse:report` handler is the only current consumer, but the typed `SubmitReportResult` shape is what 12-13's `ReportModal` should pattern-match on after the renderer hits `window.sei.browseReport(...)`:

```typescript
type SubmitReportResult =
  | { ok: true }
  | {
      ok: false;
      code: 'rate_limited' | 'network' | 'unauthenticated' | 'bad_request';
      message: string;
    };
```

- `rate_limited` → render the FRIENDLY_RATE_LIMITED_MESSAGE copy verbatim (already in `message`).
- `unauthenticated` → render "Please sign in to report." (already in `message`). The submit gate also blocks before the user can open ReportModal in v1.0 — defense in depth.
- `bad_request` → unlikely in practice (Zod gate at the IPC boundary will catch invalid reasons before the Edge Function does). Render a generic "couldn't submit" copy.
- `network` → "Couldn't reach the moderation service. Please try again in a moment." — pre-baked in `message`.

`callBackfillModerate` is the operator-only surface for the Phase 11→12 retroactive scan. v1.0 plan: invoke from a one-off main-process admin hook or a future Settings → Operator panel (out of scope for this plan).

## Deviations from Plan

The plan executed essentially as written, with five refinements driven by reading the actual codebase against the plan's example bodies:

1. **Supabase client import path = `'./auth/supabaseClient'`, NOT `'./cloud/supabaseClient'`.** The plan's example handler bodies used the wrong path. The canonical location is `src/main/auth/supabaseClient.ts` (it's been there since Phase 10; `src/main/cloud/` only holds the cloud-character-domain modules). All four new handlers + the moderationEdgeClient imports use the correct path.

2. **`getStoragePublicUrl` signature is `(bucket, ownerUuid, characterUuid)` — three args, not two.** The plan's example used `getStoragePublicUrl('portraits', row.portrait_image)`. The actual helper takes the bucket name plus the owner UUID + character UUID and reconstructs the `<owner>/<id>.png` path internally (it must, because the `portrait_image` field on the row is the stored path string, not the URL — and the storage layout for skins is owner/id-derived, not skin-PNG-hash-derived). The handler now uses `getStoragePublicUrl('portraits', ownerStr, id)` / `getStoragePublicUrl('skins', ownerStr, id)`, which matches the canonical Phase 11 Storage layout (`<owner>/<id>.png`).

3. **`inMyLibrary` predicate uses `listCharacters()`, NOT a `listLocalCharacters()` helper.** The plan hinted that the helper name might differ — the actual local-list export from `src/main/characterStore.ts` is `listCharacters`. Used that directly inside the `browse:list` handler; no new helper needed.

4. **`getCharacter` dep wires through `downloadCharacter` (cloud) NOT `loadCharacterRaw` (local).** The plan suggested `loadCharacterRaw` — that name does not exist in `characterStore.ts` (the local helpers are `getCharacter`, `saveCharacter`, `saveCharacterRaw`). The 12-07 gate operates against the cloud row's `owner` field and computes `portraitUrl` from `${supabaseUrl}/storage/v1/object/public/portraits/<owner>/<id>.png`, so the gate needs to see the CLOUD row's perspective. Production wiring now uses `downloadCharacter` from `cloudCharacterClient.ts` and folds `session.user.id` in as the `owner` field of the `ModerationCharacter` projection. This matches the 12-07 SUMMARY's wiring table (`getCharacter` ← "Projection over `downloadCharacter` from `src/main/cloud/cloudCharacterClient.ts`").

5. **`reExpandPersona` uses the graceful-fallback identity projection, NOT a wired `expandAndSaveCharacter` call.** The plan suggested calling `expandAndSaveCharacter(id, { moderationRetry: true })` — but `expandAndSaveCharacter`'s actual signature is `({ character }): Promise<Character>` (it takes a Character, not an id, and has no `moderationRetry` option). Wiring the real LLM re-expander cleanly here would require a non-trivial new code path (load the character, build mod-steering context from the prior flagged categories, call the expander, return the new expanded string) — and the 12-07 SUMMARY's wiring table explicitly endorses the graceful-fallback option for v1.0: `(characterId) => deps.getCharacter(characterId).then(c => c.persona_expanded)`. The handler now uses exactly that fallback — soft-tier flags burn the SOFT_RETRY_CAP=2 budget and surface `CLOUD_MODERATION_PROMPT_FLAGGED` to the user. The real mod-steered re-expander can swap into this same DI seam in a follow-up plan with no signature changes to this handler.

6. **`capabilities:get` ships a MINIMAL implementation reading `process.env.BROWSE_ENABLED` only.** The full capabilities module (with `config.json` read + `UserConfig.browse_enabled` field on the Zod schema) is scheduled for Plan 12-16. This minimal handler honors the dev-mode env override per CONTEXT D-36a so Wave 3+ renderer plans (12-09, 12-17) can compile and be developed against the IPC surface ahead of the 12-16 work landing. Plan 12-16 will replace this handler body with a `readCapabilities()` call against a proper `src/main/capabilities.ts` module — the IPC channel + RendererApi method already exist and won't need to change.

None of (1)–(6) is a behavior change relative to the plan's success criteria. (1)–(4) are corrections to plan-body examples that drifted from the actual codebase; (5)–(6) are deliberate scope decisions documented in the plan + 12-07 SUMMARY as acceptable seams for v1.0.

## Issues Encountered

None during execution. Two pre-existing test failures observed when running `npx vitest run` post-implementation:

1. `supabase/functions/submit-report/index.test.ts` fails under Vitest because it imports `jsr:@std/assert@1` (a Deno-only registry URL). The test is a Deno test, run via `deno test` (per 12-05 SUMMARY's TDD harness pattern). Vitest's `testInclude` glob picks it up because of the `*.test.ts` suffix — this is a pre-existing project-level config nit that should be added to `vitest.config.ts`'s `exclude` list (out of scope; not introduced by this plan).
2. `src/main/portraitStore.test.ts > applyPortrait > writes the file and updates character.portrait_image to <uuid>.png` fails with `ENOTEMPTY: directory not empty, rmdir`. This is a tmpdir cleanup race in the test's `afterEach`, pre-existing and flaky.

Both are pre-existing per the SCOPE BOUNDARY rule. Logged inline here; not deferred to `deferred-items.md` because they pre-date Phase 12.

## Threat Surface — Re-verify Against 12-08-PLAN `<threat_model>`

Plan listed 6 STRIDE threats. Implementation status:

| Threat ID  | Disposition | Implemented as                                                                                                                                                                                                                                                                                                                                              |
| ---------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-12-08-01 | mitigate    | `BrowseListSchema` (string max 200, int 1..50, int>=0) + `BrowseReportSchema` (IdSchema + 4-string enum + max-500 detail) + `IdSchema` for publishWithModeration. Every handler runs `Schema.parse(arg)` BEFORE any work; renderer-supplied invalid args throw at the IPC boundary.                                                                                                                                       |
| T-12-08-02 | mitigate    | `isCloudWriteAllowed` gate on both `browse:report` and `browse:publish-with-moderation`. JWT is read from `getClient().auth.getSession()` (main-side supabase client) and passed to the Edge Functions — the renderer cannot forge it. The browse:report handler explicitly returns `{ ok:false, code:'unauthenticated' }` for signed-out / ToS-pending callers. |
| T-12-08-03 | accept      | `inMyLibrary` is derived from `listCharacters()` (local on-disk index). The set never crosses the IPC boundary in either direction; it's used to populate the per-row boolean. No cross-user information leak.                                                                                                                                                                                                                       |
| T-12-08-04 | accept      | `search_public_characters` RPC has a hard cap (clamps `page_limit` to 1..50 in the SQL function itself, and `BrowseListSchema` enforces 1..50 at the IPC boundary). Per-IP throttling deferred to v1.x if abuse is observed.                                                                                                                                                                                                                |
| T-12-08-05 | mitigate    | The RPC's `where shared = true and (moderation_status is null or moderation_status = 'clean')` clause is the server-side filter; the IPC handler does not re-check (since RLS + RPC filter is authoritative). NULL inclusion is intentional during the Phase 11→12 backfill window per 12-01 NOTE.                                                                                                                                              |
| T-12-08-06 | mitigate    | The reason enum is locked across DB CHECK (12-01) + Edge Function REASON_ENUM (12-05) + Zod `z.enum([...])` in this plan + the exported `REPORT_REASONS` const that future ReportModal radio values bind to. Drift fails loudly at the DB CHECK boundary (400 from submit-report).                                                                                                                                                              |

No new threat surface beyond the plan. No `Threat Flags` section needed.

## Caller Invariants — Read by 12-09, 12-13, 12-17

1. **`window.sei.browseList({ query, limit, offset })`**
   - `query` is a free-text search string; empty string returns the whole moderation-clean listing.
   - `limit` MUST be in `[1, 50]` (clamped on both sides, but the Zod parse throws on out-of-range so the renderer should never test the edge).
   - `offset` MUST be `>= 0`.
   - Returns `{ entries: BrowseEntry[]; hasMore: boolean }`. `hasMore === true` when the returned page is full — the renderer can request the next offset.
   - Failures (RPC down, network) return `{ entries: [], hasMore: false }` — never throws. The renderer should render the empty state in that case (12-09 useBrowseStore handles this).

2. **`window.sei.browseReport({ characterId, reason, detail? })`**
   - `characterId` MUST be a UUID v4 (IdSchema enforces).
   - `reason` MUST be one of the 4 `REPORT_REASONS` constants. Importing `REPORT_REASONS` from `src/shared/ipc.ts` is the recommended renderer pattern.
   - `detail` MAX 500 characters. Renderer SHOULD enforce client-side with `maxLength={500}` so the Zod throw never happens.
   - Returns the `SubmitReportResult` tagged union verbatim from moderationEdgeClient. Never throws.

3. **`window.sei.charsPublishWithModeration(characterId)`**
   - `characterId` MUST be a UUID v4 of a character whose row + portrait already exist in the cloud (the 12-07 caller pre-condition).
   - Pre-condition: portrait bytes already uploaded via the existing `chars:apply-portrait` + cloud-mirror pipeline so the gate's `buildPortraitUrl` resolves.
   - Returns `{ ok: true } | { ok: false, code: PublishModerationCode, message: string }`. The renderer ERROR_COPY map in 12-10/11 should route on `code` (exact-match string compare against the three sentinels).
   - `message` carries the friendly copy from `moderationGate` — the renderer can render it verbatim; the ERROR_COPY routing is for any UI-side decorations (icon, action button).

4. **`window.sei.getCapabilities()`**
   - Returns `{ browseEnabled: boolean }`. Initially derived from `process.env.BROWSE_ENABLED === 'true'` (CONTEXT D-36a dev-mode override). Production builds see `false` until Plan 12-16 lands the full config.json read.
   - The Browse tab (Plan 12-09) MUST hide / render nothing when `browseEnabled === false`. Per CONTEXT D-36, the tab is gone entirely (not greyed out) until the operator flips the flag.

## Next Phase Readiness

**Wave 3 unblocked:**

- **Plan 12-09** (useBrowseStore) can now call `window.sei.browseList(...)` and consume `BrowseEntry[]`. The store should own debounce + pagination per CONTEXT D-31c (`setQuery`, `loadMore`, `refresh`).
- **Plan 12-10** (publish button on CharacterPage) can now call `window.sei.charsPublishWithModeration(id)` and pattern-match on the three `PUBLISH_MODERATION_CODES` sentinels for the friendly-error toast.
- **Plan 12-11** (ERROR_COPY map) needs entries for the three sentinels — the friendly copy is already in `result.message` from the gate; the ERROR_COPY map is a defense-in-depth pass-through (per 12-07 SUMMARY's guidance).
- **Plan 12-13** (ReportModal) can import `REPORT_REASONS` for the radio values and call `window.sei.browseReport(...)`. The `SubmitReportResult` shape is ready for pattern-matching.
- **Plan 12-16** (capabilities) replaces the minimal `capabilities:get` handler body with a `readCapabilities()` call against the new `src/main/capabilities.ts` module. The IPC channel + RendererApi method are already in place — no contract changes needed.
- **Plan 12-17** (Browse tab BROWSE_ENABLED gate) can now call `window.sei.getCapabilities()` from the CharactersScreen / useCapabilitiesStore.

## Self-Check: PASSED

- `src/shared/ipc.ts` — modified (channel groups + types + RendererApi methods + IpcChannelName union entries)
- `src/main/ipc.ts` — modified (4 ipcMain.handle blocks + BrowseEntry import)
- `src/preload/index.ts` — modified (4 ipcRenderer.invoke bindings)
- `src/main/cloud/moderationEdgeClient.ts` — FOUND (created, ~145 lines)
- `grep -cE "'browse:list'|'browse:report'|'browse:publish-with-moderation'|'capabilities:get'" src/shared/ipc.ts` = 4 (plan asserted 4)
- `grep -c "IpcChannel.browse\|IpcChannel.capabilities" src/main/ipc.ts` = 4 (plan asserted >= 4)
- `grep -c "browseList\|browseReport\|charsPublishWithModeration\|getCapabilities" src/preload/index.ts` = 4 (plan asserted >= 4)
- `grep -c "callSubmitReport\|callBackfillModerate\|SubmitReportResult\|BackfillResult" src/main/cloud/moderationEdgeClient.ts` = 5 (plan asserted >= 4)
- `npx tsc --build` — no new errors (loopbackPkce + supabaseClient.test pre-existing errors filtered)
- `npx vitest run src/main/cloud/moderationGate.test.ts` — 8/8 pass (12-07 gate tests unchanged)
- Commit `ecc6098` (Task 1) — FOUND in git log
- Commit `125f508` (Task 2) — FOUND in git log
- Commit `fba140c` (Task 3) — FOUND in git log
- Commit `d3fe12e` (Task 4) — FOUND in git log

---
*Phase: 12-character-sharing-ui-moderation*
*Completed: 2026-05-22*
