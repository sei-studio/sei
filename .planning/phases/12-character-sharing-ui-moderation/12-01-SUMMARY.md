---
phase: 12-character-sharing-ui-moderation
plan: 01
subsystem: database
tags: [supabase, migration, postgres, rls, moderation, reports, pg_net, database-webhook]

# Dependency graph
requires:
  - phase: 11-cloud-character-library
    provides: "public.characters table (owner, shared, persona_source, etc.) + RLS policy characters_select_own_or_shared + auth.users FK target"
provides:
  - characters.moderation_status / moderation_checked_at / moderation_provider / moderation_text_provider / moderation_text_checked_at columns
  - characters_moderation_status_chk constraint (clean/flagged/soft_flagged/clean_pending_retry)
  - characters_unmoderated_idx partial index for backfill walks
  - public.reports table (reporter_id, character_id, reason CHECK, detail<=500, created_at, resolved_at, resolution)
  - reports_character_recent_idx + reports_reporter_recent_idx
  - reports RLS enabled with ZERO insert/update/delete policies (service_role-only writes — Pitfall 4)
  - public.search_public_characters(text, int, int) RPC (security invoker; ILIKE search; cap 50)
  - GRANT EXECUTE on search_public_characters to anon + authenticated
  - tg_reports_auto_hide() + reports_auto_hide_trigger (3 distinct reporters in 24h -> shared=false)
  - tg_notify_report_inserted() + reports_after_insert_webhook (pg_net.http_post to notify-report Edge Function)
  - pg_net extension enabled in `extensions` schema
affects: [12-02-backfill-moderate-existing, 12-03-moderate-character-images, 12-04-moderate-character-prompt, 12-05-submit-report, 12-06-notify-report, 12-08-browse-list-rpc, 12-13-report-modal, 12-15-publish-with-moderation]

# Tech tracking
tech-stack:
  added: [pg_net (Postgres extension)]
  patterns:
    - "Insert-only-via-Edge-Function table (reports): RLS enabled, no insert policy, service_role inserts after Edge Function rate-limit"
    - "Database Webhook via pg_net.http_post in AFTER INSERT trigger (NOT pg_notify) — calls into Edge Function with Authorization: Bearer <service_role_key> sourced from current_setting('app.settings.*')"
    - "security invoker RPC over RLS-protected table — caller's RLS enforces shared=true visibility"
    - "Partial index keyed by created_at asc for idempotent backfill walks"
    - "Trigger ordering by alphabetical name so auto-hide runs BEFORE notification webhook"

key-files:
  created:
    - supabase/migrations/20260523000000_moderation_and_reports.sql
  modified: []

key-decisions:
  - "Reports table has NO RLS insert policy — all submissions route through Edge Function with service_role to enforce 5/hr rate limit (Pitfall 4)"
  - "Database Webhook via pg_net.http_post (NOT pg_notify) — pg_notify does not cross to Edge Functions (Pitfall 2)"
  - "search_public_characters returns rows where moderation_status IS NULL OR 'clean' — intentional during Phase 11->12 backfill window; tighten to '= clean' in follow-up migration after backfill (Pitfall 5)"
  - "characters_moderation_status_chk allows clean/flagged/soft_flagged/clean_pending_retry to support D-32d enum + Pitfall 5 retry path"
  - "Trigger alphabetical naming: reports_after_insert_webhook fires AFTER reports_auto_hide_trigger so webhook payload sees post-auto-hide state"
  - "Both trigger functions are security definer with pinned search_path; tg_reports_auto_hide UPDATE guarded by id = NEW.character_id (FK-validated) so elevation surface is minimal"

patterns-established:
  - "Edge-Function-only writes: enable RLS, omit insert policy, document the routing path in code comments — mirrors tos_acceptance immutability"
  - "Webhook trigger no-op fallback: when app.settings.edge_url or app.settings.service_role_key not configured, raise notice and return NEW so the INSERT itself never fails"

requirements-completed: [SHARE-02, SHARE-06, SHARE-07, SHARE-08]

# Metrics
duration: 3min
completed: 2026-05-22
---

# Phase 12 Plan 01: Moderation & Reports Schema Foundation Summary

**Additive Postgres migration: characters.moderation_* columns, reports table (insert-via-Edge-Function-only), search_public_characters security-invoker RPC, auto-hide trigger at 3 distinct reporters/24h, and Database Webhook trigger via pg_net.http_post.**

## Performance

- **Duration:** 3 min
- **Started:** 2026-05-22T08:00:13Z
- **Completed:** 2026-05-22T08:02:42Z
- **Tasks:** 4
- **Files modified:** 1 (one consolidated migration file)

## Accomplishments

- characters table extended with 5 moderation_* columns + CHECK constraint + partial index for backfill walks
- reports table created with reason CHECK constraint matching 4 canonical strings (sexual_content_minors, hate_speech_harassment, copyright_infringement, other) — these MUST stay in sync with src/shared/ipc.ts ReportReasonSchema (Wave 3 Plan 12-08) and ReportModal radio values (Wave 4 Plan 12-13)
- reports RLS enabled with ZERO insert/update/delete policies (Pitfall 4 — submissions route through submit-report Edge Function with service_role to enforce 5/hr rate limit)
- search_public_characters RPC defined as `language sql stable` with default `security invoker` so caller RLS (characters_select_own_or_shared) is honored; GRANT EXECUTE to anon + authenticated so signed-out Browse works
- ILIKE wildcard search across name + persona_source, hard-capped at 50 rows (DoS mitigation T-12-01-04)
- pg_net extension enabled in `extensions` schema
- tg_reports_auto_hide AFTER INSERT trigger flips characters.shared=false when count(distinct reporter_id) in last 24h >= 3 (`shared = true` guard avoids duplicate auto-hides)
- tg_notify_report_inserted AFTER INSERT trigger calls notify-report Edge Function via `net.http_post` (Pitfall 2 enforced — zero `pg_notify(` calls in code)

## Task Commits

Each task was committed atomically:

1. **Task 1: Add moderation columns + supporting index to characters** — `13d3ed7` (feat)
2. **Task 2: Create reports table + indexes + RLS (no insert-own policy)** — `13663ec` (feat)
3. **Task 3: Create search_public_characters RPC (security invoker)** — `5c34bc2` (feat)
4. **Task 4: Auto-hide trigger + Database Webhook trigger (pg_net.http_post)** — `0f3a10e` (feat)

## Files Created/Modified

- `supabase/migrations/20260523000000_moderation_and_reports.sql` — 185 lines, 4 sections in order: (1) characters moderation columns + partial index; (2) reports table + 2 indexes + RLS without insert policy; (3) search_public_characters RPC; (4) pg_net extension + auto-hide trigger + Database Webhook trigger.

## Decisions Made

1. **Sectioned single-file migration.** All 4 DDL units land in one migration file ordered: columns → reports table → RPC → triggers. Postgres requires columns to exist before any partial index that filters on them. Section banners in comments make review easy.
2. **CHECK constraint allows 4 moderation_status values + NULL.** Beyond D-32d's `clean`/`flagged`, the constraint accepts `soft_flagged` (D-33b soft regenerate verdict) and `clean_pending_retry` (Pitfall 5 — backfill can mark a row as scanned-but-retry-pending if SightEngine times out, so re-runs pick it up).
3. **No RLS insert policy on reports — service_role only.** Mirrors `tos_acceptance` immutability invariant and bakes the rate-limit enforcement into the submit-report Edge Function (D-34d's 5/hr would otherwise be bypassed by a direct INSERT — Pitfall 4).
4. **`security invoker` RPC.** Default-implicit `security invoker` so the existing `characters_select_own_or_shared` RLS policy filters out rows where `shared=false` for anon callers. `security definer` would bypass RLS and leak auto-hidden rows (T-12-01-03).
5. **`moderation_status IS NULL OR = 'clean'` in RPC.** Intentional during Phase 11→12 backfill window (Pitfall 5). A follow-up migration tightens this once `backfill-moderate-existing` completes and operator confirms `count(*) where shared=true and moderation_status is null == 0`.
6. **Webhook via pg_net.http_post, not pg_notify (Pitfall 2).** Edge Functions are external HTTP services and don't LISTEN. `pg_net` is the documented Supabase pattern for trigger → Edge Function fan-out.
7. **Trigger order via alphabetical naming.** `reports_after_insert_webhook` > `reports_auto_hide_trigger` lexicographically, so Postgres fires auto-hide FIRST. Webhook payload sees the post-auto-hide `characters.shared` state, which `notify-report` can detect via a secondary SELECT (Plan 12-06).
8. **Webhook is no-op if settings unset.** `tg_notify_report_inserted` issues a `raise notice` and returns NEW if `app.settings.edge_url` or `app.settings.service_role_key` is NULL. This keeps INSERTs from failing in environments where the operator hasn't yet configured the runbook settings (e.g., local dev).

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

None.

## Operator Runbook — Required Out-of-Band Settings

The Database Webhook trigger reads two settings via `current_setting('app.settings.*', true)`. These MUST be set out-of-band (NOT in this migration — secrets shouldn't live in git) before report notifications fire:

```sql
ALTER DATABASE postgres SET app.settings.edge_url          = 'https://<project-ref>.supabase.co';
ALTER DATABASE postgres SET app.settings.service_role_key  = '<service-role-jwt>';
```

Both settings live in the `app.settings.*` namespace (PostgreSQL convention for application-level GUCs that persist across reconnects). Verify:

```sql
select current_setting('app.settings.edge_url',          true) as edge_url,
       current_setting('app.settings.service_role_key',  true) as service_key_present;
```

If either is NULL, INSERTs to `reports` still succeed — the trigger just emits a NOTICE and skips the webhook call. Once both are set, fan-out to `notify-report` is live.

## Canonical Reason Enum

The reports.reason CHECK constraint enforces exactly these 4 strings:

| Value | UI label (Wave 4 Plan 12-13 ReportModal) |
|---|---|
| `sexual_content_minors` | "Sexual content involving minors" |
| `hate_speech_harassment` | "Hate speech / harassment" |
| `copyright_infringement` | "Copyright infringement" |
| `other` | "Other" |

These MUST stay in sync across three layers:

1. **DB layer:** this migration's CHECK constraint.
2. **IPC layer:** `src/shared/ipc.ts` `ReportReasonSchema` (Wave 3 Plan 12-08 — not yet implemented). Export as `z.enum([...])` with the same strings.
3. **Renderer layer:** `ReportModal.tsx` radio values (Wave 4 Plan 12-13 — not yet implemented). Use the IPC enum directly; never re-declare.

If a future plan adds or removes a value, ALL THREE LAYERS MUST CHANGE IN LOCKSTEP. The DB CHECK constraint will reject mismatched INSERTs from the submit-report Edge Function, surfacing the drift quickly.

## Verification Queries (Post-Deploy)

Run these on the local stack after `supabase db reset`, and again on the remote stack after `supabase db push`:

```sql
-- 1. Columns + constraint exist
\d+ public.characters
-- Expect: moderation_status, moderation_checked_at, moderation_provider,
--         moderation_text_provider, moderation_text_checked_at
--         + characters_moderation_status_chk constraint

-- 2. Reports table exists, RLS on, ZERO policies
select tablename, rowsecurity from pg_tables where tablename = 'reports';
-- Expect: rowsecurity = true
select policyname from pg_policies where tablename = 'reports';
-- Expect: 0 rows

-- 3. RPC exists and is security invoker (prosecdef = false)
select proname, prosecdef from pg_proc where proname = 'search_public_characters';
-- Expect: prosecdef = false

-- 4. Triggers exist
select tgname from pg_trigger where tgrelid = 'public.reports'::regclass and not tgisinternal;
-- Expect: reports_auto_hide_trigger, reports_after_insert_webhook
--         (alphabetical order = execution order)

-- 5. As anon (caller RLS applied): RPC returns only shared=true rows
set role anon;
select count(*) from public.search_public_characters('', 100, 0);
reset role;

-- 6. Direct INSERT as anon must fail (no insert policy)
set role anon;
insert into public.reports (reporter_id, character_id, reason)
  values (gen_random_uuid(), gen_random_uuid(), 'other');
-- Expect: ERROR: new row violates row-level security policy
reset role;

-- 7. Auto-hide: insert 3 distinct-reporter rows for one character; shared should flip to false
--    (run as service_role since RLS blocks anon inserts)
```

## Schema Push to Remote Supabase

Schema push to the remote Supabase project is operator-driven (`supabase db push` after this migration commits). Per the orchestrator note, push runs in `mode: yolo` auto-approved when reached. The migration is purely additive (no DROPs, no rewrites of Phase 11 invariants) so backward compatibility is preserved.

## Next Phase Readiness

**Wave 2 (Edge Functions) is unblocked:**

- Plan 12-02 `backfill-moderate-existing` can SELECT `WHERE shared=true AND moderation_status IS NULL ORDER BY created_at ASC` against the new partial index for efficient idempotent walks.
- Plan 12-03 `moderate-character-images` UPDATEs `moderation_status`, `moderation_checked_at`, `moderation_provider` — schema in place.
- Plan 12-04 `moderate-character-prompt` UPDATEs `moderation_text_provider`, `moderation_text_checked_at` — schema in place.
- Plan 12-05 `submit-report` INSERTs into `reports` via service_role (the only path that can INSERT; no insert policy exists).
- Plan 12-06 `notify-report` is the Edge Function endpoint the webhook trigger calls — once deployed, set `app.settings.edge_url` + `app.settings.service_role_key` to activate fan-out.

**Wave 3 (Browse UI) is unblocked:**

- Plan 12-08 `browse:list` IPC handler calls `supabase.rpc('search_public_characters', { search_query, page_limit, page_offset })`.
- ReportReasonSchema in `src/shared/ipc.ts` MUST use the exact 4 canonical strings from this migration.

**Wave 4 (Report flow) is unblocked:**

- ReportModal radio values MUST mirror the canonical reason enum.

## Self-Check: PASSED

- `supabase/migrations/20260523000000_moderation_and_reports.sql` — FOUND (185 lines, 4 sections in order)
- Commit `13d3ed7` (Task 1) — FOUND in git log
- Commit `13663ec` (Task 2) — FOUND in git log
- Commit `5c34bc2` (Task 3) — FOUND in git log
- Commit `0f3a10e` (Task 4) — FOUND in git log
- Migration grep: `pg_notify(` outside comments = 0 (Pitfall 2 enforced)
- Migration grep: `create policy.*reports.*insert` outside comments = 0 (Pitfall 4 enforced)
- Migration grep: `add column moderation_*` = 5 (D-32d schema complete)
- Migration grep: `security invoker` = 1 (RPC), `security definer` = 2 (trigger functions only)

---
*Phase: 12-character-sharing-ui-moderation*
*Completed: 2026-05-22*
