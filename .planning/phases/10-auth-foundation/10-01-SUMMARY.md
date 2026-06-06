---
phase: 10-auth-foundation
plan: 01
subsystem: auth
tags: [supabase, electron, env, pkce, main-process]

# Dependency graph
requires:
  - phase: pre-10
    provides: existing main-process module pattern (src/main/apiKeyStore.ts), electron-vite config, tsconfig.node.json
provides:
  - "@supabase/supabase-js@^2.106.0 dependency in package.json"
  - "src/main/env.ts: lazy getSupabaseUrl/getSupabaseAnonKey getters with SUPABASE_ENV_MISSING throw"
  - "src/main/auth/supabaseClient.ts: getClient() singleton + setStorageAdapter() + StorageAdapter interface"
  - "electron.vite.config.ts main.define block injecting SUPABASE_URL / SUPABASE_ANON_KEY at build time"
  - ".env.example documenting required env vars"
  - "vitest@^4 devDependency (new test framework — first vitest test landed)"
affects: [10-02-session-store, 10-03-bootstrap, 10-04-auth-ipc, 10-05-google-oauth, 10-06-jwt-port-handoff, 11, 12, 13]

# Tech tracking
tech-stack:
  added: ["@supabase/supabase-js@^2.106.0", "vitest@^4.1.6"]
  patterns:
    - "Lazy singleton with ordering gate (setStorageAdapter before getClient)"
    - "Named error throws (SUPABASE_ENV_MISSING, SUPABASE_NO_STORAGE_ADAPTER, SUPABASE_CLIENT_ALREADY_CREATED) — surfaces ordering bugs immediately"
    - "Build-time env injection via electron-vite main.define + ImportMeta augmentation"

key-files:
  created:
    - src/main/env.ts
    - src/main/auth/supabaseClient.ts
    - src/main/auth/supabaseClient.test.ts
    - .env.example
  modified:
    - package.json
    - package-lock.json
    - electron.vite.config.ts
    - .gitignore

key-decisions:
  - "Lazy singleton (instantiate on first getClient()) so test harnesses without env vars do not crash on module import"
  - "setStorageAdapter ordering gate throws if called after getClient — re-wiring storage mid-flight would orphan the in-memory session; plan 03 must call it during bootstrap before any IPC handler is registered"
  - "Augmented ImportMeta inline in env.ts (not via a separate vite-env.d.ts) — keeps the type fiction co-located with the only file that reads it"
  - "Adopted vitest@^4 as the first formal test framework for Sei (project previously had a single node:test mjs file); chosen to satisfy plan 10-01 TDD requirement and provide a foundation for Phase 10's auth coverage"

patterns-established:
  - "src/main/auth/* subdirectory convention for Supabase-touching code (renderer/preload/utility must never import from here)"
  - ".env.example template + .gitignore negation pattern (.env.* matches but !.env.example un-matches) so the template is committable while .env stays local"
  - "vitest run path for main-process modules: vi.mock '../env' to stub build-time injected values; vi.mock '@supabase/supabase-js' to avoid network in unit tests"

requirements-completed: [AUTH-01, AUTH-02, AUTH-03]

# Metrics
duration: ~6min
completed: 2026-05-19
---

# Phase 10 Plan 01: Supabase Foundation Summary

**Lazy main-process Supabase singleton with PKCE auth config, build-time env injection via electron-vite define, and an ordering gate (setStorageAdapter before getClient) that surfaces plan 03 bootstrap bugs immediately.**

## Performance

- **Duration:** ~6 min
- **Started:** 2026-05-19T22:54:00Z
- **Completed:** 2026-05-19T23:00:03Z
- **Tasks:** 2 (3 commits — feat + test + feat)
- **Files modified:** 8 (4 created, 4 modified)

## Accomplishments
- @supabase/supabase-js@^2.106.0 pinned as a direct dependency (not dev) — confirmed createClient resolves under Node ESM
- `src/main/env.ts` exports lazy `getSupabaseUrl()` / `getSupabaseAnonKey()` that throw `SUPABASE_ENV_MISSING: <NAME> must be set at build time` when value is empty
- `src/main/auth/supabaseClient.ts` exports `getClient()` (lazy singleton), `setStorageAdapter()` (ordering gate), `StorageAdapter` interface, and `_resetForTests()` for vitest isolation
- 3 unit tests pass: missing-adapter throws, singleton identity, adapter-after-client throws
- `electron.vite.config.ts` main.define injects both env vars at build time; ImportMeta augmented inline in env.ts
- `.env.example` committed with the two SUPABASE_* keys; `.gitignore` updated so `.env` stays ignored but `.env.example` is not

## Task Commits

Each task was committed atomically:

1. **Task 1: Install @supabase/supabase-js + wire env injection** — `49b2022` (feat)
2. **Task 2 RED: failing tests for supabaseClient** — `008e07a` (test)
3. **Task 2 GREEN: implement supabaseClient singleton** — `28a383b` (feat)

_TDD: RED commit (008e07a) was a failing test, GREEN commit (28a383b) implements the module. No REFACTOR commit needed — implementation was clean on first pass._

## Files Created/Modified
- `package.json`, `package-lock.json` — pinned `@supabase/supabase-js@^2.106.0` (dep) + `vitest@^4.1.6` (devDep)
- `.env.example` — Supabase URL + anon key template with explanatory comment block
- `.gitignore` — added `!.env.example` negation so the template can be committed while `.env` stays ignored
- `electron.vite.config.ts` — main section now has a `define` block injecting both SUPABASE_* env vars via `JSON.stringify(process.env.<NAME> ?? '')`
- `src/main/env.ts` — created. Lazy getter pattern + named error class. Includes inline `declare global { interface ImportMeta { ... } }` so TS understands the build-time-injected keys
- `src/main/auth/supabaseClient.ts` — created. Locked auth config: `{ storage, autoRefreshToken: true, persistSession: true, detectSessionInUrl: false, flowType: 'pkce' }`
- `src/main/auth/supabaseClient.test.ts` — created. Three vitest tests with `vi.mock` for `../env` and `@supabase/supabase-js` so the test never hits a real Supabase project

## The Locked Auth Config Block (for plan 02 / 03 reuse)

Plan 02 and 03 MUST NOT re-instantiate the Supabase client with different options. The single source of truth is `src/main/auth/supabaseClient.ts`:

```typescript
client = createClient(getSupabaseUrl(), getSupabaseAnonKey(), {
  auth: {
    storage: storageAdapter,         // plan 02 supplies the safeStorage-backed adapter
    autoRefreshToken: true,          // Supabase rotates JWT ~5 min before expiry
    persistSession: true,            // adapter is called on every change
    detectSessionInUrl: false,       // main is not a browser; no window.location
    flowType: 'pkce',                // RFC 7636/8252; required for plan 05 loopback OAuth
  },
});
```

Five auth options exactly — no extras, no spread.

## Contract Plan 02 Must Implement

`sessionStore.ts` (plan 02) exports an object satisfying this exact shape:

```typescript
interface StorageAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}
```

Each method is `async` (returns a Promise). The Supabase JS internals `await` all three. `getItem` returns `null` when the key is absent — not `undefined`, not a rejected promise.

## Bootstrap Ordering Plan 03 Must Respect

Plan 03's main-process bootstrap MUST:

1. Import `setStorageAdapter` from `./auth/supabaseClient`
2. Import the storage adapter from plan 02's `sessionStore`
3. Call `setStorageAdapter(sessionStoreAdapter)` BEFORE registering any auth IPC handler and BEFORE any code path that could call `getClient()`

If plan 03 calls `getClient()` before `setStorageAdapter()` it will throw `SUPABASE_NO_STORAGE_ADAPTER` — by design, this surfaces the ordering bug immediately rather than silently writing to a broken in-memory localStorage fallback.

If plan 03 calls `setStorageAdapter()` twice (or after `getClient()` has already created the client), it throws `SUPABASE_CLIENT_ALREADY_CREATED` — re-wiring storage mid-flight would orphan the in-memory session.

## Decisions Made
- **Lazy singleton.** `getClient()` only creates the client on first call so test harnesses that import `apiKeyStore.ts` or other main-process modules transitively don't trip the env-var check.
- **Ordering gate as a thrown error, not a console.warn.** Silent fallbacks to in-memory localStorage would cause sessions to vanish on restart — far worse than a startup crash with a clear named error.
- **vitest as the test framework.** Project had no test framework configured (one `node:test` mjs file existed). Chose vitest because: (a) excellent `vi.mock` ergonomics for the env + @supabase mocks the plan required, (b) ESM-native to match `"type": "module"`, (c) Vite-aligned with electron-vite already in the stack.
- **ImportMeta augmentation inline in env.ts.** Could have used a separate `src/main/vite-env.d.ts` but keeping the type fiction co-located with the only file that reads `import.meta.env.SUPABASE_*` is easier to reason about.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added `!.env.example` negation to .gitignore**
- **Found during:** Task 1
- **Issue:** Existing `.gitignore` had `.env.*` which matched `.env.example`, so the template the plan requires us to commit was being ignored. `git check-ignore -v .env.example` returned `.gitignore:6:.env.*	.env.example`.
- **Fix:** Added `!.env.example` after the `.env.*` line. `git check-ignore .env` still returns exit 0 (ignored), `git check-ignore .env.example` now returns exit 1 (not ignored).
- **Files modified:** `.gitignore`
- **Verification:** `git check-ignore .env; echo $?` → 0. `git check-ignore .env.example; echo $?` → 1.
- **Committed in:** `49b2022` (Task 1 commit)

**2. [Rule 3 - Blocking] Augmented ImportMeta type for `import.meta.env.SUPABASE_URL`**
- **Found during:** Task 1
- **Issue:** Initial `tsc --noEmit -p tsconfig.node.json` failed with `TS2339: Property 'env' does not exist on type 'ImportMeta'.` (twice). The project's tsconfig.node.json does not pull in any vite-env.d.ts, so `import.meta.env` was untyped in the main bundle.
- **Fix:** Added `declare global { interface ImportMeta { readonly env: { readonly SUPABASE_URL?: string; readonly SUPABASE_ANON_KEY?: string; }; }; }` directly in `src/main/env.ts`. Keeps the type fiction co-located with the only file that reads it.
- **Files modified:** `src/main/env.ts`
- **Verification:** `npx tsc --noEmit -p tsconfig.node.json` and `npx tsc --noEmit` both exit 0.
- **Committed in:** `49b2022` (Task 1 commit)

**3. [Rule 3 - Blocking] Installed vitest as devDependency**
- **Found during:** Task 2 (TDD setup)
- **Issue:** Plan instructed to write vitest tests, but no test framework was installed. `node_modules/vitest` was absent; `package.json` had no `test` script and no test framework.
- **Fix:** `npm install --save-dev vitest` → pinned `vitest@^4.1.6`.
- **Files modified:** `package.json`, `package-lock.json`
- **Verification:** `npx vitest run src/main/auth/supabaseClient.test.ts` → 3 passed.
- **Committed in:** `008e07a` (Task 2 RED commit)

**4. [Rule 2 - Missing Critical] Doc-comment scrubbing to satisfy `grep -c == 1` acceptance criteria**
- **Found during:** Task 2 verification
- **Issue:** First draft of `supabaseClient.ts` had doc-comment lines duplicating the literal strings `flowType: 'pkce'`, `detectSessionInUrl: false`, `autoRefreshToken: true`, `persistSession: true`, and `SUPABASE_CLIENT_ALREADY_CREATED`. The plan acceptance criteria assert `grep -c == 1` for each, which the doc duplicates violated.
- **Fix:** Rewrote doc comments to describe the config in prose ("PKCE flow (RFC 8252)", "URL-based session detection disabled") so the literal strings appear exactly once each — in the actual config block.
- **Files modified:** `src/main/auth/supabaseClient.ts`
- **Verification:** All `grep -c` acceptance counts return 1.
- **Committed in:** `28a383b` (Task 2 GREEN commit)

---

**Total deviations:** 4 auto-fixed (3 blocking, 1 critical-missing). All necessary for the plan to land cleanly — no scope creep. The two TS/typing fixes (1, 2) and the vitest install (3) were unblockers the plan implicitly required. The doc-comment scrub (4) was the only stylistic adjustment.

**Impact on plan:** All four auto-fixes were strictly necessary. No new features added, no scope expanded. The vitest addition is a new dev-time tool with broad downstream value (future Phase 10 plans can write tests).

## Issues Encountered
- npm install surfaced 4 high-severity vulnerabilities in transitive deps after adding `@supabase/supabase-js`. Not fixing in this plan — out of scope. Recorded in deferred-items but no `deferred-items.md` exists yet; noting here for the verifier.

## User Setup Required

Plan 10-01 frontmatter declared `user_setup` for Supabase:
- Create a free-tier Supabase project at https://app.supabase.com/projects
- Copy `Project URL` → `.env` as `SUPABASE_URL=`
- Copy `anon/public` API key → `.env` as `SUPABASE_ANON_KEY=`
- Enable Google provider under Authentication → Providers (paste Google OAuth client_id/secret from plan 10-05's separate setup)

These steps are documented in the project's `.env.example` and will be aggregated into the Phase 10 USER-SETUP.md by the orchestrator. The code paths added here will throw `SUPABASE_ENV_MISSING` until the env is populated — by design, not a bug.

## Next Phase Readiness
- `getClient()` and `setStorageAdapter()` are ready for plan 10-02 (sessionStore) to wire in the safeStorage-backed adapter
- The `StorageAdapter` interface is the exact contract plan 02 must satisfy (three async methods, `getItem` returns `null` not `undefined`)
- Plan 03 bootstrap order is enforced by the named-error gates — no silent fallbacks
- Renderer / preload / utility code paths have zero Supabase imports (verified by grep); plan 03's IPC layer is the only bridge

## Self-Check: PASSED

Verified the following exist:

- `src/main/env.ts` — FOUND
- `src/main/auth/supabaseClient.ts` — FOUND
- `src/main/auth/supabaseClient.test.ts` — FOUND
- `.env.example` — FOUND
- `electron.vite.config.ts` main.define block with both SUPABASE_* keys — FOUND
- `package.json` lists `@supabase/supabase-js@^2.106.0` and `vitest@^4.1.6` — FOUND
- Commits `49b2022`, `008e07a`, `28a383b` exist in `git log` — FOUND

All 3 vitest tests pass; `npx tsc --noEmit` exits 0; no Supabase imports in renderer/preload/utility (grep returned 0); `git check-ignore .env` returns 0; `git check-ignore .env.example` returns 1; `node -e "require('@supabase/supabase-js')"` resolves.

---
*Phase: 10-auth-foundation, Plan: 01*
*Completed: 2026-05-19*
