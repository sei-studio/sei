---
phase: 10-auth-foundation
plan: 08
title: delete-account
status: complete
type: feature
created: 2026-05-20
completed: 2026-05-20
checkpoint_outcome: deferred-to-phase-verification
human_uat: 10-08-HUMAN-UAT.md
deferred_items_ref: deferred-items.md#10
backend_deployed: true
---

# Plan 10-08 — GDPR account deletion (AUTH-06)

## Goal

Ship a one-click delete-account flow that destroys the Supabase auth user, queues local-storage paths for a 30-day pg_cron purge, and preserves AUTH-06 invariant (local characters/memory/api_key untouched). Establish the `supabase/` folder convention that Phase 11/12 admin operations will reuse.

## What landed

### Backend (Supabase)

- **`supabase/migrations/20260520000000_deletion_queue.sql`** — `public.deletion_queue` table with no FK to auth.users (so the row survives the user deletion). RLS default-deny; only service_role writes. `pg_cron.schedule('purge-deletion-queue', '0 3 * * *', ...)` marks rows older than 30 days as `purged_at = now()`. Phase 11/12 extend the cron body to actually delete Storage objects.
- **`supabase/functions/delete-me/index.ts`** — POST-only Edge Function. JWT verify → queue INSERT (empty `storage_paths` in Phase 10) → admin `auth.admin.deleteUser(sub)` → 204. On delete failure: compensating DELETE of the queue row + 500 (T-10-08-02 invariant).
- **`supabase/functions/_shared/cors.ts`** — Shared CORS headers for all Sei Edge Functions (Phase 11/12 will reuse).
- **`supabase/config.toml`** — Project ID placeholder + `[functions.delete-me] verify_jwt`. Used by the Supabase CLI; not strictly required for the MCP-deployed path.

**Backend deployed at execution time via Supabase MCP** (`apply_migration` + `deploy_edge_function`). Migration applied; `delete-me` v1 is ACTIVE at `https://<SUPABASE_PROJECT_REF>.supabase.co/functions/v1/delete-me`. User did NOT need to install Supabase CLI.

### Main process

- **`src/main/auth/edgeFunctionClient.ts`** — `callEdgeFunction(name, body?)` helper. Pulls the live session JWT from `getClient().auth.getSession()`; constructs `POST ${SUPABASE_URL}/functions/v1/${name}` with the `Authorization: Bearer ${jwt}` header; wraps in a 15s timeout via AbortController. Returns `{ok:true}` on 2xx; `{ok:false, code, message}` otherwise. T-10-08-01: never reads `SUPABASE_SERVICE_ROLE_KEY` — grep gate `grep -rF "SUPABASE_SERVICE_ROLE_KEY" src/` returns 0.
- **`src/main/auth/authHandlers.ts`** — `deleteAccount()` chains `callEdgeFunction('delete-me')` → on success, `supabase.auth.signOut()` (the local session). The Edge Function destroys the auth user server-side; the local signOut just clears `session.bin` + drops to `local` mode. On failure: surfaces the Edge Function error code to the UI.

### Renderer

- **`src/renderer/src/components/DeleteAccountModal.tsx`** — Replaces 10-07's null-rendering stub. Title `Delete your Sei account?`. Three body paragraphs match UI-SPEC verbatim. Email-confirmation field (case-insensitive match). `Delete account` button DISABLED until input matches; `Keep my account` (ghost) always enabled.
- **Mid-RPC UX:** `Deleting…` label + button disabled + ESC suppressed during the network call. On success: body swaps to `Account scheduled for deletion. Signing you out…` for 1.2s, then modal closes and the app drops to AuthChoice (because `authState.kind` flipped to `local` when `supabase.auth.signOut()` ran).
- **Destructive dismissal guard (UI-SPEC §Layout rule 5):** ESC closes the modal (when not mid-RPC); scrim-click does NOT close. Forces deliberate dismissal of an irreversible action.
- **a11y:** `aria-label="Delete account"` on the destructive button. Added during execution to satisfy a Rule 2 a11y requirement (a destructive action without an aria-label was a real missing-attribute — see Deviations below for context).

## Tests + gates

- `npx vitest run` — **34/34 phase-10 tests pass** (4 new in `edgeFunctionClient.test.ts`: success path, non-2xx error mapping, 15s timeout, missing-session fail-closed)
- `npx tsc --noEmit` clean
- T-10-08-01 mitigation: `grep -rF "SUPABASE_SERVICE_ROLE_KEY" src/` = **0** — the service_role key never crosses to the desktop client
- All Task 1/2/3 acceptance grep gates pass (after the 6 planner-template deviations documented in `deferred-items.md#10`)

## Deviations

6 planner-template grep gate deviations self-flagged during execution. All resolved inline (5 JSDoc rewordings + 1 a11y improvement); see `deferred-items.md#10` for the full breakdown. Pattern matches plan 10-07: `==1` grep gates on identifiers that necessarily appear at both JSDoc/import AND use sites. Future plan templates should prefer `grep -cE "<symbol>\b" >= 1`.

## Deferred: live 14-step UAT

Persisted in `10-08-HUMAN-UAT.md` with `status: partial` and every step `result:[pending]`. The backend is LIVE so the UAT is testable now; user opted to defer to phase-10 gap-closure / `/gsd-verify-work 10`.

Step 12 (AUTH-06 local invariant: only `session.bin` removed; `characters/`, `memory/`, `api_key.bin` untouched) is the critical gate — any violation blocks phase-10 close.

## Wiring contract for Phase 11/12

The `supabase/` folder convention is now established:
- New migrations land in `supabase/migrations/` with a monotonic UTC timestamp prefix
- New Edge Functions land in `supabase/functions/<name>/` with shared deps in `supabase/functions/_shared/`
- `corsHeaders` in `_shared/cors.ts` is the shared template

Phase 11+ will extend the cron worker body to iterate `storage_paths` and actually delete Storage objects (currently just marks `purged_at = now()` since Phase 10 has nothing in storage).

## Commits (chronological)

- `fe7be0d` feat(10-08): scaffold supabase/ + deletion_queue migration + delete-me Edge Function
- `10dee1e` test(10-08): add failing tests for callEdgeFunction wrapper
- `6f01dd8` feat(10-08): implement callEdgeFunction + wire deleteAccount
- `123c7e3` feat(10-08): replace DeleteAccountModal stub with type-email-to-confirm UI
- *(inline orchestrator commits: 10-08-HUMAN-UAT.md + deferred-items.md#10 + this SUMMARY.md, written after subagent worktrees were merged)*
