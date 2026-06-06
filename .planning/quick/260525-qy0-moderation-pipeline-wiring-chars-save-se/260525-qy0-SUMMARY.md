---
phase: quick-260525-qy0
plan: 01
subsystem: moderation-pipeline
tags: [moderation, supabase, rls, edge-functions, ipc-wiring]
requirements: [SHARE-05, SHARE-06, SHARE-07, DMCA]
commits:
  - aadfad8 fix(qy0-1) tighten search_public_characters to moderation_status='clean'
  - 556398c feat(qy0-2) per-user sightengine + openai moderation bucket kinds
  - 9f919b0 feat(qy0-3) scaffold report_appeals table + owner-only RLS
  - 6554deb fix(qy0-4) route chars.save + chars.setShared through publishWithModeration; remove dead binding
  - efce034 fix(qy0-5) moderate-character-images ownership check + server-derived portraitUrl
  - 7b1ccf2 feat(qy0-6) per-user sightengine + openai moderation buckets in edge fns
  - 086d6e4 fix(qy0-7) X-Admin-Token gate on backfill-moderate-existing via timingSafeEqual
files-modified:
  - supabase/migrations/20260528000800_tighten_public_search.sql           # created
  - supabase/migrations/20260528000900_moderation_per_user_buckets.sql     # created
  - supabase/migrations/20260528001000_report_appeals_scaffold.sql         # created
  - src/main/ipc.ts                                                        # modified
  - src/preload/index.ts                                                   # modified
  - src/shared/ipc.ts                                                      # modified
  - src/main/cloud/moderationEdgeClient.ts                                 # modified (Rule 3 — stale-comment removal)
  - supabase/functions/moderate-character-images/index.ts                  # modified
  - supabase/functions/moderate-character-prompt/index.ts                  # modified
  - supabase/functions/backfill-moderate-existing/index.ts                 # modified
---

# Phase quick-260525-qy0: Moderation Pipeline Wiring Summary

**One-liner.** Cluster C — moderation gate now actually gates publication: chars.save + chars.setShared both route through publishWithModeration before any cloud write, the search RPC drops the NULL-moderation carveout, cross-user ownership and per-user quota are enforced inside the Edge Functions, and an X-Admin-Token gate protects the backfill function.

## Truths

- Every shared=true transition (chars.save + chars.setShared) runs publishWithModeration before the cloud upsert. Confirmed by inline `runModerationGate(...)` helper called from both handlers; local-PRIVATE-first ordering defuses the sync-queue race (T-qy0-10).
- search_public_characters returns ONLY rows where moderation_status = 'clean' (no NULL carveout). Migration 20260528000800 CREATE OR REPLACE'd the function with the strict predicate.
- moderate-character-images verifies caller is the row owner and derives portraitUrl from the row, not the request body. Body validation no longer requires portraitUrl; row.portrait_image flows through `${SUPABASE_URL}/storage/v1/object/public/portraits/${row.portrait_image}`; 'no-portrait' carveout writes provider='no-portrait'.
- SightEngine + OpenAI moderation calls per user are bucket-capped (20/day + 100/day) and return 429 on overflow with Retry-After header. Bucket fail-path returns 500 bucket_rpc_failed (never silently allowed).
- backfill-moderate-existing rejects with 403 unless X-Admin-Token matches BACKFILL_ADMIN_TOKEN via constant-time compare. Fail-closed on missing header, missing env, or mismatch.
- report_appeals table exists with owner-scoped RLS (auth.uid() = owner_id) — owner can INSERT only for a character they own AND SELECT only their own appeals. No update/delete policies.
- Dead-code path removed: charsPublishWithModeration preload binding, RendererApi method, IPC channel string `browse:publish-with-moderation`, and the dead ipcMain.handle block are all deleted. Stale comment in moderationEdgeClient.ts referencing the old channel name was also scrubbed.

## Per-task Detail

### Task 1 — Migration: tighten search_public_characters (aadfad8)
- `supabase/migrations/20260528000800_tighten_public_search.sql` CREATE OR REPLACEs `public.search_public_characters(text, int, int)` with predicate `shared = true AND moderation_status = 'clean'` (no NULL branch).
- GRANT EXECUTE re-issued to anon, authenticated.
- Auto-hide / notify triggers untouched.

### Task 2 — Migration: bucket_kind CHECK extension (556398c)
- `supabase/migrations/20260528000900_moderation_per_user_buckets.sql` adds `sightengine_daily` and `openai_moderation_daily` via drop-then-add of `rate_buckets_bucket_kind_check`.
- Pattern matches 20260527000000_persona_free_bucket.sql exactly. Schema-only change; per-kind limits live in the Edge Function callers.

### Task 3 — Migration: report_appeals scaffold (9f919b0)
- `supabase/migrations/20260528001000_report_appeals_scaffold.sql` creates `public.report_appeals` with id / character_id / owner_id / reason (1..2000 chars) / created_at / resolved / resolution_notes.
- Two indexes (character_id+created_at desc, partial owner_id where !resolved) and RLS enabled.
- Owner-only INSERT (with character-ownership double-check) and SELECT policies. No update/delete policies.

### Task 4 — chars.save + chars.setShared moderation wiring (6554deb)
- `runModerationGate(characterId)` helper added at the top of `registerIpcHandlers`. PublishDeps assembly lifted verbatim from the prior browse.publishWithModeration handler.
- chars.save: when `character.shared === true && !character.is_default`, writes local PRIVATE first (saveCharacter or expandAndSaveCharacter with shared=false), runs the gate, and on clean promotes via saveCharacterRaw (no sync-queue re-enqueue). On flag: throws friendlyMessage; local row stays at shared=false.
- chars.setShared: when shared=true, routes through the gate the same way. shared=false path unchanged.
- Deleted: ipcMain.handle(IpcChannel.browse.publishWithModeration, ...), `charsPublishWithModeration` preload binding, RendererApi method, `IpcChannel.browse.publishWithModeration: 'browse:publish-with-moderation'`.
- Rule 3 fix: scrubbed a stale `browse:publish-with-moderation` reference in `src/main/cloud/moderationEdgeClient.ts` so the plan's grep gate passes. (Task 4 listed src/main/cloud/* files indirectly via the runModerationGate adapter; the stale comment was discovered during verify.)

### Task 5 — moderate-character-images ownership check + server-derived portraitUrl (efce034)
- adminClient SELECTs `owner, portrait_image` from `characters` by body.characterId. 500 on db_select_failed; 404 character_not_found on missing row; 403 forbidden on owner mismatch (before any provider call).
- portraitUrl reconstructed from `row.portrait_image` using SUPABASE_URL + `/storage/v1/object/public/portraits/${path}`. Caller-supplied portraitUrl is ignored; body validation now only requires characterId.
- No-portrait carveout: writes moderation_status='clean' with provider='no-portrait' and returns status='clean'.
- moderate-character-prompt: added a tombstone comment confirming the no-characterId invariant (cross-user ownership attack does not apply) and pointing to the Task 6 bucket gate.

### Task 6 — per-user moderation buckets in edge fns (7b1ccf2)
- moderate-character-images: `check_and_increment_bucket(p_bucket_kind='sightengine_daily', p_increment=1, p_limit=20, p_window_seconds=86400)` inserted AFTER ownership check / portraitUrl derivation, BEFORE SightEngine call. 429 + Retry-After on overflow; 500 bucket_rpc_failed on RPC error.
- moderate-character-prompt: `check_and_increment_bucket(p_bucket_kind='openai_moderation_daily', p_increment=1, p_limit=100, p_window_seconds=86400)` inserted AFTER JWT verify, BEFORE body parse. adminClient constructed locally (the function only had userClient). 429 + Retry-After / 500 same pattern.

### Task 7 — X-Admin-Token gate on backfill (086d6e4)
- Imports `timingSafeEqual` from `../_shared/timingSafe.ts`.
- After the existing Bearer JWT check, reads X-Admin-Token from request headers and compares in constant time against `BACKFILL_ADMIN_TOKEN` env var. 403 forbidden on missing header, missing env, or mismatch.
- Operator runbook in top-of-file comment updated with the new header and a BACKFILL_ADMIN_TOKEN secrets line.

## Verification Results

- All 3 migration files exist at the specified paths and pattern-match the plan's `<verify>` grep gates.
- `grep -rn "charsPublishWithModeration\|browse:publish-with-moderation" src/` returns no hits.
- `grep -c "runModerationGate" src/main/ipc.ts` = 4 (helper def + 2 call sites + 1 tombstone-comment reference; the verify `grep -c "runModerationGate("` = 3).
- `npx vitest run` shows 14 failed / 300 passed — same as baseline captured before Task 4 (all 14 failures are in proxy/* and supabase/functions/*, none introduced by this plan). One flaky `portraitStore.test.ts > removePortrait` failure observed mid-run (ENOTEMPTY tempdir cleanup race) reproduced on re-run as a pass; not related to this plan's changes.
- `npx tsc -p tsconfig.web.json --noEmit` is clean (0 lines).
- `npx tsc -p tsconfig.node.json --noEmit` shows 2 pre-existing errors (loopbackPkce.ts flowType + supabaseClient.test.ts spread argument) confirmed against `git stash` baseline; unrelated to this plan.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking issue] Stale `browse:publish-with-moderation` comment in src/main/cloud/moderationEdgeClient.ts**
- **Found during:** Task 4 verify step
- **Issue:** The plan's verify grep `! grep -rn "browse:publish-with-moderation" src/main` would have failed because moderationEdgeClient.ts:16 contained a stale doc comment naming the now-removed IPC channel.
- **Fix:** Rewrote the comment to point at chars.save / chars.setShared and the runModerationGate helper instead.
- **Files modified:** src/main/cloud/moderationEdgeClient.ts (comment only — no behavior change)
- **Commit:** 6554deb (folded into Task 4 commit)

No other deviations. Tasks 1, 2, 3, 5, 6, 7 executed exactly as written.

## Auth Gates / Checkpoints

None — the plan was fully autonomous (no `type="checkpoint:*"` tasks). No external credentials or services were needed during execution; migrations were not applied to live Supabase per plan instructions.

## Known Stubs / Followups

- `report_appeals` user-facing INSERT path + appeals modal is intentionally deferred to Cluster F (plan body section 3 documents this).
- The operator-side `report_appeals` SELECT-by-service_role dashboard is deferred to Cluster G.
- `moderationGate.ts` in src/main/cloud still passes `portraitUrl` in the body when calling `moderate-character-images` (line 192). The Edge Function now ignores that field, so this is a harmless dead arg — left as-is to avoid touching files not listed in this plan's `files_modified` array. Cluster F or a follow-up may drop the field from the moderationGate body for cleanliness.

## Self-Check

- [x] supabase/migrations/20260528000800_tighten_public_search.sql exists
- [x] supabase/migrations/20260528000900_moderation_per_user_buckets.sql exists
- [x] supabase/migrations/20260528001000_report_appeals_scaffold.sql exists
- [x] commit aadfad8 reachable from HEAD
- [x] commit 556398c reachable from HEAD
- [x] commit 9f919b0 reachable from HEAD
- [x] commit 6554deb reachable from HEAD
- [x] commit efce034 reachable from HEAD
- [x] commit 7b1ccf2 reachable from HEAD
- [x] commit 086d6e4 reachable from HEAD
- [x] grep gates from each task's `<verify>` block pass
- [x] vitest baseline (14 failed) preserved — zero new failures

## Self-Check: PASSED
