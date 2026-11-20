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
import { t, uiLanguage } from './i18n';

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

/**
 * The plan the plan screen points people at (261023): its card gets the
 * accent edge and a "Recommended" tag while it is an upgrade from the
 * current plan. Presentation only, no price or allowance rides on it. Party,
 * because Sei is a gaming companion and Party is the plan sized for games.
 */
export const RECOMMENDED_TIER: PlanTier = 'party';

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

/**
 * "Quest" / "Party" / "Free", in the UI language (261104). Quest and Party are
 * brand names and stay as they are; Free is a word, so it is translated when
 * the catalog still calls it Free. A renamed plan shows the server's name.
 */
export function planDisplayName(card: PlanCard): string {
  return card.tier === 'free' && card.name === 'Free' ? t('Free') : card.name;
}

/** planDisplayName by tier. */
export function planName(cards: readonly PlanCard[], tier: PlanTier): string {
  return planDisplayName(planCard(cards, tier));
}

/**
 * "Free plan" / "Quest plan". Free gets its own key because the translated
 * word does not fit the "{name} plan" frame ("Тариф Бесплатный").
 */
export function planLabel(cards: readonly PlanCard[], tier: PlanTier): string {
  const card = planCard(cards, tier);
  return card.tier === 'free' && card.name === 'Free' ? t('Free plan') : t('{name} plan', { name: card.name });
}

/**
 * The plan card's positioning line in the UI language. The blurb arrives in
 * English from the server catalog (or the bundled fallback), and the i18n key
 * IS the English string, so a known blurb is translated and a retuned one the
 * dictionaries do not know yet shows as sent.
 */
export function planBlurb(card: PlanCard): string {
  return t(card.blurb);
}

/** Server top up lines look like "800 credits" or "3200 credits + 400 bonus". */
const CREDITS_LINE = /^(\d[\d,]*) credits(?: \+ (\d[\d,]*) bonus)?$/;

/**
 * A top up card's credits line in the UI language (261104). Either shape
 * above is rebuilt from its numbers; anything else (a free-form server
 * blurb) goes through t() and shows as sent when the dictionaries lack it.
 * Outside English the count is shown without digit grouping.
 */
export function topUpCreditsLine(credits: string): string {
  // English shows the line exactly as the catalog has it ("10,000 credits").
  if (uiLanguage() === 'en') return credits;
  const m = CREDITS_LINE.exec(credits.trim());
  if (!m) return t(credits);
  const n = Number(m[1].replace(/,/g, ''));
  if (m[2] === undefined) return t('{n} credits', { n });
  return t('{n} credits + {bonus} bonus', { n, bonus: Number(m[2].replace(/,/g, '')) });
}

/** "$8.00" for a paid tier, null for Free. */
export function planChargeUsd(cards: readonly PlanCard[], tier: PlanTier): string | null {
  return planCard(cards, tier).chargeUsd;
}
