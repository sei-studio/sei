/**
 * FeedbackRewardCard — one-time feedback-for-playtime banner (260706).
 *
 * Shown at the top of the Playtime screen once the account has spent $0.50 of
 * tokens and has not yet claimed the feedback reward. Submitting sends the
 * text to the proxy's POST /feedback with claimReward=true; the server grants
 * a trial-sized playtime recharge at most once per account (partial unique
 * index on ledger_grants — the client flag is only a mirror).
 *
 * "Reply to my email" attaches the signed-in account email so the operator
 * can respond; unticked submissions stay anonymous on the feedback row (the
 * ledger grant itself always records the account, since credits need an owner).
 */

import React, { useState } from 'react';
import { sei } from '../lib/ipcClient';
import { useAuthStore } from '../lib/stores/useAuthStore';
import { useCreditsStore } from '../lib/stores/useCreditsStore';
import { Button } from './Button';
import { TextField } from './TextField';
import styles from './FeedbackRewardCard.module.css';

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

export interface FeedbackRewardCardProps {
  /**
   * Fired once the banner is finished for good: the reward was granted, or
   * the server says this account already claimed it. The parent flips to the
   * standing "Submit feedback" button. The claimed flag is persisted to
   * config here, before the callback.
   */
  onDone: () => void;
}

export function FeedbackRewardCard({ onDone }: FeedbackRewardCardProps): React.ReactElement {
  const authEmail = useAuthStore((s) =>
    s.state.kind === 'signed_in' ? s.state.user.email : null,
  );
  const refreshCredits = useCreditsStore((s) => s.refresh);
  const [body, setBody] = useState('');
  const [replyToEmail, setReplyToEmail] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doneNote, setDoneNote] = useState<string | null>(null);

  const canSubmit = body.trim().length > 0 && !submitting;

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await sei.feedbackSubmit({
        body: body.trim(),
        ...(replyToEmail && authEmail ? { email: authEmail } : {}),
        claimReward: true,
      });
      if (!res.ok) {
        setError(submitErrorCopy(res.code));
        return;
      }
      // Persist the claimed mirror so the banner never re-appears on this
      // profile, then let the parent swap in the standing feedback button.
      const cfg = await sei.getConfig();
      await sei.saveConfig({ ...cfg, feedback_reward_claimed: true });
      if (res.reward_granted) {
        void refreshCredits();
        setDoneNote('Reward added. Thank you for the feedback.');
      } else {
        setDoneNote('Feedback sent. The reward was already claimed on this account.');
      }
      window.setTimeout(onDone, 4000);
    } catch {
      setError(submitErrorCopy('PROXY_NETWORK'));
    } finally {
      setSubmitting(false);
    }
  };

  if (doneNote) {
    return (
      <div className={styles.card} role="status">
        <p className={styles.doneNote}>{doneNote}</p>
      </div>
    );
  }

  return (
    <form className={styles.card} onSubmit={handleSubmit}>
      <p className={styles.lede}>
        What do you not like about Sei? Submit any feedback and receive a free playtime recharge.
      </p>
      <TextField
        value={body}
        onChange={setBody}
        multiline
        rows={3}
        placeholder="Tell us what to fix or improve"
        aria-label="Feedback"
      />
      <div className={styles.row}>
        <label className={styles.checkbox}>
          <input
            type="checkbox"
            checked={replyToEmail}
            onChange={(e) => setReplyToEmail(e.target.checked)}
            disabled={!authEmail}
          />
          Reply to my email
        </label>
        <Button kind="accent" size="md" type="submit" disabled={!canSubmit}>
          {submitting ? 'Sending…' : 'Submit and claim reward'}
        </Button>
      </div>
      {error ? (
        <p className={styles.errorText} role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
