/**
 * SwitchBackendConfirmModal — confirm a cloud ↔ local AI-backend switch.
 *
 * Switching between managed cloud billing and a local (BYOK) API key is an
 * uncommon, consequential action — it changes how (and whether) the user is
 * billed and applies to the running bot immediately (see
 * botSupervisor.switchBackend). So it gets an explicit confirmation step rather
 * than a one-click toggle.
 *
 * Renders through ModalShell; reversible action → primary CTA (not destructive).
 * Esc / scrim-click cancel are suppressed while the switch is in flight.
 */
import React, { useState } from 'react';
import { Button } from './Button';
import { ModalShell, ModalFooter } from './ModalShell';
import styles from './confirmModal.module.css';

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
  const ctaLabel = submitting ? 'Switching…' : toCloud ? 'Switch to cloud' : 'Switch to my key';

  return (
    <ModalShell
      title={title}
      onClose={onCancel}
      escClose={!submitting}
      scrimClose={!submitting}
    >
      <p className={styles.body}>{body}</p>
      <ModalFooter>
        <Button kind="quiet" size="md" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button kind="primary" size="md" onClick={handleConfirm} disabled={submitting}>
          {ctaLabel}
        </Button>
      </ModalFooter>
    </ModalShell>
  );
}
