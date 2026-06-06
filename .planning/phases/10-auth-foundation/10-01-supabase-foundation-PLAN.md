---
phase: 10
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - package.json
  - package-lock.json
  - .env.example
  - electron.vite.config.ts
  - src/main/auth/supabaseClient.ts
  - src/main/env.ts
autonomous: true
requirements: [AUTH-01, AUTH-02, AUTH-03]
requirements_addressed: [AUTH-01, AUTH-02, AUTH-03]
tags: [supabase, auth, electron, env]
user_setup:
  - service: supabase
    why: "Hosted Postgres + Auth + Storage for the entire v1.0 cloud stack — created here, reused by Phases 11–13."
    env_vars:
      - name: SUPABASE_URL
        source: "Supabase dashboard → Project Settings → API → Project URL"
      - name: SUPABASE_ANON_KEY
        source: "Supabase dashboard → Project Settings → API → Project API keys → anon/public"
    dashboard_config:
      - task: "Create a free-tier project in supabase.com (region nearest you; pause-after-1-week is acceptable in dev)."
        location: "https://app.supabase.com/projects"
      - task: "Enable the Google provider under Authentication → Providers (paste Google OAuth client_id + secret from the Google Cloud Console setup in plan 05)."
        location: "Supabase dashboard → Authentication → Providers → Google"
must_haves:
  truths:
    - "@supabase/supabase-js@^2.106.0 is a direct dependency of the desktop app (AUTH-01, AUTH-02 enabling)"
    - "Main-process code can call getClient() and receive a SupabaseClient instance configured with flowType:'pkce' and detectSessionInUrl:false (D-13 supabaseClient pattern; AUTH-03 enabling)"
    - "SUPABASE_URL and SUPABASE_ANON_KEY are injected at build time via electron-vite define so they reach the compiled main bundle"
    - "Renderer and utilityProcess never import @supabase/supabase-js (architectural responsibility map; project invariant: main owns Supabase)"
    - "getClient() is lazy — the Supabase client is NOT instantiated until first call (so test harnesses without env vars don't crash on module import)"
  artifacts:
    - path: "src/main/auth/supabaseClient.ts"
      provides: "getClient() singleton returning a configured SupabaseClient; storage adapter shape stubbed and re-exported for plan 02 to wire"
      exports: ["getClient", "type StorageAdapter"]
    - path: "src/main/env.ts"
      provides: "Compile-time injected SUPABASE_URL and SUPABASE_ANON_KEY constants; throws a clear error at first access if either is empty"
      exports: ["SUPABASE_URL", "SUPABASE_ANON_KEY"]
    - path: ".env.example"
      provides: "Documented env var template for new contributors"
      contains: "SUPABASE_URL=\nSUPABASE_ANON_KEY="
    - path: "package.json"
      provides: "@supabase/supabase-js dependency pin"
      contains: "@supabase/supabase-js"
  key_links:
    - from: "src/main/auth/supabaseClient.ts"
      to: "src/main/env.ts"
      via: "import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../env'"
      pattern: "from ['\"].\\./env['\"]"
    - from: "electron.vite.config.ts"
      to: "src/main/env.ts"
      via: "define block injects process.env.SUPABASE_URL / SUPABASE_ANON_KEY into the main bundle"
      pattern: "define"
---

<objective>
Add the Supabase JS client as a project dependency, wire the SUPABASE_URL + SUPABASE_ANON_KEY env vars through electron-vite's `define` plumbing so they land in the compiled main bundle, and create the lazy-init `getClient()` singleton in `src/main/auth/supabaseClient.ts`. The storage adapter slot is left as a typed shape that plan 02 will fill with the `safeStorage`-backed implementation.

Purpose: Establish the Supabase foundation that every subsequent Phase 10 plan (and Phases 11–13) depends on. No UI, no IPC — just the typed main-process surface that says "Supabase lives here."

Output:
  - `@supabase/supabase-js` in package.json
  - `src/main/auth/supabaseClient.ts` exporting `getClient()` and a `StorageAdapter` interface
  - `src/main/env.ts` exposing compile-time-injected constants
  - `electron.vite.config.ts` extended with `define` for the two env vars
  - `.env.example` template committed
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
@.planning/research/STACK.md
@.planning/research/PITFALLS.md
@CLAUDE.md
@src/main/apiKeyStore.ts

<interfaces>
<!-- Supabase client storage adapter contract (Supabase calls these to persist its session).
     Plan 02's sessionStore.ts will implement these against safeStorage. -->

The Supabase JS storage adapter interface (from @supabase/supabase-js types):
```typescript
interface StorageAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}
```

Existing electron-vite config shape (electron.vite.config.ts) — extend the `main.define` block:
```typescript
// electron-vite uses `define` exactly like Vite — string values must be JSON-stringified.
export default defineConfig({
  main: {
    plugins: [...],
    define: {
      'import.meta.env.SUPABASE_URL': JSON.stringify(process.env.SUPABASE_URL ?? ''),
      // etc.
    },
  },
});
```
</interfaces>
</context>

<read_first>
- `src/main/apiKeyStore.ts` — existing main-only module pattern (lazy import, error-class throw convention)
- `src/main/paths.ts` — canonical paths module (plan 02 extends it; plan 01 needs to know it exists)
- `electron.vite.config.ts` — current Vite config so the new `define` block can be added in the correct location
- `package.json` — verify `@supabase/supabase-js` is NOT already present; verify Node engine pins
- `.planning/phases/10-auth-foundation/10-RESEARCH.md` §Standard Stack + §Pattern 1 (Supabase client with safeStorage adapter)
- `.planning/phases/10-auth-foundation/10-CONTEXT.md` `<code_context>` "Established Patterns" (main owns Supabase; never renderer/utilityProcess)
</read_first>

<tasks>

<task type="auto" tdd="false">
  <name>Task 1: Install @supabase/supabase-js and wire env injection</name>
  <files>package.json, package-lock.json, .env.example, electron.vite.config.ts, src/main/env.ts</files>
  <read_first>
    - package.json (verify current deps; confirm @supabase/supabase-js absent)
    - electron.vite.config.ts (locate main section's plugins/define block)
    - .gitignore (verify .env is ignored — if not, add it in this task)
  </read_first>
  <behavior>
    - npm view @supabase/supabase-js version returns >= 2.106.0 (skip the install if below this floor and surface a clear error — research date was 2026-05-19, verify still current).
    - After install: import { createClient } from '@supabase/supabase-js' resolves with no module-resolution errors in src/main/env.ts type-checking pass (tsc --noEmit).
    - SUPABASE_URL and SUPABASE_ANON_KEY constants exported from src/main/env.ts; first access throws Error('SUPABASE_ENV_MISSING: SUPABASE_URL must be set at build time') when value is empty string.
    - .env.example exists and lists exactly two keys (SUPABASE_URL, SUPABASE_ANON_KEY) with empty values and a single comment line explaining where to get them from.
    - electron.vite.config.ts main.define block defines BOTH 'import.meta.env.SUPABASE_URL' and 'import.meta.env.SUPABASE_ANON_KEY' as JSON.stringify(process.env.<NAME> ?? '').
  </behavior>
  <action>
1. Run `npm view @supabase/supabase-js version` — confirm result is >= 2.106.0. If lower, abort with a clear error.
2. Run `npm install @supabase/supabase-js` (no version pin in the command — package.json should record `^2.106.0` or current; verify it does after install).
3. Verify `.gitignore` ignores `.env` and `.env.local`. If either is missing, add them.
4. Create `.env.example` with exactly this content:
   ```
   # Phase 10 (Auth Foundation) — Supabase credentials.
   # Get these from your Supabase dashboard → Project Settings → API.
   # SUPABASE_ANON_KEY is safe to commit to .env (it's the public anon key;
   # RLS is the actual security boundary).
   SUPABASE_URL=
   SUPABASE_ANON_KEY=
   ```
5. Create `src/main/env.ts`:
   ```typescript
   /**
    * Build-time-injected env vars.
    *
    * Wiring: electron.vite.config.ts main.define replaces `import.meta.env.SUPABASE_URL`
    * (and SUPABASE_ANON_KEY) with the JSON-stringified value of process.env.<NAME> at
    * BUILD time. Dev runs `electron-vite dev` which reads from .env automatically.
    *
    * If you see SUPABASE_ENV_MISSING at boot, your .env is missing or the build
    * was produced without the env vars set. See .env.example.
    *
    * Source: 10-01-PLAN, RESEARCH §Standard Stack, CONTEXT D-13 (safeStorage pattern reuse).
    */
   const URL_RAW = import.meta.env.SUPABASE_URL as string | undefined;
   const ANON_RAW = import.meta.env.SUPABASE_ANON_KEY as string | undefined;

   function requireEnv(name: string, value: string | undefined): string {
     if (!value || value.length === 0) {
       throw new Error(`SUPABASE_ENV_MISSING: ${name} must be set at build time (see .env.example)`);
     }
     return value;
   }

   // Lazy getters so module import doesn't crash when env is missing in test envs
   // that never call into Supabase.
   export function getSupabaseUrl(): string {
     return requireEnv('SUPABASE_URL', URL_RAW);
   }
   export function getSupabaseAnonKey(): string {
     return requireEnv('SUPABASE_ANON_KEY', ANON_RAW);
   }
   ```
6. Edit `electron.vite.config.ts`. Locate the `main` section. Add (or extend) its `define` block:
   ```typescript
   main: {
     // ... existing plugins, build config, etc. unchanged ...
     define: {
       // ... preserve any existing defines ...
       'import.meta.env.SUPABASE_URL': JSON.stringify(process.env.SUPABASE_URL ?? ''),
       'import.meta.env.SUPABASE_ANON_KEY': JSON.stringify(process.env.SUPABASE_ANON_KEY ?? ''),
     },
   },
   ```
   If the `main` section currently has no `define`, add it.
  </action>
  <verify>
    <automated>npm view @supabase/supabase-js version && grep -q '@supabase/supabase-js' package.json && grep -q 'SUPABASE_URL=' .env.example && grep -q 'SUPABASE_ANON_KEY=' .env.example && grep -q "import.meta.env.SUPABASE_URL" electron.vite.config.ts && grep -q "import.meta.env.SUPABASE_ANON_KEY" electron.vite.config.ts && grep -q "SUPABASE_ENV_MISSING" src/main/env.ts && npx tsc --noEmit -p tsconfig.node.json 2>&1 | tee /tmp/tsc-env.log | grep -E "(error TS|src/main/env.ts)" || true; test ! -s /tmp/tsc-env.log || ! grep -q "error TS" /tmp/tsc-env.log</automated>
  </verify>
  <acceptance_criteria>
    - `grep -c '@supabase/supabase-js' package.json` returns >= 1
    - `node -e "console.log(require('@supabase/supabase-js').createClient)"` prints a function (not undefined)
    - `grep -F '"^2.10' package.json | grep '@supabase/supabase-js'` OR `grep -F '"@supabase/supabase-js": "^2.' package.json` — version is at least ^2.106.0
    - `grep -c 'SUPABASE_URL=' .env.example` equals 1
    - `grep -c 'SUPABASE_ANON_KEY=' .env.example` equals 1
    - `.env.example` is committed (not gitignored) and `.env` IS gitignored — run `git check-ignore -v .env .env.example` and confirm only `.env` is matched
    - `grep -c "import.meta.env.SUPABASE_URL" electron.vite.config.ts` equals 1
    - `grep -c "import.meta.env.SUPABASE_ANON_KEY" electron.vite.config.ts` equals 1
    - `grep -c "export function getSupabaseUrl" src/main/env.ts` equals 1
    - `grep -c "export function getSupabaseAnonKey" src/main/env.ts` equals 1
    - `grep -c "SUPABASE_ENV_MISSING" src/main/env.ts` equals 1
    - `npx tsc --noEmit` exits 0 (no new TS errors introduced; pre-existing baseline preserved)
  </acceptance_criteria>
  <done>
    Supabase client installed, env injection wired via electron-vite define, env.ts exports lazy getters that throw a clear named error if values were not provided at build time.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Create supabaseClient.ts with lazy getClient() singleton and StorageAdapter type</name>
  <files>src/main/auth/supabaseClient.ts</files>
  <read_first>
    - src/main/env.ts (just created — must import from here)
    - src/main/apiKeyStore.ts (existing main-only module pattern: lazy import, throw named errors)
    - .planning/phases/10-auth-foundation/10-RESEARCH.md §Pattern 1 (full code template for Supabase client with safeStorage adapter)
    - .planning/phases/10-auth-foundation/10-CONTEXT.md `<code_context>` "Established Patterns" — main is the sole Supabase owner
  </read_first>
  <behavior>
    - getClient() returns the same SupabaseClient instance on every call (singleton).
    - getClient() with `setStorageAdapter(adapter)` previously called wires the provided adapter into createClient's auth.storage option.
    - Calling getClient() without first calling setStorageAdapter throws a named error SUPABASE_NO_STORAGE_ADAPTER (so plan 03's ordering bug — bootstrapping Supabase before wiring sessionStore — surfaces immediately rather than silently writing to a broken in-memory localStorage fallback).
    - Auth options on the created client: { storage: <provided adapter>, autoRefreshToken: true, persistSession: true, detectSessionInUrl: false, flowType: 'pkce' } — these exact five keys, no others, no spread.
    - StorageAdapter interface is exported with the three methods (getItem, setItem, removeItem) matching Supabase JS's expected shape.
  </behavior>
  <action>
Create `src/main/auth/supabaseClient.ts`:

```typescript
/**
 * Supabase client singleton — main-process only.
 *
 * SECURITY: This module is main-process only. The renderer NEVER imports
 * from here. utilityProcess receives only the access-token JWT over
 * MessagePortMain (plan 06), never the SupabaseClient itself, never the
 * refresh token.
 *
 * Wiring:
 *   - Plan 01 (this file) creates the singleton + adapter slot.
 *   - Plan 02 (sessionStore.ts) implements StorageAdapter against safeStorage.
 *   - Plan 03 (bootstrap) calls setStorageAdapter(sessionStoreAdapter) BEFORE
 *     the first getClient() call.
 *
 * Sources:
 *   - 10-RESEARCH §Pattern 1 (Supabase client with safeStorage adapter)
 *   - 10-CONTEXT D-13 (clone apiKeyStore.ts pattern)
 *   - Supabase docs: https://supabase.com/docs/reference/javascript/initializing
 *   - PKCE flow: https://supabase.com/docs/guides/auth/sessions/pkce-flow
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseUrl, getSupabaseAnonKey } from '../env';

/**
 * Storage adapter shape Supabase JS expects for session persistence.
 * Plan 02 implements this against Electron safeStorage in sessionStore.ts.
 */
export interface StorageAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

let client: SupabaseClient | null = null;
let storageAdapter: StorageAdapter | null = null;

/**
 * Wire the safeStorage-backed storage adapter into the Supabase client.
 * Must be called BEFORE the first getClient() call. Plan 03 calls this
 * during bootstrap, before any auth IPC handler is registered.
 *
 * If called after getClient() has already instantiated the singleton,
 * throws SUPABASE_CLIENT_ALREADY_CREATED — re-wiring storage mid-flight
 * would orphan the in-memory session.
 */
export function setStorageAdapter(adapter: StorageAdapter): void {
  if (client !== null) {
    throw new Error('SUPABASE_CLIENT_ALREADY_CREATED: setStorageAdapter must be called before getClient()');
  }
  storageAdapter = adapter;
}

/**
 * Return the singleton SupabaseClient. Lazy — instantiates on first call so
 * test harnesses that import auth modules but never call into Supabase don't
 * trip the env-var check in env.ts.
 *
 * Configuration is locked:
 *   - storage: the adapter wired by setStorageAdapter (REQUIRED — throws if missing)
 *   - autoRefreshToken: true (Supabase rotates JWT 5 min before expiry)
 *   - persistSession: true (storage adapter is called on every change)
 *   - detectSessionInUrl: false (main process is not a browser; window.location does not exist)
 *   - flowType: 'pkce' (RFC 8252; required for the loopback OAuth flow in plan 05)
 *
 * Source: RESEARCH §Pattern 1 — exact config block; do not edit without a
 * cross-referenced research update.
 */
export function getClient(): SupabaseClient {
  if (client !== null) return client;
  if (storageAdapter === null) {
    throw new Error('SUPABASE_NO_STORAGE_ADAPTER: setStorageAdapter must be called before getClient()');
  }
  client = createClient(getSupabaseUrl(), getSupabaseAnonKey(), {
    auth: {
      storage: storageAdapter,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
      flowType: 'pkce',
    },
  });
  return client;
}

/** TEST-ONLY: reset the singleton so each test starts clean. Production code must not call. */
export function _resetForTests(): void {
  client = null;
  storageAdapter = null;
}
```

Also create `src/main/auth/supabaseClient.test.ts` with three small tests:
  1. `getClient()` before `setStorageAdapter()` throws `SUPABASE_NO_STORAGE_ADAPTER`.
  2. After `setStorageAdapter(stubAdapter)`, two `getClient()` calls return the same instance.
  3. `setStorageAdapter()` after `getClient()` throws `SUPABASE_CLIENT_ALREADY_CREATED`.

Use vitest (the project's existing test runner — check package.json for the test command). Stub env.ts with vi.mock so the test does not require real Supabase credentials.
  </action>
  <verify>
    <automated>grep -c "export function getClient" src/main/auth/supabaseClient.ts | grep -q "^1$" && grep -c "export function setStorageAdapter" src/main/auth/supabaseClient.ts | grep -q "^1$" && grep -c "export interface StorageAdapter" src/main/auth/supabaseClient.ts | grep -q "^1$" && grep -c "flowType: 'pkce'" src/main/auth/supabaseClient.ts | grep -q "^1$" && grep -c "detectSessionInUrl: false" src/main/auth/supabaseClient.ts | grep -q "^1$" && grep -c "SUPABASE_NO_STORAGE_ADAPTER" src/main/auth/supabaseClient.ts | grep -q "^1$" && npx vitest run src/main/auth/supabaseClient.test.ts 2>&1 | grep -E "(✓|PASS)"</automated>
  </verify>
  <acceptance_criteria>
    - `grep -c 'export function getClient' src/main/auth/supabaseClient.ts` equals 1
    - `grep -c 'export function setStorageAdapter' src/main/auth/supabaseClient.ts` equals 1
    - `grep -c 'export interface StorageAdapter' src/main/auth/supabaseClient.ts` equals 1
    - `grep -c "flowType: 'pkce'" src/main/auth/supabaseClient.ts` equals 1
    - `grep -c 'detectSessionInUrl: false' src/main/auth/supabaseClient.ts` equals 1
    - `grep -c 'autoRefreshToken: true' src/main/auth/supabaseClient.ts` equals 1
    - `grep -c 'persistSession: true' src/main/auth/supabaseClient.ts` equals 1
    - `grep -c 'SUPABASE_NO_STORAGE_ADAPTER' src/main/auth/supabaseClient.ts` equals 1
    - `grep -c 'SUPABASE_CLIENT_ALREADY_CREATED' src/main/auth/supabaseClient.ts` equals 1
    - `npx vitest run src/main/auth/supabaseClient.test.ts` exits 0 with 3 passing tests
    - `grep -rn "from '@supabase/supabase-js'" src/renderer src/preload src/utility 2>/dev/null | grep -v node_modules | wc -l` returns 0 (renderer / preload / utility do NOT import Supabase)
    - `npx tsc --noEmit` exits 0
  </acceptance_criteria>
  <done>
    supabaseClient.ts exports getClient() and setStorageAdapter() with the locked auth config block; calling getClient() without an adapter throws a named error; the renderer, preload, and utilityProcess do not import @supabase/supabase-js.
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Build env → packaged binary | SUPABASE_URL + SUPABASE_ANON_KEY are baked into the binary at build time. ANON key is public-by-design (RLS is the security boundary), but URL leaks identify the project — acceptable. |
| Main process ↔ renderer | Renderer NEVER imports @supabase/supabase-js. All Supabase access goes through IPC channels added in plan 03. |
| Main process ↔ utilityProcess | utilityProcess NEVER imports @supabase/supabase-js. JWT-only crosses via MessagePortMain in plan 06. |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-10-01-01 | Information Disclosure | SUPABASE_ANON_KEY in binary | accept | Anon key is public-by-design; RLS in Postgres is the actual security gate. Documented in .env.example comment ("safe to commit"). |
| T-10-01-02 | Tampering | Renderer importing @supabase/supabase-js to bypass IPC | mitigate | `grep -rn "from '@supabase/supabase-js'" src/renderer src/preload src/utility` MUST return 0 — enforced by acceptance criterion in Task 2. Code review gate; add a lint rule in a future hardening pass. |
| T-10-01-03 | Elevation of Privilege | SUPABASE_SERVICE_ROLE_KEY accidentally added to .env.example | mitigate | .env.example lists ONLY two keys (URL + ANON_KEY). Service role key lives ONLY in Supabase Edge Function env vars (plan 08). Acceptance criterion grep-counts each. |
| T-10-01-04 | Spoofing | flowType set to something other than 'pkce' (e.g., 'implicit') | mitigate | Acceptance criterion grep-asserts `flowType: 'pkce'` is present exactly once. PKCE protects the OAuth code exchange (RFC 7636). |
| T-10-01-05 | Tampering | detectSessionInUrl:true on main (reads window.location which is undefined) | mitigate | Acceptance criterion grep-asserts `detectSessionInUrl: false` is present exactly once. |
| T-10-01-06 | Information Disclosure | .env committed to git accidentally | mitigate | Task 1 verifies `git check-ignore -v .env` matches; `.env.example` is the only committed file. |
</threat_model>

<verification>
1. `npx vitest run src/main/auth/supabaseClient.test.ts` — all 3 tests pass.
2. `npx tsc --noEmit` exits 0 (no new TS errors).
3. `git check-ignore -v .env` matches (`.env` ignored).
4. `grep -rn "from '@supabase/supabase-js'" src/renderer src/preload src/utility 2>/dev/null | wc -l` returns 0.
5. `node -e "require('@supabase/supabase-js')"` exits 0.
</verification>

<success_criteria>
- `@supabase/supabase-js@^2.106.0` is in dependencies (not devDependencies)
- `.env.example` exists with exactly the two SUPABASE_* keys
- `electron.vite.config.ts` injects both env vars via main.define
- `src/main/env.ts` exports `getSupabaseUrl` / `getSupabaseAnonKey` that throw SUPABASE_ENV_MISSING when value is empty
- `src/main/auth/supabaseClient.ts` exports `getClient`, `setStorageAdapter`, `StorageAdapter` with the locked auth config block
- Renderer, preload, and utilityProcess source dirs contain ZERO imports of @supabase/supabase-js
- 3 unit tests pass for supabaseClient.ts
- `npx tsc --noEmit` exits 0
</success_criteria>

<output>
After completion, create `.planning/phases/10-auth-foundation/10-01-SUMMARY.md` covering: what was created, the locked auth config block (so plan 02/03 can reuse the same exact values), the storage adapter contract plan 02 must implement, and the bootstrap ordering plan 03 must respect (setStorageAdapter before getClient).
</output>
