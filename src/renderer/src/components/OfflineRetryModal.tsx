/**
 * OfflineRetryModal — dismissible "you're offline" notice (260610).
 *
 * Mounts when a signed-in user's ToS status check came back inconclusive
 * (tosCheckFailed in useAuthStore): the app couldn't reach the database, so
 * we genuinely don't know whether they've accepted the current legal terms.
 * Before this existed, that state mis-showed the BLOCKING AcceptToSModal to
 * users who had already accepted — and their re-accept hit the composite-PK
 * duplicate error with no way out.
 *
 * Unlike AcceptToSModal this is NOT blocking: local play works offline by
 * design (the cloud-write gate already fails closed independently), so the
 * user can dismiss and keep playing. Retry re-runs refreshTosStatus; a
 * conclusive answer clears tosCheckFailed in the store and unmounts us. We
 * also auto-retry once when the OS reports connectivity returning (window
 * 'online' event) so the common laptop-wake case heals without a click.
 *
 * Layout idiom mirrors AcceptToSModal / DeleteAccountModal: 460px frame,
 * 32px padding, 0.45-alpha scrim, token-only colors.
 */
import React, { useEffect, useState } from 'react';
import { sei } from '../lib/ipcClient';
import { useAuthStore } from '../lib/stores/useAuthStore';
import { Button } from './Button';
import styles from './OfflineRetryModal.module.css';

export interface OfflineRetryModalProps {
  /** Called when the user chooses to continue offline (dismiss). */
  onDismiss: () => void;
}

export function OfflineRetryModal({ onDismiss }: OfflineRetryModalProps): React.ReactElement {
  const refreshTosStatus = useAuthStore((s) => s.refreshTosStatus);
  const [retrying, setRetrying] = useState(false);
  const [retryFailed, setRetryFailed] = useState(false);

  const retry = async (): Promise<void> => {
    if (retrying) return;
    setRetrying(true);
    setRetryFailed(false);
    await refreshTosStatus(); // never throws — failures land in tosCheckFailed
    // Still mounted ⇒ the check is still inconclusive (parent unmounts us on
    // success). Surface that so "Retry" visibly did something.
    setRetryFailed(useAuthStore.getState().tosCheckFailed);
    setRetrying(false);
  };

  // Auto-retry when the OS reports the network coming back, so the modal
  // self-heals after a transient DNS/wifi blip without user interaction.
  useEffect(() => {
    const onOnline = (): void => {
      void retry();
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
    // retry is stable enough for this lifetime-of-modal listener.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ESC dismisses — this is a notice, not a gate.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onDismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  const titleId = 'offline-retry-title';

  return (
    <div className={styles.scrim} role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className={styles.modal}>
        <h2 id={titleId} className={styles.title}>
          You&rsquo;re offline
        </h2>
        <p className={styles.body}>
          Sei couldn&rsquo;t reach the cloud to check your account. You can keep playing locally
          &mdash; cloud features like character sync will reconnect once you&rsquo;re back online.
        </p>
        {retryFailed ? (
          <p className={styles.errorText} role="alert">
            Still can&rsquo;t connect. Check your internet connection and try again.
          </p>
        ) : null}
        <div className={styles.footer}>
          <Button kind="ghost" size="md" onClick={onDismiss} disabled={retrying}>
            Continue offline
          </Button>
          <Button kind="accent" size="md" onClick={() => void retry()} disabled={retrying}>
            {retrying ? 'Retrying…' : 'Retry'}
          </Button>
        </div>
      </div>
    </div>
  );
}
