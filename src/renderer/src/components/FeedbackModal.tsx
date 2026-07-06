/**
 * FeedbackModal — the standing "Submit feedback" form (260706).
 *
 * Opened from the Playtime screen after the one-time reward banner has been
 * used (and anywhere else a feedback entry point makes sense). Email is
 * optional: leaving it blank submits fully anonymously (the proxy stores no
 * user id on the row). Server-side the proxy caps submissions at 20/day per
 * account; the 429 surfaces here as honest daily-limit copy.
 *
 * Form scaffolding cloned from SetNewPasswordModal (fields / error / done
 * sub-state swap); renders through ModalShell.
 */

import React, { useState } from 'react';
import { sei } from '../lib/ipcClient';
import { Button } from './Button';
import { ModalShell, ModalFooter } from './ModalShell';
import { TextField } from './TextField';
import styles from './FeedbackModal.module.css';

function submitErrorCopy(code: string): string {
  switch (code) {
    case 'PROXY_RATE_LIMITED':
      return 'Daily feedback limit reached. Try again tomorrow.';
    case 'PROXY_NO_SESSION':
      return 'Sign in to submit feedback.';
    default:
      return 'Feedback could not be sent. Check your connection and try again.';
  }
}

export interface FeedbackModalProps {
  /** Closes the modal. Caller controls mount/unmount. */
  onClose: () => void;
}

export function FeedbackModal({ onClose }: FeedbackModalProps): React.ReactElement {
  const [email, setEmail] = useState('');
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const canSubmit = body.trim().length > 0 && !submitting;

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setSubmitting(true);
    try {
      const trimmedEmail = email.trim();
      const res = await sei.feedbackSubmit({
        body: body.trim(),
        ...(trimmedEmail ? { email: trimmedEmail } : {}),
      });
      if (res.ok) {
        setDone(true);
      } else {
        setError(submitErrorCopy(res.code));
      }
    } catch {
      setError(submitErrorCopy('PROXY_NETWORK'));
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <ModalShell title="Feedback sent" onClose={onClose} scrimClose width={440}>
        <p className={styles.framing}>Thank you. We read all comments within 24 hrs.</p>
        <ModalFooter>
          <Button kind="accent" size="md" onClick={onClose}>
            Close
          </Button>
        </ModalFooter>
      </ModalShell>
    );
  }

  return (
    <ModalShell title="Submit feedback" onClose={onClose} scrimClose width={440}>
      <p className={styles.framing}>
        Tell us anything you like or don&apos;t like! We read all comments within 24 hrs.
      </p>
      <form className={styles.form} onSubmit={handleSubmit}>
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel} htmlFor="feedback-email">
            Email (optional, leave blank to stay anonymous)
          </label>
          <TextField
            value={email}
            onChange={setEmail}
            placeholder="you@example.com"
            aria-label="Email, optional"
          />
        </div>
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel} htmlFor="feedback-body">
            Feedback
          </label>
          <TextField
            value={body}
            onChange={setBody}
            multiline
            rows={5}
            autoFocus
            placeholder="What should we improve?"
            aria-label="Feedback"
          />
        </div>
        {error ? (
          <p className={styles.errorText} role="alert">
            {error}
          </p>
        ) : null}
        <ModalFooter>
          <Button kind="ghost" size="md" onClick={onClose} type="button">
            Cancel
          </Button>
          <Button kind="accent" size="md" type="submit" disabled={!canSubmit}>
            {submitting ? 'Sending…' : 'Submit'}
          </Button>
        </ModalFooter>
      </form>
    </ModalShell>
  );
}
