/**
 * TopUpModal — buy extra credits (260724 weekly-subscription model).
 *
 * Opened from the extra-credits row on the plan screen and from the hard-stop
 * popup. Two one-time packages, sold through the same proxy-minted Polar
 * checkout the subscriptions use. Extra credits are a SEPARATE bucket from the
 * weekly allowance: they never expire and never reset, and they are only spent
 * once the week's allowance is gone.
 *
 * These packages are one-time purchases, so no auto-renewal consent gate
 * applies (CA ARL covers recurring charges only).
 *
 * 260725: the package cards come from `useCreditsStore.topUpPackages` — the
 * server-driven pricing catalog (proxy `topup_config` rows), seeded with the
 * bundled launch copy as the offline fallback. A package added or retuned
 * server-side appears here without a client release; its `kind` (the config
 * row id) is passed straight through to the checkout.
 *
 * Structural template: ModalShell + ModalFooter.
 */
import React from 'react';
import { useT } from '../lib/i18n';
import { useCreditsStore } from '../lib/stores/useCreditsStore';
import { Button } from './Button';
import { ModalShell, ModalFooter } from './ModalShell';
import styles from './TopUpModal.module.css';

export interface TopUpModalProps {
  onClose: () => void;
  /**
   * Fired after a package's checkout has been opened in the browser, so the
   * parent can start its "complete your purchase" watch. The modal closes
   * itself first. `kind` is the package's topup_config row id.
   */
  onProceed?: (kind: string) => void;
}

export function TopUpModal({ onClose, onProceed }: TopUpModalProps): React.ReactElement {
  const t = useT();
  const checkoutStatus = useCreditsStore((s) => s.checkoutStatus);
  const packages = useCreditsStore((s) => s.topUpPackages);
  const busy = checkoutStatus !== 'idle';

  const handleBuy = (kind: string): void => {
    if (busy) return;
    onClose();
    onProceed?.(kind);
  };

  return (
    // Stacked tier (1100) so it layers above the hard-stop popup when opened
    // from there. ESC and the footer button dismiss it.
    <ModalShell title={t('Buy extra credits')} width={440} tier="stacked" onClose={onClose}>
      <p className={styles.body}>
        {t(
          'Extra credits do not expire and do not reset. Your companions use your weekly allowance first, then these.',
        )}
      </p>

      <div className={styles.packs}>
        {packages.map((pkg) => (
          <div key={pkg.kind} className={styles.pack}>
            <span className={styles.packPrice}>{pkg.price}</span>
            <span className={styles.packCredits}>{pkg.credits}</span>
            <div className={styles.packAction}>
              <Button
                kind="accent"
                size="sm"
                fullWidth
                disabled={busy}
                onClick={() => handleBuy(pkg.kind)}
              >
                {t('Buy')}
              </Button>
            </div>
          </div>
        ))}
      </div>

      <ModalFooter>
        <Button kind="quiet" size="md" onClick={onClose}>
          {t('Close')}
        </Button>
      </ModalFooter>
    </ModalShell>
  );
}
