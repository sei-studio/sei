---
phase: 10
plan: 07
type: execute
wave: 4
depends_on: [10-03, 10-04, 10-06]
files_modified:
  - src/renderer/src/screens/SettingsScreen.tsx
  - src/renderer/src/screens/SettingsScreen.module.css
  - src/renderer/src/App.tsx
autonomous: false
requirements: [AUTH-05, AUTH-06, AUTH-07]
requirements_addressed: [AUTH-05]
tags: [settings, account, ui, banner, linux]
must_haves:
  truths:
    - "A new ACCOUNT section appears at the top of SettingsScreen, visible ONLY when authState.kind === 'signed_in' (D-11)"
    - "ACCOUNT section contains: read-only Email row (mono value), Sign Out row (ghost button 'Sign out'), Export My Data row (ghost button 'Export as JSON'), Resend verification quiet action (only when !emailVerified), and a visually separated Danger Zone with 'Delete Account' destructive button (D-11)"
    - "Sign out button opens SignOutConfirmModal with botRunning prop derived from useDataStore.summon (D-09)"
    - "Export My Data button calls sei.exportData (plan 09 implements; here it just invokes and surfaces the result)"
    - "Delete Account button opens DeleteAccountModal (plan 08 implements; here it just mounts the component)"
    - "Resend Verification button calls sei.resendVerification; success/rate-limit/network all surface as a transient toast or inline status per UI-SPEC §Empty/Error/Loading"
    - "LinuxKeyringBanner renders ONCE on the first signed-in session when sessionFallbackPlaintext is true AND linuxBasicTextWarnDismissed is false; dismissal persists via sei.saveConfig (Pitfall A2, UI-SPEC §Linux basic_text warning Banner)"
    - "Account panel uses GitHub Danger Zone visual pattern: border-top: 1px solid var(--border-strong) above Delete Account row; label color: var(--red) inline (UI-SPEC §Account panel)"
  artifacts:
    - path: "src/renderer/src/screens/SettingsScreen.tsx"
      provides: "AccountPanel section appended above existing Appearance section; conditional on signed_in"
      contains: "AccountPanel\\|ACCOUNT"
    - path: "src/renderer/src/App.tsx"
      provides: "LinuxKeyringBanner conditional rendering using sessionFallbackPlaintext warning + UserConfig.linuxBasicTextWarnDismissed dismissal persistence"
      contains: "LinuxKeyringBanner\\|linuxBasicTextWarnDismissed"
  key_links:
    - from: "src/renderer/src/screens/SettingsScreen.tsx"
      to: "src/renderer/src/components/SignOutConfirmModal.tsx"
      via: "Mounted when signOutModalOpen state is true"
      pattern: "SignOutConfirmModal"
    - from: "src/renderer/src/screens/SettingsScreen.tsx"
      to: "src/renderer/src/components/DeleteAccountModal.tsx (plan 08 — render here when deleteModalOpen)"
      via: "Mounted when deleteAccountModalOpen state is true; rendered as null in plan 07 if the component is not yet importable"
      pattern: "DeleteAccountModal"
    - from: "src/renderer/src/App.tsx"
      to: "sei.saveConfig (persisting linuxBasicTextWarnDismissed=true)"
      via: "On Banner dismiss → saveConfig({...cfg, linuxBasicTextWarnDismissed: true})"
      pattern: "linuxBasicTextWarnDismissed"
---

<objective>
Build the user-facing surface for signed-in account management:

1. Extend `SettingsScreen.tsx` to render an ACCOUNT panel (section header + 4 rows + danger zone) at the TOP of the screen when `authState.kind === 'signed_in'`. The panel:
   - Email row (mono value, read-only; `Resend verification` quiet action when !emailVerified)
   - Sign Out row (ghost button → SignOutConfirmModal → sei.signOut)
   - Export My Data row (ghost button → sei.exportData)
   - Danger Zone separator + Delete Account row (destructive button → DeleteAccountModal — wired but the modal itself is plan 08's deliverable; plan 07 ships a working stub that just disables the button if the modal component isn't yet present)
2. Wire SignOutConfirmModal (built in plan 06) — show with the correct botRunning prop.
3. Extend the Banner stack in App.tsx with the LinuxKeyringBanner (uses existing Banner component, kind='warn', dismissable, persistence via UserConfig.linuxBasicTextWarnDismissed).
4. Add the new `sessionFallbackPlaintext` warning to the bootstrap warnings load in App.tsx (warning shape extended in plan 03 — just consume the new field).

Purpose: AUTH-05 entry point shipped (the user can actually sign out); AUTH-06 entry point shipped (Delete Account button mounts modal which plan 08 fills); AUTH-07 entry point shipped (Export My Data button calls sei.exportData which plan 09 fills); Linux keyring warning is surfaced.

Output: Extension to SettingsScreen + .module.css; small extension to App.tsx Banner stack.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/REQUIREMENTS.md
@.planning/phases/10-auth-foundation/10-CONTEXT.md
@.planning/phases/10-auth-foundation/10-RESEARCH.md
@.planning/phases/10-auth-foundation/10-UI-SPEC.md
@CLAUDE.md
@src/renderer/src/screens/SettingsScreen.tsx
@src/renderer/src/components/Banner.tsx
@src/renderer/src/components/SignOutConfirmModal.tsx
@src/renderer/src/App.tsx
@src/renderer/src/lib/stores/useAuthStore.ts
@src/renderer/src/lib/stores/useDataStore.ts
@.planning/phases/10-auth-foundation/10-04-SUMMARY.md
@.planning/phases/10-auth-foundation/10-06-SUMMARY.md

<interfaces>
<!-- Existing SettingsScreen.module.css section / row primitives are reused for ACCOUNT. -->
.section, .row, .rowLabel, .rowValue, .sectionLabel (whatever the convention is — read SettingsScreen.module.css before authoring).

<!-- DeleteAccountModal (plan 08) — do not assume it exists yet. Conditional import or a typed Promise<typeof import(...)> with .catch(null). -->

<!-- Existing useDataStore.summon shape (from prior plans):
type SummonState =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'online'; characterId: string }
  | { kind: 'error'; ... };
Bot is "running" when summon.kind === 'connecting' || summon.kind === 'online'.
-->
</interfaces>
</context>

<read_first>
- `src/renderer/src/screens/SettingsScreen.tsx` (entire file — find the existing .section / .row / .rowLabel structure so the new ACCOUNT panel matches)
- `src/renderer/src/screens/SettingsScreen.module.css` (entire — the new `.dangerSeparator` and `.dangerLabel` classes are appended here per UI-SPEC)
- `src/renderer/src/components/SignOutConfirmModal.tsx` (plan 06 — props: botRunning, onCancel, onConfirm)
- `src/renderer/src/components/Banner.tsx` (kind / message / onDismiss)
- `src/renderer/src/App.tsx` (Banner stack at lines 215–222; ADD LinuxKeyringBanner BELOW VerifyEmailBanner but ABOVE keychain Banner per UI-SPEC §Layout rule 7)
- `src/renderer/src/lib/stores/useAuthStore.ts` (state.user.email, .emailVerified)
- `src/renderer/src/lib/stores/useDataStore.ts` (summon shape)
- `src/main/ipc.ts` (plan 03 — app:warnings now returns `sessionFallbackPlaintext: boolean`)
- `src/shared/characterSchema.ts` (plan 03 added `linuxBasicTextWarnDismissed`)
- `src/shared/ipc.ts` (plan 03 — StartupWarnings shape)
- `.planning/phases/10-auth-foundation/10-UI-SPEC.md` §Account panel + §Sign-out flow + §Linux basic_text warning Banner + §Layout & Composition Rules rule 7 + rule 8 (Danger Zone visual treatment)
- `.planning/phases/10-auth-foundation/10-CONTEXT.md` D-11
</read_first>

<tasks>

<task type="auto" tdd="false">
  <name>Task 1: Add ACCOUNT panel to SettingsScreen with danger-zone visual</name>
  <files>src/renderer/src/screens/SettingsScreen.tsx, src/renderer/src/screens/SettingsScreen.module.css</files>
  <read_first>
    - src/renderer/src/screens/SettingsScreen.tsx (entire file — preserve all existing sections)
    - src/renderer/src/screens/SettingsScreen.module.css (entire — append new classes; do not modify existing)
    - src/renderer/src/components/SignOutConfirmModal.tsx (plan 06 — component shape)
    - src/renderer/src/lib/stores/useAuthStore.ts (state, user.email, emailVerified)
    - src/renderer/src/lib/stores/useDataStore.ts (summon shape — for botRunning prop)
    - .planning/phases/10-auth-foundation/10-UI-SPEC.md §Account panel (D-11) — exact copy and row structure
  </read_first>
  <behavior>
    - SettingsScreen imports useAuthStore + useDataStore + SignOutConfirmModal.
    - When authState.kind === 'signed_in', render the ACCOUNT section at the top (above the existing Account section that holds the API-key — note UI-SPEC's "ACCOUNT" header is the NEW signed-in section; the existing API-key section can keep its current header or be conditionally hidden when signed_in. Read SettingsScreen first to confirm.).
    - Section uses the existing `.section` and `.row` classes from SettingsScreen.module.css. Section header `ACCOUNT` uses the existing mono-uppercase label style (or a new `.sectionLabel` if the file already names it differently — read first).
    - Row 1: label `Email`; value is the user's email rendered in a mono font (use the existing convention if there's a mono-value class; otherwise use `font-family: var(--mono)` inline). When !emailVerified, append a quiet button `Resend verification` on the right side of the row.
    - Row 2: label `Sign Out`; right-aligned ghost Button labeled `Sign out`. Click → set `signOutModalOpen=true`.
    - Row 3: label `Export My Data`; right-aligned ghost Button labeled `Export as JSON`. Helper text below row: `Downloads everything Sei has stored about your account.`
    - Danger Zone: a divider (`.dangerSeparator` — new class — `border-top: 1px solid var(--border-strong); margin-top: var(--space-md-plus); padding-top: var(--space-lg);`). Row 4: label `Delete Account` styled with `.dangerLabel` (`color: var(--red);`); helper text below: `Permanently deletes your cloud data within 30 days. Local files stay.`; right-aligned destructive button — re-use the `.deleteBtn` rule from DeleteConfirmModal.module.css OR a new `<Button kind='primary'>` with inline `style={{ background: 'var(--red)', color: 'var(--window)' }}` (the cleaner path is a new shared class — call it `.dangerBtn` in SettingsScreen.module.css). Label: `Delete account…`.
    - Modal mounts:
      - SignOutConfirmModal mounts when signOutModalOpen=true. botRunning = useDataStore((s) => s.summon).kind === 'connecting' || ... === 'online'. onCancel sets signOutModalOpen=false. onConfirm awaits sei.signOut() then sets signOutModalOpen=false (the authState push handles routing).
      - DeleteAccountModal (plan 08) mounts when deleteAccountModalOpen=true. For plan 07, render a try-import: if the file exists, use it; if not, the button is disabled with a tooltip "Wired in plan 10-08". Since we control plan order, the cleaner solution: plan 07 LANDS the import as `import { DeleteAccountModal } from '../components/DeleteAccountModal';` knowing plan 08 creates the file before this is run. BUT plan 07 and plan 08 are different waves (07 = wave 4, 08 = wave 5). So plan 07 must build a STUB component file `src/renderer/src/components/DeleteAccountModal.tsx` (empty shell that takes the same props and renders null), so that plan 08 can later REPLACE the body. Alternative: plan 07 uses a lazy `React.lazy` with a fallback. Simplest: plan 07 ships a stub DeleteAccountModal in `src/renderer/src/components/DeleteAccountModal.tsx` that just renders null and accepts the props `{ accountEmail: string; onCancel: () => void; onConfirmed: () => void; }`. Plan 08 replaces the body. NOTE THIS in the action.
    - Resend verification quiet button: on click → setResendStatus('sending') → await sei.resendVerification() → setResendStatus('sent'|'rate-limited'|'error'); a 14px secondary text appears next to (or below) the email row for 4s then auto-dismisses. Copy per UI-SPEC §Empty/Error/Loading.
  </behavior>
  <action>
1. Create a STUB `src/renderer/src/components/DeleteAccountModal.tsx`:

```tsx
/**
 * DeleteAccountModal — STUB. Body implemented in plan 10-08.
 *
 * Plan 07 needs to import this from SettingsScreen for the type-email-to-confirm
 * mount. The stub renders null + a development-mode console warning if invoked.
 */
import React, { useEffect } from 'react';

export interface DeleteAccountModalProps {
  accountEmail: string;
  onCancel: () => void;
  onConfirmed: () => void;
}

export function DeleteAccountModal(_props: DeleteAccountModalProps): React.ReactElement | null {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.warn('[DeleteAccountModal] not yet implemented (plan 10-08). Pretending to render nothing.');
  }, []);
  return null;
}
```

And a stub `.module.css` is NOT needed (component renders null).

2. Edit `src/renderer/src/screens/SettingsScreen.module.css`. APPEND at the end:

```css
/* Phase 10 — Account panel (D-11). Danger zone visual per UI-SPEC §Layout rule 8 (GitHub Danger Zone). */
.dangerSeparator {
  border-top: 1px solid var(--border-strong);
  margin-top: var(--space-md-plus);
  padding-top: var(--space-lg);
}

.dangerLabel {
  color: var(--red);
}

.dangerBtn {
  background: var(--red);
  color: var(--window);
  border: 0;
  font-family: var(--sans);
  font-size: 14px;
  font-weight: 600;
  padding: 6px 14px;
  cursor: pointer;
}
.dangerBtn:hover { filter: brightness(0.95); }
.dangerBtn:focus-visible { outline: 1.5px solid var(--accent); outline-offset: 2px; }
.dangerBtn:disabled { opacity: 0.5; cursor: not-allowed; }

.monoValue {
  font-family: var(--mono);
  font-size: 14px;
  color: var(--text);
}

.resendStatus {
  font-family: var(--sans);
  font-size: 14px;
  color: var(--text-2);
  margin-left: var(--space-md);
}

.rowHelper {
  font-family: var(--sans);
  font-size: 14px;
  color: var(--text-2);
  margin: 4px 0 0;
}
```

3. Edit `src/renderer/src/screens/SettingsScreen.tsx`. Add imports + state + Account panel JSX BEFORE the existing first section. Read the file first to confirm the section / row CSS-Module class names (they may be `.section`, `.row`, `.rowLabel` or similar). Use the existing class names verbatim. Pseudocode-with-real-types:

```tsx
// Add imports at top:
import { useAuthStore } from '../lib/stores/useAuthStore';
import { useDataStore } from '../lib/stores/useDataStore';
import { SignOutConfirmModal } from '../components/SignOutConfirmModal';
import { DeleteAccountModal } from '../components/DeleteAccountModal';

// Inside the component:
const authState = useAuthStore((s) => s.state);
const summon = useDataStore((s) => s.summon);
const botRunning = summon.kind === 'connecting' || summon.kind === 'online';
const [signOutModalOpen, setSignOutModalOpen] = useState(false);
const [deleteAccountModalOpen, setDeleteAccountModalOpen] = useState(false);
const [resendStatus, setResendStatus] = useState<'idle' | 'sending' | 'sent' | 'rate-limited' | 'error'>('idle');
const [exportStatus, setExportStatus] = useState<{ savedPath?: string; error?: string } | null>(null);

const onResendVerification = async (): Promise<void> => {
  setResendStatus('sending');
  const res = await sei.resendVerification();
  if (res.ok) {
    setResendStatus('sent');
    setTimeout(() => setResendStatus('idle'), 4000);
  } else if (res.code === 'rate_limited') {
    setResendStatus('rate-limited');
    setTimeout(() => setResendStatus('idle'), 4000);
  } else {
    setResendStatus('error');
    setTimeout(() => setResendStatus('idle'), 4000);
  }
};

const onExport = async (): Promise<void> => {
  setExportStatus(null);
  const res = await sei.exportData();
  if (res.ok) {
    setExportStatus({ savedPath: res.savedPath });
  } else if (res.code !== 'cancelled') {
    setExportStatus({ error: "Couldn't prepare your export. Try again in a moment." });
  }
};

const resendStatusText = resendStatus === 'sending' ? 'Sending…'
  : resendStatus === 'sent' ? `We sent a new verification link to ${authState.kind === 'signed_in' ? authState.user.email : ''}.`
  : resendStatus === 'rate-limited' ? 'Hold on — wait a minute before requesting another link.'
  : resendStatus === 'error' ? "Couldn't resend. Try again in a moment."
  : '';

// JSX: prepend an Account section when signed_in
{authState.kind === 'signed_in' && (
  <section className={styles.section}>
    <h2 className={styles.sectionLabel}>ACCOUNT</h2>

    <div className={styles.row}>
      <span className={styles.rowLabel}>Email</span>
      <span className={styles.rowValue}>
        <span className={styles.monoValue}>{authState.user.email}</span>
      </span>
    </div>
    {!authState.user.emailVerified && (
      <div className={styles.row}>
        <Button kind="quiet" size="md" onClick={onResendVerification} disabled={resendStatus === 'sending'}>
          Resend verification
        </Button>
        {resendStatus !== 'idle' && <span className={styles.resendStatus}>{resendStatusText}</span>}
      </div>
    )}

    <div className={styles.row}>
      <span className={styles.rowLabel}>Sign Out</span>
      <Button kind="ghost" size="md" onClick={() => setSignOutModalOpen(true)}>Sign out</Button>
    </div>

    <div>
      <div className={styles.row}>
        <span className={styles.rowLabel}>Export My Data</span>
        <Button kind="ghost" size="md" onClick={onExport}>Export as JSON</Button>
      </div>
      <p className={styles.rowHelper}>Downloads everything Sei has stored about your account.</p>
      {exportStatus?.savedPath && (
        <p className={styles.rowHelper}>Saved to {exportStatus.savedPath}</p>
      )}
      {exportStatus?.error && (
        <p className={styles.rowHelper} style={{ color: 'var(--red)' }}>{exportStatus.error}</p>
      )}
    </div>

    <div className={styles.dangerSeparator}>
      <div className={styles.row}>
        <span className={`${styles.rowLabel} ${styles.dangerLabel}`}>Delete Account</span>
        <button type="button" className={styles.dangerBtn} onClick={() => setDeleteAccountModalOpen(true)}>
          Delete account…
        </button>
      </div>
      <p className={styles.rowHelper}>Permanently deletes your cloud data within 30 days. Local files stay.</p>
    </div>
  </section>
)}

// At the end of the SettingsScreen JSX (after existing sections), render modals conditionally:
{signOutModalOpen && (
  <SignOutConfirmModal
    botRunning={botRunning}
    onCancel={() => setSignOutModalOpen(false)}
    onConfirm={async () => { await sei.signOut(); setSignOutModalOpen(false); }}
  />
)}
{deleteAccountModalOpen && authState.kind === 'signed_in' && (
  <DeleteAccountModal
    accountEmail={authState.user.email}
    onCancel={() => setDeleteAccountModalOpen(false)}
    onConfirmed={() => { setDeleteAccountModalOpen(false); /* signed_out push handles routing */ }}
  />
)}
```

IMPORTANT: Read the actual SettingsScreen.tsx FIRST. The class names above (`.section`, `.row`, `.rowLabel`, `.rowValue`, `.sectionLabel`) might be different. Use the EXACT class names that exist in the file. If `.sectionLabel` doesn't exist, use the same JSX pattern the existing sections use for their section headers and only add the `ACCOUNT` text content.
  </action>
  <verify>
    <automated>grep -cF "useAuthStore" src/renderer/src/screens/SettingsScreen.tsx | grep -q "^1$" && grep -cF "SignOutConfirmModal" src/renderer/src/screens/SettingsScreen.tsx | grep -qE "^[2-9]" && grep -cF "DeleteAccountModal" src/renderer/src/screens/SettingsScreen.tsx | grep -qE "^[2-9]" && grep -cF "ACCOUNT" src/renderer/src/screens/SettingsScreen.tsx | grep -q "^1$" && grep -cF "Sign out" src/renderer/src/screens/SettingsScreen.tsx | grep -qE "^[1-9]" && grep -cF "Resend verification" src/renderer/src/screens/SettingsScreen.tsx | grep -q "^1$" && grep -cF "Export as JSON" src/renderer/src/screens/SettingsScreen.tsx | grep -q "^1$" && grep -cF "Downloads everything Sei has stored about your account." src/renderer/src/screens/SettingsScreen.tsx | grep -q "^1$" && grep -cF "Delete account" src/renderer/src/screens/SettingsScreen.tsx | grep -q "^1$" && grep -cF "Permanently deletes your cloud data within 30 days. Local files stay." src/renderer/src/screens/SettingsScreen.tsx | grep -q "^1$" && grep -cF "dangerSeparator" src/renderer/src/screens/SettingsScreen.module.css | grep -q "^1$" && grep -cF "dangerLabel" src/renderer/src/screens/SettingsScreen.module.css | grep -q "^1$" && grep -cF "var(--red)" src/renderer/src/screens/SettingsScreen.module.css | grep -qE "^[1-9]" && grep -cE "sei\\.signOut\\(\\)" src/renderer/src/screens/SettingsScreen.tsx | grep -q "^1$" && grep -cE "sei\\.exportData\\(\\)" src/renderer/src/screens/SettingsScreen.tsx | grep -q "^1$" && grep -cE "sei\\.resendVerification\\(\\)" src/renderer/src/screens/SettingsScreen.tsx | grep -q "^1$" && test -f src/renderer/src/components/DeleteAccountModal.tsx && grep -cF "export function DeleteAccountModal" src/renderer/src/components/DeleteAccountModal.tsx | grep -q "^1$" && npx tsc --noEmit</automated>
  </verify>
  <acceptance_criteria>
    - `grep -cF "useAuthStore" src/renderer/src/screens/SettingsScreen.tsx` equals 1
    - `grep -cF "SignOutConfirmModal" src/renderer/src/screens/SettingsScreen.tsx` >= 2 (import + JSX)
    - `grep -cF "DeleteAccountModal" src/renderer/src/screens/SettingsScreen.tsx` >= 2 (import + JSX)
    - `grep -cF "ACCOUNT" src/renderer/src/screens/SettingsScreen.tsx` equals 1
    - `grep -cF "Resend verification" src/renderer/src/screens/SettingsScreen.tsx` equals 1
    - `grep -cF "Export as JSON" src/renderer/src/screens/SettingsScreen.tsx` equals 1
    - `grep -cF "Delete account…" src/renderer/src/screens/SettingsScreen.tsx` equals 1
    - `grep -cF "Downloads everything Sei has stored about your account." src/renderer/src/screens/SettingsScreen.tsx` equals 1
    - `grep -cF "Permanently deletes your cloud data within 30 days. Local files stay." src/renderer/src/screens/SettingsScreen.tsx` equals 1
    - `grep -cE "sei\\.signOut" src/renderer/src/screens/SettingsScreen.tsx` equals 1
    - `grep -cE "sei\\.exportData" src/renderer/src/screens/SettingsScreen.tsx` equals 1
    - `grep -cE "sei\\.resendVerification" src/renderer/src/screens/SettingsScreen.tsx` equals 1
    - `grep -cF "dangerSeparator" src/renderer/src/screens/SettingsScreen.module.css` equals 1
    - `grep -cF "dangerLabel" src/renderer/src/screens/SettingsScreen.module.css` equals 1
    - `grep -cF "var(--red)" src/renderer/src/screens/SettingsScreen.module.css` >= 1
    - `grep -cF "border-top: 1px solid var(--border-strong)" src/renderer/src/screens/SettingsScreen.module.css` equals 1
    - `test -f src/renderer/src/components/DeleteAccountModal.tsx`
    - `grep -cF "export function DeleteAccountModal" src/renderer/src/components/DeleteAccountModal.tsx` equals 1
    - `grep -cF "accountEmail: string" src/renderer/src/components/DeleteAccountModal.tsx` equals 1 (props contract for plan 08)
    - `npx tsc --noEmit` exits 0
  </acceptance_criteria>
  <done>
    Account panel renders all 4 rows + danger zone with UI-SPEC copy verbatim, gated on signed_in; SignOutConfirmModal mounts with correct botRunning prop; DeleteAccountModal stub exists for plan 08 to fill; export/resend/sign-out wired.
  </done>
</task>

<task type="auto" tdd="false">
  <name>Task 2: LinuxKeyringBanner in App.tsx (uses sessionFallbackPlaintext warning + UserConfig.linuxBasicTextWarnDismissed)</name>
  <files>src/renderer/src/App.tsx</files>
  <read_first>
    - src/renderer/src/App.tsx (existing Banner stack lines 215–222; warnings useState shape at line 68)
    - src/shared/ipc.ts (StartupWarnings now has sessionFallbackPlaintext per plan 03)
    - src/shared/characterSchema.ts (UserConfig has linuxBasicTextWarnDismissed per plan 03)
    - .planning/phases/10-auth-foundation/10-UI-SPEC.md §Linux basic_text warning Banner (copy verbatim) + §Layout rule 7 (Banner stacking: VerifyEmail → Keyring → Keychain)
    - .planning/phases/10-auth-foundation/10-RESEARCH.md §Pitfall A2 + §Q4 (warning surfaces on first SIGNED_IN, not on AuthChoice — per UI-SPEC recommendation)
  </read_first>
  <behavior>
    - Existing warnings state in App.tsx (line 68) currently is `{ keychainFallbackPlaintext, dismissed }`. Extend the shape to `{ keychainFallbackPlaintext, keychainDismissed, sessionFallbackPlaintext, sessionDismissed }`.
    - The bootstrap `sei.getStartupWarnings()` call already returns `sessionFallbackPlaintext` (per plan 03's IPC extension). Read it into state.
    - On bootstrap, ALSO call `sei.getConfig()` (already done at line 103) and seed `sessionDismissed` from `cfg.linuxBasicTextWarnDismissed`.
    - LinuxKeyringBanner conditional: render when `authState.kind === 'signed_in' && warnings.sessionFallbackPlaintext && !warnings.sessionDismissed`. Note the gating on signed_in — UI-SPEC §Q4 recommendation is first-successful-sign-in only, NOT on AuthChoice.
    - Banner kind='warn', message='Your system has no keyring, so Sei is storing your sign-in less securely. Install gnome-keyring or kwallet for full protection.' (UI-SPEC verbatim).
    - onDismiss: set `sessionDismissed=true` locally AND persist via `sei.saveConfig({...currentConfig, linuxBasicTextWarnDismissed:true})`. (Need to maintain a ref to current config; the simplest path: refetch config, set the bool, save back.)
    - Stack order (UI-SPEC §Layout rule 7): VerifyEmailBanner FIRST, LinuxKeyringBanner SECOND, KeychainBanner THIRD. Confirm with `awk` ordering acceptance.
    - The existing keychain banner (`keychainFallbackPlaintext && !warnings.dismissed`) keeps working — it's for the api-key/local-mode warning. The new sessionFallbackPlaintext banner is for the post-sign-in cloud-session warning. Both reference the same Linux keyring fact but are surfaced in different contexts (UI-SPEC §Q4 + RESEARCH §Q4).
  </behavior>
  <action>
Edit `src/renderer/src/App.tsx`:

1. Change the warnings useState to:
```typescript
const [warnings, setWarnings] = useState<{
  keychainFallbackPlaintext: boolean;
  keychainDismissed: boolean;
  sessionFallbackPlaintext: boolean;
  sessionDismissed: boolean;
}>({
  keychainFallbackPlaintext: false,
  keychainDismissed: false,
  sessionFallbackPlaintext: false,
  sessionDismissed: false,
});
```

2. Update the existing reference to `warnings.dismissed` (line 220 area) to `warnings.keychainDismissed`. Update the setter call `setWarnings((w) => ({ ...w, dismissed: true }))` to `setWarnings((w) => ({ ...w, keychainDismissed: true }))`.

3. In the bootstrap useEffect, after `const w = await sei.getStartupWarnings();` (line 121–123 area), update the setWarnings call:
```typescript
const cfgForWarn = await sei.getConfig().catch(() => null);
const dismissed = cfgForWarn?.linuxBasicTextWarnDismissed ?? false;
setWarnings({
  keychainFallbackPlaintext: w.keychainFallbackPlaintext,
  keychainDismissed: false,
  sessionFallbackPlaintext: w.sessionFallbackPlaintext,
  sessionDismissed: dismissed,
});
```

   (The first sei.getConfig at line 103 is for theme; this second call re-fetches for the dismissal flag — acceptable; alternatively share via a single fetch. Cleanest: do it once.)

4. Replace the existing Banner stack (around lines 215–222) with the THREE-layer stack:

```tsx
<div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }}>
  {/* 1. VerifyEmail (plan 06) */}
  {authState.kind === 'signed_in' && !authState.user.emailVerified ? (
    <Banner
      kind="warn"
      message="Verify your email to publish characters or buy credits. Check your inbox for a link from Sei."
    />
  ) : null}

  {/* 2. LinuxKeyringBanner (plan 07) — only after sign-in per UI-SPEC §Q4 */}
  {authState.kind === 'signed_in' && warnings.sessionFallbackPlaintext && !warnings.sessionDismissed ? (
    <Banner
      kind="warn"
      message="Your system has no keyring, so Sei is storing your sign-in less securely. Install gnome-keyring or kwallet for full protection."
      onDismiss={async () => {
        setWarnings((w) => ({ ...w, sessionDismissed: true }));
        try {
          const cfg = await sei.getConfig();
          await sei.saveConfig({ ...cfg, linuxBasicTextWarnDismissed: true });
        } catch {
          // Best-effort persistence; in-session dismiss already applied.
        }
      }}
    />
  ) : null}

  {/* 3. Keychain (existing, plan 04) */}
  {warnings.keychainFallbackPlaintext && !warnings.keychainDismissed ? (
    <Banner
      kind="warn"
      message={ERROR_COPY.KEYCHAIN_FALLBACK_PLAINTEXT}
      onDismiss={() => setWarnings((w) => ({ ...w, keychainDismissed: true }))}
    />
  ) : null}

  {/* ... rest of the existing layout unchanged ... */}
</div>
```
  </action>
  <verify>
    <automated>grep -cF "sessionFallbackPlaintext" src/renderer/src/App.tsx | grep -qE "^[3-9]" && grep -cF "sessionDismissed" src/renderer/src/App.tsx | grep -qE "^[3-9]" && grep -cF "keychainDismissed" src/renderer/src/App.tsx | grep -qE "^[3-9]" && grep -cF "linuxBasicTextWarnDismissed" src/renderer/src/App.tsx | grep -q "^1$" && grep -cF "Your system has no keyring, so Sei is storing your sign-in less securely. Install gnome-keyring or kwallet for full protection." src/renderer/src/App.tsx | grep -q "^1$" && awk '/Verify your email/{a=NR} /Your system has no keyring/{b=NR} /KEYCHAIN_FALLBACK_PLAINTEXT/{c=NR} END{exit !(a < b && b < c)}' src/renderer/src/App.tsx && npx tsc --noEmit</automated>
  </verify>
  <acceptance_criteria>
    - `grep -cF "sessionFallbackPlaintext" src/renderer/src/App.tsx` >= 3 (state init + setter + conditional)
    - `grep -cF "sessionDismissed" src/renderer/src/App.tsx` >= 3
    - `grep -cF "keychainDismissed" src/renderer/src/App.tsx` >= 3 (existing renamed from `dismissed`)
    - `grep -cF "dismissed: " src/renderer/src/App.tsx` equals 0 (no bare `dismissed` left — must be the new field name)
    - `grep -cF "linuxBasicTextWarnDismissed" src/renderer/src/App.tsx` equals 1
    - `grep -cF "Your system has no keyring, so Sei is storing your sign-in less securely. Install gnome-keyring or kwallet for full protection." src/renderer/src/App.tsx` equals 1
    - Stack order: `awk '/Verify your email/{a=NR} /Your system has no keyring/{b=NR} /KEYCHAIN_FALLBACK_PLAINTEXT/{c=NR} END{exit !(a < b && b < c)}' src/renderer/src/App.tsx` exits 0
    - LinuxKeyringBanner condition includes signed_in gate: `grep -B2 "Your system has no keyring" src/renderer/src/App.tsx | grep -c "signed_in"` >= 1
    - `npx tsc --noEmit` exits 0
  </acceptance_criteria>
  <done>
    LinuxKeyringBanner renders only on signed-in sessions when sessionFallbackPlaintext is true and not dismissed; dismissal persists via UserConfig.linuxBasicTextWarnDismissed; stack order matches UI-SPEC §Layout rule 7.
  </done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task 3 (checkpoint): Account panel + sign-out flow + Banner stack verification</name>
  <files>none — human verification of prior code-producing tasks</files>
  <action>Perform the verification steps listed under <how-to-verify> below. The executor must NOT skip; this checkpoint gates the wave.</action>
  <verify>
    <automated>echo "human checkpoint — see how-to-verify below"; true</automated>
  </verify>
  <done>User has replied "approved" to the resume signal below.</done>
  <what-built>
    Signed-in Settings panel (Email, Sign Out, Export, Delete) + verified sign-out modal flow + correct Banner stacking.
  </what-built>
  <how-to-verify>
    1. Sign in (any method). Navigate to Settings. Confirm the ACCOUNT section appears at the TOP of the page (above existing API-key section / Appearance / Skin setup). Section header reads `ACCOUNT` in mono caps.
    2. Email row shows your email in mono font. If unverified, a `Resend verification` quiet button appears.
    3. Sign Out row has a ghost `Sign out` button on the right. Click it → SignOutConfirmModal opens.
    4. Modal title:
       - If bot is NOT running: `Sign out?`
       - If bot IS running (summon a character first, wait until connecting/online): `Sign out will stop your bot. Continue?`
       Body in both: `Your local characters, memory, and saved API key stay on this machine.`
       Footer: ghost `Stay signed in` (left, kind=ghost), primary `Sign out` (right, kind=primary; NOT red, NOT accent — matches the same style as a Save button).
    5. Click `Stay signed in` → modal closes, nothing else happens. Confirm authState is still signed_in via DevTools.
    6. Click `Sign out` → button label flips to `Signing out…`, then modal closes, app drops to local mode WITHOUT a screen transition (current Settings screen stays mounted but the ACCOUNT section disappears).
    7. Verify AUTH-05: `<userData>/Sei Launcher Dev/characters/` and `memory/` files UNCHANGED; api_key.bin UNCHANGED; session.bin DELETED.
    8. Re-sign in. In Settings → click `Export as JSON` — calls sei.exportData. Plan 09 implements the actual save; in plan 07 it'll return `{ok:false, code:'write_failed', message:'not_implemented: wired in plan 10-09'}` — the error appears as red helper text under the row: `Couldn't prepare your export. Try again in a moment.` (Plan 07 verification only needs the BUTTON to be present and clickable.)
    9. Click `Delete account…` (red button at bottom of danger zone) — DeleteAccountModal mounts (the stub from plan 07 renders null and logs a console.warn; plan 08 fills the body). At minimum confirm the button shows as RED (var(--red) background) and is visually separated from the rows above by the danger separator line.
    10. Banner stacking: on a Linux test machine WITHOUT gnome-keyring/kwallet (or fake by stubbing app:warnings to return sessionFallbackPlaintext:true), sign in. Both VerifyEmailBanner (if unverified) AND LinuxKeyringBanner should appear at the top, in that order. Dismiss the LinuxKeyringBanner; quit; relaunch; sign in again — the LinuxKeyringBanner stays dismissed (persisted via UserConfig).
    11. Confirm in DevTools console no React warnings about missing keys or unmounted components when toggling modals.
  </how-to-verify>
  <resume-signal>
    Reply `approved` if all 11 steps pass. If Step 10's Linux fake-warning is too hard to test without a Linux box, accept the persistence test via a manual config edit: stop the app; edit config.json to set `linuxBasicTextWarnDismissed: true`; relaunch; banner does not appear even when sessionFallbackPlaintext is true.
  </resume-signal>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| SettingsScreen render gate | ACCOUNT panel renders ONLY when authState.kind === 'signed_in' — prevents a stale local-mode view from leaking signed-in chrome. |
| Sign-out button → confirmation modal | Modal blocks accidental sign-out (D-09). |
| Delete Account button | Plan 07 mounts the modal stub; plan 08 fills the destructive flow. Stub renders null and logs a warning — no accidental delete. |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-10-07-01 | Information Disclosure | Email row exposes the user's account email in plaintext to anyone with screen access | accept | Settings screen is gated by OS login; revealing the user's own email to themselves is the desired UX. |
| T-10-07-02 | Elevation of Privilege | DeleteAccountModal stub in plan 07 actually deletes an account before plan 08 lands | mitigate | Stub renders null and calls neither sei.deleteAccount nor any other side effect. Acceptance criterion: `grep -c "sei.deleteAccount" src/renderer/src/components/DeleteAccountModal.tsx` equals 0 (it's plan 08's job). |
| T-10-07-03 | Tampering | LinuxKeyringBanner dismissal persists via UserConfig — a hostile renderer could call saveConfig({linuxBasicTextWarnDismissed:true}) to suppress the warning forever | accept | Renderer is trusted; ASVS L1 doesn't require warning-anti-dismissal hardening. The user dismissing their own warning is the expected UX. |
| T-10-07-04 | Denial of Service | Rapid clicks on Resend verification → Supabase rate-limit + user confusion | mitigate | resendStatus state disables the button while sending; rate-limited responses surface the dedicated copy `Hold on — wait a minute before requesting another link.` (UI-SPEC §Empty/Error/Loading). |
| T-10-07-05 | Tampering | Plan 07 conditionally renders the new ACCOUNT panel, but the renderer's existing api-key section also exists when signed_in — could cause confusion (signed-in users still see "API key" controls) | accept | This is by design per CONTEXT D-03/D-08: signed-in users can still BYO a provider key as a fallback while the Phase 13 proxy is "Coming Soon". The signed-in flow doesn't break the local flow. Documented in code comment. |
| T-10-07-06 | Spoofing | A renderer-side stale closure for botRunning sends `false` to SignOutConfirmModal during an active bot session | mitigate | botRunning is computed inline from useDataStore.summon on every render; SignOutConfirmModal is mounted live, not memoized. React reconciler picks up the change. |
</threat_model>

<verification>
1. `npx tsc --noEmit` exits 0.
2. Human checkpoint (Task 3) — all 11 steps pass.
3. `grep -c "sei.deleteAccount" src/renderer/src/components/DeleteAccountModal.tsx` equals 0 (stub is inert).
4. Banner stack order asserted via awk acceptance.
</verification>

<success_criteria>
- ACCOUNT panel: Email + Sign Out + Export + Resend verification + Danger Zone Delete Account, all with UI-SPEC copy verbatim
- SignOutConfirmModal wired with correct botRunning prop
- DeleteAccountModal stub exists for plan 08 to replace
- LinuxKeyringBanner renders on signed-in sessions with sessionFallbackPlaintext; dismissal persists via UserConfig
- Banner stack order: VerifyEmail → LinuxKeyring → Keychain
- Human checkpoint approved
- tsc clean
</success_criteria>

<output>
After completion, create `.planning/phases/10-auth-foundation/10-07-SUMMARY.md` covering: the DeleteAccountModal props contract (so plan 08's body matches exactly), the Banner stack order (so plan 11+ doesn't break it), and the ACCOUNT-panel conditional gate (so plans 11+ can append new rows without re-introducing them when signed_out).
</output>
