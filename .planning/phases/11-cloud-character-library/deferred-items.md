# Phase 11 — Deferred Items

Out-of-scope issues discovered during execution. Tracked here per executor
scope-boundary rule; NOT to be fixed in the discovering plan.

## Pre-existing typecheck errors (discovered during 11-07)

These existed BEFORE Plan 11-07 landed — confirmed via `git stash && tsc` on
the base `b9d2bd6 chore: merge executor worktree (11-05)`. Out-of-scope for
11-07, which adds zero new TS errors of its own.

- `src/main/auth/loopbackPkce.ts:83:57` — TS2353: `flowType` not in
  `SignInWithOAuthCredentials.options` type. Supabase JS 2.x drifted vs. our
  call shape; either move flowType to client init (already there in
  supabaseClient.ts) and drop it here, or pin the supabase-js types.
- `src/main/auth/supabaseClient.test.ts:19:58` — TS2556: spread-argument
  tuple-type error. Test harness wrinkle.

Suggested home: a small Phase 11 tail plan ("hygiene") or a Phase 12 cleanup.
