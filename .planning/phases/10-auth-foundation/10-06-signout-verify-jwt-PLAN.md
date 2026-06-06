---
phase: 10
plan: 06
type: execute
wave: 4
depends_on: [10-03, 10-04, 10-05]
files_modified:
  - src/main/auth/authHandlers.ts
  - src/main/auth/jwtBridge.ts
  - src/main/auth/authState.ts
  - src/main/botSupervisor.ts
  - src/main/index.ts
  - src/renderer/src/components/SignOutConfirmModal.tsx
  - src/renderer/src/components/SignOutConfirmModal.module.css
  - src/renderer/src/App.tsx
autonomous: false
requirements: [AUTH-05]
requirements_addressed: [AUTH-05]
tags: [signout, jwt, utility-process, verify-email, banner]
must_haves:
  truths:
    - "Sign-out calls getClient().auth.signOut(), which fires SIGNED_OUT → authState transitions to local → renderer drops to local mode WITHOUT screen transition (D-09; AUTH-05 invariant)"
    - "Local character files (<userData>/characters/), local memory (<userData>/memory/), and cached cloud character definitions are NEVER touched by sign-out (AUTH-05 invariant)"
    - "Sign-out while bot is running calls deps.supervisor.stop() BEFORE auth.signOut() so the bot disconnects cleanly (D-09 single confirmation modal)"
    - "JWT delivery to utilityProcess via MessagePortMain — main pushes a fresh JWT immediately on TOKEN_REFRESHED events (Pitfall A4)"
    - "VerifyEmailBanner renders at the top of MainApp shell whenever authState.kind === 'signed_in' && !user.emailVerified (D-04, UI-SPEC §Persistent Banner)"
    - "Banner is NOT dismissable (onDismiss omitted per UI-SPEC); disappears only when emailVerified flips to true via Pitfall A6 USER_UPDATED event"
    - "resendVerification calls getClient().auth.resend({type:'signup', email:user.email}); rate-limited by Supabase (60s) — maps 429 → {ok:false, code:'rate_limited'}"
    - "SignOutConfirmModal title differs based on bot-running state: 'Sign out?' vs 'Sign out will stop your bot. Continue?' (UI-SPEC §Sign-out flow)"
    - "SignOutConfirmModal dismissal label is exactly 'Stay signed in'; confirm button is exactly 'Sign out' with kind='primary' (NOT accent, NOT red — D-09 + UI-SPEC)"
  artifacts:
    - path: "src/main/auth/authHandlers.ts"
      provides: "Implemented signOut and resendVerification bodies (replacing plan 03 shells)"
      contains: "auth.signOut"
    - path: "src/main/auth/jwtBridge.ts"
      provides: "Subscribes to TOKEN_REFRESHED + SIGNED_IN/SIGNED_OUT and pushes the new JWT (or null) to utilityProcess via MessagePortMain"
      exports: ["initJwtBridge", "pushJwtToUtility"]
    - path: "src/main/botSupervisor.ts"
      provides: "Extended init payload includes initialJwt:string|null; new updateJwt(jwt:string|null) method that postMessages {type:'jwt', jwt} to the active session's port1"
      contains: "updateJwt"
    - path: "src/renderer/src/components/SignOutConfirmModal.tsx"
      provides: "Two-branch (bot-running / not-running) sign-out confirm modal with 'Stay signed in' dismissal + 'Sign out' primary confirm"
      exports: ["SignOutConfirmModal"]
    - path: "src/renderer/src/App.tsx"
      provides: "Renders VerifyEmailBanner (existing Banner component, kind='warn', not dismissable) when signed_in && !emailVerified"
      contains: "VerifyEmailBanner\\|emailVerified"
  key_links:
    - from: "src/main/auth/jwtBridge.ts"
      to: "src/main/botSupervisor.ts (updateJwt)"
      via: "supervisor.updateJwt(jwt) on TOKEN_REFRESHED or SIGNED_IN/OUT"
      pattern: "updateJwt"
    - from: "src/main/auth/authHandlers.ts (signOut)"
      to: "src/main/botSupervisor.ts (stop)"
      via: "supervisor.stop() called BEFORE auth.signOut() when bot is active"
      pattern: "supervisor\\.stop"
    - from: "src/renderer/src/App.tsx"
      to: "src/renderer/src/components/Banner.tsx"
      via: "<Banner kind='warn' message='Verify your email...' /> rendered when authState.kind === 'signed_in' && !user.emailVerified"
      pattern: "Banner.*Verify"
    - from: "src/renderer/src/components/SignOutConfirmModal.tsx"
      to: "window.sei.signOut"
      via: "sei.signOut() called on confirm"
      pattern: "sei\\.signOut"
---

<objective>
Ship the sign-out flow, the verify-email Banner, the resend-verification path, and the JWT-to-utilityProcess delivery wiring:

1. `src/main/auth/authHandlers.ts` — implement `signOut` (with bot-stop ordering) and `resendVerification`.
2. `src/main/auth/jwtBridge.ts` — subscribe to Supabase events and push the current JWT (or null on signed-out) to utilityProcess via the existing MessagePortMain channel. Phase 13 is the consumer; Phase 10 verifies the wiring (the bot doesn't USE the JWT yet, but it receives it).
3. `src/main/botSupervisor.ts` — extend init payload with `initialJwt:string|null`; add `updateJwt(jwt)` method that postMessages to the active session.
4. `src/main/index.ts` — call `initJwtBridge(supervisor)` from bootstrap.
5. `src/renderer/src/components/SignOutConfirmModal.tsx` — two-branch (bot-running / not-running) confirm with UI-SPEC copy.
6. `src/renderer/src/App.tsx` — render VerifyEmailBanner at top of MainApp when signed_in && !emailVerified.

Purpose: AUTH-05 ships (sign-out preserves local data); D-09 single-confirmation modal lands; D-04 verify-email Banner lands; the JWT-to-utilityProcess channel is wired so Phase 13 can drop in without re-architecting the bot loop.

Output: 2 handler bodies, 1 new main module, 2 edits to botSupervisor/index, 1 new modal+CSS, 1 small edit to App.tsx.
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
@src/main/botSupervisor.ts
@src/main/index.ts
@src/renderer/src/App.tsx
@src/renderer/src/components/Banner.tsx
@src/renderer/src/components/DeleteConfirmModal.tsx
@src/renderer/src/lib/stores/useAuthStore.ts
@.planning/phases/10-auth-foundation/10-03-SUMMARY.md
@.planning/phases/10-auth-foundation/10-04-SUMMARY.md

<interfaces>
<!-- Supabase events of interest (from @supabase/supabase-js): -->
'SIGNED_IN' | 'SIGNED_OUT' | 'TOKEN_REFRESHED' | 'USER_UPDATED'

<!-- The supervisor's existing message vocabulary (from botSupervisor.ts):
     port1.postMessage({type: 'stop'}); → bot disconnects.
     This plan ADDS a new outbound message {type: 'jwt', jwt: string | null}.
     The bot itself (utilityProcess) gets the jwt but does NOT consume it in
     Phase 10 — Phase 13's proxy is the consumer. -->
</interfaces>
</context>

<read_first>
- `src/main/auth/authHandlers.ts` (plan 03 shells for signOut + resendVerification)
- `src/main/auth/authState.ts` (plan 03 — `_disposeForTests` / how subscription works; jwtBridge mirrors the same subscription pattern)
- `src/main/auth/supabaseClient.ts` (getClient)
- `src/main/botSupervisor.ts` (find the message channel setup around line 265 and the init payload around the supervisor.summon path; identify where to add updateJwt)
- `src/main/index.ts` (bootstrap order — jwtBridge wiring goes after supervisor creation)
- `src/renderer/src/App.tsx` (Banner usage pattern lines 207–222; the VerifyEmailBanner goes in the same stack)
- `src/renderer/src/components/Banner.tsx` (kind='warn', message, onDismiss optional)
- `src/renderer/src/components/DeleteConfirmModal.tsx` + .module.css (template for SignOutConfirmModal — only the button kinds differ)
- `src/renderer/src/lib/stores/useAuthStore.ts` (plan 04 — read state from here)
- `src/renderer/src/lib/stores/useDataStore.ts` (read `summon` to determine bot-running)
- `.planning/phases/10-auth-foundation/10-UI-SPEC.md` §Sign-out flow (D-09 copy verbatim), §Persistent "Verify your email" Banner (D-04), §Empty/Error/Loading (resend-verification copy)
- `.planning/phases/10-auth-foundation/10-CONTEXT.md` D-04, D-09
- `.planning/phases/10-auth-foundation/10-RESEARCH.md` §Pitfall A4 (JWT staleness in utilityProcess), §Pitfall A6 (email-verification flip detection)
</read_first>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Implement signOut + resendVerification + jwtBridge.ts + extend botSupervisor</name>
  <files>src/main/auth/authHandlers.ts, src/main/auth/jwtBridge.ts, src/main/botSupervisor.ts, src/main/index.ts</files>
  <read_first>
    - src/main/auth/authHandlers.ts (plan 03 shells)
    - src/main/auth/supabaseClient.ts (getClient — for auth.signOut, auth.resend)
    - src/main/auth/authState.ts (for getCurrentAuthState — used by jwtBridge initial push)
    - src/main/botSupervisor.ts (full file — find the MessageChannelMain creation line, the init payload posted to utilityProcess, the supervisor's exported interface; ADD updateJwt without breaking existing surfaces)
    - src/main/index.ts (locate where supervisor is created and registerIpcHandlers runs; jwtBridge wires after both)
    - .planning/phases/10-auth-foundation/10-RESEARCH.md §Pitfall A4 (push on TOKEN_REFRESHED, also on SIGNED_OUT to push null)
  </read_first>
  <behavior>
    - signOut handler:
      1. Read the dependency-injected supervisor reference (the handler module needs access — see step in action below).
      2. If supervisor has an active session (supervisor.getActiveId() !== null), call await supervisor.stop().
      3. Call await getClient().auth.signOut().
      4. Return void.
      Errors at any step are SWALLOWED with a logger.warn (sign-out must always result in a local state, never leave the user stuck in a halfway state). On stop() or signOut() throw → still call transitionToLocal() to force the renderer to drop to local mode immediately.
    - resendVerification handler:
      1. Read current auth state via getCurrentAuthState(); if kind !== 'signed_in', return {ok:false, code:'network', message:'Not signed in'}.
      2. Call getClient().auth.resend({type:'signup', email:user.email}).
      3. On success → {ok:true}. On 429 / 'rate limit' error → {ok:false, code:'rate_limited', message:'Hold on — wait a minute before requesting another link.'}. Other errors → {ok:false, code:'network', message:'Couldn't resend verification.'}.
      4. Wrap with 15s withTimeout (reused from plan 04).
    - jwtBridge.ts:
      - initJwtBridge(supervisor) subscribes to getClient().auth.onAuthStateChange. On SIGNED_IN, TOKEN_REFRESHED, INITIAL_SESSION events, push session.access_token to supervisor.updateJwt(...). On SIGNED_OUT, push null.
      - The initial push happens immediately after subscription so the supervisor starts with the current JWT (if any).
      - Exposes pushJwtToUtility(jwt:string|null) for tests / direct calls.
    - botSupervisor extension:
      - Add to BotSupervisor interface: `updateJwt(jwt: string | null): void;`
      - Track the latest JWT in a module-local variable inside createBotSupervisor.
      - When a new session is started (_summon flow), include `initialJwt: latestJwt` in the init payload posted to the utilityProcess via port2.
      - When updateJwt is called while a session is active, postMessage `{type: 'jwt', jwt}` to the active session's port1.
      - When no session is active, just store the JWT; next summon's init payload picks it up.
      - utilityProcess in Phase 10 will receive the message but doesn't yet act on it — that's Phase 13. Add a console.log in the utilityProcess bot entry (src/utility/...) to acknowledge receipt? NO: do not touch utilityProcess code in Phase 10 (per CONTEXT Claude's discretion: "Phase 10 wires it; Phase 13 consumes"). The new {type:'jwt'} message will be ignored by the utilityProcess message handler — that's expected.
    - src/main/index.ts: after `supervisor = createBotSupervisor(...)`, call:
      ```typescript
      import { initJwtBridge } from './auth/jwtBridge';
      try { await initJwtBridge(supervisor); }
      catch (err) { logger.warn(`jwt bridge init failed: ${(err as Error).message}`); }
      ```
    - Tests: vitest for jwtBridge — mock supabaseClient.getClient. Three cases:
      1. On SIGNED_IN event with session.access_token='jwt-A', supervisor.updateJwt('jwt-A') was called once.
      2. On TOKEN_REFRESHED with new token 'jwt-B', supervisor.updateJwt('jwt-B') was called.
      3. On SIGNED_OUT, supervisor.updateJwt(null) was called.
  </behavior>
  <action>
1. Edit `src/main/auth/authHandlers.ts`:

   (a) Add imports:
   ```typescript
   import { getClient } from './supabaseClient';
   import { getCurrentAuthState } from './authState';
   import type { BotSupervisor } from '../botSupervisor';
   import { logger } from '../logger'; // verify exact path; existing logger import pattern in main/
   ```

   (b) Add a DI registration for the supervisor reference (handlers need it for signOut):
   ```typescript
   let supervisorRef: BotSupervisor | null = null;
   /** Called by src/main/ipc.ts during registerIpcHandlers; sets the supervisor handle for signOut's bot-stop step. */
   export function setSupervisor(s: BotSupervisor): void { supervisorRef = s; }
   ```

   And in `src/main/ipc.ts` registerIpcHandlers — right before the // === Auth (Phase 10) === section — add:
   ```typescript
     // Wire supervisor handle for signOut's bot-stop ordering.
     {
       const { setSupervisor } = await import('./auth/authHandlers');
       setSupervisor(deps.supervisor);
     }
   ```

   Actually the cleaner solution: pass deps in directly — refactor handlers to receive deps. The minimal-diff path is the setSupervisor helper above. Use that.

   (c) Replace `signOut`:
   ```typescript
   export async function signOut(): Promise<void> {
     // Per D-09: if bot is running, stop it BEFORE clearing the session so
     // the disconnect is clean. The user has already confirmed via the modal.
     if (supervisorRef && supervisorRef.getActiveId() !== null) {
       try { await supervisorRef.stop(); }
       catch (err) { logger.warn(`signOut: bot stop failed: ${(err as Error).message}`); }
     }
     try { await getClient().auth.signOut(); }
     catch (err) {
       // AUTH-05 invariant: sign-out must always result in local mode, even on
       // network failure. Force the state transition so the renderer is consistent.
       logger.warn(`signOut: supabase.auth.signOut failed: ${(err as Error).message}`);
       const { transitionToLocal } = await import('./authState');
       transitionToLocal();
     }
   }
   ```

   (d) Replace `resendVerification`:
   ```typescript
   export async function resendVerification(): Promise<ResendVerificationResult> {
     const state = getCurrentAuthState();
     if (state.kind !== 'signed_in') {
       return { ok: false, code: 'network', message: 'Not signed in' };
     }
     try {
       const { error } = await withTimeout(
         getClient().auth.resend({ type: 'signup', email: state.user.email }),
         15_000,
         () => ({ error: { message: 'timeout', status: 0 } as { message: string; status?: number } }),
       );
       if (error) {
         const m = error.message.toLowerCase();
         const status = (error as { status?: number }).status;
         if (status === 429 || m.includes('rate limit')) {
           return { ok: false, code: 'rate_limited', message: 'Hold on — wait a minute before requesting another link.' };
         }
         return { ok: false, code: 'network', message: "Couldn't resend verification." };
       }
       return { ok: true };
     } catch (err) {
       return { ok: false, code: 'network', message: (err as Error).message };
     }
   }
   ```

   Delete the `// IMPLEMENTED IN PLAN 10-06` comments.

2. Create `src/main/auth/jwtBridge.ts`:

```typescript
/**
 * JWT delivery from main process to utilityProcess.
 *
 * Subscribes to Supabase auth events; on SIGNED_IN / TOKEN_REFRESHED /
 * INITIAL_SESSION pushes the current access_token (JWT) to the bot
 * supervisor, which forwards to the running utilityProcess (if any) over
 * MessagePortMain. On SIGNED_OUT pushes null.
 *
 * Phase 10 wires this. Phase 13's proxy is the JWT consumer (the bot will
 * use it as a Bearer header when cloud-AI mode is selected). In Phase 10
 * the bot loop ignores the {type:'jwt'} message — that's fine; the wiring
 * is verified in plan 06's checkpoint.
 *
 * Sources:
 *   - 10-CONTEXT Claude's discretion (JWT-only crosses to utilityProcess)
 *   - 10-RESEARCH §Pitfall A4 (push on TOKEN_REFRESHED to avoid stale-JWT bot stop)
 */
import { getClient } from './supabaseClient';
import type { BotSupervisor } from '../botSupervisor';

let supervisorRef: BotSupervisor | null = null;

export async function initJwtBridge(supervisor: BotSupervisor): Promise<void> {
  supervisorRef = supervisor;
  const supabase = getClient();

  // Push initial token immediately so supervisor.updateJwt has a value
  // before the first summon. getSession() reads from the storage adapter.
  const { data: { session } } = await supabase.auth.getSession();
  supervisor.updateJwt(session?.access_token ?? null);

  supabase.auth.onAuthStateChange((event, session) => {
    if (!supervisorRef) return;
    switch (event) {
      case 'SIGNED_IN':
      case 'TOKEN_REFRESHED':
      case 'INITIAL_SESSION':
      case 'USER_UPDATED':
        supervisorRef.updateJwt(session?.access_token ?? null);
        break;
      case 'SIGNED_OUT':
        supervisorRef.updateJwt(null);
        break;
      case 'PASSWORD_RECOVERY':
        // No-op in Phase 10.
        break;
    }
  });
}

/** TEST-ONLY: directly invoke the push path without going through Supabase. */
export function pushJwtToUtility(jwt: string | null): void {
  supervisorRef?.updateJwt(jwt);
}

/** TEST-ONLY: reset for clean test isolation. */
export function _disposeForTests(): void {
  supervisorRef = null;
}
```

3. Edit `src/main/botSupervisor.ts`:

   (a) Extend the exported BotSupervisor interface (around line 108) to add:
   ```typescript
     updateJwt(jwt: string | null): void;
   ```

   (b) Inside createBotSupervisor, add module-local state:
   ```typescript
     let latestJwt: string | null = null;
   ```

   (c) In the session-start path (where the init payload is posted to the utilityProcess via port2.postMessage — around line 380–390 area, after `const { port1, port2 } = new MessageChannelMain();`), include `initialJwt: latestJwt` in the init payload. Read the existing init message shape and add the field (do NOT change any other field). Example:
   ```typescript
     // Before: port2.postMessage({type: 'init', characterId, skinServerBaseUrl, ...});
     // After: include initialJwt
     port2.postMessage({
       type: 'init',
       characterId,
       skinServerBaseUrl,
       initialJwt: latestJwt,
       // ... other existing fields ...
     });
   ```

   (d) Add the updateJwt method to the returned supervisor object (around line 478–486 where stop/shutdown/etc. are defined):
   ```typescript
     updateJwt: (jwt: string | null) => {
       latestJwt = jwt;
       if (active && active.port1) {
         try { active.port1.postMessage({ type: 'jwt', jwt }); }
         catch { /* port closed during teardown; ignore */ }
       }
     },
   ```

4. Edit `src/main/index.ts`:

   After `supervisor = createBotSupervisor(...)` and `registerIpcHandlers({...})` calls (around line 245), add:
   ```typescript
     // Phase 10: JWT bridge — pushes access_token to supervisor on every Supabase auth event.
     try {
       const { initJwtBridge } = await import('./auth/jwtBridge');
       await initJwtBridge(supervisor);
     } catch (err) {
       logger.warn(`jwt bridge init failed: ${(err as Error).message}`);
     }
   ```

5. Create `src/main/auth/jwtBridge.test.ts` with 3 vitest cases (mock supabaseClient.getClient + supervisor):

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { initJwtBridge, _disposeForTests } from './jwtBridge';

const onAuthStateChangeMock = vi.fn();
const getSessionMock = vi.fn();

vi.mock('./supabaseClient', () => ({
  getClient: () => ({
    auth: {
      onAuthStateChange: onAuthStateChangeMock,
      getSession: getSessionMock,
    },
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  _disposeForTests();
});

function makeSupervisorStub(): { updateJwt: any } {
  return { updateJwt: vi.fn() };
}

describe('jwtBridge', () => {
  it('pushes the initial token to supervisor on init', async () => {
    getSessionMock.mockResolvedValue({ data: { session: { access_token: 'jwt-initial' } } });
    onAuthStateChangeMock.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } });
    const sup = makeSupervisorStub();
    await initJwtBridge(sup as any);
    expect(sup.updateJwt).toHaveBeenCalledWith('jwt-initial');
  });

  it('pushes new JWT on TOKEN_REFRESHED', async () => {
    getSessionMock.mockResolvedValue({ data: { session: null } });
    let cb: any;
    onAuthStateChangeMock.mockImplementation((fn) => { cb = fn; return { data: { subscription: { unsubscribe: vi.fn() } } }; });
    const sup = makeSupervisorStub();
    await initJwtBridge(sup as any);
    cb('TOKEN_REFRESHED', { access_token: 'jwt-refreshed' });
    expect(sup.updateJwt).toHaveBeenLastCalledWith('jwt-refreshed');
  });

  it('pushes null on SIGNED_OUT', async () => {
    getSessionMock.mockResolvedValue({ data: { session: null } });
    let cb: any;
    onAuthStateChangeMock.mockImplementation((fn) => { cb = fn; return { data: { subscription: { unsubscribe: vi.fn() } } }; });
    const sup = makeSupervisorStub();
    await initJwtBridge(sup as any);
    cb('SIGNED_OUT', null);
    expect(sup.updateJwt).toHaveBeenLastCalledWith(null);
  });
});
```
  </action>
  <verify>
    <automated>! grep -q "IMPLEMENTED IN PLAN 10-06" src/main/auth/authHandlers.ts && grep -c "auth.signOut" src/main/auth/authHandlers.ts | grep -q "^1$" && grep -c "supervisorRef" src/main/auth/authHandlers.ts | grep -qE "^[2-9]" && grep -c "auth.resend" src/main/auth/authHandlers.ts | grep -q "^1$" && grep -c "rate_limited" src/main/auth/authHandlers.ts | grep -qE "^[2-9]" && grep -c "export async function initJwtBridge" src/main/auth/jwtBridge.ts | grep -q "^1$" && grep -c "updateJwt" src/main/botSupervisor.ts | grep -qE "^[3-9]" && grep -c "initialJwt" src/main/botSupervisor.ts | grep -qE "^[1-9]" && grep -c "initJwtBridge(supervisor)" src/main/index.ts | grep -q "^1$" && npx vitest run src/main/auth/jwtBridge.test.ts && npx tsc --noEmit</automated>
  </verify>
  <acceptance_criteria>
    - `grep -c "IMPLEMENTED IN PLAN 10-06" src/main/auth/authHandlers.ts` equals 0
    - `grep -c "auth.signOut" src/main/auth/authHandlers.ts` equals 1
    - `grep -c "supervisorRef" src/main/auth/authHandlers.ts` >= 2
    - `grep -c "setSupervisor" src/main/auth/authHandlers.ts` equals 1
    - `grep -c "setSupervisor" src/main/ipc.ts` equals 1
    - `grep -c "auth.resend" src/main/auth/authHandlers.ts` equals 1
    - `grep -c "rate_limited" src/main/auth/authHandlers.ts` >= 2 (signIn + resendVerification)
    - `grep -c "export async function initJwtBridge" src/main/auth/jwtBridge.ts` equals 1
    - `grep -c "TOKEN_REFRESHED" src/main/auth/jwtBridge.ts` equals 1
    - `grep -c "SIGNED_OUT" src/main/auth/jwtBridge.ts` equals 1
    - `grep -c "access_token" src/main/auth/jwtBridge.ts` >= 2
    - `grep -c "updateJwt" src/main/botSupervisor.ts` >= 3 (interface decl + module state + impl)
    - `grep -c "initialJwt" src/main/botSupervisor.ts` >= 1 (init payload field)
    - `grep -c "type: 'jwt'" src/main/botSupervisor.ts` equals 1
    - `grep -c "initJwtBridge(supervisor)" src/main/index.ts` equals 1
    - Bootstrap ordering: `awk '/initJwtBridge/{a=NR} /createBotSupervisor/{b=NR} END{exit !(b < a)}' src/main/index.ts` exits 0 (initJwtBridge runs AFTER createBotSupervisor)
    - `npx vitest run src/main/auth/jwtBridge.test.ts` exits 0 with 3 passing tests
    - `grep -rn "from.*auth/jwtBridge" src/renderer src/preload src/utility 2>/dev/null | grep -v node_modules | wc -l` returns 0
    - `npx tsc --noEmit` exits 0
  </acceptance_criteria>
  <done>
    signOut wires supervisor.stop before auth.signOut; resendVerification calls Supabase auth.resend with rate-limit mapping; jwtBridge subscribes and pushes on every relevant event; supervisor.updateJwt wired into the existing message channel; 3 vitest cases pass.
  </done>
</task>

<task type="auto" tdd="false">
  <name>Task 2: SignOutConfirmModal + VerifyEmailBanner integration in App.tsx</name>
  <files>src/renderer/src/components/SignOutConfirmModal.tsx, src/renderer/src/components/SignOutConfirmModal.module.css, src/renderer/src/App.tsx</files>
  <read_first>
    - src/renderer/src/components/DeleteConfirmModal.tsx + .module.css (template — clone shape; ONLY the button kinds differ)
    - src/renderer/src/components/Banner.tsx (kind='warn', onDismiss optional)
    - src/renderer/src/App.tsx (Banner stack at lines 215–222; VerifyEmailBanner joins this stack)
    - src/renderer/src/lib/stores/useAuthStore.ts (state.user.emailVerified)
    - src/renderer/src/lib/stores/useDataStore.ts (summon — to derive bot-running for SignOutConfirmModal)
    - .planning/phases/10-auth-foundation/10-UI-SPEC.md §Sign-out flow (D-09 copy verbatim), §Persistent "Verify your email" Banner (D-04), §Layout & Composition Rules rule 7 (Banner stacking)
  </read_first>
  <behavior>
    - SignOutConfirmModal props: { botRunning: boolean; onCancel: () => void; onConfirm: () => Promise<void> }.
    - Title: 'Sign out?' (botRunning=false) OR 'Sign out will stop your bot. Continue?' (botRunning=true).
    - Body: 'Your local characters, memory, and saved API key stay on this machine.' (both branches; AUTH-05 framing).
    - Dismissal button (ghost, kind='ghost'): 'Stay signed in'.
    - Confirm button: kind='primary' (NOT 'accent', NOT 'destructive'/red — UI-SPEC D-09). Label: 'Sign out'. While onConfirm is in flight, label becomes 'Signing out…' and button is disabled.
    - Scrim+modal CSS identical to DeleteConfirmModal: 460px width, 32px padding, sharp corners, 0.45 scrim alpha. ESC closes; click-outside closes.
    - VerifyEmailBanner in App.tsx: When `authState.kind === 'signed_in' && !authState.user.emailVerified`, render `<Banner kind="warn" message="Verify your email to publish characters or buy credits. Check your inbox for a link from Sei." />` ABOVE the existing keychain Banner. NOT dismissable (onDismiss omitted per UI-SPEC).
    - VerifyEmailBanner appears in the existing Banner stack (lines 215–222 area of App.tsx). Stacking order (UI-SPEC §Layout rule 7): VerifyEmail first (top), keychain Banner second (below).
    - SignOutConfirmModal is NOT mounted in plan 06's App.tsx by default — plan 07 mounts it from the Settings Account panel. Plan 06 only ships the component; integration is handled by plan 07.
  </behavior>
  <action>
1. Create `src/renderer/src/components/SignOutConfirmModal.module.css` — copy from `DeleteConfirmModal.module.css` verbatim, then change the `.confirmBtn` rule to use `var(--text)` background instead of `var(--red)`. (Actually plan: use the existing Button component for the confirm — clone of DeleteConfirmModal.module.css unchanged is fine, the destructive `.deleteBtn` class is just unused in our SignOutConfirmModal.) Read DeleteConfirmModal.module.css; if cloning is messier than reuse, import its styles directly. Recommended: create a slim SignOutConfirmModal.module.css with only the SCRIM + MODAL + TITLE + BODY + FOOTER classes (no .deleteBtn — confirm uses `<Button kind='primary'>`).

   ```css
   /* Mirrors DeleteConfirmModal.module.css scaffold; no destructive button class. */
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
   }
   .title {
     font-size: 22px; font-weight: 600; line-height: 1.2; letter-spacing: -0.2px;
     color: var(--text); margin: 0 0 var(--space-md-plus);
   }
   .body {
     font-size: 15px; line-height: 1.5; color: var(--text-2); margin: 0 0 var(--space-lg);
   }
   .footer {
     display: flex; justify-content: flex-end; gap: var(--space-md);
   }
   @keyframes fade { from {opacity:0} to {opacity:1} }
   @keyframes fadeUp { from {opacity:0; transform:translateY(8px)} to {opacity:1; transform:none} }
   @media (prefers-reduced-motion: reduce) {
     .scrim, .modal { animation: none; }
   }
   ```

2. Create `src/renderer/src/components/SignOutConfirmModal.tsx`:

```tsx
/**
 * SignOutConfirmModal — single-confirmation modal for sign-out (D-09).
 *
 * Two title branches based on bot-running state. Body is identical in both
 * branches — emphasizes what's preserved (AUTH-05 framing).
 *
 * Confirm button is kind='primary' (NOT 'accent', NOT 'destructive') — D-09
 * says sign-out is reversible and preserves local data, so it does not warrant
 * the red destructive treatment.
 *
 * Dismissal label: 'Stay signed in' (UI-SPEC dismissal-label policy).
 *
 * Source: 10-UI-SPEC §Sign-out flow (D-09) + Copywriting Contract.
 */
import React, { useEffect, useState } from 'react';
import { Button } from './Button';
import styles from './SignOutConfirmModal.module.css';

export interface SignOutConfirmModalProps {
  botRunning: boolean;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}

export function SignOutConfirmModal({ botRunning, onCancel, onConfirm }: SignOutConfirmModalProps): React.ReactElement {
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape' && !submitting) onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, submitting]);

  const handleConfirm = async (): Promise<void> => {
    setSubmitting(true);
    try { await onConfirm(); }
    finally { setSubmitting(false); }
  };

  const title = botRunning ? 'Sign out will stop your bot. Continue?' : 'Sign out?';
  const ctaLabel = submitting ? 'Signing out…' : 'Sign out';

  const titleId = 'signout-confirm-title';
  return (
    <div className={styles.scrim} role="dialog" aria-modal="true" aria-labelledby={titleId}
         onClick={(e) => { if (e.target === e.currentTarget && !submitting) onCancel(); }}>
      <div className={styles.modal}>
        <h2 id={titleId} className={styles.title}>{title}</h2>
        <p className={styles.body}>Your local characters, memory, and saved API key stay on this machine.</p>
        <div className={styles.footer}>
          <Button kind="ghost" size="md" onClick={onCancel} disabled={submitting}>Stay signed in</Button>
          <Button kind="primary" size="md" onClick={handleConfirm} disabled={submitting}>{ctaLabel}</Button>
        </div>
      </div>
    </div>
  );
}
```

3. Edit `src/renderer/src/App.tsx`:

   (a) Import the auth store hook and the Banner:
   ```typescript
   // Banner is already imported in App.tsx (line 42). Just consume authState.
   ```

   (b) Get authState (already added by plan 04). Inside the existing Banner stack (lines 215–222), ADD the VerifyEmailBanner ABOVE the keychain banner:

   ```tsx
   <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }}>
     {/* Phase 10: VerifyEmailBanner (D-04) — top of stack per UI-SPEC §Layout rule 7. Not dismissable. */}
     {authState.kind === 'signed_in' && !authState.user.emailVerified ? (
       <Banner
         kind="warn"
         message="Verify your email to publish characters or buy credits. Check your inbox for a link from Sei."
       />
     ) : null}
     {warnings.keychainFallbackPlaintext && !warnings.dismissed ? (
       <Banner
         kind="warn"
         message={ERROR_COPY.KEYCHAIN_FALLBACK_PLAINTEXT}
         onDismiss={() => setWarnings((w) => ({ ...w, dismissed: true }))}
       />
     ) : null}
     {/* ... rest of the existing structure unchanged ... */}
   </div>
   ```

   (c) Optionally: on USER_UPDATED-driven emailVerified flip, no manual refresh needed — the Banner naturally disappears on the next re-render (authState push from main updates the store). Pitfall A6 recommends also calling `supabase.auth.refreshSession()` on window-focus when emailVerified is false — punt this to a follow-up unless trivial. For now, comment in the JSX:
   ```tsx
   {/* Pitfall A6 follow-up: optionally trigger supabase.auth.refreshSession() on window focus when !emailVerified to pick up email_confirmed_at flip faster. */}
   ```
  </action>
  <verify>
    <automated>grep -cF "Sign out?" src/renderer/src/components/SignOutConfirmModal.tsx | grep -q "^1$" && grep -cF "Sign out will stop your bot. Continue?" src/renderer/src/components/SignOutConfirmModal.tsx | grep -q "^1$" && grep -cF "Stay signed in" src/renderer/src/components/SignOutConfirmModal.tsx | grep -q "^1$" && grep -cF "Your local characters, memory, and saved API key stay on this machine." src/renderer/src/components/SignOutConfirmModal.tsx | grep -q "^1$" && grep -cF 'kind="primary"' src/renderer/src/components/SignOutConfirmModal.tsx | grep -q "^1$" && ! grep -qE 'kind="(accent|destructive)"' src/renderer/src/components/SignOutConfirmModal.tsx && grep -cF "Verify your email to publish characters or buy credits. Check your inbox for a link from Sei." src/renderer/src/App.tsx | grep -q "^1$" && grep -cE "emailVerified" src/renderer/src/App.tsx | grep -qE "^[1-9]" && grep -cE "width: 460px" src/renderer/src/components/SignOutConfirmModal.module.css | grep -q "^1$" && npx tsc --noEmit</automated>
  </verify>
  <acceptance_criteria>
    - `grep -cF "Sign out?" src/renderer/src/components/SignOutConfirmModal.tsx` equals 1
    - `grep -cF "Sign out will stop your bot. Continue?" src/renderer/src/components/SignOutConfirmModal.tsx` equals 1
    - `grep -cF "Stay signed in" src/renderer/src/components/SignOutConfirmModal.tsx` equals 1
    - `grep -cF "Your local characters, memory, and saved API key stay on this machine." src/renderer/src/components/SignOutConfirmModal.tsx` equals 1
    - `grep -cF 'kind="primary"' src/renderer/src/components/SignOutConfirmModal.tsx` equals 1 (the confirm button)
    - `grep -cE 'kind="(accent|destructive)"' src/renderer/src/components/SignOutConfirmModal.tsx` equals 0
    - `grep -cF "Signing out…" src/renderer/src/components/SignOutConfirmModal.tsx` equals 1
    - `grep -cE "width: 460px" src/renderer/src/components/SignOutConfirmModal.module.css` equals 1
    - `grep -cE "rgba\\(0, 0, 0, 0\\.45\\)" src/renderer/src/components/SignOutConfirmModal.module.css` equals 1
    - `grep -cF "Verify your email to publish characters or buy credits. Check your inbox for a link from Sei." src/renderer/src/App.tsx` equals 1
    - `grep -cF "emailVerified" src/renderer/src/App.tsx` >= 1
    - VerifyEmailBanner is NOT dismissable: `grep -B1 -A6 "Verify your email to publish" src/renderer/src/App.tsx | grep -c "onDismiss"` equals 0
    - `npx tsc --noEmit` exits 0
  </acceptance_criteria>
  <done>
    SignOutConfirmModal renders both bot-running and not-running variants with UI-SPEC copy verbatim and primary (not accent / not destructive) confirm; VerifyEmailBanner renders unconditionally at top of MainApp when signed_in && !emailVerified, not dismissable.
  </done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task 3 (checkpoint): Sign-out + JWT-to-utilityProcess + verify-email Banner end-to-end</name>
  <files>none — human verification of prior code-producing tasks</files>
  <action>Perform the verification steps listed under <how-to-verify> below. The executor must NOT skip; this checkpoint gates the wave.</action>
  <verify>
    <automated>echo "human checkpoint — see how-to-verify below"; true</automated>
  </verify>
  <done>User has replied "approved" to the resume signal below.</done>
  <what-built>
    Sign-out flow (preserves local data per AUTH-05); JWT pushed to utilityProcess on session events (Phase 13 consumer ready); VerifyEmailBanner persistent + non-dismissable.
  </what-built>
  <how-to-verify>
    1. With a fresh sign-up (unverified email), reach MainApp. The VerifyEmailBanner appears at the top: `Verify your email to publish characters or buy credits. Check your inbox for a link from Sei.` There is NO × dismiss button — try clicking the message, no action.
    2. In your email, click the Supabase verification link. Switch focus to the Sei window. Within ~10s (Pitfall A6: USER_UPDATED fires on next API call; might need a manual refresh), Banner disappears. If it doesn't auto-disappear, manually trigger by calling `window.sei.signInPassword({email:<your>, password:<your>})` in DevTools — this forces a session refresh.
    3. Summon a bot via the Home screen. Verify in main's stdout logs that the supervisor session-init payload includes `initialJwt` (add a logger.debug stub if needed to confirm; remove before commit).
    4. Wait for a TOKEN_REFRESHED event (or force one: in DevTools `window.sei.signInPassword(...)` to trigger SIGNED_IN). Verify in logs that supervisor.updateJwt was called and the new {type:'jwt', jwt:'<new>'} was posted to port1. (The bot ignores it in Phase 10 — fine.)
    5. While bot is RUNNING, navigate to Settings (plan 07 wires the actual button, but for this checkpoint open DevTools and call `window.sei.signOut()` directly). The bot disconnects cleanly; session.bin is deleted; authState pushes `{kind:'local'}`; renderer drops to local mode WITHOUT screen transition (current screen stays mounted; per D-09).
    6. Verify AUTH-05 invariant: list `<userData>/Sei Launcher Dev/characters/` — file count UNCHANGED. List `<userData>/Sei Launcher Dev/memory/` — UNCHANGED. `api_key.bin` UNCHANGED. Only session.bin is gone.
    7. Open SignOutConfirmModal (will be wired in plan 07; for now manually mount it in App.tsx temporarily or skip): confirm both title branches read exactly as UI-SPEC, the dismissal label says `Stay signed in`, the confirm button is the same shape/color as the existing primary buttons in Settings (NOT red, NOT accent).
    8. Trigger resend-verification by calling `window.sei.resendVerification()` in DevTools — receives `{ok:true}`. Call it again immediately — receives `{ok:false, code:'rate_limited'}`.
  </how-to-verify>
  <resume-signal>
    Reply `approved` if all 8 steps pass. If step 2 takes longer than 30s, that's an A6 follow-up — acceptable for this checkpoint as long as forcing a refresh works.
  </resume-signal>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Main ↔ utilityProcess | JWT-only crosses via MessagePortMain. Refresh token never leaves main. |
| Sign-out sequence | Bot stop MUST precede auth.signOut() — otherwise the bot's last request fires with a soon-to-be-revoked JWT. |
| Local data | AUTH-05: sign-out NEVER touches characters/, memory/, api_key.bin, or cached cloud character definitions. |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-10-06-01 | Information Disclosure | utilityProcess receives the full session (refresh + JWT) | mitigate | jwtBridge pushes session.access_token ONLY — never the full session object. Refresh token stays in sessionStore.bin in main's filesystem. Grep gate: `grep -c 'refresh_token' src/main/auth/jwtBridge.ts` equals 0. |
| T-10-06-02 | Tampering | Sign-out fails silently (network down) → user thinks they're signed out but session persists | mitigate | signOut() catches errors AND calls transitionToLocal() so the renderer immediately drops to local mode. The next launch's session.bin load will either succeed (false alarm) or fail (real signed-out state). Documented in comment. |
| T-10-06-03 | Elevation of Privilege | Sign-out preserves session.bin (atomic write didn't complete) → next launch shows signed_in with revoked JWT → 401 from Supabase → recoverable via re-signin | accept | Recovery is automatic on next API call (sessionStore.loadJson catches decrypt-or-expired and treats as logged out via Pitfall A3 corrupt-blob branch is too generous; for revoked-JWT case Supabase returns 401 and onAuthStateChange emits SIGNED_OUT). User clicks Sign In again. |
| T-10-06-04 | Denial of Service | TOKEN_REFRESHED fires every 50 minutes → JWT push spam | accept | Push frequency is dictated by Supabase auto-refresh schedule (default 50 min). Negligible overhead. |
| T-10-06-05 | Information Disclosure | VerifyEmailBanner copy reveals account state to anyone watching the screen | accept | Banner copy is generic ("Verify your email"); doesn't reveal email address. UI-SPEC approved. |
| T-10-06-06 | Tampering | A renderer-side stale closure shows VerifyEmailBanner after emailVerified flips true | mitigate | Banner is computed live from useAuthStore.state on every render; React's reconciler picks up the change. Acceptance criterion: VerifyEmailBanner conditional reads `authState.user.emailVerified` directly. |
| T-10-06-07 | Spoofing | jwtBridge pushes a JWT to a utilityProcess that has been compromised | accept | utilityProcess is spawned by main (Electron's utilityProcess API enforces same-binary execution). If main is compromised, the JWT was already at risk; the bridge doesn't widen the attack surface. |
| T-10-06-08 | Information Disclosure | Logger writes JWT to disk via the existing log pipeline | mitigate | logger.warn calls in this plan log error.message strings only — never the JWT. Code review gate. (Future hardening: add a logger.scrub() helper that redacts JWT-shaped strings.) |
| T-10-06-09 | Tampering | Sign-out runs auth.signOut BEFORE supervisor.stop → bot's final action uses revoked JWT | mitigate | Code ordering in signOut() is verified: supervisor.stop() called FIRST, then auth.signOut(). Acceptance criterion checks the source order with awk. |
</threat_model>

<verification>
1. `npx tsc --noEmit` exits 0.
2. `npx vitest run src/main/auth/jwtBridge.test.ts` — 3 tests pass.
3. Human checkpoint (Task 3) — all 8 steps pass.
4. `grep -cF "refresh_token" src/main/auth/jwtBridge.ts` equals 0.
5. Source ordering in signOut: `awk '/supervisorRef.*stop/{a=NR} /auth\\.signOut/{b=NR} END{exit !(a < b)}' src/main/auth/authHandlers.ts` exits 0.
</verification>

<success_criteria>
- signOut stops bot before clearing session; preserves local files
- resendVerification maps rate-limit + network errors correctly
- jwtBridge pushes JWT on every relevant event; null on SIGNED_OUT
- botSupervisor.updateJwt is wired; init payload includes initialJwt
- SignOutConfirmModal: 2 title branches, 'Stay signed in' dismissal, 'Sign out' primary confirm
- VerifyEmailBanner: persistent, non-dismissable, top of stack
- 3 jwtBridge tests pass
- Human checkpoint approved
- AUTH-05 invariant verified manually
</success_criteria>

<output>
After completion, create `.planning/phases/10-auth-foundation/10-06-SUMMARY.md` covering: sign-out ordering contract (bot.stop → auth.signOut), JWT push event matrix (Phase 13 reuses this), and the VerifyEmailBanner conditional (so plan 11/13's verify-first-modal pattern can layer on top without duplicating the Banner).
</output>
