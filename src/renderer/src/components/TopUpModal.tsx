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
 * applies (CA ARL covers recurring charges only). The prices are static copy on
 * the package cards, matching the plan cards.
 *
 * Structural template: ModalShell + ModalFooter, like AutoRenewalConsentModal.
 */
import React from 'react';
import { useCreditsStore } from '../lib/stores/useCreditsStore';
import { Button } from './Button';
import { ModalShell, ModalFooter } from './ModalShell';
import styles from './TopUpModal.module.css';

/**
 * The two `topup_config` SKUs. Credit totals are what the server grants, kept
 * here ONLY as marketing copy: the authoritative amounts live in the proxy's
 * `topup_config` table so they can be retuned without a client release. If the
 * two ever disagree, the server wins and this copy is the bug.
 */
const PACKAGES: Array<{
  kind: 'topup_small' | 'topup_large';
  price: string;
  credits: string;
  note: string | null;
}> = [
  { kind: 'topup_small', price: '$5', credits: '800 credits', note: null },
  {
    kind: 'topup_large',
    price: '$20',
    credits: '3,600 credits',
    note: '3,200 plus 400 bonus',
  },
];

export interface TopUpModalProps {
  onClose: () => void;
  /**
   * Fired after a package's checkout has been opened in the browser, so the
   * parent can start its "complete your purchase" watch. The modal closes
   * itself first.
   */
  onProceed?: (kind: 'topup_small' | 'topup_large') => void;
}

export function TopUpModal({ onClose, onProceed }: TopUpModalProps): React.ReactElement {
  const checkoutStatus = useCreditsStore((s) => s.checkoutStatus);
  const busy = checkoutStatus !== 'idle';

  const handleBuy = (kind: 'topup_small' | 'topup_large'): void => {
    if (busy) return;
    onClose();
    onProceed?.(kind);
  };

  return (
    // Stacked tier (1100) so it layers above the hard-stop popup when opened
    // from there. ESC and the footer button dismiss it.
    <ModalShell title="Buy extra credits" width={440} tier="stacked" onClose={onClose}>
      <p className={styles.body}>
        Extra credits do not expire and do not reset. Your companions use your weekly
        allowance first, then these.
      </p>

      <div className={styles.packs}>
        {PACKAGES.map((pkg) => (
          <div key={pkg.kind} className={styles.pack}>
            <span className={styles.packPrice}>{pkg.price}</span>
            <span className={styles.packCredits}>{pkg.credits}</span>
            <span className={styles.packNote}>{pkg.note ?? 'one time'}</span>
            <div className={styles.packAction}>
              <Button
                kind="accent"
                size="sm"
                fullWidth
                disabled={busy}
                onClick={() => handleBuy(pkg.kind)}
              >
                Buy
              </Button>
            </div>
          </div>
        ))}
      </div>

      <ModalFooter>
        <Button kind="quiet" size="md" onClick={onClose}>
          Close
        </Button>
      </ModalFooter>
    </ModalShell>
  );
}
