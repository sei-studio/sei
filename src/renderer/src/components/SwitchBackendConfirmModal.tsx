/**
 * SwitchBackendConfirmModal — confirm a cloud ↔ local AI-backend switch.
 *
 * Switching between managed cloud billing and a local (BYOK) API key is an
 * uncommon, consequential action — it changes how (and whether) the user is
 * billed and applies to the running bot immediately (see
 * botSupervisor.switchBackend). So it gets an explicit confirmation step rather
 * than a one-click toggle.
 *
 * 261110: the Playtime tabs open it. One heads-up line per direction (plus
 * the renewal note for a paying subscriber leaving the cloud).
 *
 * Renders through ModalShell; reversible action → primary CTA (not destructive).
 * Esc / scrim-click cancel are suppressed while the switch is in flight.
 */
import React, { useState } from 'react';
import { useT } from '../lib/i18n';
import { useCreditsStore } from '../lib/stores/useCreditsStore';
import { Button } from './Button';
import { ModalShell, ModalFooter } from './ModalShell';
import styles from './confirmModal.module.css';

export interface SwitchBackendConfirmModalProps {
  /** Target backend the user is switching TO. */
  direction: 'cloud-proxy' | 'local';
  /**
   * 261017 (issue #46): the switch to local was started from "Use your
   * ChatGPT plan", so the copy talks about the ChatGPT plan, not an API key.
   */
  via?: 'chatgpt';
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}

export function SwitchBackendConfirmModal({
  direction,
  via,
  onCancel,
  onConfirm,
}: SwitchBackendConfirmModalProps): React.ReactElement {
  const t = useT();
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
  const toChatgpt = !toCloud && via === 'chatgpt';
  // 261110 (Playtime tabs): one short heads-up line, no paragraph. A paying
  // subscriber moving off the cloud also hears that the plan keeps renewing.
  const plan = useCreditsStore((s) => s.plan);
  const title = toCloud
    ? t('Switch to Sei?')
    : toChatgpt
      ? t('Use your ChatGPT plan?')
      : t('Switch to my keys?');
  const line = toCloud
    ? t('Your companions will think and speak with Sei, on your Sei plan.')
    : toChatgpt
      ? t('Your companions will think with ChatGPT and use voices on this device.')
      : t('Your companions will think with your own key or model.');
  const renewNote = !toCloud && plan !== 'free' ? t('Your Sei plan keeps renewing until you cancel it.') : null;
  const ctaLabel = submitting
    ? t('Switching…')
    : toCloud
      ? t('Switch to Sei')
      : toChatgpt
        ? t('Use ChatGPT plan')
        : t('Switch to my keys');

  return (
    <ModalShell
      title={title}
      onClose={onCancel}
      escClose={!submitting}
      scrimClose={!submitting}
    >
      <p className={styles.body}>{line}</p>
      {renewNote ? <p className={styles.body}>{renewNote}</p> : null}
      <ModalFooter>
        <Button kind="quiet" size="md" onClick={onCancel} disabled={submitting}>
          {t('Cancel')}
        </Button>
        <Button kind="primary" size="md" onClick={handleConfirm} disabled={submitting}>
          {ctaLabel}
        </Button>
      </ModalFooter>
    </ModalShell>
  );
}
