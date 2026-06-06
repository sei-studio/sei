/**
 * SwitchBackendConfirmModal — confirm a cloud ↔ local AI-backend switch.
 *
 * Switching between managed cloud billing and a local (BYOK) API key is an
 * uncommon, consequential action — it changes how (and whether) the user is
 * billed and applies to the running bot immediately (see
 * botSupervisor.switchBackend). So it gets an explicit confirmation step
 * rather than a one-click toggle.
 *
 * Scaffold cloned from SignOutConfirmModal (reversible action → primary CTA,
 * not destructive red).
 */
import React, { useEffect, useState } from 'react';
import { Button } from './Button';
import styles from './SignOutConfirmModal.module.css';

export interface SwitchBackendConfirmModalProps {
  /** Target backend the user is switching TO. */
  direction: 'cloud-proxy' | 'local';
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}

export function SwitchBackendConfirmModal({
  direction,
  onCancel,
  onConfirm,
}: SwitchBackendConfirmModalProps): React.ReactElement {
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

  const toCloud = direction === 'cloud-proxy';
  const title = toCloud ? 'Switch to managed billing?' : 'Switch to your own API key?';
  const body = toCloud
    ? 'Sei will stop using your local API key and route through our managed cloud, billed to your subscription or credits. This applies to a running bot right away. You can switch back any time.'
    : 'Sei will stop using managed cloud credits and route through the API key stored on this device. This applies to a running bot right away. Your subscription keeps renewing until you cancel it.';
  const ctaLabel = submitting
    ? 'Switching…'
    : toCloud
      ? 'Switch to cloud'
      : 'Switch to my key';
  const titleId = 'switch-backend-confirm-title';

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
        <h2 id={titleId} className={styles.title}>{title}</h2>
        <p className={styles.body}>{body}</p>
        <div className={styles.footer}>
          <Button kind="ghost" size="md" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
          <Button kind="primary" size="md" onClick={handleConfirm} disabled={submitting}>
            {ctaLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
