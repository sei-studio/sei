/**
 * planCatalog — the three subscription tiers as the UI presents them (260724).
 *
 * ONE place for tier labels and prices so the plan cards and the three legally
 * required purchase surfaces (PreCtaDisclosure, AutoRenewalConsentModal,
 * ReceiptScreen) can never drift apart on the amount they disclose.
 *
 * Dollar amounts appear ONLY here and on the top up packages. Everything else
 * in the app talks in percentages and credits: no per-usage cost figures and no
 * playtime estimates anywhere in the UI.
 *
 * The allowance figures are display copy. The authoritative numbers live in the
 * proxy's `plan_config` table so they can be retuned without a client release;
 * if the two disagree, the server wins and this copy is the bug.
 */

import type { PlanTier } from '@shared/ipc';

export interface PlanCard {
  tier: PlanTier;
  /** User-facing plan name. */
  name: string;
  /** Big money number on the card, e.g. "$8". */
  price: string;
  /** Small qualifier under the price, e.g. "/mo". Null for Free. */
  priceQualifier: string | null;
  /** One-line positioning under the price. */
  blurb: string;
  /**
   * Exact charge for the legal disclosures, e.g. "$8.00". Null for Free (there
   * is nothing to disclose when nothing is charged).
   */
  chargeUsd: string | null;
}

export const PLANS: readonly PlanCard[] = [
  {
    tier: 'free',
    name: 'Free',
    price: '$0',
    priceQualifier: null,
    blurb: '100 credits a week',
    chargeUsd: null,
  },
  {
    tier: 'quest',
    name: 'Quest',
    price: '$8',
    priceQualifier: '/mo',
    blurb: '800 credits a week',
    chargeUsd: '$8.00',
  },
  {
    tier: 'party',
    name: 'Party',
    price: '$18',
    priceQualifier: '/mo',
    blurb: '2,400 credits a week',
    chargeUsd: '$18.00',
  },
] as const;

/** Rank order, free < quest < party. Used to label Upgrade vs Downgrade. */
export const TIER_ORDER: Record<PlanTier, number> = { free: 0, quest: 1, party: 2 };

export function planCard(tier: PlanTier): PlanCard {
  return PLANS.find((p) => p.tier === tier) ?? PLANS[0];
}

/** "Quest" / "Party" / "Free". */
export function planName(tier: PlanTier): string {
  return planCard(tier).name;
}

/** "$8.00" for a paid tier, null for Free. */
export function planChargeUsd(tier: PlanTier): string | null {
  return planCard(tier).chargeUsd;
}
