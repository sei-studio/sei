/**
 * SetNewPasswordModal — choose a new password after a password-reset link lands.
 *
 * Flow: the user taps "Forgot your password?" in SignInModal → main emails a
 * reset link → clicking it lands a recovery session (main pushes
 * auth:password-recovery) → App.tsx mounts this modal. The user enters a new
 * password (typed twice) and submits → sei.updatePassword → success.
 *
 * The user is already SIGNED IN via the recovery session by the time this
 * mounts. They reached here by deliberately clicking a password-reset link, so
 * the modal is completion-only (260605): there is no "Maybe later" dismiss and
 * ESC does not close it — finishing the reset (or the success "Back to Sei") is
 * the single way out. This prevents leaving an account in a half-reset state.
 *
 * Mirrors SignInModal's modal frame, Button, and TextField usage so the
 * recovery prompt is visually continuous with the sign-in surface.
 */
import React, { useState } from 'react';
import { sei } from '../lib/ipcClient';
import { Button } from './Button';
import { ModalShell, ModalFooter } from './ModalShell';
import { TextField } from './TextField';
import styles from './SetNewPasswordModal.module.css';

export interface SetNewPasswordModalProps {
  /** Called on success AND on dismissal. App.tsx clears the recovery flag. */
  onClose: () => void;
}

/** Matches the signup floor + the UpdatePasswordSchema(min 8) in main. */
const MIN_PASSWORD_LEN = 8;

export function SetNewPasswordModal({ onClose }: SetNewPasswordModalProps): React.ReactElement {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    if (password.length < MIN_PASSWORD_LEN) {
      setError(`Password must be at least ${MIN_PASSWORD_LEN} characters.`);
      return;
    }
    if (password !== confirm) {
      setError("Those passwords don't match.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await sei.updatePassword({ password });
      if (res.ok) {
        setDone(true);
      } else {
        setError(res.message);
      }
    } finally {
      setSubmitting(false);
    }
  };

  // BLOCKING recovery gate (tier 'recovery', z 1200): ESC does not close and
  // there is no scrim-click dismiss — finishing the reset is the only way out.
  // Success sub-state — confirm and let the user dismiss back into the app.
  if (done) {
    return (
      <ModalShell title="Password updated" width={460} tier="recovery" escClose={false}>
        <p className={styles.framing}>
          You can sign in with your new password next time. You're all set for now.
        </p>
        <ModalFooter>
          <Button kind="accent" size="md" onClick={onClose}>
            Back to Sei
          </Button>
        </ModalFooter>
      </ModalShell>
    );
  }

  return (
    <ModalShell title="Choose a new password" width={460} tier="recovery" escClose={false}>
      <p className={styles.framing}>
        Enter a new password for your Sei account. At least {MIN_PASSWORD_LEN} characters.
      </p>

      <form className={styles.form} onSubmit={onSubmit}>
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel} htmlFor="new-password">New password</label>
          <TextField
            value={password}
            onChange={setPassword}
            placeholder={`At least ${MIN_PASSWORD_LEN} characters`}
            type="password"
            autoFocus
            aria-label="New password"
            aria-invalid={!!error}
          />
        </div>

        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel} htmlFor="confirm-password">Confirm password</label>
          <TextField
            value={confirm}
            onChange={setConfirm}
            placeholder="Re-enter your new password"
            type="password"
            aria-label="Confirm password"
            aria-invalid={!!error}
          />
        </div>

        {error ? <p className={styles.errorText} role="alert">{error}</p> : null}

        <Button
          kind="accent"
          size="md"
          type="submit"
          disabled={submitting || !password || !confirm}
        >
          {submitting ? 'Saving…' : 'Save new password'}
        </Button>
      </form>
    </ModalShell>
  );
}
