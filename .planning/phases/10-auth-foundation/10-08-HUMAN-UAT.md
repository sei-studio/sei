---
phase: 10-auth-foundation
plan: 08
source: 10-08-delete-account-PLAN.md (Task 4 — checkpoint:human-verify)
status: partial
created: 2026-05-20
deferred_from: 10-08 execution (checkpoint deferred at user direction; end-to-end account deletion not yet exercised against live Supabase)
preconditions:
  - "Sei dev build runnable (`npm run dev`) with phase 10 plans 01–08 merged AND .env populated with SUPABASE_URL + SUPABASE_ANON_KEY."
  - "Supabase backend already deployed via MCP (deletion_queue migration applied, delete-me Edge Function ACTIVE at https://<SUPABASE_PROJECT_REF>.supabase.co/functions/v1/delete-me). Verified at deferral time."
  - "A throwaway Supabase test account you're willing to permanently delete."
  - "Supabase dashboard SQL Editor access for the queue-row + cron.job verification queries."
resume_owner: "Phase 10 gap-closure pass OR `/gsd-verify-work 10`"
references:
  - "deferred-items.md item #10"
  - "10-08-SUMMARY.md"
  - "10-08-delete-account-PLAN.md <how-to-verify> (canonical 14-step script)"
---

# Phase 10 Plan 08 — Human UAT (deferred)

**Status:** partial — automated work was comprehensive (34/34 phase-10 tests pass including 4 new in `edgeFunctionClient.test.ts`; `npx tsc --noEmit` clean; T-10-08-01 mitigation grep `service_role` = 0 in src/; all task-1/2/3 acceptance grep gates pass). Backend infrastructure is LIVE (migration applied via MCP, delete-me v1 ACTIVE). The 14-step live UAT against a throwaway test account remains owed to phase verification.

The original checkpoint copy is preserved verbatim from `10-08-delete-account-PLAN.md` (Task 4 `<how-to-verify>`) so the verifier and `/gsd-progress` surface this as a single canonical list. Mark each step as it is exercised.

## Why this was deferred

At the human-verify checkpoint the user opted to defer the live UAT to phase-10 gap-closure. Rationale:

- Backend deployed via Supabase MCP, not Supabase CLI — user does not need to install supabase/tap or run `supabase login` / `db push` / `functions deploy` to test. The infrastructure is already live.
- Established phase-10 precedent (plans 10-05, 10-06, 10-07 all deferred their live UATs to phase verification).
- The destructive nature of the flow (it permanently deletes accounts) means the UAT needs deliberate timing, not "in the middle of executing the next phase".

## Preconditions (must complete before running)

1. **Dev build runnable** — `npm run dev` opens the Sei window.
2. **A throwaway Supabase test account** in the project `<SUPABASE_PROJECT_REF>`. Best practice: sign up via Sei's Sign In → Create Account flow with a throwaway email; complete onboarding to a known-good state.
3. **Supabase dashboard access** for steps 10, 11, 14 (SQL Editor + Authentication → Users).
4. **DevTools NOT required** — the entire UAT runs against the rendered UI.

## UAT script (14 steps, all required)

### Step 1. Create a throwaway test account
- **Action:** Delete `<userData>/Sei Launcher Dev/session.bin` if a session exists. `npm run dev`. AuthChoice → Sign In tile → click "New here?" toggle → enter a throwaway email + 8+ char password → Create Account. Complete the 2-step OnboardingScreen.
- **Expected:** Reach the Home screen as a signed-in unverified user. `<userData>/Sei Launcher Dev/session.bin` exists.
- **result:** [pending]

### Step 2. Open DeleteAccountModal from Settings
- **Action:** Settings → ACCOUNT panel → scroll to Danger Zone → click red `Delete account…` button.
- **Expected:** DeleteAccountModal mounts (was a stub in 10-07; now the real type-email-to-confirm UI).
- **result:** [pending]

### Step 3. Initial modal state + UI-SPEC body copy
- **Action:** Inspect the modal.
- **Expected:** Title reads exactly `Delete your Sei account?`. Three body paragraphs match UI-SPEC verbatim. `Delete account` button is DISABLED. `Keep my account` button is enabled (ghost-styled).
- **result:** [pending]

### Step 4. Type-email-to-enable, case-insensitive
- **Action:** Type a wrong email (`wrong@foo.com`) — confirm button stays disabled. Clear → type the correct test account's email — button enables. Try a MixedCase variant (e.g. `Test@Foo.COM` vs `test@foo.com`) — button stays enabled.
- **Expected:** Button only enables when input matches the account email case-insensitively.
- **result:** [pending]

### Step 5. `Keep my account` cancels with no side effects
- **Action:** With email typed and button enabled, click `Keep my account`.
- **Expected:** Modal closes. No IPC fires. Account still signed in (`authState.kind === 'signed_in'`). Re-open modal — input is cleared.
- **result:** [pending]

### Step 6. ESC closes the modal
- **Action:** Re-open the modal. Press ESC.
- **Expected:** Modal closes (same as clicking `Keep my account`).
- **result:** [pending]

### Step 7. Click-outside scrim DOES NOT close (destructive guard)
- **Action:** Re-open the modal. Click on the scrim background outside the modal body.
- **Expected:** Modal stays open (UI-SPEC §Layout rule 5: destructive actions require explicit dismissal — no accidental dismiss via background click).
- **result:** [pending]

### Step 8. Submit kicks off the destructive flow
- **Action:** Type the correct email → click `Delete account`.
- **Expected:** Label flips to `Deleting…`. Button disables. ESC is suppressed during this window. (Visually verify by pressing ESC — modal stays open until the network call returns.)
- **result:** [pending]

### Step 9. Success body + signed-out routing
- **Action:** Wait for the call to complete (a few hundred ms over a fast connection; up to a couple seconds otherwise).
- **Expected:** Modal body swaps to `Account scheduled for deletion. Signing you out…`. After ~1.2s, modal closes. App drops to AuthChoiceScreen (signed out — `authState.kind` flips to `local`).
- **result:** [pending]

### Step 10. Account gone from Supabase dashboard
- **Action:** Supabase dashboard → Authentication → Users. Search for the throwaway email.
- **Expected:** No row returned.
- **result:** [pending]

### Step 11. deletion_queue row exists with empty storage_paths
- **Action:** Supabase dashboard → SQL Editor. Run:
  ```sql
  SELECT user_id, deletion_requested_at, storage_paths, purged_at
  FROM public.deletion_queue
  ORDER BY deletion_requested_at DESC LIMIT 5;
  ```
- **Expected:** A row for the just-deleted user_id with `storage_paths = []` and `purged_at IS NULL`. (Phase 10 has nothing to purge in storage; rows older than 30 days will be marked `purged_at = now()` by the daily cron job.)
- **result:** [pending]

### Step 12. AUTH-06 local invariant
- **Action:** Inspect `<userData>/Sei Launcher Dev/`:
  - `characters/` — file count and contents UNCHANGED.
  - `memory/` — file count and contents UNCHANGED.
  - `api_key.bin` — present, UNCHANGED.
  - `session.bin` — GONE.
- **Expected:** Only `session.bin` removed. AUTH-06 says deleting the cloud account never destroys local data.
- **result:** [pending]

### Step 13. Cannot sign back in with deleted email
- **Action:** AuthChoice → Sign In tile → enter the deleted email + its password → submit.
- **Expected:** Red helper text `Email or password doesn't match. Try again.` Supabase no longer has the account.
- **result:** [pending]

### Step 14. pg_cron daily worker is registered
- **Action:** Supabase dashboard → SQL Editor:
  ```sql
  SELECT jobname FROM cron.job WHERE jobname = 'purge-deletion-queue';
  ```
- **Expected:** Returns exactly one row with `jobname = 'purge-deletion-queue'`.
- **result:** [pending]

## Resume signal

Once all 14 steps show `result: [pass]`, reply `approved`. Any failure becomes a Rule-1 / Rule-2 auto-fix per executor deviation rules.

---

*Tracked: AUTH-06 (delete account preserves local data) + D-13 (service_role key never crosses to client) + Pitfall A7 (30-day Storage purge via deletion_queue)*
*Owner: phase-10 gap-closure / `/gsd-verify-work 10`*
*Last updated: 2026-05-20*
