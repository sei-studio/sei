---
phase: 10
plan: 04
type: execute
wave: 3
depends_on: [10-03]
files_modified:
  - src/main/auth/authHandlers.ts
  - src/renderer/src/lib/stores/useAuthStore.ts
  - src/renderer/src/screens/AuthChoiceScreen.tsx
  - src/renderer/src/screens/AuthChoiceScreen.module.css
  - src/renderer/src/components/SignInModal.tsx
  - src/renderer/src/components/SignInModal.module.css
  - src/renderer/src/screens/OnboardingScreen.tsx
  - src/renderer/src/App.tsx
autonomous: false
requirements: [AUTH-01, AUTH-04]
requirements_addressed: [AUTH-01, AUTH-04]
tags: [auth, ui, onboarding, ux]
must_haves:
  truths:
    - "On first launch with no session.bin, the renderer shows AuthChoiceScreen with TWO equal-weight tiles: Sign In and Continue Locally (D-01, D-02)"
    - "Clicking Sign In tile opens SignInModal overlaid on AuthChoice (AuthChoice stays mounted underneath at 0.45 scrim; D-01)"
    - "SignInModal has a unified form with a mode toggle link 'New here? Create an account' / 'Already have an account? Sign in' — there is no separate Create-Account tile on AuthChoice (D-01)"
    - "Clicking Continue Locally tile routes to today's OnboardingScreen unchanged; no Supabase calls are made in this branch (D-02, AUTH-04 invariant)"
    - "On AuthChoice, a signed-in user (session.bin loads successfully) bypasses AuthChoice and goes straight to MainApp or to a 3-step OnboardingScreen (signedIn=true skips the provider/api-key steps per D-03)"
    - "SignInModal email/password form invokes auth:signin-password or auth:signup-password; success closes the modal and the AuthState onAuthState push transitions the app"
    - "Email verification does NOT block sign-in — user proceeds to MainApp immediately even when emailVerified is false (D-04)"
    - "Sign up with an 8+ char password, valid email, and unused address: receives {ok:true, requiresVerification:true}; the user is signed in immediately"
    - "The Sign In tile button label is exactly 'Sign In' and the local tile label is exactly 'Continue Locally' (UI-SPEC AuthChoiceScreen copy — forbidden labels: 'Skip', 'Guest', 'Try without signing in')"
  artifacts:
    - path: "src/main/auth/authHandlers.ts"
      provides: "Implemented signInWithPassword and signUpWithPassword (replacing plan 03 shells)"
      contains: "supabase.auth.signInWithPassword"
    - path: "src/renderer/src/lib/stores/useAuthStore.ts"
      provides: "Zustand store wrapping window.sei.onAuthState; exposes current AuthState + an upgradeReason field for D-10 inline-upgrade framing (used in plan 07)"
      exports: ["useAuthStore"]
    - path: "src/renderer/src/screens/AuthChoiceScreen.tsx"
      provides: "First-launch screen with two equal tiles, hosted inside MacosWindow"
      exports: ["AuthChoiceScreen"]
    - path: "src/renderer/src/components/SignInModal.tsx"
      provides: "Unified sign-in/sign-up modal with mode toggle, Google button (wired in plan 05), and 'Back to Sei' dismissal"
      exports: ["SignInModal"]
    - path: "src/renderer/src/screens/OnboardingScreen.tsx"
      provides: "Accepts new signedIn?:boolean prop; when true, skips Provider tiles and API key steps (D-03)"
      contains: "signedIn"
    - path: "src/renderer/src/App.tsx"
      provides: "Top-level routing: AuthChoice → (OnboardingScreen | MainApp) per the table in RESEARCH Pitfall A8"
      contains: "AuthChoiceScreen"
  key_links:
    - from: "src/renderer/src/App.tsx"
      to: "src/renderer/src/lib/stores/useAuthStore.ts"
      via: "useAuthStore((s) => s.state) drives top-level routing"
      pattern: "useAuthStore"
    - from: "src/renderer/src/screens/AuthChoiceScreen.tsx"
      to: "src/renderer/src/components/SignInModal.tsx"
      via: "AuthChoiceScreen state opens SignInModal on tile click"
      pattern: "SignInModal"
    - from: "src/renderer/src/components/SignInModal.tsx"
      to: "window.sei.signInPassword / signUpPassword"
      via: "ipcClient sei.* invocation"
      pattern: "sei\\.(signInPassword|signUpPassword)"
    - from: "src/main/auth/authHandlers.ts"
      to: "src/main/auth/supabaseClient.ts"
      via: "getClient().auth.signInWithPassword({email, password})"
      pattern: "auth\\.signInWithPassword"
---

<objective>
Implement the email/password sign-in/sign-up flow end-to-end:
1. Replace plan 03 shells in `src/main/auth/authHandlers.ts` for `signInWithPassword` and `signUpWithPassword` with real Supabase calls + clean error classification.
2. Create the renderer `useAuthStore` Zustand store wired to `window.sei.onAuthState`.
3. Build `AuthChoiceScreen.tsx` (two tiles, UI-SPEC copy verbatim).
4. Build `SignInModal.tsx` (unified sign-in / sign-up form with mode toggle, dismissal label `Back to Sei`).
5. Extend `OnboardingScreen.tsx` to accept `signedIn?:boolean` prop (D-03 — signed-in users skip provider/API-key step).
6. Rewire `App.tsx` top-level routing per the AUTH-04-preserving table from RESEARCH Pitfall A8.

The Google button in SignInModal is rendered but routed to a "wired in plan 05" stub that opens an OAuth interstitial modal — full Google flow lands in plan 05.

Purpose: AUTH-01 (email/password sign-in) and AUTH-04 ("Continue without account" first-class) ship as user-visible features. The renderer's view-routing state machine becomes auth-aware.

Output: One renderer store, two new screens/modals + CSS, two edits to existing screens, two real handler implementations.
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
@src/renderer/src/App.tsx
@src/renderer/src/screens/OnboardingScreen.tsx
@src/renderer/src/components/DeleteConfirmModal.tsx
@src/renderer/src/components/DeleteConfirmModal.module.css
@src/renderer/src/components/Button.tsx
@src/renderer/src/components/TextField.tsx
@src/renderer/src/components/Banner.tsx
@src/main/auth/authHandlers.ts
@.planning/phases/10-auth-foundation/10-03-SUMMARY.md

<interfaces>
<!-- Existing renderer primitives the new screens compose. Read each file before authoring. -->

From src/renderer/src/components/Button.tsx (kinds available):
```typescript
export type ButtonKind = 'primary' | 'accent' | 'ghost' | 'quiet';
export interface ButtonProps {
  kind: ButtonKind;
  size?: 'sm' | 'md' | 'lg';
  onClick?: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  type?: 'button' | 'submit';
}
```

From src/renderer/src/components/TextField.tsx: standard text field with label, placeholder, value/onChange, error string, autoComplete prop.

From src/shared/ipc.ts (Phase 10 — plan 03):
```typescript
window.sei.signInPassword(args: {email, password}): Promise<SignInResult>
window.sei.signUpPassword(args: {email, password}): Promise<SignUpResult>
window.sei.signInGoogle(): Promise<OAuthResult>
window.sei.onAuthState(cb): Unsubscribe
type AuthState = {kind:'local'} | {kind:'signed_in', user: AuthUser};
type SignInResult = {ok:true} | {ok:false, code:'invalid_credentials'|'network'|'rate_limited', message:string};
type SignUpResult = {ok:true, requiresVerification:boolean} | {ok:false, code:'email_in_use'|'weak_password'|'invalid_email'|'network', message:string};
```

From src/renderer/src/lib/ipcClient.ts: `export const sei = window.sei as RendererApi;`

Routing pattern in App.tsx (current — read entire file 1–290):
- view: View union from useUiStore
- useEffect bootstrap: loads config, characters, warnings, then either `navigate({kind:'onboarding'})` or `navigate({kind:'home'})` based on hasApiKey()
- Plan 04 must extend the routing decision per Pitfall A8 table.
</interfaces>
</context>

<read_first>
- `src/renderer/src/App.tsx` (entire file — top-level routing lives here; the routing table extension lands here)
- `src/renderer/src/screens/OnboardingScreen.tsx` (entire file — read prop interface + steps before adding signedIn prop)
- `src/renderer/src/components/DeleteConfirmModal.tsx` + `.module.css` (scrim+modal scaffold to clone for SignInModal)
- `src/renderer/src/components/Button.tsx` (kind values, exact size names)
- `src/renderer/src/components/TextField.tsx` (props — especially label, placeholder, autoComplete, error)
- `src/renderer/src/components/Banner.tsx` (used inside SignInModal for inline errors per UI-SPEC)
- `src/renderer/src/components/SeiPixelMark.tsx` (used as AuthChoiceScreen focal point)
- `src/renderer/src/styles/tokens.css` (token names referenced by AuthChoiceScreen.module.css)
- `src/main/auth/authHandlers.ts` (the plan 03 shells; replace bodies for two handlers)
- `src/main/auth/supabaseClient.ts` (getClient)
- `.planning/phases/10-auth-foundation/10-UI-SPEC.md` §AuthChoiceScreen, §SignInModal, §Interaction Contracts → AuthChoice → SignInModal vs OnboardingScreen routing, §Signed-in user reaches OnboardingScreen (D-03), §Empty/Error/Loading states (sign-in error copy)
- `.planning/phases/10-auth-foundation/10-CONTEXT.md` D-01, D-02, D-03, D-04
- `.planning/phases/10-auth-foundation/10-RESEARCH.md` §Pitfall A8 (routing table for v0.1.1-user-upgrade case)
</read_first>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Implement signInWithPassword + signUpWithPassword handler bodies</name>
  <files>src/main/auth/authHandlers.ts</files>
  <read_first>
    - src/main/auth/authHandlers.ts (plan 03 shells; replace bodies for two functions)
    - src/main/auth/supabaseClient.ts (getClient)
    - .planning/phases/10-auth-foundation/10-UI-SPEC.md §Empty/Error/Loading states (the user-visible copy strings — must map error codes to one of these UI-SPEC copy strings)
  </read_first>
  <behavior>
    - signInWithPassword({email, password}) calls getClient().auth.signInWithPassword({email, password}); on success returns {ok:true}.
    - On failure, maps Supabase error to one of: 'invalid_credentials' (Supabase error message contains 'Invalid login credentials' OR HTTP 400 with the auth-specific code), 'rate_limited' (status 429 OR message contains 'rate limit'), 'network' (everything else; including thrown fetch errors).
    - signUpWithPassword({email, password}) calls getClient().auth.signUp({email, password}); on success returns {ok:true, requiresVerification: !data.session} (Supabase returns session=null when email-confirmation is required; session populated when email-confirm is disabled in the project — both ship: plan 04 ALWAYS proceeds the user into MainApp per D-04 regardless of verification state).
    - On signUp failure, maps to: 'email_in_use' (message contains 'already' or 'registered'), 'weak_password' (message contains 'password' AND ('characters' OR 'length' OR 'weak')), 'invalid_email' (message contains 'email' AND ('invalid' OR 'valid')), 'network' (default).
    - Both handlers wrap the Supabase call with a 15s Promise.race timeout (per CLAUDE.md "every external call has a timeout"); timeout → {ok:false, code:'network', message:'Network timeout'}.
    - The two handlers DO NOT broadcast state — Supabase's onAuthStateChange handler in authState.ts does that automatically.
    - Tests with mocked getClient(): 6 unit tests — 2 success, 4 error-class mappings.
  </behavior>
  <action>
Replace the bodies of `signInWithPassword` and `signUpWithPassword` in `src/main/auth/authHandlers.ts`:

```typescript
import { getClient } from './supabaseClient';

// ... existing imports preserved ...

// Internal: 15s timeout wrap (CLAUDE.md: every external call has a timeout).
async function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  return await Promise.race([
    p,
    new Promise<T>((resolve) => setTimeout(() => resolve(onTimeout()), ms)),
  ]);
}

function classifySignInError(message: string, status?: number): SignInResult {
  const m = message.toLowerCase();
  if (status === 429 || m.includes('rate limit')) {
    return { ok: false, code: 'rate_limited', message: 'Hold on a moment — too many attempts.' };
  }
  if (m.includes('invalid login') || m.includes('invalid credentials') || status === 400) {
    return { ok: false, code: 'invalid_credentials', message: "Email or password doesn't match. Try again." };
  }
  return { ok: false, code: 'network', message: "Couldn't reach Sei's sign-in server. Check your connection and try again." };
}

function classifySignUpError(message: string): SignUpResult {
  const m = message.toLowerCase();
  if (m.includes('already') || m.includes('registered') || m.includes('exists')) {
    return { ok: false, code: 'email_in_use', message: 'That email is already registered. Sign in instead.' };
  }
  if (m.includes('password') && (m.includes('character') || m.includes('length') || m.includes('weak') || m.includes('short'))) {
    return { ok: false, code: 'weak_password', message: 'Pick a password with at least 8 characters.' };
  }
  if (m.includes('email') && (m.includes('invalid') || m.includes('valid') || m.includes('format'))) {
    return { ok: false, code: 'invalid_email', message: "That doesn't look like an email address." };
  }
  return { ok: false, code: 'network', message: "Couldn't reach Sei's sign-in server. Check your connection and try again." };
}

export async function signInWithPassword(args: { email: string; password: string }): Promise<SignInResult> {
  const supabase = getClient();
  try {
    const { error } = await withTimeout(
      supabase.auth.signInWithPassword({ email: args.email, password: args.password }),
      15_000,
      () => ({ error: { message: 'timeout', status: 0 } as { message: string; status?: number } }),
    );
    if (error) return classifySignInError(error.message, (error as { status?: number }).status);
    return { ok: true };
  } catch (err) {
    return classifySignInError((err as Error).message);
  }
}

export async function signUpWithPassword(args: { email: string; password: string }): Promise<SignUpResult> {
  const supabase = getClient();
  try {
    const { data, error } = await withTimeout(
      supabase.auth.signUp({ email: args.email, password: args.password }),
      15_000,
      () => ({ data: { session: null }, error: { message: 'timeout' } as { message: string } }),
    );
    if (error) return classifySignUpError(error.message);
    // requiresVerification = true iff Supabase did NOT return a session (project has email-confirm enabled).
    // Per D-04, the user proceeds either way — the verify-email Banner shows when !emailVerified.
    return { ok: true, requiresVerification: data?.session == null };
  } catch (err) {
    return classifySignUpError((err as Error).message);
  }
}
```

Also write `src/main/auth/authHandlers.test.ts` with vitest cases (mock supabaseClient.getClient to return a stub with the auth methods):

1. signInWithPassword success → {ok:true}
2. signInWithPassword with "Invalid login credentials" → {ok:false, code:'invalid_credentials', message starts with "Email or password"}
3. signInWithPassword with status 429 → {ok:false, code:'rate_limited'}
4. signInWithPassword that throws network error → {ok:false, code:'network'}
5. signUpWithPassword success with session=null → {ok:true, requiresVerification:true}
6. signUpWithPassword success with session={...} → {ok:true, requiresVerification:false}
7. signUpWithPassword with "User already registered" → {ok:false, code:'email_in_use'}
8. signUpWithPassword with "Password should be at least 8 characters" → {ok:false, code:'weak_password'}
9. signUpWithPassword with "Invalid email format" → {ok:false, code:'invalid_email'}

Use vi.mock to stub './supabaseClient'.
  </action>
  <verify>
    <automated>grep -c "supabase.auth.signInWithPassword" src/main/auth/authHandlers.ts | grep -q "^1$" && grep -c "supabase.auth.signUp" src/main/auth/authHandlers.ts | grep -q "^1$" && grep -c "rate_limited" src/main/auth/authHandlers.ts | grep -q "^1$" && grep -c "invalid_credentials" src/main/auth/authHandlers.ts | grep -q "^1$" && grep -c "requiresVerification" src/main/auth/authHandlers.ts | grep -q "^1$" && grep -c "withTimeout" src/main/auth/authHandlers.ts | grep -q "^3$" && ! grep -q "IMPLEMENTED IN PLAN 10-04" src/main/auth/authHandlers.ts && npx vitest run src/main/auth/authHandlers.test.ts</automated>
  </verify>
  <acceptance_criteria>
    - `grep -c "supabase.auth.signInWithPassword" src/main/auth/authHandlers.ts` equals 1
    - `grep -c "supabase.auth.signUp\\b" src/main/auth/authHandlers.ts` equals 1
    - `grep -c "withTimeout" src/main/auth/authHandlers.ts` >= 2 (called from both handlers)
    - `grep -c "15_000" src/main/auth/authHandlers.ts` >= 2 OR `grep -c "15000" src/main/auth/authHandlers.ts` >= 2 (15s timeout per CLAUDE.md)
    - `grep -c "rate_limited" src/main/auth/authHandlers.ts` >= 1
    - `grep -c "invalid_credentials" src/main/auth/authHandlers.ts` >= 1
    - `grep -c "email_in_use" src/main/auth/authHandlers.ts` >= 1
    - `grep -c "weak_password" src/main/auth/authHandlers.ts` >= 1
    - `grep -c "invalid_email" src/main/auth/authHandlers.ts` >= 1
    - `grep -c "requiresVerification" src/main/auth/authHandlers.ts` >= 1
    - `grep -c "IMPLEMENTED IN PLAN 10-04" src/main/auth/authHandlers.ts` equals 0 (both TODOs replaced)
    - `npx vitest run src/main/auth/authHandlers.test.ts` exits 0 with 9 passing tests
    - `npx tsc --noEmit` exits 0
  </acceptance_criteria>
  <done>
    Two handler bodies call real Supabase APIs with 15s timeout and error-class mapping that matches the UI-SPEC error copy strings; 9 unit tests pass.
  </done>
</task>

<task type="auto" tdd="false">
  <name>Task 2: Build useAuthStore (Zustand) + AuthChoiceScreen + SignInModal + extend OnboardingScreen + rewire App.tsx</name>
  <files>src/renderer/src/lib/stores/useAuthStore.ts, src/renderer/src/screens/AuthChoiceScreen.tsx, src/renderer/src/screens/AuthChoiceScreen.module.css, src/renderer/src/components/SignInModal.tsx, src/renderer/src/components/SignInModal.module.css, src/renderer/src/screens/OnboardingScreen.tsx, src/renderer/src/App.tsx</files>
  <read_first>
    - src/renderer/src/lib/stores/useUiStore.ts and src/renderer/src/lib/stores/useDataStore.ts (Zustand pattern — useAuthStore mirrors)
    - src/renderer/src/lib/ipcClient.ts (sei export)
    - src/renderer/src/App.tsx (entire — rewire view selection)
    - src/renderer/src/screens/OnboardingScreen.tsx (entire — find STEPS const + step rendering)
    - src/renderer/src/components/DeleteConfirmModal.module.css (scrim+modal CSS to clone)
    - src/renderer/src/components/Button.module.css (kind classes available)
    - src/renderer/src/styles/tokens.css (verify all color/spacing tokens used)
    - .planning/phases/10-auth-foundation/10-UI-SPEC.md (§AuthChoiceScreen + §SignInModal + §Inline upgrade modal — verbatim copy)
  </read_first>
  <behavior>
    - useAuthStore exposes: state: AuthState, upgradeFraming: null | 'browse public characters' | 'use cloud-hosted AI' | 'share this character', setUpgradeFraming(value). On mount-once subscription via `sei.onAuthState`, it updates state.
    - AuthChoiceScreen is a screen-level component composing MacosWindow-internal layout. Centered column max-width 560px. SeiPixelMark at top (centered focal point). Below: vertical-rhythm `--space-3xl` to a horizontal tile pair (stacks to vertical below 640px viewport). Below: 14px secondary footer microcopy. Copy values are EXACTLY from UI-SPEC.
    - SignInModal: 460px scrim+modal. State `mode: 'signin' | 'signup'`. Mode toggle link. Email + Password TextFields. Primary accent Button: 'Sign In' (signin mode) / 'Create Account' (signup mode). Below: a small `or` divider, then a ghost Button 'Continue with Google' (wires sei.signInGoogle — plan 05 owns the flow; here the button just calls and shows a transient toast on result).
    - Footer: quiet Button 'Back to Sei' (dismissal label per UI-SPEC).
    - Submitting state: button text swaps to 'Signing in…' / 'Creating account…', button is disabled.
    - Inline error: when result.ok=false, render the result.message inside a 14px red helper text below the password field. Error copy strings already mapped in Task 1 — render them verbatim.
    - On result.ok=true: close the modal. The authState push will fire from Supabase's event; the renderer's useAuthStore subscriber drives the view transition.
    - OnboardingScreen.tsx gains optional prop `signedIn?: boolean`. When true: skip steps 3 (Provider tiles) and 4 (API key). STEPS const becomes a function-computed value depending on signedIn. The Welcome step's body gets an extra muted line: 'Cloud-hosted AI is launching in a future update. For now, you can paste your own provider key in Settings.' (UI-SPEC D-03 framing).
    - App.tsx routing rewrite per Pitfall A8 table:
        | session.bin OK | api_key.bin OK | First view |
        |---|---|---|
        | Yes | Either | navigate({kind:'home'}) (signed_in path; MainApp) |
        | No | Yes | AuthChoice (and Continue Locally → home, not onboarding — already onboarded) |
        | No | No | AuthChoice (and Continue Locally → onboarding) |
    - AuthChoice is rendered as a SEPARATE view kind 'auth-choice'. Add 'auth-choice' to View union in useUiStore.ts (lazy: if the executor finds the View union type, add the new variant; if not, render AuthChoice via local state in App.tsx).
  </behavior>
  <action>
1. Create `src/renderer/src/lib/stores/useAuthStore.ts`:

```typescript
/**
 * useAuthStore — renderer-side mirror of main's AuthState, plus the
 * D-10 upgrade-modal framing micro-copy slot.
 *
 * Subscribes to window.sei.onAuthState ONCE at App.tsx mount. Plans 04–09
 * read s.state to drive routing, conditional Banners, and Account-panel
 * visibility.
 *
 * Source: 10-CONTEXT D-06, D-10. 10-UI-SPEC §Inline upgrade modal.
 */
import { create } from 'zustand';
import { sei } from '../ipcClient';
import type { AuthState } from '@shared/ipc';

export type UpgradeFraming = null | 'browse public characters' | 'use cloud-hosted AI' | 'share this character';

interface AuthStore {
  state: AuthState;
  upgradeFraming: UpgradeFraming;
  setUpgradeFraming: (v: UpgradeFraming) => void;
  _setState: (s: AuthState) => void;
}

export const useAuthStore = create<AuthStore>((set) => ({
  state: { kind: 'local' }, // until first onAuthState event fires
  upgradeFraming: null,
  setUpgradeFraming: (v) => set({ upgradeFraming: v }),
  _setState: (s) => set({ state: s }),
}));

/**
 * Subscribe once to main's auth:state push. Returns the unsubscribe function
 * so App.tsx can clean up on unmount (though in practice App is never
 * unmounted during the app lifetime).
 */
export function subscribeAuthState(): () => void {
  return sei.onAuthState((s) => {
    useAuthStore.getState()._setState(s);
  });
}
```

2. Create `src/renderer/src/screens/AuthChoiceScreen.module.css` (sharp corners, token-driven, matches UI-SPEC):

```css
.shell {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 100%;
  padding: var(--space-3xl) var(--space-xl);
  gap: var(--space-3xl);
  background: var(--window);
}

.brandRow {
  display: flex;
  justify-content: center;
}

.copyBlock {
  text-align: center;
  max-width: 560px;
  display: flex;
  flex-direction: column;
  gap: var(--space-md-plus);
}

.title {
  font-family: var(--sans);
  font-size: 30px;
  font-weight: 600;
  line-height: 1.15;
  letter-spacing: -0.4px;
  color: var(--text);
  margin: 0;
}

.sub {
  font-family: var(--sans);
  font-size: 15px;
  line-height: 1.5;
  color: var(--text-2);
  margin: 0;
}

.tiles {
  display: flex;
  gap: var(--space-md-plus);
  width: 100%;
  max-width: 560px;
  flex-direction: column;
}

@media (min-width: 640px) {
  .tiles { flex-direction: row; }
}

.tile {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-sm);
  padding: var(--space-lg) var(--space-xl);
  background: var(--surface);
  border: 1px solid var(--border);
  cursor: pointer;
  text-align: left;
  font-family: var(--sans);
  transition: background 140ms ease, border-color 140ms ease, transform 140ms ease;
}

.tile:hover {
  background: var(--accent-soft);
  border-color: var(--accent);
  transform: translateY(-1px);
}

.tile:focus-visible {
  outline: 1.5px solid var(--accent);
  outline-offset: 2px;
}

.tileTitle {
  font-size: 22px;
  font-weight: 600;
  line-height: 1.2;
  letter-spacing: -0.2px;
  color: var(--text);
  margin: 0;
}

.tileBody {
  font-size: 15px;
  line-height: 1.5;
  color: var(--text-2);
  margin: 0;
}

.footer {
  font-family: var(--sans);
  font-size: 14px;
  color: var(--muted);
  text-align: center;
  margin: 0;
}

@media (prefers-reduced-motion: reduce) {
  .tile, .tile:hover { transform: none; }
}
```

3. Create `src/renderer/src/screens/AuthChoiceScreen.tsx`:

```tsx
/**
 * AuthChoiceScreen — first-launch sign-in vs local choice (D-01, D-02).
 *
 * Two equal-weight tiles. NO third 'Create account' tile — sign-up lives
 * inside SignInModal as a mode toggle (D-01).
 *
 * Copy is verbatim from UI-SPEC §AuthChoiceScreen. Forbidden labels
 * ("Skip", "Guest", "Try without signing in", etc.) are NOT in the copy
 * here — local mode is privacy-first, the equal-citizen choice (D-02).
 *
 * Source: 10-UI-SPEC §AuthChoiceScreen + Component Inventory.
 */
import React, { useState } from 'react';
import { SeiPixelMark } from '../components/SeiPixelMark';
import { SignInModal } from '../components/SignInModal';
import styles from './AuthChoiceScreen.module.css';

export interface AuthChoiceScreenProps {
  onChooseLocal: () => void;
}

export function AuthChoiceScreen({ onChooseLocal }: AuthChoiceScreenProps): React.ReactElement {
  const [showSignIn, setShowSignIn] = useState(false);

  return (
    <div className={styles.shell}>
      <div className={styles.brandRow}>
        <SeiPixelMark />
      </div>

      <div className={styles.copyBlock}>
        <h1 className={styles.title}>Welcome to Sei.</h1>
        <p className={styles.sub}>Sei is a Minecraft companion. Choose how you&apos;d like to use it.</p>
      </div>

      <div className={styles.tiles}>
        <button
          type="button"
          className={styles.tile}
          onClick={() => setShowSignIn(true)}
        >
          <span className={styles.tileTitle}>Sign In</span>
          <span className={styles.tileBody}>
            Sync characters across devices and use cloud-hosted AI. Email or Google.
          </span>
        </button>

        <button
          type="button"
          className={styles.tile}
          onClick={onChooseLocal}
        >
          <span className={styles.tileTitle}>Continue Locally</span>
          <span className={styles.tileBody}>
            Run everything on this machine with your own API key. No account, no cloud.
          </span>
        </button>
      </div>

      <p className={styles.footer}>You can switch between modes anytime in Settings.</p>

      {showSignIn ? (
        <SignInModal
          onClose={() => setShowSignIn(false)}
          framingLabel={null}
        />
      ) : null}
    </div>
  );
}
```

4. Create `src/renderer/src/components/SignInModal.module.css` — clone of `DeleteConfirmModal.module.css` shape (460px width, 32px padding, scrim 0.45 alpha, sharp corners) with these additions:

```css
.scrim {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  animation: fade 220ms ease;
}

.modal {
  width: 460px;
  background: var(--window);
  padding: 24px 40px 40px;
  border: 1px solid var(--border-strong);
  font-family: var(--sans);
  animation: fadeUp 280ms var(--ease-pop);
  display: flex;
  flex-direction: column;
  gap: var(--space-md-plus);
}

.framing {
  font-size: 14px;
  color: var(--muted);
  margin: 0;
}

.title {
  font-size: 22px;
  font-weight: 600;
  line-height: 1.2;
  letter-spacing: -0.2px;
  color: var(--text);
  margin: 0;
}

.toggleRow {
  display: flex;
  justify-content: flex-start;
}

.toggleLink {
  background: none;
  border: 0;
  font: inherit;
  font-size: 14px;
  color: var(--text-2);
  cursor: pointer;
  text-decoration: underline;
  padding: 0;
}

.form {
  display: flex;
  flex-direction: column;
  gap: var(--space-md-plus);
}

.errorText {
  font-size: 14px;
  color: var(--red);
  margin: 0;
}

.divider {
  display: flex;
  align-items: center;
  gap: var(--space-md);
  font-size: 14px;
  color: var(--muted);
  margin: 4px 0;
}

.divider::before, .divider::after {
  content: '';
  flex: 1;
  border-top: 1px solid var(--border);
}

.footer {
  display: flex;
  justify-content: flex-start;
  gap: var(--space-md);
  margin-top: var(--space-md-plus);
}

.forgotLink {
  background: none;
  border: 0;
  font: inherit;
  font-size: 14px;
  color: var(--text-2);
  cursor: pointer;
  padding: 0;
  align-self: flex-start;
}

@keyframes fade { from { opacity: 0 } to { opacity: 1 } }
@keyframes fadeUp { from { opacity: 0; transform: translateY(8px) } to { opacity: 1; transform: none } }

@media (prefers-reduced-motion: reduce) {
  .scrim, .modal { animation: none; }
}
```

5. Create `src/renderer/src/components/SignInModal.tsx`:

```tsx
/**
 * SignInModal — unified sign-in / sign-up modal (D-01).
 *
 * Mode toggle inside the form. Email + Password. Primary accent CTA changes
 * label per mode. Google button (plan 05 wires the actual OAuth dance).
 *
 * Dismissal label: 'Back to Sei' (UI-SPEC dismissal-label policy — no
 * generic 'Cancel').
 *
 * Email verification does NOT block sign-in (D-04). On signup success the
 * modal closes immediately and the user proceeds into the app; the
 * verify-email Banner (plan 06) handles the persistent prompt.
 *
 * Source: 10-UI-SPEC §SignInModal + Copywriting Contract.
 */
import React, { useEffect, useRef, useState } from 'react';
import { sei } from '../lib/ipcClient';
import { Button } from './Button';
import { TextField } from './TextField';
import styles from './SignInModal.module.css';

export interface SignInModalProps {
  /** D-10 framing micro-copy. Null when opened directly from AuthChoice; set to e.g. 'browse public characters' for inline-upgrade flow. */
  framingLabel: string | null;
  /** Called on dismissal AND on successful sign-in/up. Caller is responsible for whatever happens next. */
  onClose: () => void;
}

type Mode = 'signin' | 'signup';

export function SignInModal({ framingLabel, onClose }: SignInModalProps): React.ReactElement {
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Focus management: first interactive element on mount
    emailRef.current?.focus();
    // ESC closes
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape' && !submitting) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, submitting]);

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (mode === 'signin') {
        const res = await sei.signInPassword({ email, password });
        if (res.ok) {
          onClose();
        } else {
          setError(res.message);
        }
      } else {
        const res = await sei.signUpPassword({ email, password });
        if (res.ok) {
          // D-04: proceed regardless of verification state.
          onClose();
        } else {
          setError(res.message);
        }
      }
    } finally {
      setSubmitting(false);
    }
  };

  const onGoogleClick = async (): Promise<void> => {
    setError(null);
    setSubmitting(true);
    try {
      // Plan 05 implements the loopback + interstitial flow. For now this
      // just dispatches and surfaces whatever the handler returns.
      const res = await sei.signInGoogle();
      if (res.ok) onClose();
      else setError('Google sign-in is not yet implemented. Use email and password for now.');
    } finally {
      setSubmitting(false);
    }
  };

  const titleId = 'signin-modal-title';
  const titleText = mode === 'signin' ? 'Sign in to Sei' : 'Create your Sei account';
  const ctaLabel = submitting
    ? (mode === 'signin' ? 'Signing in…' : 'Creating account…')
    : (mode === 'signin' ? 'Sign In' : 'Create Account');
  const toggleLabel = mode === 'signin' ? 'New here? Create an account' : 'Already have an account? Sign in';

  return (
    <div className={styles.scrim} role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className={styles.modal}>
        {framingLabel ? (
          <p className={styles.framing}>Sign in to {framingLabel}</p>
        ) : null}

        <h2 id={titleId} className={styles.title}>{titleText}</h2>

        <div className={styles.toggleRow}>
          <button
            type="button"
            className={styles.toggleLink}
            onClick={() => { setMode((m) => (m === 'signin' ? 'signup' : 'signin')); setError(null); }}
          >
            {toggleLabel}
          </button>
        </div>

        <form className={styles.form} onSubmit={onSubmit}>
          <TextField
            label="Email"
            placeholder="you@example.com"
            value={email}
            onChange={setEmail}
            type="email"
            autoComplete="email"
            inputRef={emailRef}
          />
          <TextField
            label="Password"
            placeholder={mode === 'signup' ? 'At least 8 characters' : ''}
            value={password}
            onChange={setPassword}
            type="password"
            autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
          />
          {error ? <p className={styles.errorText} role="alert">{error}</p> : null}

          <Button kind="accent" size="md" type="submit" disabled={submitting || !email || !password}>
            {ctaLabel}
          </Button>

          {mode === 'signin' ? (
            <button type="button" className={styles.forgotLink}>Forgot your password?</button>
          ) : null}
        </form>

        <div className={styles.divider}>or</div>

        <Button kind="ghost" size="md" onClick={onGoogleClick} disabled={submitting}>
          Continue with Google
        </Button>

        <div className={styles.footer}>
          <Button kind="quiet" size="md" onClick={onClose} disabled={submitting}>
            Back to Sei
          </Button>
        </div>
      </div>
    </div>
  );
}
```

   NOTE: If `TextField` does not accept an `inputRef` prop, omit the prop and focus the input via querySelector inside useEffect — read TextField.tsx first to confirm.

6. Edit `src/renderer/src/screens/OnboardingScreen.tsx`:

   - Change the prop interface:
     ```typescript
     export interface OnboardingScreenProps {
       isReonboard: boolean;
       /** D-03: signed-in users skip the Provider tiles AND API-key steps. */
       signedIn?: boolean;
     }
     ```
   - Change `const STEPS = 4;` to `const STEPS = signedIn ? 2 : 4;` (using the prop in the function body, not module top-level — refactor to a local const). The actual step count depends on the project's step indexing — verify by reading the file and re-indexing the step state machine consistently.
   - In the welcome step (step 0), when `signedIn === true`, append a 14px secondary line with the EXACT text: `Cloud-hosted AI is launching in a future update. For now, you can paste your own provider key in Settings.`
   - In the step transition logic, skip the provider step (current step 3) and the API-key step (current step 4) when signedIn is true. After the preferred-name step, navigate directly to `{kind:'home'}`.
   - The signed-in branch MUST NOT call `sei.saveApiKey()` — assert this by reading the file's existing submit flow and gating saveApiKey behind `if (!signedIn)`.

7. Rewire `src/renderer/src/App.tsx`:

   (a) Import `useAuthStore, subscribeAuthState` and `AuthChoiceScreen`:
   ```typescript
   import { useAuthStore, subscribeAuthState } from './lib/stores/useAuthStore';
   import { AuthChoiceScreen } from './screens/AuthChoiceScreen';
   ```

   (b) Inside App component, add at top with other hooks:
   ```typescript
   const authState = useAuthStore((s) => s.state);
   ```

   (c) Wire the subscription in a useEffect (alongside subscribeIpc):
   ```typescript
   useEffect(() => subscribeAuthState(), []);
   ```

   (d) Rewrite the bootstrap useEffect routing decision to implement Pitfall A8 table. Replace the existing `if (!hasKey) ... else navigate({kind:'home'})` block with:
   ```typescript
   // Pitfall A8 routing:
   //   session.bin OK            → kind:'home' (signed-in)
   //   no session, api_key.bin OK → AuthChoice; Continue Locally → kind:'home' (already onboarded)
   //   no session, no api_key.bin → AuthChoice; Continue Locally → onboarding step 0
   //
   // The session-OK check uses the auth-state push: by the time we're past
   // initAuthState in bootstrap, the renderer has received the initial
   // {kind:'local'} OR {kind:'signed_in'} via did-finish-load replay.
   // We DON'T read the auth state here — we set a sentinel view and let
   // the auth-state subscriber drive the actual transition in a separate
   // effect.
   // Simpler: gate the first view decision on a single boot pulse.
   const initial = useAuthStore.getState().state;
   if (initial.kind === 'signed_in') {
     navigate({ kind: 'home' });
   } else {
     // Show AuthChoice. The choice handler navigates onward.
     navigate({ kind: 'auth-choice' });
   }
   ```

   (e) Add new view kind 'auth-choice' to View union in useUiStore.ts. Add a switch case in the render JSX:
   ```typescript
   {view.kind === 'auth-choice' && (
     <AuthChoiceScreen onChooseLocal={() => {
       // Per Pitfall A8: api_key.bin exists → home; else onboarding
       sei.hasApiKey().then((hasKey) => {
         if (hasKey) navigate({ kind: 'home' });
         else navigate({ kind: 'onboarding', isReonboard: false });
       });
     }} />
   )}
   ```

   (f) Wire authState subscriber: when authState transitions to signed_in, navigate to home and (D-03) pass signedIn=true to OnboardingScreen if currently in onboarding:
   ```typescript
   useEffect(() => {
     if (authState.kind === 'signed_in' && (view.kind === 'auth-choice' || view.kind === 'loading')) {
       navigate({ kind: 'home' });
     }
   }, [authState, view.kind, navigate]);
   ```

   (g) When rendering OnboardingScreen, pass `signedIn={authState.kind === 'signed_in'}`:
   ```typescript
   {view.kind === 'onboarding' && (
     <OnboardingScreen
       isReonboard={view.isReonboard}
       signedIn={authState.kind === 'signed_in'}
     />
   )}
   ```

   (h) Update useUiStore.ts View union: add `| { kind: 'auth-choice' }`. Update subtitleForView in App.tsx to return 'Welcome' (or empty string) for auth-choice.

   IMPORTANT: do NOT remove the existing LOADING_FLOOR_MS pulse — the initial loading screen still gates the boot animation, AuthChoice renders AFTER.
  </action>
  <verify>
    <automated>grep -c "export function useAuthStore" src/renderer/src/lib/stores/useAuthStore.ts | grep -q "^0$" && grep -c "useAuthStore" src/renderer/src/lib/stores/useAuthStore.ts | grep -q "^[2-9]" && grep -c "subscribeAuthState" src/renderer/src/lib/stores/useAuthStore.ts | grep -q "^1$" && grep -c "Welcome to Sei" src/renderer/src/screens/AuthChoiceScreen.tsx | grep -q "^1$" && grep -c "Continue Locally" src/renderer/src/screens/AuthChoiceScreen.tsx | grep -q "^1$" && grep -c "Sign In" src/renderer/src/screens/AuthChoiceScreen.tsx | grep -q "^[1-9]" && grep -c "Back to Sei" src/renderer/src/components/SignInModal.tsx | grep -q "^1$" && grep -c "New here. Create an account" src/renderer/src/components/SignInModal.tsx | grep -q "^1$" && grep -c "signInPassword" src/renderer/src/components/SignInModal.tsx | grep -q "^1$" && grep -c "signUpPassword" src/renderer/src/components/SignInModal.tsx | grep -q "^1$" && grep -c "signedIn" src/renderer/src/screens/OnboardingScreen.tsx | grep -q "^[2-9]" && grep -c "AuthChoiceScreen" src/renderer/src/App.tsx | grep -q "^[2-9]" && grep -c "subscribeAuthState" src/renderer/src/App.tsx | grep -q "^1$" && grep -vE '^\s*(\*|//|/\*|\*/)' src/renderer/src/screens/AuthChoiceScreen.tsx | grep -qE '\b(Skip|Guest|Maybe later)\b' && echo "FORBIDDEN_COPY_FOUND" || echo "ok" | grep -q "ok" && npx tsc --noEmit</automated>
  </verify>
  <acceptance_criteria>
    - `grep -c "useAuthStore" src/renderer/src/lib/stores/useAuthStore.ts` >= 2 (the create + export reference)
    - `grep -c "subscribeAuthState" src/renderer/src/lib/stores/useAuthStore.ts` equals 1
    - `grep -c "sei.onAuthState" src/renderer/src/lib/stores/useAuthStore.ts` equals 1
    - `grep -cF "Welcome to Sei." src/renderer/src/screens/AuthChoiceScreen.tsx` equals 1
    - `grep -cF "Sei is a Minecraft companion. Choose how you" src/renderer/src/screens/AuthChoiceScreen.tsx` equals 1
    - `grep -cF "Continue Locally" src/renderer/src/screens/AuthChoiceScreen.tsx` equals 1
    - `grep -cF "Run everything on this machine with your own API key. No account, no cloud." src/renderer/src/screens/AuthChoiceScreen.tsx` equals 1
    - `grep -cF "Sync characters across devices and use cloud-hosted AI. Email or Google." src/renderer/src/screens/AuthChoiceScreen.tsx` equals 1
    - `grep -cF "You can switch between modes anytime in Settings." src/renderer/src/screens/AuthChoiceScreen.tsx` equals 1
    - FORBIDDEN copy check: `grep -vE '^\s*(\*|//|/\*|\*/|\s*\*)' src/renderer/src/screens/AuthChoiceScreen.tsx | grep -cwE 'Skip|Guest|Maybe later'` equals 0
    - `grep -cF "Back to Sei" src/renderer/src/components/SignInModal.tsx` equals 1
    - `grep -cF "Continue with Google" src/renderer/src/components/SignInModal.tsx` equals 1
    - `grep -cF "Forgot your password?" src/renderer/src/components/SignInModal.tsx` equals 1
    - `grep -cF "Sign in to Sei" src/renderer/src/components/SignInModal.tsx` equals 1
    - `grep -cF "Create your Sei account" src/renderer/src/components/SignInModal.tsx` equals 1
    - `grep -cE "sei\\.signInPassword" src/renderer/src/components/SignInModal.tsx` equals 1
    - `grep -cE "sei\\.signUpPassword" src/renderer/src/components/SignInModal.tsx` equals 1
    - `grep -cE "sei\\.signInGoogle" src/renderer/src/components/SignInModal.tsx` equals 1
    - SignInModal width: `grep -cE "width: 460px" src/renderer/src/components/SignInModal.module.css` equals 1
    - `grep -cF "signedIn" src/renderer/src/screens/OnboardingScreen.tsx` >= 2
    - `grep -cF "Cloud-hosted AI is launching in a future update" src/renderer/src/screens/OnboardingScreen.tsx` equals 1
    - `grep -cE "saveApiKey" src/renderer/src/screens/OnboardingScreen.tsx` >= 1 — verify it's gated behind `if (!signedIn)` or equivalent
    - `grep -cF "AuthChoiceScreen" src/renderer/src/App.tsx` >= 2 (import + JSX)
    - `grep -cF "subscribeAuthState" src/renderer/src/App.tsx` equals 1
    - `grep -cF "auth-choice" src/renderer/src/App.tsx` >= 2
    - `grep -cF "useAuthStore" src/renderer/src/App.tsx` >= 1
    - `grep -cF "auth-choice" src/renderer/src/lib/stores/useUiStore.ts` >= 1 (View union extended)
    - `npx tsc --noEmit` exits 0
    - `grep -rn "@supabase/supabase-js" src/renderer 2>/dev/null | wc -l` returns 0 (renderer still does not import Supabase)
  </acceptance_criteria>
  <done>
    AuthChoice + SignInModal render with verbatim UI-SPEC copy; sign-in/sign-up succeeds via real Supabase calls; Continue Locally routes per Pitfall A8 table; signed-in users get the 2-step OnboardingScreen with the cloud-AI placeholder line; tsc clean.
  </done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task 3 (checkpoint): Verify AuthChoice flow end-to-end against a real Supabase project</name>
  <files>none — human verification of prior code-producing tasks</files>
  <action>Perform the verification steps listed under <how-to-verify> below. The executor must NOT skip; this checkpoint gates the wave.</action>
  <verify>
    <automated>echo "human checkpoint — see how-to-verify below"; true</automated>
  </verify>
  <done>User has replied "approved" to the resume signal below.</done>
  <what-built>
    Email/password sign-in/sign-up flow: AuthChoiceScreen → SignInModal (toggle modes) → Supabase Auth → onAuthState push → MainApp (or signed-in OnboardingScreen with cloud-AI placeholder); Continue Locally path preserved per AUTH-04.
  </what-built>
  <how-to-verify>
    With your dev Supabase project's URL + ANON_KEY in .env, run `npm run dev` and step through:
    1. Delete any existing `<userData>/Sei Launcher Dev/session.bin` and `api_key.bin` so the app is in a true first-launch state.
    2. App boots → AuthChoiceScreen appears with `Welcome to Sei.` title, two tiles. Confirm the tile copy exactly matches UI-SPEC (Sign In / Continue Locally) and there is NO `Skip` / `Guest` / `Maybe later` anywhere.
    3. Click **Continue Locally** → arrives at OnboardingScreen step 0. Quit. Relaunch. AuthChoice should appear AGAIN (no session.bin); choose Continue Locally → this time it should route to HOME (api_key.bin was created during step 2 onboarding) per the Pitfall A8 table. Confirm BOT can still summon — AUTH-04 invariant.
    4. Delete session.bin again. Relaunch. Click **Sign In** tile → SignInModal opens with title `Sign in to Sei`, dismissal label `Back to Sei`. Click 'New here? Create an account' → title flips to `Create your Sei account`.
    5. Create a brand-new test account with an 8+ char password. Modal closes. App routes to a 2-step OnboardingScreen (Welcome, then Minecraft username) — provider/api-key steps are SKIPPED. Welcome step body includes `Cloud-hosted AI is launching in a future update. For now, you can paste your own provider key in Settings.` Complete onboarding → reach home.
    6. Quit. Relaunch. App goes straight to home (signed_in state restored from session.bin). Confirm in DevTools that `window.sei.onAuthState((s) => console.log(s))` logs `{kind:'signed_in', user:{email:<your-test-email>, emailVerified:false, ...}}`.
    7. Trigger a sign-in error: sign out manually by deleting session.bin and relaunching, click Sign In tile, enter the test email with WRONG password. Confirm: red helper text `Email or password doesn't match. Try again.` appears below the password field. Modal stays open.
    8. Trigger weak-password error: switch to sign-up mode, try password `abc`. Confirm: `Pick a password with at least 8 characters.`
  </how-to-verify>
  <resume-signal>
    Reply `approved` if all 8 steps pass. Reply with the specific step number + actual behavior if anything diverges from UI-SPEC.
  </resume-signal>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Renderer form → Main auth handler | Email/password cross IPC; Zod-gated at boundary (plan 03). |
| Main → Supabase Auth HTTPS | Standard TLS; flowType:'pkce' (plan 01). |
| Local-mode branch → Cloud | Local mode MUST NEVER touch Supabase — AUTH-04 invariant. |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-10-04-01 | Information Disclosure | Password logged via console.error on sign-in failure | mitigate | The handler bodies do not log args. Error mapping returns clean copy strings; no password leaks. Code review gate. |
| T-10-04-02 | Tampering | Local-mode branch accidentally calls a cloud API after AUTH-04 | mitigate | OnboardingScreen.tsx saveApiKey call gated behind `if (!signedIn)`. No Supabase imports in OnboardingScreen.tsx — enforced by grep acceptance criterion. |
| T-10-04-03 | Spoofing | Forgot-password link sends user to a fake reset URL | accept | Phase 10 ships the link as a non-functional placeholder (no recovery flow). Plan reference: `forgotLink` button has no onClick handler; safe by inaction. Future hardening: wire to supabase.auth.resetPasswordForEmail with rate limiting. |
| T-10-04-04 | Denial of Service | Rapid sign-in retries → Supabase rate-limits the IP | mitigate | Supabase Auth's built-in rate limit (60s; CITED RESEARCH §Q5). Plan 04 maps 429 to {code:'rate_limited', message:'Hold on a moment — too many attempts.'}. |
| T-10-04-05 | Information Disclosure | Banner / error text leaks JWT or refresh token | mitigate | Error message strings are static copy from UI-SPEC; no JWT-shaped values reach the renderer. |
| T-10-04-06 | Elevation of Privilege | Signed-in user reaches OnboardingScreen without signedIn=true → can submit a provider API key that then gets read as a cloud user | mitigate | App.tsx renders OnboardingScreen with `signedIn={authState.kind === 'signed_in'}` ALWAYS. The hardcoded flow ensures consistency. |
| T-10-04-07 | Information Disclosure | Email field autocompletes with stored browser passwords from other apps | accept | autoComplete="email" / "current-password" / "new-password" are standard; browser password manager interaction is expected UX. |
</threat_model>

<verification>
1. `npx tsc --noEmit` exits 0.
2. `npx vitest run src/main/auth/authHandlers.test.ts` — 9 tests pass.
3. Human checkpoint (Task 3) — all 8 steps pass.
4. `grep -rn "@supabase/supabase-js" src/renderer 2>/dev/null | wc -l` returns 0.
</verification>

<success_criteria>
- AuthChoiceScreen renders verbatim UI-SPEC copy; no forbidden labels
- SignInModal: mode toggle, accent CTA, ghost Google button, quiet 'Back to Sei' dismissal
- Real Supabase signInWithPassword / signUp calls with 15s timeout and UI-SPEC error mapping
- OnboardingScreen accepts signedIn prop; skips provider/api-key steps when true
- App.tsx routing implements Pitfall A8 table
- AUTH-04 invariant: local-mode users never trigger a Supabase call
- 9 handler tests pass; tsc clean
- Human checkpoint approved
</success_criteria>

<output>
After completion, create `.planning/phases/10-auth-foundation/10-04-SUMMARY.md` covering: the routing table implementation (so plan 06's sign-out flow knows what view to drop to), the SignInModal framingLabel prop contract (plan 06/07 use it for the D-10 upgrade flow), and the OnboardingScreen.signedIn step-count invariant (so plan 11+ doesn't reintroduce the api-key step for signed-in users).
</output>
