---
phase: 10-auth-foundation
reviewed: 2026-05-20T00:00:00Z
depth: standard
files_reviewed: 48
files_reviewed_list:
  - .env.example
  - .gitignore
  - electron.vite.config.ts
  - package.json
  - src/main/auth/authHandlers.test.ts
  - src/main/auth/authHandlers.ts
  - src/main/auth/authState.ts
  - src/main/auth/edgeFunctionClient.test.ts
  - src/main/auth/edgeFunctionClient.ts
  - src/main/auth/exportBuilder.test.ts
  - src/main/auth/exportBuilder.ts
  - src/main/auth/jwtBridge.test.ts
  - src/main/auth/jwtBridge.ts
  - src/main/auth/loopbackCallback.ts
  - src/main/auth/loopbackPkce.test.ts
  - src/main/auth/loopbackPkce.ts
  - src/main/auth/sessionStore.test.ts
  - src/main/auth/sessionStore.ts
  - src/main/auth/supabaseClient.test.ts
  - src/main/auth/supabaseClient.ts
  - src/main/botSupervisor.ts
  - src/main/env.ts
  - src/main/index.ts
  - src/main/ipc.ts
  - src/main/paths.ts
  - src/preload/index.ts
  - src/renderer/src/App.tsx
  - src/renderer/src/components/DeleteAccountModal.module.css
  - src/renderer/src/components/DeleteAccountModal.tsx
  - src/renderer/src/components/OAuthInterstitialModal.module.css
  - src/renderer/src/components/OAuthInterstitialModal.tsx
  - src/renderer/src/components/SignInModal.module.css
  - src/renderer/src/components/SignInModal.tsx
  - src/renderer/src/components/SignOutConfirmModal.module.css
  - src/renderer/src/components/SignOutConfirmModal.tsx
  - src/renderer/src/lib/stores/useAuthStore.ts
  - src/renderer/src/lib/stores/useUiStore.ts
  - src/renderer/src/screens/AuthChoiceScreen.module.css
  - src/renderer/src/screens/AuthChoiceScreen.tsx
  - src/renderer/src/screens/OnboardingScreen.tsx
  - src/renderer/src/screens/SettingsScreen.module.css
  - src/renderer/src/screens/SettingsScreen.tsx
  - src/shared/characterSchema.ts
  - src/shared/ipc.ts
  - supabase/config.toml
  - supabase/functions/_shared/cors.ts
  - supabase/functions/delete-me/deno.json
  - supabase/functions/delete-me/index.ts
  - supabase/migrations/20260520000000_deletion_queue.sql
  - vitest.config.ts
findings:
  blocker: 6
  warning: 11
  total: 17
status: issues_found
---

# Phase 10: Code Review Report

**Reviewed:** 2026-05-20
**Depth:** standard
**Files Reviewed:** 48
**Status:** issues_found

## Summary

Phase 10 lands Supabase auth, loopback PKCE, JWT bridging, GDPR delete, and data
export across main, preload, renderer, and one Edge Function. All seven of the
design-time threat-model gates pass clean (verified via the greps you ran in the
prompt: T-10-05-04 BrowserWindow=0, T-10-05-05 0.0.0.0=0, T-10-06-01
refresh_token=0, T-10-08-01 SERVICE_ROLE_KEY=0 under src/, T-10-04 signup-error
neutralization, T-10-06-09 stop-before-signOut ordering, D-14 export schema).

The defects below are NOT in the threat-model gates — they're in the *seams
between subsystems*: lifecycle ordering of subscriptions, fire-and-forget
async init, multi-step destructive operations that aren't transactional, and a
few places where `Promise.race` leaks unhandled rejections from the losers.
The highest-impact finding is BL-06 (delete-me has no resumability between
queue-insert and admin.deleteUser — a function-process crash silently
breaks the GDPR contract). The next highest is BL-01 (setSupervisor is
fire-and-forget at IPC registration — a sufficiently fast post-boot signOut
will skip the bot-stop step that D-09 + T-10-06-09 promise).

Threat-model gates verified clean (no findings under these IDs):

- T-10-04 — signup enumeration: `classifySignUpError` and the two
  `signUpWithPassword` branches both collapse already-registered to
  `{ ok: true, requiresVerification: true }`. Confirmed in handler + tests.
- T-10-05-04, T-10-05-05 — loopback PKCE does not import BrowserWindow and
  binds 127.0.0.1 only (literal-string assertion).
- T-10-06-01 — `jwtBridge.ts` carries no `refresh_token` reference; only
  `session?.access_token` crosses to the supervisor.
- T-10-06-09 — `signOut` in `authHandlers.ts:336-353` calls
  `supervisorRef.stop()` before `supabase.auth.signOut()` (source-order gate).
- T-10-08-01 — `SUPABASE_SERVICE_ROLE_KEY` exists only at
  `supabase/functions/delete-me/index.ts:43`; nothing under `src/`.
- D-14 — `buildExport()` emits exactly the 5 documented top-level keys and the
  test asserts this.

## Blockers

### BL-01: `setSupervisor` is fire-and-forget — bot-stop ordering (T-10-06-09 / D-09) can be skipped

**File:** `src/main/ipc.ts:308-311`
**Issue:** `registerIpcHandlers` wires the supervisor into the auth-handlers
module via:

```ts
void (async () => {
  const { setSupervisor } = await import('./auth/authHandlers');
  setSupervisor(deps.supervisor);
})();
```

This is fire-and-forget — `registerIpcHandlers` returns synchronously while the
dynamic import is still pending. Every IPC handler under `IpcChannel.auth.*` is
registered immediately (lines 312–345). The window during which `supervisorRef`
in `authHandlers.ts` is still `null` is bounded only by the resolve time of the
dynamic import. If a renderer `signOut` IPC fires inside that window (impossible
in *first-launch* UX since the user must traverse AuthChoice → SignIn → home →
Settings; possible if the app is launched with a persisted session.bin and the
user opens Settings + clicks Sign out faster than the dynamic import resolves),
the bot-stop branch at `authHandlers.ts:339` is skipped entirely:

```ts
if (supervisorRef && supervisorRef.getActiveId() !== null) {
  try { await supervisorRef.stop(); } catch (err) { ... }
}
```

A null `supervisorRef` short-circuits the stop, then `auth.signOut()` revokes
the JWT while the bot is still running — exactly the race D-09 forbids. In
Phase 10 the bot ignores the JWT, but in Phase 13 the cloud-AI proxy will
401-cascade.

**Fix:** Make supervisor wiring synchronous. Either import `authHandlers`
statically at the top of `ipc.ts` and call `setSupervisor` synchronously, or
make `registerIpcHandlers` itself `async` and `await` the wiring before
returning. The dynamic-import-for-deadlock-safety comment on line 300 is
mooted by every per-handler `await import('./auth/authHandlers')` that
follows — the module is already in the import graph by the time the first
real handler resolves.

```ts
// Top of file
import { setSupervisor as setAuthSupervisor } from './auth/authHandlers';

// In registerIpcHandlers, replace the IIFE with:
setAuthSupervisor(deps.supervisor);
```

---

### BL-02: `initAuthState` and `initJwtBridge` leak listeners on re-bootstrap (macOS reopen)

**File:** `src/main/auth/authState.ts:66-93`, `src/main/auth/jwtBridge.ts:30-63`,
`src/main/index.ts:345-349`

**Issue:** `bootstrap()` can run more than once. The `app.on('activate', ...)`
handler at `src/main/index.ts:345-349` calls `bootstrap()` again when all
windows have been closed on macOS and the dock icon is clicked. Each invocation
calls:

```ts
const { initAuthState } = await import('./auth/authState');
await initAuthState(mainWindow);
```

`initAuthState` blindly overwrites `mainWindowRef = window` and registers a
NEW `supabase.auth.onAuthStateChange` subscription (line 78). The PREVIOUS
subscription is never `unsubscribe()`'d — module-level `subscription` is
reassigned without releasing the old one. Same defect in `initJwtBridge`:

```ts
// jwtBridge.ts:30
export async function initJwtBridge(supervisor: BotSupervisor): Promise<void> {
  supervisorRef = supervisor;
  ...
  subscription = sub.subscription;  // old subscription orphaned
```

On every macOS reopen, both files accumulate a new auth-event subscriber. Each
old subscription still fires its callback into the OLD `mainWindowRef` (already
nulled; the broadcast no-ops on `!window || window.isDestroyed()`) AND into the
OLD `supervisorRef` (which is the same `supervisor` reference). Net effect:

1. `broadcastAuthState` runs N times per auth event but most no-op — wasted
   work, but not user-visible.
2. `supervisorRef.updateJwt(...)` in jwtBridge runs N times per event — N
   `postMessage` calls into the same active port. Mostly idempotent for the
   utilityProcess but adds growth-unbounded callback overhead per session.
3. The `did-finish-load` listener at `authState.ts:87` is also attached N
   times — N rebroadcasts per renderer load.

**Fix:** Guard both inits against re-entry, and unsubscribe before re-binding:

```ts
// authState.ts
export async function initAuthState(window: BrowserWindow): Promise<void> {
  subscription?.unsubscribe();  // drop prior subscriber
  subscription = null;
  mainWindowRef = window;
  ...
}

// jwtBridge.ts
export async function initJwtBridge(supervisor: BotSupervisor): Promise<void> {
  subscription?.unsubscribe();
  subscription = null;
  supervisorRef = supervisor;
  ...
}
```

Also consider gating `bootstrap()` itself behind a `bootstrapped` boolean since
nothing else inside it is idempotent (LAN watcher, skin server, etc. would all
double-bind too — that's outside Phase 10 scope but worth flagging).

---

### BL-03: `delete-me` Edge Function has no resumability — process death between insert and `auth.admin.deleteUser` silently breaks GDPR

**File:** `supabase/functions/delete-me/index.ts:55-80`,
`supabase/migrations/20260520000000_deletion_queue.sql:34-43`

**Issue:** The flow is:

1. INSERT row into `deletion_queue` (line 56-61).
2. CALL `adminClient.auth.admin.deleteUser(userId)` (line 70).
3. On step-2 failure, compensating DELETE of the queue row (line 74).
4. Return 204.

There is NO retry, NO transactional bracket, and NO recovery if the function
process dies between step 1 and step 2 (Edge Function timeout, Deno OOM,
upstream Supabase auth flake, network reset, deploy mid-request). After such a
death:

- The queue row is present with `purged_at = NULL`.
- The auth user is NOT deleted.
- The client received NO response and will surface as `{ ok: false, code:
  'network' }` to the user — they think it failed.
- The daily pg_cron job (line 34-43) ONLY sets `purged_at = now()` after
  30 days. It does NOT re-attempt the auth.admin.deleteUser. The user
  remains in `auth.users` forever, with a tombstone in `deletion_queue` that
  paper-trails the request but doesn't fulfill it.

Net result: a Supabase user who clicked "Delete account…" may continue
existing in `auth.users` indefinitely. GDPR Article 17 ("right to erasure") is
silently broken; only manual log-trawling would surface this. The renderer
shows the user `code:'network'` and they likely just try again — succeeding
the second time and creating a SECOND queue row (no uniqueness constraint).

**Fix:** Two layers:

1. Reverse the order. Call `auth.admin.deleteUser(userId)` FIRST; only insert
   the deletion-queue row AFTER successful user deletion. The queue is for
   the 30-day Storage-purge job, not for the auth-user delete itself. If
   step-1 (now: deleteUser) fails, return 500 with no side effects. If step-2
   (queue insert) fails after the user is gone, log + return 500 — the
   30-day Storage purge for THIS user is now an admin-recovery task,
   surfaced via the function logs. (This trades "Storage purge may not run"
   for "auth.users IS clean," which is the GDPR-compliant trade.)

2. Make the cron job retry-on-auth as well. Have the cron worker look up
   whether each queue row's `user_id` still exists in `auth.users`; if so,
   call `auth.admin.deleteUser` (or a paired Edge Function with service_role)
   before marking `purged_at`. That covers the failure path where the queue
   row was inserted but the user wasn't deleted.

The current "compensating delete" on `delErr` (line 74) only handles synchronous
failure of `deleteUser`, not function-process death — so it is insufficient.

---

### BL-04: `App.tsx` `useEffect` does not exit Settings on SIGNED_OUT after delete-account

**File:** `src/renderer/src/App.tsx:247-251`, `src/renderer/src/screens/SettingsScreen.tsx:380-386`

**Issue:** The auth-routing effect handles only the signed-in transition:

```ts
useEffect(() => {
  if (authState.kind === 'signed_in' && (view.kind === 'auth-choice' || view.kind === 'loading')) {
    navigate({ kind: 'home' });
  }
}, [authState, view.kind, navigate]);
```

There is no symmetric `kind === 'local'` branch. On delete-account success,
`authHandlers.deleteAccount` calls `supabase.auth.signOut()`, which fires
SIGNED_OUT → renderer authState flips to `kind:'local'`. `SettingsScreen`
re-renders, the Account section disappears (good), but the user is still
parked on the Settings view with no way back to the home flow EXCEPT the
Back button. Worse, on a signOut-from-Settings flow, the same thing happens:
the user is signed out but stranded on the Settings view, which now hides
the Account panel they were just looking at. The expected UX (per D-09 and
the AUTH-05 framing) is to drop them to AuthChoice OR home (local mode).

**Fix:** Add a downward transition to the same effect:

```ts
useEffect(() => {
  if (authState.kind === 'signed_in' && (view.kind === 'auth-choice' || view.kind === 'loading')) {
    navigate({ kind: 'home' });
  } else if (authState.kind === 'local' && view.kind === 'settings') {
    // Sign-out / delete-account from Settings — drop to AuthChoice.
    navigate({ kind: 'auth-choice' });
  }
}, [authState, view.kind, navigate]);
```

Pick the right target per D-06 — if local mode is the equal-citizen path,
`home` is fine; if AuthChoice is the intended landing on SIGNED_OUT, use it.
Either way the current code lands the user nowhere.

---

### BL-05: `withTimeout` leaks unhandled rejections from the losing Supabase promise

**File:** `src/main/auth/authHandlers.ts:66-78`

**Issue:**

```ts
async function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(onTimeout()), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
```

When the timer wins, `Promise.race` resolves with the fallback. The `p`
promise continues executing in the background. If `p` later rejects (Supabase
returns 500, or fetch throws ECONNRESET), the rejection has no consumer →
Node emits `unhandledRejection`. In production this surfaces as a noisy
warning that DOES NOT carry the email/password (good — those aren't logged)
but DOES carry whatever Supabase chose to put in the message.

For Electron, unhandledRejection in main is not fatal but it IS logged to
stderr where a CI tail can capture it.

**Fix:** Swallow the late rejection of the loser:

```ts
async function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Attach a no-op catch BEFORE the race so a late rejection doesn't bubble.
  p.catch(() => undefined);
  try {
    return await Promise.race([
      p,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(onTimeout()), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
```

This applies to all four call sites: `signInWithPassword`, `signUpWithPassword`,
`exportData` (the `writeFile` path), and `resendVerification`.

---

### BL-06: `deleteAccount` doesn't stop the running bot before signOut

**File:** `src/main/auth/authHandlers.ts:374-404`

**Issue:** `deleteAccount` calls the Edge Function, then on success calls
`supabase.auth.signOut()` — but unlike `signOut()`, it does NOT call
`supervisorRef.stop()` first. The bot will continue running with a now-
deleted user's JWT until its next action (which will 401-cascade in Phase 13)
or until the user manually stops it. D-09 and T-10-06-09 mandate "stop bot
before clearing session" — `deleteAccount` is logically a SUPERSET of
sign-out, so the same invariant applies.

In Phase 10 the bot ignores the JWT so this is observably harmless. In Phase
13 the running bot will start emitting 401s into the chat as soon as its
in-memory JWT becomes invalid.

**Fix:** Refactor the bot-stop into a shared helper used by both `signOut`
and `deleteAccount`:

```ts
async function stopBotIfActive(): Promise<void> {
  if (supervisorRef && supervisorRef.getActiveId() !== null) {
    try {
      await supervisorRef.stop();
    } catch (err) {
      logger.warn(`stopBotIfActive: ${(err as Error).message}`);
    }
  }
}

// In deleteAccount, BEFORE await supabase.auth.signOut():
await stopBotIfActive();
```

Same rationale as the existing `signOut` invariant — confirmed UX has already
shown the user the delete-confirm modal, no re-prompt needed.

---

## Warnings

### WR-01: `loopbackCallback.ts` has dead `pkceHandler` indirection that could route a real OAuth code through the wrong exchange

**File:** `src/main/auth/loopbackCallback.ts:92-99, 190-196`
**Issue:** The fixed-port loopback server includes a `pkceHandler` registration
hook (`setPkceHandler`). No code in the repo calls `setPkceHandler` — Phase 10
Google OAuth lives entirely in `loopbackPkce.ts`, which binds its own ephemeral
port. The dispatcher logic at line 190 is therefore unreachable in practice.

But: `if (state && pkceHandler)` falls through when `state` is set and the
handler is null. The fall-through path reaches the email-verification
exchange (`exchangeCodeForSession(code)`). A future change that drops the
fixed port for Google OAuth (e.g., 8.4 cleanup) would route an OAuth callback
into the verification path with no logging that the wrong exchange ran.

**Fix:** Either (a) implement the PKCE handler when it's needed in Phase 10-05
(it's not, per the code), or (b) delete the indirection now. If kept, harden
the fall-through:

```ts
if (state) {
  if (!pkceHandler) {
    logger.warn(`loopback callback: state=${state.slice(0, 8)}… present but no PKCE handler registered; rejecting`);
    res.statusCode = 400;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(ERROR_HTML);
    return;
  }
  const result = await pkceHandler(req, query);
  ...
}
```

---

### WR-02: `SignUpResult` union includes a `code: 'email_in_use'` variant that is never emitted (dead protocol surface)

**File:** `src/shared/ipc.ts:208-210`, `src/main/auth/authHandlers.ts:233-273`
**Issue:** `SignUpResult` declares:

```ts
export type SignUpResult =
  | { ok: true; requiresVerification: boolean }
  | { ok: false; code: 'email_in_use' | 'weak_password' | 'invalid_email' | 'network'; message: string };
```

`signUpWithPassword` deliberately never returns `'email_in_use'` (per T-10-04 +
UAT fix #4; the two "already-registered" detectors both fold into
`{ ok: true, requiresVerification: true }`). The renderer also can't switch on
it. Leaving the variant in the union risks a future contributor reading
`SignUpResult` and re-introducing the enumeration leak.

**Fix:** Remove the `'email_in_use'` literal from the union and add a comment
pointing to T-10-04. If you want the enum reserved for future use, type it
`never` with an inline justification — but cleaner is removal.

```ts
export type SignUpResult =
  | { ok: true; requiresVerification: boolean }
  // SECURITY: no `email_in_use` variant — T-10-04 (enumeration resistance).
  // Already-registered emails return { ok: true, requiresVerification: true }.
  | { ok: false; code: 'weak_password' | 'invalid_email' | 'network'; message: string };
```

---

### WR-03: `signUpWithPassword` keyword detection of already-registered is fragile

**File:** `src/main/auth/authHandlers.ts:255-260`
**Issue:** The fallback enumeration-neutralization path on `signUp` error:

```ts
const msg = error.message.toLowerCase();
if (msg.includes('already') || msg.includes('registered') || msg.includes('exists')) {
  return { ok: true, requiresVerification: true };
}
```

If Supabase changes the wire message to e.g. `"duplicate key value violates
unique constraint"` (a real Postgres unique-violation message that COULD leak
through if the server adapter changes), none of those keywords match. The
error falls through to `classifySignUpError`, which has no email-in-use branch
either, and returns `{ ok: false, code: 'network' }`. That's still
enumeration-safe (no `email_in_use` code), but it's a side-channel: an attacker
sees "network" for an already-registered email vs. `{ ok: true,
requiresVerification: true }` for a fresh one. Weak signal but observable
under repeated probing.

**Fix:** Treat ALL signup errors after weak-password / invalid-email
classification as the same neutral success shape:

```ts
function classifySignUpError(message: string): SignUpResult {
  const m = message.toLowerCase();
  if (m.includes('password') && ...) return { ok: false, code: 'weak_password', ... };
  if (m.includes('email') && ...)    return { ok: false, code: 'invalid_email', ... };
  // SECURITY (T-10-04): collapse anything else into neutral success so a
  // future Supabase wire-format change can't reopen the enumeration channel.
  return { ok: true, requiresVerification: true };
}
```

Caveat: that means genuine "network" errors during signup return success-
looking shape, which is misleading to the user. Trade-off — pick "weakly
leaky but UX-correct" (status quo) or "UX-misleading but maximally enum-
resistant" (proposed). Document the choice either way.

---

### WR-04: `loopbackCallback.ts` uses `http://localhost:54321` but binds `127.0.0.1` — IPv6 dual-stack hosts can break verification

**File:** `src/main/auth/loopbackCallback.ts:57-60, 139`,
`src/main/auth/authHandlers.ts:194`
**Issue:** The server binds `127.0.0.1` (IPv4). The verification email URL is
`http://localhost:54321/auth/callback`. On hosts where `/etc/hosts` (or
nsswitch) resolves `localhost` to `::1` first (Linux with IPv6, some macOS
configs), the user's browser sends to `[::1]:54321` and gets ECONNREFUSED.
The verification flow appears broken with no diagnostic.

**Fix:** Either bind both stacks (`::1` AND `127.0.0.1`) — Node's `http`
server binds to all interfaces by default with `listen(port)` (no host arg),
but T-10-05-05 forbids 0.0.0.0; the correct fix is dual loopback:

Option A — change the URL to `http://127.0.0.1:54321/auth/callback` (in BOTH
authHandlers.ts and the Supabase dashboard Site URL), so browsers always hit
IPv4. Trade-off: the user sees an IP address in the email body.

Option B — explicitly bind two listeners, one on `127.0.0.1` and one on `::1`,
both routed to the same handleRequest. More code, but cleaner UX.

Document the chosen approach in the deferred-items.md so the Supabase
dashboard config is kept in sync.

---

### WR-05: `sessionStore.readDict` silently nukes the blob on transient decrypt failure

**File:** `src/main/auth/sessionStore.ts:40-55`
**Issue:** Both decrypt failures and JSON-parse failures auto-`unlink` the
session file:

```ts
try {
  raw = safeStorage.decryptString(buf);
} catch {
  try { await unlink(paths.sessionPath()); } catch {}
  return {};
}
```

This is the Pitfall A3 recovery contract — correct for genuine corruption. But
safeStorage can also throw on transient conditions (keychain locked,
gnome-keyring not yet awake on cold boot, kwallet temporarily unavailable).
A user with a temporarily-locked keychain who restarts the app will silently
lose their session. The session blob is GONE — they must sign in again, which
is annoying but acceptable. Worse: the PKCE code-verifier in the same blob is
also gone, so an in-flight email-verification link will fail to exchange.

**Fix:** Distinguish transient from permanent. safeStorage exposes
`isEncryptionAvailable()` — check it before auto-deleting:

```ts
} catch (decryptErr) {
  if (!safeStorage.isEncryptionAvailable()) {
    // Transient — keychain unavailable. DON'T delete; let the user resolve
    // their keyring and try again.
    return {};
  }
  // Permanent corruption — delete and recover.
  try { await unlink(paths.sessionPath()); } catch {}
  return {};
}
```

Also log the error so a user reporting "I keep getting signed out" has a
diagnostic trail.

---

### WR-06: `loopbackPkce.ts` abort-listener leak when codePromise wins

**File:** `src/main/auth/loopbackPkce.ts:125-131, 144-166`
**Issue:**

```ts
const abortPromise = new Promise<never>((_, reject) => {
  if (opts.abortSignal.aborted) {
    reject(new Error('aborted'));
  } else {
    opts.abortSignal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }
});
```

When `codePromise` wins the race (happy path), the `abortSignal` listener is
never removed. The AbortController object lives until `authHandlers.signInWithGoogle`'s
`finally` block clears `oauthController`; the listener is GC'd then. Bounded
leak, not unbounded — but if a future refactor keeps `oauthController` around
longer (e.g. for retry support), the listener becomes a slow leak.

Same for `timeoutPromise` — if `codePromise` wins, the abortPromise never
resolves and just sits attached to `signal`.

**Fix:** Track the listener and remove it on race resolution. Easier — use
AbortSignal's `reason` and check `aborted` inline rather than listening:

```ts
try {
  // No abort listener attached up front — race against a polling check is
  // overkill. Instead, register the listener but capture cleanup.
  const abortListener = () => { /* nothing — checked below */ };
  opts.abortSignal.addEventListener('abort', abortListener);
  try {
    const code = await Promise.race([
      codePromise,
      timeoutPromise,
      new Promise<never>((_, reject) => {
        if (opts.abortSignal.aborted) reject(new Error('aborted'));
        else opts.abortSignal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
    ]);
    ...
  } finally {
    opts.abortSignal.removeEventListener('abort', abortListener);
  }
}
```

Minor — file as a cleanup-pass item, not a release blocker.

---

### WR-07: `loopbackPkce.ts` request handler attaches to `server.on('request', ...)` not `server.once`

**File:** `src/main/auth/loopbackPkce.ts:97-117`
**Issue:** The OAuth callback handler is attached via `server.on('request', ...)`
inside the Promise body. The handler responds to EVERY request — `/callback`
proper AND any incidental request (favicon, browser prefetch, multiple back/
forward navigation). Each `/callback` hit fires `resolve(code)` again; only
the first resolution is kept (Promise semantics), but the handler still writes
the polite "you can close this tab" HTML response every time.

Lower-risk side: a browser that prefetches the URL on hover (some browsers do
this on `<a>` link hover) could consume the OAuth code BEFORE the user clicks
it. Supabase codes are one-shot, so prefetch could break the flow. Modern
browsers generally don't prefetch arbitrary URLs, but if a user has an
aggressive prefetch extension, the flow can fail silently.

**Fix:** Track whether the code has been received and short-circuit subsequent
requests:

```ts
let received = false;
server!.on('request', (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  if (url.pathname !== '/callback') { res.writeHead(404).end('Not Found'); return; }
  if (received) { res.writeHead(200, { 'Content-Type': 'text/plain' }).end('Already handled.'); return; }
  received = true;
  ...
});
```

---

### WR-08: Edge Function `Access-Control-Allow-Origin: '*'` on a destructive endpoint

**File:** `supabase/functions/_shared/cors.ts:5`
**Issue:** `'Access-Control-Allow-Origin': '*'` with `'Access-Control-Allow-Methods': 'POST, OPTIONS'`. The delete-me function is called only from the main process (`callEdgeFunction` in edgeFunctionClient.ts), so CORS is a no-op at the call site — but the `*` advertisement says "any browser-origin can call this." Combined with the JWT requirement, this is still authenticated, but it widens the attack surface: if a future Phase-11+ user ever exposes their JWT to a renderer-side fetch (e.g., a feature that requires direct browser → edge function call), a malicious site could orchestrate a delete-account flow via fetch + the user's leaked JWT.

**Fix:** Scope CORS to the local-dev null origin and known Sei domains; or
drop CORS entirely for endpoints invoked only from main:

```ts
export const corsHeaders = {
  // Sei is a desktop app — no browser-origin should call this directly.
  // Edge Function ALSO verifies the JWT (defense in depth).
  'Access-Control-Allow-Origin': 'null',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
```

Or remove CORS headers entirely (the OPTIONS preflight will fail and the
browser will refuse the call — exactly what's wanted for a native-only API).

---

### WR-09: `deletion_queue` has no uniqueness constraint on `user_id` — repeated delete attempts orphan rows

**File:** `supabase/migrations/20260520000000_deletion_queue.sql:17-24`
**Issue:** The schema:

```sql
create table public.deletion_queue (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  deletion_requested_at timestamptz not null default now(),
  storage_paths jsonb not null default '[]'::jsonb,
  purged_at timestamptz
);
```

There's no unique index on `(user_id) WHERE purged_at IS NULL`. Combined with
BL-03 (retry on network failure), a user who clicks "Delete account" twice
because the first attempt timed out creates TWO pending queue rows. The
30-day Storage purge runs against both; for Phase 10 with empty
`storage_paths` this is just two no-ops, but Phase 11+ where the rows hold
actual paths could create double-purge attempts (no harm, since the second
delete is a no-op on already-gone objects, but it spawns extra cron load).

**Fix:** Add a partial unique constraint:

```sql
create unique index deletion_queue_user_pending_uniq
  on public.deletion_queue (user_id)
  where purged_at is null;
```

Then the Edge Function INSERT uses `on conflict do nothing` and treats a
no-op insert as "already queued, proceed."

---

### WR-10: `DeleteAccountModal` setTimeout(1200ms) for "scheduled for deletion" UI is cut short by SIGNED_OUT

**File:** `src/renderer/src/components/DeleteAccountModal.tsx:60-62`
**Issue:** On `deleteAccount` success:

```ts
setPhase('success');
setTimeout(() => onConfirmed(), 1200);
```

But the main process has already called `supabase.auth.signOut()`. The renderer's
`onAuthState` push fires SIGNED_OUT → `authState.kind === 'local'` → SettingsScreen's
account-panel conditional becomes falsy → the modal is mounted INSIDE the panel
(it's gated by `deleteAccountModalOpen && authState.kind === 'signed_in'` at
SettingsScreen.tsx:380) → it unmounts immediately. The user sees a flash of "Account
scheduled for deletion. Signing you out…" then the modal disappears in ~50–200ms,
nowhere near the intended 1200ms.

If the design intent was a 1200ms confirmation, host the message on the
post-signOut surface (e.g., AuthChoiceScreen) or stop gating the success-phase
on `authState.kind`. If the design intent was "show fleeting confirmation and
move on," the 1200ms is misleading — drop it.

**Fix:** Either (a) keep the modal mounted independent of auth-state during
the success phase:

```tsx
{(deleteAccountModalOpen && (authState.kind === 'signed_in' || phaseStillRunningRef.current)) ? ...}
```

or (b) move the "scheduled for deletion" message to a toast layer that
survives the screen unmount.

---

### WR-11: `signUpWithPassword` may emit `requiresVerification:false` for an actually-already-registered email

**File:** `src/main/auth/authHandlers.ts:262-269`
**Issue:**

```ts
if (data?.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
  return { ok: true, requiresVerification: true };
}
return { ok: true, requiresVerification: data?.session == null };
```

The "identities = []" detector relies on Supabase actually populating
`data.user.identities` on the obfuscated-signup path. If a Supabase change
returns `identities` as `null` or `undefined` instead, `Array.isArray()` is
false, the check is skipped, and we reach the final return — which evaluates
`requiresVerification` from session presence. With email-confirm enabled the
session is null → `requiresVerification:true` (still safe). With email-confirm
DISABLED but the email is already registered, Supabase returns a session
ONLY for genuinely-new emails, so already-registered + no-confirm should
still give session=null → requiresVerification:true → "check your email"
copy. Either way enumeration-safe.

BUT: if a future Supabase change makes the obfuscation path return a session
(unlikely but possible if the team decides obfuscation isn't worth it), this
code happily ships `{ ok: true, requiresVerification: false }` and the user
thinks they're signed in to an account that isn't theirs.

**Fix:** Add a final defensive check that `data.user.identities`, when
defined, isn't empty:

```ts
const identities = data?.user?.identities;
if (Array.isArray(identities) && identities.length === 0) {
  return { ok: true, requiresVerification: true };
}
// Defensive: if identities is undefined AND session is non-null AND we
// can't verify the email-confirm setting, lean toward requiresVerification.
return { ok: true, requiresVerification: data?.session == null };
```

The proposed change keeps current behavior but documents the invariant.

---

## Info

### IN-01: `IpcChannel.app.ready` is defined but never used

**File:** `src/shared/ipc.ts:358` (`app: { ready: 'app:ready', ... }`)
**Issue:** No handler registered for `app:ready`; no caller invokes it. Dead
protocol surface.
**Fix:** Remove or comment out the constant; or wire it if there's a planned
"main signals ready" usage.

### IN-02: `loopbackCallback.LOOPBACK_CALLBACK_URL` and `authHandlers.LOOPBACK_CALLBACK_URL` duplicate the same constant

**File:** `src/main/auth/loopbackCallback.ts:60`,
`src/main/auth/authHandlers.ts:194`
**Issue:** Two module-level constants with identical string values
`http://localhost:54321/auth/callback`. A future port change would have to
remember both.
**Fix:** Export `LOOPBACK_CALLBACK_URL` from `loopbackCallback.ts` (it
already is, line 60) and import it in `authHandlers.ts` instead of redefining.

### IN-03: `botSupervisor.updateJwt` swallows `postMessage` errors silently

**File:** `src/main/botSupervisor.ts:509-515`
**Issue:** The empty `catch { /* port closed during teardown; ignore */ }`
hides a class of bugs where post-message fails for non-teardown reasons (port
serialization error on a malformed JWT, channel buffer overrun, etc.). The
comment explains the intent, but no log line means an actual bug here is
invisible.
**Fix:** Log at debug level:

```ts
catch (err) {
  // logger.debug not yet wired; left as TODO. Add when central logger lands.
}
```

### IN-04: `package.json` doesn't pin `@supabase/supabase-js` exact version

**File:** `package.json:23`
**Issue:** `"@supabase/supabase-js": "^2.106.0"` — the caret allows 2.x minor
bumps. Supabase has historically introduced subtle behavior changes in minor
releases (e.g., session-blob format, auth-event vocabulary). For a security-
sensitive subsystem, pin the exact version:
**Fix:** `"@supabase/supabase-js": "2.106.0"` and let dependabot/renovate
surface upgrades for review.

### IN-05: `authState.ts` `_disposeForTests` does not remove the `did-finish-load` listener

**File:** `src/main/auth/authState.ts:115-120`
**Issue:** The test helper unsubscribes the Supabase auth subscription and
clears `mainWindowRef`, but the `webContents.on('did-finish-load', ...)`
listener attached at line 87 is never removed. In a real test environment
using a mock BrowserWindow, this might or might not matter; in production it
compounds with BL-02. The dispose helper should match the bind helper.
**Fix:**

```ts
export function _disposeForTests(): void {
  subscription?.unsubscribe();
  subscription = null;
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.removeAllListeners('did-finish-load');
  }
  mainWindowRef = null;
  currentState = { kind: 'local' };
}
```

(Or capture the specific handler reference for removal.)

---

_Reviewed: 2026-05-20_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
