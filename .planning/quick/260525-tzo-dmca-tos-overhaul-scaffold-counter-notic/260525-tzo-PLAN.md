---
phase: quick-260525-tzo
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - supabase/migrations/20260528001500_dmca_strikes.sql
  - supabase/migrations/20260528001600_drop_copyright_infringement_reason.sql
  - supabase/functions/dmca-strike-enforce/index.ts
  - supabase/functions/dmca-strike-enforce/deno.json
  - supabase/functions/submit-report/index.ts
  - src/shared/ipc.ts
  - src/main/ipc.ts
  - src/main/cloud/moderationEdgeClient.ts
  - src/renderer/src/components/ReportModal.tsx
  - scripts/admin-resolve-report.ts
  - src/shared/legalVersions.ts
  - ../sei-website/terms.html
autonomous: true
requirements:
  - DMCA-F1
  - DMCA-F2
  - DMCA-F3
  - DMCA-F9
  - DMCA-F11
  - TOS-F12
  - TOS-F13
  - TOS-F20

must_haves:
  truths:
    - "terms.html §7 DMCA section displays an explicit placeholder block that an operator can fill after USCO registration (Name / Address / Phone / Email / USCO receipt URL); placeholder language tells the reader registration is pending so legal counsel can confirm visibility before public character sharing flips on."
    - "terms.html §7(b) Counter-Notification subsection lists all five §512(g)(3) elements verbatim (identification of removed material, good-faith statement under penalty of perjury, consent to federal court jurisdiction in the user's district of residence, signature, contact info), tells users where to send the counter-notice (dmca@sei.app), states the 10-14 business-day restore window, and warns that bad-faith counter-notices are subject to §512(f) liability."
    - "terms.html §4 contains a UGC warranty paragraph (user warrants ownership / rights to upload, no third-party IP/privacy/publicity violation) and an AI-generated-content allocation paragraph (AI output via user prompts is treated as the user's UGC for warranty + indemnity purposes; Sei asserts no ownership)."
    - "terms.html contains a new §11.5 Indemnification clause covering claims arising out of User Content (including AI-generated content), Service use, Terms violation, and third-party rights violation."
    - "src/shared/legalVersions.ts TOS_VERSION + PRIVACY_VERSION are both bumped to today's date (2026-05-26 is acceptable — current value — but if a same-day re-bump is needed for any reason the prior 2026-05-26 stays the floor); terms.html and privacy.html Effective Date strings stay in lockstep with the constants."
    - "Database table public.dmca_strike_events exists with RLS enabled, owner-SELECT-own policy, service_role-only INSERT via SECURITY DEFINER function public.record_dmca_strike(uuid, text, uuid, text); the threshold function public.dmca_strike_threshold_reached(uuid) returns true at count ≥ 3."
    - "Edge Function dmca-strike-enforce, when invoked with a strike event payload + valid X-Admin-Token header, records the strike, suspends the user via supabase.auth.admin.banUser when count ≥ 3, and unshares all of that user's characters. Below the threshold it records the strike and returns 200 with the running count. Auth gate is a constant-time compare against DMCA_STRIKE_ADMIN_TOKEN (mirrors backfill-moderate-existing M7 pattern)."
    - "Server-side reason allowlist no longer includes copyright_infringement: submit-report Edge Function returns 400 with a friendly message pointing users to dmca@sei.app per ToS §7 when a request carries reason='copyright_infringement'; the DB CHECK constraint on reports.reason is tightened to exclude the value; the canonical REPORT_REASONS const in src/shared/ipc.ts no longer lists it; the Zod enum in src/main/ipc.ts no longer lists it; the SubmitReportArgs union in moderationEdgeClient.ts no longer lists it; ReportModal.tsx no longer renders the radio option and surfaces a help line directing copyright complaints to dmca@sei.app per ToS §7."
    - "Operator CLI scripts/admin-resolve-report.ts accepts <report_id> <resolution> (resolutions: valid_dmca | dismissed | withdrawn), reads SUPABASE_SERVICE_ROLE_KEY from .env, on 'valid_dmca' calls dmca-strike-enforce with the reporting context (character + user) and flips characters.shared=false, and updates the reports row with resolved_at + resolution; on dismissed/withdrawn only updates the reports row."
  artifacts:
    - path: "supabase/migrations/20260528001500_dmca_strikes.sql"
      provides: "dmca_strike_events table + record_dmca_strike + dmca_strike_threshold_reached RPCs + user_dmca_strike_count view + RLS"
      contains: "create table public.dmca_strike_events"
    - path: "supabase/migrations/20260528001600_drop_copyright_infringement_reason.sql"
      provides: "Tightens reports.reason CHECK constraint to drop copyright_infringement"
      contains: "alter table public.reports"
    - path: "supabase/functions/dmca-strike-enforce/index.ts"
      provides: "Operator-triggered strike enforcement (record + suspend + unshare at threshold)"
      exports: ["default Deno.serve handler", "makeHandler factory"]
    - path: "supabase/functions/dmca-strike-enforce/deno.json"
      provides: "Import map mirroring submit-report's deno.json (supabase-js)"
    - path: "supabase/functions/submit-report/index.ts"
      provides: "Drops 'copyright_infringement' from REASON_ENUM; adds friendly DMCA-redirect message branch"
      contains: "REASON_ENUM"
    - path: "src/shared/ipc.ts"
      provides: "Updated REPORT_REASONS const (3 entries) + ReportReason type"
      contains: "export const REPORT_REASONS"
    - path: "src/main/ipc.ts"
      provides: "Updated BrowseReportSchema z.enum (3 entries, no copyright_infringement)"
      contains: "BrowseReportSchema"
    - path: "src/main/cloud/moderationEdgeClient.ts"
      provides: "Updated SubmitReportArgs reason union (3 entries)"
      contains: "SubmitReportArgs"
    - path: "src/renderer/src/components/ReportModal.tsx"
      provides: "Updated LABELS map (3 entries) + DMCA-redirect help text under fieldset"
      contains: "LABELS"
    - path: "scripts/admin-resolve-report.ts"
      provides: "Operator CLI to resolve a report row + optionally invoke dmca-strike-enforce"
      exports: ["main()"]
    - path: "src/shared/legalVersions.ts"
      provides: "TOS_VERSION + PRIVACY_VERSION (today's date — already 2026-05-26)"
      contains: "TOS_VERSION"
    - path: "../sei-website/terms.html"
      provides: "§4 warranty + §4 AI-content allocation + §7(a) DMCA placeholders + §7(b) counter-notice + §11.5 indemnification"
      contains: "Counter-Notification"
  key_links:
    - from: "supabase/functions/dmca-strike-enforce/index.ts"
      to: "public.record_dmca_strike"
      via: "admin.rpc('record_dmca_strike', {...})"
      pattern: "record_dmca_strike"
    - from: "supabase/functions/dmca-strike-enforce/index.ts"
      to: "public.dmca_strike_threshold_reached"
      via: "admin.rpc('dmca_strike_threshold_reached', {...})"
      pattern: "dmca_strike_threshold_reached"
    - from: "supabase/functions/dmca-strike-enforce/index.ts"
      to: "supabase.auth.admin.banUser"
      via: "admin.auth.admin.updateUserById(userId, { ban_duration: 'none' })"
      pattern: "ban_duration"
    - from: "supabase/functions/submit-report/index.ts"
      to: "REASON_ENUM (3 entries)"
      via: "string allowlist + redirect message branch"
      pattern: "dmca@sei\\.app"
    - from: "src/renderer/src/components/ReportModal.tsx"
      to: "REPORT_REASONS @shared/ipc"
      via: "REPORT_REASONS.map((r) => <radio>)"
      pattern: "REPORT_REASONS"
    - from: "scripts/admin-resolve-report.ts"
      to: "dmca-strike-enforce"
      via: "fetch(SUPABASE_URL + '/functions/v1/dmca-strike-enforce', { headers: { X-Admin-Token, Authorization } })"
      pattern: "dmca-strike-enforce"
    - from: "../sei-website/terms.html"
      to: "src/shared/legalVersions.ts"
      via: "Effective Date string co-bump"
      pattern: "Effective Date"
---

<objective>
Ship Cluster G — DMCA + ToS overhaul (scaffold). This plan closes 8 audit findings:
  - F1 (HIGH, USER-blocked) — DMCA designated-agent placeholders in terms.html (operator fills after USCO registration)
  - F2 (HIGH) — §512(g)(3) counter-notice procedure in terms.html
  - F3 (HIGH) — repeat-infringer strike tracking (dmca_strike_events table + RPCs + enforce Edge Function)
  - F9 (HIGH) — remove copyright_infringement from in-app report reason enum across all 5 layers (DB CHECK → submit-report → main Zod → renderer ipc + moderationEdgeClient → ReportModal)
  - F11 (MEDIUM) — operator CLI scripts/admin-resolve-report.ts
  - F12 (HIGH) — UGC warranty clause in terms.html §4
  - F13 (HIGH) — indemnification clause in new terms.html §11.5
  - F20 (HIGH) — AI-generated-content allocation clause in terms.html §4

Purpose: ship the legal + technical scaffolding so the operator can register the DMCA agent (USCO) and flip Browse + character-sharing on without §512 safe-harbor exposure. Strike-tracking schema lands ahead of the agent registration so reports flowing in from day one have a place to land + an enforcement path.

Output: 1 new SQL migration (strikes schema), 1 SQL migration (tighten reason CHECK), 1 new Edge Function (dmca-strike-enforce), 1 modified Edge Function (submit-report), 4 modified TS files (shared/ipc, main/ipc, moderationEdgeClient, ReportModal) to drop copyright_infringement, 1 new operator CLI script (admin-resolve-report.ts), 1 sei-website filesystem mod (terms.html overhaul), and a legalVersions.ts no-op verification (already at 2026-05-26 from Cluster F — no bump needed unless terms.html changes are material enough to warrant a same-day re-bump; this plan IS material so we keep the date).
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@./CLAUDE.md

# Migration patterns (the H6 reconciliation file is the gold-standard idempotent migration shape; the security_definer_guards file is the canonical SECURITY DEFINER + GRANT EXECUTE TO service_role pattern)
@supabase/migrations/20260528000000_security_definer_guards.sql
@supabase/migrations/20260528000300_reconcile_moderation_and_reports.sql

# Original reports schema (12-01) — the CHECK constraint we're tightening lives here; reconciliation file 20260528000300 is the parallel definition
@supabase/migrations/20260523000000_moderation_and_reports.sql

# Edge Function patterns
@supabase/functions/submit-report/index.ts
@supabase/functions/backfill-moderate-existing/index.ts
@supabase/functions/notify-report/index.ts

# Shared helpers reused by dmca-strike-enforce + admin-resolve-report
@supabase/functions/_shared/timingSafe.ts
@supabase/functions/_shared/cors.ts

# Renderer + main contract layers (drop copyright_infringement from all five)
@src/shared/ipc.ts
@src/main/ipc.ts
@src/main/cloud/moderationEdgeClient.ts
@src/renderer/src/components/ReportModal.tsx

# ToS overhaul target + version source-of-truth
# (sei-website is NOT a git repo on this machine — filesystem-only mod; operator deploys separately)
# ../sei-website/terms.html — read inline by the executor, not @-referenced (file lives outside the sei repo's tracking scope)
@src/shared/legalVersions.ts

<interfaces>
<!-- Key types and SQL surfaces the executor needs. Embedded so the executor does not re-explore. -->

From supabase/migrations/20260523000000_moderation_and_reports.sql (current reports CHECK constraint to tighten):
```sql
create table public.reports (
  id              uuid primary key default gen_random_uuid(),
  reporter_id     uuid not null references auth.users(id) on delete set null,
  character_id    uuid not null references public.characters(id) on delete cascade,
  reason          text not null check (reason in (
                    'sexual_content_minors',
                    'hate_speech_harassment',
                    'copyright_infringement',     -- TO BE DROPPED
                    'other'
                  )),
  detail          text check (char_length(detail) <= 500),
  created_at      timestamptz not null default now(),
  resolved_at     timestamptz,
  resolution      text
);
```

From src/shared/ipc.ts:316-322 (CURRENT — must shrink to 3 entries):
```typescript
export const REPORT_REASONS = [
  'sexual_content_minors',
  'hate_speech_harassment',
  'copyright_infringement',   // DROP
  'other',
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
```

From src/main/ipc.ts:920-930 (CURRENT BrowseReportSchema — drop copyright_infringement):
```typescript
const BrowseReportSchema = z.object({
  characterId: IdSchema,
  reason: z.enum([
    'sexual_content_minors',
    'hate_speech_harassment',
    'copyright_infringement',   // DROP
    'other',
  ]),
  detail: z.string().max(500).optional(),
});
```

From src/main/cloud/moderationEdgeClient.ts:50 (CURRENT SubmitReportArgs.reason union):
```typescript
reason: 'sexual_content_minors' | 'hate_speech_harassment' | 'copyright_infringement' | 'other';
```

From src/renderer/src/components/ReportModal.tsx:48-53 (CURRENT LABELS — drop copyright_infringement):
```typescript
const LABELS: Record<ReportReason, string> = {
  sexual_content_minors: 'Sexual content involving minors',
  hate_speech_harassment: 'Hate speech or harassment',
  copyright_infringement: 'Copyright infringement',   // DROP
  other: 'Other',
};
```

From supabase/functions/submit-report/index.ts:88-93 (CURRENT REASON_ENUM):
```typescript
const REASON_ENUM = [
  'sexual_content_minors',
  'hate_speech_harassment',
  'copyright_infringement',   // DROP — replace with explicit branch returning 400 + friendly DMCA-redirect message
  'other',
] as const;
```

From supabase/functions/backfill-moderate-existing/index.ts (admin-token gate pattern — mirror verbatim in dmca-strike-enforce):
```typescript
const adminToken = req.headers.get('X-Admin-Token');
const expectedToken = Deno.env.get('BACKFILL_ADMIN_TOKEN');  // dmca-strike-enforce uses DMCA_STRIKE_ADMIN_TOKEN
if (!adminToken || !expectedToken || !timingSafeEqual(adminToken, expectedToken)) {
  return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: JSON_HEADERS });
}
```

From supabase/migrations/20260528000000_security_definer_guards.sql (SECURITY DEFINER + GRANT pattern — mirror in dmca_strike_events RPCs):
```sql
create or replace function public.fn(p_x ...)
returns ...
language plpgsql security definer set search_path = public
as $$ ... $$;
revoke execute on function public.fn(...) from public, anon, authenticated;
grant execute on function public.fn(...) to service_role;
```

From src/shared/legalVersions.ts (CURRENT — keep date if no further bump needed, OR co-bump if material):
```typescript
export const TOS_VERSION = '2026-05-26';
export const PRIVACY_VERSION = '2026-05-26';
```
Today (planner-relative) is 2026-05-25; the constants are already dated 2026-05-26 from Cluster F. The Cluster G ToS additions (warranty + indemnification + AI clause + DMCA counter-notice + agent placeholders) are MATERIAL — they MUST trigger a fresh AcceptToSModal cycle. Since Cluster F shipped 2026-05-26 and we're shipping Cluster G the same calendar day, the constant stays at 2026-05-26 (single AcceptToSModal cycle that bundles both clusters' changes — per 12-15/13-22/Cluster F co-bump convention). If somehow the constant is BELOW 2026-05-26 when this executes, bump to 2026-05-26.
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Migration — dmca_strike_events table + RPCs + view + RLS (F3 DB)</name>
  <files>supabase/migrations/20260528001500_dmca_strikes.sql</files>
  <action>
Create `supabase/migrations/20260528001500_dmca_strikes.sql` following the idempotent + SECURITY DEFINER patterns from 20260528000300 (reconciliation gold-standard) and 20260528000000_security_definer_guards.sql.

Sections (write the header comment block first, naming F3 + audit cluster G + the operator workflow):

§1 — Table:
```sql
create table if not exists public.dmca_strike_events (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  reason        text not null,
  character_id  uuid references public.characters(id) on delete set null,
  evidence_url  text,
  notes         text,
  created_at    timestamptz not null default now()
);

create index if not exists dmca_strike_events_user_recent_idx
  on public.dmca_strike_events (user_id, created_at desc);
```

§2 — RLS:
```sql
alter table public.dmca_strike_events enable row level security;

-- Owner can SELECT own strikes (transparency — user can see their own record).
do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'dmca_strike_events'
       and policyname = 'dmca_strike_events_select_own'
  ) then
    create policy dmca_strike_events_select_own
      on public.dmca_strike_events
      for select
      using (auth.uid() = user_id);
  end if;
end $$;

-- NO insert/update/delete policies. service_role-only via record_dmca_strike RPC.
-- Mirrors reports table (12-01 Pitfall 4).
```

§3 — View (per-user count, security_invoker so caller RLS applies):
```sql
-- security_invoker view; caller (the user) sees ONLY their own count because the
-- underlying SELECT policy restricts to own rows. service_role bypasses RLS and
-- sees the full count for any user_id (consumed by record_dmca_strike +
-- dmca_strike_threshold_reached).
create or replace view public.user_dmca_strike_count
with (security_invoker = true)
as
select user_id, count(*)::int as strike_count
  from public.dmca_strike_events
 group by user_id;

grant select on public.user_dmca_strike_count to authenticated, service_role;
```

§4 — record_dmca_strike RPC (SECURITY DEFINER, service_role only):
```sql
create or replace function public.record_dmca_strike(
  p_user_id      uuid,
  p_reason       text,
  p_character_id uuid default null,
  p_notes        text default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
begin
  insert into public.dmca_strike_events (user_id, reason, character_id, notes)
    values (p_user_id, p_reason, p_character_id, p_notes)
    returning id into v_id;
  return v_id;
end;
$$;

revoke execute on function public.record_dmca_strike(uuid, text, uuid, text) from public, anon, authenticated;
grant   execute on function public.record_dmca_strike(uuid, text, uuid, text) to service_role;
```

§5 — dmca_strike_threshold_reached RPC (industry-standard 3-strike threshold, constant in body):
```sql
-- Industry-standard 3-strike threshold (DMCA repeat-infringer policy under
-- §512(i)(1)(A) requires "reasonably implemented" termination policy for
-- repeat infringers; 3 strikes is the de facto industry standard adopted by
-- YouTube, Twitch, Reddit, etc.). Constant lives inside the function so
-- callers cannot tamper. SECURITY DEFINER so the function reads the FULL
-- count via service_role bypass, even when invoked under a non-service JWT
-- (defense in depth — the only production caller is the Edge Function which
-- already runs as service_role, but defining as DEFINER guards against
-- accidental misuse).
create or replace function public.dmca_strike_threshold_reached(
  p_user_id uuid
)
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select count(*) from public.dmca_strike_events where user_id = p_user_id),
    0
  ) >= 3;
$$;

revoke execute on function public.dmca_strike_threshold_reached(uuid) from public, anon, authenticated;
grant   execute on function public.dmca_strike_threshold_reached(uuid) to service_role;
```

CRITICAL: every `create table`, `create index`, `alter table … enable row level security`, `create policy`, `create view`, and `create function` MUST be idempotent (`if not exists` / `create or replace` / catalog-guarded `do $$ ... if not exists ... $$`). Pattern reference: 20260528000300_reconcile_moderation_and_reports.sql.

DO NOT touch the reports table in this migration — that lives in Task 2.
  </action>
  <verify>
    <automated>cd /Users/ouen/slop/sei && grep -c "create table if not exists public.dmca_strike_events" supabase/migrations/20260528001500_dmca_strikes.sql | grep -E '^1$' && grep -c "create or replace function public.record_dmca_strike" supabase/migrations/20260528001500_dmca_strikes.sql | grep -E '^1$' && grep -c "create or replace function public.dmca_strike_threshold_reached" supabase/migrations/20260528001500_dmca_strikes.sql | grep -E '^1$' && grep -c "grant   execute on function public.record_dmca_strike" supabase/migrations/20260528001500_dmca_strikes.sql | grep -E '^1$' && grep -v '^--' supabase/migrations/20260528001500_dmca_strikes.sql | grep -c "with (security_invoker = true)" | grep -E '^1$' && grep -v '^--' supabase/migrations/20260528001500_dmca_strikes.sql | grep -c ">= 3" | grep -E '^1$'</automated>
  </verify>
  <done>Migration file exists at 20260528001500_dmca_strikes.sql with idempotent DDL for the strike events table, owner-select-own RLS policy, security_invoker view, record_dmca_strike SECURITY DEFINER RPC, dmca_strike_threshold_reached SECURITY DEFINER RPC, and the 3-strike threshold hardcoded in the function body. service_role-only GRANT EXECUTE on both RPCs. Migration NOT pushed to live DB (operator runbook).</done>
</task>

<task type="auto">
  <name>Task 2: Migration — drop copyright_infringement from reports.reason CHECK (F9 DB)</name>
  <files>supabase/migrations/20260528001600_drop_copyright_infringement_reason.sql</files>
  <action>
Create `supabase/migrations/20260528001600_drop_copyright_infringement_reason.sql`. Header comment naming F9 + cluster G + "all copyright complaints must flow through dmca@sei.app per ToS §7."

Approach: Postgres CHECK constraints cannot be ALTERed in place — drop + re-add. Both the original migration 20260523000000 and the H6 reconciliation 20260528000300 define the same constraint name pattern; use the catalog name `reports_reason_check` (auto-generated by Postgres on the column-level CHECK). The migration MUST be idempotent and survive re-runs.

```sql
-- ============================================================================
-- 260525-tzo Task 2 — Cluster G F9: drop copyright_infringement from reports.reason
-- ============================================================================
-- Audit finding F9 (HIGH): in-app report reason 'copyright_infringement' bypasses
-- the §512 DMCA notice procedure (no penalty-of-perjury statement, no signature,
-- no agent receipt). Tightening the DB CHECK constraint here is layer 3 of the
-- 4-layer defense (UI radio in ReportModal + main Zod enum + submit-report
-- REASON_ENUM + this CHECK + the now-explicit dmca-redirect 400 branch in
-- submit-report). Copyright complaints now flow through dmca@sei.app per ToS §7.
--
-- Pre-flight (operator MUST verify before push):
--   select count(*) from public.reports where reason = 'copyright_infringement';
--   -- If > 0: triage those rows manually (likely 0 in production because the
--   -- moderation pipeline is gated by browse_enabled=false and Browse is not
--   -- live yet — but verify; if non-zero, either resolve them out, change
--   -- their reason to 'other', or hold this migration until cleaned up).
-- ============================================================================

-- Drop the auto-generated CHECK constraint by its conventional name (lifted
-- verbatim from the original 12-01 / reconciliation 20260528000300 migrations).
-- The constraint name 'reports_reason_check' is what Postgres assigns to a
-- column-level CHECK on column 'reason' of table 'reports'.
do $$
begin
  if exists (
    select 1 from pg_constraint
     where conname = 'reports_reason_check'
       and conrelid = 'public.reports'::regclass
  ) then
    alter table public.reports drop constraint reports_reason_check;
  end if;
end $$;

-- Re-add the constraint WITHOUT copyright_infringement.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'reports_reason_check'
       and conrelid = 'public.reports'::regclass
  ) then
    alter table public.reports
      add constraint reports_reason_check
      check (reason in (
        'sexual_content_minors',
        'hate_speech_harassment',
        'other'
      ));
  end if;
end $$;
```

If the constraint name in the live DB differs (e.g., Postgres auto-named it `reports_reason_check1` due to a prior reconciliation re-add), the drop block silently no-ops and the add block re-adds the constraint under the canonical name. Resulting state is identical regardless of starting point.

DO NOT touch any other columns / policies / indexes / triggers. This migration is one-purpose.
  </action>
  <verify>
    <automated>cd /Users/ouen/slop/sei && grep -c "drop constraint reports_reason_check" supabase/migrations/20260528001600_drop_copyright_infringement_reason.sql | grep -E '^1$' && ! grep -q "copyright_infringement" supabase/migrations/20260528001600_drop_copyright_infringement_reason.sql && grep -c "sexual_content_minors" supabase/migrations/20260528001600_drop_copyright_infringement_reason.sql | grep -E '^1$' && grep -c "hate_speech_harassment" supabase/migrations/20260528001600_drop_copyright_infringement_reason.sql | grep -E '^1$'</automated>
  </verify>
  <done>Migration 20260528001600 exists; the file does NOT contain the literal "copyright_infringement" anywhere (verify); contains drop-and-re-add of reports_reason_check via catalog-guarded `do $$` blocks; new CHECK lists exactly 3 reasons (sexual_content_minors, hate_speech_harassment, other). Migration NOT pushed to live DB.</done>
</task>

<task type="auto">
  <name>Task 3: Edge Function — dmca-strike-enforce (F3 code)</name>
  <files>supabase/functions/dmca-strike-enforce/index.ts, supabase/functions/dmca-strike-enforce/deno.json</files>
  <action>
Create new Edge Function directory + 2 files.

`supabase/functions/dmca-strike-enforce/deno.json` (mirror submit-report's):
```json
{
  "imports": {
    "@supabase/supabase-js": "https://esm.sh/@supabase/supabase-js@2.106.0"
  }
}
```

`supabase/functions/dmca-strike-enforce/index.ts` — modeled on backfill-moderate-existing (admin-token gate pattern) + submit-report (two-client + makeHandler factory). ~180 lines.

Structure:

1. Header JSDoc naming F3 + cluster G + operator workflow:
   - Operator receives notify-report email for `copyright_infringement`-flavored complaint received via dmca@sei.app inbox (NOT through in-app report flow — that path is now blocked per F9).
   - Operator validates DMCA notice (5 §512(c)(3) elements present + good-faith assessment).
   - Operator calls `dmca-strike-enforce` via curl with `X-Admin-Token: $DMCA_STRIKE_ADMIN_TOKEN` and JSON body `{ user_id, reason, character_id?, notes? }`.
   - Function: records strike → checks threshold → if reached, bans user via auth admin API + unshares all characters + emails the user via Resend.
   - Below threshold: records strike + returns `{ ok: true, strike_count: N, threshold_reached: false }`.

2. Constants + imports:
```typescript
import { createClient } from '@supabase/supabase-js';
import { corsHeaders } from '../_shared/cors.ts';
import { timingSafeEqual } from '../_shared/timingSafe.ts';

const ENFORCE_TIMEOUT_MS = 15_000;
const EMAIL_FROM = 'Sei Moderation <reports@sei.app>';
const JSON_HEADERS = { ...corsHeaders, 'Content-Type': 'application/json' };
```

3. Body schema (loose runtime parsing — fail-closed on shape mismatch):
```typescript
interface StrikeRequest {
  user_id: string;        // uuid of the infringing user (auth.users.id)
  reason: string;         // short reason string (e.g., "DMCA notice from XYZ Corp re: Mickey Mouse skin")
  character_id?: string;  // optional uuid of the offending character (cascaded to characters.shared=false on enforce)
  notes?: string;         // optional free-form operator notes
  evidence_url?: string;  // optional URL to DMCA notice copy / screenshot
}
```
Validate via inline checks (uuid regex + non-empty reason; mirror submit-report's manual checks rather than pulling in Zod for Deno).

4. `makeHandler` factory (mirrors submit-report shape — injectable createClient for tests):
```typescript
export function makeHandler(
  deps?: { createClient?: typeof createClient },
): (req: Request) => Promise<Response> {
  const create = deps?.createClient ?? createClient;
  return async function handler(req: Request): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });

    // Auth gate 1 — Bearer sanity check (mirrors backfill-moderate-existing M7 pattern).
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'missing_jwt' }), { status: 401, headers: JSON_HEADERS });
    }

    // Auth gate 2 — X-Admin-Token constant-time compare (the identity gate).
    const adminToken = req.headers.get('X-Admin-Token');
    const expectedToken = Deno.env.get('DMCA_STRIKE_ADMIN_TOKEN');
    if (!adminToken || !expectedToken || !timingSafeEqual(adminToken, expectedToken)) {
      return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: JSON_HEADERS });
    }

    // Parse + validate body.
    let body: StrikeRequest;
    try { body = await req.json(); } catch {
      return new Response(JSON.stringify({ error: 'bad_request' }), { status: 400, headers: JSON_HEADERS });
    }
    if (typeof body.user_id !== 'string' || typeof body.reason !== 'string' || body.reason.length === 0) {
      return new Response(JSON.stringify({ error: 'bad_request', detail: 'user_id + reason required' }), { status: 400, headers: JSON_HEADERS });
    }
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(body.user_id)) {
      return new Response(JSON.stringify({ error: 'bad_request', detail: 'user_id must be uuid' }), { status: 400, headers: JSON_HEADERS });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const admin = create(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // Step 1 — record strike via SECURITY DEFINER RPC.
    const { data: strikeId, error: recordErr } = await admin.rpc('record_dmca_strike', {
      p_user_id: body.user_id,
      p_reason: body.reason,
      p_character_id: body.character_id ?? null,
      p_notes: body.notes ?? null,
    });
    if (recordErr) {
      return new Response(JSON.stringify({ ok: false, code: 'record_failed', message: recordErr.message }), { status: 500, headers: JSON_HEADERS });
    }

    // Step 2 — threshold check.
    const { data: thresholdReached, error: thresholdErr } = await admin.rpc('dmca_strike_threshold_reached', {
      p_user_id: body.user_id,
    });
    if (thresholdErr) {
      return new Response(JSON.stringify({ ok: false, code: 'threshold_check_failed', message: thresholdErr.message }), { status: 500, headers: JSON_HEADERS });
    }

    // Step 2.5 — get current strike count for response shape (best-effort).
    const { count: strikeCount } = await admin
      .from('dmca_strike_events')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', body.user_id);

    if (!thresholdReached) {
      return new Response(JSON.stringify({
        ok: true,
        strike_id: strikeId,
        strike_count: strikeCount ?? null,
        threshold_reached: false,
      }), { status: 200, headers: JSON_HEADERS });
    }

    // Step 3 — threshold REACHED → enforce.
    //
    // 3a. Suspend user (supabase-js auth admin API; use updateUserById with
    //     ban_duration='876000h' which is ~100y = effectively permanent;
    //     'none' would UN-ban, so we explicitly set a long duration).
    //     Per supabase-js docs, the ban_duration property on updateUserById
    //     accepts either 'none' (unban) or a Go-style duration string.
    const { error: banErr } = await admin.auth.admin.updateUserById(body.user_id, {
      ban_duration: '876000h',
    });
    // 3b. Unshare ALL of the user's characters.
    const { error: unshareErr } = await admin
      .from('characters')
      .update({ shared: false })
      .eq('owner', body.user_id);   // NOTE: characters.owner is the owner-uuid column; verify the column name when implementing
    // 3c. Notify user via Resend (best-effort; do not fail the response).
    const resendApiKey = Deno.env.get('RESEND_API_KEY');
    let emailDispatched = false;
    if (resendApiKey) {
      try {
        const userResp = await admin.auth.admin.getUserById(body.user_id);
        const userEmail = userResp.data.user?.email;
        if (userEmail) {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), ENFORCE_TIMEOUT_MS);
          const resendRes = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: EMAIL_FROM,
              to: userEmail,
              subject: 'Sei account suspended — DMCA repeat-infringer policy',
              text:
                "Your Sei account has been suspended per our DMCA repeat-infringer " +
                "policy (3 valid DMCA notices). All shared characters have been " +
                "unshared. If you believe this is in error, reply to this email.\n\n" +
                "— Sei Moderation",
            }),
            signal: controller.signal,
          });
          clearTimeout(timer);
          emailDispatched = resendRes.ok;
        }
      } catch (e) {
        console.error('dmca_strike_email_failed', e instanceof Error ? e.message : String(e));
      }
    }

    return new Response(JSON.stringify({
      ok: true,
      strike_id: strikeId,
      strike_count: strikeCount ?? null,
      threshold_reached: true,
      enforced: {
        ban_succeeded: !banErr,
        ban_error: banErr?.message ?? null,
        unshare_succeeded: !unshareErr,
        unshare_error: unshareErr?.message ?? null,
        email_dispatched: emailDispatched,
      },
    }), { status: 200, headers: JSON_HEADERS });
  };
}

export const handler = makeHandler();

if (import.meta.main) {
  Deno.serve(handler);
}
```

CRITICAL implementation notes:
1. Verify `characters.owner` column name by grepping the existing migrations / submit-report / cloudCharacterClient code before writing. If the column is named `owner_uuid` or `user_id` instead, use the correct name. Don't break the unshare query.
2. Use `import.meta.main` gate on `Deno.serve` so the module can be imported by future test files without binding port 8000 (matches submit-report convention).
3. Env reads MUST be inside the request handler (NOT module init) so `deno test` does not require `--allow-env`.
4. The `_shared/timingSafe.ts` helper already exists per Cluster A (M2 — verify import path before writing).
5. NO new deno tests required for this task (operator will smoke via curl per the runbook); the makeHandler factory is present so future tests can plug in.

CRITICAL: `deno check` MUST pass on the new index.ts before commit. Run:
```bash
cd supabase/functions/dmca-strike-enforce && deno check index.ts
```
  </action>
  <verify>
    <automated>cd /Users/ouen/slop/sei && test -f supabase/functions/dmca-strike-enforce/index.ts && test -f supabase/functions/dmca-strike-enforce/deno.json && grep -c "DMCA_STRIKE_ADMIN_TOKEN" supabase/functions/dmca-strike-enforce/index.ts | grep -qE '^[1-9][0-9]*$' && grep -c "timingSafeEqual" supabase/functions/dmca-strike-enforce/index.ts | grep -qE '^[1-9][0-9]*$' && grep -c "record_dmca_strike" supabase/functions/dmca-strike-enforce/index.ts | grep -qE '^[1-9][0-9]*$' && grep -c "ban_duration" supabase/functions/dmca-strike-enforce/index.ts | grep -qE '^[1-9][0-9]*$' && grep -c "import.meta.main" supabase/functions/dmca-strike-enforce/index.ts | grep -qE '^1$' && (cd supabase/functions/dmca-strike-enforce && deno check index.ts)</automated>
  </verify>
  <done>Edge Function dmca-strike-enforce exists with admin-token gate (X-Admin-Token + timingSafeEqual), JSON body schema validation, record_dmca_strike RPC call, threshold check, and threshold-crossed enforcement (banUser via updateUserById with ban_duration, unshare via UPDATE characters SET shared=false WHERE owner=user_id, Resend email best-effort). deno check passes. makeHandler factory + import.meta.main gate present.</done>
</task>

<task type="auto">
  <name>Task 4: Renderer + Edge Function + main + shared — drop copyright_infringement from all 5 layers (F9 code)</name>
  <files>supabase/functions/submit-report/index.ts, src/shared/ipc.ts, src/main/ipc.ts, src/main/cloud/moderationEdgeClient.ts, src/renderer/src/components/ReportModal.tsx</files>
  <action>
This task removes `copyright_infringement` from the canonical 4-layer enum chain (DB → submit-report → shared/ipc → main/ipc + moderationEdgeClient → ReportModal) AND adds a friendly redirect in the Edge Function pointing the user to dmca@sei.app per ToS §7.

**Subtask 4a — submit-report/index.ts (the trust boundary):**

In `supabase/functions/submit-report/index.ts`:

(i) Update `REASON_ENUM` (line 88) to drop `'copyright_infringement'`:
```typescript
const REASON_ENUM = [
  'sexual_content_minors',
  'hate_speech_harassment',
  'other',
] as const;
```

(ii) Insert a NEW explicit early-return branch BEFORE the existing `REASON_ENUM.includes` check (around line 226). The new branch detects the now-illegal `copyright_infringement` value and returns 400 with a friendly DMCA-redirect message — this is more user-friendly than a generic 400 `invalid_reason` because there ARE old clients still on the wire who haven't updated and we want them to see the right next step:

```typescript
// Cluster G F9: copyright_infringement is no longer a valid in-app report
// reason. Copyright complaints must follow the §512 DMCA procedure (penalty-
// of-perjury statement, signature, agent notice). Return a friendly 400 that
// tells the user where to file.
if (body.reason === 'copyright_infringement') {
  return new Response(
    JSON.stringify({
      ok: false,
      code: 'bad_request',
      message:
        'Copyright complaints must be filed via dmca@sei.app per our DMCA ' +
        'policy (see Terms of Service §7). The in-app report tool is for ' +
        'content policy violations only.',
    }),
    { status: 400, headers: JSON_HEADERS },
  );
}

if (!(REASON_ENUM as readonly string[]).includes(body.reason)) {
  return new Response(
    JSON.stringify({ error: 'bad_request', detail: 'invalid_reason' }),
    { status: 400, headers: JSON_HEADERS },
  );
}
```

(iii) Update the JSDoc near the top of the file: the existing comment lists 4 reasons in the lockstep-sites paragraph — update to 3 and add a line noting F9 dropped copyright_infringement to dmca@sei.app.

(iv) Run `deno check supabase/functions/submit-report/index.ts` — must pass.

(v) Run `deno test supabase/functions/submit-report/` — must still pass at 10/10 (current submit-report tests do NOT reference `copyright_infringement` per the planner's pre-flight grep, so this should be a no-op for the test suite).

**Subtask 4b — src/shared/ipc.ts:**

Update `REPORT_REASONS` (line 316) to 3 entries:
```typescript
export const REPORT_REASONS = [
  'sexual_content_minors',
  'hate_speech_harassment',
  'other',
] as const;
```

Update the JSDoc immediately above (the lockstep-sites paragraph) to note F9 dropped `copyright_infringement` and to remove it from the enumerated 4-site list (now 3 — DB CHECK + submit-report REASON_ENUM + ReportModal labels; the Zod enum in main/ipc.ts also needs the same).

**Subtask 4c — src/main/ipc.ts:**

Update `BrowseReportSchema.reason` (line 920-928) to 3 entries (drop `'copyright_infringement'`):
```typescript
const BrowseReportSchema = z.object({
  characterId: IdSchema,
  reason: z.enum([
    'sexual_content_minors',
    'hate_speech_harassment',
    'other',
  ]),
  detail: z.string().max(500).optional(),
});
```

**Subtask 4d — src/main/cloud/moderationEdgeClient.ts:**

Update `SubmitReportArgs.reason` (line 50) to 3 entries:
```typescript
reason: 'sexual_content_minors' | 'hate_speech_harassment' | 'other';
```

**Subtask 4e — src/renderer/src/components/ReportModal.tsx:**

(i) Update `LABELS` (line 48-53) to 3 entries (drop `copyright_infringement`):
```typescript
const LABELS: Record<ReportReason, string> = {
  sexual_content_minors: 'Sexual content involving minors',
  hate_speech_harassment: 'Hate speech or harassment',
  other: 'Other',
};
```

(ii) Add a small help line UNDER the closing `</fieldset>` (and ABOVE the existing `<label className={styles.detailLabel}>` for the detail textarea) directing copyright complaints to dmca@sei.app. Use existing CSS conventions (reuse a styled `<p>` with an existing class if possible, e.g. `className={styles.helpText}` — if that class doesn't exist, just use a plain `<p>` with inline styles matching the modal's text color, or add a `.helpText` rule to `ReportModal.module.css`):

```tsx
<p className={styles.helpText}>
  Copyright? Email{' '}
  <a href="mailto:dmca@sei.app" onClick={(e) => {
    e.preventDefault();
    void window.sei.openExternal('mailto:dmca@sei.app');
  }}>dmca@sei.app</a>{' '}
  per ToS §7.
</p>
```

If `window.sei.openExternal` doesn't accept `mailto:` (verify against Cluster E H5 `assertSafeExternalUrl` allowlist), make it a plain `<a href="mailto:...">` and let Electron's default link handler fire. Note: `mailto:` SHOULD be allowed per Cluster E's note about `cancelSubscription`'s `shell.openExternal` flow — verify by grepping `externalUrlValidator.ts` for `mailto`.

(iii) Run `npx tsc --noEmit -p tsconfig.web.json` — must pass clean (no new errors).

(iv) Run `npm test` (renderer-side vitest) — the ReportModal currently has no dedicated test (grep confirms only 19 vitest test files in renderer); 395/395 baseline must hold.

CRITICAL — the 5 layers are tightly coupled. Edit ALL FIVE files in this single task to avoid leaving the type system in an inconsistent intermediate state across the task boundary. The commit MUST land all 5 edits atomically.
  </action>
  <verify>
    <automated>cd /Users/ouen/slop/sei && ! grep -q "'copyright_infringement'" src/shared/ipc.ts && ! grep -q "'copyright_infringement'" src/main/ipc.ts && ! grep -q "'copyright_infringement'" src/main/cloud/moderationEdgeClient.ts && ! grep -q "copyright_infringement" src/renderer/src/components/ReportModal.tsx && ! grep -E "^[^/*]*'copyright_infringement'" supabase/functions/submit-report/index.ts && grep -q "dmca@sei.app" supabase/functions/submit-report/index.ts && grep -q "dmca@sei.app" src/renderer/src/components/ReportModal.tsx && (cd supabase/functions/submit-report && deno check index.ts) && npx tsc --noEmit -p tsconfig.web.json && (cd supabase/functions/submit-report && deno test --allow-env --no-check) && npx vitest run --reporter=dot 2>&1 | tail -5</automated>
  </verify>
  <done>All 5 layers (shared/ipc, main/ipc, moderationEdgeClient, ReportModal, submit-report Edge Function) updated atomically. The literal "copyright_infringement" no longer appears in any of the 5 files (verified by grep). submit-report has a new early-return branch returning 400 with the friendly dmca@sei.app redirect message. ReportModal renders 3 radio options + a help line pointing copyright complaints to dmca@sei.app. `deno check` clean on submit-report. `npx tsc --noEmit -p tsconfig.web.json` clean. submit-report's 10 deno tests still pass. vitest baseline preserved (395/395 — zero regressions).</done>
</task>

<task type="auto">
  <name>Task 5: Script — scripts/admin-resolve-report.ts (F11)</name>
  <files>scripts/admin-resolve-report.ts</files>
  <action>
Create `scripts/admin-resolve-report.ts` — Node TypeScript CLI run via `npx tsx`. Header JSDoc names F11 + cluster G + the operator workflow.

Usage:
```
npx tsx scripts/admin-resolve-report.ts <report_id> <resolution>
  <resolution>: valid_dmca | dismissed | withdrawn
```

Behavior matrix:
- `valid_dmca` — operator has validated a §512(c)(3)-compliant DMCA notice; script:
   1. SELECTs the report row to fetch character_id (and via that, the character owner).
   2. SELECTs `characters.owner` for character_id (so we know which user gets the strike).
   3. POSTs to `dmca-strike-enforce` with `{ user_id, reason: "valid DMCA notice (report_id=<uuid>)", character_id, notes: "resolved via admin-resolve-report.ts" }` + `X-Admin-Token: $DMCA_STRIKE_ADMIN_TOKEN` + `Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY`.
   4. UPDATEs the report row: `resolved_at = now(), resolution = 'valid_dmca'`.
   5. UPDATEs the character row: `shared = false`.
- `dismissed` — operator decided the report was not actionable; UPDATEs the report row only.
- `withdrawn` — operator was contacted by the reporter to withdraw; UPDATEs the report row only.

Code structure (~180 lines):
```typescript
#!/usr/bin/env node
/**
 * scripts/admin-resolve-report.ts — Cluster G F11
 *
 * Operator CLI to resolve a report row + optionally trigger DMCA strike
 * enforcement. Manual operator workflow until a web admin UI exists.
 *
 * Usage:
 *   npx tsx scripts/admin-resolve-report.ts <report_id> <resolution>
 *   <resolution> ∈ { valid_dmca | dismissed | withdrawn }
 *
 * Env (reads from process.env / .env — gitignored):
 *   SUPABASE_URL                — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY   — for direct DB reads/writes
 *   DMCA_STRIKE_ADMIN_TOKEN     — only required for valid_dmca resolution
 *
 * Exit codes:
 *   0 — success
 *   1 — usage / arg error
 *   2 — env missing
 *   3 — DB error
 *   4 — enforce call failed
 */
import { createClient } from '@supabase/supabase-js';

const RESOLUTIONS = ['valid_dmca', 'dismissed', 'withdrawn'] as const;
type Resolution = (typeof RESOLUTIONS)[number];

function usage(): never {
  console.error('usage: npx tsx scripts/admin-resolve-report.ts <report_id> <resolution>');
  console.error(`  <resolution> ∈ { ${RESOLUTIONS.join(' | ')} }`);
  process.exit(1);
}

async function main(): Promise<void> {
  const [, , reportId, resolutionRaw] = process.argv;
  if (!reportId || !resolutionRaw) usage();
  if (!(RESOLUTIONS as readonly string[]).includes(resolutionRaw)) usage();
  const resolution = resolutionRaw as Resolution;

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    console.error('missing env: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required');
    process.exit(2);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey);

  // Fetch the report row.
  const { data: report, error: reportErr } = await admin
    .from('reports')
    .select('id, character_id, reporter_id, reason, detail, created_at, resolved_at, resolution')
    .eq('id', reportId)
    .single();
  if (reportErr || !report) {
    console.error('report not found:', reportErr?.message ?? 'no row');
    process.exit(3);
  }
  if (report.resolved_at) {
    console.error('report already resolved at', report.resolved_at, 'with', report.resolution);
    process.exit(1);
  }

  if (resolution === 'valid_dmca') {
    const adminToken = process.env.DMCA_STRIKE_ADMIN_TOKEN;
    if (!adminToken) {
      console.error('missing env: DMCA_STRIKE_ADMIN_TOKEN required for valid_dmca');
      process.exit(2);
    }

    // Fetch the character owner.
    const { data: character, error: charErr } = await admin
      .from('characters')
      .select('id, owner, name')
      .eq('id', report.character_id)
      .single();
    if (charErr || !character) {
      console.error('character not found:', charErr?.message ?? 'no row');
      process.exit(3);
    }

    // POST to dmca-strike-enforce.
    const enforceRes = await fetch(`${supabaseUrl}/functions/v1/dmca-strike-enforce`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        'X-Admin-Token': adminToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        user_id: character.owner,
        reason: `valid DMCA notice (report_id=${reportId})`,
        character_id: character.id,
        notes: 'resolved via admin-resolve-report.ts',
      }),
    });
    const enforceBody = await enforceRes.json().catch(() => ({}));
    if (!enforceRes.ok) {
      console.error('dmca-strike-enforce failed:', enforceRes.status, enforceBody);
      process.exit(4);
    }
    console.log('strike recorded:', enforceBody);

    // Unshare the character.
    const { error: unshareErr } = await admin
      .from('characters')
      .update({ shared: false })
      .eq('id', character.id);
    if (unshareErr) {
      console.error('unshare failed:', unshareErr.message);
      process.exit(3);
    }
  }

  // Update the report row.
  const { error: resolveErr } = await admin
    .from('reports')
    .update({ resolved_at: new Date().toISOString(), resolution })
    .eq('id', reportId);
  if (resolveErr) {
    console.error('report update failed:', resolveErr.message);
    process.exit(3);
  }

  console.log(`report ${reportId} resolved as ${resolution}`);
}

main().catch((e) => {
  console.error('unhandled:', e);
  process.exit(1);
});
```

CRITICAL implementation notes:
1. Verify `characters.owner` column name matches the actual schema before writing (same caveat as Task 3). If the column is `owner_uuid` or `user_id`, use that name consistently across the file.
2. The shebang `#!/usr/bin/env node` is decorative when run via `npx tsx` — but include it so the file is also runnable as `chmod +x scripts/admin-resolve-report.ts && ./scripts/admin-resolve-report.ts` if the operator prefers.
3. NO tests — operator validates by running against a staging DB row.
4. `npx tsc --noEmit` (the repo's existing tsconfig that covers scripts/) MUST pass clean. If the script isn't currently included in any tsconfig, that's fine — `npx tsx` runs it without a tsconfig.
5. Document `.env` reading: do NOT call `dotenv.config()` automatically — operator is expected to either `source .env` or run `env $(cat .env | xargs) npx tsx scripts/admin-resolve-report.ts ...`. The script just reads `process.env` directly. Document this in the JSDoc.
  </action>
  <verify>
    <automated>cd /Users/ouen/slop/sei && test -f scripts/admin-resolve-report.ts && grep -c "valid_dmca\|dismissed\|withdrawn" scripts/admin-resolve-report.ts | grep -qE '^[3-9][0-9]*$|^[1-9][0-9]+$' && grep -c "dmca-strike-enforce" scripts/admin-resolve-report.ts | grep -qE '^[1-9][0-9]*$' && grep -c "DMCA_STRIKE_ADMIN_TOKEN" scripts/admin-resolve-report.ts | grep -qE '^[1-9][0-9]*$' && grep -c "SUPABASE_SERVICE_ROLE_KEY" scripts/admin-resolve-report.ts | grep -qE '^[1-9][0-9]*$' && npx tsx --check scripts/admin-resolve-report.ts 2>&1 | (grep -E "error|Error" && false || true)</automated>
  </verify>
  <done>scripts/admin-resolve-report.ts exists with the three-resolution branch, reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + DMCA_STRIKE_ADMIN_TOKEN from process.env, on valid_dmca fetches character + POSTs to dmca-strike-enforce + flips shared=false + updates report row, on dismissed/withdrawn just updates report row. `npx tsx --check` clean. Documented as manual operator workflow until web admin UI exists.</done>
</task>

<task type="auto">
  <name>Task 6: sei-website terms.html — DMCA placeholders + counter-notice + warranty + indemnification + AI clause (F1 + F2 + F12 + F13 + F20)</name>
  <files>../sei-website/terms.html, src/shared/legalVersions.ts</files>
  <action>
This is a filesystem-only mod (../sei-website is NOT a git repo on this machine — per workflow deviation inherited from 12-15 and 13-22 and Cluster F). The operator deploys via a separate sei-website push step.

The current terms.html state (read in pre-flight by the planner; full file is 257 lines):
- Effective Date: 2026-05-26 (current; KEEP unless we need a fresh date)
- §4 User-Generated Content — exists; needs (a) warranty paragraph + (b) AI-content allocation paragraph
- §7 DMCA Notices — exists with PLACEHOLDER agent constants already (`[Designated Agent — pending registration]` etc. from 12-14); needs (a) §7(a) header upgrade making the registration-pending status more explicit + (b) NEW §7(b) Counter-Notification subsection
- §11 Disclaimers — exists; needs NEW §11.5 Indemnification clause INSERTED between §11 and §12

Edit plan (apply in order to keep line numbers stable until each block is committed):

**Edit 1 — §4 User-Generated Content: add warranty + AI clause AFTER the existing two `<p>` blocks (after line 96, before line 98).**

Insert two new `<p>` blocks at the end of §4:
```html
      <p>
        <strong>Your rights warranty.</strong>
        You represent and warrant that you own or have obtained all necessary
        rights, licenses, consents, and permissions to use and authorize Sei to
        use any content you upload or share, including any name, image,
        likeness, persona, trademark, or copyrighted material; and that the
        content does not violate any third party's intellectual property,
        privacy, publicity, or other rights.
      </p>
      <p>
        <strong>AI-generated content.</strong>
        Sei may use AI to expand personas, generate text, or produce images.
        You direct these features by providing prompts and inputs. AI-generated
        content arising from your prompts is treated as your User-Generated
        Content for purposes of these Terms, including your representations in
        this Section 4 and your indemnity in Section 11.5. Sei does not assert
        ownership over AI-generated content created via your prompts.
      </p>
```

**Edit 2 — §7 DMCA Notices: upgrade placeholder block.**

REPLACE the current `<p><strong>Designated Agent:</strong>` block (currently lines 135-141 — the one with `id="dmca-name"` / `id="dmca-address"` / `id="dmca-receipt"`) WITH a more explicit placeholder block that signals the registration is in progress. Keep the same `id`s so any existing JS hooks survive. New block:

```html
      <p>
        <strong>Designated Agent:</strong><br>
        <em>[Sei is registering its DMCA designated agent with the US
        Copyright Office. The placeholders below will be replaced with the
        registered agent details before public character sharing is enabled
        for general users. Register at
        <a href="https://dmca.copyright.gov">https://dmca.copyright.gov</a>
        — REQUIRED BEFORE PUBLIC CHARACTER SHARING.]</em>
      </p>
      <p>
        Name: <span id="dmca-name">[DMCA AGENT NAME — operator to fill]</span><br>
        Address: <span id="dmca-address">[PHYSICAL MAILING ADDRESS — operator to fill]</span><br>
        Phone: <span id="dmca-phone">[PHONE — operator to fill]</span><br>
        Email: <a href="mailto:dmca@sei.app">dmca@sei.app</a><br>
        USCO directory listing: <a href="https://dmca.copyright.gov/list" id="dmca-receipt">[registered receipt URL — fill after USCO registration]</a>
      </p>
```

**Edit 3 — §7 DMCA Notices: add a new §7(b) Counter-Notification subsection.**

INSERT a new subsection AFTER the existing "Repeat infringers will have their accounts terminated." paragraph (currently around line 154, before §8). New block:

```html
      <h3>Counter-Notification — DMCA Section 512(g)</h3>
      <p>
        If you believe content you shared was removed or disabled by mistake or
        misidentification, you may submit a counter-notification under
        17 U.S.C. § 512(g)(3). A valid counter-notification must include all of
        the following:
      </p>
      <ol>
        <li>Identification of the removed or disabled material and its
            location (URL or other reference) prior to removal.</li>
        <li>A statement under penalty of perjury that you have a good-faith
            belief the material was removed or disabled as a result of
            mistake or misidentification.</li>
        <li>Your consent to the jurisdiction of the federal district court
            for the judicial district in which your address is located, or,
            if your address is outside the United States, the federal
            district court for the Western District of Washington, and your
            agreement to accept service of process from the person who
            provided the original DMCA notice or that person's agent.</li>
        <li>Your physical or electronic signature.</li>
        <li>Your name, address, and telephone number.</li>
      </ol>
      <p>
        Submit counter-notifications to
        <a href="mailto:dmca@sei.app">dmca@sei.app</a>. Sei will forward the
        counter-notification to the original complainant. Sei will restore the
        material within 10 to 14 business days after receipt of a valid
        counter-notification unless the original complainant files a court
        action seeking a restraining order against the user.
      </p>
      <p>
        <strong>Warning.</strong> Bad-faith counter-notifications — material
        misrepresentations that material was removed by mistake — are subject
        to liability under 17 U.S.C. § 512(f).
      </p>
```

**Edit 4 — Insert §11.5 Indemnification AFTER §11 Disclaimers + BEFORE §12 Limitation of Liability.**

Locate `<h2>12. Limitation of Liability</h2>` and INSERT immediately BEFORE it:

```html
      <h2 id="indemnification">11.5 Indemnification</h2>
      <p>
        You agree to indemnify, defend, and hold harmless Sei, its officers,
        employees, and affiliates from and against any and all claims,
        damages, liabilities, costs, and expenses (including reasonable
        attorneys' fees) arising out of or related to: (a) your User Content,
        including AI-generated content created via your prompts; (b) your use
        of the Service; (c) your violation of these Terms; or (d) your
        violation of any third party's intellectual property, privacy,
        publicity, or other rights.
      </p>
```

NOTE: do NOT renumber §12 → §12.5 or §13 → §14 etc. The "11.5" sub-numbering is intentional — it avoids the 7-section shift cascade that Cluster F (13-22) had to manage. The hash-anchor `#indemnification` provides a stable named link if anything ever cross-references this section.

**Edit 5 — Effective Date / version bump:**

The current Effective Date is `2026-05-26`. legalVersions.ts is also at `2026-05-26`. Today is 2026-05-25 per planner-relative date.

Decision rule:
- If the current legalVersions.ts TOS_VERSION + PRIVACY_VERSION are BOTH `2026-05-26` AND the terms.html Effective Date is `2026-05-26`, KEEP `2026-05-26` (single AcceptToSModal cycle with Cluster F — Cluster F already bumped today; users will get one combined re-accept).
- If for any reason the constants are < `2026-05-26`, bump to `2026-05-26`.

Since the planner has confirmed both are at `2026-05-26`, the action is: leave both files' dates unchanged. The Cluster G material adds (warranty + indemnification + AI clause + counter-notice + agent placeholders) ride under the SAME AcceptToSModal cycle that Cluster F already produced.

If the executor finds the dates have drifted below `2026-05-26` at edit time (e.g., a rebase / merge dropped Cluster F changes), bump both `src/shared/legalVersions.ts` constants to `2026-05-26` and the terms.html Effective Date string + footer `Effective 2026-05-23` line to `2026-05-26`.

Also update the footer line in terms.html (currently `<p class="legal__footer">Effective 2026-05-23 ...`) to match `Effective 2026-05-26` — this is a stale footer date that survived the 13-22 cluster F change in the body but not the footer.

**Edit 6 — Sanity grep + file count check after all edits:**

Run these verifier greps in `../sei-website/terms.html`:
- `grep -c "Counter-Notification" ../sei-website/terms.html` == 1
- `grep -c "indemnify, defend, and hold harmless" ../sei-website/terms.html` == 1
- `grep -c "AI-generated content arising from your prompts" ../sei-website/terms.html` == 1
- `grep -c "Your rights warranty" ../sei-website/terms.html` == 1
- `grep -c "11.5" ../sei-website/terms.html` >= 1
- `grep -c "REQUIRED BEFORE PUBLIC CHARACTER SHARING" ../sei-website/terms.html` == 1
- `grep -c "17 U.S.C. § 512(g)(3)" ../sei-website/terms.html` == 1
- `grep -c "17 U.S.C. § 512(f)" ../sei-website/terms.html` == 1
- `grep -c "2026-05-23" ../sei-website/terms.html` == 0 (the stale footer date should be GONE)
- `grep -c "2026-05-26" ../sei-website/terms.html` >= 2 (Effective Date header + footer)

If any of these fail, fix the edits and re-grep.

CRITICAL workflow note: ../sei-website is NOT a git repo. Edits land as persistent filesystem mods. The sei-repo commit for this task covers only `src/shared/legalVersions.ts` (no change expected, but the file is in `files_modified` for the audit trail) AND no other repo files. The Cluster G commit-set is therefore 5 sei-repo commits (Tasks 1-5) + 1 sei-website filesystem mod (this Task 6); legalVersions.ts is unchanged so the Task 6 sei-repo commit is empty (and skipped — git status will be clean for the sei repo after Task 6).
  </action>
  <verify>
    <automated>cd /Users/ouen/slop/sei && grep -c "Counter-Notification" ../sei-website/terms.html | grep -qE '^1$' && grep -c "indemnify, defend, and hold harmless" ../sei-website/terms.html | grep -qE '^1$' && grep -c "AI-generated content arising from your prompts" ../sei-website/terms.html | grep -qE '^1$' && grep -c "Your rights warranty" ../sei-website/terms.html | grep -qE '^1$' && grep -c "11.5" ../sei-website/terms.html | grep -qE '^[1-9][0-9]*$' && grep -c "REQUIRED BEFORE PUBLIC CHARACTER SHARING" ../sei-website/terms.html | grep -qE '^1$' && grep -c "17 U.S.C. § 512(g)(3)" ../sei-website/terms.html | grep -qE '^1$' && grep -c "17 U.S.C. § 512(f)" ../sei-website/terms.html | grep -qE '^1$' && (! grep -q "2026-05-23" ../sei-website/terms.html) && grep -c "2026-05-26" ../sei-website/terms.html | grep -qE '^[2-9]$|^[1-9][0-9]+$' && grep -c "TOS_VERSION = '2026-05-26'" src/shared/legalVersions.ts | grep -qE '^1$' && grep -c "PRIVACY_VERSION = '2026-05-26'" src/shared/legalVersions.ts | grep -qE '^1$'</automated>
  </verify>
  <done>terms.html contains: (a) §4 warranty paragraph + AI-content allocation paragraph, (b) upgraded §7 DMCA placeholder block with REGISTRATION-PENDING explicit notice + 5 placeholder fields, (c) new §7(b) Counter-Notification subsection listing all 5 §512(g)(3) elements + 10-14 day restore window + §512(f) bad-faith warning, (d) new §11.5 Indemnification clause, (e) footer Effective date updated 2026-05-23 → 2026-05-26 (stale footer fix). legalVersions.ts both constants at 2026-05-26 (unchanged from Cluster F; same-day AcceptToSModal cycle).</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Operator → dmca-strike-enforce Edge Function | Operator JWT + X-Admin-Token cross from the trusted operator's terminal into the Edge Function; constant-time admin-token compare is the identity gate (mirrors backfill-moderate-existing M7 pattern). |
| renderer / IPC body → submit-report | Untrusted reason string crosses from the renderer ReportModal through main Zod into the Edge Function body; the explicit copyright_infringement → 400 redirect branch is the last-mile redirect for old/stale clients. |
| Edge Function → public.record_dmca_strike | service_role caller (Edge Function) crosses into a SECURITY DEFINER RPC; GRANT EXECUTE TO service_role only — RPC body trusts caller-supplied user_id because service_role is the trust boundary. |
| Operator CLI → dmca-strike-enforce | HTTP boundary; same admin-token gate applies — CLI possesses SUPABASE_SERVICE_ROLE_KEY (in operator's local .env) and DMCA_STRIKE_ADMIN_TOKEN (separate secret per defense-in-depth: leaked service role alone does not enable strike enforcement). |
| sei-website terms.html → user browser | Public static HTML; no trust boundary, but legal-text fidelity is the invariant (verifier greps in Task 6 enforce verbatim §512(g)(3) and §512(f) wording). |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-tzo-01 | Spoofing | dmca-strike-enforce | mitigate | X-Admin-Token gate via timingSafeEqual against DMCA_STRIKE_ADMIN_TOKEN env var; missing token → 403 (fail-closed; mirrors backfill-moderate-existing M7 pattern). Bearer JWT presence is a sanity gate only — the admin token is identity authority. |
| T-tzo-02 | Tampering | dmca_strike_events table | mitigate | RLS enabled with owner-SELECT-own policy + ZERO insert/update/delete policies; record_dmca_strike RPC is SECURITY DEFINER with GRANT EXECUTE TO service_role only (revoked from public/anon/authenticated). Mirrors reports table pattern (12-01 Pitfall 4). |
| T-tzo-03 | Repudiation | dmca-strike-enforce enforcement | accept | All strikes recorded with `created_at` + `reason` + optional `notes` + `evidence_url`. Operator's curl invocation is logged in shell history. Acceptable: this is operator-only; no end-user repudiation surface. |
| T-tzo-04 | Information Disclosure | dmca-strike-enforce enforcement response | mitigate | Response body does NOT include the user's email address in the threshold-reached branch (only `ban_succeeded` / `unshare_succeeded` / `email_dispatched` booleans). The Resend email payload includes the user's own email (as the `to` field) but never logs it. |
| T-tzo-05 | Denial of Service | dmca-strike-enforce | accept | Operator-only surface; admin-token gate provides DoS protection (no anonymous invocation possible). Acceptable: low-volume operator endpoint. |
| T-tzo-06 | Elevation of Privilege | record_dmca_strike RPC | mitigate | SECURITY DEFINER with `set search_path = public` (prevents search-path injection per M1 Cluster A pattern). GRANT EXECUTE revoked from public/anon/authenticated; only service_role can invoke. |
| T-tzo-07 | Spoofing | submit-report copyright_infringement redirect | mitigate | Explicit early-return branch BEFORE the REASON_ENUM allowlist check ensures stale clients that still send `copyright_infringement` get a friendly redirect (not a generic 400). DB CHECK constraint is layer 4 defense — if a stale client bypasses all upper layers, the INSERT itself is rejected. |
| T-tzo-08 | Information Disclosure | admin-resolve-report.ts | mitigate | Reads SUPABASE_SERVICE_ROLE_KEY + DMCA_STRIKE_ADMIN_TOKEN from process.env only — never logged, never sent over the wire except as `Authorization: Bearer <key>` / `X-Admin-Token: <token>` HTTP headers per spec. `.env` is gitignored project-wide. |
| T-tzo-09 | Tampering | terms.html legal text | mitigate | Verifier greps in Task 6 assert verbatim presence of §512(g)(3) / §512(f) wording + 5-element counter-notice list + 11.5 indemnification clause + AI-content allocation paragraph. Any future drift fails the grep gate. |
| T-tzo-10 | Spoofing | dmca_strike_threshold_reached RPC | mitigate | SECURITY DEFINER with explicit GRANT EXECUTE TO service_role only — caller cannot tamper with the 3-strike threshold (constant lives in function body, not in a settable parameter or table row). |
</threat_model>

<verification>
End-to-end phase verification (run after all 6 tasks land):

1. **Migration syntax check** — `supabase db lint supabase/migrations/20260528001500_dmca_strikes.sql` and the F9 migration must report zero errors. (If `supabase db lint` is not available locally, the verifier greps in Tasks 1 + 2 are the proxy.)

2. **Edge Function `deno check`** — `cd supabase/functions/dmca-strike-enforce && deno check index.ts` clean. `cd supabase/functions/submit-report && deno check index.ts` clean.

3. **Renderer compile** — `npx tsc --noEmit -p tsconfig.web.json` clean. No new TS errors after dropping `copyright_infringement` from the 4 TS layers.

4. **Test baseline preserved** — `npm test` (vitest) holds at 395/395; `deno test supabase/functions/` holds at 61/61 (no new tests added by this plan).

5. **Verifier greps consolidated**:
   - `! grep -rn "'copyright_infringement'" src/ supabase/migrations/20260528001600_drop_copyright_infringement_reason.sql` — copyright_infringement gone from all 4 TS layers (the migration file legitimately mentions the string only inside `do $$` SQL strings; the negation excludes that file).
   - Wait — refine: `grep -rn "copyright_infringement" src/` should return 0 lines (no `src/` files mention it).
   - `grep -rn "copyright_infringement" supabase/functions/` should return 0 lines (submit-report's REASON_ENUM no longer has it; the redirect branch references the literal string in the comparison `body.reason === 'copyright_infringement'` — THAT IS THE EXCEPTION; the verifier asserts that the function body uses the literal once for the comparison + once or twice in the friendly-message strings/comments).
   - Refined: `grep -c "copyright_infringement" supabase/functions/submit-report/index.ts` should be small (1 in the equality check + 1 in the friendly-message comment context — total ≤ 3).
   - All terms.html greps from Task 6 verifier.

6. **Operator runbook synthesis** — Task 3 produces SUMMARY that documents the curl example for dmca-strike-enforce + the new env vars (DMCA_STRIKE_ADMIN_TOKEN); Task 5 SUMMARY documents the admin-resolve-report CLI usage; Task 6 SUMMARY documents the placeholder fields the operator must fill in terms.html after USCO registration.
</verification>

<success_criteria>
- [ ] 6 tasks completed in single wave (all atomic, no checkpoints)
- [ ] 2 new migrations under supabase/migrations/ (20260528001500 + 20260528001600); both idempotent + survive re-runs
- [ ] 1 new Edge Function (dmca-strike-enforce) with admin-token gate + RPC calls + ban/unshare/notify enforcement; deno check passes
- [ ] submit-report Edge Function tightened: REASON_ENUM = 3 entries; copyright_infringement → 400 friendly redirect message pointing to dmca@sei.app per ToS §7
- [ ] 4 TS layer files (shared/ipc, main/ipc, moderationEdgeClient, ReportModal) all drop copyright_infringement
- [ ] ReportModal renders 3 radio options + dmca@sei.app help line
- [ ] scripts/admin-resolve-report.ts CLI exists with 3-resolution branch (valid_dmca + dismissed + withdrawn), tsx-runnable, env-aware
- [ ] terms.html updated: §4 warranty + AI-content allocation, §7 upgraded DMCA placeholder + new §7(b) counter-notification, new §11.5 indemnification, footer Effective date fix
- [ ] legalVersions.ts unchanged (already at 2026-05-26 from Cluster F; same-day AcceptToSModal cycle bundles Cluster G material)
- [ ] vitest baseline 395/395 preserved; deno baseline 61/61 preserved
- [ ] npx tsc --noEmit -p tsconfig.web.json clean
- [ ] No migrations pushed to live DB; no Edge Function deployed — operator runbook items
- [ ] 5 sei-repo commits (Tasks 1-5) + 1 sei-website filesystem mod (Task 6, legalVersions.ts unchanged so no sei-repo commit for Task 6)
</success_criteria>

<output>
After completion, create `.planning/quick/260525-tzo-dmca-tos-overhaul-scaffold-counter-notic/260525-tzo-SUMMARY.md` documenting:
- 8 audit findings closed (F1, F2, F3, F9, F11, F12, F13, F20) — mark F1 as USER-blocked (placeholder shipped; operator must register the DMCA agent at copyright.gov and fill in agent details before flipping browse_enabled=true).
- 2 new migrations + their idempotency strategy; operator MUST run `supabase db push` (NOT applied to live).
- 1 new Edge Function (dmca-strike-enforce) + its env vars (DMCA_STRIKE_ADMIN_TOKEN — operator MUST set via `supabase secrets set DMCA_STRIKE_ADMIN_TOKEN=<random 32-char token>` AND `supabase functions deploy dmca-strike-enforce`).
- 1 new operator CLI (admin-resolve-report.ts) + usage example.
- 5-layer copyright_infringement drop chain (DB CHECK → submit-report → shared/ipc → main/ipc + moderationEdgeClient → ReportModal); call out the friendly redirect message visible to stale clients.
- terms.html overhaul; placeholder fields that operator must fill post-USCO-registration (Name / Address / Phone / Email / USCO receipt URL); note the 11.5 sub-numbering choice avoided the 7-section shift cascade Cluster F navigated.
- legalVersions.ts not bumped — same-day Cluster F co-bump convention; users get ONE combined AcceptToSModal cycle covering Cluster F + Cluster G changes.
- Test posture: vitest 395/395 + deno 61/61 baseline preserved; zero new tests added (operator validates dmca-strike-enforce via curl in the runbook).
- Operator runbook items (compact):
  1. `supabase db push` to apply 20260528001500 + 20260528001600
  2. `supabase secrets set DMCA_STRIKE_ADMIN_TOKEN=<random>`
  3. `supabase functions deploy dmca-strike-enforce`
  4. Register DMCA agent at https://dmca.copyright.gov, fill terms.html placeholders, deploy sei-website
  5. Test admin-resolve-report.ts against a throwaway report row in staging
- Cross-reference to Cluster F (260525-sbo) and Cluster C (260525-qy0) for related items
</output>
