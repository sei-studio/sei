---
phase: quick-260525-pbn
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - supabase/migrations/20260528000000_security_definer_guards.sql
  - supabase/migrations/20260528000100_drop_storage_listing.sql
  - supabase/migrations/20260528000200_user_read_views.sql
  - supabase/migrations/20260528000300_reconcile_moderation_and_reports.sql
  - supabase/functions/_shared/timingSafe.ts
  - supabase/functions/lemon-webhook/index.ts
  - supabase/functions/notify-report/index.ts
  - src/main/cloud/proxyClient.ts
autonomous: true
requirements:
  - SEC-CRIT-C1
  - SEC-HIGH-H6
  - SEC-HIGH-H7
  - SEC-HIGH-H8
  - SEC-MED-M1
  - SEC-MED-M2
  - SEC-MED-M3
  - SEC-MED-M8

must_haves:
  truths:
    - "An authenticated user calling reserve_credits(other_user_uuid, …) is rejected with SQLSTATE 42501 (privilege escalation guard fires)."
    - "GET storage.objects?select=* on the skins/portraits buckets returns zero rows for an authenticated caller (listing dropped); direct file fetches via public URL still succeed."
    - "Authenticated SELECT on public.my_grants returns ONLY (id, kind, credits_micro, granted_at, expires_at) for the caller's own rows — no lemon_event_id column reaches the client."
    - "Authenticated SELECT on public.my_subscription returns ONLY (status, tier, current_period_end) for the caller's own row — no lemon_subscription_id column reaches the client."
    - "Re-running 20260528000300 against either schema state (objects present OR missing) succeeds without error — true idempotency for the moderation_and_reports reconciliation."
    - "tg_set_updated_at function has search_path explicitly pinned (pg_catalog, public) — pg_proc.proconfig shows the setting."
    - "notify-report rejects bearer mismatches in constant time using timingSafeEqual (lifted from lemon-webhook into _shared/timingSafe.ts)."
    - "INSERT into deletion_queue with a storage_paths array containing another user's path-prefix is rejected by RLS WITH CHECK."
    - "Authenticated user attempting raw INSERT/UPDATE/DELETE on ledger_grants / ledger_consumption / subscription_status receives RLS denial (defense-in-depth REVOKE in effect even if a future policy is accidentally permissive)."
  artifacts:
    - path: "supabase/migrations/20260528000000_security_definer_guards.sql"
      provides: "RPC privilege-escalation guards + tg_set_updated_at search_path + deletion_queue WITH CHECK tightening + defense-in-depth REVOKE on ledger tables"
      contains: "p_user_id mismatch"
    - path: "supabase/migrations/20260528000100_drop_storage_listing.sql"
      provides: "Drops storage SELECT (listing) policies on skins + portraits buckets"
      contains: "drop policy"
    - path: "supabase/migrations/20260528000200_user_read_views.sql"
      provides: "Column-restricted security_invoker views my_grants + my_subscription; tightens base-table SELECT policies to force users through the views"
      contains: "security_invoker"
    - path: "supabase/migrations/20260528000300_reconcile_moderation_and_reports.sql"
      provides: "Fully idempotent reconciliation of 20260523000000 schema (characters moderation_* columns, reports table, RLS, policies, RPC, triggers)"
      contains: "if not exists"
    - path: "supabase/functions/_shared/timingSafe.ts"
      provides: "Shared timingSafeEqual helper extracted from lemon-webhook"
      exports: ["timingSafeEqual"]
    - path: "supabase/functions/notify-report/index.ts"
      provides: "Bearer comparison now uses timingSafeEqual (line ~135)"
      contains: "timingSafeEqual"
    - path: "supabase/functions/lemon-webhook/index.ts"
      provides: "Imports timingSafeEqual from _shared instead of defining locally"
      contains: "from '../_shared/timingSafe.ts'"
    - path: "src/main/cloud/proxyClient.ts"
      provides: "creditsGet + subscriptionStatus read from my_grants + my_subscription views instead of base tables"
      contains: "my_subscription"
  key_links:
    - from: "supabase/migrations/20260528000200_user_read_views.sql (my_subscription view)"
      to: "src/main/cloud/proxyClient.ts (subscriptionStatus + creditsGet)"
      via: "view rename in SELECT .from(...)"
      pattern: "from\\('my_subscription'"
    - from: "supabase/functions/notify-report/index.ts (auth check)"
      to: "supabase/functions/_shared/timingSafe.ts"
      via: "ESM import"
      pattern: "import .* from '\\.\\./_shared/timingSafe\\.ts'"
    - from: "supabase/migrations/20260528000000 (RPC guard)"
      to: "public.reserve_credits / settle_consumption / check_and_increment_bucket"
      via: "create or replace function with IF p_user_id IS DISTINCT FROM auth.uid()"
      pattern: "p_user_id is distinct from auth\\.uid\\(\\)"
---

<objective>
Close 8 Supabase security audit findings in a single ship: privilege-escalation guards on SECURITY DEFINER RPCs (C1), public storage listing surface (H7), column-restricted user-read views to stop lemon_*_id leakage (H8), idempotent reconciliation of the divergent moderation_and_reports schema (H6), trigger search_path hardening (M1), constant-time bearer comparison in notify-report (M2), deletion_queue cross-user path injection guard (M3), and defense-in-depth REVOKEs on ledger tables (M8).

Purpose: The live Supabase project has known privilege-escalation and data-leakage primitives that any authenticated user (or a stolen JWT) could trigger today. The reconciliation migration (H6) additionally unblocks the moderation pipeline that ships in Phase 12 — the live `schema_migrations` ledger thinks 20260523000000 was applied, but pg_class disagrees, so a normal re-run would fail on `CREATE TABLE public.reports` already existing in some environments and missing in others.

Output: Four migration files (timestamps starting 20260528000000), one new shared helper (`_shared/timingSafe.ts`), two Edge Function patches (lemon-webhook re-import, notify-report bearer fix), and one renderer-side cloud client patch (proxyClient.ts switches to the new views). Six atomic commits.

Out of scope (other clusters own these — DO NOT touch):
- DMCA agent registration
- supabase/config.toml [auth.rate_limit] changes
- privacy.html
- proxy/* WIP (forwardFree.ts, personaDailyGate.ts, fly.toml, sentinel.ts, buckets.ts)
- src/bot/* WIP
- src/main/ipc.ts, src/main/personaExpansion.ts WIP
- src/renderer/* WIP
- src/shared/errorClasses.ts WIP
- supabase/migrations/20260527000000_persona_free_bucket.sql (someone else's WIP)
- .mcp.json, deno.lock, supabase/.temp/ (untracked WIPs owned by other clusters)
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@./CLAUDE.md
@.planning/STATE.md
@supabase/migrations/20260524000000_phase_13_ledger.sql
@supabase/migrations/20260524000100_rate_buckets_rpc.sql
@supabase/migrations/20260525000000_ledger_balance_restrict.sql
@supabase/migrations/20260526000000_phase_13_hardening.sql
@supabase/migrations/20260521000100_storage_buckets.sql
@supabase/migrations/20260521000000_characters_tos.sql
@supabase/migrations/20260521000300_deletion_queue_user_insert.sql
@supabase/migrations/20260523000000_moderation_and_reports.sql
@supabase/functions/notify-report/index.ts
@supabase/functions/lemon-webhook/index.ts
@src/main/cloud/proxyClient.ts

<interfaces>
<!-- Key contracts the executor needs — extracted so no codebase scavenger hunt is required. -->

From supabase/migrations/20260524000000_phase_13_ledger.sql (existing RPC signatures — KEEP IDENTICAL when re-creating):
```sql
public.reserve_credits(p_user_id uuid, p_reservation_micro bigint)
  RETURNS TABLE(id uuid)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public

public.settle_consumption(p_reservation_id uuid, p_actual_micro bigint, p_anthropic_call_id text)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
```

From supabase/migrations/20260524000100_rate_buckets_rpc.sql (existing RPC signature — KEEP IDENTICAL):
```sql
public.check_and_increment_bucket(
  p_user_id uuid, p_bucket_kind text,
  p_increment bigint, p_limit bigint, p_window_seconds int)
  RETURNS TABLE(allowed boolean, retry_after_seconds int)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
```

From supabase/functions/lemon-webhook/index.ts (line 116-123 — implementation to LIFT to _shared/):
```ts
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
```

From supabase/functions/notify-report/index.ts:133-135 (CURRENT non-constant-time auth check — REPLACE):
```ts
const auth = req.headers.get('Authorization');
const expected = `Bearer ${serviceKey}`;
if (auth !== expected) {  // ← non-constant-time; replace with timingSafeEqual
```

From src/main/cloud/proxyClient.ts:247-270 (creditsGet — Promise.all fan-out; update reads):
- `from('ledger_balance')` → KEEP (already restricted by 20260525000000)
- `from('subscription_status')` → CHANGE to `from('my_subscription')` (column-restricted view)
- `from('trial_claims')` → KEEP (no PII to strip — only mc_username)
- `from('ledger_consumption')` → KEEP (proxy service_role still needs this; user-facing reads of grants go via my_grants but creditsGet currently doesn't read ledger_grants directly)

From src/main/cloud/proxyClient.ts:434-438 (subscriptionStatus — CHANGE):
- `from('subscription_status')` → CHANGE to `from('my_subscription')`. Note the SELECT changes: my_subscription exposes (status, tier, current_period_end). The current code selects (status, renews_at, ends_at). The view spec calls for (status, tier, current_period_end) — but `renews_at` and `ends_at` are present on the base table and the renderer uses both. Resolution: the my_subscription view MUST expose status + renews_at + ends_at (NOT lemon_subscription_id, NOT lemon_event_id derived). The CONTEXT description names {status, tier, current_period_end} as an example; for this codebase the equivalent safe column set is {status, renews_at, ends_at}. Justify in the migration comment.

From supabase/migrations/20260521000100_storage_buckets.sql (POLICIES TO DROP — names verbatim):
- "skins_public_read" on storage.objects
- "portraits_public_read" on storage.objects
(Keep the owner_insert/owner_update/owner_delete policies and the public bucket flag — public-bucket direct GET via `/storage/v1/object/public/...` does NOT require a SELECT policy.)

From supabase/migrations/20260521000300_deletion_queue_user_insert.sql (POLICY TO REPLACE — name verbatim):
- "deletion_queue_user_insert" on public.deletion_queue
- Current WITH CHECK: `user_id = auth.uid()` (does NOT validate storage_paths array contents)
- New WITH CHECK per audit:
  `user_id = auth.uid() and (storage_paths is null or (select bool_and(split_part(elem,'/',1)=auth.uid()::text) from jsonb_array_elements_text(storage_paths) as elem))`

From supabase/migrations/20260521000000_characters_tos.sql (TRIGGER FUNCTION TO HARDEN):
```sql
create or replace function public.tg_set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
```
ALTER target: `ALTER FUNCTION public.tg_set_updated_at() SET search_path = pg_catalog, public;`

From supabase/migrations/20260523000000_moderation_and_reports.sql (FULL OBJECT INVENTORY for the reconciliation migration):
- ALTER TABLE public.characters ADD COLUMN: moderation_status text, moderation_checked_at timestamptz, moderation_provider text, moderation_text_provider text, moderation_text_checked_at timestamptz
- CHECK constraint: `characters_moderation_status_chk` on moderation_status IN ('clean','flagged','soft_flagged','clean_pending_retry') or NULL
- INDEX: `characters_unmoderated_idx` partial on (created_at asc) WHERE shared=true AND moderation_status IS NULL
- TABLE public.reports (id uuid pk, reporter_id uuid fk auth.users on delete set null, character_id uuid fk public.characters on delete cascade, reason text check, detail text check len<=500, created_at timestamptz, resolved_at timestamptz, resolution text)
- INDEX: reports_character_recent_idx, reports_reporter_recent_idx
- RLS ENABLE on public.reports
- FUNCTION: tg_reports_auto_hide (SECURITY DEFINER, search_path public)
- TRIGGER: reports_auto_hide_trigger AFTER INSERT
- FUNCTION: tg_notify_report_inserted (SECURITY DEFINER, search_path public,extensions)
- TRIGGER: reports_after_insert_webhook AFTER INSERT
- FUNCTION: search_public_characters(text, int, int) RETURNS setof characters, STABLE, security INVOKER (default)
- EXTENSION: pg_net (with schema extensions)
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Migration — SECURITY DEFINER guards + tg_set_updated_at search_path + deletion_queue WITH CHECK + defense-in-depth REVOKEs (covers C1 + M1 + M3 + M8)</name>
  <files>supabase/migrations/20260528000000_security_definer_guards.sql</files>
  <action>
Create a new migration `supabase/migrations/20260528000000_security_definer_guards.sql` containing four sections in order. Use the Write tool. Start with a top-of-file comment block summarising what this migration does and which audit findings it closes (C1, M1, M3, M8).

Section 1 — RPC privilege-escalation guards (C1):
For each of `public.reserve_credits(uuid, bigint)`, `public.settle_consumption(uuid, bigint, text)`, and `public.check_and_increment_bucket(uuid, text, bigint, bigint, int)`:
- `REVOKE EXECUTE ON FUNCTION ... FROM anon, authenticated;` (DO NOT revoke from service_role — that grant already exists from 20260524000000 / 20260524000100; the public REVOKE in 20260526000000 covered PUBLIC but NOT anon/authenticated explicitly; this REVOKE is defense-in-depth in case the PUBLIC default is granted back by a future migration or supabase-side automation).
- `CREATE OR REPLACE FUNCTION` with IDENTICAL signature, return type, language, security mode, search_path, and body — BUT inject this guard as the FIRST executable statement inside the `begin` block:
  ```sql
  if p_user_id is distinct from auth.uid()
     and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'p_user_id mismatch' using errcode = '42501';
  end if;
  ```
- Reference the existing body verbatim from `20260524000000_phase_13_ledger.sql` (reserve_credits + settle_consumption) and `20260524000100_rate_buckets_rpc.sql` (check_and_increment_bucket). DO NOT alter any logic; just prepend the guard.
- After each CREATE OR REPLACE, re-issue the existing `GRANT EXECUTE ... TO service_role` for the function (it persists across CREATE OR REPLACE on most Postgres versions, but re-issuing is cheap insurance against any version that drops grants).

Section 2 — tg_set_updated_at search_path hardening (M1):
```sql
ALTER FUNCTION public.tg_set_updated_at() SET search_path = pg_catalog, public;
```
This preserves the existing body (defined in 20260521000000_characters_tos.sql) — no CREATE OR REPLACE needed.

Section 3 — deletion_queue WITH CHECK tightening (M3):
```sql
drop policy if exists "deletion_queue_user_insert" on public.deletion_queue;
create policy "deletion_queue_user_insert" on public.deletion_queue
  for insert
  with check (
    user_id = auth.uid()
    and (
      storage_paths is null
      or (
        select bool_and(split_part(elem, '/', 1) = auth.uid()::text)
        from jsonb_array_elements_text(storage_paths) as elem
      )
    )
  );
```
Add a comment line above explaining: the prior policy validated `user_id = auth.uid()` but did NOT validate the `storage_paths` jsonb array — a malicious caller could pass `["<other_user_uuid>/<file>.png"]` and the cron worker would happily delete those files. The path-segment check forces every entry's first segment to equal the caller's uuid.

Section 4 — Defense-in-depth REVOKEs on ledger tables (M8):
```sql
revoke insert, update, delete on public.ledger_grants from authenticated, anon;
revoke insert, update, delete on public.ledger_consumption from authenticated, anon;
revoke insert, update, delete on public.subscription_status from authenticated, anon;
```
Add comment explaining: the existing migrations did NOT create insert/update/delete RLS policies (so RLS already blocks these), but the table-level GRANTs from Postgres defaults could allow service_role-like access if a future migration accidentally added a permissive policy. Belt-and-suspenders.

Do NOT add a COMMIT or any session-level state. Each migration runs in its own transaction by Supabase migration runner.

IMPORTANT: Do NOT run `supabase db push`, `supabase migration up`, or any apply command. This migration is to be committed only — application happens out-of-band per cluster constraints.
  </action>
  <verify>
    <automated>test -f supabase/migrations/20260528000000_security_definer_guards.sql && grep -q "p_user_id is distinct from auth.uid()" supabase/migrations/20260528000000_security_definer_guards.sql && grep -q "tg_set_updated_at" supabase/migrations/20260528000000_security_definer_guards.sql && grep -q "deletion_queue_user_insert" supabase/migrations/20260528000000_security_definer_guards.sql && grep -q "revoke insert, update, delete on public.ledger_grants" supabase/migrations/20260528000000_security_definer_guards.sql</automated>
  </verify>
  <done>
Migration file exists with all four sections. Each RPC has REVOKE + CREATE OR REPLACE WITH GUARD + GRANT to service_role. tg_set_updated_at has SET search_path. deletion_queue policy validates jsonb array. Defense-in-depth REVOKEs on three ledger tables. Top-of-file comment names findings C1, M1, M3, M8.

Commit message: `fix(security): guard SECURITY DEFINER RPCs + harden tg_set_updated_at + tighten deletion_queue WITH CHECK + defense-in-depth REVOKE on ledger tables (260525-pbn task 1, C1+M1+M3+M8)`
  </done>
</task>

<task type="auto">
  <name>Task 2: Migration — Drop public storage SELECT listing policies (covers H7)</name>
  <files>supabase/migrations/20260528000100_drop_storage_listing.sql</files>
  <action>
Create `supabase/migrations/20260528000100_drop_storage_listing.sql` with a top-of-file comment block explaining:
- The skins + portraits buckets are marked `public = true` in 20260521000100_storage_buckets.sql, which means direct GETs to `/storage/v1/object/public/<bucket>/<path>` succeed WITHOUT any SELECT policy — Supabase's public-bucket fast-path bypasses RLS for the public route.
- The `*_public_read` SELECT policies on `storage.objects` ALSO enabled the LIST endpoint (`/storage/v1/object/list/<bucket>?prefix=<uuid>`) for any authenticated caller, which enumerates every file in the bucket. This is the H7 finding — UUIDs were assumed unguessable but enumeration leaks them.
- Dropping the SELECT policies removes the listing surface while keeping direct public-URL GETs working (verified Supabase behavior, see RESEARCH/AUDIT trail).

Then the DDL:
```sql
drop policy if exists "skins_public_read" on storage.objects;
drop policy if exists "portraits_public_read" on storage.objects;
```

Use `if exists` because if this migration is re-run after a manual revoke, the second run must not error.

Do NOT touch the owner_insert / owner_update / owner_delete policies — those gate writes correctly and stay.
Do NOT touch the `public = true` bucket flag — direct public URLs still need it.
  </action>
  <verify>
    <automated>test -f supabase/migrations/20260528000100_drop_storage_listing.sql && grep -q "drop policy if exists \"skins_public_read\"" supabase/migrations/20260528000100_drop_storage_listing.sql && grep -q "drop policy if exists \"portraits_public_read\"" supabase/migrations/20260528000100_drop_storage_listing.sql</automated>
  </verify>
  <done>
Migration drops both SELECT policies. Top-of-file comment explains why public-bucket GETs still work without them. Commit message: `fix(security): drop public-listing SELECT policies on skins+portraits storage buckets (260525-pbn task 2, H7)`
  </done>
</task>

<task type="auto">
  <name>Task 3: Migration — Column-restricted views for ledger PII (covers H8)</name>
  <files>supabase/migrations/20260528000200_user_read_views.sql</files>
  <action>
Create `supabase/migrations/20260528000200_user_read_views.sql`. Top-of-file comment must:
- Cite H8 finding: the existing `ledger_grants_select_own` and `subscription_status_select_own` policies grant SELECT on the entire row, which includes `lemon_event_id` (ledger_grants) and `lemon_subscription_id` (subscription_status) — Lemon Squeezy primary keys that should NOT be exposed to the renderer-side authenticated JWT. They are useful for cross-referencing in the Lemon dashboard and SHOULD remain service_role-only.
- State the design choice: create two `security_invoker=true` views (`public.my_grants`, `public.my_subscription`) exposing only the safe column subset, then DROP the broad SELECT policies on the base tables so the only path for authenticated readers is through the views. `security_invoker=true` ensures the view runs under the caller's role, so the WHERE `user_id = auth.uid()` predicate is enforced by RLS-equivalent logic (no auth.users enumeration risk — the WHERE uses auth.uid() directly).
- Note: proxy reads (service_role) continue to read base tables directly via `getAdminClient()` — service_role bypasses RLS. Dropping the base SELECT policies only affects authenticated/anon readers.

Then DDL in order:

1) Create views:
```sql
create or replace view public.my_grants
  with (security_invoker = true)
  as
  select id, kind, credits_micro, granted_at, expires_at
    from public.ledger_grants
   where user_id = auth.uid();

create or replace view public.my_subscription
  with (security_invoker = true)
  as
  select status, renews_at, ends_at
    from public.subscription_status
   where user_id = auth.uid();
```

IMPORTANT column-set note (also include as inline comment): the CONTEXT cluster description listed `{status, tier, current_period_end}` as the my_subscription example column set. The actual `subscription_status` table in 20260524000000_phase_13_ledger.sql has columns `{user_id, status, lemon_subscription_id, renews_at, ends_at, updated_at}` — there is no `tier` column and no `current_period_end` column. The safe subset that matches what `proxyClient.ts:434-438` consumes is `{status, renews_at, ends_at}`. We expose those three. `lemon_subscription_id` and `updated_at` are excluded (the former is PII per H8; the latter is operational metadata the renderer does not need).

2) Grant SELECT on views to authenticated ONLY (not anon — anon can't get a user-scoped row anyway since auth.uid() is null, but defense-in-depth):
```sql
grant select on public.my_grants to authenticated;
grant select on public.my_subscription to authenticated;
```

3) Drop the broad base-table SELECT policies — force authenticated readers through the views:
```sql
drop policy if exists "ledger_grants_select_own" on public.ledger_grants;
drop policy if exists "subscription_status_select_own" on public.subscription_status;
```

Add a justification comment block above (3) explaining: we chose to drop the broad SELECT policies (option B in the audit) rather than column-restrict them in-place (option A — which would require REVOKEing column-level SELECT then re-GRANTing the subset). Dropping is simpler, harder to get wrong on future column adds (adding a new column to subscription_status would silently leak it back to authenticated under option A), and tooling-friendly (the views are first-class objects that show up in supabase-js typegen). Trade-off: any renderer code that reads `ledger_grants` or `subscription_status` directly by table name will get RLS denial — Task 4 fixes the one consumer (proxyClient.ts).

IMPORTANT: `ledger_balance` view (defined in 20260525000000_ledger_balance_restrict.sql) is NOT touched by this migration — it remains the path for balance reads, and its WR-07 fix already restricts the outer FROM to the caller's row. Authenticated callers continue to SELECT from `ledger_balance` unchanged.
  </action>
  <verify>
    <automated>test -f supabase/migrations/20260528000200_user_read_views.sql && grep -q "security_invoker = true" supabase/migrations/20260528000200_user_read_views.sql && grep -q "create or replace view public.my_grants" supabase/migrations/20260528000200_user_read_views.sql && grep -q "create or replace view public.my_subscription" supabase/migrations/20260528000200_user_read_views.sql && grep -q "drop policy if exists \"subscription_status_select_own\"" supabase/migrations/20260528000200_user_read_views.sql && ! grep -q "lemon_subscription_id" supabase/migrations/20260528000200_user_read_views.sql && ! grep -q "lemon_event_id" supabase/migrations/20260528000200_user_read_views.sql</automated>
  </verify>
  <done>
Migration creates my_grants + my_subscription views with security_invoker, grants SELECT to authenticated only, drops the two broad base-table SELECT policies. Neither lemon_event_id nor lemon_subscription_id appears in the view definitions. Comment block documents the design choice.

Commit message: `fix(security): introduce my_grants + my_subscription column-restricted views to stop lemon_*_id leakage (260525-pbn task 3, H8)`
  </done>
</task>

<task type="auto">
  <name>Task 4: Code — Switch proxyClient.ts reads to my_grants + my_subscription views (covers H8 client-side)</name>
  <files>src/main/cloud/proxyClient.ts</files>
  <action>
Modify `src/main/cloud/proxyClient.ts` with two surgical edits. Use Edit tool with exact-string matching:

Edit 1 — `creditsGet` (around line 254-257):
Replace the `subscription_status` read in the Promise.all fan-out:
```ts
    supabase
      .from('subscription_status')
      .select('status,renews_at,ends_at')
      .eq('user_id', session.userId)
      .maybeSingle(),
```
with:
```ts
    // 260525-pbn task 4 (H8): read via my_subscription view (security_invoker)
    // — the base-table SELECT policy was dropped in 20260528000200 so that
    // lemon_subscription_id can no longer reach the renderer-side JWT.
    supabase
      .from('my_subscription')
      .select('status,renews_at,ends_at')
      .maybeSingle(),
```
Note: the view definition already filters by `auth.uid()`, so the `.eq('user_id', session.userId)` clause is dropped (the view returns at most one row for the caller — exactly what `.maybeSingle()` expects).

Edit 2 — `subscriptionStatus` (around line 434-438):
Replace:
```ts
  const { data } = await supabase
    .from('subscription_status')
    .select('status,renews_at,ends_at')
    .eq('user_id', session.userId)
    .maybeSingle();
```
with:
```ts
  // 260525-pbn task 4 (H8): see creditsGet — same view substitution.
  const { data } = await supabase
    .from('my_subscription')
    .select('status,renews_at,ends_at')
    .maybeSingle();
```

DO NOT touch:
- `from('ledger_balance')` — already restricted by 20260525000000; remains the balance source.
- `from('trial_claims')` — no PII (only mc_username); the existing select-own policy stays.
- `from('ledger_consumption')` — proxy service_role reads happen here for tokens/min math; the existing select-own policy stays for authenticated reads (no PII columns on this table — micro, deducted_at, reservation_state, anthropic_call_id; anthropic_call_id is an internal opaque id, not PII).

DO NOT widen the diff with comment reformatting or unrelated edits — the renderer code is shared with other in-flight clusters and a noisy diff risks merge conflicts.

After the edits, verify by re-reading the two changed regions and confirming the strings match. Do NOT run `npm test` or `tsc` here — TypeScript will not see the new view tables until typegen is regenerated, which happens out-of-band when the migration is applied. The two `.from('my_subscription')` calls will be `from<any>` at the supabase-js layer and will type-check fine (supabase-js falls back to any for unknown tables/views unless the Database type is regenerated). If strict typegen is enabled in this repo, add `// @ts-expect-error my_subscription view added 20260528000200 — typegen pending` immediately above each new `.from('my_subscription')` line — check `src/types/supabase.ts` (or equivalent) for whether the Database generic is constrained; if it is constrained, add the ts-expect-error comments. If not constrained, omit them.
  </action>
  <verify>
    <automated>grep -c "from('my_subscription')" src/main/cloud/proxyClient.ts | grep -q "^2$" && ! grep -E "from\('subscription_status'\)" src/main/cloud/proxyClient.ts</automated>
  </verify>
  <done>
proxyClient.ts has exactly two `from('my_subscription')` calls and zero `from('subscription_status')` calls. Other reads (ledger_balance, trial_claims, ledger_consumption) untouched.

Commit message: `fix(cloud): read subscription via my_subscription view (260525-pbn task 4, H8 client-side)`
  </done>
</task>

<task type="auto">
  <name>Task 5: Migration — Idempotent reconciliation of moderation_and_reports (covers H6)</name>
  <files>supabase/migrations/20260528000300_reconcile_moderation_and_reports.sql</files>
  <action>
Create `supabase/migrations/20260528000300_reconcile_moderation_and_reports.sql`. The goal: re-issue every DDL statement from `20260523000000_moderation_and_reports.sql` in a form that is safe to run regardless of whether those objects currently exist.

Top-of-file comment block (MANDATORY — operators will read this):
- Cite H6: the live project's `schema_migrations` ledger contains a row for `20260523000000` but `pg_class` shows the `reports` table is missing AND the `characters.moderation_*` columns are missing. This means a normal `supabase db push` would NOT re-apply the migration (the ledger says "done"), but the schema is actually drifted. Some local dev environments may be in the opposite state (objects present, ledger matches). This migration safely reconciles either state.
- Explicitly note: this migration does NOT delete or rewrite `schema_migrations` rows. Operators who want to manually mark `20260523000000` as un-applied to force a re-run should do so via the Supabase CLI's `supabase migration repair`, but the normal path is: apply this reconciliation migration via the next `supabase db push` and the schema converges.

DDL — every statement uses idempotent forms:

Section 1 — pg_net extension (already in 20260523000000 section 4):
```sql
create extension if not exists pg_net with schema extensions;
```

Section 2 — characters moderation_* columns:
```sql
alter table public.characters
  add column if not exists moderation_status text,
  add column if not exists moderation_checked_at timestamptz,
  add column if not exists moderation_provider text,
  add column if not exists moderation_text_provider text,
  add column if not exists moderation_text_checked_at timestamptz;
```

Section 3 — characters CHECK constraint (Postgres has no `add constraint if not exists`; use a DO block guarded by pg_constraint catalog lookup):
```sql
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'characters_moderation_status_chk'
       and conrelid = 'public.characters'::regclass
  ) then
    alter table public.characters
      add constraint characters_moderation_status_chk
      check (moderation_status is null or moderation_status in ('clean','flagged','soft_flagged','clean_pending_retry'));
  end if;
end $$;
```

Section 4 — partial index:
```sql
create index if not exists characters_unmoderated_idx
  on public.characters (created_at asc)
  where shared = true and moderation_status is null;
```

Section 5 — reports table:
```sql
create table if not exists public.reports (
  id              uuid primary key default gen_random_uuid(),
  reporter_id     uuid not null references auth.users(id) on delete set null,
  character_id    uuid not null references public.characters(id) on delete cascade,
  reason          text not null check (reason in (
                    'sexual_content_minors',
                    'hate_speech_harassment',
                    'copyright_infringement',
                    'other'
                  )),
  detail          text check (char_length(detail) <= 500),
  created_at      timestamptz not null default now(),
  resolved_at     timestamptz,
  resolution      text
);
```

Section 6 — reports indexes:
```sql
create index if not exists reports_character_recent_idx on public.reports (character_id, created_at desc);
create index if not exists reports_reporter_recent_idx  on public.reports (reporter_id, created_at desc);
```

Section 7 — RLS enable (idempotent — ENABLE on already-enabled table is a no-op):
```sql
alter table public.reports enable row level security;
```

Section 8 — Functions (CREATE OR REPLACE is inherently idempotent). Re-issue BOTH tg_reports_auto_hide and tg_notify_report_inserted bodies VERBATIM from the source migration. Re-issue the search_public_characters function VERBATIM.

Section 9 — Triggers (DROP IF EXISTS + CREATE — Postgres has no `create trigger if not exists`):
```sql
drop trigger if exists reports_auto_hide_trigger on public.reports;
create trigger reports_auto_hide_trigger
  after insert on public.reports
  for each row execute function public.tg_reports_auto_hide();

drop trigger if exists reports_after_insert_webhook on public.reports;
create trigger reports_after_insert_webhook
  after insert on public.reports
  for each row execute function public.tg_notify_report_inserted();
```

Section 10 — search_public_characters GRANT (re-issue — grants persist across CREATE OR REPLACE FUNCTION but cheap to re-issue):
```sql
grant execute on function public.search_public_characters(text, int, int) to anon, authenticated;
```

The source migration creates NO RLS policies on public.reports (per Pitfall 4 comment — no insert/select/update/delete policies; all access via service_role from submit-report Edge Function). This migration MUST NOT add any either. If a future cluster adds policies, those will be in a separate migration.

Hand-verify the function bodies match `20260523000000_moderation_and_reports.sql` byte-for-byte by reading both files side-by-side before committing. If they diverge (e.g., a follow-up migration changed the function), use the LATEST version — never silently drop a fix.
  </action>
  <verify>
    <automated>test -f supabase/migrations/20260528000300_reconcile_moderation_and_reports.sql && grep -q "add column if not exists moderation_status" supabase/migrations/20260528000300_reconcile_moderation_and_reports.sql && grep -q "create table if not exists public.reports" supabase/migrations/20260528000300_reconcile_moderation_and_reports.sql && grep -q "create or replace function public.tg_reports_auto_hide" supabase/migrations/20260528000300_reconcile_moderation_and_reports.sql && grep -q "create or replace function public.tg_notify_report_inserted" supabase/migrations/20260528000300_reconcile_moderation_and_reports.sql && grep -q "create or replace function public.search_public_characters" supabase/migrations/20260528000300_reconcile_moderation_and_reports.sql && grep -q "drop trigger if exists reports_auto_hide_trigger" supabase/migrations/20260528000300_reconcile_moderation_and_reports.sql && grep -q "drop trigger if exists reports_after_insert_webhook" supabase/migrations/20260528000300_reconcile_moderation_and_reports.sql && grep -q "characters_moderation_status_chk" supabase/migrations/20260528000300_reconcile_moderation_and_reports.sql</automated>
  </verify>
  <done>
Migration is fully idempotent — every DDL uses `if not exists`, `or replace`, `do $$ … end $$` guards, or `drop if exists` + recreate. All objects from 20260523000000 are covered. No RLS policies added to public.reports. Top-of-file comment explains the schema-vs-ledger drift and reconciliation strategy.

Commit message: `fix(supabase): idempotent reconciliation migration for moderation_and_reports schema drift (260525-pbn task 5, H6)`
  </done>
</task>

<task type="auto">
  <name>Task 6: Code — Extract _shared/timingSafe.ts and patch notify-report bearer check (covers M2)</name>
  <files>supabase/functions/_shared/timingSafe.ts, supabase/functions/lemon-webhook/index.ts, supabase/functions/notify-report/index.ts</files>
  <action>
Three coordinated file edits to extract the timing-safe equality helper and apply it to notify-report's bearer check.

Step A — Create `supabase/functions/_shared/timingSafe.ts` using Write tool:
```ts
/**
 * Constant-time string comparison helper. Returns false fast on length
 * mismatch (length is not secret), then compares character-by-character
 * with a bitwise OR accumulator so the loop runs in time proportional
 * only to length, not to the position of the first mismatching byte.
 *
 * Use this for ANY secret-bearing comparison (HMAC digest equality,
 * bearer token equality, webhook signature equality). The plain `===`
 * operator short-circuits on first differing byte, which leaks the
 * length of the common prefix to a remote timing attacker.
 *
 * Extracted from supabase/functions/lemon-webhook/index.ts (260525-pbn
 * task 6, M2) so notify-report can reuse it without duplicating the
 * implementation. Lemon-webhook continues to re-export from its own
 * module for backward-compat with its test file.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
```

Step B — Edit `supabase/functions/lemon-webhook/index.ts` to import from the new shared module and remove the local definition. Use Edit tool with exact-string matching:

B1 — Add the import. Find the existing imports block at the top:
```ts
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { corsHeaders } from '../_shared/cors.ts';
```
Replace with:
```ts
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { corsHeaders } from '../_shared/cors.ts';
import { timingSafeEqual } from '../_shared/timingSafe.ts';
```

B2 — Replace the local function definition (lines ~108-123 — the JSDoc + function block) with a re-export so the lemon-webhook test file's `import { timingSafeEqual } from './index.ts'` continues to work. Find:
```ts
/**
 * Constant-time string comparison. Returns false fast on length mismatch
 * (length is not secret), but compares character-by-character with a
 * bitwise OR accumulator so the loop runs in time proportional only to
 * length, not to the position of the first mismatching byte.
 *
 * Exported for test coverage of the boundary cases.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
```
Replace with:
```ts
// timingSafeEqual implementation moved to ../_shared/timingSafe.ts
// (260525-pbn task 6, M2). Re-exported for the test file which imports
// it from './index.ts'.
export { timingSafeEqual } from '../_shared/timingSafe.ts';
```

Verify after edit that `verifySignature` (around line 129-136) still calls `timingSafeEqual(signature, expected)` — it doesn't need editing because the name is unchanged.

Step C — Edit `supabase/functions/notify-report/index.ts`:

C1 — Add the import to the imports block at the top. Find:
```ts
import { createClient } from '@supabase/supabase-js';
import { corsHeaders } from '../_shared/cors.ts';
```
Replace with:
```ts
import { createClient } from '@supabase/supabase-js';
import { corsHeaders } from '../_shared/cors.ts';
import { timingSafeEqual } from '../_shared/timingSafe.ts';
```

C2 — Replace the non-constant-time bearer check at lines 133-140. Find:
```ts
  const auth = req.headers.get('Authorization');
  const expected = `Bearer ${serviceKey}`;
  if (auth !== expected) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
```
Replace with:
```ts
  // 260525-pbn task 6 (M2): constant-time bearer comparison via
  // timingSafeEqual prevents a remote timing oracle from probing the
  // service-role key one byte at a time. `auth ?? ''` keeps the
  // comparison length-independent of whether the header was set at all.
  const auth = req.headers.get('Authorization') ?? '';
  const expected = `Bearer ${serviceKey}`;
  if (!timingSafeEqual(auth, expected)) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
```

Do NOT modify any other notify-report logic (the body parsing, enrich query, fan-out steps all stay).

Run `deno check` if available to confirm the imports resolve. If deno is not installed locally, skip — Supabase's deploy step will catch import errors. Do NOT deploy the Edge Functions; commit only.
  </action>
  <verify>
    <automated>test -f supabase/functions/_shared/timingSafe.ts && grep -q "export function timingSafeEqual" supabase/functions/_shared/timingSafe.ts && grep -q "from '../_shared/timingSafe.ts'" supabase/functions/lemon-webhook/index.ts && grep -q "from '../_shared/timingSafe.ts'" supabase/functions/notify-report/index.ts && grep -q "timingSafeEqual(auth, expected)" supabase/functions/notify-report/index.ts && ! grep -E "if \(auth !== expected\)" supabase/functions/notify-report/index.ts</automated>
  </verify>
  <done>
_shared/timingSafe.ts exists with the lifted implementation. lemon-webhook imports + re-exports timingSafeEqual from the shared module (test file's import path unchanged). notify-report imports timingSafeEqual and uses it for the bearer comparison; the old `if (auth !== expected)` is gone. No other notify-report logic touched.

Commit message: `fix(security): extract _shared/timingSafe and apply to notify-report bearer check (260525-pbn task 6, M2)`
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| renderer JWT → Supabase REST/RPC | authenticated user can call ANY SECURITY DEFINER RPC and pass arbitrary args (C1) and SELECT from any table the SELECT policy permits (H8) |
| client → storage.objects LIST endpoint | authenticated user can enumerate bucket contents if SELECT policy on storage.objects is permissive (H7) |
| Supabase Database Webhook → notify-report Edge Function | unauthenticated outside Supabase's network; bearer token is the sole authN (M2 — timing oracle on bearer compare) |
| Authenticated user → public.deletion_queue INSERT | jsonb array contents are not validated by the existing WITH CHECK; cross-user storage path injection (M3) |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-260525-pbn-01 | E (Elevation of Privilege) | public.reserve_credits / settle_consumption / check_and_increment_bucket RPC | mitigate | Task 1 — REVOKE EXECUTE from anon/authenticated + inject `IF p_user_id IS DISTINCT FROM auth.uid() AND auth.role() <> 'service_role' THEN RAISE 42501` guard as first statement in each RPC body |
| T-260525-pbn-02 | I (Information Disclosure) | storage.objects LIST endpoint via skins_public_read / portraits_public_read SELECT policies | mitigate | Task 2 — drop both SELECT policies; public-bucket direct GETs unaffected |
| T-260525-pbn-03 | I (Information Disclosure) | public.ledger_grants.lemon_event_id + public.subscription_status.lemon_subscription_id readable by authenticated JWT | mitigate | Task 3 — replace base-table SELECT with security_invoker views (my_grants, my_subscription) that omit the lemon_*_id columns; Task 4 wires the client to read via the views |
| T-260525-pbn-04 | T (Tampering) — deployment drift | public.reports + characters.moderation_* schema-vs-ledger drift blocks Phase 12 moderation pipeline rollout | mitigate | Task 5 — fully idempotent reconciliation migration safe to apply over either schema state |
| T-260525-pbn-05 | T (Tampering) — search_path hijack | public.tg_set_updated_at trigger function runs without explicit search_path | mitigate | Task 1 §2 — `ALTER FUNCTION public.tg_set_updated_at() SET search_path = pg_catalog, public` |
| T-260525-pbn-06 | I (Information Disclosure) — timing side channel | notify-report bearer comparison via `!==` leaks common-prefix length of SUPABASE_SERVICE_ROLE_KEY | mitigate | Task 6 — replace with timingSafeEqual lifted into _shared/ |
| T-260525-pbn-07 | T (Tampering) — cross-user storage delete | public.deletion_queue INSERT with attacker-controlled storage_paths array bypasses path-ownership check at INSERT time (cron job's secondary filter is the only line of defense) | mitigate | Task 1 §3 — replace WITH CHECK to validate every jsonb_array_elements_text(storage_paths) first-segment matches auth.uid()::text |
| T-260525-pbn-08 | E (Elevation of Privilege) — defense-in-depth | future migration accidentally adds permissive INSERT/UPDATE/DELETE RLS policy on ledger_grants / ledger_consumption / subscription_status without remembering tables also need table-level REVOKE | mitigate | Task 1 §4 — REVOKE INSERT, UPDATE, DELETE on three ledger tables FROM authenticated, anon; service_role unaffected |

All eight findings have disposition = mitigate (no accept / no transfer — these are auditor-flagged critical/high/medium issues).
</threat_model>

<verification>
After all six commits land, the operator (out-of-band, NOT during plan execution) will:
1. Run `supabase db diff` against a staging DB to confirm the four migrations apply cleanly in sequence.
2. Apply via `supabase db push` to staging.
3. Run `supabase db lint` — the H7/H8/M1 advisor warnings should be gone; new advisors (if any) get triaged.
4. Smoke-test from a renderer build pointed at staging:
   - creditsGet() returns balance + plan correctly (validates my_subscription wiring)
   - subscriptionStatus() returns the same shape it did before (validates my_subscription column subset matches)
   - Direct GET on a known portrait URL (`/storage/v1/object/public/portraits/<uuid>/<file>.png`) still returns the PNG (validates H7 didn't break public reads)
   - LIST endpoint (`/storage/v1/object/list/portraits?prefix=<uuid>/`) returns empty (validates H7 took effect)
   - submit-report → notify-report end-to-end still succeeds (validates M2 bearer compare migration is byte-equivalent)
5. Manual RPC probe via psql as `authenticated`: `select * from public.reserve_credits('00000000-0000-0000-0000-000000000001', 100);` must raise SQLSTATE 42501 (validates C1).
6. Manual probe via psql as `authenticated`: `insert into public.deletion_queue(user_id, storage_paths) values (auth.uid(), '["other-uuid/file.png"]'::jsonb);` must violate the WITH CHECK (validates M3).
7. Re-run 20260528000300 against a freshly-converged DB — must succeed with zero changes (validates H6 idempotency).

This verification happens out-of-band per cluster constraints (no live DB writes during plan execution).
</verification>

<success_criteria>
- [ ] All four migration files exist with timestamps 20260528000000–20260528000300 and follow the section ordering specified.
- [ ] supabase/functions/_shared/timingSafe.ts exists and exports timingSafeEqual.
- [ ] supabase/functions/lemon-webhook/index.ts imports timingSafeEqual from _shared and re-exports it for its test file.
- [ ] supabase/functions/notify-report/index.ts uses timingSafeEqual for the bearer check (line ~135).
- [ ] src/main/cloud/proxyClient.ts has exactly two `from('my_subscription')` calls (creditsGet + subscriptionStatus) and zero `from('subscription_status')` calls.
- [ ] Six atomic commits land, each prefixed `fix(security)`, `fix(supabase)`, or `fix(cloud)` with the cluster ID `260525-pbn` and the finding ID(s) in the message.
- [ ] No files outside the `files_modified` list are modified. (Hard check against the WIP-protected paths in the constraints block.)
- [ ] No `supabase db push`, `supabase migration up`, `supabase functions deploy`, or any apply/deploy command is executed during plan execution.
- [ ] The threat register's eight T-260525-pbn-* threats each map to a concrete mitigation in one of the six tasks.
</success_criteria>

<output>
After completion, create `.planning/quick/260525-pbn-supabase-critical-security-rpc-privilege/260525-pbn-SUMMARY.md` capturing:
- Six commit SHAs in order
- Which audit finding each commit closed (C1, H6, H7, H8, M1, M2, M3, M8)
- The exact column set my_subscription exposes ({status, renews_at, ends_at}) and the rationale for diverging from the cluster description's example {status, tier, current_period_end}
- Whether ts-expect-error comments were needed in proxyClient.ts (depends on whether the Database generic is constrained in this repo)
- Manual verification commands the operator will run out-of-band against staging
- Any deviations from the plan and why
</output>
