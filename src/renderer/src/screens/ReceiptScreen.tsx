/**
 * ReceiptScreen — quick/260525-sbo Task 6.
 *
 * In-app receipt surface auto-navigated to when a user's plan transitions
 * from any non-'unlimited' value to 'unlimited' (= first-time subscription
 * activation). Required by FTC 16 CFR §425.5 ("plain-language
 * acknowledgement of the charges at the point of subscription"). The
 * transition trigger lives in useCreditsStore.shouldNavigateToReceipt +
 * the status-push side-effect; this component is the rendered surface.
 *
 * PROXY-05 carve-out: this screen renders the literal "$20.00" amount in
 * the renderer per FTC 16 CFR §425.5 (plain-language acknowledgement of
 * charges at the point of subscription). The PROXY-05 bright-line ("no
 * dollar amounts in renderer") is suspended for the at-purchase legal-
 * disclosure surface only.
 *
 * Idempotency: the auto-navigate fires AT MOST ONCE per non-unlimited →
 * unlimited transition (guarded by useCreditsStore.prevPlanForReceipt
 * module-level ref). Subsequent unlimited→unlimited pushes do NOT
 * re-navigate; an already-subscribed user opening the app does NOT see
 * this screen on cold-load (the seed plan is recorded as prev BEFORE the
 * first transition check).
 *
 * Source: quick/260525-sbo Cluster F Task 6.
 */
import React from 'react';
import { useCreditsStore } from '../lib/stores/useCreditsStore';
import { useUiStore } from '../lib/stores/useUiStore';
import { Button } from '../components/Button';
import { BackIcon } from '../components/icons';
import { formatRenewal } from '../lib/formatRenewal';
import styles from './ReceiptScreen.module.css';

export function ReceiptScreen(): React.ReactElement {
  const renewsAt = useCreditsStore((s) => s.renews_at);
  const navigate = useUiStore((s) => s.navigate);

  const nextBilling = formatRenewal(renewsAt) ?? 'in 30 days';

  return (
    <div className={styles.root}>
      <div className={styles.col}>
        <div className={styles.backRow}>
          <Button
            kind="quiet"
            size="sm"
            icon={<BackIcon size={14} />}
            onClick={() => navigate({ kind: 'home' })}
          >
            Back
          </Button>
        </div>
        <h1 className={styles.title}>Welcome to Party!</h1>

        <div className={styles.tile}>
          {/*
            * PROXY-05 carve-out (quick/260525-sbo Task 6): "$20.00 charged
            * today" is the FTC 16 CFR §425.5 plain-language charge
            * acknowledgement; the dollar amount MUST render in-app at the
            * activation moment.
            */}
          <p className={styles.line}>$20.00 charged today.</p>
          <p className={styles.line}>Billed monthly until you cancel.</p>
          <p className={styles.line}>Next billing date: {nextBilling}.</p>
          <p className={styles.line}>
            Cancel anytime in Settings → Cloud AI → Cancel subscription.
          </p>
        </div>

        <div className={styles.actions}>
          <Button kind="primary" onClick={() => navigate({ kind: 'home' })}>
            Back to Sei
          </Button>
        </div>
      </div>
    </div>
  );
}
