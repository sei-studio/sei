---
phase: 10-auth-foundation
plan: 07
source: 10-07-account-panel-PLAN.md (Task 3 — checkpoint:human-verify)
status: partial
created: 2026-05-20
deferred_from: 10-07 execution (checkpoint deferred at user direction; ACCOUNT panel + SignOutConfirmModal mount + LinuxKeyringBanner stack not yet exercised end-to-end)
preconditions:
  - "A working Sei dev build (`npm run dev`) with phase 10 plans 01–07 merged."
  - "A real Supabase email/password account; both verified and unverified states are exercised."
  - "DevTools accessible from the running app (View → Toggle Developer Tools or Cmd+Opt+I)."
  - "`<userData>/Sei Launcher Dev/session.bin` deletable to force a fresh sign-up if needed."
  - "Step 10 needs either a Linux machine without gnome-keyring/kwallet OR a stub of `app:warnings` returning `sessionFallbackPlaintext:true`."
resume_owner: "Phase 10 gap-closure pass OR `/gsd-verify-work 10`"
references:
  - "deferred-items.md item #9 (this UAT deferral + the 3 planner-spec issues — all resolved in-line)"
  - "10-07-SUMMARY.md (records the deferral and the rename rationale)"
  - "10-07-account-panel-PLAN.md <how-to-verify> (canonical 11-step script — duplicated below verbatim)"
---

# Phase 10 Plan 07 — Human UAT (deferred)

**Status:** partial — automated work (Settings ACCOUNT panel wired with all four row actions, SignOutConfirmModal mounted with live `botRunning` derivation, DeleteAccountModal stub honoring the T-10-07-02 mitigation, LinuxKeyringBanner gated on `signed_in && sessionFallbackPlaintext && !dismissed` with persisted dismissal, Banner stack reordered to VerifyEmail → LinuxKeyring → Keychain) is comprehensive enough that plan 10-07 was closed at the checkpoint without exercising the 11-step manual UAT. Those 11 steps remain owed to phase verification.

The original checkpoint copy is preserved verbatim from `10-07-account-panel-PLAN.md` (Task 3 `<how-to-verify>`) so the verifier and `/gsd-progress` surface this as a single canonical list. Mark each step as it is exercised. Do NOT trim, re-order, or merge — D-11 (Settings as the only signed-in account surface) and AUTH-05 (sign-out preserves local data) both depend on all 11 passing.

## Why this was deferred

At the human-verify checkpoint the user opted to defer the live UAT to phase-10 gap-closure rather than block plan 10-07's wave on UI traversal that ultimately echoes plan 10-06's deferred sign-out / verify-email Banner UAT. The rationale was:

- Plan 10-07's added components are pure UI — `SettingsScreen.tsx`'s new ACCOUNT panel, `App.tsx`'s LinuxKeyringBanner conditional, and `DeleteAccountModal.tsx` are mounted but the *behaviours* they invoke (`sei.signOut`, `sei.resendVerification`, `sei.deleteAccount` stub, `sei.exportData` stub) are already covered by plan 10-06's automated tests OR are deliberately stubbed for 10-08/10-09 to fill.
- All three executor self-flagged deviations were *planner-spec* issues, not implementation drift (an over-restrictive `grep == 1` on identifiers that necessarily appear twice; a JSX-layout-incompatible `grep -B2` proximity check; the `ACCOUNT` → `PROFILE` rename forced by acceptance criteria assuming the literal would be unique). All three were resolved in-line in `0d73bff` and `5e8f4b8`; no follow-up code work is owed.
- The deferred UAT inherits plan 10-06's AUTH-05 + Pitfall A4 contracts; running plan 10-06's UAT at phase verification will exercise plan 10-07's natural entry point (Settings → Sign out) automatically.

## Preconditions

1. **Dev build runnable** — `npm run dev` opens the Sei window; main + renderer + utilityProcess all spawn cleanly.
2. **A signed-in account** in known verified-or-unverified state. Use `<userData>/Sei Launcher Dev/session.bin` reset + AuthChoice → Sign In if needed.
3. **DevTools open** — steps 5, 8, 11 inspect renderer state and console output.
4. **A character that can summon** — at least one fully configured character so step 4 (bot-running title branch) is exercisable.
5. **Step 10 needs** either a Linux box without gnome-keyring/kwallet OR a config-edit substitute (`linuxBasicTextWarnDismissed:true` in `<userData>/Sei Launcher Dev/config.json`) for the persistence half of the check.

## UAT script (11 steps, all required) — `result: [pending]` for each

### Step 1. ACCOUNT panel renders at top of Settings

- **Action:** Sign in. Open Settings. Confirm the section ordering at the top of the screen.
- **Expected:** `ACCOUNT` (mono caps, signed-in-only) appears ABOVE `PROFILE` (the renamed API-key section), Skins, Appearance, etc. The `ACCOUNT` header literal appears exactly once in `SettingsScreen.tsx` (renames satisfy acceptance grep).
- **result:** [pending]

### Step 2. Email row + conditional Resend verification

- **Action:** Inspect the ACCOUNT panel's Email row. If the test account is unverified, look for the quiet `Resend verification` button to the right of the email.
- **Expected:** Email shown in mono. If `emailVerified === true`: no Resend button (a small "Verified" label MAY be present per UI-SPEC). If `emailVerified === false`: quiet button visible; clicking it triggers `sei.resendVerification()` and shows a 4s auto-dismiss status line (e.g. `Sent — check your inbox.`).
- **result:** [pending]

### Step 3. Sign Out row → SignOutConfirmModal opens

- **Action:** Click the ghost `Sign out` button in the ACCOUNT panel's Sign Out row.
- **Expected:** SignOutConfirmModal renders centered over a scrim. Body reads exactly `Your local characters, memory, and saved API key stay on this machine.` Dismissal button is ghost-styled `Stay signed in`. Confirm button is `kind="primary"` (NOT accent, NOT red/destructive) labelled `Sign out`.
- **result:** [pending]

### Step 4. Modal title branches: bot idle vs running

- **Action:** With NO bot summoned, repeat Step 3 — note the modal title. Dismiss. Summon a character (Home → Summon). Return to Settings → Sign Out — note the modal title.
- **Expected:** Bot idle title reads exactly `Sign out?`. Bot running (status connecting OR online) title reads exactly `Sign out will stop your bot. Continue?`. The branch is computed live from `useDataStore.summon.status`.
- **result:** [pending]

### Step 5. `Stay signed in` cancels with no state change

- **Action:** With the modal open (either branch), click `Stay signed in`. In DevTools after closure: `useAuthStore.getState().authState.kind` → confirm value.
- **Expected:** Modal closes; no IPC fires; `authState.kind === 'signed_in'` (unchanged); the bot (if running) stays connected.
- **result:** [pending]

### Step 6. `Sign out` confirms with optimistic label flip

- **Action:** Re-open SignOutConfirmModal. Click `Sign out`.
- **Expected:** Confirm button label flips to `Signing out…` and disables; modal closes within a few hundred ms; renderer drops to local mode WITHOUT a screen transition (the current screen — Settings — stays mounted but the ACCOUNT panel disappears since it gates on `signed_in`); `authState.kind === 'local'`.
- **result:** [pending]

### Step 7. AUTH-05 invariant after sign-out

- **Action:** After step 6, snapshot `<userData>/Sei Launcher Dev/`:
  - `characters/` — file count and contents UNCHANGED.
  - `memory/` — file count and contents UNCHANGED.
  - `api_key.bin` — present, UNCHANGED (mtime + size).
  - `session.bin` — GONE.
- **Expected:** Only `session.bin` removed; everything else byte-identical to a pre-step-6 snapshot.
- **result:** [pending]

### Step 8. Export My Data row surfaces stub error

- **Action:** Re-sign in. Settings → ACCOUNT panel → click `Export as JSON`.
- **Expected:** Plan 10-09 implements the real flow; plan 10-07 expects the current `sei.exportData()` stub to return `{ok:false, code:'write_failed'}`. The UI surfaces red helper text below the row reading `Couldn't prepare your export. Try again in a moment.` (After plan 10-09 ships, this step is re-run successfully — the JSON file is written and a success status line appears instead. Re-mark `result:` as a regression check during gap-closure.)
- **result:** [pending]

### Step 9. Delete account button + DeleteAccountModal stub

- **Action:** Settings → ACCOUNT panel → scroll to Danger Zone (visually separated by `border-top: 1px solid var(--border-strong)`). Click the red `Delete account…` button.
- **Expected:** The button is rendered with the destructive treatment (background or text uses `var(--red)`). Clicking it mounts the DeleteAccountModal stub: it renders nothing visible AND emits a `console.warn` `[10-07 stub] DeleteAccountModal mounted — full flow ships in plan 10-08.` (or equivalent stub log). It does NOT call `sei.deleteAccount` (T-10-07-02 mitigation; verified by `grep -c "deleteAccount" src/renderer/src/components/DeleteAccountModal.tsx == 0`).
- **result:** [pending]

### Step 10. LinuxKeyringBanner stack ordering + persisted dismissal

- **Action:** Either on Linux without a working keyring, OR stub the warning by editing `<userData>/Sei Launcher Dev/config.json` to set `linuxBasicTextWarnDismissed:false` AND making `app:warnings` return `sessionFallbackPlaintext:true` (a temporary one-line edit in `botSupervisor.ts` or `index.ts`). Sign in. Observe the Banner stack at the top of the window.
- **Expected:**
  - Banner order top-to-bottom: VerifyEmailBanner (if unverified) → LinuxKeyringBanner → Keychain Banner (UI-SPEC §Layout rule 7).
  - LinuxKeyringBanner reads exactly the UI-SPEC copy `Your system has no keyring — your sign-in session is stored in plain text. Set up gnome-keyring or kwallet for encryption, or sign out to clear the session.` with an inline `Dismiss` × button.
  - Click `Dismiss`. Banner unmounts. Relaunch app. Sign in again. Banner does NOT reappear. The `linuxBasicTextWarnDismissed:true` value is persisted in `config.json`.
  - Persistence-only substitute: edit `config.json` to set `linuxBasicTextWarnDismissed:true`, relaunch, sign in — Banner does not appear even when `sessionFallbackPlaintext:true`.
- **result:** [pending]

### Step 11. No React key / unmounted-component warnings

- **Action:** Open DevTools Console. Toggle each modal (SignOutConfirm, DeleteAccount stub) open AND closed in sequence. Then sign out and sign back in (to remount the ACCOUNT panel). Inspect the console.
- **Expected:** Zero React warnings of the shape `Warning: Each child in a list should have a unique "key" prop`, `Warning: Can't perform a React state update on an unmounted component`, or `Warning: setState(...) called from inside an unmounted component.` A clean console (apart from any unrelated existing logs).
- **result:** [pending]

## Resume signal

Once all 11 steps show `result: [pass]`, reply `approved` in the verification thread. If any step fails, file the diagnosis as a deviation and follow the auto-fix path below:

- **Step 1–2 panel missing or mis-ordered** → check `SettingsScreen.tsx` ACCOUNT section is gated on `authState.kind === 'signed_in'` AND rendered before the renamed PROFILE section.
- **Step 3–5 modal copy / shape wrong** → re-read `src/renderer/src/components/SignOutConfirmModal.tsx`; the body string is verbatim from UI-SPEC and the confirm button MUST be `kind="primary"`.
- **Step 6 screen transition fires** → check App.tsx routing — sign-out must NOT trigger a route change; ACCOUNT panel just disappears because its gate flips.
- **Step 7 AUTH-05 violation** → CRITICAL bug. Whatever code path touched characters/memory/api_key on sign-out must be reverted immediately. `signOut()` in `authHandlers.ts` only owns `session.bin` via `auth.signOut()` + storage adapter.
- **Step 8 stub returns the wrong shape** → check `sei.exportData()` IPC handler in `src/main/auth/authHandlers.ts` returns `{ok:false, code:'write_failed'}` until plan 10-09 lands.
- **Step 9 modal calls `sei.deleteAccount`** → T-10-07-02 VIOLATION. The stub must not invoke any IPC. Re-check `DeleteAccountModal.tsx` is purely presentational + console.warn.
- **Step 10 banner stack out of order** → check App.tsx — VerifyEmailBanner must mount before LinuxKeyringBanner before Keychain Banner; the order matches `<App>` body order top-to-bottom.
- **Step 10 dismissal not persisted** → check `App.tsx` `onDismiss` calls `sei.saveConfig({...cfg, linuxBasicTextWarnDismissed: true})` AND the gate reads from `cfg.linuxBasicTextWarnDismissed` (not from a transient state).
- **Step 11 React warnings present** → triage each warning individually; common cause is forgetting to clean up the 4s `Resend verification` status timeout on unmount.

Any failure becomes a follow-up auto-fix per executor deviation rules; do NOT close this UAT until all 11 are green.

---

*Tracked: D-11 (Settings is the only signed-in account surface) + AUTH-05 (sign-out preserves local data) + Pitfall A2 (Linux keyring fallback warning persistence)*
*Owner: phase-10 gap-closure / `/gsd-verify-work 10`*
*Last updated: 2026-05-20*
