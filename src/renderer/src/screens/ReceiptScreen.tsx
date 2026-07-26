/**
 * ReceiptScreen — quick/260525-sbo Task 6.
 *
 * In-app receipt surface auto-navigated to when a user's plan moves UP into a
 * paid tier (Free → Quest / Party, or Quest → Party). Required by FTC 16 CFR
 * §425.5 ("plain-language acknowledgement of the charges at the point of
 * subscription"). The transition trigger lives in
 * useCreditsStore.shouldNavigateToReceipt + the status-push side-effect; this
 * component is the rendered surface.
 *
 * This screen renders the literal charged amount per FTC 16 CFR §425.5. It is
 * the one surface that keeps a dollar figure for legal reasons (260725: the
 * consent modal + pre-CTA disclosure were removed; Polar's hosted checkout
 * carries the recurring terms), alongside the plan cards and top up packages.
 *
 * Idempotency: the auto-navigate fires AT MOST ONCE per upgrade (guarded by
 * useCreditsStore.prevPlanForReceipt module-level ref). Repeat pushes on the
 * same tier do NOT re-navigate; an already-subscribed user opening the app does
 * NOT see this screen on cold-load (the seed plan is recorded as prev BEFORE
 * the first transition check).
 *
 * Source: quick/260525-sbo Cluster F Task 6.
 */
import React from 'react';
import { useCreditsStore } from '../lib/stores/useCreditsStore';
import { useUiStore } from '../lib/stores/useUiStore';
import { Button } from '../components/Button';
import { BackIcon } from '../components/icons';
import { formatRenewal } from '../lib/formatRenewal';
import { planCard } from '../lib/planCatalog';
import styles from './ReceiptScreen.module.css';

export function ReceiptScreen(): React.ReactElement {
  const renewsAt = useCreditsStore((s) => s.renews_at);
  const plan = useCreditsStore((s) => s.plan);
  // 260725: server-driven catalog, so the acknowledged charge matches what
  // the proxy actually billed (bundled fallback until the catalog loads).
  const planCards = useCreditsStore((s) => s.planCards);
  const navigate = useUiStore((s) => s.navigate);

  const card = planCard(planCards, plan);
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
        <h1 className={styles.title}>Welcome to {card.name}!</h1>

        <div className={styles.tile}>
          {/*
            * "$X.00 charged today" is the FTC 16 CFR §425.5 plain-language
            * charge acknowledgement; the dollar amount MUST render in-app at
            * the activation moment, and MUST match the tier just purchased.
            */}
          <p className={styles.line}>{card.chargeUsd ?? '$0.00'} charged today.</p>
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
