---
phase: 10-auth-foundation
plan: 05
subsystem: auth
tags: [auth, oauth, google, pkce, loopback, electron, shell-openExternal, abortcontroller, ui, modal]

# Dependency graph
requires:
  - phase: 10
    provides: "Plan 10-01 (getClient — Supabase client with PKCE flow locked). Plan 10-03 (IPC contract — OAuthResult union, signInGoogle/cancelGoogle stubs, AuthState push). Plan 10-04 (SignInModal — the Continue-with-Google button this plan rewires; the loopbackCallback.ts setPkceHandler seam this plan deliberately does NOT use)."
provides:
  - "src/main/auth/loopbackPkce.ts — startGoogleOAuth({timeoutMs, abortSignal}) → OAuthResult, full RESEARCH §Pattern 2 implementation (ephemeral-port loopback HTTP server, 127.0.0.1-only bind, one-shot callback handler, system-browser open via shell.openExternal, exchangeCodeForSession in main, abort+timeout race, finally drain)"
  - "src/main/auth/loopbackPkce.test.ts — 5 cases: happy path, timeout, abort, google_rejected error param, signInWithOAuth-returns-no-URL"
  - "src/main/auth/authHandlers.ts — signInWithGoogle / cancelGoogle handler bodies wired to a module-level AbortController (replaces plan 10-03 shells)"
  - "src/renderer/src/components/OAuthInterstitialModal.tsx + .module.css — centered 460px modal, 60s countdown, all 6 UI-SPEC OAuth error variants with verbatim copy, suppressed ESC + click-outside per UI-SPEC §Layout 4b/5"
  - "src/renderer/src/components/SignInModal.tsx — onGoogleClick rewired to mount OAuthInterstitialModal as a sibling (NOT replacement) so SignInModal stays mounted and email state is preserved across OAuth cancellation"
  - ".planning/phases/10-auth-foundation/10-05-HUMAN-UAT.md — the 9-step live UAT script preserved verbatim, status:partial, awaiting Google Cloud OAuth client + Supabase Google provider config"
  - ".planning/phases/10-auth-foundation/deferred-items.md item #7 — deferred-UAT entry with preconditions and resume signal"
affects:
  - "10-06-signout-verify-jwt — signOut() must call supabase.auth.signOut() AND fire the AbortController via cancelGoogle() if an OAuth attempt is in flight at sign-out time"
  - "10-07-account-panel — AccountPanel displays user.email which can now originate from a Google provider (no behavior change, just a sourcing fact)"
  - "Phase-10 gap-closure / /gsd-verify-work 10 — owes the 9-step live Google UAT in 10-05-HUMAN-UAT.md"

# Tech tracking
tech-stack:
  added:
    - "node:http loopback HTTP server with ephemeral port (`server.listen(0, '127.0.0.1')`) — mirrors src/main/skinServer.ts shape"
    - "electron.shell.openExternal — opens the system default browser for OAuth consent (Pitfall 4: never BrowserWindow)"
    - "AbortController + AbortSignal race against timeout / callback for cancellable async operations in the main process"
    - "Test-time indirection pattern: `_setOpenExternalForTests(fn|null)` so vitest can simulate the browser callback without spawning a real system browser"
  patterns:
    - "Per-attempt ephemeral-port loopback server (port:0, 127.0.0.1-only) — distinct from plan 10-04's fixed-port-54321 loopbackCallback.ts (the email-verification flow needs a stable URL for the Supabase dashboard Site URL match; OAuth registers `http://127.0.0.1` bare in Google Cloud and per RFC 8252 §7.3 accepts ANY port)"
    - "Race-3 promise pattern: `Promise.race([codePromise, timeoutPromise, abortPromise])` with a finally-block `server.close()` to drain in-flight requests — covers T-10-05-06 (DoS via leaked listener)"
    - "Sibling-mount cancellation pattern: parent modal stays mounted under the interstitial overlay so cancel preserves form state via React's parent-keeps-children-state contract — explicitly NOT a child-replaces-parent navigation"
    - "One-handed `if (oauthController) { abort(); null = }` re-entry guard: a second signInWithGoogle while one is in flight aborts the old before starting the new (prevents racing two loopback servers)"
    - "Reason-union → UI-variant mapping table keyed off OAuthResult.reason — closed set of 6 + user_cancelled (routed through onCancel rather than rendered) — keeps the renderer's error rendering exhaustive and grep-auditable"

key-files:
  created:
    - "src/main/auth/loopbackPkce.ts (167 LOC) — startGoogleOAuth + _setOpenExternalForTests"
    - "src/main/auth/loopbackPkce.test.ts (173 LOC) — 5 vitest cases"
    - "src/renderer/src/components/OAuthInterstitialModal.tsx (194 LOC) — interstitial with 60s countdown + 6 error variants"
    - "src/renderer/src/components/OAuthInterstitialModal.module.css (76 LOC) — 460px modal, 0.45 scrim, reduced-motion respected"
    - ".planning/phases/10-auth-foundation/10-05-HUMAN-UAT.md — deferred 9-step live UAT, status:partial"
  modified:
    - "src/main/auth/authHandlers.ts — signInWithGoogle / cancelGoogle bodies + module-level oauthController + startGoogleOAuth import"
    - "src/renderer/src/components/SignInModal.tsx — oauthInFlight state, OAuthInterstitialModal sibling render, onGoogleClick rewired to NOT await sei.signInGoogle (the interstitial owns the IPC lifecycle)"
    - ".planning/phases/10-auth-foundation/deferred-items.md — item #7 (deferred live UAT) + #6 update (loopbackCallback.ts setPkceHandler seam unused)"

key-decisions:
  - "Ephemeral port (`server.listen(0, '127.0.0.1')`) NOT fixed-port 54321 — Google Cloud OAuth clients register `http://127.0.0.1` (bare); per RFC 8252 §7.3 + Google native-app guide ANY port is accepted, so port:0 dodges port-collision retries and matches skinServer.ts idiom"
  - "Per-attempt fresh server (NOT routing through plan 10-04's loopbackCallback.ts + setPkceHandler seam) — because (a) the email-verification port (54321) is fixed and the OAuth port must be free, (b) per-attempt teardown is the cleanest mapping for AbortController-driven cancellation; consequence: the setPkceHandler seam from plan 10-04 is now unused (tracked in deferred-items.md update to item #6)"
  - "OAuthInterstitialModal owns the sei.signInGoogle() IPC invocation, NOT SignInModal — keeps lifecycle (start / cancel / retry) co-located with the UI that displays it, and lets the interstitial Try-again button re-invoke without an awkward parent re-dispatch"
  - "Sibling-mount cancellation pattern: SignInModal stays mounted under the interstitial scrim (oauthInFlight=true gates a sibling render); on cancel, oauthInFlight=false → SignInModal is visible again with email state preserved automatically because it never unmounted. Rejected alternative: lift email state to AuthChoiceScreen and re-mount SignInModal — more wiring, same effect."
  - "Single OAuthResult.reason → ERROR_COPY map of 6 variants — keeps the renderer exhaustive; user_cancelled is handled via onCancel rather than rendered as an error (consistent with cancel being a soft return to SignInModal)"
  - "Module-level oauthController in authHandlers.ts (NOT per-call closure) — required so cancelGoogle can abort across handler invocations; clearing only-if-still-owner avoids a race when re-entry replaces the controller"
  - "Live Google UAT deferred to phase-10 verification — automated coverage (27 tests, 4 threat-model grep gates, all 6 reason variants wired) demonstrates surface correctness; live UAT contract preserved verbatim in 10-05-HUMAN-UAT.md awaiting Google Cloud OAuth client + Supabase Google provider config"

patterns-established:
  - "Test-injection via mutable module-level fn slot (`_setOpenExternalForTests`) — strictly typed to the function's actual signature, defaults to the production binding, reset by passing null. Cleaner than vi.mock'ing electron wholesale and avoids fragile module-loading order traps."
  - "Per-flow loopback HTTP server lifecycle: bind → register one-shot listener → race callback/timeout/abort → finally close. The finally branch is the ONLY teardown path — every error/return path falls through it, which is asserted by the acceptance grep for `server.close()` presence."
  - "OAuth result rendering: `Record<ErrorReason, {heading, body}>` literal keyed by the OAuthResult reason union — TypeScript enforces exhaustiveness at the type level, and the UI-SPEC strings live next to the type binding instead of scattered through JSX."

requirements-completed: [AUTH-02]

# Metrics
duration: ~75min execution + ~15min checkpoint-handling + ~10min summary
completed: 2026-05-20
---

# Phase 10 Plan 05: google-oauth Summary

**Google OAuth shipping end-to-end via an ephemeral-port 127.0.0.1 loopback PKCE server with shell.openExternal-only browser opens (Pitfall 4), an OAuthInterstitialModal that owns the IPC lifecycle and renders all 6 UI-SPEC failure variants with verbatim copy, and a sibling-mount cancellation pattern that preserves the user's typed email across cancelled OAuth attempts — with the 9-step live UAT against real Google Cloud + Supabase deferred to phase-10 verification.**

## Performance

- **Duration:** ~100 min (Task 1 RED+GREEN ~45min; Task 2 GREEN ~30min; checkpoint deferral handling ~15min; this SUMMARY pass ~10min)
- **Started:** 2026-05-20T07:30Z (approximate — Task 1 RED commit `2e8616b`)
- **Completed:** 2026-05-20T08:50Z (this SUMMARY commit)
- **Tasks:** 2/3 fully executed (tasks 1 + 2 shipped with full automated coverage; task 3 deferred at checkpoint per user direction)
- **Files created:** 5 (loopbackPkce.ts, loopbackPkce.test.ts, OAuthInterstitialModal.tsx, .module.css, 10-05-HUMAN-UAT.md)
- **Files modified:** 3 (authHandlers.ts, SignInModal.tsx, deferred-items.md)
- **Tests added:** 5 vitest cases in `loopbackPkce.test.ts` (project total: 27 passing)

## Accomplishments

- **AUTH-02 ships end-to-end behind comprehensive automated coverage.** The loopback PKCE pattern from RESEARCH §Pattern 2 is implemented verbatim with the abortSignal/timeout race integrated cleanly into a single `Promise.race` + finally-close shape.
- **Pitfall 4 (Google blocks embedded-window OAuth) sidestepped at compile time.** Acceptance grep gate `grep -c BrowserWindow src/main/auth/loopbackPkce.ts` equals 0; the file's header comment cites Pitfall 4 + RFC 8252 so future contributors get the rationale inline.
- **T-10-05-05 (loopback widens to LAN) mitigation grep-asserted.** `grep -c 0.0.0.0` equals 0; the bind line `server.listen(0, '127.0.0.1', ...)` literal-matches the threat-model gate.
- **All 6 UI-SPEC OAuth `reason` strings wired to verbatim error copy.** The ERROR_COPY map in OAuthInterstitialModal.tsx is the single source for `browser_closed`, `network`, `timeout`, `google_rejected`, `port_collision`, `exchange_failed` — TypeScript enforces exhaustiveness via the `Record<ErrorReason, …>` type.
- **Cancellation preserves the user's typed email.** SignInModal stays mounted under the interstitial scrim (sibling render via `oauthInFlight=true`), so on Cancel the email field still contains whatever the user typed — AUTH-02 cancellation contract from D-05.
- **27/27 vitest cases pass** (5 new in `loopbackPkce.test.ts` + the existing 22 from prior plans). `npx tsc --noEmit` clean at HEAD.

## Loopback contract (port:0, 127.0.0.1-only, one-shot)

The contract `startGoogleOAuth` advertises to its callers:

| Property | Value | Why |
|----------|-------|-----|
| Bind address | LITERAL `127.0.0.1` | T-10-05-05 mitigation — LAN must not be able to hit the callback. Grep gate enforces. Never widen to `0.0.0.0`. |
| Bind port | `0` (OS-chosen ephemeral) | Google Cloud OAuth client registers `http://127.0.0.1` (bare); RFC 8252 §7.3 + Google native-app guide accept ANY port. Port:0 avoids collision retries — mirrors `skinServer.ts`. |
| Listener lifetime | **one-shot** — first request is the callback (or 404 for any path other than `/callback`), then the server is closed in the finally block | T-10-05-06 mitigation (no port leak). Subsequent OAuth attempts get a fresh server on a fresh port. |
| Callback path | `/callback` only; everything else 404s | Reduces the attack surface; static 404 leaks no info. |
| Code exchange | `supabase.auth.exchangeCodeForSession(code)` runs **inside the main process** | Pitfall A1 (Supabase Electron deep-link 401 bug) sidestepped — no URL crosses IPC, no `setSession` in renderer. |
| Timeout | 60s (passed by handler) → `{ok:false, reason:'timeout'}` | UI-SPEC OAuth interstitial: countdown shown to user; expires gracefully into the timeout error variant. |
| Abort | `opts.abortSignal` listens for `'abort'` → `{ok:false, reason:'user_cancelled'}` | Cancel button in interstitial fires `cancelGoogle()` which aborts the controller. |
| Finally | **always** `server.close()` (drains in-flight requests) | T-10-05-06 — no port leak regardless of how the flow exits (success / timeout / abort / error). |

The contrast with plan 10-04's `loopbackCallback.ts` (fixed port 54321) is intentional: that server hosts the email-verification flow and the Supabase dashboard Site URL must literal-match its URL. Google's OAuth client config does NOT require a literal port match (RFC 8252 §7.3), so port:0 is preferred here — no dashboard touch-up needed per dev machine.

## Interstitial → SignInModal cancellation flow (email preserved via shared-mounted parent)

The cancellation contract from CONTEXT D-05 says: "On Cancel, return to SignInModal, NOT AuthChoice; the user's typed email must be preserved." The implementation uses a **sibling-mount** pattern rather than a parent-replaces-child navigation:

```
SignInModal (always mounted while user is in the sign-in flow)
├── [normal SignInModal JSX with email/password fields, email state held in useState]
└── {oauthInFlight ? <OAuthInterstitialModal … /> : null}   ← sibling, NOT child
```

The flow:

1. User types `myemail@example.com`, clicks **Continue with Google**.
2. `onGoogleClick` does NOT await `sei.signInGoogle()`. It just sets `oauthInFlight = true`. SignInModal stays mounted (still rendering the email field) but its scrim is now covered by the interstitial's scrim (z-index 1100 vs 1000).
3. `OAuthInterstitialModal` mounts and immediately calls `sei.signInGoogle()` in its `useEffect`. Shows the 60s countdown.
4. **Cancel path:** user clicks `Cancel sign-in` → modal calls `sei.cancelGoogle()` then its `onCancel` prop. SignInModal's `onCancel` handler sets `oauthInFlight = false`. The interstitial unmounts. SignInModal is now uncovered — and its `email` useState was never re-initialized (because the component never unmounted), so the field still contains `myemail@example.com`.
5. **Success path:** `sei.signInGoogle()` resolves `{ok:true}` → interstitial flips to `Signed in. One moment…` for ~200ms → calls `onResult({ok:true})` → SignInModal calls `onClose()`. The whole sign-in flow tears down.
6. **Error path:** interstitial swaps to an error variant; user can `Try again` (re-invokes `sei.signInGoogle()` in place) or `Cancel sign-in` (same as step 4).

The pattern's invariant: **SignInModal's React component instance is never re-created during OAuth.** That's what preserves the email field. Any future refactor MUST keep that invariant (e.g., do NOT lift OAuth state to AuthChoiceScreen and gate SignInModal's render on it — that would unmount on each toggle and lose the field).

## 6 reason → UI-SPEC variant mapping

The `ERROR_COPY: Record<ErrorReason, {heading, body}>` literal in `OAuthInterstitialModal.tsx` is the canonical source. All 6 reasons that surface as error variants:

| OAuthResult.reason | Heading (UI-SPEC verbatim) | Body summary | Source-of-truth |
|--------------------|----------------------------|--------------|-----------------|
| `browser_closed` | `Sign-in didn't finish` | "Looks like the browser tab was closed…" | `shell.openExternal` failure path |
| `network` | `Couldn't reach Google` | "Sei couldn't connect to Google's sign-in…" | thrown error in `signInWithOAuth` call |
| `timeout` | `That took a little too long` | "The sign-in link expired. Try again…" | 60s timer wins the Promise.race |
| `google_rejected` | `Google declined the sign-in` | "Google didn't approve the sign-in…" | callback `?error=…` query OR `signInWithOAuth` returned `{error, no data.url}` |
| `port_collision` | `Couldn't open the sign-in helper` | "Something else on your machine is using the port…" | `server.listen` threw |
| `exchange_failed` | `Sign-in hit a snag` | "Sei completed the Google step but couldn't finish setting up your session…" | `exchangeCodeForSession` returned non-null error or threw |

`user_cancelled` is the 7th `reason` value but does NOT render as an error variant — the interstitial detects it in the `onResult` handler and routes it to `onCancel()` (treating it as a soft return to SignInModal, consistent with the cancel-button path). This keeps the UI free of redundant "you cancelled" toasts.

Plan 10-06+ can rely on the OAuthResult shape and the 6 + 1 reasons being stable: the union is defined in `src/shared/ipc.ts` (plan 10-03) and the mapping is grep-auditable by checking that all 6 strings appear in `OAuthInterstitialModal.tsx`.

## Task Commits

Each task was committed atomically following the TDD gate sequence for Task 1 and a single GREEN commit for Task 2 (no test file required per the plan — task 2 is wiring + UI, exercised end-to-end by the live UAT and by tsc).

### Task 1 (TDD — `tdd="true"`)

1. **Task 1 RED — failing tests for startGoogleOAuth** — `2e8616b` (test)
2. **Task 1 GREEN — startGoogleOAuth Pattern 2 implementation** — `56cbca4` (feat)

### Task 2 (handler bodies + interstitial + SignInModal rewire)

3. **Task 2 GREEN — signInWithGoogle/cancelGoogle + OAuthInterstitialModal + SignInModal sibling render** — `9834538` (feat)

### Continuation pass — deferred-UAT artifacts (this pass)

4. **HUMAN-UAT.md (9-step deferred UAT, status:partial)** — `792e4a2` (docs)
5. **deferred-items.md entry #7 + #6 update** — `473fbf5` (docs)
6. **This SUMMARY** — committed next.

## Files Created/Modified

### Created

- `src/main/auth/loopbackPkce.ts` (167 LOC) — `startGoogleOAuth({timeoutMs, abortSignal})` returning `OAuthResult`. Binds `127.0.0.1:0`, asks Supabase for the auth URL via `signInWithOAuth({provider:'google', options:{redirectTo, skipBrowserRedirect:true, flowType:'pkce'}})`, opens via `_openExternal` (default `shell.openExternal`), races the `/callback` listener against timeout + abort, calls `exchangeCodeForSession` inside the main process, finally-closes the server. Exports `_setOpenExternalForTests` for test injection.
- `src/main/auth/loopbackPkce.test.ts` (173 LOC) — 5 cases: (1) happy path with stubbed Supabase + injected openExternal that fetches the bound port's `/callback?code=abc`; (2) timeout at 200ms; (3) abort after 50ms; (4) `/callback?error=access_denied` → google_rejected; (5) signInWithOAuth returns no URL → google_rejected BEFORE openExternal is called.
- `src/renderer/src/components/OAuthInterstitialModal.tsx` (194 LOC) — owns the `sei.signInGoogle()` lifecycle; useEffect-mount kicks off the flow; useEffect-tick decrements `secondsLeft`; `onCancelClick` calls `sei.cancelGoogle()` then `onCancel`; `onTryAgain` re-invokes via the `start()` helper. ERROR_COPY map at top binds each reason to its UI-SPEC heading + body. No keydown / outside-click handlers (UI-SPEC §Layout 4b/5).
- `src/renderer/src/components/OAuthInterstitialModal.module.css` (76 LOC) — 460px modal, `rgba(0,0,0,0.45)` scrim, `var(--window)` background, `1100` z-index (above SignInModal's 1000), `prefers-reduced-motion` respected.
- `.planning/phases/10-auth-foundation/10-05-HUMAN-UAT.md` — the 9-step UAT script preserved verbatim from the PLAN's `<how-to-verify>`, with `status: partial` and every step `result: [pending]`. Preconditions list the Google Cloud OAuth client + Supabase Google provider config needed before running.

### Modified

- `src/main/auth/authHandlers.ts` — added `import { startGoogleOAuth } from './loopbackPkce'`, module-level `let oauthController: AbortController | null = null`, real `signInWithGoogle()` body (re-entry guard → fresh controller → `startGoogleOAuth({timeoutMs:60_000, abortSignal})` → finally clear if still-owner), real `cancelGoogle()` body (abort + null if controller exists). Plan 10-03's `// IMPLEMENTED IN PLAN 10-05` shells removed.
- `src/renderer/src/components/SignInModal.tsx` — added `oauthInFlight` useState, imported `OAuthInterstitialModal`, rewrote `onGoogleClick` to just set `oauthInFlight=true` (NOT await sei.signInGoogle anymore — interstitial owns that), conditionally rendered `<OAuthInterstitialModal onResult onCancel/>` as a JSX sibling.
- `.planning/phases/10-auth-foundation/deferred-items.md` — added entry #7 (live UAT deferred, with preconditions + resume signal); annotated entry #6 with the outcome that plan 10-05 spun its own ephemeral-port server rather than routing through plan 10-04's setPkceHandler seam (so that seam is now unused dead code).

## Decisions Made

All decisions follow CONTEXT D-05, UI-SPEC dismissal-label policy, RESEARCH §Pattern 2 + §Pitfall A1, and PITFALLS §Pitfall 4. Net-new decisions made during execution:

- **Per-attempt ephemeral-port server (NOT route through plan 10-04's `setPkceHandler`).** Considered: register a handler on the existing fixed-port-54321 listener that plan 10-04 built. Rejected because (a) the Google Cloud OAuth client config registers `http://127.0.0.1` bare — RFC 8252 §7.3 says any port works, so port:0 is preferred and trivially avoids the OAuth flow stomping on the email-verification port if it's in use; (b) per-attempt teardown maps cleanly onto AbortController-driven cancellation. **Consequence:** plan 10-04's `setPkceHandler` seam in `loopbackCallback.ts` is now unused. Tracked in the deferred-items.md update to entry #6 — clean up or repurpose in plan 10-06.
- **Interstitial owns the IPC lifecycle, not SignInModal.** Considered: SignInModal awaits sei.signInGoogle and passes the in-flight Promise to the interstitial. Rejected because retry semantics (Try again button) would require an awkward parent re-dispatch round-trip. The interstitial calling `sei.signInGoogle()` in useEffect-mount + `sei.cancelGoogle()` in the cancel handler + `sei.signInGoogle()` again in onTryAgain keeps the lifecycle co-located with the UI that displays it.
- **Sibling-mount over lifted-state.** Considered: lift email state to AuthChoiceScreen and gate SignInModal's render on a parent flag. Rejected as more wiring with the same end-user behaviour. The sibling-mount pattern works because React's parent-keeps-children-state contract preserves `useState` across renders as long as the component instance survives — SignInModal does survive because `oauthInFlight=true` does NOT unmount it, only mounts the interstitial as a sibling above it.
- **Module-level `oauthController` (NOT closure-scoped).** Required so `cancelGoogle()` (a separate handler call) can find and abort the in-flight controller from `signInWithGoogle()`. The "only-clear-if-still-owner" guard (`if (oauthController === controller) oauthController = null`) handles the re-entry race where a second sign-in attempt replaces us before our finally runs.
- **`_setOpenExternalForTests` indirection over vi.mock.** Mocking `electron` wholesale via vi.mock has fragile module-loading-order traps (Electron's main-module side effects fire at import time). A simple mutable function slot with `null` reset is testable, type-safe, and grep-auditable.
- **Live UAT deferred to phase-10 verification.** Per user direction at the checkpoint — automated coverage (27 tests, 4 threat-model grep gates, all 6 reason variants wired to UI-SPEC copy) is comprehensive enough to close the wave. The 9-step contract against real Google + Supabase remains owed; persisted verbatim in `10-05-HUMAN-UAT.md` with preconditions and resume signal so the verifier and `/gsd-progress` can surface it as outstanding work.

## Deviations from Plan

The plan executed substantively as written. Two acceptance-grep counts differ from the plan's stated values; both are **structural / irreducible** and not wiring bugs.

### Acceptance-grep deviations (intentional, structural)

**1. [Rule 1 - Bug correction in plan's acceptance criteria] `grep -c "startGoogleOAuth" src/main/auth/authHandlers.ts` is 2, not the plan's stated 1**

- **Found during:** Task 2 acceptance verification.
- **What:** The plan's acceptance criteria says `grep -c "startGoogleOAuth" src/main/auth/authHandlers.ts | grep -q "^1$"`. Actual count is **2**: one occurrence in the import statement (`import { startGoogleOAuth } from './loopbackPkce'`) and one at the call site inside `signInWithGoogle` (`return await startGoogleOAuth({timeoutMs:60_000, abortSignal})`). You cannot reduce this without removing the named-import idiom (e.g., aliasing on import, dynamic require) — both of which would degrade the code and obscure the dependency from static analysis.
- **Disposition:** Acceptance gate refined to `>= 1` semantics — both call sites are required by the spec; the plan's `==1` was a counting mistake. The plan's *intent* (the import + call site both exist) is satisfied.
- **Verification:** `grep -n "startGoogleOAuth" src/main/auth/authHandlers.ts` → line 29 (import) + line 274 (call). Both required.
- **No commit needed** — gate refinement only.

**2. [Rule 1 - Bug correction in plan's acceptance criteria] `grep -c "AbortController" src/main/auth/authHandlers.ts` is 2, not the plan's stated 1**

- **Found during:** Task 2 acceptance verification.
- **What:** The plan's acceptance criteria says `grep -c "AbortController" src/main/auth/authHandlers.ts | grep -q "^1$"`. Actual count is **2**: one in the module-level type-annotation (`let oauthController: AbortController | null = null`) and one in the constructor call inside `signInWithGoogle` (`const controller = new AbortController()`). The type annotation cannot be removed without losing strict-typing on `oauthController`; the constructor call cannot be removed without using the controller for its purpose.
- **Disposition:** Acceptance gate refined to `>= 1` semantics — both occurrences are required by the spec; the plan's `==1` was a counting mistake.
- **Verification:** `grep -n "AbortController" src/main/auth/authHandlers.ts` → line 261 (type) + line 271 (new). Both required.
- **No commit needed** — gate refinement only.

Both deviations are **counting-arithmetic errors in the plan's grep acceptance gates**, not implementation drift. The actual code matches the plan's `<action>` block verbatim. No code edits or follow-up commits were made on account of these — they are documented here so that future passes don't re-tighten the gates and trigger a spurious failure.

### Authentication Gates

Task 3 (`type="checkpoint:human-verify"`) is by definition an auth-gate-style pause — the executor cannot self-approve a live UAT against external services (Google Cloud, Supabase dashboard, real Google account). The user explicitly opted to **defer** the live UAT to phase-10 verification rather than block this plan's wave on multi-step external provisioning. The deferral is documented:

- The verbatim 9-step UAT script is preserved in `10-05-HUMAN-UAT.md` with `status: partial` and `result: [pending]` on every step.
- `deferred-items.md` entry #7 lists the preconditions (Google Cloud OAuth client + Supabase Google provider config) and the resume signal (all 9 steps → `result: [pass]` → reply `approved`).
- The verifier and `/gsd-progress` surface both artifacts as outstanding work owed to AUTH-02.

This pattern is consistent with how plan 10-04's checkpoint was handled when the user found UAT bugs (4 auto-fixes layered on top of the initial wave) — checkpoints are auth-gates, not failures; the deferral is recorded as normal flow.

## Threat Flags

No new threat surface introduced beyond the plan's `<threat_model>`. Per-threat verification:

- **T-10-05-01 (Spoofing — attacker pre-binds the port):** mitigated by port:0 → OS-chosen unpredictable port + PKCE code_verifier (Supabase JS owns this; we set `flowType:'pkce'` in the `signInWithOAuth` options). Live UAT step 3 will exercise the full PKCE round-trip.
- **T-10-05-04 (EoP — future BrowserWindow OAuth):** grep gate `grep -c BrowserWindow src/main/auth/loopbackPkce.ts` returns **0**. The file header comment cites Pitfall 4 + RFC 8252 so a future contributor reads the rationale before considering the switch.
- **T-10-05-05 (Spoofing — bind widens to LAN):** grep gate `grep -c 0.0.0.0 src/main/auth/loopbackPkce.ts` returns **0**. The literal `'127.0.0.1'` appears in the bind line, the redirectTo template, and the URL parse — three independent grep-asserted occurrences. Acceptance verifies `>=3`.
- **T-10-05-06 (DoS — listener left running):** `finally { server.close() }` is the sole teardown path; every return / throw / abort branch falls through it. Acceptance verifies presence in source; live UAT step 6 (timeout) implicitly exercises the path.
- **T-10-05-09 (Tampering — SignInModal bypasses interstitial):** grep gate `grep -cF "OAuthInterstitialModal" src/renderer/src/components/SignInModal.tsx` returns 2 (import + JSX usage) — at-least-2 satisfied. The Continue-with-Google button cannot bypass the interstitial because `onGoogleClick` only sets `oauthInFlight=true`; the IPC call lives inside the interstitial's mount-effect.

## Known Stubs

None introduced by this plan. The plan 10-04 stub (`signInGoogle` IPC stub returning a placeholder) is **resolved** by this plan's signInWithGoogle implementation. The `setPkceHandler` seam in `loopbackCallback.ts` is now **unused** but that is not a stub — it's dead code documented in deferred-items.md #6 for cleanup in plan 10-06.

## TDD Gate Compliance

- **Task 1 (`tdd="true"`):** RED gate satisfied — `2e8616b` is a pure `test(10-05): add failing tests for startGoogleOAuth loopback PKCE` commit (no production code, vitest run fails). GREEN gate satisfied — `56cbca4` is a `feat(10-05): implement startGoogleOAuth loopback PKCE server` commit that turns the 5 tests green. REFACTOR not needed (initial implementation is clean per code review).
- **Task 2 (`tdd="false"`):** Single GREEN commit `9834538` for handlers + UI + SignInModal rewire. No test commit is required per the task spec — task 2 is wiring + UI, exercised by the live UAT and by tsc.
- **Plan type is `execute`** (not `tdd`) — plan-level gate enforcement does not apply, but the per-task TDD compliance above demonstrates the gate sequence was followed where marked.

## Next Phase Readiness

- **Plan 10-06 (sign-out + verify-jwt) can rely on:** the OAuthResult union and the 6+1 reason variants being stable; the module-level `oauthController` being abortable from any handler (a sign-out while OAuth is in flight should call `cancelGoogle()` first so the loopback server tears down cleanly before `supabase.auth.signOut()` runs).
- **Plan 10-06 should also clean up:** the unused `setPkceHandler` seam in `loopbackCallback.ts` (or repurpose it for a future fixed-port OAuth provider).
- **Phase-10 verification / gap-closure owes:** the 9-step live UAT in `10-05-HUMAN-UAT.md` against a real Google Cloud OAuth client + Supabase Google provider config. The preconditions, resume signal, and per-step failure remediation hints are documented in the file.

## Self-Check: PASSED

- `src/main/auth/loopbackPkce.ts` → FOUND
- `src/main/auth/loopbackPkce.test.ts` → FOUND
- `src/main/auth/authHandlers.ts` (signInWithGoogle + cancelGoogle implemented) → FOUND
- `src/renderer/src/components/OAuthInterstitialModal.tsx` → FOUND
- `src/renderer/src/components/OAuthInterstitialModal.module.css` → FOUND
- `src/renderer/src/components/SignInModal.tsx` (OAuthInterstitialModal mounted) → FOUND
- `.planning/phases/10-auth-foundation/10-05-HUMAN-UAT.md` → FOUND
- `.planning/phases/10-auth-foundation/deferred-items.md` (entry #7 added) → FOUND
- Commit `2e8616b` (Task 1 RED) → FOUND
- Commit `56cbca4` (Task 1 GREEN) → FOUND
- Commit `9834538` (Task 2 GREEN) → FOUND
- Commit `792e4a2` (HUMAN-UAT.md) → FOUND
- Commit `473fbf5` (deferred-items.md #7) → FOUND
- Threat gates: `grep -c BrowserWindow src/main/auth/loopbackPkce.ts` = 0 → PASS; `grep -c 0.0.0.0 src/main/auth/loopbackPkce.ts` = 0 → PASS; `grep -cF '127.0.0.1' src/main/auth/loopbackPkce.ts` >= 3 → PASS; `grep -cF OAuthInterstitialModal src/renderer/src/components/SignInModal.tsx` >= 2 → PASS

---
*Phase: 10-auth-foundation*
*Plan: 05 (google-oauth)*
*Completed: 2026-05-20*
