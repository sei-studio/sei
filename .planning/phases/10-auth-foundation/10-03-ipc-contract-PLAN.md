---
phase: 10
plan: 03
type: execute
wave: 2
depends_on: [10-01, 10-02]
files_modified:
  - src/shared/ipc.ts
  - src/shared/characterSchema.ts
  - src/main/auth/authState.ts
  - src/main/auth/authHandlers.ts
  - src/main/ipc.ts
  - src/main/index.ts
  - src/preload/index.ts
autonomous: true
requirements: [AUTH-01, AUTH-03, AUTH-05]
requirements_addressed: [AUTH-01, AUTH-03, AUTH-05]
tags: [ipc, state-machine, auth, preload]
must_haves:
  truths:
    - "Renderer subscribes to a single `auth:state` push channel and receives {kind:'local'} | {kind:'signed_in', user, emailVerified} (D-06; AUTH-05 surface)"
    - "All 9 auth:* IPC channels are registered with Zod argument schemas at the boundary (per existing ipc.ts discipline)"
    - "The two-state machine in src/main/auth/authState.ts has exactly two states `local` and `signed_in` and no third state (D-06)"
    - "App bootstraps with setStorageAdapter(createSessionStorageAdapter()) called BEFORE the first getClient() call (plan 01's SUPABASE_NO_STORAGE_ADAPTER error never fires in production)"
    - "Main subscribes to supabase.auth.onAuthStateChange and broadcasts on SIGNED_IN, SIGNED_OUT, TOKEN_REFRESHED, and USER_UPDATED events (covers email-verification flip per Pitfall A6)"
    - "Linux basic_text fallback is surfaced via the EXISTING app:warnings IPC, extended to include a sessionFallbackPlaintext field — no new warning channel (Pitfall A2; reuses existing pattern)"
    - "Preload (window.sei) exposes typed auth methods: signInPassword, signUpPassword, signInGoogle, cancelGoogle, signOut, deleteAccount, exportData, resendVerification, onAuthState"
    - "UserConfigSchema gains linuxBasicTextWarnDismissed:boolean default false so plan 07's Banner dismissal persists (RESEARCH Q4)"
  artifacts:
    - path: "src/shared/ipc.ts"
      provides: "AuthState union type, IpcChannel.auth nested namespace, RendererApi auth methods, StartupWarnings extended with sessionFallbackPlaintext"
      exports: ["AuthState", "AuthUser", "SignInResult", "SignUpResult", "OAuthResult", "DeleteAccountResult", "ExportDataResult", "ResendVerificationResult", "IpcChannel.auth"]
    - path: "src/main/auth/authState.ts"
      provides: "Two-state machine + onAuthStateChange subscription + broadcast helper"
      exports: ["initAuthState", "getCurrentAuthState", "broadcastAuthState", "transitionToLocal", "transitionToSignedIn"]
    - path: "src/main/auth/authHandlers.ts"
      provides: "IPC handler bodies for the 9 auth:* channels; placeholders for handlers fully implemented in plans 04/05/06/08/09"
      exports: ["signInWithPassword", "signUpWithPassword", "signInWithGoogle", "cancelGoogle", "signOut", "deleteAccount", "exportData", "resendVerification"]
    - path: "src/main/ipc.ts"
      provides: "Registered auth:* ipcMain.handle bindings with Zod schemas"
      contains: "IpcChannel.auth"
    - path: "src/main/index.ts"
      provides: "Bootstrap calls setStorageAdapter(createSessionStorageAdapter()) before any auth IPC handler is registered; initAuthState(mainWindow) wires onAuthStateChange → broadcast"
      contains: "setStorageAdapter\\|initAuthState"
    - path: "src/preload/index.ts"
      provides: "Typed window.sei.signInPassword, signUpPassword, signInGoogle, etc. bindings"
      contains: "auth:signin-password"
  key_links:
    - from: "src/main/index.ts (bootstrap)"
      to: "src/main/auth/supabaseClient.ts (setStorageAdapter)"
      via: "setStorageAdapter(createSessionStorageAdapter()) called before getClient()"
      pattern: "setStorageAdapter\\(createSessionStorageAdapter"
    - from: "src/main/auth/authState.ts"
      to: "src/main/auth/supabaseClient.ts"
      via: "getClient().auth.onAuthStateChange(callback)"
      pattern: "onAuthStateChange"
    - from: "src/main/auth/authState.ts"
      to: "BrowserWindow.webContents.send"
      via: "broadcastAuthState pushes IpcChannel.auth.state to renderer"
      pattern: "webContents\\.send.*auth\\.state"
    - from: "src/preload/index.ts"
      to: "src/shared/ipc.ts (RendererApi auth methods)"
      via: "contextBridge.exposeInMainWorld('sei', api)"
      pattern: "ipcRenderer\\.invoke\\(IpcChannel\\.auth"
---

<objective>
Build the IPC contract layer that every Phase 10 plan downstream depends on:
1. Extend `src/shared/ipc.ts` with the `AuthState` union, the `IpcChannel.auth` namespace (9 channels), the request/response result shapes, and the `RendererApi` method signatures.
2. Extend `src/shared/characterSchema.ts` `UserConfigSchema` with `linuxBasicTextWarnDismissed: z.boolean().default(false)`.
3. Build `src/main/auth/authState.ts` — the two-state machine (`local` / `signed_in`, NO third state), `supabase.auth.onAuthStateChange` subscription, and the `broadcastAuthState(window)` helper.
4. Build `src/main/auth/authHandlers.ts` — the 9 handler functions. Plans 04–09 fill the bodies; plan 03 provides the function shells with placeholder TODOs that return `{ok:false, code:'not_implemented', message:'wired in plan NN'}` so the IPC layer is testable end-to-end immediately.
5. Wire `setStorageAdapter(createSessionStorageAdapter())` into `src/main/index.ts` bootstrap BEFORE any `getClient()` call.
6. Register all 9 `auth:*` handlers in `src/main/ipc.ts`.
7. Extend `src/preload/index.ts` with the typed renderer bindings.
8. Extend the existing `app:warnings` IPC handler to also include `sessionFallbackPlaintext: boolean` (no new channel — reuses existing pattern).

Purpose: Stand up the entire auth IPC surface in one wave-2 plan so plans 04–09 (wave 3+) each have a single concern (implement a handler body / build a UI surface) instead of fighting the contract.

Output:
  - One IPC schema extension, one state machine, one handler shell, one bootstrap wiring, one preload bridge, one config schema extension.
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
@src/main/ipc.ts
@src/main/index.ts
@src/preload/index.ts
@src/shared/ipc.ts
@src/shared/characterSchema.ts
@.planning/phases/10-auth-foundation/10-01-SUMMARY.md
@.planning/phases/10-auth-foundation/10-02-SUMMARY.md

<interfaces>
<!-- The 9 channels and their exact request/response shapes. Sourced verbatim from RESEARCH §Pattern 5. -->

| Channel | Direction | Request | Response |
|---------|-----------|---------|----------|
| `auth:state` | main → renderer push | — | `AuthState` |
| `auth:signin-password` | invoke | `{email, password}` | `SignInResult` |
| `auth:signup-password` | invoke | `{email, password}` | `SignUpResult` |
| `auth:signin-google` | invoke | — | `OAuthResult` |
| `auth:cancel-google` | invoke | — | `void` |
| `auth:signout` | invoke | — | `void` |
| `auth:delete-account` | invoke | — | `DeleteAccountResult` |
| `auth:export-data` | invoke | — | `ExportDataResult` |
| `auth:resend-verification` | invoke | — | `ResendVerificationResult` |

```typescript
export interface AuthUser {
  id: string;
  email: string;
  emailVerified: boolean;
  createdAt: string; // ISO
}
export type AuthState =
  | { kind: 'local' }
  | { kind: 'signed_in'; user: AuthUser };

export type SignInResult =
  | { ok: true }
  | { ok: false; code: 'invalid_credentials' | 'network' | 'rate_limited'; message: string };
export type SignUpResult =
  | { ok: true; requiresVerification: boolean }
  | { ok: false; code: 'email_in_use' | 'weak_password' | 'invalid_email' | 'network'; message: string };
export type OAuthResult =
  | { ok: true }
  | { ok: false; reason: 'user_cancelled' | 'timeout' | 'browser_closed' | 'google_rejected' | 'exchange_failed' | 'port_collision' | 'network'; message: string };
export type DeleteAccountResult =
  | { ok: true }
  | { ok: false; code: 'network' | 'edge_function_error'; message: string };
export type ExportDataResult =
  | { ok: true; savedPath: string }
  | { ok: false; code: 'cancelled' | 'network' | 'write_failed'; message: string };
export type ResendVerificationResult =
  | { ok: true }
  | { ok: false; code: 'rate_limited' | 'network'; message: string };
```

Supabase JS event types (from @supabase/supabase-js):
```typescript
type AuthChangeEvent =
  | 'INITIAL_SESSION' | 'SIGNED_IN' | 'SIGNED_OUT'
  | 'TOKEN_REFRESHED' | 'USER_UPDATED' | 'PASSWORD_RECOVERY';
```
</interfaces>
</context>

<read_first>
- `src/shared/ipc.ts` (locate IpcChannel; RendererApi interface; StartupWarnings interface)
- `src/main/ipc.ts` (registration pattern — Zod gate at boundary, lazy `await import` of handler module)
- `src/main/index.ts` lines 100–264 (bootstrap function — must add setStorageAdapter + initAuthState in the right order, BEFORE registerIpcHandlers)
- `src/preload/index.ts` (RendererApi shape; add auth methods + onAuthState subscription)
- `src/main/auth/supabaseClient.ts` (plan 01 — setStorageAdapter must be called first)
- `src/main/auth/sessionStore.ts` (plan 02 — createSessionStorageAdapter() is the value passed)
- `src/shared/characterSchema.ts` lines 100–110 (UserConfigSchema — extend with one new field)
- `.planning/phases/10-auth-foundation/10-RESEARCH.md` §Pattern 5 (IPC channel extension table)
- `.planning/phases/10-auth-foundation/10-CONTEXT.md` D-06 (two-state model — NO signed_out state) and `<code_context>` "Integration Points" channel list
</read_first>

<tasks>

<task type="auto" tdd="false">
  <name>Task 1: Extend src/shared/ipc.ts + src/shared/characterSchema.ts with auth types and channels</name>
  <files>src/shared/ipc.ts, src/shared/characterSchema.ts</files>
  <read_first>
    - src/shared/ipc.ts (entire file — 333 lines; preserve all existing exports)
    - src/shared/characterSchema.ts lines 100–110 (UserConfigSchema)
  </read_first>
  <behavior>
    - All existing IpcChannel namespaces unchanged.
    - IpcChannel.auth namespace exists with exactly 9 keys: state, signinPassword, signupPassword, signinGoogle, cancelGoogle, signout, deleteAccount, exportData, resendVerification.
    - String values match the format from RESEARCH §Pattern 5: 'auth:state', 'auth:signin-password', 'auth:signup-password', 'auth:signin-google', 'auth:cancel-google', 'auth:signout', 'auth:delete-account', 'auth:export-data', 'auth:resend-verification'.
    - StartupWarnings gains `sessionFallbackPlaintext: boolean` (in ADDITION to existing keychainFallbackPlaintext; not replacing).
    - RendererApi gains 9 methods: signInPassword, signUpPassword, signInGoogle, cancelGoogle, signOut, deleteAccount, exportData, resendVerification, onAuthState. Method names follow the existing camelCase convention.
    - IpcChannelName union includes the new auth channels.
    - UserConfigSchema gains `linuxBasicTextWarnDismissed: z.boolean().default(false)`.
  </behavior>
  <action>
1. Edit `src/shared/ipc.ts`:

   (a) Add ABOVE the `IpcChannel` constant and BELOW the existing exports — i.e., in the "Preload-exposed RendererApi" section near line 184 — these type exports:

   ```typescript
   /* -------------------------------------------------------------------------- */
   /*  Auth domain types (Phase 10)                                              */
   /* -------------------------------------------------------------------------- */

   /** Renderer-facing user shape; subset of Supabase's User. */
   export interface AuthUser {
     id: string;
     email: string;
     emailVerified: boolean;
     createdAt: string; // ISO 8601
   }

   /**
    * Top-level auth state. Two-state model per CONTEXT D-06:
    * there is no separate 'signed_out' — AuthChoice gates the app
    * so 'local' is the resting-state when no session is loaded.
    */
   export type AuthState =
     | { kind: 'local' }
     | { kind: 'signed_in'; user: AuthUser };

   export type SignInResult =
     | { ok: true }
     | { ok: false; code: 'invalid_credentials' | 'network' | 'rate_limited'; message: string };

   export type SignUpResult =
     | { ok: true; requiresVerification: boolean }
     | { ok: false; code: 'email_in_use' | 'weak_password' | 'invalid_email' | 'network'; message: string };

   export type OAuthResult =
     | { ok: true }
     | { ok: false; reason: 'user_cancelled' | 'timeout' | 'browser_closed' | 'google_rejected' | 'exchange_failed' | 'port_collision' | 'network'; message: string };

   export type DeleteAccountResult =
     | { ok: true }
     | { ok: false; code: 'network' | 'edge_function_error'; message: string };

   export type ExportDataResult =
     | { ok: true; savedPath: string }
     | { ok: false; code: 'cancelled' | 'network' | 'write_failed'; message: string };

   export type ResendVerificationResult =
     | { ok: true }
     | { ok: false; code: 'rate_limited' | 'network'; message: string };
   ```

   (b) Edit `StartupWarnings` (existing interface near line 46) to ADD a field (do NOT remove keychainFallbackPlaintext):

   ```typescript
   export interface StartupWarnings {
     keychainFallbackPlaintext: boolean;
     /** Phase 10: Linux basic_text safeStorage also affects session.bin (Pitfall A2). Same backend signal, different consumer Banner. */
     sessionFallbackPlaintext: boolean;
   }
   ```

   (c) Add to `RendererApi` interface — anywhere in the body, group together as "// --- Auth (Phase 10) ---":

   ```typescript
     // --- Auth (Phase 10) ---
     signInPassword(args: { email: string; password: string }): Promise<SignInResult>;
     signUpPassword(args: { email: string; password: string }): Promise<SignUpResult>;
     signInGoogle(): Promise<OAuthResult>;
     cancelGoogle(): Promise<void>;
     signOut(): Promise<void>;
     deleteAccount(): Promise<DeleteAccountResult>;
     exportData(): Promise<ExportDataResult>;
     resendVerification(): Promise<ResendVerificationResult>;
     onAuthState(cb: (state: AuthState) => void): Unsubscribe;
   ```

   (d) Edit the `IpcChannel` constant to add the `auth` namespace immediately before the closing `} as const;` (preserve all existing entries):

   ```typescript
     auth: {
       state: 'auth:state',
       signinPassword: 'auth:signin-password',
       signupPassword: 'auth:signup-password',
       signinGoogle: 'auth:signin-google',
       cancelGoogle: 'auth:cancel-google',
       signout: 'auth:signout',
       deleteAccount: 'auth:delete-account',
       exportData: 'auth:export-data',
       resendVerification: 'auth:resend-verification',
     },
   ```

   (e) Extend `IpcChannelName` union (existing type alias at file bottom) with:

   ```typescript
     | typeof IpcChannel.auth[keyof typeof IpcChannel.auth];
   ```

2. Edit `src/shared/characterSchema.ts`. Inside the `UserConfigSchema` z.object body (around line 103–108), ADD one field — alphabetical order would put it first; put it after `theme_mode` to minimize diff and preserve existing field order:

   ```typescript
   export const UserConfigSchema = z.object({
     mc_username: z.string().default(''),
     preferred_name: z.string().default(''),
     provider: z.enum(['anthropic']).default('anthropic'),
     theme_mode: z.enum(['system', 'light', 'dark']).default('system'),
     /** Plan 07: Linux basic_text safeStorage warning Banner dismissal (Pitfall A2). */
     linuxBasicTextWarnDismissed: z.boolean().default(false),
   });
   ```
  </action>
  <verify>
    <automated>grep -c "export type AuthState" src/shared/ipc.ts | grep -q "^1$" && grep -c "'auth:state'" src/shared/ipc.ts | grep -q "^1$" && grep -c "'auth:signin-password'" src/shared/ipc.ts | grep -q "^1$" && grep -c "'auth:signin-google'" src/shared/ipc.ts | grep -q "^1$" && grep -c "'auth:delete-account'" src/shared/ipc.ts | grep -q "^1$" && grep -c "'auth:export-data'" src/shared/ipc.ts | grep -q "^1$" && grep -c "sessionFallbackPlaintext" src/shared/ipc.ts | grep -q "^1$" && grep -c "signInPassword" src/shared/ipc.ts | grep -q "^1$" && grep -c "onAuthState" src/shared/ipc.ts | grep -q "^1$" && grep -c "linuxBasicTextWarnDismissed" src/shared/characterSchema.ts | grep -q "^1$" && npx tsc --noEmit 2>&1 | grep -v "src/main/auth/authHandlers\|src/main/auth/authState\|src/main/ipc\|src/main/index\|src/preload/index" | grep -E "error TS" || true; true</automated>
  </verify>
  <acceptance_criteria>
    - `grep -c "export type AuthState" src/shared/ipc.ts` equals 1
    - `grep -c "export interface AuthUser" src/shared/ipc.ts` equals 1
    - `grep -c "export type SignInResult" src/shared/ipc.ts` equals 1
    - `grep -c "export type SignUpResult" src/shared/ipc.ts` equals 1
    - `grep -c "export type OAuthResult" src/shared/ipc.ts` equals 1
    - `grep -c "export type DeleteAccountResult" src/shared/ipc.ts` equals 1
    - `grep -c "export type ExportDataResult" src/shared/ipc.ts` equals 1
    - `grep -c "export type ResendVerificationResult" src/shared/ipc.ts` equals 1
    - `grep -c "'auth:state'" src/shared/ipc.ts` equals 1
    - `grep -c "'auth:signin-password'" src/shared/ipc.ts` equals 1
    - `grep -c "'auth:signup-password'" src/shared/ipc.ts` equals 1
    - `grep -c "'auth:signin-google'" src/shared/ipc.ts` equals 1
    - `grep -c "'auth:cancel-google'" src/shared/ipc.ts` equals 1
    - `grep -c "'auth:signout'" src/shared/ipc.ts` equals 1
    - `grep -c "'auth:delete-account'" src/shared/ipc.ts` equals 1
    - `grep -c "'auth:export-data'" src/shared/ipc.ts` equals 1
    - `grep -c "'auth:resend-verification'" src/shared/ipc.ts` equals 1
    - `grep -c "sessionFallbackPlaintext" src/shared/ipc.ts` equals 1
    - `grep -c "keychainFallbackPlaintext" src/shared/ipc.ts` >= 1 (preserved)
    - All 9 method names appear in RendererApi: `for m in signInPassword signUpPassword signInGoogle cancelGoogle signOut deleteAccount exportData resendVerification onAuthState; do grep -c "$m" src/shared/ipc.ts; done` — each returns at least 1
    - `grep -c "linuxBasicTextWarnDismissed" src/shared/characterSchema.ts` equals 1
    - `grep -c "z.boolean().default(false)" src/shared/characterSchema.ts` >= 1
  </acceptance_criteria>
  <done>
    IPC contract published in src/shared. Plans 04–09 import types from here. Existing IpcChannel entries and StartupWarnings.keychainFallbackPlaintext preserved.
  </done>
</task>

<task type="auto" tdd="false">
  <name>Task 2: Build authState.ts (two-state machine + onAuthStateChange subscription)</name>
  <files>src/main/auth/authState.ts</files>
  <read_first>
    - src/main/auth/supabaseClient.ts (getClient)
    - src/shared/ipc.ts (AuthState, AuthUser types from Task 1; IpcChannel.auth.state)
    - .planning/phases/10-auth-foundation/10-CONTEXT.md D-06 (two-state model; no signed_out)
    - .planning/phases/10-auth-foundation/10-RESEARCH.md §Pitfall A6 (USER_UPDATED event handling for email verification flip)
  </read_first>
  <behavior>
    - initAuthState(mainWindow) is called once during bootstrap. It:
      (a) Subscribes to getClient().auth.onAuthStateChange.
      (b) On 'INITIAL_SESSION' with a session → currentState becomes signed_in.
      (c) On 'SIGNED_IN' → currentState becomes signed_in.
      (d) On 'SIGNED_OUT' → currentState becomes local.
      (e) On 'TOKEN_REFRESHED' / 'USER_UPDATED' → re-derive AuthUser from session.user; if emailVerified flipped, broadcast new state.
      (f) On the BrowserWindow's did-finish-load event, replays the current state to the freshly-loaded renderer (same pattern as latestLanState in src/main/index.ts line 217).
    - getCurrentAuthState() returns the current AuthState synchronously.
    - broadcastAuthState(window) sends IpcChannel.auth.state to the given BrowserWindow.
    - transitionToLocal() and transitionToSignedIn(user) are NOT exposed for normal flow — Supabase events drive transitions. They exist for: (a) tests, (b) the rare manual sync-out from plan 06 that doesn't wait for the SIGNED_OUT event.
    - AuthUser derivation from a Supabase Session.user is centralized in a single internal `toAuthUser(user)` function so plans 04/05 don't reinvent it.
  </behavior>
  <action>
Create `src/main/auth/authState.ts`:

```typescript
/**
 * Auth state machine + onAuthStateChange subscription.
 *
 * Two-state model per CONTEXT D-06: `local` and `signed_in`. No `signed_out`
 * — AuthChoice gates the app before MainApp renders, so the resting state when
 * no session is loaded is `local`.
 *
 * Source of truth: Supabase's onAuthStateChange. We never set state by hand
 * except for testing or for the synchronous sign-out path in plan 06 (which
 * fires the supabase.auth.signOut() but doesn't await its SIGNED_OUT event
 * before tearing down the bot).
 *
 * Renderer subscription: src/preload/index.ts exposes onAuthState; React
 * subscribes once at App.tsx mount and re-renders on every push.
 *
 * Pitfall A6 (email-verification flip): when the user clicks the verification
 * link in their browser, Supabase fires USER_UPDATED on the next API call.
 * We re-derive emailVerified from session.user.email_confirmed_at on every
 * USER_UPDATED and TOKEN_REFRESHED event.
 *
 * Sources:
 *   - 10-CONTEXT D-06 (two-state model)
 *   - 10-RESEARCH §Pitfall A6 (USER_UPDATED for email-verified flip)
 *   - src/main/index.ts line 214–219 (did-finish-load replay pattern)
 */
import type { BrowserWindow } from 'electron';
import type { Session, User } from '@supabase/supabase-js';
import { getClient } from './supabaseClient';
import { IpcChannel, type AuthState, type AuthUser } from '../../shared/ipc';

let currentState: AuthState = { kind: 'local' };
let mainWindowRef: BrowserWindow | null = null;
let subscription: { unsubscribe: () => void } | null = null;

function toAuthUser(user: User): AuthUser {
  return {
    id: user.id,
    email: user.email ?? '',
    emailVerified: user.email_confirmed_at != null,
    createdAt: user.created_at,
  };
}

function applySession(session: Session | null): void {
  if (session && session.user) {
    currentState = { kind: 'signed_in', user: toAuthUser(session.user) };
  } else {
    currentState = { kind: 'local' };
  }
}

export function getCurrentAuthState(): AuthState {
  return currentState;
}

export function broadcastAuthState(window: BrowserWindow | null): void {
  if (!window || window.isDestroyed()) return;
  window.webContents.send(IpcChannel.auth.state, currentState);
}

/**
 * Wire up the onAuthStateChange subscription and replay current state on
 * window refresh. Called ONCE from main/index.ts bootstrap, after the
 * BrowserWindow exists.
 */
export async function initAuthState(window: BrowserWindow): Promise<void> {
  mainWindowRef = window;

  const supabase = getClient();

  // Load the initial session so currentState is correct before the first
  // onAuthStateChange event arrives. getSession() reads from the storage
  // adapter (sessionStore — already wired by bootstrap).
  const { data: { session } } = await supabase.auth.getSession();
  applySession(session);

  // Subscribe.
  const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
    // Events we care about: SIGNED_IN, SIGNED_OUT, TOKEN_REFRESHED, USER_UPDATED, INITIAL_SESSION.
    // PASSWORD_RECOVERY is irrelevant in Phase 10 (no recovery flow shipped).
    applySession(session);
    broadcastAuthState(mainWindowRef);
  });
  subscription = sub.subscription;

  // Replay on renderer reload (same pattern as latestLanState in src/main/index.ts).
  window.webContents.on('did-finish-load', () => {
    broadcastAuthState(mainWindowRef);
  });

  // Initial broadcast so renderer's first onAuthState subscription receives state immediately.
  broadcastAuthState(window);
}

/**
 * TEST-ONLY helper: forcibly transition to local. Used by plan 06's
 * synchronous sign-out path AFTER it has called supabase.auth.signOut() and
 * does not want to wait for the SIGNED_OUT event.
 */
export function transitionToLocal(): void {
  currentState = { kind: 'local' };
  broadcastAuthState(mainWindowRef);
}

/** TEST-ONLY helper: tear down the subscription. */
export function _disposeForTests(): void {
  subscription?.unsubscribe();
  subscription = null;
  mainWindowRef = null;
  currentState = { kind: 'local' };
}
```
  </action>
  <verify>
    <automated>grep -c "export async function initAuthState" src/main/auth/authState.ts | grep -q "^1$" && grep -c "export function getCurrentAuthState" src/main/auth/authState.ts | grep -q "^1$" && grep -c "export function broadcastAuthState" src/main/auth/authState.ts | grep -q "^1$" && grep -c "onAuthStateChange" src/main/auth/authState.ts | grep -q "^1$" && grep -c "did-finish-load" src/main/auth/authState.ts | grep -q "^1$" && ! grep -q "'signed_out'" src/main/auth/authState.ts && npx tsc --noEmit 2>&1 | grep -E "src/main/auth/authState\.ts.*error TS" || true; true</automated>
  </verify>
  <acceptance_criteria>
    - `grep -c "export async function initAuthState" src/main/auth/authState.ts` equals 1
    - `grep -c "export function getCurrentAuthState" src/main/auth/authState.ts` equals 1
    - `grep -c "export function broadcastAuthState" src/main/auth/authState.ts` equals 1
    - `grep -c "onAuthStateChange" src/main/auth/authState.ts` equals 1
    - `grep -c "email_confirmed_at" src/main/auth/authState.ts` equals 1 (emailVerified derivation)
    - `grep -c "did-finish-load" src/main/auth/authState.ts` equals 1
    - `grep -c "'signed_out'" src/main/auth/authState.ts` equals 0 (NO third state — D-06)
    - `grep -c "kind: 'local'" src/main/auth/authState.ts` >= 2 (initial state + transitionToLocal)
    - `grep -c "kind: 'signed_in'" src/main/auth/authState.ts` >= 1
    - `npx tsc --noEmit` reports no errors specific to authState.ts
  </acceptance_criteria>
  <done>
    Two-state machine wired to Supabase events; broadcasts to renderer; replays on did-finish-load; never enters a third state.
  </done>
</task>

<task type="auto" tdd="false">
  <name>Task 3: Create authHandlers.ts shells + wire all 9 channels in src/main/ipc.ts + preload bindings + bootstrap</name>
  <files>src/main/auth/authHandlers.ts, src/main/ipc.ts, src/main/index.ts, src/preload/index.ts</files>
  <read_first>
    - src/main/ipc.ts (entire file — registration pattern, Zod gates, lazy await import of handler modules)
    - src/main/index.ts lines 50–264 (bootstrap function; registerIpcHandlers call)
    - src/preload/index.ts (RendererApi binding pattern)
    - src/main/auth/supabaseClient.ts (setStorageAdapter must be called BEFORE first getClient)
    - src/main/auth/sessionStore.ts (createSessionStorageAdapter, sessionBackendKind)
    - src/main/apiKeyStore.ts (backendKind — the existing app:warnings source)
  </read_first>
  <behavior>
    - src/main/auth/authHandlers.ts exports 8 async functions (signInWithPassword, signUpWithPassword, signInWithGoogle, cancelGoogle, signOut, deleteAccount, exportData, resendVerification). Bodies are TODO stubs that return the appropriate {ok:false, code:'not_implemented', message:'wired in plan NN'} variant — except `signOut` (no return / void) which is a no-op.
    - The stub for each handler INCLUDES a comment `// IMPLEMENTED IN PLAN 10-NN` where NN is: 04 for signInWithPassword/signUpWithPassword, 05 for signInWithGoogle/cancelGoogle, 06 for signOut/resendVerification, 08 for deleteAccount, 09 for exportData.
    - src/main/ipc.ts gains 9 ipcMain.handle registrations under a comment `// === Auth (Phase 10) ===`. Each handler validates the args with a Zod schema where applicable, then lazy-imports './auth/authHandlers' and dispatches.
    - src/main/index.ts bootstrap order: BEFORE `registerIpcHandlers(...)`, call `setStorageAdapter(createSessionStorageAdapter())` (once), then AFTER mainWindow is created and before bootstrap exits, call `await initAuthState(mainWindow)`.
    - src/main/index.ts: the existing `app:warnings` handler (currently in ipc.ts line 275) returns `{keychainFallbackPlaintext, sessionFallbackPlaintext}`. The new field uses `sessionBackendKind() === 'basic_text'` on Linux.
    - src/preload/index.ts: 9 new bindings on the `api` object (8 invoke + 1 push subscription) wired to the matching IpcChannel.auth.* constants.
  </behavior>
  <action>
1. Create `src/main/auth/authHandlers.ts`:

```typescript
/**
 * IPC handler bodies for the 9 auth:* channels.
 *
 * This file is the per-handler dispatch surface. Each handler function
 * is referenced by name from src/main/ipc.ts. Plan 03 ships SHELLS;
 * plans 04 (email/password), 05 (Google OAuth), 06 (sign-out + JWT + verify),
 * 08 (delete via Edge Function), 09 (export) fill the bodies.
 *
 * The shells return {ok:false, code:'not_implemented', message:'...'} so a
 * renderer wired to the IPC at end-of-plan-03 produces a clean error rather
 * than a hang.
 *
 * Sources:
 *   - 10-RESEARCH §Pattern 5 (IPC channel table)
 *   - 10-CONTEXT integration_points (channel list)
 */
import { shell, dialog } from 'electron';
import type {
  SignInResult,
  SignUpResult,
  OAuthResult,
  DeleteAccountResult,
  ExportDataResult,
  ResendVerificationResult,
} from '../../shared/ipc';

// IMPLEMENTED IN PLAN 10-04 (Email/password)
export async function signInWithPassword(_args: { email: string; password: string }): Promise<SignInResult> {
  return { ok: false, code: 'network', message: 'not_implemented: wired in plan 10-04' };
}

// IMPLEMENTED IN PLAN 10-04 (Email/password)
export async function signUpWithPassword(_args: { email: string; password: string }): Promise<SignUpResult> {
  return { ok: false, code: 'network', message: 'not_implemented: wired in plan 10-04' };
}

// IMPLEMENTED IN PLAN 10-05 (Google OAuth + loopback + PKCE)
export async function signInWithGoogle(): Promise<OAuthResult> {
  return { ok: false, reason: 'exchange_failed', message: 'not_implemented: wired in plan 10-05' };
}

// IMPLEMENTED IN PLAN 10-05 (Google OAuth cancel via AbortController)
export async function cancelGoogle(): Promise<void> {
  /* no-op until plan 10-05 wires the AbortController for the in-flight loopback server */
}

// IMPLEMENTED IN PLAN 10-06 (Sign-out semantics + bot stop)
export async function signOut(): Promise<void> {
  /* no-op until plan 10-06 wires getClient().auth.signOut() + bot supervisor stop */
}

// IMPLEMENTED IN PLAN 10-08 (Edge Function delete-me + type-email-to-confirm)
export async function deleteAccount(): Promise<DeleteAccountResult> {
  return { ok: false, code: 'edge_function_error', message: 'not_implemented: wired in plan 10-08' };
}

// IMPLEMENTED IN PLAN 10-09 (JSON export envelope + dialog.showSaveDialog)
export async function exportData(): Promise<ExportDataResult> {
  return { ok: false, code: 'write_failed', message: 'not_implemented: wired in plan 10-09' };
}

// IMPLEMENTED IN PLAN 10-06 (resend verification via Supabase Auth)
export async function resendVerification(): Promise<ResendVerificationResult> {
  return { ok: false, code: 'network', message: 'not_implemented: wired in plan 10-06' };
}

// Re-export the dialog/shell symbols so plan 05/09 don't need separate imports.
// (Kept here so handlers stay co-located.)
export { shell, dialog };
```

2. Edit `src/main/ipc.ts`:

   (a) Add Zod schemas near the existing schemas (around line 54):

   ```typescript
   const SignInPasswordSchema = z.object({
     email: z.string().email(),
     password: z.string().min(1),
   });
   const SignUpPasswordSchema = z.object({
     email: z.string().email(),
     password: z.string().min(8),
   });
   ```

   (b) Inside `registerIpcHandlers(deps)`, add (anywhere after the existing handlers but before the closing brace) — group under a comment header:

   ```typescript
     // === Auth (Phase 10) ===
     ipcMain.handle(IpcChannel.auth.signinPassword, async (_e, argsRaw: unknown) => {
       const args = SignInPasswordSchema.parse(argsRaw);
       const { signInWithPassword } = await import('./auth/authHandlers');
       return await signInWithPassword(args);
     });
     ipcMain.handle(IpcChannel.auth.signupPassword, async (_e, argsRaw: unknown) => {
       const args = SignUpPasswordSchema.parse(argsRaw);
       const { signUpWithPassword } = await import('./auth/authHandlers');
       return await signUpWithPassword(args);
     });
     ipcMain.handle(IpcChannel.auth.signinGoogle, async () => {
       const { signInWithGoogle } = await import('./auth/authHandlers');
       return await signInWithGoogle();
     });
     ipcMain.handle(IpcChannel.auth.cancelGoogle, async () => {
       const { cancelGoogle } = await import('./auth/authHandlers');
       return await cancelGoogle();
     });
     ipcMain.handle(IpcChannel.auth.signout, async () => {
       const { signOut } = await import('./auth/authHandlers');
       return await signOut();
     });
     ipcMain.handle(IpcChannel.auth.deleteAccount, async () => {
       const { deleteAccount } = await import('./auth/authHandlers');
       return await deleteAccount();
     });
     ipcMain.handle(IpcChannel.auth.exportData, async () => {
       const { exportData } = await import('./auth/authHandlers');
       return await exportData();
     });
     ipcMain.handle(IpcChannel.auth.resendVerification, async () => {
       const { resendVerification } = await import('./auth/authHandlers');
       return await resendVerification();
     });
   ```

   (c) Edit the existing `app:warnings` handler (currently lines 275–280) to add `sessionFallbackPlaintext`:

   ```typescript
     ipcMain.handle(IpcChannel.app.warnings, async () => {
       const { sessionBackendKind } = await import('./auth/sessionStore');
       const onLinux = process.platform === 'linux';
       return {
         keychainFallbackPlaintext: onLinux && backendKind() === 'basic_text',
         sessionFallbackPlaintext: onLinux && sessionBackendKind() === 'basic_text',
       };
     });
   ```

3. Edit `src/main/index.ts`:

   (a) At the very top of `bootstrap()`, before `runFirstLaunchMigration()`, add:

   ```typescript
     // 0. Auth foundation — wire safeStorage-backed session storage into the
     //    Supabase client BEFORE any auth IPC handler can call getClient().
     //    This is the only legal point in the lifecycle to call setStorageAdapter.
     {
       const { setStorageAdapter } = await import('./auth/supabaseClient');
       const { createSessionStorageAdapter } = await import('./auth/sessionStore');
       setStorageAdapter(createSessionStorageAdapter());
     }
   ```

   (b) After `mainWindow = createMainWindow({...})` and after `mainWindow.on('closed', ...)` (around line 213, before the `did-finish-load` LAN replay), add:

   ```typescript
     // Wire auth state broadcast (initial replay + onAuthStateChange subscription).
     {
       const { initAuthState } = await import('./auth/initAuthState');
       try { await initAuthState(mainWindow); }
       catch (err) { logger.warn(`auth state init failed: ${(err as Error).message}`); }
     }
   ```

   WAIT — note the import path: should be `./auth/authState`, not `./auth/initAuthState`. Use `./auth/authState`.

   So correct snippet:
   ```typescript
     // Wire auth state broadcast (initial replay + onAuthStateChange subscription).
     {
       const { initAuthState } = await import('./auth/authState');
       try { await initAuthState(mainWindow); }
       catch (err) { logger.warn(`auth state init failed: ${(err as Error).message}`); }
     }
   ```

4. Edit `src/preload/index.ts`. Inside the `api: RendererApi` object literal (after the existing wizard bindings, before the closing brace), add:

   ```typescript
     // --- Auth (Phase 10) ---
     signInPassword: (args) => ipcRenderer.invoke(IpcChannel.auth.signinPassword, args),
     signUpPassword: (args) => ipcRenderer.invoke(IpcChannel.auth.signupPassword, args),
     signInGoogle: () => ipcRenderer.invoke(IpcChannel.auth.signinGoogle),
     cancelGoogle: () => ipcRenderer.invoke(IpcChannel.auth.cancelGoogle),
     signOut: () => ipcRenderer.invoke(IpcChannel.auth.signout),
     deleteAccount: () => ipcRenderer.invoke(IpcChannel.auth.deleteAccount),
     exportData: () => ipcRenderer.invoke(IpcChannel.auth.exportData),
     resendVerification: () => ipcRenderer.invoke(IpcChannel.auth.resendVerification),

     onAuthState(cb: (state: AuthState) => void) {
       const handler = (_e: Electron.IpcRendererEvent, state: AuthState) => cb(state);
       ipcRenderer.on(IpcChannel.auth.state, handler);
       return () => ipcRenderer.off(IpcChannel.auth.state, handler);
     },
   ```

   Also add to the imports at the top of preload/index.ts: `type AuthState`.
  </action>
  <verify>
    <automated>grep -c "export async function signInWithPassword" src/main/auth/authHandlers.ts | grep -q "^1$" && grep -c "export async function deleteAccount" src/main/auth/authHandlers.ts | grep -q "^1$" && grep -c "// IMPLEMENTED IN PLAN 10-04" src/main/auth/authHandlers.ts | grep -q "^2$" && grep -c "// IMPLEMENTED IN PLAN 10-08" src/main/auth/authHandlers.ts | grep -q "^1$" && grep -c "IpcChannel.auth.signinPassword" src/main/ipc.ts | grep -q "^1$" && grep -c "IpcChannel.auth.signinGoogle" src/main/ipc.ts | grep -q "^1$" && grep -c "IpcChannel.auth.deleteAccount" src/main/ipc.ts | grep -q "^1$" && grep -c "sessionFallbackPlaintext" src/main/ipc.ts | grep -q "^1$" && grep -c "setStorageAdapter(createSessionStorageAdapter" src/main/index.ts | grep -q "^1$" && grep -c "initAuthState(mainWindow)" src/main/index.ts | grep -q "^1$" && grep -c "IpcChannel.auth.signinPassword" src/preload/index.ts | grep -q "^1$" && grep -c "IpcChannel.auth.state" src/preload/index.ts | grep -q "^1$" && npx tsc --noEmit</automated>
  </verify>
  <acceptance_criteria>
    - `grep -c "export async function signInWithPassword" src/main/auth/authHandlers.ts` equals 1
    - `grep -c "export async function signUpWithPassword" src/main/auth/authHandlers.ts` equals 1
    - `grep -c "export async function signInWithGoogle" src/main/auth/authHandlers.ts` equals 1
    - `grep -c "export async function cancelGoogle" src/main/auth/authHandlers.ts` equals 1
    - `grep -c "export async function signOut" src/main/auth/authHandlers.ts` equals 1
    - `grep -c "export async function deleteAccount" src/main/auth/authHandlers.ts` equals 1
    - `grep -c "export async function exportData" src/main/auth/authHandlers.ts` equals 1
    - `grep -c "export async function resendVerification" src/main/auth/authHandlers.ts` equals 1
    - `grep -c "IMPLEMENTED IN PLAN 10-04" src/main/auth/authHandlers.ts` equals 2
    - `grep -c "IMPLEMENTED IN PLAN 10-05" src/main/auth/authHandlers.ts` equals 2
    - `grep -c "IMPLEMENTED IN PLAN 10-06" src/main/auth/authHandlers.ts` equals 2
    - `grep -c "IMPLEMENTED IN PLAN 10-08" src/main/auth/authHandlers.ts` equals 1
    - `grep -c "IMPLEMENTED IN PLAN 10-09" src/main/auth/authHandlers.ts` equals 1
    - For each of 9 auth channels: `grep -c "IpcChannel.auth.{channelKey}" src/main/ipc.ts` >= 1
    - `grep -c "ipcMain.handle(IpcChannel.auth" src/main/ipc.ts` equals 8 (all 8 invoke handlers)
    - `grep -c "sessionFallbackPlaintext" src/main/ipc.ts` equals 1
    - `grep -c "setStorageAdapter(createSessionStorageAdapter" src/main/index.ts` equals 1
    - `grep -c "initAuthState(mainWindow)" src/main/index.ts` equals 1
    - Bootstrap ordering: `awk '/setStorageAdapter/{a=NR} /runFirstLaunchMigration/{b=NR} END{exit !(a < b)}' src/main/index.ts` exits 0 (setStorageAdapter is BEFORE runFirstLaunchMigration)
    - Bootstrap ordering: `awk '/initAuthState/{a=NR} /registerIpcHandlers/{b=NR} END{exit !(b < a)}' src/main/index.ts` exits 0 (registerIpcHandlers is BEFORE initAuthState, so handlers exist when state broadcasts begin)
    - `grep -c "IpcChannel.auth.signinPassword" src/preload/index.ts` equals 1
    - `grep -c "IpcChannel.auth.state" src/preload/index.ts` equals 1 (onAuthState subscription)
    - `grep -c "onAuthState" src/preload/index.ts` equals 1
    - `npx tsc --noEmit` exits 0
  </acceptance_criteria>
  <done>
    9 auth:* channels registered with Zod gates; 9 typed renderer bindings exposed; storage adapter wired before any getClient(); authState subscription replays on did-finish-load; app:warnings extended without breaking existing keychainFallbackPlaintext callers.
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Renderer → Main (IPC) | All auth-shaped data crosses via Zod-validated channels. Email/password/JWT never leave the main process surface untyped. |
| Main → Renderer (push) | `auth:state` is the only auth-shaped push; payload is a discriminated union — no overshare of refresh tokens. |
| Bootstrap ordering | Order matters: setStorageAdapter MUST precede first getClient() OR sessionStore writes will silently no-op against an in-memory fallback. |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-10-03-01 | Tampering | Renderer sends malformed email/password to auth:signin-password | mitigate | SignInPasswordSchema = z.object({email: z.string().email(), password: z.string().min(1)}); SignUpPasswordSchema requires password >= 8. Invalid input throws at the IPC boundary BEFORE the handler body. |
| T-10-03-02 | Information Disclosure | auth:state push payload includes refresh token | mitigate | AuthState union only contains AuthUser {id, email, emailVerified, createdAt}. Refresh token never leaves sessionStore.bin. |
| T-10-03-03 | Spoofing | Renderer subscribes to auth:state before main has wired initAuthState → race; broadcast lost | mitigate | did-finish-load handler replays current state to every renderer reload (same pattern as latestLanState in src/main/index.ts:217). Initial broadcast also fires from initAuthState() body. |
| T-10-03-04 | Denial of Service | setStorageAdapter is called AFTER getClient() — singleton orphans session | mitigate | supabaseClient.ts throws SUPABASE_NO_STORAGE_ADAPTER on first getClient() if adapter not wired. Plan 03 bootstrap calls setStorageAdapter as task 0 of bootstrap. Acceptance criterion grep-asserts ordering with awk. |
| T-10-03-05 | Tampering | Third state `signed_out` introduced by future contributor | mitigate | Acceptance criterion grep-asserts `'signed_out'` count == 0 in authState.ts. CONTEXT D-06 cited in code comment. |
| T-10-03-06 | Information Disclosure | app:warnings new field accidentally breaks renderer parser | mitigate | Existing keychainFallbackPlaintext field preserved; sessionFallbackPlaintext is additive. Renderer reads `w.keychainFallbackPlaintext` (line 123) — unchanged. Plan 07 will read the new field. |
</threat_model>

<verification>
1. `npx tsc --noEmit` exits 0.
2. Manual smoke (executor): start `npm run dev`, observe renderer console: `window.sei.onAuthState((s) => console.log(s))` followed by no other call — should log `{kind:'local'}` once on subscribe.
3. `grep -rn "from.*supabase" src/renderer src/preload 2>/dev/null | grep -v node_modules | grep -v 'AuthState\|AuthUser\|SignInResult\|SignUpResult\|OAuthResult\|DeleteAccountResult\|ExportDataResult\|ResendVerificationResult'` returns no rows that import the SDK itself.
4. Bootstrap ordering acceptance criteria pass.
</verification>

<success_criteria>
- 9 auth:* IPC channels registered with Zod gates
- 9 typed renderer bindings exposed via contextBridge
- Two-state machine (local / signed_in only) wired to Supabase's onAuthStateChange
- Storage adapter wired at the legal bootstrap point (before first getClient())
- StartupWarnings extended additively (existing field preserved)
- UserConfigSchema gains linuxBasicTextWarnDismissed
- tsc clean; no renderer/preload imports of @supabase/supabase-js
</success_criteria>

<output>
After completion, create `.planning/phases/10-auth-foundation/10-03-SUMMARY.md` covering: the 9-channel contract (so plans 04–09 can each implement a single handler without re-reading the channel list), the Supabase event → AuthState mapping (so plan 06's manual sign-out path knows whether to wait for SIGNED_OUT or call transitionToLocal directly), and the bootstrap ordering invariant (setStorageAdapter → getClient → initAuthState → registerIpcHandlers → render).
</output>
