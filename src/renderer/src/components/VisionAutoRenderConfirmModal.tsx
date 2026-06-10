/**
 * VisionAutoRenderConfirmModal — confirm turning ON the idle auto-look (vision)
 * feature (Phase 15, D-05/D-06).
 *
 * Auto-look has the bot periodically render what it sees on its own, which it
 * sends to the model — so it uses more playtime than leaving vision off. That
 * cost is worth a one-time heads-up, so enabling it goes through this confirm
 * step instead of a one-click toggle. Turning it back OFF needs no confirm
 * (disabling a cost feature is always safe) — only the enable path opens this.
 *
 * D-06 / PROXY-05 (CRITICAL): the body speaks in PLAIN LANGUAGE — "uses more
 * playtime" — with NO token counts, NO dollar amounts, and NO numeric
 * estimates. The cost surfaces instead as the shrunk "~Xh left" playtime figure
 * on the Playtime screen (D-07), never as a scary number here.
 *
 * Scaffold cloned from SwitchBackendConfirmModal (which itself cloned
 * SignOutConfirmModal): reversible action → primary CTA (not destructive red),
 * Escape-to-cancel, scrim-click cancel, submitting guard. Reuses the SHARED
 * SignOutConfirmModal.module.css — no new CSS file.
 */
import React, { useEffect, useState } from 'react';
import { Button } from './Button';
import styles from './SignOutConfirmModal.module.css';

export interface VisionAutoRenderConfirmModalProps {
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}

export function VisionAutoRenderConfirmModal({
  onCancel,
  onConfirm,
}: VisionAutoRenderConfirmModalProps): React.ReactElement {
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !submitting) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, submitting]);

  const handleConfirm = async (): Promise<void> => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onConfirm();
    } finally {
      setSubmitting(false);
    }
  };

  const titleId = 'vision-auto-render-confirm-title';

  return (
    <div
      className={styles.scrim}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) onCancel();
      }}
    >
      <div className={styles.modal}>
        <h2 id={titleId} className={styles.title}>Turn on auto-look?</h2>
        <p className={styles.body}>
          With auto-look on, your bot will glance around and take a look at its
          surroundings on its own from time to time. Seeing the world uses more
          playtime than leaving auto-look off. You can turn it back off any time.
        </p>
        <div className={styles.footer}>
          <Button kind="ghost" size="md" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
          <Button kind="primary" size="md" onClick={() => void handleConfirm()} disabled={submitting}>
            {submitting ? 'Turning on…' : 'Turn on auto-look'}
          </Button>
        </div>
      </div>
    </div>
  );
}
