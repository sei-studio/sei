---
phase: 10-auth-foundation
plan: 06
subsystem: auth
tags: [auth, signout, jwt, utility-process, message-port, verify-email, banner, modal, rate-limit, supabase, electron]

# Dependency graph
requires:
  - phase: 10
    provides: "Plan 10-01 (getClient — Supabase client with session storage adapter). Plan 10-02 (sessionStore — safeStorage-backed session.bin which signOut clears). Plan 10-03 (IPC contract — signOut / resendVerification handler shells, AuthState push, ResendVerificationResult union). Plan 10-04 (SignInModal verificationSentTo interim state which this plan INTENTIONALLY does not remove — see Deviations; withTimeout helper reused by resendVerification; useAuthStore consumed by VerifyEmailBanner). Plan 10-05 (OAuthResult union stable; cancelGoogle()'s module-level oauthController is NOT touched by signOut in this plan — see Deviations)."
provides:
  - "src/main/auth/authHandlers.ts — real signOut() + resendVerification() bodies (replacing plan 10-03 shells); setSupervisor() DI hook so handlers can reach the bot supervisor from a separate import graph"
  - "src/main/auth/jwtBridge.ts — initJwtBridge(supervisor) subscribes to supabase.auth.onAuthStateChange and forwards session.access_token to supervisor.updateJwt() on SIGNED_IN / TOKEN_REFRESHED / INITIAL_SESSION / USER_UPDATED; null on SIGNED_OUT. Also: initial push via getSession() immediately after subscribe. pushJwtToUtility + _disposeForTests exports."
  - "src/main/botSupervisor.ts — updateJwt(jwt) method on the BotSupervisor interface; module-local latestJwt state; initialJwt field added to the {type:'init', …} init payload posted to utilityProcess; {type:'jwt', jwt} postMessage to the active session's port1 when JWT rotates mid-session"
  - "src/main/ipc.ts — calls setSupervisor(deps.supervisor) during registerIpcHandlers so the auth-handler module has the supervisor handle before the first sei.signOut() IPC dispatch"
  - "src/main/index.ts — bootstrap order: createBotSupervisor → initJwtBridge(supervisor); jwtBridge init wrapped in try/catch with logger.warn (non-fatal — bot can still summon without JWT in Phase 10)"
  - "src/renderer/src/components/SignOutConfirmModal.tsx + .module.css — D-09 two-branch confirm modal (`Sign out?` vs `Sign out will stop your bot. Continue?`), `Stay signed in` dismissal + `Sign out` `kind=\"primary\"` confirm (NOT accent, NOT red), `Signing out…` submitting state, ESC + click-outside-to-close. NOT mounted by App.tsx in this plan — plan 10-07 wires the Settings Account-panel mount + onConfirm → sei.signOut()."
  - "src/renderer/src/App.tsx — VerifyEmailBanner: persistent, non-dismissable warn Banner with verbatim D-04 copy, rendered above the existing keychain Banner whenever `authState.kind === 'signed_in' && !authState.user.emailVerified`; condition is computed live to avoid stale closures (T-10-06-06)"
  - "src/main/auth/jwtBridge.test.ts (79 LOC) — 3 vitest cases: initial token push on init, TOKEN_REFRESHED push, SIGNED_OUT null push"
  - ".planning/phases/10-auth-foundation/10-06-HUMAN-UAT.md — the 8-step live UAT script preserved verbatim, status:partial, awaiting real Supabase account + inbox + bot summon"
  - ".planning/phases/10-auth-foundation/deferred-items.md item #8 — deferred-UAT entry with preconditions and resume signal; SUPERSEDES the suggestion in #3 to remove SignInModal's verificationSentTo interim state; PARTIALLY ADDRESSES #5 for the resend path"
affects:
  - "10-07-account-panel — must mount SignOutConfirmModal from the Settings Account row, wiring onConfirm to call sei.signOut(); must read useAuthStore + useDataStore.summon to compute the botRunning prop"
  - "Phase 11 (verify-first-modal / paywall) — VerifyEmailBanner is the layer-zero verify-email surface; plan 11 layers an action-blocking verify-first-modal on top of paid affordances (publish, buy credits) without duplicating the Banner"
  - "Phase 13 (cloud AI proxy) — drops in as the CONSUMER of the {type:'jwt'} message that botSupervisor already postMessages to the utilityProcess; no re-architecture needed, just an `if (msg.type === 'jwt') currentJwt = msg.jwt;` in the utility-process message handler plus Bearer-header use on outbound proxy requests"
  - "Phase-10 gap-closure / /gsd-verify-work 10 — owes the 8-step live UAT in 10-06-HUMAN-UAT.md; also still owes the signUp-path 429 mapping per deferred-items.md #5 (only the resend path is fixed by this plan)"

# Tech tracking
tech-stack:
  added:
    - "@supabase/supabase-js auth events SIGNED_IN / SIGNED_OUT / TOKEN_REFRESHED / INITIAL_SESSION / USER_UPDATED — Pitfall A4 push surface"
    - "supabase.auth.resend({type:'signup', email}) — email-verification resend RPC with built-in 60s rate-limit"
    - "Electron MessagePortMain.postMessage({type:'jwt', jwt}) — new outbound message vocabulary on the existing main↔utilityProcess channel (Phase 13 consumer)"
    - "Module-level DI handle pattern: let supervisorRef + setSupervisor(s) export — wires supervisor from ipc.ts into authHandlers.ts without forcing a circular import"
  patterns:
    - "Sign-out ordering contract: supervisor.stop() BEFORE auth.signOut() — verified by `awk '/supervisorRef.*stop/{a=NR} /auth\\.signOut/{b=NR} END{exit !(a<b)}' src/main/auth/authHandlers.ts` exiting 0. Source order is the gate, not a runtime check, because runtime ordering is enforced by `await` and a misordered source would silently break."
    - "JWT push event matrix: 4 events push token (SIGNED_IN, TOKEN_REFRESHED, INITIAL_SESSION, USER_UPDATED), 1 event pushes null (SIGNED_OUT), 1 event no-ops (PASSWORD_RECOVERY) — closed switch in `jwtBridge.ts` enforces exhaustiveness against the Supabase event union."
    - "Live-compute Banner conditional: `authState.kind === 'signed_in' && !authState.user.emailVerified` evaluated inline in JSX (not memoised, not captured by a useEffect) so a USER_UPDATED-driven `emailVerified` flip causes the Banner to unmount on the next render with no extra plumbing. T-10-06-06 mitigation."
    - "Submitting-state guard on confirm modal: `useState(false)` + `disabled={submitting}` on both buttons + `if (submitting) return` re-entry guard in handleConfirm + ESC and click-outside both check `!submitting` — prevents a double-RPC if the user mashes Sign out while the first sei.signOut() is in flight."
    - "Init-payload + push-on-rotate dual-channel pattern: every new utilityProcess session gets the latest JWT in its `{type:'init', …}` payload (initialJwt field), AND every subsequent TOKEN_REFRESHED rotates the live JWT via `{type:'jwt', jwt}` on the active session's port1. The bot picks up the right value either at boot or via rotation — there is no race where a new session boots with a stale JWT and then waits 50min for the next refresh."

key-files:
  created:
    - "src/main/auth/jwtBridge.ts (75 LOC) — initJwtBridge + onAuthStateChange subscription + pushJwtToUtility + _disposeForTests"
    - "src/main/auth/jwtBridge.test.ts (79 LOC) — 3 vitest cases"
    - "src/renderer/src/components/SignOutConfirmModal.tsx (87 LOC) — D-09 two-branch modal"
    - "src/renderer/src/components/SignOutConfirmModal.module.css (48 LOC) — 460px modal, 0.45 scrim alpha, reduced-motion respected"
    - ".planning/phases/10-auth-foundation/10-06-HUMAN-UAT.md — deferred 8-step live UAT, status:partial"
  modified:
    - "src/main/auth/authHandlers.ts (+111 / −few) — supervisorRef + setSupervisor + signOut body + resendVerification body, plan 10-03 // IMPLEMENTED IN PLAN 10-06 markers removed for the two implemented handlers"
    - "src/main/botSupervisor.ts (+32) — BotSupervisor.updateJwt interface decl + module-local latestJwt + initialJwt field on init payload + {type:'jwt'} postMessage in updateJwt"
    - "src/main/index.ts (+13) — initJwtBridge(supervisor) call after createBotSupervisor; wrapped in try/catch with logger.warn (non-fatal)"
    - "src/main/ipc.ts (+9) — setSupervisor(deps.supervisor) call inside registerIpcHandlers, executed before the auth-channel registrations"
    - "src/renderer/src/App.tsx (+15) — VerifyEmailBanner JSX block above the keychain Banner; consumes authState from useAuthStore"
    - ".planning/phases/10-auth-foundation/deferred-items.md — entry #8 added; supersedes #3 (verificationSentTo retention) and partially addresses #5 (resend path 429 mapping fixed)"

key-decisions:
  - "supervisor.stop() BEFORE auth.signOut() in signOut() — D-09 + T-10-06-09. The bot's final outbound request must flush under the still-valid JWT; otherwise a 401 against a just-revoked JWT would surface as a spurious error to the user. Acceptance: source-order awk proof."
  - "Module-level supervisorRef + setSupervisor() DI hook (NOT a constructor-injected deps shape on authHandlers) — minimal-diff over re-architecting the per-handler function exports into a class or factory. The risk of a test importing authHandlers without wiring supervisorRef is mitigated by the null-check (`if (supervisorRef && supervisorRef.getActiveId() !== null)`) — if no supervisor is wired, signOut skips the stop branch and just clears the session, which is the right behaviour in a test context."
  - "JWT push event matrix: 4 events push token + 1 pushes null + 1 no-ops — INITIAL_SESSION and USER_UPDATED are deliberately INCLUDED in the push set. INITIAL_SESSION lets a freshly-summoned bot pick up the JWT from a session that pre-existed the bridge subscription; USER_UPDATED lets the bot see a refreshed JWT after a profile-update RPC (some Supabase mutations trigger USER_UPDATED with a new access_token alongside the email_confirmed_at flip)."
  - "resendVerification rate-limit pattern-match is multi-signal: `status === 429` OR `m.includes('rate limit')` OR `m.includes('over_email_send_rate_limit')`. Supabase's error envelope varies across SDK versions; matching all three signals makes the mapping resilient to library upgrades. Verbatim user-facing copy: `Hold on — wait a minute before requesting another link.` (UI-SPEC §Empty/Error/Loading)."
  - "VerifyEmailBanner conditional is computed live, not memoised — `{authState.kind === 'signed_in' && !authState.user.emailVerified ? <Banner …/> : null}`. T-10-06-06: React's reconciler sees the change on the next push from main (USER_UPDATED → useAuthStore.setState → re-render). A memoised condition would risk a stale closure capturing the pre-flip authState."
  - "VerifyEmailBanner is NOT dismissable (no onDismiss prop) — UI-SPEC §Persistent Banner: verify-email is not a transient notice, it is a gate on paid affordances; allowing dismissal would let the user lose the path back to resending the link."
  - "SignOutConfirmModal NOT mounted by App.tsx in this plan — plan 10-07 wires the mount from Settings Account row. Rationale: the natural sign-out entry-point is the Settings panel (D-09), and that panel doesn't exist yet. Mounting the modal here would either require a fake trigger button in App.tsx (which would then need to be removed) or a temporary entry that confuses the plan-10 surface. Plan 10-07 reads the component + props contract from this plan's exported interface."
  - "SignInModal verificationSentTo RETAINED (deviation from deferred-items #3 suggestion) — the persistent Banner gates on `signed_in`, but `signUp` returns `{user, session:null}` when email confirmation is required, so authState stays `local` post-signup. The interim verificationSentTo block inside SignInModal covers that no-session window; removing it would silently drop UX for the most common signup case. The two states are complementary (Banner for resumed-unverified-session, modal block for fresh-signup-pending), not duplicative."
  - "Bot supervisor's updateJwt has try/catch around port1.postMessage — during teardown the port can be closed before updateJwt finishes; swallowing the throw avoids a noisy log on the otherwise-clean shutdown path. Caller is the auth-event listener, which has no recovery action anyway."
  - "Bootstrap order: createBotSupervisor → initJwtBridge(supervisor) — supervisor must exist before the bridge subscribes, because the bridge's first action is `supervisor.updateJwt(initialAccessToken)`. Failure to await initJwtBridge is non-fatal (logger.warn, continue) — bot can still summon without JWT in Phase 10; Phase 13 is the consumer."

patterns-established:
  - "Source-order awk proof for ordering contracts: `awk '/PATTERN_A/{a=NR} /PATTERN_B/{b=NR} END{exit !(a<b)}' file` exits 0 iff A appears before B in source. Used by T-10-06-09 to enforce supervisor.stop → auth.signOut ordering. Cheaper than a runtime test, grep-auditable in code review, and survives refactors because the patterns are stable substrings."
  - "Closed switch + Supabase event union: every onAuthStateChange consumer in the codebase should switch over the full event union (SIGNED_IN, SIGNED_OUT, TOKEN_REFRESHED, INITIAL_SESSION, USER_UPDATED, PASSWORD_RECOVERY) and either handle or explicitly no-op each case. TypeScript exhaustiveness via the AuthChangeEvent string-literal type catches future Supabase additions at compile time."
  - "Live JSX conditional over memoised derived state for fast-changing predicates: when the predicate is cheap (a boolean from store state) and the predicate's dependents are small (a single Banner mount), inline the conditional in JSX. The cost of re-evaluating on every render is dwarfed by the cost of a useMemo dep array, and there's no stale-closure surface."
  - "Phase-aware deferral: when a UX surface needs a parent that the next plan delivers (here: SignOutConfirmModal needs Settings Account row from plan 10-07), ship the component + interface and document the mount-deferral in the SUMMARY's affects-list. Plan 10-07 reads this SUMMARY's `affects` entry and is unblocked."

requirements-completed: [AUTH-05]

# Metrics
duration: ~120min execution + ~10min checkpoint deferral handling + ~15min summary
completed: 2026-05-20
---

# Phase 10 Plan 06: signout-verify-jwt Summary

**Sign-out preserves local data (AUTH-05) shipped with a stop-bot-first source-ordering contract; resendVerification 429 → rate_limited mapping closes one half of deferred-items #5; the JWT-to-utilityProcess wiring (jwtBridge + supervisor.updateJwt + initialJwt init field + {type:'jwt'} message) is the channel Phase 13 will drop into without re-architecture; VerifyEmailBanner ships persistent + non-dismissable + live-computed (no stale closure per T-10-06-06); SignOutConfirmModal ships interface + component for plan 10-07 to mount — with the 8-step live UAT against real Supabase + real inbox + real bot summon deferred to phase-10 verification.**

## Performance

- **Duration:** ~145 min (Task 1 RED+GREEN ~75min; Task 2 GREEN ~45min; continuation pass ~25min)
- **Started:** 2026-05-20T08:55Z (Task 1 RED commit `41b3294`)
- **Completed:** 2026-05-20T11:20Z (this SUMMARY commit)
- **Tasks:** 2/3 fully executed; task 3 (live UAT checkpoint) deferred per user direction
- **Files created:** 5 (jwtBridge.ts, jwtBridge.test.ts, SignOutConfirmModal.tsx, .module.css, 10-06-HUMAN-UAT.md)
- **Files modified:** 6 (authHandlers.ts, botSupervisor.ts, ipc.ts, index.ts, App.tsx, deferred-items.md)
- **Tests added:** 3 vitest cases in `jwtBridge.test.ts` (project total: 30 passing)

## Sign-out ordering contract

D-09 + T-10-06-09 mandate that `supervisor.stop()` runs BEFORE `getClient().auth.signOut()` so the bot's final outbound request flushes under the still-valid JWT — a misordered sign-out would race the bot's last action against a just-revoked token, producing a spurious 401 surface to the user.

The contract is enforced at the **source level** (not runtime), because runtime ordering is implicit from `await` and a misordered source would silently break the invariant.

**Awk source-order proof** — passes against `f62d906:src/main/auth/authHandlers.ts`:

```bash
awk '/supervisorRef.*stop/{a=NR} /auth\.signOut/{b=NR} END{exit !(a<b)}' src/main/auth/authHandlers.ts
# exit 0 (a=338, b=347 — stop happens first)
```

Output of the same on the shipped file:

```
stop-line:338 signOut-line:347 stop_before_signOut:1
```

The shape of `signOut()`:

```typescript
export async function signOut(): Promise<void> {
  // D-09 + T-10-06-09: stop the bot first so its final request flushes under
  // the still-valid JWT.
  if (supervisorRef && supervisorRef.getActiveId() !== null) {
    try { await supervisorRef.stop(); }
    catch (err) { logger.warn(`signOut: bot stop failed: ${(err as Error).message}`); }
  }
  try { await getClient().auth.signOut(); }
  catch (err) {
    // T-10-06-02: never strand the renderer mid-signout. Force local state.
    logger.warn(`signOut: supabase.auth.signOut failed: ${(err as Error).message}`);
    transitionToLocal();
  }
}
```

Two error gates flank the call:
- Bot-stop error → log + continue (the bot may already be detached; the session-clear still needs to run).
- auth.signOut error → log + `transitionToLocal()` (T-10-06-02: never strand the renderer mid-signout; force local mode so the next launch can recover cleanly).

The `supervisorRef.getActiveId() !== null` guard means: if no bot is currently summoned, the stop branch is skipped entirely. This is the common case (user signs out from the Account panel without ever summoning).

## resendVerification 429 → rate_limited mapping

`resendVerification` in `authHandlers.ts` calls `supabase.auth.resend({type:'signup', email: state.user.email})` wrapped in the shared 15s `withTimeout` helper from plan 10-04. The error envelope is then run through a **three-signal pattern match**:

```typescript
if (status === 429 || m.includes('rate limit') || m.includes('over_email_send_rate_limit')) {
  return {
    ok: false,
    code: 'rate_limited',
    message: 'Hold on — wait a minute before requesting another link.',
  };
}
return { ok: false, code: 'network', message: "Couldn't resend verification." };
```

The three signals catch all known Supabase rate-limit shapes:
- `status === 429` — HTTP status when the SDK surfaces it as an Error with `.status`.
- `m.includes('rate limit')` — generic message body (older SDKs).
- `m.includes('over_email_send_rate_limit')` — Supabase's specific `error_code` value when bumping the per-email throttle (default 60s between resends).

This **partially addresses** deferred-items.md #5 (which flagged that signup attempts hitting 429 also mis-map to `code:'network'`). Plan 10-06 fixes the **resend path only**; the signUp path (`classifySignUpError` in plan 10-04's authHandlers.ts) still needs the same multi-signal match — that fix-by-symmetry is owed to a phase-10 gap-closure pass. The two paths hit the same Supabase rate-limiter but route through different result-shape classifiers (SignUpResult vs ResendVerificationResult), so the fix cannot be lifted into a shared helper without first unifying the result-shape contracts.

User-facing copy `Hold on — wait a minute before requesting another link.` is verbatim from UI-SPEC §Empty/Error/Loading.

## JWT push event matrix (Phase 13 consumer)

`jwtBridge.ts` subscribes once to `supabase.auth.onAuthStateChange` and routes each event through a closed switch:

| Supabase event | Action | Reason |
|----------------|--------|--------|
| `SIGNED_IN` | `supervisor.updateJwt(session.access_token)` | First push after a successful sign-in; bot may already be summoned (re-sign-in mid-session). |
| `TOKEN_REFRESHED` | `supervisor.updateJwt(session.access_token)` | Pitfall A4 — Supabase rotates the JWT ~5 min before expiry (default lifetime 1h). Without this push, a long-running bot would carry a stale JWT until the next sign-in. |
| `INITIAL_SESSION` | `supervisor.updateJwt(session?.access_token ?? null)` | Fires once on subscription if a session was already in storage when the bridge initialised. Belt-and-braces alongside the explicit `getSession()` push earlier in `initJwtBridge`. |
| `USER_UPDATED` | `supervisor.updateJwt(session?.access_token ?? null)` | Some Supabase mutations (e.g., email verification flip) emit `USER_UPDATED` with a fresh access_token alongside the new `email_confirmed_at`. Pushing here lets the bot see the new claims without waiting for the next TOKEN_REFRESHED. |
| `SIGNED_OUT` | `supervisor.updateJwt(null)` | Bot loop sees null and should treat the connection as un-authenticated (Phase 13 consumer responsibility). |
| `PASSWORD_RECOVERY` | no-op | Phase 10 ships no recovery flow; the event would fire only on a magic-link landing that we don't route. Documented as an explicit `case` to keep the switch exhaustive. |

The supervisor's `updateJwt(jwt)` implementation:
1. Updates the module-local `latestJwt`.
2. If a session is currently active (`active && active.port1`), `port1.postMessage({type: 'jwt', jwt})` (wrapped in try/catch for port-closed-during-teardown).
3. If no session is active, just stores `latestJwt` — the next `_summon` flow will pick it up via the `initialJwt: latestJwt` field on the init payload.

The **dual-channel** pattern (init-payload at session start + push-on-rotate during session) is intentional. There is no race where a new session boots with a stale JWT and then waits 50min for the next refresh: the init payload guarantees the boot value is fresh; the rotation push guarantees the live value stays fresh.

**Phase 13 reuses this without re-architecture.** The utility-process bot loop in Phase 13 will:

```typescript
// Phase 13 — utilityProcess message handler
port.on('message', (msg) => {
  if (msg.type === 'init') currentJwt = msg.initialJwt;
  if (msg.type === 'jwt')  currentJwt = msg.jwt;
  // ... existing message handlers ...
});
// Outbound proxy request:
fetch(proxyUrl, { headers: { Authorization: `Bearer ${currentJwt}` } });
```

Nothing on the main side needs to change.

## T-10-06-01 mitigation: refresh_token never crosses to utilityProcess

`jwtBridge.ts` only ever pushes `session.access_token` — never the full `session` object. The Supabase `Session` shape includes `refresh_token`, `expires_at`, `expires_in`, plus the access token; pushing the whole shape would leak the refresh credential into the utilityProcess where it could be exfiltrated by a compromised bot binary.

**Acceptance grep gate** — passes against the shipped file:

```bash
grep -c refresh_token src/main/auth/jwtBridge.ts
# 0
```

The file's header comment cites T-10-06-01 explicitly so a future contributor sees the rationale before adding a push of any session field beyond `access_token`. The refresh credential stays in `sessionStore.bin` (plan 10-02), behind `safeStorage`, in the main process's filesystem only.

## VerifyEmailBanner conditional (T-10-06-06 live computation)

`src/renderer/src/App.tsx` renders the Banner above the keychain Banner inside the existing top-of-window stack:

```tsx
{authState.kind === 'signed_in' && !authState.user.emailVerified ? (
  <Banner
    kind="warn"
    message="Verify your email to publish characters or buy credits. Check your inbox for a link from Sei."
  />
) : null}
```

**T-10-06-06 mitigation:** the conditional is **computed live** in JSX, not memoised, not captured by a useEffect dep array, not lifted into a derived store selector. Reasons:

- The predicate is cheap (two reads from `authState`).
- The dependent is small (a single Banner mount with two constant props).
- Memoisation introduces a stale-closure surface: if the dep array forgets to include `authState.user.emailVerified`, the Banner would persist after a USER_UPDATED-driven flip and the user could never get rid of the warning.
- React's reconciler sees the predicate change on the next push from main (USER_UPDATED → useAuthStore.setState → re-render) and unmounts the Banner naturally.

**Non-dismissable:** `onDismiss` prop is deliberately omitted, so `Banner.tsx` does not render the × button. UI-SPEC §Persistent Banner says verify-email is not a transient notice — it is a gate on paid affordances (publish, buy credits) and must not be dismissable. The user's only path to clearing it is to verify the email (or sign out).

**Stacking order:** UI-SPEC §Layout rule 7 — VerifyEmailBanner FIRST (top of stack), keychain Banner SECOND (below). The shipped App.tsx renders them in that order.

## SignOutConfirmModal — interface ships, mount deferred to 10-07

`src/renderer/src/components/SignOutConfirmModal.tsx` exports:

```typescript
export interface SignOutConfirmModalProps {
  botRunning: boolean;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}
export function SignOutConfirmModal(props: SignOutConfirmModalProps): React.ReactElement;
```

Behaviour:

| Aspect | Value | Source |
|--------|-------|--------|
| Title (botRunning=false) | `Sign out?` | UI-SPEC §Sign-out flow |
| Title (botRunning=true)  | `Sign out will stop your bot. Continue?` | UI-SPEC §Sign-out flow |
| Body (both branches) | `Your local characters, memory, and saved API key stay on this machine.` | UI-SPEC + AUTH-05 framing |
| Dismissal button | `Stay signed in` (ghost) | UI-SPEC dismissal-label policy |
| Confirm button | `Sign out` (`kind="primary"`, NOT 'accent', NOT red) | D-09 — sign-out is reversible + preserves local data |
| Submitting label | `Signing out…` | UI-SPEC §Empty/Error/Loading |
| ESC | closes modal (unless submitting) | DeleteConfirmModal convention |
| Click-outside | closes modal (unless submitting) | DeleteConfirmModal convention |
| Re-entry guard | `if (submitting) return` in handleConfirm | Prevents double-RPC if user mashes the button |

**The modal is NOT mounted by `App.tsx` in this plan.** Plan 10-07 wires the Settings Account-panel mount + onConfirm → sei.signOut(). The reason for deferring the mount: the natural sign-out entry-point per D-09 is the Settings panel, and that panel doesn't yet exist. Mounting here would either require a temporary trigger button in App.tsx (which would then need removing) or a synthetic entry that confuses the plan-10 surface. Plan 10-07 reads the props interface above and consumes the component as-shipped.

## Deviation: SignInModal verificationSentTo RETAINED (supersedes deferred-items #3)

Deferred-items.md #3 suggested that plan 10-06 should "remove or repurpose the verification-pending block inside `SignInModal.tsx`" now that the persistent VerifyEmailBanner exists. **Plan 10-06 intentionally did NOT remove it.** This is a deliberate deviation from the deferred-items suggestion, documented here so future passes do not "clean it up" on autopilot.

**The two states are complementary, not duplicative:**

| State | Condition | Surface |
|-------|-----------|---------|
| No-session-after-signup | `authState.kind === 'local'` AND signUp returned `{user, session:null}` (Supabase requires verification → no session issued) | SignInModal's `verificationSentTo` block: `We sent a verification link to {email}. Open it on this device to finish signing in.` |
| Resumed-unverified-session | `authState.kind === 'signed_in' && !user.emailVerified` (user signed in with an old account whose verification was never completed) | App.tsx's persistent VerifyEmailBanner: `Verify your email to publish characters or buy credits.` |

The persistent Banner **cannot** cover the no-session-after-signup case because its conditional gates on `authState.kind === 'signed_in'`, and `authState` stays `local` until verification completes. Removing the `verificationSentTo` interim block would silently drop the post-signup UX for the most common new-user case (sign up → modal closes → no message → user is confused).

Plan 10-07 / Phase 11 may choose to unify the two surfaces into a single component, but that's an architectural refactor outside plan 10-06's scope.

## Decisions Made

All decisions follow CONTEXT D-04 / D-09, UI-SPEC §Sign-out flow + §Persistent Banner + Copywriting Contract, RESEARCH §Pitfall A4 (TOKEN_REFRESHED push) + §Pitfall A6 (USER_UPDATED detection). Net-new decisions:

- **supervisor.stop() BEFORE auth.signOut().** D-09 + T-10-06-09. Source-order awk proof is the gate.
- **Module-level `supervisorRef` + `setSupervisor()` DI hook (NOT constructor-injected deps).** Minimal-diff over re-architecting per-handler exports; null-check guards against test-context import without wiring.
- **JWT push set is 4 events + 1 null + 1 no-op.** SIGNED_IN, TOKEN_REFRESHED, INITIAL_SESSION, USER_UPDATED all push token; SIGNED_OUT pushes null; PASSWORD_RECOVERY no-ops. Including INITIAL_SESSION and USER_UPDATED in the push set is intentional — covers session-pre-exists-bridge and email-verification-flip-issues-new-JWT respectively.
- **Multi-signal rate-limit pattern match.** `status === 429 || m.includes('rate limit') || m.includes('over_email_send_rate_limit')` — resilient to Supabase SDK error-envelope churn across versions.
- **VerifyEmailBanner conditional computed live in JSX (NOT memoised).** T-10-06-06. Cheap predicate, small dependent, no stale-closure surface.
- **VerifyEmailBanner NOT dismissable.** UI-SPEC §Persistent Banner. Onus is on verification (or sign-out), not dismissal.
- **SignOutConfirmModal confirm button `kind="primary"` (NOT 'accent', NOT red/destructive).** D-09 — sign-out is reversible + preserves local data + does not warrant destructive treatment.
- **SignOutConfirmModal NOT mounted by App.tsx; deferred to plan 10-07.** Natural entry-point is Settings; mounting here would require a temporary trigger.
- **SignInModal `verificationSentTo` RETAINED.** Supersedes deferred-items #3; the two states (no-session-post-signup vs resumed-unverified-session) are complementary surfaces, not duplicative.
- **Dual-channel JWT delivery (init payload + push on rotate).** No race where a fresh utilityProcess boots with a stale JWT.
- **jwtBridge init wrapped in try/catch + logger.warn (non-fatal).** Bot can summon without JWT in Phase 10; Phase 13 is the consumer that actually USES the JWT.

## Deviations from Plan

The plan executed substantively as written. Two intentional deviations from related artefacts are documented above:

1. **[Rule 2 — Auto-add missing critical functionality] SignInModal `verificationSentTo` retained** — deferred-items.md #3 suggested removing it; plan 10-06 intentionally kept it because the persistent Banner cannot cover the no-session-after-signup window. See §Deviation: SignInModal verificationSentTo RETAINED above. Tracked in deferred-items.md entry #8 (SUPERSEDES item #3) to prevent autopilot cleanup.
   - **Files affected:** none (no code change — just a non-removal).
   - **Commit:** captured in deferred-items.md #8 update, this continuation pass.
2. **[Rule 1 — Bug correction] resendVerification rate-limit branch added.** Partially addresses deferred-items.md #5 for the resend path. The signUp path (`classifySignUpError`) still owes the same multi-signal match — deferred to phase-10 gap-closure.
   - **Files affected:** `src/main/auth/authHandlers.ts` (resendVerification body).
   - **Commit:** `f62d906`.

### Authentication Gates

Task 3 (`type="checkpoint:human-verify"`) is an auth-gate-style pause — the executor cannot self-approve a live UAT that requires:
- A real Supabase account in a known verification state
- Inbox access for the verification link
- A real bot summon end-to-end (utilityProcess + Mineflayer + Minecraft server reachable)
- A way to observe `<userData>` directory state pre/post sign-out

The user explicitly opted to **defer** the 8-step UAT to phase-10 verification rather than block this plan's wave (wave 4) on multi-step UI traversal plus the missing natural sign-out entry-point (plan 10-07 wires it from Settings). The deferral is documented:

- The verbatim 8-step UAT script is preserved in `10-06-HUMAN-UAT.md` with `status: partial` and `result: [pending]` on every step.
- `deferred-items.md` entry #8 lists the preconditions (real Supabase account, inbox, dev build, character ready to summon) and the resume signal (all 8 steps → `result: [pass]` → reply `approved`).
- Both artifacts surface as outstanding work to `/gsd-verify-work 10` and `/gsd-progress`.

This pattern is consistent with how plan 10-05's checkpoint was handled — checkpoints are auth-gates, not failures; the deferral is recorded as normal flow.

## Threat Flags

No new threat surface introduced beyond the plan's `<threat_model>`. Per-threat verification:

- **T-10-06-01 (Information Disclosure — full session crosses to utilityProcess):** mitigated. `grep -c refresh_token src/main/auth/jwtBridge.ts` returns **0**. Only `session.access_token` is forwarded. Header comment cites T-10-06-01.
- **T-10-06-02 (Tampering — sign-out fails silently):** mitigated. `signOut()` catches `auth.signOut()` errors AND calls `transitionToLocal()` so the renderer drops to local mode regardless of network status. Log line surfaces the underlying cause.
- **T-10-06-06 (Tampering — stale closure shows VerifyEmailBanner after flip):** mitigated. Conditional computed live in JSX from `useAuthStore.state` on every render. No memoised derived state.
- **T-10-06-08 (Information Disclosure — logger writes JWT):** mitigated. `logger.warn` calls in this plan log only `(err as Error).message` strings — never the JWT, never session blobs. Manual code-review gate; future hardening: `logger.scrub()` helper.
- **T-10-06-09 (Tampering — sign-out runs auth.signOut BEFORE supervisor.stop):** mitigated. Awk source-order proof passes: `stop` at line 338, `auth.signOut` at line 347. Stop-first invariant verified.

## Known Stubs

None introduced by this plan. The plan 10-03 stubs for `signOut` and `resendVerification` are **resolved** by this plan's implementations.

The {type:'jwt'} message that `botSupervisor.updateJwt` posts is **received but ignored** by the utilityProcess bot loop in Phase 10 — this is **not a stub**, it is the documented Phase 10 / Phase 13 split (Phase 10 wires the channel; Phase 13 consumes it). The `affects` list in this SUMMARY's frontmatter explicitly calls out Phase 13 as the consumer.

## TDD Gate Compliance

- **Task 1 (`tdd="true"`):** RED gate satisfied — `41b3294` is a pure `test(10-06): add failing jwtBridge tests for JWT push to supervisor` commit (test file only, vitest run fails because jwtBridge.ts does not yet exist). GREEN gate satisfied — `f62d906` is a `feat(10-06): signOut + resendVerification + jwtBridge to utilityProcess` commit that turns the 3 tests green. REFACTOR not needed.
- **Task 2 (`tdd="false"`):** Single GREEN commit `fe1ace4` for SignOutConfirmModal + VerifyEmailBanner integration. No test commit is required per the task spec — task 2 is UI wiring exercised by the live UAT and by `tsc`.
- **Plan type is `execute`** — plan-level gate enforcement does not apply, but the per-task TDD compliance above demonstrates the gate sequence was followed where marked.

## Next Phase Readiness

- **Plan 10-07 (Account panel) can rely on:** `SignOutConfirmModal` component + props contract being stable; `sei.signOut()` IPC channel being live; `useAuthStore.state.user` shape being available for rendering the signed-in user's email and provider in the Account row; `useDataStore.summon.kind !== 'idle'` being the source for the `botRunning` prop.
- **Phase 11 (verify-first paywall) can rely on:** VerifyEmailBanner being the layer-zero surface; the verify-first modal that blocks paid affordances can layer on top using the same `authState.user.emailVerified` predicate without duplicating the Banner.
- **Phase 13 (cloud AI proxy) can rely on:** every utilityProcess session receiving its current JWT via the init payload (`msg.initialJwt`) at boot AND every TOKEN_REFRESHED rotation arriving via `{type:'jwt', jwt}` message on the active port. Drop-in consumer needs no main-side changes.
- **Phase-10 verification / gap-closure owes:**
  - The 8-step live UAT in `10-06-HUMAN-UAT.md`.
  - The signUp-path 429 mapping (deferred-items #5; resend path fixed here, signUp still owes the multi-signal match in `classifySignUpError`).
  - The unused `setPkceHandler` seam in `loopbackCallback.ts` (deferred-items #6; still unused at HEAD).

## Self-Check: PASSED

- `src/main/auth/authHandlers.ts` (signOut + resendVerification implemented) → FOUND
- `src/main/auth/jwtBridge.ts` → FOUND
- `src/main/auth/jwtBridge.test.ts` → FOUND
- `src/main/botSupervisor.ts` (updateJwt + initialJwt) → FOUND
- `src/main/index.ts` (initJwtBridge call) → FOUND
- `src/main/ipc.ts` (setSupervisor call) → FOUND
- `src/renderer/src/components/SignOutConfirmModal.tsx` → FOUND
- `src/renderer/src/components/SignOutConfirmModal.module.css` → FOUND
- `src/renderer/src/App.tsx` (VerifyEmailBanner) → FOUND
- `.planning/phases/10-auth-foundation/10-06-HUMAN-UAT.md` → FOUND
- `.planning/phases/10-auth-foundation/deferred-items.md` (entry #8 added) → FOUND
- Commit `41b3294` (Task 1 RED) → FOUND
- Commit `f62d906` (Task 1 GREEN) → FOUND
- Commit `fe1ace4` (Task 2 GREEN) → FOUND
- Commit `57b903d` (HUMAN-UAT.md) → FOUND (this continuation pass)
- Commit `d2303d6` (deferred-items.md #8) → FOUND (this continuation pass)
- Threat gates: `grep -c refresh_token src/main/auth/jwtBridge.ts` = 0 → PASS; awk source-order proof `stop` (338) < `auth.signOut` (347) → PASS

---
*Phase: 10-auth-foundation*
*Plan: 06 (signout-verify-jwt)*
*Completed: 2026-05-20*
