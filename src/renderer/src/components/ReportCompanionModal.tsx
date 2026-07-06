/**
 * ReportCompanionModal — in-app companion report form (260706).
 *
 * Replaces the old mailto:dmca@sei.gg link on foreign-owned character pages.
 * Common reasons render as checkboxes; "Other" requires a comment. Submits to
 * the proxy's POST /report (20/day per user server-side); rows land in the
 * RLS-locked reports table for manual review. The DMCA mailto path in
 * Settings stays untouched as the formal legal channel.
 */

import React, { useState } from 'react';
import { sei } from '../lib/ipcClient';
import { Button } from './Button';
import { ModalShell, ModalFooter } from './ModalShell';
import { TextField } from './TextField';
import styles from './ReportCompanionModal.module.css';

/** Mirrors the proxy's REPORT_REASONS allowlist (sei-proxy src/feedback/submit.ts). */
const REASONS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'sexual_minors', label: 'Sexual content involving minors' },
  { key: 'sexual_content', label: 'Sexual or explicit content' },
  { key: 'hate_harassment', label: 'Hate or harassment' },
  { key: 'violence_self_harm', label: 'Violence or self harm' },
  { key: 'copyright', label: 'Copyright infringement' },
  { key: 'impersonation', label: 'Impersonation' },
  { key: 'spam', label: 'Spam or misleading' },
  { key: 'other', label: 'Other' },
];

function submitErrorCopy(code: string): string {
  switch (code) {
    case 'PROXY_RATE_LIMITED':
      return 'Daily report limit reached. Try again tomorrow.';
    case 'PROXY_NO_SESSION':
      return 'Sign in to report a companion.';
    default:
      return 'Report could not be sent. Check your connection and try again.';
  }
}

export interface ReportCompanionModalProps {
  characterName: string;
  characterPublicId?: string;
  /** Closes the modal. Caller controls mount/unmount. */
  onClose: () => void;
}

export function ReportCompanionModal({
  characterName,
  characterPublicId,
  onClose,
}: ReportCompanionModalProps): React.ReactElement {
  const [selected, setSelected] = useState<string[]>([]);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const toggle = (key: string): void => {
    setSelected((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  };

  const needsComment = selected.includes('other') && comment.trim().length === 0;
  const canSubmit = selected.length > 0 && !needsComment && !submitting;

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setSubmitting(true);
    try {
      const trimmedComment = comment.trim();
      const res = await sei.reportSubmit({
        reasons: selected,
        ...(trimmedComment ? { comment: trimmedComment } : {}),
        ...(characterPublicId ? { characterPublicId } : {}),
        characterName,
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
      <ModalShell title="Report sent" onClose={onClose} scrimClose width={440}>
        <p className={styles.framing}>
          Thank you. We review reports within 24 hours and remove companions that break the rules.
        </p>
        <ModalFooter>
          <Button kind="accent" size="md" onClick={onClose}>
            Close
          </Button>
        </ModalFooter>
      </ModalShell>
    );
  }

  return (
    <ModalShell title={`Report ${characterName}`} onClose={onClose} scrimClose width={440}>
      <p className={styles.framing}>What is wrong with this companion? Select all that apply.</p>
      <form className={styles.form} onSubmit={handleSubmit}>
        <div className={styles.reasons}>
          {REASONS.map((r) => (
            <label key={r.key} className={styles.checkbox}>
              <input
                type="checkbox"
                checked={selected.includes(r.key)}
                onChange={() => toggle(r.key)}
              />
              {r.label}
            </label>
          ))}
        </div>
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel} htmlFor="report-comment">
            Details {selected.includes('other') ? '(required for Other)' : '(optional)'}
          </label>
          <TextField
            value={comment}
            onChange={setComment}
            multiline
            rows={3}
            placeholder="Anything that helps us review faster"
            aria-label="Report details"
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
          <Button kind="danger" size="md" type="submit" disabled={!canSubmit}>
            {submitting ? 'Sending…' : 'Submit report'}
          </Button>
        </ModalFooter>
      </form>
    </ModalShell>
  );
}
