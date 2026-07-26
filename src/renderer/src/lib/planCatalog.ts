/**
 * planCatalog — plan cards + top up packages as the UI presents them.
 *
 * 260725: the catalog is SERVER-DRIVEN. Main reads the proxy's world-readable
 * `plan_config` / `topup_config` tables (credits:catalog IPC) and
 * `useCreditsStore.loadCatalog()` overlays the result onto the store via the
 * normalizers here, so a price/name/blurb retune (or a whole new top up
 * package) repaints every up-to-date client without a release. The literals
 * below are the LAUNCH copy, kept only as the offline / failure fallback —
 * if they disagree with the server, the server wins and this copy is stale.
 *
 * ONE place for the money formatting so the plan cards and ReceiptScreen (the
 * post-purchase charge acknowledgement) can never drift apart on the amount
 * they disclose. Dollar amounts appear ONLY on these surfaces and the top up
 * packages. Everything else in the app talks in percentages and credits: no
 * per-usage cost figures and no playtime estimates anywhere in the UI.
 * (260725: the in-app consent modal + pre-CTA disclosure were removed; the
 * recurring terms are disclosed on the Polar hosted checkout page.)
 */

import type { PlanTier, PricingCatalog } from '@shared/ipc';

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

/** A top up package card (TopUpModal). `kind` is the checkout SKU id. */
export interface TopUpPackage {
  kind: string;
  /** Big money number, e.g. "$5". */
  price: string;
  /** Credits line, e.g. "800 credits" or "3200 credits + 400 bonus". */
  credits: string;
}

/** 800 → "$8", 750 → "$7.50". Card-face price. */
function formatPrice(cents: number): string {
  const dollars = cents / 100;
  return cents % 100 === 0 ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

/** 800 → "$8.00". Exact-charge form for the legal disclosures. */
function formatCharge(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Launch fallback copy — see the header note. Server catalog wins.
 *
 * 260725: plan blurbs are POSITIONING copy, never credit amounts. The weekly
 * allowance sizes are deliberately not shown anywhere in the app (or in the
 * Polar product copy) — the usage bar communicates headroom as a percentage.
 */
export const PLANS: readonly PlanCard[] = [
  {
    tier: 'free',
    name: 'Free',
    price: '$0',
    priceQualifier: null,
    blurb: 'Give Sei a try!',
    chargeUsd: null,
  },
  {
    tier: 'quest',
    name: 'Quest',
    price: '$8',
    priceQualifier: '/mo',
    blurb: 'Best for texting and calling.',
    chargeUsd: '$8.00',
  },
  {
    tier: 'party',
    name: 'Party',
    price: '$18',
    priceQualifier: '/mo',
    blurb: '3x Quest usage. Best for gaming.',
    chargeUsd: '$18.00',
  },
] as const;

/**
 * Launch fallback copy for the top up packages. Server catalog wins. Unlike
 * the plans, a top up card DOES state its credits — that is the product.
 */
export const TOP_UPS: readonly TopUpPackage[] = [
  { kind: 'topup_small', price: '$5', credits: '800 credits' },
  { kind: 'topup_large', price: '$20', credits: '3200 credits + 400 bonus' },
] as const;

/** Rank order, free < quest < party. Used to label Upgrade vs Downgrade. */
export const TIER_ORDER: Record<PlanTier, number> = { free: 0, quest: 1, party: 2 };

/**
 * Normalize the server catalog into plan cards. Free stays price-qualifier-
 * and disclosure-free. A null server blurb falls back to the bundled
 * positioning line for that tier — NEVER a derived credit amount (260725:
 * allowance sizes are not shown in the app).
 */
export function plansFromCatalog(catalog: PricingCatalog): PlanCard[] {
  return catalog.plans.map((p) => ({
    tier: p.tier,
    name: p.name,
    price: formatPrice(p.price_cents),
    priceQualifier: p.price_cents > 0 ? '/mo' : null,
    blurb: p.blurb ?? planCard(PLANS, p.tier).blurb,
    chargeUsd: p.price_cents > 0 ? formatCharge(p.price_cents) : null,
  }));
}

/**
 * Normalize the server catalog into top up package cards. The blurb, when
 * set, REPLACES the derived credits line (e.g. "3200 credits + 400 bonus").
 */
export function topUpsFromCatalog(catalog: PricingCatalog): TopUpPackage[] {
  return catalog.topups.map((t) => ({
    kind: t.kind,
    price: formatPrice(t.price_cents),
    credits: t.blurb ?? `${t.credits.toLocaleString('en-US')} credits`,
  }));
}

/**
 * Lookup helpers. Callers pass the CURRENT card set — normally
 * `useCreditsStore(s => s.planCards)`, which starts as the bundled PLANS and
 * is overlaid with the server catalog once loaded — so every surface
 * (cards, consent modal, disclosures, receipt) discloses the same amounts.
 */
export function planCard(cards: readonly PlanCard[], tier: PlanTier): PlanCard {
  return cards.find((p) => p.tier === tier) ?? cards[0] ?? PLANS[0];
}

/** "Quest" / "Party" / "Free". */
export function planName(cards: readonly PlanCard[], tier: PlanTier): string {
  return planCard(cards, tier).name;
}

/** "$8.00" for a paid tier, null for Free. */
export function planChargeUsd(cards: readonly PlanCard[], tier: PlanTier): string | null {
  return planCard(cards, tier).chargeUsd;
}
