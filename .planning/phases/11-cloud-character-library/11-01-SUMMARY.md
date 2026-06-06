---
phase: 11-cloud-character-library
plan: 01
subsystem: database
tags: [supabase, migration, rls, storage, pg_cron, postgres, schema-push]

# Dependency graph
requires:
  - phase: 10-auth-foundation
    provides: deletion_queue table + purge-deletion-queue pg_cron job + auth.users (FK target) + supabaseClient pattern
provides:
  - public.characters table (full-row mirror of CharacterSchema per D-24) with RLS (select-own-or-shared + insert/update/delete-own)
  - public.tos_acceptance table (composite PK, immutable per D-27) with select-own + insert-own policies
  - storage buckets 'skins' and 'portraits' (both public) with nested path-prefix RLS '<owner_uuid>/<character_uuid>.png'
  - extended purge-deletion-queue cron body that deletes storage.objects across both buckets with T-11-10-01 path-ownership guard
affects: [11-02, 11-03, 11-07, 11-09, 11-10, 11-12, 12-cloud-sharing, 13-ai-proxy-billing]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Migration filename timestamp ordering (Phase 11 = 20260521000000+)"
    - "RLS with USING + WITH CHECK on UPDATE (T-11-01-02 mitigation pattern)"
    - "Nested storage path layout '<owner_uuid>/<file>.png' enabling storage.foldername(name)[1] RLS"
    - "Idempotent bucket insert via on conflict ... do update set public = excluded.public"
    - "Privileged cron CTE with safe_paths filter (split_part(obj_path, '/', 1) = user_id::text) to defend against malicious deletion_queue insertions"

key-files:
  created:
    - supabase/migrations/20260521000000_characters_tos.sql
    - supabase/migrations/20260521000100_storage_buckets.sql
    - supabase/migrations/20260521000200_storage_purge_extend.sql
  modified: []

key-decisions:
  - "Adopted nested storage layout '<owner_uuid>/<character_uuid>.png' per RESEARCH §Open Questions Q1 — enables clean RLS via storage.foldername(name)[1] = auth.uid()::text"
  - "tos_acceptance has NO update/delete policies — immutability is enforced via absence of policy rather than runtime check (D-27)"
  - "Purge cron extension uses CTE-based body with safe_paths filter to neutralize T-11-10-01 (a malicious deletion_queue row naming another user's storage path cannot escape because cron runs with privileged context — RLS is bypassed)"

patterns-established:
  - "Phase 11 cloud-write migrations: enable RLS first, then add per-action policies; deny-by-default via RLS without 'for all' policies"
  - "Storage bucket creation co-located with storage.objects RLS in same migration (atomic surface)"
  - "Cron migrations always unschedule before reschedule (idempotent across re-runs)"

requirements-completed: [LIB-01, LIB-02, LIB-06]

# Metrics
duration: ~10min (Tasks 1-3 only; Task 4 schema-push checkpoint deferred to orchestrator)
completed: 2026-05-21
---

# Phase 11 Plan 01: Cloud Schema Foundation Summary

**Three Supabase migrations authored: characters + tos_acceptance tables with full RLS surface, public skins/portraits storage buckets with nested-path RLS, and an extended purge-deletion-queue cron that deletes storage objects with a path-ownership guard.**

## Performance

- **Duration:** ~10 min (tasks 1-3); Task 4 (schema push) is a blocking human-action checkpoint
- **Started:** 2026-05-21T23:30:00Z (approx)
- **Completed:** 2026-05-21T23:40:14Z (Tasks 1-3 only)
- **Tasks completed:** 3 of 4 (Task 4 is a blocking checkpoint — schema push to remote Supabase project)
- **Files created:** 3

## Accomplishments

- `supabase/migrations/20260521000000_characters_tos.sql` — full D-24 column set for `public.characters` (id, owner FK auth.users cascade, slug, name, persona_source, persona_expanded, skin_source, mojang_username, skin_png_sha256, skin_applied_at, username, is_default, shared, created_at, last_launched, playtime_ms, portrait_image, metadata jsonb, updated_at). Four RLS policies (`characters_select_own_or_shared`, `characters_insert_own`, `characters_update_own` with USING+WITH CHECK both bound to `owner = auth.uid()`, `characters_delete_own`). `tg_set_updated_at()` trigger. Indexes `characters_owner_idx` and partial `characters_shared_updated_idx where shared = true`. `public.tos_acceptance` with composite PK `(user_id, tos_version, privacy_version)` and only select-own + insert-own policies (NO update/delete — immutable per D-27).
- `supabase/migrations/20260521000100_storage_buckets.sql` — idempotent `skins` and `portraits` public bucket inserts (`on conflict do update set public = excluded.public`); 4 RLS policies per bucket (public read, owner insert/update/delete) using `auth.uid()::text = (storage.foldername(name))[1]` against the nested `<owner_uuid>/<character_uuid>.png` layout.
- `supabase/migrations/20260521000200_storage_purge_extend.sql` — unschedules existing Phase 10 cron and reschedules with CTE-based body: `due` (rows past the 30-day window) → `paths` (flattened via `jsonb_array_elements_text`) → `safe_paths` (T-11-10-01 guard: `split_part(obj_path, '/', 1) = user_id::text`) → `deleted` (`delete from storage.objects` where `bucket_id in ('skins', 'portraits')` and `name = obj_path`) → mark queue rows purged.

## Task Commits

1. **Task 1: Author characters + tos_acceptance migration** — `82fb23e` (feat)
2. **Task 2: Author Storage buckets + storage.objects RLS migration** — `5c1b2d0` (feat)
3. **Task 3: Extend purge-deletion-queue cron to delete storage objects** — `a136a4b` (feat)
4. **Task 4: [BLOCKING] Push migrations to remote Supabase project** — DEFERRED to orchestrator (see Checkpoint section)

_No final metadata commit yet — SUMMARY commit will be made by the parallel-executor commit step below._

## Files Created/Modified

- `supabase/migrations/20260521000000_characters_tos.sql` — characters + tos_acceptance tables, all 4+2 RLS policies, indexes, updated_at trigger
- `supabase/migrations/20260521000100_storage_buckets.sql` — skins + portraits buckets with 8 storage.objects RLS policies (4 per bucket: 1 read + 3 write)
- `supabase/migrations/20260521000200_storage_purge_extend.sql` — extended cron body with T-11-10-01 path-ownership guard

## Decisions Made

- **Nested storage layout** `<owner_uuid>/<character_uuid>.png` chosen over a flat layout (RESEARCH §Open Questions Q1) because it enables RLS via `(storage.foldername(name))[1] = auth.uid()::text`, which is simpler and tamper-proof relative to subquery-based ownership checks. All downstream upload sites (11-07 cloudCharacterClient, 11-09 ipc, 11-10 storage purge) must honor this layout consistently — flagged in the storage_buckets migration comment.
- **Immutable tos_acceptance** enforced by absence of update/delete RLS policies, not by runtime guard. Composite PK `(user_id, tos_version, privacy_version)` allows multiple acceptance rows when ToS or Privacy versions bump.
- **Cron safe_paths guard** added in addition to (not in place of) bucket-id scoping, because the privileged cron context bypasses storage RLS. Without `split_part(obj_path, '/', 1) = user_id::text`, a malicious user could write a deletion_queue row naming another user's storage path and the cron would obediently delete it.

## Deviations from Plan

None — Tasks 1-3 executed exactly per the plan's verbatim SQL blocks. No auto-fixes applied; all acceptance criteria passed on first verification.

## Issues Encountered

None during Tasks 1-3.

## Checkpoint — Task 4 BLOCKING

**Type:** `checkpoint:human-action` (gate: blocking)
**Status:** awaiting orchestrator / human action

**Why this agent cannot complete Task 4:** The schema push requires either (a) the `supabase` CLI plus a `SUPABASE_ACCESS_TOKEN` exported in the environment, or (b) the Supabase MCP `apply_migration` + `generate_typescript_types` tools invoked against the linked remote project. In this worktree:

- `supabase` CLI is not installed and `SUPABASE_ACCESS_TOKEN` is unset (verified via `which supabase` and env check).
- Supabase MCP tools (`mcp__supabase__*`) are not present in this sub-agent's tool surface (consistent with the known upstream Claude Code restriction on MCP tools for sub-agents — `.mcp.json` declares the server but the tool bindings do not reach this thread).

**What the orchestrator (or follow-up agent with the right credentials) needs to do:**

1. From repo root, ensure linked project — `supabase link --project-ref <ref>` (skip if already linked from Phase 10).
2. Apply migrations in timestamp order — `supabase db push` (or three `mcp__supabase__apply_migration` calls).
3. Regenerate types — `supabase gen types typescript --linked > src/main/auth/database.types.ts` (or `mcp__supabase__generate_typescript_types` + write).
4. Verify:
   - `mcp__supabase__list_tables` returns rows for `characters` and `tos_acceptance`
   - `select id from storage.buckets where id in ('skins','portraits')` returns 2 rows
   - `select jobname from cron.job where jobname='purge-deletion-queue'` returns exactly 1 row
   - `grep -c "characters:" src/main/auth/database.types.ts` ≥ 1
   - `mcp__supabase__get_advisors type=security` returns no new RLS-disabled findings on the new tables/buckets

**Resume signal:** Reply `schema-pushed` with the type generation timestamp once the four verification checks pass. Until then, downstream Phase 11 plans (11-02 onward) MUST NOT execute against the remote — their CRUD calls would hit `PGRST205` on the missing tables.

## User Setup Required

The schema push gate (Task 4) is the user-setup surface for this plan. After it completes, the plan's `files_modified` includes `src/main/auth/database.types.ts` — that file is created on the developer machine as a side effect of `supabase gen types`, not from this worktree.

## Next Phase Readiness

- **Ready (after schema push):** Plans 11-02 (config/env wiring), 11-07 (cloudCharacterClient), 11-09 (IPC), 11-10 (storage purge writer) — all consume the schema, buckets, and types delivered here.
- **Blocked until Task 4 resumes:** All downstream Phase 11 plans whose verification touches the remote database.

## Threat Flags

None — all surfaces introduced (RLS policies, storage policies, cron body) are explicitly enumerated in the plan's `<threat_model>` (T-11-01-01 through T-11-01-09 and T-11-10-01) and the migrations implement the mitigations called out there.

## Self-Check: PASSED

- FOUND: supabase/migrations/20260521000000_characters_tos.sql
- FOUND: supabase/migrations/20260521000100_storage_buckets.sql
- FOUND: supabase/migrations/20260521000200_storage_purge_extend.sql
- FOUND commit 82fb23e (Task 1)
- FOUND commit 5c1b2d0 (Task 2)
- FOUND commit a136a4b (Task 3)

---
*Phase: 11-cloud-character-library*
*Plan: 01*
*Completed (Tasks 1-3): 2026-05-21*
*Task 4 (schema push): BLOCKED — awaits orchestrator/human*
