# Deferred items — 260524-0ka

Pre-existing or out-of-scope issues observed during execution. Per the
constraints' "Only auto-fix issues DIRECTLY caused by the current task's
changes" rule, these are recorded for a future session and NOT fixed in
260524-0ka.

## 1. portraitStore.test.ts ENOTEMPTY flake (pre-existing)

**File:** `src/main/portraitStore.test.ts`
**Test:** `removePortrait > clears portrait_image and unlinks the file`
**Failure mode:** `ENOTEMPTY: directory not empty, rmdir '/var/folders/.../sei-portrait-XXXX'`
**Reproduces in:** the parallel full-suite vitest run; passes in isolation.
**Cause hypothesis:** test cleanup rmdir races with a still-open file
handle from a previous test in the same temp directory hierarchy. Not
related to any 260524-0ka file (proxyClient.ts / playtimeEstimate.ts /
webhook), and the test passes 5/5 when re-run alone.
**Recommended fix path (next session):** convert the temp-dir cleanup to
`rm -rf` semantics via `fs.rm(dir, { recursive: true, force: true })`,
OR add a per-test unique temp dir with no shared ancestor.

## 2. Pre-existing Deno-format test files (documented in 260523-t8d SUMMARY)

**Files:**
- `supabase/functions/lemon-webhook/index.test.ts`
- `supabase/functions/submit-report/index.test.ts`
- `supabase/functions/trial-claim/index.test.ts`

**Failure mode:** `Cannot find package 'jsr:@std/assert@1'` when vitest
tries to import them. These are Deno-style tests intended to run via
`deno test`, not vitest. The 260523-t8d SUMMARY documents this as
already-failing-pre-task and out of scope.

**Note for 260524-0ka:** the lemon-webhook one was MODIFIED in this
quick task (added 8 new A4 + isSubscriptionFirstInvoice tests). All 33
tests pass under `deno test supabase/functions/lemon-webhook/
--allow-env --allow-net --no-check` (the documented run command). The
vitest "failure" is just the import-resolution mismatch from the wrong
runner — not a test logic regression.

**Recommended fix path (whenever the project decides to unify
test runners):** either add `jsr:` import resolution to vitest config
(unlikely — vitest doesn't natively support JSR), OR add a vitest
include/exclude rule for `supabase/functions/**/*.test.ts` so the
Deno-only tests don't appear in the vitest run output.

## 3. Cosmetic — DEFAULT_TOKENS_PER_MIN one-token offset (1523 vs 1524)

**Files:** `src/renderer/src/lib/playtimeEstimate.ts`
**Symptom:** the JSDoc derivation says `ceil(91_400 / 60) = 1524` but
DEFAULT is set to 1523 (per dispatch-prompt B4 spec). The B5
playtimeEstimate.test.ts case tolerates a ≤1 token offset
(`Math.abs(derived - DEFAULT_TOKENS_PER_MIN) <= 1`).
**Why deferred:** the dispatch prompt's plan-checker WARNING flagged
this as non-blocking ("don't re-architect"). Either 1523 or 1524 is
correct; the constant choice is operationally indistinguishable
(0.07% difference in displayed playtime).
**Recommended fix path:** in a future session, either bump DEFAULT to
1524 (matching the derivation exactly) or update the JSDoc to say
`floor` instead of `ceil` (matching the constant). Pick whichever the
maintainer prefers for codebase consistency.
