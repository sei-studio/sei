---
phase: 10-auth-foundation
plan: 06
source: 10-06-signout-verify-jwt-PLAN.md (Task 3 — checkpoint:human-verify)
status: partial
created: 2026-05-20
deferred_from: 10-06 execution (checkpoint deferred at user direction; live sign-out / JWT push / verify-email Banner flow not yet exercised end-to-end)
preconditions:
  - "A working Sei dev build (`npm run dev`) with phase 10 plans 01–06 merged."
  - "A real Supabase email/password account in a verified-OR-unverified state (the UAT exercises both)."
  - "An inbox you can read for the verification link (steps 1–2)."
  - "DevTools accessible from the running app (View → Toggle Developer Tools or Cmd+Opt+I)."
  - "`<userData>/Sei Launcher Dev/session.bin` deletable to force a fresh sign-up if needed."
resume_owner: "Phase 10 gap-closure pass OR `/gsd-verify-work 10`"
references:
  - "deferred-items.md item #8 (live UAT deferred entry, contains the same preconditions)"
  - "10-06-SUMMARY.md §Authentication Gates (records why this was deferred)"
  - "10-06-signout-verify-jwt-PLAN.md <how-to-verify> (the canonical 8-step script — duplicated below verbatim)"
---

# Phase 10 Plan 06 — Human UAT (deferred)

**Status:** partial — automated coverage (30 vitest cases across all phase-10 specs incl. 3 new `jwtBridge.test.ts` cases; 31 grep gates across both tasks; T-10-06-01 / T-10-06-09 threat-model grep+awk proofs passing) was comprehensive enough that plan 10-06 was closed at the checkpoint without exercising live sign-out + JWT push + verify-email Banner. The 8 manual steps below remain owed to phase verification.

The original checkpoint copy is preserved verbatim from `10-06-signout-verify-jwt-PLAN.md` (Task 3 `<how-to-verify>`) so the verifier and `/gsd-progress` surface this as a single canonical list. Mark each step as it is exercised. Do NOT trim, re-order, or merge steps — the contract is that all 8 pass before AUTH-05 + Pitfall A4 wiring are considered live-verified.

## Why this was deferred

At the human-verify checkpoint the user opted to defer the live UAT to phase-10 gap-closure rather than block plan 10-06's wave (wave 4) on multi-step UI traversal that depends on plan 10-07's Settings Account-panel for the natural sign-out entry-point. The rationale was:

- All threat-model grep gates passed (T-10-06-01 `grep -c refresh_token src/main/auth/jwtBridge.ts` = 0; T-10-06-09 `awk` source-order check on `supervisorRef.stop` vs `auth.signOut` confirms stop-first ordering).
- All 3 `jwtBridge.test.ts` cases pass (initial push, TOKEN_REFRESHED, SIGNED_OUT-null), and `npx vitest run` is green across all 30 phase-10 specs.
- VerifyEmailBanner conditional reads `authState.user.emailVerified` directly (no stale-closure risk per T-10-06-06).
- SignOutConfirmModal renders both title branches verbatim with `kind="primary"` (NOT accent, NOT red) and the dismissal label `Stay signed in` (UI-SPEC §Sign-out flow).
- `npx tsc --noEmit` is clean at HEAD.
- `SignOutConfirmModal` is NOT mounted by App.tsx in plan 10-06 — plan 10-07 wires the mount from Settings, so step 7 below cannot be exercised "naturally" until plan 10-07 ships. The DevTools-direct path (`window.sei.signOut()`) is the agreed substitute.

The live UAT below remains the source-of-truth contract for AUTH-05 (sign-out preserves local data) and for the Pitfall A4 wiring (JWT-to-utilityProcess on every TOKEN_REFRESHED) — automated coverage demonstrates the surfaces are correct, but does NOT demonstrate that the real Supabase auth-event stream + the real bot supervisor + the real MessagePortMain forward agree end-to-end.

## Preconditions (must complete before running)

1. **Dev build runnable** — `npm run dev` opens the Sei window; main + renderer + utilityProcess can spawn.
2. **A test Supabase account** in a known state. If you need a fresh unverified account, delete `<userData>/Sei Launcher Dev/session.bin` and sign up with a new email through SignInModal.
3. **Inbox access** for the verification link (step 2).
4. **DevTools open** — most steps require a console paste against `window.sei.*`.
5. **A character that can summon** — at least one fully configured character in `<userData>/Sei Launcher Dev/characters/` so step 3 can spawn the bot.

## UAT script (8 steps, all required) — `result: [pending]` for each

### Step 1. VerifyEmailBanner appears on fresh unverified sign-up

- **Action:** With a freshly-created Supabase account that has NOT yet clicked the verification link, reach the MainApp shell (post-onboarding / Home). Observe the top of the window.
- **Expected:** A warn-style Banner reads verbatim `Verify your email to publish characters or buy credits. Check your inbox for a link from Sei.` There is NO × dismiss button. Clicking the Banner copy does nothing.
- **result:** [pending]

### Step 2. VerifyEmailBanner disappears after email verification

- **Action:** Click the Supabase verification link in your inbox. Switch focus back to the Sei window. Wait ~10 seconds (Pitfall A6: `USER_UPDATED` fires on the next API call). If the Banner does not auto-disappear within 10s, force a refresh via DevTools by calling `window.sei.signInPassword({email:'<your>', password:'<your>'})` — this re-runs the session and pushes a fresh `authState` with `emailVerified:true`.
- **Expected:** Banner unmounts on the next render. The rest of the layout shifts up to fill the gap (Banner stack invariant per UI-SPEC §Layout rule 7).
- **result:** [pending]

### Step 3. JWT in initial supervisor init payload

- **Action:** Summon a bot from the Home screen (click a character tile → Summon). Observe the main-process stdout logs (terminal that ran `npm run dev`).
- **Expected:** The supervisor session-init payload (the `{type:'init', …}` message posted to the utilityProcess port2) includes an `initialJwt: '<token>'` field. If logs do not surface this by default, temporarily add `console.log(initPayload)` in `botSupervisor.ts` around the `port2.postMessage({type:'init', …})` call and re-run — remove the log before committing any fixes. The JWT value should be a JWT-shaped string (3 base64url segments split by `.`).
- **result:** [pending]

### Step 4. JWT push on TOKEN_REFRESHED

- **Action:** With the bot still running, wait for a Supabase TOKEN_REFRESHED event (default ~50 minutes before JWT expiry) OR force one in DevTools: `window.sei.signInPassword({email:'<your>', password:'<your>'})`. Watch the main-process logs for a `supervisor.updateJwt(...)` invocation OR add a temporary debug log in `botSupervisor.updateJwt` to print the new JWT before forwarding.
- **Expected:** `supervisor.updateJwt('<new-jwt>')` fires; the active session's `port1.postMessage({type: 'jwt', jwt: '<new-jwt>'})` is sent. The utilityProcess bot loop ignores this message in Phase 10 (Phase 13 is the consumer) — that is expected; we are only verifying the WIRING.
- **result:** [pending]

### Step 5. Sign-out preserves local data + drops to local mode

- **Action:** While the bot is RUNNING, open DevTools and execute `await window.sei.signOut()`. (Plan 10-07 wires the natural Settings entry-point; for plan 10-06 the DevTools-direct call is the agreed substitute.)
- **Expected:**
  - The bot disconnects cleanly (supervisor.stop() runs BEFORE auth.signOut() — see T-10-06-09 awk proof).
  - `session.bin` is removed from `<userData>/Sei Launcher Dev/`.
  - `authState` pushes `{kind:'local'}` to the renderer; the AuthChoiceScreen (or whatever local-mode landing) renders WITHOUT a screen transition (the current screen stays mounted; per D-09).
- **result:** [pending]

### Step 6. AUTH-05 invariant: local files untouched

- **Action:** After step 5, list the contents of these directories and compare against a pre-step-5 snapshot:
  - `<userData>/Sei Launcher Dev/characters/` — file count and contents UNCHANGED.
  - `<userData>/Sei Launcher Dev/memory/` — file count and contents UNCHANGED.
  - `<userData>/Sei Launcher Dev/api_key.bin` — present and UNCHANGED (mtime, size).
  - `<userData>/Sei Launcher Dev/session.bin` — GONE.
- **Expected:** Only `session.bin` is gone. Everything else byte-identical to pre-step-5.
- **result:** [pending]

### Step 7. SignOutConfirmModal copy + button shape

- **Action:** Plan 10-06 does NOT mount `SignOutConfirmModal` in App.tsx (plan 10-07 wires it). For this checkpoint, EITHER temporarily mount it inline in App.tsx (revert before commit) OR open the React DevTools and render the component in isolation. Inspect both title branches:
  - `<SignOutConfirmModal botRunning={false} … />` → title reads exactly `Sign out?`.
  - `<SignOutConfirmModal botRunning={true} … />` → title reads exactly `Sign out will stop your bot. Continue?`.
  - In both branches, the body reads exactly `Your local characters, memory, and saved API key stay on this machine.`
  - The dismissal button is the ghost-styled `Stay signed in`.
  - The confirm button reads `Sign out`, has `kind="primary"` (NOT 'accent', NOT red/destructive — D-09 says sign-out is reversible).
- **Expected:** All four copy strings match verbatim; the confirm button looks identical to the primary buttons in Settings (same shape, same colour). No red treatment.
- **result:** [pending]

### Step 8. resendVerification rate-limit mapping

- **Action:** With a signed-in unverified account, in DevTools execute `await window.sei.resendVerification()`. Then IMMEDIATELY (within Supabase's ~60s rate-limit window) execute it a second time.
- **Expected:**
  - First call returns `{ok:true}`.
  - Second call returns `{ok:false, code:'rate_limited', message:'Hold on — wait a minute before requesting another link.'}`. The `code` MUST be `rate_limited` (not `network`) — that's the whole point of the 429 mapping landed in plan 10-06.
- **result:** [pending]

## Resume signal

Once all 8 steps show `result: [pass]`, reply `approved` in the verification thread. If any step fails:

- **Step 1 Banner not visible** → check `src/renderer/src/App.tsx` for the conditional `authState.kind === 'signed_in' && !authState.user.emailVerified`; check that `useAuthStore.state.user.emailVerified` is `false` for the test account. The Supabase admin dashboard can confirm `email_confirmed_at IS NULL`.
- **Step 2 Banner doesn't disappear after verification** → likely Pitfall A6 timing. Force `supabase.auth.refreshSession()` via DevTools (`await (await window.sei._debugRefresh?.())`) or sign out + sign in. If signing back in does not flip emailVerified, the dashboard's verification confirmation has not propagated yet (free-tier delay).
- **Step 3 `initialJwt` absent from init payload** → check `src/main/botSupervisor.ts` around the `port2.postMessage({type:'init', …})` call; the `initialJwt: latestJwt` field must be included. Also confirm `jwtBridge` ran during bootstrap and pushed a non-null JWT BEFORE the summon (the order is critical — main/index.ts calls `initJwtBridge(supervisor)` AFTER `createBotSupervisor`).
- **Step 4 updateJwt not called on TOKEN_REFRESHED** → check `src/main/auth/jwtBridge.ts` switch covers `'TOKEN_REFRESHED'`; check that the supabase storage adapter is wired (plan 10-02 sessionStore) so the refresh actually fires.
- **Step 5 sign-out leaves bot running** → check `src/main/auth/authHandlers.ts` `signOut()` calls `supervisorRef.stop()` BEFORE `getClient().auth.signOut()` (T-10-06-09 awk proof). Also confirm `setSupervisor(deps.supervisor)` was called by `src/main/ipc.ts` before the first IPC dispatch.
- **Step 6 local files modified** → CRITICAL AUTH-05 BUG. File an immediate Rule-1 fix and block phase-10 close. Whatever code path deleted/modified those files must be reverted; `signOut()` only owns `session.bin`.
- **Step 7 SignOutConfirmModal mis-coloured** → check `src/renderer/src/components/SignOutConfirmModal.tsx` confirm button is `kind="primary"`, NOT 'accent' or 'destructive'. Check `Button.tsx` `primary` styling has not been overridden with red.
- **Step 8 second resend returns `code:'network'` instead of `'rate_limited'`** → Rule-1 fix on `resendVerification()` rate-limit branch in `authHandlers.ts`. Should match `status === 429` OR `m.includes('rate limit')` OR `m.includes('over_email_send_rate_limit')`.

Any failure becomes a follow-up auto-fix per executor deviation rules; do NOT close this UAT until all 8 are green.

---

*Tracked: AUTH-05 (sign-out preserves local data) + Pitfall A4 (JWT push to utilityProcess on TOKEN_REFRESHED)*
*Owner: phase-10 gap-closure / `/gsd-verify-work 10`*
*Last updated: 2026-05-20*
