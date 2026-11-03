// Vitest tests for planCatalog (260725 server-driven pricing).
//
// The normalizers are the seam between the proxy's plan_config/topup_config
// rows (cents + credits + optional blurb) and the copy every money surface
// renders — including the legally disclosed amounts — so the formatting
// contract is pinned here.

import { afterEach, describe, it, expect } from 'vitest';
import type { PricingCatalog } from '@shared/ipc';
import {
  PLANS,
  TOP_UPS,
  plansFromCatalog,
  topUpsFromCatalog,
  planCard,
  planChargeUsd,
  planBlurb,
  planLabel,
  planName,
  topUpCreditsLine,
} from './planCatalog';
import { useLangStore } from './i18n';
import { formatResetsIn, resetsInLine } from './formatResetsIn';

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

describe('localized plan display (261104)', () => {
  afterEach(() => useLangStore.getState().setLang('en'));

  it('keeps English unchanged', () => {
    expect(planName(PLANS, 'free')).toBe('Free');
    expect(planLabel(PLANS, 'free')).toBe('Free plan');
    expect(planLabel(PLANS, 'quest')).toBe('Quest plan');
    expect(planBlurb(planCard(PLANS, 'party'))).toBe('3x Quest usage. Best for gaming.');
    expect(topUpCreditsLine('3200 credits + 400 bonus')).toBe('3200 credits + 400 bonus');
    expect(topUpCreditsLine('800 credits')).toBe('800 credits');
  });

  it('translates Free, the blurbs and the credit lines; Quest and Party stay brand names', () => {
    useLangStore.getState().setLang('ru');
    expect(planName(PLANS, 'free')).not.toBe('Free');
    expect(planName(PLANS, 'quest')).toBe('Quest');
    expect(planLabel(PLANS, 'free')).not.toMatch(/Free/);
    expect(planLabel(PLANS, 'party')).toContain('Party');
    for (const p of PLANS) expect(planBlurb(p)).not.toBe(p.blurb);
    expect(topUpCreditsLine('3200 credits + 400 bonus')).toMatch(/^3200 \S+ \+ 400 /);
    expect(topUpCreditsLine('800 credits')).toMatch(/^800 /);
    expect(topUpCreditsLine('800 credits')).not.toMatch(/credits/);
  });

  it('shows an unknown server line as sent', () => {
    useLangStore.getState().setLang('ja');
    expect(topUpCreditsLine('Limited pack!')).toBe('Limited pack!');
    expect(planBlurb({ ...planCard(PLANS, 'free'), blurb: 'Brand new blurb.' })).toBe('Brand new blurb.');
    expect(planName([{ ...planCard(PLANS, 'free'), name: 'Starter' }], 'free')).toBe('Starter');
  });

  it('localizes the reset countdown units', () => {
    const now = Date.parse('2026-11-04T00:00:00Z');
    const at = new Date(now + (2 * 1440 + 23 * 60 + 5) * 60_000).toISOString();
    expect(formatResetsIn(at, now)).toBe('2d 23h');
    expect(resetsInLine(formatResetsIn(new Date(now + 30_000).toISOString(), now))).toBe('Resets soon');
    useLangStore.getState().setLang('ja');
    expect(formatResetsIn(at, now)).toBe('2日23時間');
    useLangStore.getState().setLang('ru');
    expect(resetsInLine(formatResetsIn(at, now))).not.toMatch(/\d+d|\d+h/);
  });
});
