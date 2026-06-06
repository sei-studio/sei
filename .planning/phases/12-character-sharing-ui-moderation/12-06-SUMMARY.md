---
phase: 12-character-sharing-ui-moderation
plan: 06
subsystem: api
tags: [supabase, edge-function, webhook, discord, resend, moderation, fan-out]

# Dependency graph
requires:
  - phase: 12-character-sharing-ui-moderation (Plan 12-01)
    provides: "reports_after_insert_webhook trigger that pg_net.http_posts { report_id, character_id } payload with Authorization: Bearer <service_role_key> to /functions/v1/notify-report; reports_auto_hide_trigger that flips characters.shared=false at 3 distinct reporters / 24h BEFORE this webhook fires (alphabetical trigger ordering invariant)"
provides:
  - supabase/functions/notify-report Edge Function
  - Bearer service_role_key verbatim auth gate (T-12-06-01 mitigation)
  - Auto-hide detection via post-trigger SELECT of characters.shared
  - Discord webhook fan-out (URL never logged — T-12-06-02)
  - dmca@sei.app triage email via Resend with admin actions cheat-sheet
  - Creator notification email on auto-hide (reporter_id NOT disclosed — T-12-06-06)
  - 15s AbortController timeout on every outbound fetch (CLAUDE.md invariant)
  - Always-200 response so webhook never retry-storms (T-12-06-05)
affects: [12-13-report-modal (none — submit-report owns the renderer-facing surface), 12-17-operator-runbook (must document supabase secrets set DISCORD_REPORT_WEBHOOK_URL + RESEND_API_KEY + EMAIL_FROM sender domain verification)]

# Tech tracking
tech-stack:
  added: [Resend (transactional email), Discord webhooks (channel fan-out)]
  patterns:
    - "Service-role bearer verbatim compare as defense for un-HMAC-signed Supabase free-tier Database Webhooks"
    - "Best-effort outbound fan-out: log failures, return 200 always — the DB row is the record-of-truth, side channels are advisory"
    - "Trigger ordering by alphabetical naming → webhook payload reads post-auto-hide characters.shared state"
    - "Never log secret-bearing URLs (Discord webhook URL is secret-equivalent — Pitfall 12-PATTERNS)"
    - "timedFetch helper wrapping every external call in an AbortController + 15s timeout (CLAUDE.md)"
    - "import.meta.main gate on Deno.serve so a future test module can import handler without binding port 8000 (matches submit-report)"

key-files:
  created:
    - supabase/functions/notify-report/index.ts
    - supabase/functions/notify-report/deno.json
    - supabase/functions/notify-report/deno.lock
  modified: []

key-decisions:
  - "Compare full `Bearer <key>` header verbatim (not just the token after the prefix) so a caller sending `Authorization: <key>` without the prefix is also rejected"
  - "Emit a structured `notify_report_misconfigured_no_service_key` error and 500 if SUPABASE_SERVICE_ROLE_KEY is missing rather than fail-open accepting any request"
  - "Return 200 with `{ skipped: 'enrich_failed' }` if the report or character row vanished between trigger fire and our SELECT — webhook retries would be meaningless since the underlying state is already gone"
  - "Creator email cites the reason CATEGORY (e.g. `copyright_infringement`) but NEVER the reporter_id — T-12-06-06 disposition is `accept` for reason-category disclosure but `mitigate` for reporter identity disclosure"
  - "EMAIL_FROM = `Sei Moderation <reports@sei.app>` — `reports@` rather than `noreply@` because the creator email tells users to reply to the email address. Resend will need the sei.app domain verified with SPF/DKIM for the `reports@` mailbox to deliver"
  - "Triage email body includes admin SQL cheat-sheet (restore character / resolve report) so the on-call human can act without grepping for SQL — minor UX win during incident response"
  - "Single `timedFetch` helper used by all three outbound fan-out calls — error labels are static strings (`discord_post`, `resend_triage_email`, `resend_creator_email`) so URLs never reach console.error"

patterns-established:
  - "Database Webhook consumer Edge Function shape: Bearer-verbatim auth → enrich-via-service_role SELECT → best-effort fan-out (each call independent, all timed) → always-200"
  - "Pre-baked admin runbook in the triage email body — operator gets SQL snippets to act without context-switching"

requirements-completed: [SHARE-08]

# Metrics
duration: 4min
completed: 2026-05-22
---

# Phase 12 Plan 06: notify-report Edge Function Summary

**Database Webhook consumer that fans report INSERTs out to Discord + dmca@sei.app via Resend, detects auto-hide via post-trigger SELECT, and notifies creators when their character is hidden — Bearer-verbatim auth, secret-URL-never-logged, always-200 to prevent webhook retry-storm.**

## Performance

- **Duration:** 4 min
- **Started:** 2026-05-22T08:33:00Z
- **Completed:** 2026-05-22T08:37:19Z
- **Tasks:** 1 (single comprehensive Edge Function)
- **Files modified:** 3 created (index.ts + deno.json + deno.lock)

## Accomplishments

- `supabase/functions/notify-report/index.ts` Edge Function (~290 lines) implements the full fan-out contract from Plan 12-06.
- Bearer service_role_key verbatim compare on the `Authorization` header — defends the un-HMAC-signed Supabase free-tier Database Webhook surface (T-12-06-01).
- Auto-hide detection via post-trigger SELECT of `characters.shared` — works because Plan 12-01's trigger naming (`reports_auto_hide_trigger` < `reports_after_insert_webhook` lexicographically) guarantees auto-hide fires first.
- Discord fan-out via `DISCORD_REPORT_WEBHOOK_URL` env var; URL never reaches `console.error` in any code path (T-12-06-02).
- Resend fan-out via `RESEND_API_KEY` env var; sender `Sei Moderation <reports@sei.app>` (operator must verify `sei.app` domain DKIM/SPF in Resend dashboard).
- Triage email to `dmca@sei.app` includes admin SQL cheat-sheet so on-call can restore/resolve without separate doc lookup.
- Creator notification email on auto-hide via `admin.auth.admin.getUserById` — cites the reason category, never the reporter_id (T-12-06-06).
- Every outbound `fetch` wrapped in a 15s `AbortController` (CLAUDE.md invariant).
- Always-200 response — even on missing config, enrichment failure, or 100% downstream failure, the webhook receives 200 so it does not retry-storm (T-12-06-05). The DB row is the record-of-truth.
- `import.meta.main` gate on `Deno.serve` — future test modules can import `handler` without binding port 8000 (matches the `submit-report` convention).

## Task Commits

Each task was committed atomically:

1. **Task 1: Implement notify-report Edge Function** — `6115ae6` (feat)
2. **Lockfile addendum:** add `deno.lock` mirroring `submit-report` convention — `c379712` (chore)

## Files Created/Modified

- `supabase/functions/notify-report/index.ts` — 290 lines. Single `handler` async function exported (test-friendly) + `if (import.meta.main) Deno.serve(handler)` gate. Five logical sections: (1) AuthN — Bearer service_role verbatim compare; (2) Body validation — `report_id` + `character_id` uuid-string guard; (3) Enrichment — service_role parallel SELECT of `reports` + `characters` rows; (4) Outbound fan-out — Discord webhook + Resend triage email + (conditional) Resend creator email, each via the shared `timedFetch` helper; (5) Always-200 response.
- `supabase/functions/notify-report/deno.json` — pins `@supabase/supabase-js@2.106.0` from esm.sh, matching `submit-report` and `delete-me`.
- `supabase/functions/notify-report/deno.lock` — generated by `deno check`; checked in to match the `submit-report` precedent.

## Decisions Made

1. **Verbatim `Bearer <key>` compare, not just the token.** A caller sending `Authorization: <key>` (no Bearer prefix) gets 401 because the expected string includes the prefix. This is slightly stricter than checking the trailing token, which is desirable since Plan 12-01 always sends the Bearer prefix.
2. **Misconfig → 500, not 401.** If `SUPABASE_SERVICE_ROLE_KEY` is unset (impossible on Supabase runtime since it's auto-injected, but possible during a future migration), we 500 + log `notify_report_misconfigured_no_service_key` rather than fail-open accepting any request. Webhook retries on 500 won't fix the misconfig either — operator must act.
3. **Vanished-row → 200 with `skipped: 'enrich_failed'`.** Reports/characters FK guarantees both rows exist at INSERT time, but they can be deleted between trigger fire and our SELECT (rare). Returning 200 instead of 5xx avoids retry-storms for state that no longer exists.
4. **Reason category disclosed to creator; reporter_id is NOT.** T-12-06-06's disposition was `accept` for reason-category disclosure; we explicitly only include `report.reason` (e.g. `copyright_infringement`) in the creator email body — no `reporter_id`.
5. **`reports@sei.app` rather than `noreply@`.** The creator email tells users to reply for human review; using a no-reply address would either bounce or silently drop replies. `reports@sei.app` aliases (or shares an inbox) with `dmca@sei.app` per operator runbook.
6. **Triage email pre-bakes admin SQL.** The body includes copy-paste SQL for the three most common moderator actions (review row, un-hide character, resolve report). On-call gets actionable context inline rather than chasing a doc link during an incident.
7. **Single `timedFetch` helper, static error labels.** Three outbound calls (Discord, Resend triage, Resend creator) all funnel through one helper. Error labels are compile-time-static strings — the URL itself never passes through `console.error`, eliminating an entire class of accidental URL-leak bugs.

## Deviations from Plan

None — plan executed exactly as written.

The plan code in `<task type="auto">` was inlined wholesale with three additive tightenings that don't change semantics:

1. Extracted the per-call AbortController + timeout into a single `timedFetch` helper to keep the three fan-out call-sites scannable and uniform.
2. Added a `SUPABASE_SERVICE_ROLE_KEY` undefined guard with a structured 500 response — defense against a hypothetical future where the runtime no longer auto-injects this var.
3. Returned 200 with `{ skipped: 'enrich_failed' }` rather than 404 when the report or character row has vanished — webhook retries are meaningless once the row is gone, so 404 would mis-signal a recoverable error.

None of these qualify as Rule-1/2/3 deviations under the deviation guidance — they're refactors that preserve the plan's invariants. Recorded here for traceability.

## Issues Encountered

None.

## User Setup Required

**Operator runbook (out-of-band, before fan-out goes live):**

```bash
# Set the Discord webhook URL (operator creates the channel webhook in Discord → Server Settings → Integrations → Webhooks)
supabase secrets set DISCORD_REPORT_WEBHOOK_URL='https://discord.com/api/webhooks/...'

# Set the Resend API key (operator creates the key in resend.com dashboard → API Keys)
supabase secrets set RESEND_API_KEY='re_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'

# Deploy the function
supabase functions deploy notify-report

# Verify Plan 12-01's database webhook trigger settings are populated
# (these were set out-of-band per the 12-01 runbook):
psql "$SUPABASE_DB_URL" -c "select current_setting('app.settings.edge_url', true), (current_setting('app.settings.service_role_key', true) is not null) as key_set;"
```

**Database Webhook configuration in Supabase Dashboard** — the trigger that calls this function was created by Plan 12-01 (`reports_after_insert_webhook`). The `app.settings.edge_url` and `app.settings.service_role_key` GUCs must be set at the database level per Plan 12-01's runbook. No additional Dashboard webhook configuration is required for Plan 12-06.

**Resend domain verification:**
- Add the SPF + DKIM TXT records that Resend's dashboard generates for `sei.app` to the operator's DNS provider.
- Configure `reports@sei.app` as a verified sending identity (or as an alias of `dmca@sei.app` if the inbox is shared).
- Until verification completes, Resend rejects sends — `notify-report` will log `resend_triage_email_http_403` and still return 200 to the webhook (graceful degradation).

**Smoke test:**
1. As authenticated user A, submit a report via `submit-report` Edge Function on character X.
2. Within a few seconds, Discord channel receives a `⚠️ New report for character ...` post.
3. `dmca@sei.app` inbox receives an email with the same content + admin SQL cheat-sheet.
4. Repeat with users B and C reporting the same character X within 24h.
5. The third report fires `reports_auto_hide_trigger` (Plan 12-01) → `characters.shared` flips to false → `notify-report` reads the updated row → Discord post shows `🚨 AUTO-HIDDEN` + the character X owner receives a friendly heads-up email at their auth-account email address.
6. Direct curl without the service_role bearer should return 401.

## Trigger Ordering Invariant (critical to correctness)

Plan 12-01 created two AFTER INSERT triggers on `public.reports`:

| Trigger name | Function | Fires |
|---|---|---|
| `reports_after_insert_webhook` | `tg_notify_report_inserted` | SECOND (lexicographically later) |
| `reports_auto_hide_trigger` | `tg_reports_auto_hide` | FIRST (lexicographically earlier) |

Postgres documents trigger firing order as alphabetical on `tgname`. By the time `tg_notify_report_inserted` calls `net.http_post` → `notify-report`, the auto-hide trigger has already finished its `UPDATE characters SET shared=false WHERE id=NEW.character_id` (if the 3-distinct-reporters threshold was crossed in the same transaction as this INSERT). When `notify-report` runs its `SELECT shared FROM characters WHERE id=...`, it sees the post-auto-hide value.

**If anyone renames these triggers, the invariant breaks.** Both triggers must keep their current names, OR the new names must preserve `auto_hide < webhook` lexicographic ordering.

## Next Phase Readiness

**Wave 3 (Browse UI + IPC) is unblocked:**

- Plan 12-13 (ReportModal) calls `submit-report` (Plan 12-05); the reporter never knows about `notify-report` — fan-out is operator-facing.
- Plan 12-17 (operator runbook) should append the Resend domain verification + `supabase secrets set` commands from this summary.

**Pre-launch checklist (CONTEXT D-36 BROWSE_ENABLED gate):**
- (c) Edge Functions deployed — `notify-report` now in scope. After `supabase functions deploy notify-report`, the BROWSE_ENABLED prereq for `notify-report` is satisfied.

## Self-Check: PASSED

- `supabase/functions/notify-report/index.ts` — FOUND
- `supabase/functions/notify-report/deno.json` — FOUND
- `supabase/functions/notify-report/deno.lock` — FOUND
- Commit `6115ae6` (Task 1 feat) — FOUND in git log
- Commit `c379712` (lockfile chore) — FOUND in git log
- `grep -c "console.*discordUrl\|console.*DISCORD_REPORT_WEBHOOK_URL" supabase/functions/notify-report/index.ts` = 0 (Discord URL never logged — T-12-06-02 enforced)
- Plan verification grep (`SUPABASE_SERVICE_ROLE_KEY|expected|auto_hidden|RESEND_API_KEY|DISCORD_REPORT_WEBHOOK_URL`) returns >3 matches
- `deno check supabase/functions/notify-report/index.ts` passes cleanly

---
*Phase: 12-character-sharing-ui-moderation*
*Completed: 2026-05-22*
