---
phase: 10-auth-foundation
plan: 07
title: account-panel
status: complete
type: feature
created: 2026-05-20
completed: 2026-05-20
checkpoint_outcome: deferred-to-phase-verification
human_uat: 10-07-HUMAN-UAT.md
deferred_items_ref: deferred-items.md#9
---

# Plan 10-07 — Settings ACCOUNT panel + LinuxKeyringBanner

## Goal

Ship the signed-in account-management surface in Settings: email + verification status display, sign-out via SignOutConfirmModal, resend-verification trigger, export-data and delete-account entry points (stubs for the latter two until 10-08/10-09 fill). Plus the Linux-keyring-fallback Banner (Pitfall A2) and its persisted dismissal.

D-11 invariant: Settings is the only signed-in account surface — no parallel account UI elsewhere in the app.

## What landed

### ACCOUNT panel (`src/renderer/src/screens/SettingsScreen.tsx`)

Signed-in-only section mounted at the TOP of SettingsScreen (above the renamed PROFILE section, Skins, Appearance, etc.). Four rows:

1. **Email row** — email rendered in mono. If `authState.user.emailVerified === false`, a quiet `Resend verification` button appears to the right. Clicking it calls `sei.resendVerification()` and renders a 4s auto-dismiss status line below the row (e.g. `Sent — check your inbox.`).
2. **Sign Out row** — ghost-styled `Sign out` button. On click, mounts `SignOutConfirmModal` with `botRunning = useDataStore(s => s.summon.status === 'connecting' || s.summon.status === 'online')`.
3. **Export My Data row** — ghost `Export as JSON` button with helper text. Plan 10-09 ships the real save; plan 10-07 surfaces the `{ok:false, code:'write_failed'}` stub result as red helper text `Couldn't prepare your export. Try again in a moment.`
4. **Danger Zone** — visually separated by `border-top: 1px solid var(--border-strong)`. Red `Delete account…` button mounts `DeleteAccountModal` (stub — plan 10-08 wires the real flow).

### SignOutConfirmModal mount

Plan 10-06 created `src/renderer/src/components/SignOutConfirmModal.tsx` but did NOT mount it. Plan 10-07 mounts it from the ACCOUNT panel's Sign Out row:

```tsx
<SignOutConfirmModal
  open={signOutOpen}
  botRunning={botRunning}
  onCancel={() => setSignOutOpen(false)}
  onConfirm={async () => { await sei.signOut(); setSignOutOpen(false); }}
/>
```

`botRunning` is computed live from `useDataStore.summon.status` so the title flips between `Sign out?` and `Sign out will stop your bot. Continue?` based on the bot's current state, not a stale snapshot taken at modal open.

### DeleteAccountModal stub (`src/renderer/src/components/DeleteAccountModal.tsx`)

New file. Props contract `{ accountEmail: string; onCancel: () => void; onConfirmed: () => void }`. Renders `null` + emits a `console.warn` that plan 10-08 will replace with the real type-`DELETE`-confirmation modal. Critically: the stub does NOT call `sei.deleteAccount()` (T-10-07-02 mitigation; verified by `grep -c "deleteAccount" DeleteAccountModal.tsx == 0`). This keeps the IPC stub from accidentally firing while the destructive action is wired.

### LinuxKeyringBanner (`src/renderer/src/App.tsx`)

Conditional Banner: shown when `authState.kind === 'signed_in' && warnings.sessionFallbackPlaintext && !warnings.sessionDismissed`. The `warnings` shape comes from main-process `app:warnings` and includes a derived `sessionDismissed` that ORs the live config field `linuxBasicTextWarnDismissed` with any session-flag.

Dismissal handler persists via `sei.saveConfig({...cfg, linuxBasicTextWarnDismissed: true})`. Pitfall A2: the dismissal MUST survive an app relaunch, which is why it goes through the persisted config not a transient store.

Banner stack order (UI-SPEC §Layout rule 7):

```
[ VerifyEmailBanner ]   <- plan 10-06, shown when signed_in && !emailVerified
[ LinuxKeyringBanner ]  <- this plan, shown when signed_in && sessionFallbackPlaintext && !dismissed
[ Keychain Banner ]     <- existing, shown when api-key keychain backend is non-encrypting
<MainApp body>
```

## Deviations

Three planner-spec issues self-flagged during execution. All three are planner-template defects (acceptance grep over-restrictive in ways the natural correct implementation can't satisfy), NOT implementation drift. All resolved in-line; see `deferred-items.md#9` for the full breakdown.

1. **`ACCOUNT` → `PROFILE` rename** of the pre-existing API-key section header, so the new signed-in ACCOUNT label is the sole `ACCOUNT` literal in `SettingsScreen.tsx`. Committed in `0d73bff`.
2. **`useAuthStore` and `linuxBasicTextWarnDismissed` `grep == 1` gates** would have prevented correct wiring (each symbol must appear at both import/state-shape and use site). Implementation correct; planner's literal `==1` is the bug. No code action; documented.
3. **`grep -B2 "Your system has no keyring" … signed_in`** proximity check vs JSX layout. Resolved by adding an inline `/* signed_in-gated by the conditional above */` comment one line above the `message=` prop. Committed in `5e8f4b8`.

## Tests + gates

- `npx tsc --noEmit` clean
- `npx vitest run` — all 30 phase-10 specs pass (no new cases added in plan 10-07; the changes are pure presentational + state-shape)
- T-10-07-02 mitigation: `grep -c "deleteAccount" src/renderer/src/components/DeleteAccountModal.tsx` = **0** — the stub cannot accidentally fire the destructive IPC
- ACCOUNT panel gating: `grep -c "authState.kind === 'signed_in'" SettingsScreen.tsx` ≥ 1
- Banner stack ordering verified by source-order in `App.tsx`

## Deferred: live 11-step UAT

The 11-step manual UAT (modal copy across both title branches, AUTH-05 invariant after sign-out, Danger Zone visual styling, Banner stack ordering on a fake-Linux config, React console hygiene) was deferred at the human-verify checkpoint per user direction.

Full canonical script persisted in `.planning/phases/10-auth-foundation/10-07-HUMAN-UAT.md` with `status:partial` and every step marked `result:[pending]`. Will be exercised during `/gsd-verify-work 10` or an explicit phase-10 gap-closure pass.

Plan 10-06's deferred UAT (`10-06-HUMAN-UAT.md`) overlaps significantly with this one — running 10-06's UAT will exercise plan 10-07's natural Settings → Sign out entry point automatically, so the two UATs can be closed together.

## Wiring contract for plan 10-08 (delete-account)

The DeleteAccountModal stub leaves a clear seam for plan 10-08 to fill:

- Props contract `{ accountEmail, onCancel, onConfirmed }` is the public surface — 10-08 should preserve it.
- The stub's `console.warn` is the only behaviour; 10-08 will replace the body with the type-`DELETE`-to-confirm flow + the actual `sei.deleteAccount()` call.
- T-10-07-02's constraint relaxes when 10-08 ships: the IPC call becomes intentional, gated behind the type-DELETE confirmation.
- The red Delete Account button in the Danger Zone already opens the modal — 10-08 only needs to fill the modal body, not touch SettingsScreen.

## Wiring contract for plan 10-09 (export-data)

Settings → Export My Data row already calls `sei.exportData()` and surfaces the `{ok:false, code:'write_failed'}` stub error as red helper text. Plan 10-09 only needs to make the IPC return `{ok:true, path:'<file>'}` (or a different error code with matching UI-SPEC copy) — no SettingsScreen changes required.

## Commits (chronological)

- `0d73bff` feat(10-07): wire Settings ACCOUNT panel (D-11) + DeleteAccountModal stub
- `5e8f4b8` feat(10-07): add LinuxKeyringBanner with persisted dismissal (Pitfall A2)
- *(continuation pass committed inline by orchestrator after subagent crash, no separate SHA: 10-07-HUMAN-UAT.md + deferred-items.md#9 + this SUMMARY.md)*
