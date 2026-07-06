/**
 * AcceptToSModal — BLOCKING ToS + Privacy Policy acceptance modal (D-26).
 *
 * Mounts at next launch for any signed-in user without a current-version
 * tos_acceptance row. The catch-all for:
 *   - Phase 10 alpha accounts that pre-date the legal flow
 *   - Google OAuth users (Plan 11-12 inline signup form skips them; they land here post-callback)
 *   - Any user signed in BEFORE a TOS_VERSION / PRIVACY_VERSION bump
 *
 * Layout invariants per Phase 10 UI-SPEC §Layout rules (mirrored from
 * DeleteAccountModal):
 *   - 460px width, 32px padding, scrim 0.45 alpha
 *   - ESC SUPPRESSED unconditionally (blocking modal — no dismissal path)
 *   - Click-outside does NOT close (no onClick on scrim)
 *   - Primary action disabled until checkbox is checked
 *
 * Submit calls `sei.tosAccept()` (Plan 11-12). On success the modal closes via
 * onAccepted (parent refreshes tosAccepted in useAuthStore → modal unmounts).
 * On {ok:false} the message renders inline and the user can retry.
 *
 * Source: 11-CONTEXT D-26 (blocking modal for legacy + version-bump cases),
 *         LIB-06 (no cloud write before acceptance — defense-in-depth in
 *         Plan 11-14's isCloudWriteAllowed gate).
 */
import React, { useEffect, useState } from 'react';
import { sei as seiRaw } from '../lib/ipcClient';
import { Button } from './Button';
import { ModalShell, ModalFooter } from './ModalShell';
import styles from './AcceptToSModal.module.css';

// Plan 11-12 ships `sei.tosAccept` + `sei.openExternal` on `RendererApi`. This
// plan (11-13) lands in parallel with 11-12; the type bridge below lets
// AcceptToSModal compile standalone in this worktree and is a no-op once the
// 11-12 types land (RendererApi gains the real properties — the cast is then
// equivalent to the source type).
type TosBridge = {
  tosAccept(): Promise<{ ok: true } | { ok: false; message: string }>;
  openExternal(url: string): Promise<void>;
};
const sei = seiRaw as typeof seiRaw & TosBridge;

export interface AcceptToSModalProps {
  /** Called after sei.tosAccept() returns {ok:true}. Parent refreshes auth-store tosAccepted. */
  onAccepted: () => void;
}

export function AcceptToSModal({ onAccepted }: AcceptToSModalProps): React.ReactElement {
  const [checked, setChecked] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ESC suppression — this is a BLOCKING modal (D-26). Unlike DeleteAccountModal
  // which only suppresses ESC during the in-flight submit, AcceptToSModal blocks
  // ESC unconditionally — there is no "cancel" path for a legal-gate prompt.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const handleSubmit = async (): Promise<void> => {
    if (submitting || !checked) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await sei.tosAccept();
      if (result.ok) {
        onAccepted();
      } else {
        setError(result.message);
        setSubmitting(false);
      }
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  };

  const openTerms = (): void => {
    void sei.openExternal('https://sei.gg/terms.html');
  };
  const openPrivacy = (): void => {
    void sei.openExternal('https://sei.gg/privacy.html');
  };

  // BLOCKING legal gate. ESC + click-outside SUPPRESSED (escClose false, no
  // scrimClose, no onClose) — there is no dismissal path. The dedicated
  // keydown/preventDefault effect above also stops any other ESC handler.
  return (
    <ModalShell title="Review Sei’s Terms" width={460} escClose={false}>
      <p className={styles.body}>
        We have published a Privacy Policy and Terms of Service. Please review and accept to
        continue.
      </p>
      <div className={styles.linkRow}>
        <Button kind="ghost" size="md" onClick={openTerms} disabled={submitting}>
          Open Terms of Service
        </Button>
        <Button kind="ghost" size="md" onClick={openPrivacy} disabled={submitting}>
          Open Privacy Policy
        </Button>
      </div>
      <label className={styles.checkbox}>
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => setChecked(e.target.checked)}
          disabled={submitting}
        />
        <span>I have read and agree to both</span>
      </label>
      {error ? (
        <p className={styles.errorText} role="alert">
          {error}
        </p>
      ) : null}
      <ModalFooter>
        <Button
          kind="accent"
          size="md"
          onClick={handleSubmit}
          disabled={!checked || submitting}
        >
          {submitting ? 'Accepting…' : 'Accept and continue'}
        </Button>
      </ModalFooter>
    </ModalShell>
  );
}
