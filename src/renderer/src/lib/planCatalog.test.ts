// Vitest tests for planCatalog (260725 server-driven pricing).
//
// The normalizers are the seam between the proxy's plan_config/topup_config
// rows (cents + credits + optional blurb) and the copy every money surface
// renders — including the legally disclosed amounts — so the formatting
// contract is pinned here.

import { describe, it, expect } from 'vitest';
import type { PricingCatalog } from '@shared/ipc';
import {
  PLANS,
  TOP_UPS,
  plansFromCatalog,
  topUpsFromCatalog,
  planCard,
  planChargeUsd,
} from './planCatalog';

const SERVER_LAUNCH: PricingCatalog = {
  plans: [
    { tier: 'free', name: 'Free', price_cents: 0, weekly_credits: 100, blurb: null },
    { tier: 'quest', name: 'Quest', price_cents: 800, weekly_credits: 800, blurb: null },
    { tier: 'party', name: 'Party', price_cents: 1800, weekly_credits: 2400, blurb: null },
  ],
  topups: [
    { kind: 'topup_small', name: '800 Credits', price_cents: 500, credits: 800, blurb: null },
    {
      kind: 'topup_large',
      name: '3600 Credits',
      price_cents: 2000,
      credits: 3600,
      blurb: '3200 credits + 400 bonus',
    },
  ],
};

describe('plansFromCatalog', () => {
  it('reproduces the bundled launch copy from the launch server rows', () => {
    // The bundled PLANS are the offline fallback for exactly these rows, so
    // the normalized output must match them field for field.
    expect(plansFromCatalog(SERVER_LAUNCH)).toEqual(PLANS);
  });

  it('reflects a server-side price retune, including the disclosure form', () => {
    const retuned: PricingCatalog = {
      ...SERVER_LAUNCH,
      plans: SERVER_LAUNCH.plans.map((p) =>
        p.tier === 'quest' ? { ...p, price_cents: 950, weekly_credits: 1000 } : p,
      ),
    };
    const cards = plansFromCatalog(retuned);
    const quest = planCard(cards, 'quest');
    expect(quest.price).toBe('$9.50');
    expect(quest.chargeUsd).toBe('$9.50');
    // 260725: a null server blurb falls back to bundled positioning copy.
    // It must NEVER derive a credit amount; allowances are not shown in-app.
    expect(quest.blurb).toBe('Best for texting and calling.');
    expect(quest.blurb).not.toMatch(/credit/i);
    // The legal helpers read the same cards, so the disclosures move with it.
    expect(planChargeUsd(cards, 'quest')).toBe('$9.50');
  });

  it('lets a server blurb override the derived credits line', () => {
    const withBlurb: PricingCatalog = {
      ...SERVER_LAUNCH,
      plans: SERVER_LAUNCH.plans.map((p) =>
        p.tier === 'party' ? { ...p, blurb: 'Best for whole parties' } : p,
      ),
    };
    expect(planCard(plansFromCatalog(withBlurb), 'party').blurb).toBe('Best for whole parties');
  });

  it('keeps Free free of price qualifier and disclosure amount', () => {
    const free = planCard(plansFromCatalog(SERVER_LAUNCH), 'free');
    expect(free.priceQualifier).toBeNull();
    expect(free.chargeUsd).toBeNull();
  });
});

describe('topUpsFromCatalog', () => {
  it('reproduces the bundled launch copy from the launch server rows', () => {
    expect(topUpsFromCatalog(SERVER_LAUNCH)).toEqual(TOP_UPS);
  });

  it('carries a NEW server package through untouched (the 260725 point)', () => {
    const withNewPack: PricingCatalog = {
      ...SERVER_LAUNCH,
      topups: [
        ...SERVER_LAUNCH.topups,
        { kind: 'topup_mega', name: '10000 Credits', price_cents: 5000, credits: 10_000, blurb: null },
      ],
    };
    const packs = topUpsFromCatalog(withNewPack);
    const mega = packs.find((p) => p.kind === 'topup_mega');
    expect(mega).toEqual({
      kind: 'topup_mega',
      price: '$50',
      credits: '10,000 credits',
    });
  });
});
