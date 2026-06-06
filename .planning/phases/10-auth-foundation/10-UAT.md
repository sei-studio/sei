---
status: testing
phase: 10-auth-foundation
source:
  - 10-05-HUMAN-UAT.md
  - 10-06-HUMAN-UAT.md
  - 10-07-HUMAN-UAT.md
  - 10-08-HUMAN-UAT.md
  - 10-09-HUMAN-UAT.md
seeded_gaps:
  - 10-VERIFICATION.md (WR-09 deletion_queue partial-unique-index)
started: 2026-05-20T00:00:00Z
updated: 2026-05-20T00:00:00Z
---

## Current Test

number: 2
name: Plan 10-06 — Sign-out + JWT push + VerifyEmailBanner (8 steps)
expected: |
  Complete every step in `10-06-HUMAN-UAT.md` (Steps 1–8). All 8 must pass before AUTH-05 + Pitfall A4 are live-verified:
   1. VerifyEmailBanner appears on fresh unverified sign-up (warn-style, no × dismiss)
   2. VerifyEmailBanner disappears after email verification (layout shifts up)
   3. JWT in initial supervisor init payload (initialJwt field present, JWT-shaped)
   4. JWT push on TOKEN_REFRESHED (supervisor.updateJwt fires; port1 jwt message sent)
   5. Sign-out preserves local data + drops to local mode (bot stops first, session.bin removed, no screen transition)
   6. AUTH-05 invariant: characters/, memory/, api_key.bin all byte-identical post sign-out
   7. SignOutConfirmModal copy + button shape (both title branches verbatim, Stay signed in ghost, Sign out primary not red)
   8. resendVerification rate-limit mapping (second call within 60s returns {code:'rate_limited'} not 'network')
  Reply `yes` only after all 8 steps are green.
awaiting: user response

## Tests

### 1. Plan 10-05 — Google OAuth live end-to-end (9 steps)
expected: All 9 steps in 10-05-HUMAN-UAT.md pass (SignInModal cold start, interstitial+system browser, real Google sign-in routes to MainApp, session persists, cancel preserves email, 60s timeout, google_rejected variant, no BrowserWindow leak, onAuthState push).
result: pass
note: User confirmed all 9 steps pass after fixing precondition (had to use Web Application OAuth client, not Desktop App — see Gaps).
ref: 10-05-HUMAN-UAT.md

### 2. Plan 10-06 — Sign-out + JWT push + VerifyEmailBanner (8 steps)
expected: All 8 steps in 10-06-HUMAN-UAT.md pass (Banner appears unverified, disappears after verification, initialJwt in supervisor init, updateJwt on TOKEN_REFRESHED, sign-out drops to local without touching characters/memory/api_key.bin, SignOutConfirmModal copy + primary styling, resendVerification 429 → rate_limited).
result: [pending]
ref: 10-06-HUMAN-UAT.md

### 3. Plan 10-07 — ACCOUNT panel + SignOutConfirmModal mount + LinuxKeyringBanner (11 steps)
expected: All 11 steps in 10-07-HUMAN-UAT.md pass (ACCOUNT panel renders, email row + resend, Sign Out opens modal with correct title branch, Stay signed in / Sign out behavior, AUTH-05 invariant after sign-out, Export and Delete buttons mount children, LinuxKeyringBanner stack ordering + persisted dismissal, no React warnings).
result: [pending]
ref: 10-07-HUMAN-UAT.md

### 4. Plan 10-08 — GDPR account deletion end-to-end (14 steps)
expected: All 14 steps in 10-08-HUMAN-UAT.md pass (throwaway account, DeleteAccountModal opens, UI-SPEC body, type-email enables Delete, Keep my account cancels, ESC closes, scrim does NOT close, submit runs destructive flow, success body + sign-out routing, account gone from Supabase, deletion_queue row with empty storage_paths, local files untouched, cannot sign back in, pg_cron daily worker registered).
result: [pending]
ref: 10-08-HUMAN-UAT.md

### 5. Plan 10-09 — Export My Data live save dialog (8 steps)
expected: All 8 steps in 10-09-HUMAN-UAT.md pass (sign in, Export opens native dialog with default filename sei-export-YYYY-MM-DD.json, saves to Desktop with success status, file matches D-14 schema {schemaVersion:1, exportedAt, account:{email,createdAt}, characters:[], sharing:[]}, cancel returns {ok:false,code:'cancelled'}, read-only path → write_failed, defensive sign-out invariant).
result: [pending]
ref: 10-09-HUMAN-UAT.md

## Summary

total: 5
passed: 1
issues: 0
pending: 4
skipped: 0

## Gaps

- truth: "10-05-HUMAN-UAT.md precondition #1 says OAuth client type = Desktop App with http://127.0.0.1 as Authorized redirect URI"
  status: failed
  reason: "Sei's actual flow (src/main/auth/loopbackPkce.ts:81-83) calls supabase.auth.signInWithOAuth, which routes Google's redirect_uri through Supabase's callback (https://<SUPABASE_PROJECT_REF>.supabase.co/auth/v1/callback). Google therefore needs a Web Application OAuth client with the Supabase callback URI registered — Desktop App produces redirect_uri_mismatch. User hit this live during Test 1; fix was to create a Web Application client and re-paste credentials into Supabase."
  severity: minor
  test: 1
  source: "Hit during /gsd-verify-work 10 Test 1"
  artifacts:
    - ".planning/phases/10-auth-foundation/10-05-HUMAN-UAT.md (preconditions §1 + §2)"
    - "deferred-items.md item #7 (if it duplicates the same wrong preconditions)"
  missing: []

- truth: "deletion_queue partial-unique-index + on-conflict collapse (WR-09)"
  status: failed
  reason: "Pre-existing gap from 10-VERIFICATION.md: migration 20260520000000_deletion_queue.sql lacks the partial unique index on (user_id) WHERE purged_at IS NULL, and supabase/functions/delete-me/index.ts does not pass onConflict on the insert. Flaky network double-tap can produce duplicate pending queue rows."
  severity: major
  test: pre-existing
  source: 10-VERIFICATION.md
  artifacts:
    - "supabase/migrations/20260520000000_deletion_queue.sql"
    - "supabase/functions/delete-me/index.ts"
  missing: []
