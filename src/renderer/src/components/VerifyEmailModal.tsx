/**
 * VerifyEmailModal — redeem an email code from inside the app (260804).
 *
 * The signed-in-but-unverified state has its own entry point because it does
 * not pass through any sign-in surface: the account already exists, the session
 * is live, and the only thing missing is the confirmation. Settings used to
 * offer "Resend verification" here, which under the link flow was the whole
 * interaction; with codes there has to be somewhere to type one.
 *
 * Opens by sending a fresh code, so the row is one click rather than
 * "resend, then verify". Reuses useEmailCode, so entry, redemption, resend and
 * their copy are the same as the sign-in surfaces.
 */
import React, { useEffect, useRef } from 'react';
import { useT } from '../lib/i18n';
import { useEmailCode } from '../lib/useEmailCode';
import { Button } from './Button';
import { CodeInput } from './CodeInput';
import { ModalShell, ModalFooter } from './ModalShell';
import styles from './SignInModal.module.css';

export interface VerifyEmailModalProps {
  /** The signed-in user's address. The code goes here. */
  email: string;
  onClose: () => void;
}

export function VerifyEmailModal({ email, onClose }: VerifyEmailModalProps): React.ReactElement {
  const t = useT();
  // Redemption fires USER_UPDATED, which flips emailVerified in the auth state
  // and removes both the banner and the Settings row that opened this.
  const code = useEmailCode(email, onClose);
  const sent = useRef(false);

  useEffect(() => {
    // Once per mount. StrictMode double-invokes effects in dev, and a second
    // send would trip Supabase's 60s send limit and greet the user with a
    // rate-limit notice on a modal they just opened.
    if (sent.current) return;
    sent.current = true;
    void code.resend();
    // Deliberately empty deps: `code` is a fresh object every render, so
    // depending on it would fire a send per keystroke. The ref above is what
    // makes "once" true; the deps array only avoids the churn.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [before, after] = t('We sent a 6-digit code to {email}. Check spam if it is not there.').split(
    '{email}',
  );

  return (
    <ModalShell
      title={t('Verify your email')}
      width={460}
      escClose={!code.submitting}
      onClose={onClose}
    >
      <p className={styles.framing}>
        {before}
        <strong>{email}</strong>
        {after}
      </p>
      <CodeInput
        value={code.code}
        onChange={code.setCode}
        onComplete={(v) => void code.submit(v)}
        disabled={code.submitting}
        invalid={!!code.error}
        autoFocus
        aria-label={t('Verification code')}
      />
      {code.error ? (
        <p className={styles.errorText} role="alert">
          {code.error}
        </p>
      ) : null}
      {code.note ? <p className={styles.framing}>{code.note}</p> : null}
      <ModalFooter>
        <Button
          kind="accent"
          size="md"
          disabled={code.submitting || code.code.length === 0}
          onClick={() => void code.submit()}
        >
          {code.submitting ? t('Checking…') : t('Verify')}
        </Button>
        <Button kind="quiet" size="md" disabled={code.resending} onClick={() => void code.resend()}>
          {code.resending ? t('Sending…') : t('Send a new code')}
        </Button>
        <Button kind="quiet" size="md" onClick={onClose}>
          {t('Back to Sei')}
        </Button>
      </ModalFooter>
    </ModalShell>
  );
}
