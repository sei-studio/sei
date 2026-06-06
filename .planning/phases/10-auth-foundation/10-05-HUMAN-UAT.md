---
phase: 10-auth-foundation
plan: 05
source: 10-05-google-oauth-PLAN.md (Task 3 — checkpoint:human-verify)
status: partial
created: 2026-05-20
deferred_from: 10-05 execution (checkpoint deferred at user direction; live Google sign-in not yet exercised)
preconditions:
  - "Google Cloud Console: OAuth client (type Desktop App) created; client_id + client_secret in hand"
  - "Google Cloud Console: `http://127.0.0.1` registered as Authorized redirect URI on that client"
  - "Supabase dashboard → Authentication → Providers → Google: Enabled = true, client_id + client_secret pasted"
  - "At least one Google account added as a Test User to the OAuth consent screen (project is in Testing mode by default)"
  - "Local Sei dev build runnable (`npm run dev`); `<userData>/Sei Launcher Dev/session.bin` deleted to force AuthChoice on first launch"
resume_owner: "Phase 10 gap-closure pass OR `/gsd-verify-work 10`"
references:
  - "deferred-items.md item #7 (live UAT deferred entry, contains the same preconditions)"
  - "10-05-SUMMARY.md §Authentication Gates (records why this was deferred)"
  - "10-05-google-oauth-PLAN.md <how-to-verify> (the canonical 9-step script — duplicated below verbatim)"
---

# Phase 10 Plan 05 — Human UAT (deferred)

**Status:** partial — automated coverage (27 vitest cases incl. 5 in `loopbackPkce.test.ts`; 4 threat-model grep gates; all 6 OAuth `reason` variants wired to UI-SPEC copy strings) is comprehensive enough that plan 10-05 was closed at the checkpoint without exercising live Google sign-in. The 9 manual steps below remain owed to phase verification.

The original checkpoint copy is preserved verbatim from `10-05-google-oauth-PLAN.md` (Task 3 `<how-to-verify>`) so the verifier and `/gsd-progress` surface this as a single canonical list. Mark each step as it is exercised. Do NOT trim, re-order, or merge steps — the contract is that all 9 pass before AUTH-02 is considered live-verified.

## Why this was deferred

At the human-verify checkpoint the user opted to defer the live-UAT pass to phase 10 gap-closure rather than block plan 10-05's wave on a multi-step Google Cloud + Supabase dashboard provisioning. The rationale was:

- All threat-model grep gates passed (T-10-05-04, T-10-05-05, T-10-05-09 mitigations verified — no `BrowserWindow`, no `0.0.0.0`, `OAuthInterstitialModal` mounted in `SignInModal`).
- All 5 `loopbackPkce.test.ts` cases pass (happy path + 4 failure modes, against stubbed Supabase + stubbed `shell.openExternal`).
- All 6 UI-SPEC OAuth `reason` strings (`browser_closed`, `network`, `timeout`, `google_rejected`, `port_collision`, `exchange_failed`) are wired to their verbatim error-copy variants in the interstitial.
- `npx tsc --noEmit` is clean at HEAD.

The live UAT below remains the source-of-truth contract for AUTH-02 — automated coverage demonstrates the surfaces are correct, but does NOT demonstrate that the real Google Cloud OAuth client + Supabase provider config + this code agree end-to-end.

## Preconditions (must complete before running)

1. **Google Cloud project + OAuth client (Desktop App)** — create at https://console.cloud.google.com/apis/credentials → Create credentials → OAuth client ID → Type: **Desktop app** (NOT "Web application"). Name it `Sei Desktop` or similar.
2. **Authorized redirect URI** — on the same OAuth client, add `http://127.0.0.1` (bare, no port — per RFC 8252 §7.3 Google then accepts ANY port).
3. **OAuth consent screen** — User Type **External**; Publishing status **Testing** is fine for dev. Add your real Google account email as a **Test user** so consent doesn't get auto-blocked.
4. **Supabase Google provider** — https://app.supabase.com/project/<your-project>/auth/providers → Google → **Enabled: true** → paste **Client ID** and **Client Secret** from step 1.
5. **Local dev** — `npm run dev` runnable; delete `<userData>/Sei Launcher Dev/session.bin` to force the AuthChoice route on launch.

## UAT script (9 steps, all required) — `result: [pending]` for each

### Step 1. Cold start → SignInModal opens

- **Action:** Delete `<userData>/Sei Launcher Dev/session.bin`. Run `npm run dev`. From AuthChoice → click the Sign In tile → SignInModal opens.
- **Expected:** SignInModal visible with email + password fields and the "Continue with Google" button.
- **result:** [pending]

### Step 2. Continue with Google → interstitial + system browser

- **Action:** Type your email into the Email field (do NOT submit). Click "Continue with Google".
- **Expected:**
  - SignInModal stays mounted but the interstitial scrim appears with title `Continue in your browser`, body about the browser tab, and a `This will close on its own in 60s.` caption that decrements.
  - The system browser opens to Google's sign-in page. **Verify the browser is your default system browser, NOT a BrowserWindow inside Electron** (Pitfall 4 contract — `BrowserWindow.getAllWindows().length` must remain 1).
- **result:** [pending]

### Step 3. Sign in with a real test Google account → routes to MainApp

- **Action:** Sign in with a real Google account that's been added as a test user to your Google Cloud project. Google redirects to `http://127.0.0.1:<port>/callback?code=…`.
- **Expected:**
  - The browser tab shows the `You can close this tab.` page and attempts to `window.close()` itself.
  - Sei's interstitial flips to `Signed in. One moment…` for ~200ms, then closes.
  - The app routes to MainApp (or the 2-step signed-in OnboardingScreen for first-time accounts).
- **result:** [pending]

### Step 4. Session persistence across quit/relaunch

- **Action:** Confirm session.bin exists: `ls -la "<userData>/Sei Launcher Dev/session.bin"`. Quit Sei. Relaunch.
- **Expected:** App goes straight to home — session restored from safeStorage. No AuthChoice.
- **result:** [pending]

### Step 5. Cancel mid-flow → SignInModal preserves typed email

- **Action:** Delete session.bin. Relaunch. Sign In tile → SignInModal → type `cancel-test@example.com` into the Email field → click "Continue with Google" → interstitial opens. Click `Cancel sign-in`.
- **Expected:**
  - Interstitial closes.
  - SignInModal is still visible AND the email field still contains `cancel-test@example.com` (AUTH-02 cancellation contract — D-05 says cancel returns to SignInModal NOT AuthChoice, and the typed email is preserved because SignInModal remained mounted under the interstitial).
- **result:** [pending]

### Step 6. Timeout (60s) → error variant + Try again

- **Action:** Click "Continue with Google" → wait 60 full seconds without doing anything in the browser tab.
- **Expected:**
  - Interstitial flips to heading `That took a little too long` + the timeout body + `Try again` (ghost) + `Cancel sign-in` (quiet) buttons.
  - Click `Try again` → new browser tab opens (new loopback port, new Google auth URL).
  - Click `Cancel sign-in` → return to SignInModal.
- **result:** [pending]

### Step 7. google_rejected variant — Google blocks the test account

- **Action:** In your Google Cloud Console, remove your account from the OAuth consent screen Test Users list → in Sei, click "Continue with Google" → sign in with that account.
- **Expected:** Google blocks the consent step; the loopback callback receives `?error=access_denied`; the interstitial flips to `Google declined the sign-in` variant with the verbatim UI-SPEC body and the two CTAs.
- **result:** [pending]

### Step 8. No BrowserWindow ever opens during the flow

- **Action:** Open Sei's DevTools (View → Toggle Developer Tools or Cmd+Opt+I). In the main-process Console (NOT the renderer), run:
  ```js
  require('electron').BrowserWindow.getAllWindows().length
  ```
- **Expected:**
  - Returns `1` (just the main app window).
  - Also confirm `grep -c BrowserWindow src/main/auth/loopbackPkce.ts` returns 0 (Pitfall 4 invariant — automated grep gate already enforces this at acceptance time, but step 8 is the runtime confirmation).
- **result:** [pending]

### Step 9. onAuthState push fires with the Google account

- **Action:** After a successful Google sign-in (step 3), open the renderer DevTools console and run:
  ```js
  window.sei.onAuthState((s) => console.log('auth-state:', s))
  ```
  Then trigger a transient auth event (e.g., sign out and back in, or wait for a token refresh).
- **Expected:** Logs `auth-state: {kind:'signed_in', user:{email:'<your-google-email>', emailVerified:true, …}}`. Confirms the renderer-side AuthState mirror is being pushed the Google-issued session.
- **result:** [pending]

## Resume signal

Once all 9 steps show `result: [pass]`, reply `approved` in the verification thread. If any step fails:

- **Step 3 fails to redirect** → check Supabase Auth → Providers → Google has the right client_id/secret. Supabase's own callback (`https://<project>.supabase.co/auth/v1/callback`) is auto-configured, but the Google Cloud OAuth client must register `http://127.0.0.1` as a redirect URI for the loopback step.
- **Step 8 returns > 1 window** → a BrowserWindow leaked. Grep `src/main/auth/loopbackPkce.ts` and `src/main/auth/authHandlers.ts` for any `BrowserWindow` reference and file a Rule 1 fix.
- **Step 5 loses the typed email** → SignInModal was unmounted during OAuth. Check the `oauthInFlight` sibling-render pattern (`SignInModal.tsx` line ~242) — both modals must remain mounted concurrently.
- **Step 9 fires nothing** → check `authState.ts` `onAuthStateChange` subscription wired in `bootstrap()` AFTER session restore (plan 10-03 contract).

Any failure becomes a follow-up auto-fix per executor deviation rules; do NOT close this UAT until all 9 are green.

---

*Tracked: AUTH-02 (Google OAuth via PKCE loopback)*
*Owner: phase-10 gap-closure / `/gsd-verify-work 10`*
*Last updated: 2026-05-20*
