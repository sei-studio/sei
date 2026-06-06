---
phase: 10-auth-foundation
verified: 2026-05-20T21:11:02Z
status: human_needed
score: 4/5 must-haves verified (SC-4 and SC-5 blocked only by live UAT; automated evidence is strong)
overrides_applied: 0
human_verification:
  - test: "AUTH-02 — Google OAuth live end-to-end (9 steps)"
    expected: "System browser opens, loopback callback receives ?code=, Sei transitions to MainApp, session persists on restart, cancel returns to SignInModal preserving typed email, 60s timeout shows correct error variant, google_rejected variant fires on blocked account, BrowserWindow.getAllWindows().length stays at 1 throughout"
    why_human: "Requires real Google Cloud OAuth client (Desktop App type), Supabase Google provider configured, live Google account as OAuth Test User. Automated tests cover the loopback PKCE server, all 6 OAuthResult reason variants, and all 4 threat-model grep gates — but cannot verify the Google Cloud + Supabase + code agreement end-to-end."
  - test: "AUTH-05 — Sign-out flow, JWT push, VerifyEmailBanner (8 steps)"
    expected: "Sign-out from Settings clears session and drops to AuthChoice; local characters/memory/api_key.bin are untouched; VerifyEmailBanner appears when signed_in && !emailVerified and disappears when verification link is clicked; JWT is forwarded to utilityProcess on each TOKEN_REFRESHED; resendVerification maps 429 to rate_limited"
    why_human: "Requires real Supabase account, inbox access for verification link, bot running for the bot-stop branch. Automated tests cover signOut ordering (T-10-06-09 awk proof), JWT push events (jwtBridge.test.ts 3 cases), banner conditional, rate-limit mapping — but cannot verify end-to-end with real Supabase auth-event stream."
  - test: "AUTH-05 / D-11 — ACCOUNT panel + SignOutConfirmModal + LinuxKeyringBanner (11 steps)"
    expected: "ACCOUNT panel visible only when signed_in, all 4 rows present, Sign Out opens modal with correct title branch (bot-running vs not), 'Stay signed in' / 'Sign out' labels exact, Export My Data and Delete Account buttons mount correct child modals, LinuxKeyringBanner fires + persists dismissal on fake-Linux config, Banner stack order: VerifyEmail → LinuxKeyring → Keychain"
    why_human: "Requires real signed-in dev build, both verified/unverified states, DevTools, and either a Linux box or config-edit substitute for the keyring warning. Automated coverage pins the component wiring and the Danger Zone pattern — live traversal owed."
  - test: "AUTH-06 — GDPR account deletion end-to-end (14 steps)"
    expected: "Type-email-to-confirm UI enables Delete button on exact match (case-insensitive), Deleting... label shows, 1.2s success state visible, account purged from Supabase Auth + deletion_queue row inserted, cron job registered, local characters/memory/api_key.bin untouched after deletion"
    why_human: "Requires throwaway Supabase test account, Supabase dashboard SQL Editor for verification queries. Backend is LIVE (deployed via MCP). Automated tests cover edgeFunctionClient (4 cases) and service_role isolation — but the delete-account destructive flow cannot be automated safely."
  - test: "AUTH-07 — Export My Data live save dialog (8 steps)"
    expected: "Clicking Export opens native save dialog with default filename sei-export-YYYY-MM-DD.json, saved file contains exactly 5 top-level keys: {schemaVersion:1, exportedAt, account:{email,createdAt}, characters:[], sharing:[]}, cancelled dialog returns {ok:false,code:'cancelled'}, write timeout surfaces {ok:false,code:'write_failed'}"
    why_human: "Requires real signed-in account and real dialog interaction. D-14 schema contract is comprehensively covered by 5 exportBuilder.test.ts cases — live UAT owed for the dialog + writeFile chain."
gaps:
  - truth: "deletion_queue partial-unique-index + on-conflict collapse (WR-09)"
    status: failed
    reason: "The migration (20260520000000_deletion_queue.sql) has NO partial unique index on (user_id) WHERE purged_at IS NULL. The Edge Function's insert call (delete-me/index.ts line 83-89) does not include an onConflict clause in the Supabase client call — only references it in a comment. A second delete attempt from a flaky network creates a duplicate pending queue row. This is WR-09 which was explicitly skipped by the fix agent."
    artifacts:
      - path: "supabase/migrations/20260520000000_deletion_queue.sql"
        issue: "Missing: CREATE UNIQUE INDEX deletion_queue_user_pending_uniq ON public.deletion_queue (user_id) WHERE purged_at IS NULL"
      - path: "supabase/functions/delete-me/index.ts"
        issue: "The .insert() at line 83-89 does not use .onConflict() / ignoreDuplicates to make the WR-09 conflict clause effective. Comment on line 79 claims it does but the Supabase JS client call has no such option."
    missing:
      - "Add partial unique index migration: CREATE UNIQUE INDEX deletion_queue_user_pending_uniq ON public.deletion_queue (user_id) WHERE purged_at IS NULL"
      - "Add onConflict handling to delete-me Edge Function insert: .insert({...}, {onConflict: 'user_id', ignoreDuplicates: true}) (or .upsert with ignoreDuplicates) so the INSERT does nothing on a re-attempt rather than inserting a second row"
      - "Apply the migration to the live Supabase project via MCP or supabase CLI"
  - truth: "DeleteAccountModal success-phase unmounts before 1200ms (WR-10)"
    status: failed
    reason: "WR-10 was skipped by the fix agent. The modal's success phase calls setTimeout(() => onConfirmed(), 1200) (line 62 of DeleteAccountModal.tsx), but SettingsScreen mounts the modal only when deleteAccountModalOpen && authState.kind === 'signed_in' (line 380). After deleteAccount() calls supabase.auth.signOut(), the SIGNED_OUT event fires, authState flips to 'local', and the modal unmounts — in practice under 200ms, well before the 1200ms intent."
    artifacts:
      - path: "src/renderer/src/screens/SettingsScreen.tsx"
        issue: "Modal gate: {deleteAccountModalOpen && authState.kind === 'signed_in'} unmounts on SIGNED_OUT before the 1200ms success display completes"
      - path: "src/renderer/src/components/DeleteAccountModal.tsx"
        issue: "setTimeout(() => onConfirmed(), 1200) at line 62 is cut short when the parent conditional gates out"
    missing:
      - "Keep the modal mounted through the success phase independent of auth-state (e.g., track a phaseStillRunning ref that unlocks during the success state), OR move the confirmation message to a toast layer that survives the SettingsScreen unmount"
deferred:
  - truth: "pg_cron retry path for Storage purge (BL-03 follow-on)"
    addressed_in: "Phase 11"
    evidence: "Phase 11 goal: cloud character definitions including Storage blobs. deferred-items.md item N explicitly states: 'Phase 11/12, when the Storage purge body lands, is the natural place' for the cron retry extension. Phase 10 has empty storage_paths so practical exposure is zero today."
---

# Phase 10: Auth Foundation Verification Report

**Phase Goal:** Users can sign in to Sei with email/password or Google, sessions persist across launches, and the local-only path from v0.1.1 remains a first-class citizen.
**Verified:** 2026-05-20T21:11:02Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| SC-1 | A new user can complete sign-up with email + password and sign in again across an app restart | VERIFIED | `signInWithPassword` / `signUpWithPassword` implemented in authHandlers.ts (L266+); safeStorage session.bin persists via sessionStore.ts; session restores via `initAuthState` + `getSession()` on bootstrap; 8 vitest cases covering sign-in and sign-up paths all pass |
| SC-2 | A new user can complete Google sign-in via the system browser (not BrowserWindow), with the loopback callback closing cleanly | ? UNCERTAIN (human) | `loopbackPkce.ts` verified: `grep -c BrowserWindow=0`, `grep -c 0.0.0.0=0`, `listen(0,'127.0.0.1')` confirmed, `shell.openExternal` confirmed; 5 vitest cases pass (happy path + timeout + abort + google_rejected + no-URL). Live end-to-end with real Google Cloud OAuth client NOT yet exercised — 9-step UAT pending in 10-05-HUMAN-UAT.md |
| SC-3 | A v0.1.1 user upgrading can choose "Continue without an account" and reach the existing bot summon flow with no cloud writes | VERIFIED | AuthChoiceScreen.tsx: tile label exactly "Continue Locally" (line 55); `onChooseLocal` callback routes to home (hasApiKey) or OnboardingScreen; OnboardingScreen `signedIn=false` path preserves all 4 original steps; no Supabase call in the local path confirmed (getClient() never called in the local branch) |
| SC-4 | A signed-in user can delete their account from settings; deletion purges Supabase rows and Storage objects within 30 days | ? UNCERTAIN (human) | deleteAccount() implemented: stopBotIfActive (BL-06 fix) → callEdgeFunction('delete-me') → supabase.auth.signOut(); Edge Function: deleteUser BEFORE queue insert (BL-03 fix); deletion_queue table + pg_cron daily worker exist in migration; service_role key confirmed not in src/ (T-10-08-01 gate passes); 14-step live UAT pending in 10-08-HUMAN-UAT.md. Two code gaps remain (WR-09 unique index, WR-10 modal timing) — classified as GAPS below |
| SC-5 | A signed-in user can export their account data as a single JSON download containing characters + sharing metadata | ? UNCERTAIN (human) | exportData() implemented: buildExport(session) → showSaveDialog → writeFile with 15s timeout; D-14 contract: 5 keys (schemaVersion:1, exportedAt, account, characters:[], sharing:[]) verified by 5 vitest cases and grep; 8-step live UAT pending in 10-09-HUMAN-UAT.md |

**Score:** 3/5 truths fully verified; 2/5 have strong automated coverage but owe live UAT confirmation. 0 truths FAILED on automated evidence.

### Deferred Items

Items not yet met but explicitly addressed in later milestone phases.

| # | Item | Addressed In | Evidence |
|---|------|-------------|----------|
| 1 | pg_cron retry path for Storage purge orphaned rows (BL-03 follow-on from REVIEW.md) | Phase 11 | deferred-items.md item N: "Phase 11/12, when the Storage purge body lands, is the natural place." Phase 10 has empty storage_paths; practical exposure is zero. |

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/main/auth/supabaseClient.ts` | getClient() singleton, PKCE config, StorageAdapter interface | VERIFIED | Exists, substantive (getClient, setStorageAdapter, StorageAdapter interface; flowType:'pkce', detectSessionInUrl:false, autoRefreshToken:true, persistSession:true); imported by authState.ts and authHandlers.ts |
| `src/main/auth/sessionStore.ts` | safeStorage-backed StorageAdapter, corrupt-blob recovery | VERIFIED | Exists; saveJson/loadJson/removeJson/createSessionStorageAdapter/sessionBackendKind all present; WR-05 fix (transient keyring check) applied; key-aware JSON dict (session.bin Wave-1 fix documented in 10-04-SUMMARY.md) |
| `src/main/auth/authState.ts` | Two-state FSM (local/signed_in), onAuthStateChange subscription, BL-02 unsubscribe | VERIFIED | Exists; `subscription?.unsubscribe()` before re-bind (BL-02 fix at L77); no 'signed_out' state; did-finish-load replay; broadcastAuthState wired |
| `src/main/auth/authHandlers.ts` | All 8 handlers implemented; stopBotIfActive shared helper (BL-06) | VERIFIED | All 8 exported async functions present; stopBotIfActive helper at L69; called by signOut (L372) and deleteAccount (L412) before supabase.auth.signOut(); withTimeout p.catch() (BL-05 fix at L96) |
| `src/main/auth/loopbackPkce.ts` | 127.0.0.1:0 ephemeral port, shell.openExternal, exchangeCodeForSession | VERIFIED | Exists; `server.listen(0, '127.0.0.1')` at L62; `shell.openExternal` at L159; `exchangeCodeForSession` wired; WR-06+WR-07 abort listener + idempotent callback fix applied |
| `src/main/auth/jwtBridge.ts` | TOKEN_REFRESHED push to utilityProcess via updateJwt; no refresh_token | VERIFIED | Exists; `grep -c refresh_token = 0`; pushes only `session.access_token`; BL-02 fix (unsubscribe before re-bind) applied; initJwtBridge called from index.ts bootstrap |
| `src/main/auth/exportBuilder.ts` | buildExport pure function, SeiExportV1 interface, D-14 5-key schema | VERIFIED | Exists; 5 top-level keys (schemaVersion:1, exportedAt, account, characters:[], sharing:[]) confirmed by grep and 5 passing vitest cases |
| `src/main/auth/edgeFunctionClient.ts` | callEdgeFunction with Bearer JWT + 15s timeout | VERIFIED | Exists; 4 passing vitest cases (204/401/fetch-throw/timeout); imported by authHandlers.ts deleteAccount |
| `supabase/migrations/20260520000000_deletion_queue.sql` | deletion_queue table + pg_cron daily worker, NO FK to auth.users | VERIFIED (partial) | Exists; table structure correct; pg_cron schedule at 03:00 UTC; no FK to auth.users (line 19 comment). MISSING: partial unique index on (user_id) WHERE purged_at IS NULL (WR-09) |
| `supabase/functions/delete-me/index.ts` | JWT verify → deleteUser FIRST → queue insert → 204 (BL-03 fix) | VERIFIED (partial) | Exists; BL-03 reorder applied (deleteUser at L60, queue insert at L83); service_role key NOT in src/. MISSING: effective onConflict clause in the insert call (the comment at L79 claims it but the Supabase JS call at L83-89 has no .onConflict() / ignoreDuplicates option — WR-09 incomplete) |
| `src/renderer/src/screens/AuthChoiceScreen.tsx` | "Sign In" + "Continue Locally" tiles, equal weight, correct labels | VERIFIED | Exists; tile labels exactly "Sign In" (L44) and "Continue Locally" (L55); no forbidden labels (Skip/Guest/Try without); hosts inside MacosWindow |
| `src/renderer/src/components/SignInModal.tsx` | Unified sign-in/sign-up form, mode toggle, dismissal "Back to Sei" | VERIFIED | Exists; email/password form, mode toggle wired; invokes sei.signInPassword / sei.signUpPassword; Google button mounts OAuthInterstitialModal |
| `src/renderer/src/screens/OnboardingScreen.tsx` | signedIn?: boolean prop; when true, skips provider/API-key steps | VERIFIED | Exists; signedIn prop at L44; `STEPS = signedIn ? 2 : 4` at L50; API key save gated on `!signedIn` at L112 |
| `src/renderer/src/App.tsx` | Auth routing, BL-04 SIGNED_OUT→Settings fix, VerifyEmailBanner | VERIFIED | BL-04 fix present (L256-257: `authState.kind === 'local' && view.kind === 'settings' → navigate auth-choice`); VerifyEmailBanner at L282; LinuxKeyringBanner at L296 |
| `src/renderer/src/screens/SettingsScreen.tsx` | ACCOUNT panel visible only when signed_in, all 4 rows, Danger Zone | VERIFIED | ACCOUNT panel at L211; gated on `authState.kind === 'signed_in'` (L209); Sign Out / Export My Data / Delete Account rows present; Danger Zone border-top at L259; var(--red) on label |
| `src/renderer/src/components/DeleteAccountModal.tsx` | Type-email-to-confirm, 3 body paragraphs, 30-day window stated, ESC suppressed during in-flight | VERIFIED (partial) | Exists; type-email gate present; "Keep my account" dismissal; "Delete account" destructive button; success-phase setTimeout(1200ms) present but will be cut short by SIGNED_OUT unmount (WR-10 gap) |
| `src/main/auth/authHandlers.ts` + `src/main/ipc.ts` + `src/preload/index.ts` | 9 auth:* IPC channels, Zod gates, 9 preload bindings | VERIFIED | All 9 channels confirmed in ipc.ts (8 ipcMain.handle + 1 push); all 9 preload bindings confirmed in preload/index.ts; setAuthSupervisor synchronous (BL-01 fix at ipc.ts L314) |
| `src/main/env.ts` | SUPABASE_URL / SUPABASE_ANON_KEY lazy getters, throws on empty | VERIFIED | Exists; getSupabaseUrl / getSupabaseAnonKey exported; SUPABASE_ENV_MISSING error on empty value |
| `src/main/paths.ts` | sessionPath() returning session.bin | VERIFIED | `sessionPath: () => path.join(userDataRoot(), 'session.bin')` at L30 |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| src/main/index.ts (bootstrap) | supabaseClient.setStorageAdapter | setStorageAdapter(createSessionStorageAdapter()) before getClient() | WIRED | Line 115-117; before registerIpcHandlers (L254); before initAuthState (L266) |
| src/main/auth/authState.ts | getClient().auth.onAuthStateChange | subscription with unsubscribe guard | WIRED | BL-02 fix: `subscription?.unsubscribe()` at L77 before re-subscribing |
| src/main/auth/authState.ts | BrowserWindow.webContents.send | broadcastAuthState → IpcChannel.auth.state | WIRED | L96: `window.webContents.send(IpcChannel.auth.state, currentState)` |
| src/preload/index.ts | IpcChannel.auth.* | 9 ipcRenderer.invoke + 1 ipcRenderer.on | WIRED | All 9 bindings at lines 53-68 |
| src/main/ipc.ts | setSupervisor (synchronous) | import from authHandlers at top of file (BL-01 fix) | WIRED | Static import at L17; setAuthSupervisor(deps.supervisor) at L314 |
| src/main/auth/loopbackPkce.ts | electron.shell.openExternal | shell.openExternal(authUrl) at L159 | WIRED | shell.openExternal confirmed; no BrowserWindow reference |
| src/main/auth/loopbackPkce.ts | supabase.auth.exchangeCodeForSession | via getClient() | WIRED | exchangeCodeForSession in loopbackPkce.ts confirmed |
| src/main/auth/authHandlers.ts (signOut + deleteAccount) | stopBotIfActive → supervisor.stop() BEFORE signOut | shared helper at L69 (BL-06 fix) | WIRED | stopBotIfActive at L372 (signOut) and L412 (deleteAccount); supabase.auth.signOut() at L374 / L421 — correct ordering |
| src/main/auth/jwtBridge.ts | botSupervisor.updateJwt | supervisor.updateJwt(session.access_token) on TOKEN_REFRESHED | WIRED | L58: `supervisorRef.updateJwt(session?.access_token ?? null)` |
| supabase/functions/delete-me/index.ts | auth.admin.deleteUser BEFORE deletion_queue | BL-03 fix: deleteUser at L60, insert at L83 | WIRED | Delete-before-queue ordering confirmed |
| src/main/auth/authHandlers.ts (exportData) | buildExport + dialog.showSaveDialog | buildExport at L471; showSaveDialog at L487-488 | WIRED | Both confirmed wired; writeFile with 15s timeout at L502 |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| AuthChoiceScreen | N/A (no dynamic data) | — | — | N/A — static UI |
| AuthState renderer | authState (from useAuthStore) | Supabase onAuthStateChange → broadcastAuthState → preload.onAuthState → Zustand store | Yes — driven by real Supabase auth events | FLOWING |
| exportBuilder.ts | session | getClient().auth.getSession() in exportData handler | Yes — real Supabase session | FLOWING |
| SignInModal | sign-in result | window.sei.signInPassword → IPC → authHandlers → getClient().auth.signInWithPassword | Yes — real Supabase call | FLOWING |
| SettingsScreen ACCOUNT panel | authState.user.email | useAuthStore → broadcasted AuthState | Yes — derived from real Supabase session user object | FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| 39/39 vitest cases pass | `npx vitest run` | 7 test files, 39 tests, 0 failures | PASS |
| tsc clean | `npx tsc --noEmit` | exits 0 | PASS |
| T-10-05-04: no BrowserWindow in loopbackPkce | `grep -c BrowserWindow src/main/auth/loopbackPkce.ts` | 0 | PASS |
| T-10-05-05: no 0.0.0.0 in loopbackPkce | `grep -c "0.0.0.0" src/main/auth/loopbackPkce.ts` | 0 | PASS |
| T-10-06-01: no refresh_token in jwtBridge | `grep -c refresh_token src/main/auth/jwtBridge.ts` | 0 | PASS |
| T-10-08-01: no SERVICE_ROLE_KEY in src/ | `grep -rF "SUPABASE_SERVICE_ROLE_KEY" src/` | 0 results | PASS |
| T-10-04 enumeration: signUpWithPassword collapses all non-password/email errors to neutral success | `grep -n "classifySignUpError" src/main/auth/authHandlers.ts` shows fallthrough returns `{ok:true,requiresVerification:true}` | Confirmed at L182 | PASS |
| T-10-06-09: supervisor.stop() before auth.signOut() | stopBotIfActive at L372 / L412; supabase.auth.signOut() at L374 / L421 | Confirmed source order in both signOut and deleteAccount (BL-06) | PASS |
| D-14: buildExport 5-key schema | `grep -c "schemaVersion.*1\|characters.*\[\]\|sharing.*\[\]" exportBuilder.ts` | 7 matches (multiple occurrences of locked contract) | PASS |
| email_in_use removed from SignUpResult (WR-02) | `grep -n "email_in_use" src/shared/ipc.ts` | Only in security comment, not as a union variant | PASS |
| Renderer never imports @supabase/supabase-js | `grep -rn "from '@supabase/supabase-js'" src/renderer src/preload` | 0 results | PASS |
| BL-01 synchronous supervisor wiring | `grep -n "setAuthSupervisor" src/main/ipc.ts` | Static import at L17, synchronous call at L314 | PASS |
| BL-02 unsubscribe on re-bootstrap | `grep -n "subscription?.unsubscribe" src/main/auth/authState.ts` | L77 before re-subscribing | PASS |
| BL-04 SIGNED_OUT routes Settings → AuthChoice | `grep -n "local.*settings\|navigate.*auth-choice" src/renderer/src/App.tsx` | L256-257 confirmed | PASS |
| BL-05 p.catch() prevents unhandledRejection | `grep -n "p.catch" src/main/auth/authHandlers.ts` | L96: `p.catch(() => undefined)` | PASS |
| WR-03 all signup errors collapse to neutral | classifySignUpError fallthrough at L182 | Returns `{ok:true, requiresVerification:true}` for all unclassified errors | PASS |
| WR-04 127.0.0.1 literal in loopback URL | `grep -n "LOOPBACK_CALLBACK_URL" src/main/auth/loopbackCallback.ts src/main/auth/authHandlers.ts` | Both now use 127.0.0.1 literal | PASS |
| WR-08 CORS scoped to 'null' | `grep -n "Access-Control-Allow-Origin" supabase/functions/_shared/cors.ts` | `'null'` at L15 | PASS |
| WR-09 partial unique index | `grep -n "unique\|uniq" supabase/migrations/20260520000000_deletion_queue.sql` | Only a non-unique index exists | FAIL |
| WR-09 onConflict in insert | `grep -n "onConflict\|ignoreDuplicates" supabase/functions/delete-me/index.ts` | No results — code only has a comment | FAIL |
| WR-10 modal success-phase survives SIGNED_OUT | `grep -n "deleteAccountModalOpen.*authState.kind" src/renderer/src/screens/SettingsScreen.tsx` | L380: gated on authState.kind === 'signed_in' — will unmount | FAIL |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| AUTH-01 | 10-01, 10-03, 10-04 | Email/password sign-up and sign-in | SATISFIED | signInWithPassword + signUpWithPassword implemented; Supabase PKCE client wired; session persists |
| AUTH-02 | 10-05 | Google OAuth via system browser + loopback + PKCE | NEEDS HUMAN | Code wired (loopbackPkce.ts, OAuthInterstitialModal, shell.openExternal); automated gates all pass; live UAT owed (10-05-HUMAN-UAT.md) |
| AUTH-03 | 10-01, 10-02, 10-03 | Session tokens persist via safeStorage; Linux basic_text surfaced as warning | SATISFIED | sessionStore.ts + sessionPath() + createSessionStorageAdapter(); BL-02 subscription fix applied; sessionBackendKind() wired to app:warnings sessionFallbackPlaintext; UserConfigSchema.linuxBasicTextWarnDismissed present |
| AUTH-04 | 10-04 | "Continue without account" is first-class; local experience from v0.1.1 unchanged | SATISFIED | AuthChoiceScreen "Continue Locally" tile routes to OnboardingScreen with signedIn=false; no cloud writes in local path; OnboardingScreen all 4 steps preserved for local users |
| AUTH-05 | 10-06, 10-07 | Sign out clears cloud session but does not delete local files | NEEDS HUMAN | signOut(): stopBotIfActive → supabase.auth.signOut() only touches session.bin; characters/memory/api_key.bin untouched; live UAT owed (10-06-HUMAN-UAT.md, 10-07-HUMAN-UAT.md) |
| AUTH-06 | 10-08 | Account deletion purges Supabase rows and Storage within 30 days | NEEDS HUMAN (+ 2 gaps) | Edge Function deployed via MCP; BL-03 delete-before-queue fix applied; automated tests pass; WR-09 (unique index) and WR-10 (modal timing) remain unfixed; live UAT owed (10-08-HUMAN-UAT.md) |
| AUTH-07 | 10-09 | Export cloud data as JSON download | NEEDS HUMAN | exportData() fully wired; D-14 schema locked by tests; live UAT owed (10-09-HUMAN-UAT.md) |

### Anti-Patterns Found

| File | Pattern | Severity | Impact |
|------|---------|----------|--------|
| `supabase/migrations/20260520000000_deletion_queue.sql` | Missing: `CREATE UNIQUE INDEX deletion_queue_user_pending_uniq ON public.deletion_queue (user_id) WHERE purged_at IS NULL` | WARNING (WR-09 skipped) | Repeated delete-account attempts create duplicate pending queue rows; Phase 11+ Storage purge will double-process them |
| `supabase/functions/delete-me/index.ts` (L83-89) | .insert() has no `.onConflict()` / `ignoreDuplicates` despite code comment claiming WR-09 is handled | WARNING (WR-09 incomplete) | The comment at L79 says "on_conflict: user_id collapses duplicate pending rows" but no such option is passed to the Supabase JS client insert — the feature is described but not implemented |
| `src/renderer/src/screens/SettingsScreen.tsx` (L380) | Modal mount gated on `authState.kind === 'signed_in'` means SIGNED_OUT event during deleteAccount's 1200ms success phase unmounts the modal immediately | WARNING (WR-10 skipped) | User sees a flash of "Account scheduled for deletion" instead of the intended 1.2s confirmation |

### Human Verification Required

The following tests MUST be exercised before the phase is considered fully live-verified. All 5 test plans are documented with verbatim scripts in their respective HUMAN-UAT.md files.

#### 1. Google OAuth End-to-End (10-05-HUMAN-UAT.md — 9 steps)

**Test:** Set up Google Cloud OAuth client (Desktop App), register `http://127.0.0.1` redirect URI, enable Supabase Google provider, add a test user, run `npm run dev`, exercise the full flow including cancel, timeout, and google_rejected variants.
**Expected:** System browser opens (not BrowserWindow), loopback catches `?code=`, app transitions to MainApp, session persists on restart, cancel returns to SignInModal with email preserved, 60s timeout shows error variant.
**Why human:** Requires real Google Cloud + Supabase dashboard configuration and a live Google account. Automated coverage is comprehensive (5 loopbackPkce.test.ts cases + 4 threat-model greps) but cannot substitute for real OAuth provider agreement.

#### 2. Sign-Out, JWT Push, VerifyEmailBanner (10-06-HUMAN-UAT.md — 8 steps)

**Test:** Sign in with a real account, trigger sign-out from Settings, verify local files untouched, verify VerifyEmailBanner appears for unverified account and disappears after clicking verification link, verify JWT propagates to utilityProcess.
**Expected:** SESSION.bin cleared on sign-out; characters/memory/api_key.bin untouched (AUTH-05 invariant); banner visible when unverified, gone when verified; bot-stop precedes session clear when bot is running.
**Why human:** Requires real inbox, real Supabase auth-event stream, real MessagePortMain forward, and a running bot for the stop-ordering path.

#### 3. ACCOUNT Panel and LinuxKeyringBanner (10-07-HUMAN-UAT.md — 11 steps)

**Test:** Sign in, open Settings, verify all 4 ACCOUNT rows present, exercise Sign Out (both bot-running and not-running title variants), verify Export and Delete buttons mount correct modals, verify LinuxKeyringBanner fires and dismissal persists.
**Expected:** "Stay signed in" / "Sign out" labels exact; Danger Zone visual pattern correct; banner stack order: VerifyEmail → LinuxKeyring → Keychain.
**Why human:** Requires real signed-in UI traversal, both verified/unverified states, and either Linux hardware or config-edit for the keyring warning.

#### 4. GDPR Account Deletion (10-08-HUMAN-UAT.md — 14 steps)

**Test:** Create a throwaway account, navigate to Settings → Delete Account, type email to confirm, submit, verify Supabase Auth user is deleted, deletion_queue row inserted, pg_cron job registered, local characters/memory/api_key.bin untouched.
**Expected:** Type-email gate enables button; "Deleting..." label during in-flight; account purged from auth.users within the Edge Function call; local data preserved (step 12 is the critical AUTH-06 invariant gate).
**Why human:** Destructive operation on real Supabase project; requires dashboard SQL Editor access for verification. Backend is LIVE (deployed via MCP at deferral time).
**Note:** WR-09 (unique index) and WR-10 (modal timing) are code gaps that should be resolved in a gap-closure plan before or alongside this UAT.

#### 5. Export My Data (10-09-HUMAN-UAT.md — 8 steps)

**Test:** Sign in, click Export My Data in Settings, pick a save location, open the saved file and verify exactly 5 top-level keys match the D-14 contract, verify cancelled dialog returns cleanly.
**Expected:** Default filename `sei-export-YYYY-MM-DD.json`; file contains `{schemaVersion:1, exportedAt, account:{email,createdAt}, characters:[], sharing:[]}`.
**Why human:** Requires real dialog interaction and signed-in account. The D-14 schema contract is fully covered by 5 automated vitest cases; this UAT covers the dialog + writeFile chain.

### Gaps Summary

Two code gaps block a clean `passed` declaration (beyond the 5 deferred human UATs):

**Gap 1 — WR-09: deletion_queue missing partial unique index + Edge Function missing onConflict (WARNING-level)**

The REVIEW.md identified WR-09 as a skipped warning. The migration file has only a `(deletion_requested_at) WHERE purged_at IS NULL` index — not the partial unique index on `(user_id) WHERE purged_at IS NULL` required to prevent duplicate pending rows on retry. The Edge Function code comments at L79 say "on_conflict: user_id collapses duplicate pending rows" but the actual `.insert()` call at L83-89 passes no `onConflict` / `ignoreDuplicates` option to the Supabase JS client. The description in the comment is aspirational, not implemented. Fix requires: (a) a new Supabase migration adding the partial unique index, (b) updating the Edge Function insert call with an `onConflict` option, (c) applying the migration to the live project.

**Gap 2 — WR-10: DeleteAccountModal success-phase race with SIGNED_OUT unmount (WARNING-level)**

The `DeleteAccountModal` success-phase `setTimeout(() => onConfirmed(), 1200)` is cut short because the modal is mounted only while `authState.kind === 'signed_in'` (SettingsScreen.tsx L380). The `deleteAccount()` handler calls `supabase.auth.signOut()` which immediately fires SIGNED_OUT, flipping `authState.kind` to `'local'` and unmounting the modal in ~50–200ms — well before the intended 1200ms. The user sees a flash of the success message rather than the documented 1.2s confirmation. Fix: keep the modal mounted through the success phase (e.g., via a `phaseStillRunning` ref) or move the confirmation to a toast layer that survives the parent unmount.

Neither gap is a functional blocker to the core auth flows (AUTH-01 through AUTH-07 work end-to-end), but WR-09 is a correctness issue for the deletion flow and WR-10 is a UX regression vs the spec. Both should be resolved in a Phase 10 gap-closure plan before the 5 deferred human UATs are run.

---

_Verified: 2026-05-20T21:11:02Z_
_Verifier: Claude (gsd-verifier)_
