---
phase: 10
plan: 08
type: execute
wave: 5
depends_on: [10-03, 10-06, 10-07]
files_modified:
  - supabase/config.toml
  - supabase/migrations/20260520000000_deletion_queue.sql
  - supabase/functions/delete-me/index.ts
  - supabase/functions/_shared/cors.ts
  - src/main/auth/authHandlers.ts
  - src/main/auth/edgeFunctionClient.ts
  - src/renderer/src/components/DeleteAccountModal.tsx
  - src/renderer/src/components/DeleteAccountModal.module.css
autonomous: false
requirements: [AUTH-06]
requirements_addressed: [AUTH-06]
tags: [edge-function, delete, gdpr, supabase, modal]
user_setup:
  - service: supabase
    why: "Deploy the project's FIRST Edge Function and run a database migration."
    env_vars: []
    dashboard_config:
      - task: "Install Supabase CLI locally: `brew install supabase/tap/supabase` OR `npm i -g supabase`."
        location: "Terminal — one-time, machine-global."
      - task: "From repo root, run `supabase login` (browser auth) then `supabase link --project-ref <your-project-ref>` to associate the local supabase/ folder with your hosted project."
        location: "Terminal at repo root."
      - task: "Apply migration: `supabase db push` (uploads supabase/migrations/20260520000000_deletion_queue.sql)."
        location: "Terminal at repo root."
      - task: "Deploy Edge Function: `supabase functions deploy delete-me --no-verify-jwt=false` (the function verifies JWT internally; --no-verify-jwt=false leaves Supabase's gateway JWT check on)."
        location: "Terminal at repo root."
      - task: "Verify pg_cron is enabled in your project (free tier supports it as of 2026-05): Dashboard → Database → Extensions → search 'pg_cron' → enable if not already on."
        location: "Supabase Dashboard → Database → Extensions."
must_haves:
  truths:
    - "supabase/functions/delete-me/index.ts is the project's first Edge Function and establishes the convention for Phase 11/12 admin operations (CONTEXT D-13)"
    - "Edge Function verifies caller JWT, inserts a deletion_queue row, then calls auth.admin.deleteUser(sub); returns 204 on success (AUTH-06)"
    - "service_role key NEVER appears in the desktop client; only in Edge Function env (Supabase Dashboard → Edge Functions → Secrets) — grep gate enforces"
    - "deletion_queue table has user_id (UUID, NO foreign key to auth.users so it survives user deletion), deletion_requested_at, storage_paths jsonb, purged_at (RESEARCH §Pitfall A7 schema)"
    - "pg_cron daily job at 03:00 UTC marks rows older than 30 days as purged (Phase 10 has empty storage_paths; Phase 11+ extends the cron job body to delete Storage objects)"
    - "DeleteAccountModal renders the type-email-to-confirm UI per UI-SPEC §Delete-account modal: 3 body paragraphs, type field, 'Keep my account' dismissal, 'Delete account' destructive button (red bg, white text) (CONTEXT D-12)"
    - "Modal body explicitly states (a) 30-day deletion window, (b) what gets deleted (cloud characters + Storage objects + credit ledger), (c) what stays (local characters + local memory + cached cloud definitions) per CONTEXT D-12"
    - "Destructive button is disabled until the typed string equals account email (case-insensitive trim) per CONTEXT D-12; enabled state then runs sei.deleteAccount and shows 'Deleting…' label; modal cannot be dismissed (ESC suppressed) while in flight"
    - "On {ok:true}, the modal swaps to a 1-line 'Account scheduled for deletion. Signing you out…' state for 1.2s, then closes; the SIGNED_OUT event drops app to local mode"
  artifacts:
    - path: "supabase/config.toml"
      provides: "Supabase CLI project config — establishes the supabase/ folder convention; specifies edge_runtime + functions config"
      contains: "project_id"
    - path: "supabase/migrations/20260520000000_deletion_queue.sql"
      provides: "deletion_queue table + pg_cron daily worker (RESEARCH §Edge Function SQL block)"
      contains: "deletion_queue"
    - path: "supabase/functions/delete-me/index.ts"
      provides: "Edge Function: verify JWT → insert queue row → auth.admin.deleteUser → 204"
      contains: "auth.admin.deleteUser"
    - path: "supabase/functions/_shared/cors.ts"
      provides: "Shared corsHeaders constant for Phase 10 + reuse in Phase 11/12 Edge Functions"
      exports: ["corsHeaders"]
    - path: "src/main/auth/edgeFunctionClient.ts"
      provides: "callEdgeFunction(name, opts) — typed wrapper over fetch with Bearer JWT injection + 15s timeout"
      exports: ["callEdgeFunction"]
    - path: "src/main/auth/authHandlers.ts"
      provides: "deleteAccount body (replaces plan 03 shell): calls callEdgeFunction('delete-me'), maps to DeleteAccountResult"
      contains: "callEdgeFunction"
    - path: "src/renderer/src/components/DeleteAccountModal.tsx"
      provides: "Type-email-to-confirm modal with success transition state"
      exports: ["DeleteAccountModal"]
  key_links:
    - from: "supabase/functions/delete-me/index.ts"
      to: "deletion_queue table"
      via: "INSERT INTO deletion_queue"
      pattern: "deletion_queue"
    - from: "supabase/functions/delete-me/index.ts"
      to: "auth.admin.deleteUser"
      via: "adminClient.auth.admin.deleteUser(userId)"
      pattern: "auth\\.admin\\.deleteUser"
    - from: "src/main/auth/authHandlers.ts"
      to: "src/main/auth/edgeFunctionClient.ts"
      via: "callEdgeFunction('delete-me', {jwt})"
      pattern: "callEdgeFunction"
    - from: "src/renderer/src/components/DeleteAccountModal.tsx"
      to: "window.sei.deleteAccount"
      via: "sei.deleteAccount() called when confirm clicked"
      pattern: "sei\\.deleteAccount"
---

<objective>
Ship the GDPR account-deletion flow (AUTH-06):

1. Establish the `supabase/` folder convention with `config.toml`, the deletion_queue migration, and the project's first Edge Function (CONTEXT D-13 calls this out explicitly — Phase 11/12 reuse this scaffolding).
2. The Edge Function `delete-me` implements RESEARCH §Edge Function example verbatim: verify JWT → insert queue row → auth.admin.deleteUser → 204. Compensating delete on failure path.
3. Build `src/main/auth/edgeFunctionClient.ts` — typed fetch wrapper that injects Bearer JWT and times out at 15s. Used by `deleteAccount` here; future plans reuse.
4. Replace the plan 03 `deleteAccount` shell in `src/main/auth/authHandlers.ts`.
5. Replace the plan 07 `DeleteAccountModal` stub with the real type-email-to-confirm UI.

Purpose: AUTH-06 ships; the 30-day Storage purge convention is established (Phase 11/12 add Storage delete steps to the cron job body).

Output: 4 supabase/ files + Edge Function + edge client + handler body + real modal.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/REQUIREMENTS.md
@.planning/phases/10-auth-foundation/10-CONTEXT.md
@.planning/phases/10-auth-foundation/10-RESEARCH.md
@.planning/phases/10-auth-foundation/10-UI-SPEC.md
@CLAUDE.md
@src/main/auth/authHandlers.ts
@src/main/auth/authState.ts
@src/main/auth/supabaseClient.ts
@src/renderer/src/components/DeleteConfirmModal.tsx
@src/renderer/src/components/DeleteConfirmModal.module.css
@src/renderer/src/components/DeleteAccountModal.tsx
@.planning/phases/10-auth-foundation/10-03-SUMMARY.md
@.planning/phases/10-auth-foundation/10-06-SUMMARY.md
@.planning/phases/10-auth-foundation/10-07-SUMMARY.md

<interfaces>
<!-- Edge Function endpoint URL: https://<project-ref>.supabase.co/functions/v1/delete-me -->
<!-- The desktop client calls this with: Authorization: Bearer <JWT>. -->

<!-- DeleteAccountResult shape (from plan 03): -->
type DeleteAccountResult =
  | { ok: true }
  | { ok: false; code: 'network' | 'edge_function_error'; message: string };

<!-- DeleteAccountModalProps (from plan 07 stub): -->
interface DeleteAccountModalProps {
  accountEmail: string;
  onCancel: () => void;
  onConfirmed: () => void;
}
</interfaces>
</context>

<read_first>
- `src/main/auth/authHandlers.ts` (plan 03 deleteAccount shell)
- `src/main/auth/supabaseClient.ts` (getClient — needed for the JWT pull in deleteAccount and the project URL)
- `src/main/env.ts` (getSupabaseUrl — Edge Function URL derived from this)
- `src/renderer/src/components/DeleteConfirmModal.tsx` + .module.css (template for the type-email-to-confirm shape)
- `src/renderer/src/components/DeleteAccountModal.tsx` (plan 07 stub — REPLACE the body)
- `src/renderer/src/components/TextField.tsx` (for the type-to-confirm input)
- `.planning/phases/10-auth-foundation/10-RESEARCH.md` §Edge Function code (FULL Deno template) + §Migration SQL block (FULL SQL) + §Pitfall A5 (CORS) + §Pitfall A7 (queue + purge ordering)
- `.planning/phases/10-auth-foundation/10-UI-SPEC.md` §Delete-account modal (D-12) + §Layout rule 5 (click-outside DOES NOT close DeleteAccountModal)
- `.planning/phases/10-auth-foundation/10-CONTEXT.md` D-12, D-13
</read_first>

<tasks>

<task type="auto" tdd="false">
  <name>Task 1: Establish supabase/ folder + deletion_queue migration + Edge Function delete-me</name>
  <files>supabase/config.toml, supabase/migrations/20260520000000_deletion_queue.sql, supabase/functions/_shared/cors.ts, supabase/functions/delete-me/index.ts, supabase/functions/delete-me/deno.json</files>
  <read_first>
    - .planning/phases/10-auth-foundation/10-RESEARCH.md §Edge Function code block (lines 633–700 — full Deno template; COPY verbatim) + Migration SQL block (lines 700–730)
    - .planning/phases/10-auth-foundation/10-CONTEXT.md D-13
  </read_first>
  <behavior>
    - supabase/config.toml is created with a minimal valid config (project_id = '<placeholder>'; the human sets the real value via `supabase link`). edge_runtime block enables verifyjwt.
    - supabase/migrations/20260520000000_deletion_queue.sql contains the RESEARCH §SQL block verbatim: deletion_queue table + index + pg_cron job.
    - supabase/functions/_shared/cors.ts exports `corsHeaders` constant (Phase 10's first Edge Function; Phase 11/12 reuse).
    - supabase/functions/delete-me/index.ts implements RESEARCH §Edge Function example verbatim: OPTIONS handler → corsHeaders; method !== POST → 405; missing Bearer → 401; getUser via userClient (JWT-scoped) → 401 on invalid; INSERT into deletion_queue with empty storage_paths [] (Phase 10 has nothing to purge) → 500 if insert fails; auth.admin.deleteUser(userId) via adminClient (service_role) → on failure, COMPENSATING DELETE of the queue row + 500; return 204 on success.
    - supabase/functions/delete-me/deno.json declares the @supabase/supabase-js import map (HTTPS esm.sh URL pinned to 2.106.0).
    - Files lint-clean per Deno's basic checker (the human will run `deno check` via `supabase functions deploy`); no TypeScript compile gate on Sei's tsc.
  </behavior>
  <action>
1. Create `supabase/config.toml`:

```toml
# Supabase project config — established by Phase 10 (Auth Foundation).
# Run `supabase link --project-ref <your-project-ref>` to associate this
# folder with your hosted project; the link writes the actual project_id
# into the local .branches/ state, NOT here.
#
# Source: 10-CONTEXT D-13 (Phase 10 is the first Edge Function; sets
# supabase/ conventions for Phase 11/12).

project_id = "REPLACE_VIA_SUPABASE_LINK"

[functions.delete-me]
verify_jwt = true   # Supabase gateway verifies JWT before forwarding to Deno;
                    # the function ALSO re-verifies via getUser() for the user
                    # context required by RLS (defense-in-depth).
```

2. Create `supabase/migrations/20260520000000_deletion_queue.sql` — verbatim from RESEARCH §SQL block:

```sql
-- Phase 10 (Auth Foundation) — deletion_queue table + pg_cron daily worker.
--
-- 30-day Storage purge contract (RESEARCH §Pitfall A7):
--   1. delete-me Edge Function inserts a row here BEFORE calling
--      auth.admin.deleteUser(sub) so the queue row outlives the auth user.
--   2. user_id is a plain UUID (NO foreign key to auth.users) so referential
--      integrity does not break when the user is deleted in step 1's next call.
--   3. pg_cron daily job at 03:00 UTC marks rows older than 30 days as
--      purged_at = now(). Phase 10 has empty storage_paths; Phase 11+ will
--      extend the cron body to iterate storage_paths and call storage.objects
--      delete (or invoke a paired Edge Function with service_role).
--
-- Source: 10-RESEARCH §Edge Function SQL block + §Pitfall A7 mitigation.

create extension if not exists pg_cron;

create table public.deletion_queue (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,                       -- NO FK to auth.users; survives user deletion
  deletion_requested_at timestamptz not null default now(),
  storage_paths jsonb not null default '[]'::jsonb,
  purged_at timestamptz                        -- null = pending; non-null = done
);
create index on public.deletion_queue (deletion_requested_at) where purged_at is null;

-- RLS: deny all by default. Only service_role (via Edge Functions) writes/reads.
alter table public.deletion_queue enable row level security;
-- (No policies — RLS default-deny is the policy.)

-- Daily worker at 03:00 UTC. Phase 10 just marks rows purged; Phase 11/12
-- extend the body to actually delete Storage objects for each storage_paths
-- entry (via storage.objects DELETE WHERE name = ANY(...) or via a paired
-- cron Edge Function with service_role).
select cron.schedule(
  'purge-deletion-queue',
  '0 3 * * *',
  $$
    update public.deletion_queue
    set purged_at = now()
    where deletion_requested_at < now() - interval '30 days'
      and purged_at is null
  $$
);
```

3. Create `supabase/functions/_shared/cors.ts`:

```typescript
// Shared CORS headers for all Sei Edge Functions.
// Source: https://supabase.com/docs/guides/functions/cors
// Phase 10 calls Edge Functions from main process only; CORS preflight isn't
// strictly necessary, but the template is future-proof for Phase 11/12.
export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
```

4. Create `supabase/functions/delete-me/deno.json`:

```json
{
  "imports": {
    "@supabase/supabase-js": "https://esm.sh/@supabase/supabase-js@2.106.0"
  }
}
```

5. Create `supabase/functions/delete-me/index.ts` — copy verbatim from RESEARCH §Edge Function code block:

```typescript
/**
 * Edge Function: delete-me
 *
 * The project's FIRST Edge Function. Establishes the convention for Phase
 * 11/12 admin operations (CONTEXT D-13).
 *
 * Flow (RESEARCH §Pitfall A7 + §Edge Function example):
 *   1. OPTIONS → corsHeaders.
 *   2. Method !== POST → 405.
 *   3. Missing Bearer → 401.
 *   4. userClient.auth.getUser() — invalid JWT → 401.
 *   5. INSERT into deletion_queue (empty storage_paths in Phase 10).
 *   6. adminClient.auth.admin.deleteUser(userId).
 *      - On failure, compensating DELETE of the queue row + 500.
 *   7. Return 204.
 *
 * service_role key MUST live ONLY in Supabase Dashboard → Edge Function Secrets,
 * never in the desktop client (CONTEXT D-13 invariant).
 *
 * Source: 10-RESEARCH §Code Examples — Edge Function delete-me (verbatim).
 */
import { createClient } from '@supabase/supabase-js';
import { corsHeaders } from '../_shared/cors.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });

  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'missing_jwt' }), { status: 401, headers: corsHeaders });
  }

  // Two clients: user-scoped (for getUser identification) + admin (for the
  // destructive actions). Admin client never sees the request JWT.
  const userClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const adminClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) {
    return new Response(JSON.stringify({ error: 'invalid_jwt' }), { status: 401, headers: corsHeaders });
  }
  const userId = userData.user.id;

  // 1. Queue 30-day purge job (no FK to auth.users — survives user deletion).
  //    Phase 10: storage_paths is empty (no character images uploaded yet).
  //    Phase 11/12 fills storage_paths with actual paths to delete in 30 days.
  const { error: queueErr } = await adminClient
    .from('deletion_queue')
    .insert({
      user_id: userId,
      deletion_requested_at: new Date().toISOString(),
      storage_paths: [],
    });
  if (queueErr) {
    return new Response(
      JSON.stringify({ error: 'queue_failed', detail: queueErr.message }),
      { status: 500, headers: corsHeaders },
    );
  }

  // 2. Delete the auth user (Supabase cascades to any ON DELETE CASCADE rows).
  const { error: delErr } = await adminClient.auth.admin.deleteUser(userId);
  if (delErr) {
    // Compensating action — remove the queue row we just inserted so the
    // database doesn't accumulate orphaned purge requests.
    await adminClient.from('deletion_queue').delete().eq('user_id', userId);
    return new Response(
      JSON.stringify({ error: 'delete_failed', detail: delErr.message }),
      { status: 500, headers: corsHeaders },
    );
  }

  return new Response(null, { status: 204, headers: corsHeaders });
});
```

NOTE on Deno.serve: Supabase Edge Functions on Deno 1.41+ accept `Deno.serve` directly. If the executor's Supabase CLI version targets an older runtime that uses `serve` from std/http, adapt accordingly — but as of 2026-05 `Deno.serve` is the canonical pattern.
  </action>
  <verify>
    <automated>test -f supabase/config.toml && grep -cF "project_id" supabase/config.toml | grep -q "^1$" && test -f supabase/migrations/20260520000000_deletion_queue.sql && grep -cF "deletion_queue" supabase/migrations/20260520000000_deletion_queue.sql | grep -qE "^[3-9]" && grep -cF "pg_cron" supabase/migrations/20260520000000_deletion_queue.sql | grep -qE "^[1-9]" && grep -cF "interval '30 days'" supabase/migrations/20260520000000_deletion_queue.sql | grep -q "^1$" && test -f supabase/functions/_shared/cors.ts && grep -cF "Access-Control-Allow-Origin" supabase/functions/_shared/cors.ts | grep -q "^1$" && test -f supabase/functions/delete-me/index.ts && grep -cF "auth.admin.deleteUser" supabase/functions/delete-me/index.ts | grep -q "^1$" && grep -cF "deletion_queue" supabase/functions/delete-me/index.ts | grep -qE "^[2-9]" && grep -cF "SUPABASE_SERVICE_ROLE_KEY" supabase/functions/delete-me/index.ts | grep -q "^1$" && grep -rF "SUPABASE_SERVICE_ROLE_KEY" src/ 2>/dev/null | wc -l | grep -q "^0$" && test -f supabase/functions/delete-me/deno.json</automated>
  </verify>
  <acceptance_criteria>
    - `test -f supabase/config.toml`
    - `grep -cF "project_id" supabase/config.toml` equals 1
    - `grep -cF "[functions.delete-me]" supabase/config.toml` equals 1
    - `test -f supabase/migrations/20260520000000_deletion_queue.sql`
    - `grep -cF "create table public.deletion_queue" supabase/migrations/20260520000000_deletion_queue.sql` equals 1
    - `grep -cF "user_id uuid not null" supabase/migrations/20260520000000_deletion_queue.sql` equals 1
    - `grep -cF "storage_paths jsonb" supabase/migrations/20260520000000_deletion_queue.sql` equals 1
    - `grep -cF "purged_at timestamptz" supabase/migrations/20260520000000_deletion_queue.sql` equals 1
    - `grep -cF "enable row level security" supabase/migrations/20260520000000_deletion_queue.sql` equals 1
    - `grep -cF "cron.schedule" supabase/migrations/20260520000000_deletion_queue.sql` equals 1
    - `grep -cF "interval '30 days'" supabase/migrations/20260520000000_deletion_queue.sql` equals 1
    - `grep -cF "references auth" supabase/migrations/20260520000000_deletion_queue.sql` equals 0 (NO foreign key)
    - `test -f supabase/functions/_shared/cors.ts`
    - `grep -cF "export const corsHeaders" supabase/functions/_shared/cors.ts` equals 1
    - `test -f supabase/functions/delete-me/index.ts`
    - `grep -cF "auth.admin.deleteUser" supabase/functions/delete-me/index.ts` equals 1
    - `grep -cF "SUPABASE_SERVICE_ROLE_KEY" supabase/functions/delete-me/index.ts` equals 1
    - `grep -cF "deletion_queue" supabase/functions/delete-me/index.ts` >= 2 (insert + compensating delete)
    - `grep -cF "compensating" supabase/functions/delete-me/index.ts` equals 1 (comment present so reviewer knows why the delete-on-failure exists)
    - `grep -cF "OPTIONS" supabase/functions/delete-me/index.ts` equals 1
    - service_role grep gate (CRITICAL — never in client): `grep -rF "SUPABASE_SERVICE_ROLE_KEY" src/ 2>/dev/null | wc -l` equals 0
    - `test -f supabase/functions/delete-me/deno.json`
    - `grep -cF "@supabase/supabase-js@2.106.0" supabase/functions/delete-me/deno.json` equals 1
  </acceptance_criteria>
  <done>
    supabase/ folder structure established; deletion_queue migration + pg_cron worker + delete-me Edge Function with COMPENSATING delete-on-failure ready to deploy.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: edgeFunctionClient.ts + deleteAccount handler body</name>
  <files>src/main/auth/edgeFunctionClient.ts, src/main/auth/edgeFunctionClient.test.ts, src/main/auth/authHandlers.ts</files>
  <read_first>
    - src/main/auth/authHandlers.ts (plan 03 deleteAccount shell)
    - src/main/auth/supabaseClient.ts (getClient → access_token from current session)
    - src/main/env.ts (getSupabaseUrl)
  </read_first>
  <behavior>
    - callEdgeFunction(name, opts) takes:
        - name: string (e.g. 'delete-me')
        - opts: { jwt: string; method?: 'POST' | 'GET'; body?: unknown; timeoutMs?: number (default 15_000) }
      Constructs URL `${getSupabaseUrl()}/functions/v1/${name}`.
      Adds headers: Authorization: `Bearer ${jwt}`, content-type: 'application/json'.
      Body is JSON.stringify(opts.body) if present.
      Returns: { ok: true, status: number, json?: unknown } | { ok: false, status: number, message: string, json?: unknown }. Network/timeout returns { ok: false, status: 0, message: '...' }.
    - deleteAccount handler:
      1. Read current session via getClient().auth.getSession(); error or no session → {ok:false, code:'network', message:'Not signed in'}.
      2. Call callEdgeFunction('delete-me', { jwt: session.access_token, method: 'POST' }).
      3. If res.ok === true (HTTP 204 or 2xx) → return {ok:true}. Then ALSO call getClient().auth.signOut() so the local session.bin is cleared and SIGNED_OUT fires (which drops the renderer to AuthChoice).
      4. If res.ok === false with status >= 500 → {ok:false, code:'edge_function_error', message:'Could not reach the account-deletion service. Try again.'}.
      5. If status 0 (network/timeout) → {ok:false, code:'network', message:"Couldn't reach the account-deletion service. Try again."}.
      6. Other 4xx → {ok:false, code:'edge_function_error', message: res.message ?? 'Unexpected error'}.
    - Tests: 4 vitest cases with global.fetch stubbed via vi.fn:
      1. callEdgeFunction with 204 → {ok:true, status:204, json:undefined}.
      2. callEdgeFunction with 401 + json body → {ok:false, status:401, json:{error:'invalid_jwt'}, message:'invalid_jwt' (or status text)}.
      3. callEdgeFunction with fetch throwing → {ok:false, status:0, message:'<error message>'}.
      4. callEdgeFunction with timeout (use vi.useFakeTimers + a delayed fetch resolve that never lands within timeoutMs) → {ok:false, status:0, message:'timeout'}.
  </behavior>
  <action>
1. Create `src/main/auth/edgeFunctionClient.ts`:

```typescript
/**
 * Typed wrapper for Supabase Edge Function fetches.
 *
 * Phase 10 uses this for delete-me; Phase 11/12 reuse for additional admin
 * operations (per CONTEXT D-13 — Phase 10 sets the supabase/ convention).
 *
 * Source: 10-RESEARCH §Pitfall A5 (CORS — not needed for main-process fetch
 * but template is future-proof), §Edge Function example (URL shape).
 */
import { getSupabaseUrl } from '../env';

export interface EdgeFunctionOptions {
  jwt: string;
  method?: 'POST' | 'GET';
  body?: unknown;
  timeoutMs?: number;
}

export type EdgeFunctionResponse =
  | { ok: true; status: number; json: unknown }
  | { ok: false; status: number; message: string; json?: unknown };

export async function callEdgeFunction(name: string, opts: EdgeFunctionOptions): Promise<EdgeFunctionResponse> {
  const url = `${getSupabaseUrl()}/functions/v1/${name}`;
  const method = opts.method ?? 'POST';
  const timeoutMs = opts.timeoutMs ?? 15_000;

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${opts.jwt}`,
        'content-type': 'application/json',
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });

    // 204 has no body
    let json: unknown = undefined;
    if (res.status !== 204) {
      try { json = await res.json(); }
      catch { json = undefined; }
    }

    if (res.ok) {
      return { ok: true, status: res.status, json };
    }
    const message = (json && typeof json === 'object' && 'error' in json && typeof (json as { error: unknown }).error === 'string')
      ? (json as { error: string }).error
      : res.statusText || `HTTP ${res.status}`;
    return { ok: false, status: res.status, message, json };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    const isAbort = e.name === 'AbortError';
    return { ok: false, status: 0, message: isAbort ? 'timeout' : (e.message ?? 'network') };
  } finally {
    clearTimeout(timeoutHandle);
  }
}
```

2. Edit `src/main/auth/authHandlers.ts`. Replace the deleteAccount body:

```typescript
// Add imports at top (with existing auth imports):
import { callEdgeFunction } from './edgeFunctionClient';

// Replace deleteAccount body:
export async function deleteAccount(): Promise<DeleteAccountResult> {
  const supabase = getClient();
  const { data: { session }, error: sessErr } = await supabase.auth.getSession();
  if (sessErr || !session) {
    return { ok: false, code: 'network', message: 'Not signed in' };
  }
  const res = await callEdgeFunction('delete-me', {
    jwt: session.access_token,
    method: 'POST',
  });
  if (res.ok) {
    // Deletion succeeded server-side; clear local session so the renderer
    // drops to AuthChoice via the SIGNED_OUT event (D-12 success state).
    try { await supabase.auth.signOut(); }
    catch (err) {
      // Best-effort — the account is gone; even if signOut fails locally,
      // the user's next API call will 401 and Supabase will SIGNED_OUT.
      logger.warn(`deleteAccount: post-delete signOut failed: ${(err as Error).message}`);
    }
    return { ok: true };
  }
  if (res.status === 0) {
    return { ok: false, code: 'network', message: "Couldn't reach the account-deletion service. Try again." };
  }
  return { ok: false, code: 'edge_function_error', message: res.message };
}
```

Delete the `// IMPLEMENTED IN PLAN 10-08` comment.

3. Create `src/main/auth/edgeFunctionClient.test.ts` with 4 vitest cases. Use `global.fetch = vi.fn()` and the AbortSignal pattern. Sample structure:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { callEdgeFunction } from './edgeFunctionClient';

vi.mock('../env', () => ({ getSupabaseUrl: () => 'https://stub.example' }));

const realFetch = global.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  global.fetch = fetchMock as any;
});
afterEach(() => {
  global.fetch = realFetch;
});

describe('callEdgeFunction', () => {
  it('returns ok:true on 204', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const res = await callEdgeFunction('delete-me', { jwt: 'x' });
    expect(res).toEqual({ ok: true, status: 204, json: undefined });
  });

  it('returns ok:false with error message on 401', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'invalid_jwt' }), { status: 401, headers: { 'content-type': 'application/json' } }));
    const res = await callEdgeFunction('delete-me', { jwt: 'x' });
    expect(res.ok).toBe(false);
    expect((res as any).status).toBe(401);
    expect((res as any).message).toBe('invalid_jwt');
  });

  it('returns network failure on fetch throw', async () => {
    fetchMock.mockRejectedValue(new Error('econnrefused'));
    const res = await callEdgeFunction('delete-me', { jwt: 'x' });
    expect(res).toEqual({ ok: false, status: 0, message: 'econnrefused' });
  });

  it('returns timeout when timeoutMs elapses', async () => {
    // fetch returns a Promise that resolves with an abort-triggered error.
    fetchMock.mockImplementation((_url, init) => new Promise((_, reject) => {
      const signal = (init as RequestInit).signal as AbortSignal;
      signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        (err as any).name = 'AbortError';
        reject(err);
      });
    }));
    const res = await callEdgeFunction('delete-me', { jwt: 'x', timeoutMs: 20 });
    expect(res).toEqual({ ok: false, status: 0, message: 'timeout' });
  });
});
```
  </action>
  <verify>
    <automated>! grep -q "IMPLEMENTED IN PLAN 10-08" src/main/auth/authHandlers.ts && grep -c "callEdgeFunction" src/main/auth/authHandlers.ts | grep -q "^1$" && grep -c "auth.getSession" src/main/auth/authHandlers.ts | grep -qE "^[1-9]" && grep -c "edge_function_error" src/main/auth/authHandlers.ts | grep -qE "^[1-9]" && grep -c "export async function callEdgeFunction" src/main/auth/edgeFunctionClient.ts | grep -q "^1$" && grep -c "AbortController" src/main/auth/edgeFunctionClient.ts | grep -q "^1$" && grep -cE "timeoutMs.*15_000|15000" src/main/auth/edgeFunctionClient.ts | grep -qE "^[1-9]" && grep -c "Bearer" src/main/auth/edgeFunctionClient.ts | grep -q "^1$" && grep -rF "SUPABASE_SERVICE_ROLE_KEY" src/ 2>/dev/null | wc -l | grep -q "^0$" && npx vitest run src/main/auth/edgeFunctionClient.test.ts && npx tsc --noEmit</automated>
  </verify>
  <acceptance_criteria>
    - `grep -c "IMPLEMENTED IN PLAN 10-08" src/main/auth/authHandlers.ts` equals 0
    - `grep -c "callEdgeFunction" src/main/auth/authHandlers.ts` equals 1
    - `grep -c "'delete-me'" src/main/auth/authHandlers.ts` equals 1
    - `grep -c "edge_function_error" src/main/auth/authHandlers.ts` >= 1
    - `grep -c "auth.signOut" src/main/auth/authHandlers.ts` >= 2 (plan 06's signOut + plan 08's post-delete cleanup)
    - `grep -c "export async function callEdgeFunction" src/main/auth/edgeFunctionClient.ts` equals 1
    - `grep -c "AbortController" src/main/auth/edgeFunctionClient.ts` equals 1
    - `grep -cE "timeoutMs.*15_?000|15000" src/main/auth/edgeFunctionClient.ts` >= 1
    - `grep -c "Bearer" src/main/auth/edgeFunctionClient.ts` equals 1
    - `grep -c "functions/v1/" src/main/auth/edgeFunctionClient.ts` equals 1
    - Service role grep gate STILL CLEAN: `grep -rF "SUPABASE_SERVICE_ROLE_KEY" src/ 2>/dev/null | wc -l` equals 0
    - `npx vitest run src/main/auth/edgeFunctionClient.test.ts` exits 0 with 4 passing tests
    - `npx tsc --noEmit` exits 0
  </acceptance_criteria>
  <done>
    Typed Edge Function client with timeout + abort; deleteAccount handler chains queue-insert via Edge Function then local signOut; 4 vitest cases pass.
  </done>
</task>

<task type="auto" tdd="false">
  <name>Task 3: Replace DeleteAccountModal stub with the real type-email-to-confirm UI</name>
  <files>src/renderer/src/components/DeleteAccountModal.tsx, src/renderer/src/components/DeleteAccountModal.module.css</files>
  <read_first>
    - src/renderer/src/components/DeleteAccountModal.tsx (plan 07 stub — replace body, preserve props interface)
    - src/renderer/src/components/DeleteConfirmModal.tsx + .module.css (structural template)
    - src/renderer/src/components/TextField.tsx (type-to-confirm input)
    - .planning/phases/10-auth-foundation/10-UI-SPEC.md §Delete-account modal (D-12) + §Layout rule 5 (click-outside DOES NOT close) + rule 4a (ESC suppressed while in-flight)
    - .planning/phases/10-auth-foundation/10-CONTEXT.md D-12
  </read_first>
  <behavior>
    - Same props as the stub: { accountEmail: string; onCancel: () => void; onConfirmed: () => void }.
    - State: typed (string), submitting (boolean), phase ('idle' | 'success').
    - Title: 'Delete your Sei account?'
    - 3 body paragraphs (UI-SPEC verbatim):
      1. 'Cloud-side, this removes your characters, shared listings, credit ledger, and uploaded skin & portrait files within 30 days.'
      2. 'Local-side, your characters on this machine, your bot's memory, and any cloud characters you've opened locally are untouched.'
      3. 'To confirm, type <strong>{accountEmail}</strong> below.' (with email bolded inline via <strong> tag).
    - TextField with placeholder `{accountEmail}`.
    - Destructive confirm button: red bg, white text (use the `.deleteBtn` class pattern from DeleteConfirmModal.module.css). DISABLED until typed.trim().toLowerCase() === accountEmail.trim().toLowerCase(). While submitting: label flips to 'Deleting…'.
    - Dismissal: quiet Button 'Keep my account'. Click → onCancel.
    - ESC: closes the modal UNLESS submitting (UI-SPEC §Layout rule 4a).
    - Click-outside: does NOT close (UI-SPEC §Layout rule 5).
    - On confirm: await sei.deleteAccount().
      - On {ok:true}: phase becomes 'success'; modal swaps to title 'Delete your Sei account?' + body 'Account scheduled for deletion. Signing you out…'; after 1200ms, call onConfirmed (parent unmounts modal; SIGNED_OUT event drops app to AuthChoice).
      - On {ok:false}: surface result.message as red helper text below the TextField; re-enable button (still requires typed match).
    - aria-describedby on the input → the body paragraph 3 element id (so screen readers hear the required string).
    - Modal width 460px, 32px padding, scrim 0.45 alpha, sharp corners (UI-SPEC verbatim).
  </behavior>
  <action>
1. Create `src/renderer/src/components/DeleteAccountModal.module.css` (clone DeleteConfirmModal.module.css and add the type-to-confirm input row):

```css
/* Phase 10 — DeleteAccountModal (D-12). Mirrors DeleteConfirmModal scaffold;
   adds a type-to-confirm input row between body and footer. */
.scrim {
  position: fixed; inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex; align-items: center; justify-content: center;
  z-index: 1000;
  animation: fade 220ms ease;
}
.modal {
  width: 460px;
  background: var(--window);
  padding: var(--space-xl);
  border: 1px solid var(--border-strong);
  font-family: var(--sans);
  animation: fadeUp 280ms var(--ease-pop);
  display: flex; flex-direction: column; gap: var(--space-md-plus);
}
.title {
  font-size: 22px; font-weight: 600; line-height: 1.2; letter-spacing: -0.2px;
  color: var(--text); margin: 0;
}
.body {
  font-size: 15px; line-height: 1.5; color: var(--text-2); margin: 0;
}
.bodyEmphasis { font-weight: 600; color: var(--text); }
.confirmInputRow { margin: 0; }
.errorText {
  font-size: 14px; color: var(--red); margin: 0;
}
.footer {
  display: flex; justify-content: flex-end; gap: var(--space-md); margin-top: var(--space-md-plus);
}
.deleteBtn {
  background: var(--red); color: var(--window);
  border: 0; font-family: var(--sans);
  font-size: 14px; font-weight: 600;
  padding: 6px 14px; cursor: pointer;
}
.deleteBtn:hover { filter: brightness(0.95); }
.deleteBtn:focus-visible { outline: 1.5px solid var(--accent); outline-offset: 2px; }
.deleteBtn:disabled { opacity: 0.5; cursor: not-allowed; }
.success {
  font-size: 15px; color: var(--text); margin: 0;
}
@keyframes fade { from {opacity:0} to {opacity:1} }
@keyframes fadeUp { from {opacity:0; transform:translateY(8px)} to {opacity:1; transform:none} }
@media (prefers-reduced-motion: reduce) {
  .scrim, .modal { animation: none; }
}
```

2. Replace `src/renderer/src/components/DeleteAccountModal.tsx` (the plan 07 stub — preserve props interface):

```tsx
/**
 * DeleteAccountModal — type-email-to-confirm destructive modal (D-12).
 *
 * Source: 10-UI-SPEC §Delete-account modal + Copywriting Contract.
 *
 * Layout invariants per UI-SPEC §Layout rules:
 *   - 460px width, 32px padding, scrim 0.45 alpha (rule 2, 3).
 *   - ESC closes; SUPPRESSED while submitting (rule 4a).
 *   - Click-outside does NOT close — explicit 'Keep my account' required (rule 5).
 *   - Destructive confirm disabled until typed string matches accountEmail
 *     (case-insensitive trim).
 */
import React, { useEffect, useState } from 'react';
import { sei } from '../lib/ipcClient';
import { Button } from './Button';
import { TextField } from './TextField';
import styles from './DeleteAccountModal.module.css';

export interface DeleteAccountModalProps {
  accountEmail: string;
  onCancel: () => void;
  onConfirmed: () => void;
}

export function DeleteAccountModal({ accountEmail, onCancel, onConfirmed }: DeleteAccountModalProps): React.ReactElement {
  const [typed, setTyped] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<'idle' | 'success'>('idle');

  const matches = typed.trim().toLowerCase() === accountEmail.trim().toLowerCase();
  const canConfirm = matches && !submitting && phase === 'idle';

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !submitting && phase === 'idle') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, submitting, phase]);

  const onConfirmClick = async (): Promise<void> => {
    if (!canConfirm) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await sei.deleteAccount();
      if (res.ok) {
        setPhase('success');
        setTimeout(() => onConfirmed(), 1200);
      } else {
        setError(
          res.code === 'network'
            ? "Couldn't reach the account-deletion service. Try again."
            : (res.message || "Couldn't delete the account. Try again."),
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  const titleId = 'delete-account-title';
  const para3Id = 'delete-account-confirm-instruction';

  return (
    <div className={styles.scrim} role="dialog" aria-modal="true" aria-labelledby={titleId}
         /* Click-outside SUPPRESSED — UI-SPEC §Layout rule 5. No onClick handler on scrim. */>
      <div className={styles.modal}>
        <h2 id={titleId} className={styles.title}>Delete your Sei account?</h2>

        {phase === 'idle' ? (
          <>
            <p className={styles.body}>
              Cloud-side, this removes your characters, shared listings, credit ledger, and uploaded skin &amp; portrait files within 30 days.
            </p>
            <p className={styles.body}>
              Local-side, your characters on this machine, your bot&apos;s memory, and any cloud characters you&apos;ve opened locally are untouched.
            </p>
            <p id={para3Id} className={styles.body}>
              To confirm, type <strong className={styles.bodyEmphasis}>{accountEmail}</strong> below.
            </p>

            <div className={styles.confirmInputRow}>
              <TextField
                label=""
                placeholder={accountEmail}
                value={typed}
                onChange={setTyped}
                type="email"
                aria-describedby={para3Id}
                aria-invalid={typed.length > 0 && !matches}
              />
            </div>

            {error ? <p className={styles.errorText} role="alert">{error}</p> : null}

            <div className={styles.footer}>
              <Button kind="quiet" size="md" onClick={onCancel} disabled={submitting}>
                Keep my account
              </Button>
              <button
                type="button"
                className={styles.deleteBtn}
                onClick={onConfirmClick}
                disabled={!canConfirm}
              >
                {submitting ? 'Deleting…' : 'Delete account'}
              </button>
            </div>
          </>
        ) : (
          <p className={styles.success}>Account scheduled for deletion. Signing you out…</p>
        )}
      </div>
    </div>
  );
}
```

NOTE: Read TextField.tsx FIRST to confirm props. If `aria-describedby` / `aria-invalid` are not supported, omit them (best-effort accessibility — Phase 10 won't fail UI-SPEC for missing aria attrs on a custom TextField).
  </action>
  <verify>
    <automated>grep -cF "Delete your Sei account?" src/renderer/src/components/DeleteAccountModal.tsx | grep -q "^1$" && grep -cF "Cloud-side, this removes your characters" src/renderer/src/components/DeleteAccountModal.tsx | grep -q "^1$" && grep -cF "Local-side, your characters on this machine" src/renderer/src/components/DeleteAccountModal.tsx | grep -q "^1$" && grep -cF "Keep my account" src/renderer/src/components/DeleteAccountModal.tsx | grep -q "^1$" && grep -cF "Delete account" src/renderer/src/components/DeleteAccountModal.tsx | grep -qE "^[2-9]" && grep -cF "Deleting…" src/renderer/src/components/DeleteAccountModal.tsx | grep -q "^1$" && grep -cF "Account scheduled for deletion. Signing you out…" src/renderer/src/components/DeleteAccountModal.tsx | grep -q "^1$" && grep -cE "sei\\.deleteAccount" src/renderer/src/components/DeleteAccountModal.tsx | grep -q "^1$" && grep -cE "width: 460px" src/renderer/src/components/DeleteAccountModal.module.css | grep -q "^1$" && grep -cE "background: var\\(--red\\)" src/renderer/src/components/DeleteAccountModal.module.css | grep -q "^1$" && ! grep -q "DeleteAccountModal] not yet implemented" src/renderer/src/components/DeleteAccountModal.tsx && npx tsc --noEmit</automated>
  </verify>
  <acceptance_criteria>
    - `grep -cF "Delete your Sei account?" src/renderer/src/components/DeleteAccountModal.tsx` equals 1
    - `grep -cF "Cloud-side, this removes your characters, shared listings, credit ledger, and uploaded skin" src/renderer/src/components/DeleteAccountModal.tsx` equals 1
    - `grep -cF "Local-side, your characters on this machine, your bot" src/renderer/src/components/DeleteAccountModal.tsx` equals 1
    - `grep -cF "To confirm, type" src/renderer/src/components/DeleteAccountModal.tsx` equals 1
    - `grep -cF "Keep my account" src/renderer/src/components/DeleteAccountModal.tsx` equals 1
    - `grep -cF "Delete account" src/renderer/src/components/DeleteAccountModal.tsx` >= 2 (label + 'Deleting…' state surrounding text)
    - `grep -cF "Deleting…" src/renderer/src/components/DeleteAccountModal.tsx` equals 1
    - `grep -cF "Account scheduled for deletion. Signing you out…" src/renderer/src/components/DeleteAccountModal.tsx` equals 1
    - `grep -cE "sei\\.deleteAccount" src/renderer/src/components/DeleteAccountModal.tsx` equals 1
    - `grep -c "not yet implemented" src/renderer/src/components/DeleteAccountModal.tsx` equals 0 (stub replaced)
    - `grep -c "matches" src/renderer/src/components/DeleteAccountModal.tsx` >= 1 (typed-vs-email check)
    - `grep -cE "width: 460px" src/renderer/src/components/DeleteAccountModal.module.css` equals 1
    - `grep -cE "background: var\\(--red\\)" src/renderer/src/components/DeleteAccountModal.module.css` equals 1
    - `grep -cE "rgba\\(0, 0, 0, 0\\.45\\)" src/renderer/src/components/DeleteAccountModal.module.css` equals 1
    - `npx tsc --noEmit` exits 0
  </acceptance_criteria>
  <done>
    DeleteAccountModal renders the full UI-SPEC §Delete-account modal with verbatim copy; destructive button gates on typed-email match; click-outside suppressed; ESC suppressed while submitting; success transition lands on the 'scheduled for deletion' state.
  </done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task 4 (checkpoint): Deploy delete-me + verify end-to-end account deletion against real Supabase</name>
  <files>none — human verification of prior code-producing tasks</files>
  <action>Perform the verification steps listed under <how-to-verify> below. The executor must NOT skip; this checkpoint gates the wave.</action>
  <verify>
    <automated>echo "human checkpoint — see how-to-verify below"; true</automated>
  </verify>
  <done>User has replied "approved" to the resume signal below.</done>
  <what-built>
    Full GDPR deletion flow: DeleteAccountModal → sei.deleteAccount → callEdgeFunction → Edge Function → deletion_queue + auth.admin.deleteUser → local signOut → AuthChoice.
  </what-built>
  <how-to-verify>
    Pre-flight: complete the user_setup tasks (install Supabase CLI; link project; push migration; deploy function). Confirm in Supabase Dashboard → Edge Functions that `delete-me` is listed as Deployed and pg_cron extension is enabled.

    1. Create a brand-new throwaway test account in Sei via SignInModal → Create Account flow. Note the email.
    2. Navigate to Settings → ACCOUNT panel → click `Delete account…` (red button in Danger Zone). DeleteAccountModal opens.
    3. Verify title is `Delete your Sei account?`. Verify all 3 body paragraphs match UI-SPEC verbatim. Verify `Delete account` button is DISABLED (greyed/cursor:not-allowed). Verify `Keep my account` is enabled.
    4. Type a wrong email (e.g. `wrong@foo.com`) → button stays disabled. Type your account email → button enables. Type matches case-insensitive: try MixedCase variants of your email — button stays enabled.
    5. Click `Keep my account` → modal closes, no side effects. Re-open the modal.
    6. Press ESC → modal closes.
    7. Click outside the modal (on the scrim) → modal does NOT close (UI-SPEC §Layout rule 5).
    8. Type the email correctly → click `Delete account`. Button label flips to `Deleting…`. ESC is suppressed during this ~500ms window.
    9. On success: body swaps to `Account scheduled for deletion. Signing you out…`. After 1.2s, modal closes; app drops to AuthChoice (SIGNED_OUT event from local signOut).
    10. In Supabase Dashboard → Authentication → Users — the account no longer appears.
    11. In Supabase Dashboard → SQL Editor — run `SELECT user_id, deletion_requested_at, storage_paths, purged_at FROM public.deletion_queue ORDER BY deletion_requested_at DESC LIMIT 5;` — one row for the deleted user_id, deletion_requested_at is recent, storage_paths is `[]`, purged_at is NULL.
    12. Verify AUTH-06 local invariant: local `<userData>/Sei Launcher Dev/characters/` and `memory/` files UNCHANGED; api_key.bin UNCHANGED.
    13. Sign in with the deleted email — Supabase returns `Invalid login credentials` (account gone), which surfaces as the inline error in SignInModal.
    14. (pg_cron 30-day worker not testable in this checkpoint; verify the worker definition exists by running `SELECT cron.job_name FROM cron.job WHERE jobname = 'purge-deletion-queue';` in SQL Editor — returns one row.)
  </how-to-verify>
  <resume-signal>
    Reply `approved` if all 14 steps pass. If step 11's deletion_queue row is missing, the Edge Function's INSERT failed — check Edge Function logs (Dashboard → Edge Functions → delete-me → Logs) for the error.
  </resume-signal>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Desktop client → Edge Function | Bearer JWT verifies caller identity. Function re-verifies via getUser() (defense-in-depth over Supabase gateway's verify_jwt). |
| Edge Function → Postgres | service_role used for the INSERT + admin.deleteUser. RLS default-deny on deletion_queue (no client policy). |
| service_role key location | LIVES ONLY in Supabase Edge Function env vars. Grep gate: `grep -rF SUPABASE_SERVICE_ROLE_KEY src/` returns 0. |
| User confirmation | Type-email-to-confirm gates destruction. Even a hostile renderer must somehow know and type the email. |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-10-08-01 | Elevation of Privilege | service_role key leaks into the desktop binary | mitigate | Grep gate: `grep -rF "SUPABASE_SERVICE_ROLE_KEY" src/ 2>/dev/null | wc -l` MUST equal 0. .env.example does NOT mention the service role key. The Edge Function references it ONLY via `Deno.env.get(...)`. |
| T-10-08-02 | Spoofing | Edge Function called with a forged Bearer (someone else's JWT) | mitigate | The function calls userClient.auth.getUser() which validates the JWT signature against Supabase's JWKS. Invalid → 401. |
| T-10-08-03 | Tampering | Race: insert into deletion_queue succeeds, deleteUser fails, queue row orphaned | mitigate | Compensating DELETE in the failure path (`adminClient.from('deletion_queue').delete().eq('user_id', userId)`). Acceptance criterion grep-asserts a 'compensating' comment exists. |
| T-10-08-04 | Information Disclosure | deletion_queue holds user_id forever | accept | user_id is a UUID; per RESEARCH §Pitfall A7 NO FK is intentional (row outlives auth.users). 30-day window is GDPR-compliant; row is marked purged_at after that. |
| T-10-08-05 | Denial of Service | Spam clicks on Delete account → multiple Edge Function invocations | mitigate | The first successful invocation deletes the auth user; subsequent invocations fail with `invalid_jwt` (the JWT references a now-deleted sub). Acceptable degradation. |
| T-10-08-06 | Tampering | Renderer fakes a sei.deleteAccount and skips the type-email confirmation | mitigate | The renderer-side check is UX; the actual gate is the Edge Function requiring a valid Bearer JWT. Worst case: an authenticated user deletes their own account without typing — exactly equivalent to "user is signed in and posts to /delete-me directly with their JWT". Acceptable. |
| T-10-08-07 | Information Disclosure | Edge Function error response leaks queueErr.message / delErr.message (could include schema names) | accept | The error.detail field is included only for 500-class responses; these are dev-time signals. Production logs should redact, but Phase 10 doesn't add a logger to the Edge Function. Future hardening. |
| T-10-08-08 | Tampering | A bug in pg_cron worker purges rows BEFORE 30 days | mitigate | SQL gate: `interval '30 days'` is grep-asserted. Cron schedule '0 3 * * *' (daily) is grep-asserted. Worker body only marks purged_at; does not delete the row (so audit trail preserved). |
| T-10-08-09 | Denial of Service | CORS preflight failures from renderer-side calls in future phases | accept (Phase 10) | Phase 10 calls the Edge Function from main ONLY (Node fetch — no CORS). The OPTIONS handler exists for Phase 11/12 future-proofing per RESEARCH §Pitfall A5. |
</threat_model>

<verification>
1. `npx tsc --noEmit` exits 0.
2. `npx vitest run src/main/auth/edgeFunctionClient.test.ts` — 4 tests pass.
3. Human checkpoint (Task 4) — all 14 steps pass.
4. `grep -rF "SUPABASE_SERVICE_ROLE_KEY" src/ 2>/dev/null | wc -l` equals 0.
5. supabase/ folder exists with config.toml, migration, function, _shared/cors.
</verification>

<success_criteria>
- supabase/ folder convention established (config.toml + migrations + functions/_shared + functions/delete-me)
- delete-me Edge Function: JWT verify → queue insert → auth.admin.deleteUser → compensating delete on failure → 204
- pg_cron daily worker marks 30-day-old rows as purged_at
- callEdgeFunction reusable wrapper with timeout + abort
- deleteAccount handler: chain Edge Function call → local signOut
- DeleteAccountModal: type-email-to-confirm, click-outside suppressed, ESC suppressed while submitting, success transition
- service_role never in client (grep gate)
- 4 edgeFunctionClient tests pass; tsc clean
- Human-verified end-to-end against real Supabase
</success_criteria>

<output>
After completion, create `.planning/phases/10-auth-foundation/10-08-SUMMARY.md` covering: the supabase/ folder convention (so Phase 11/12 admin functions slot in alongside _shared/cors.ts), the callEdgeFunction reusable contract (Phase 11+ uses for moderation/admin ops), the pg_cron worker body Phase 11/12 must extend (Storage path iteration), and the DeleteAccountResult-to-modal mapping (so Phase 11+ delete-with-character-cleanup variant can be added without breaking the modal).
</output>
