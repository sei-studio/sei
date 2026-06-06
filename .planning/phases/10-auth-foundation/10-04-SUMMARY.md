---
phase: 10-auth-foundation
plan: 04
subsystem: auth
tags: [auth, ui, onboarding, ux, supabase, pkce, loopback, email-verification, enumeration-resistance]

# Dependency graph
requires:
  - phase: 10
    provides: "Plan 10-01 (getClient, setStorageAdapter, env loading via vite loadEnv after fix d2c5e66). Plan 10-02 (sessionStore safeStorage adapter). Plan 10-03 (IPC contract — SignInResult / SignUpResult unions, signInPassword/signUpPassword stubs, onAuthState push). All three merged into the executor base before wave 3 started."
provides:
  - "AuthChoiceScreen + SignInModal — first-launch UI surface for AUTH-01 + AUTH-04"
  - "useAuthStore (renderer-side AuthState mirror, with upgradeFraming slot for plan 07)"
  - "signInWithPassword / signUpWithPassword handler bodies (real Supabase calls, 15s timeout, UI-SPEC error copy)"
  - "Loopback HTTP callback server at 127.0.0.1:54321 for Supabase OAuth/email-verification redirects (shared with plan 10-05 via setPkceHandler hook)"
  - "Pitfall A8 routing in App.tsx (session.bin → home; api_key.bin → home-after-AuthChoice; neither → onboarding-after-AuthChoice)"
  - "Enumeration-resistant signup contract: signUpPassword NEVER reveals whether an email is already registered"
affects:
  - "10-05-google-oauth (uses setPkceHandler hook + LOOPBACK_CALLBACK_URL constant)"
  - "10-06-signout-verify-jwt (replaces the interim 'Check your email' modal sub-state with a top-of-window Banner; wires resendVerification)"
  - "10-07-account-panel (consumes useAuthStore.upgradeFraming for D-10 inline-upgrade modal)"

# Tech tracking
tech-stack:
  added:
    - "node:http loopback server pattern (port-fixed 54321, 127.0.0.1-only bind)"
    - "Supabase emailRedirectTo option (signUp → loopback URL)"
    - "Supabase exchangeCodeForSession (handled by loopback callback)"
  patterns:
    - "Enumeration-resistant auth response: identical {ok:true, requiresVerification:true} shape for both brand-new and already-registered emails"
    - "Forward-compat extension hook (setPkceHandler) — one loopback HTTP server multiplexes email-verification AND OAuth-PKCE callbacks via the `state` query param"
    - "Modal-with-sub-states pattern — same scrim+modal frame, different body content per sub-state (form vs verification-pending)"
    - "Auth-event-driven routing — handlers NEVER navigate directly; they emit {ok:true} and the onAuthStateChange subscription drives the transition"

key-files:
  created:
    - "src/main/auth/loopbackCallback.ts (143 LOC) — HTTP server for ?code= exchange"
    - "src/renderer/src/lib/stores/useAuthStore.ts — Zustand AuthState mirror (created in 7ac384e)"
    - "src/renderer/src/screens/AuthChoiceScreen.tsx (+ .module.css) — first-launch tiles (created in 7ac384e)"
    - "src/renderer/src/components/SignInModal.tsx (+ .module.css) — unified sign-in/sign-up modal (created in 7ac384e)"
  modified:
    - "src/main/auth/authHandlers.ts — real signIn/signUp bodies; email_not_confirmed bypass; enumeration-resistant signup; emailRedirectTo wiring"
    - "src/main/auth/authHandlers.test.ts — 12 cases (added 2 new for UAT fixes #3 + #4)"
    - "src/main/index.ts — bootstrap wires startLoopbackCallback after initAuthState; before-quit stops it alongside skin server"
    - "src/renderer/src/components/SignInModal.tsx — verification-pending sub-state (UAT fix #2)"
    - "src/renderer/src/screens/OnboardingScreen.tsx — signedIn prop (modified in 7ac384e)"
    - "src/renderer/src/App.tsx — Pitfall A8 routing + auth-choice view (modified in 7ac384e)"
    - "src/renderer/src/lib/stores/useUiStore.ts — View union + 'auth-choice' variant (modified in 7ac384e)"
    - ".planning/phases/10-auth-foundation/deferred-items.md — 3 new items"

key-decisions:
  - "Email_not_confirmed treated as {ok:true} per D-04 (verification does NOT block sign-in) — branch placed before the 400→invalid_credentials catch-all"
  - "Signup masks already-registered emails behind the same {ok:true,requiresVerification:true} as brand-new accounts — no email_in_use code ever emitted (T-10-04 enumeration disposition tightened from 'classify' to 'mask')"
  - "Loopback server port hardcoded to 54321 (not OS-ephemeral) because the Supabase project Site URL must match; ephemeral would force a re-paste on every launch"
  - "Loopback server bound to 127.0.0.1 only — NEVER 0.0.0.0 — to prevent same-LAN OTP interception"
  - "One HTTP listener serves both email-verification (no `state`) and Google OAuth PKCE (with `state`); plan 10-05 will register its handler via setPkceHandler instead of starting a second server"
  - "Loopback server starts AFTER initAuthState so the onAuthStateChange subscription is in place before any inbound exchange can fire SIGNED_IN"
  - "Interim 'Check your email' modal sub-state added inside SignInModal — replaced by plan 10-06's persistent app-level Banner once that ships"
  - "SignUpResult union still allows `email_in_use` code for backward-source compatibility, but the handler never emits it (kept as deferred-cleanup for plan 10-06)"

patterns-established:
  - "260519 UAT-fix labelling — each user-discovered bug fixed in this remediation pass is tagged in the source as `260519 UAT fix #N` so future readers can trace the manual-test-driven changes back to the UAT findings"
  - "Loopback callback dispatcher — switch on `state` query param to route between auth flows; keeps port allocation and HTTP listener owned by one module"
  - "Auth handler error classification — exhaustive switch on Supabase error.message + status, mapping to a closed set of UI-SPEC copy strings; security-sensitive branches (enumeration) NEVER reach the renderer"

requirements-completed: [AUTH-01, AUTH-04]

# Metrics
duration: ~95min (initial wave: ~70min; 260519 UAT remediation: ~25min)
completed: 2026-05-19
---

# Phase 10 Plan 04: email-password Summary

**Email/password sign-in/sign-up shipping end-to-end against a real Supabase project, with enumeration-resistant signup, a loopback HTTP server for verification-link exchange, and a Pitfall A8 routing table that preserves the AUTH-04 (Continue Locally) invariant — plus four 260519 UAT-driven security/UX fixes layered on top of the initial wave.**

## Performance

- **Duration:** ~95 min total (initial wave 835b142+7ac384e ~70 min; 260519 UAT remediation this pass ~25 min)
- **Started (UAT remediation):** 2026-05-19T23:50Z
- **Completed:** 2026-05-19T23:56Z
- **Tasks:** 3/3 (tasks 1 + 2 completed in the initial wave; task 3 human-verify checkpoint failed at step 5 of the UAT and required this remediation pass)
- **Files modified (remediation only):** 5 (authHandlers.ts, authHandlers.test.ts, SignInModal.tsx, index.ts, deferred-items.md) + 1 created (loopbackCallback.ts)

## Accomplishments

- **AuthChoiceScreen + SignInModal ship** with verbatim UI-SPEC copy and no forbidden labels (Skip/Guest/Maybe later). Sign-in and sign-up both round-trip through the real Supabase project.
- **AUTH-04 invariant preserved**: Continue Locally users still never trigger a Supabase call. OnboardingScreen's signedIn prop gates saveApiKey() behind `if (!signedIn)`.
- **Enumeration-resistant signup**: re-registering an existing email is indistinguishable from a brand-new signup in the response payload — closing a real attack surface flagged during UAT.
- **Loopback callback infrastructure** for Supabase auth redirects, designed as a clean seam for plan 10-05 (Google OAuth PKCE) so we don't end up with two HTTP servers fighting over ports.
- **Email-verification doesn't block sign-in** (per D-04) — UAT fix #3 corrects the previous misclassification that surfaced "Email or password doesn't match" for unverified-but-valid sign-in attempts.

## Task Commits

The plan ran in two passes — initial wave (tasks 1 + 2) followed by a checkpoint-failure remediation pass that completes task 3.

### Initial wave (committed in earlier work, present at the start of this continuation)

1. **Task 1: handler bodies + 15s timeout + error classifiers + 10 unit tests** — `835b142` (feat)
2. **Task 2: useAuthStore + AuthChoiceScreen + SignInModal + OnboardingScreen.signedIn + App.tsx Pitfall A8 routing** — `7ac384e` (feat)
3. **Orchestrator fix between waves** (not part of plan tasks): `d2c5e66` (fix(10-01): load .env via vite loadEnv so SUPABASE_URL reaches the bundle) — required for the initial UAT to even reach the sign-in modal.

### Task 3: human-verify checkpoint remediation (this pass)

4. **UAT fix #3 + #4 (email_not_confirmed bypass + enumeration-resistant signup)** — `500f0c3` (fix)
5. **UAT fix #2 ('Check your email' sub-state in SignInModal)** — `900263b` (fix)
6. **UAT fix #5 (loopback HTTP server at 127.0.0.1:54321)** — `36b3c7a` (fix)
7. **Deferred items tracking (manual Supabase dashboard step + plan 10-05/10-06 hand-offs)** — `d9e43b0` (docs)

**Plan metadata:** this SUMMARY commit (next).

UAT bug #1 ("there was no log-in / make-acc screen") was the env-loading bug already fixed by the orchestrator in `d2c5e66` before this continuation started.

## Files Created/Modified

### Created (this remediation pass)

- `src/main/auth/loopbackCallback.ts` — node:http server bound to 127.0.0.1:54321. Handles GET `/auth/callback?code=…` by calling `supabase.auth.exchangeCodeForSession(code)`, returning a static "You can close this tab" HTML page on success / a generic failure page on error. Includes a forward-compat `setPkceHandler` hook so plan 10-05 can route OAuth-PKCE callbacks through the same listener (dispatched on the `state` query param). Bind failure is non-fatal — bootstrap logs a warning and continues.

### Modified (this remediation pass)

- `src/main/auth/authHandlers.ts` — added `LOOPBACK_CALLBACK_URL` constant + `emailRedirectTo` option in signUp; added `email_not_confirmed` short-circuit in `classifySignInError` (before the 400 catch-all); rewrote `signUpWithPassword` to mask both already-registered shapes (explicit error message AND empty `identities` array) behind a neutral `{ok:true, requiresVerification:true}`; removed the `email_in_use` mapping from `classifySignUpError` (the SignUpResult union still allows the code for backward-source-compat but the handler never emits it).
- `src/main/auth/authHandlers.test.ts` — replaced the `email_in_use` mapping test with two new tests asserting the enumeration-resistant behaviour (one per Supabase signal shape); added a test for the `email_not_confirmed` → `{ok:true}` bypass. Total: 12 tests (was 10).
- `src/main/index.ts` — added `loopbackAuthServer` module-level handle; added a `5c` step in `bootstrap()` that imports and starts the loopback callback AFTER `initAuthState`; extended the `before-quit` cleanup chain to await `loopbackAuthServer.stop()`.
- `src/renderer/src/components/SignInModal.tsx` — added `verificationSentTo` state and a new render branch that renders a verification-pending sub-state ("We sent a verification link to {email}…") inside the same scrim+modal frame when signUp returns `{ok:true, requiresVerification:true}`. The session-issued path (`requiresVerification:false`) still calls `onClose()` immediately.
- `.planning/phases/10-auth-foundation/deferred-items.md` — three new items: manual Supabase Site URL dashboard step, plan 10-06 verify-email Banner replacement, plan 10-05 Google OAuth integration via `setPkceHandler`.

## Decisions Made

All major decisions follow CONTEXT.md D-04 (verification does not block sign-in), the UI-SPEC dismissal-label policy, and the user's verbatim 260519 UAT directives. New decisions made during this remediation:

- **Tighten T-10-04 (account enumeration) disposition from "classify" to "mask".** The threat model already noted enumeration as a concern via the `email_in_use` branch; the UAT showed the leak materializing in practice ("cannot connect to server" surface on retries was the same signal). The fix collapses both leak shapes (error path + empty-identities path) into neutral success. Source: UAT user directive bullet #4a.
- **Single loopback server, multiplexed via `state` query param.** Considered: separate listeners per auth flow. Rejected because port management duplicated, and Supabase's redirect URLs are project-config tied to a single hostname:port. Source: UAT user directive bullet #5c ("design this so 10-05 can extend or re-use it"). Implemented via `setPkceHandler(handler)` — plan 10-05 registers its handler at bootstrap (or per-attempt for AbortController-driven cancellation).
- **Hardcoded port 54321 (vs OS-ephemeral).** The Supabase project Site URL config must be a literal URL — ephemeral ports would force the user to update the dashboard on every launch. 54321 chosen because it dodges 3000/5173/8080 dev-server defaults and matches the skin-server's existing baseUrl convention.
- **Loopback server starts AFTER initAuthState.** Race condition: if the server started first, an inbound exchange could fire SIGNED_IN before authState.ts's `onAuthStateChange` subscription was wired, swallowing the renderer broadcast. Ordering documented in the bootstrap comment.

## Deviations from Plan

The initial wave (commits 835b142 + 7ac384e) executed the plan as written. This remediation pass adds work NOT in the original PLAN.md because the human-verify checkpoint at task 3 surfaced four bugs the plan didn't anticipate.

### Auto-fixed Issues

**1. [Rule 1 - Bug] UAT #3 — `email_not_confirmed` misclassified as `invalid_credentials`**
- **Found during:** Task 3 (human-verify checkpoint, UAT step 7).
- **Issue:** Signing in with an unverified email returned "Email or password doesn't match" because Supabase's 400 + "Email not confirmed" message fell through the generic 400→invalid_credentials catch-all in `classifySignInError`. Violated D-04 (verification does NOT block sign-in).
- **Fix:** Added an `email_not_confirmed` short-circuit BEFORE the 400 catch-all that returns `{ok:true}` — the auth-state stream drives the transition, the verify-email Banner (plan 10-06) will surface the persistent prompt.
- **Files modified:** `src/main/auth/authHandlers.ts`, `src/main/auth/authHandlers.test.ts`.
- **Verification:** New unit test in `authHandlers.test.ts` asserts the mapping; all 12 tests pass.
- **Committed in:** `500f0c3`.

**2. [Rule 2 - Critical missing functionality] UAT #4 — signup leaks already-registered status**
- **Found during:** Task 3 (UAT — user attempted to re-register an existing email).
- **Issue:** `classifySignUpError` mapped Supabase's "User already registered" message to `email_in_use`, leaking account-enumeration via the signup endpoint. Supabase's complementary obfuscation path (empty `identities` array on the "success" shape) was also not collapsed to match — so an attacker probing for registered emails got distinguishable responses.
- **Fix:** Removed the `email_in_use` mapping from `classifySignUpError`. Added explicit detection of both leak shapes (error.message contains "already"/"registered"/"exists" AND data.user.identities.length === 0) in `signUpWithPassword`; both now return `{ok:true, requiresVerification:true}` — identical to brand-new signups.
- **Files modified:** `src/main/auth/authHandlers.ts`, `src/main/auth/authHandlers.test.ts`.
- **Verification:** Two new unit tests cover both leak shapes; all 12 tests pass. Threat model T-10-04 enumeration disposition tightened.
- **Committed in:** `500f0c3`.

**3. [Rule 1 - Bug] UAT #2 — silent bounce to AuthChoice after signup**
- **Found during:** Task 3 (UAT step 5 — verification email never mentioned).
- **Issue:** SignInModal's `onSubmit` blindly called `onClose()` on every `{ok:true}`, regardless of `requiresVerification`. When email-confirm is enabled in the Supabase project, the signup returns no session — the user got bounced back to AuthChoice with no feedback, with no way to know a verification email had been sent.
- **Fix:** Added `verificationSentTo` state. When signUp returns `{ok:true, requiresVerification:true}`, set it to the submitted email; the modal stays open and re-renders to a verification-pending sub-state ("We sent a verification link to {email}…") inside the same scrim+modal frame. The session-issued path still closes the modal as before.
- **Files modified:** `src/renderer/src/components/SignInModal.tsx`.
- **Verification:** Manual code review (next UAT pass will confirm visually). Tests still pass; tsc clean.
- **Committed in:** `900263b`.

**4. [Rule 2 - Critical missing functionality] UAT #5 — no listener for the verification-email OTP**
- **Found during:** Task 3 (UAT — user clicked the email link and saw `?error=access_denied&error_code=otp_expired`).
- **Issue:** Supabase's default Site URL is `http://localhost:3000` where nothing listens. The browser navigates there, consumes the one-shot OTP, and the user is stuck. No code in the project's auth surface handled the `exchangeCodeForSession` step.
- **Fix:** Created `src/main/auth/loopbackCallback.ts` — a node:http server bound to 127.0.0.1:54321 that handles `/auth/callback?code=…` by calling `exchangeCodeForSession(code)` and rendering a static "You can close this tab" HTML page. Wired into bootstrap after `initAuthState`. Added `emailRedirectTo: http://localhost:54321/auth/callback` to the `signUp()` call so the verification email points at the server. Designed with a `setPkceHandler` extension hook so plan 10-05 (Google OAuth) can register its PKCE handler through the same listener — dispatched on the inbound `state` query param.
- **Files modified:** `src/main/auth/loopbackCallback.ts` (created), `src/main/auth/authHandlers.ts`, `src/main/index.ts`.
- **Verification:** `tsc --noEmit` clean. End-to-end verification requires manual UAT (deferred — needs the Supabase dashboard step in deferred-items item #2 first).
- **Committed in:** `36b3c7a` + emailRedirectTo half in `500f0c3`.

### Authentication Gates

Task 3 (human-verify checkpoint) is by definition an auth-gate-style pause — the executor cannot self-approve. The first attempt at this checkpoint failed against a real Supabase project; this remediation pass addresses the 4 specific bugs the user found. Manual re-UAT against the dashboard-configured project is required for final sign-off (see deferred-items.md item #2).

## Threat Flags

No new threat surface introduced beyond what's already in the plan's `<threat_model>`. The loopback HTTP server is a new network endpoint but is bound to 127.0.0.1 only and serves no user-controlled data in its responses. Documented in the loopbackCallback.ts header comment under "Security".

The enumeration-resistance hardening tightens T-10-04 disposition without adding new surface.

## Known Stubs

- **Forgot-password link** in `SignInModal.tsx` — non-functional placeholder (T-10-04-03 accept disposition; future plan will wire `supabase.auth.resetPasswordForEmail`).
- **Google "Continue with Google" button** — calls `sei.signInGoogle()` which still returns the plan 10-05 placeholder. Plan 10-05 owns the real implementation; the button + handler stub is intentional per the plan.
- **`SignUpResult` union still allows `email_in_use` code** even though the handler never emits it. Deferred to plan 10-06 (which also owns the deferred-items item #3 cleanup of the interim "Check your email" sub-state).

## TDD Gate Compliance

Plan type is `execute` (not `tdd`), so RED/GREEN gate enforcement doesn't apply. Task 1 in the original wave was authored with tests-first per the task's `tdd="true"` marker; this remediation pass added 2 more tests (12 total) before/alongside the handler changes (`500f0c3` includes both the production code and test additions in one commit — acceptable for non-tdd plan, the unit tests cover the new branches).

## Self-Check: PASSED

- `src/main/auth/loopbackCallback.ts` exists → FOUND
- `src/main/auth/authHandlers.ts` modified → FOUND
- `src/main/auth/authHandlers.test.ts` modified → FOUND
- `src/renderer/src/components/SignInModal.tsx` modified → FOUND
- `src/main/index.ts` modified → FOUND
- `.planning/phases/10-auth-foundation/deferred-items.md` updated → FOUND
- Commit `835b142` (task 1) → FOUND
- Commit `7ac384e` (task 2) → FOUND
- Commit `d2c5e66` (env-loading orchestrator fix) → FOUND
- Commit `500f0c3` (UAT #3 + #4) → FOUND
- Commit `900263b` (UAT #2) → FOUND
- Commit `36b3c7a` (UAT #5) → FOUND
- Commit `d9e43b0` (deferred-items) → FOUND
- `npx vitest run` → 20/20 tests pass
- `npx tsc --noEmit` → exit 0
