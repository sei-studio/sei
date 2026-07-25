/**
 * Tests for AutoRenewalConsentModal — quick/260525-sbo Task 3.
 *
 * RED phase: the component file does not yet exist; this test fails to import.
 *
 * Project test convention (mirrors useCreditsStore.test.ts): no
 * @testing-library/react is installed, so we exercise the modal's CONTRACT
 * at the import/module boundary (literal-string presence and exports) plus
 * the IPC handoff (sei.recordSubscriptionConsent + sei.creditsOpenCheckout
 * call order). DOM-render assertions are handled by the structural greps
 * in the executor verify gate — this file's job is the behavior contract.
 *
 * Invariants under test:
 *   1. Module exports an AutoRenewalConsentModal symbol.
 *   2. The consent label discloses the TIER's exact per-month amount ($8/month
 *      for Quest, $18/month for Party) — CA ARL §17602(a)(1) clear-and-
 *      conspicuous disclosure inside the consent surface.
 *   3. Source contains literal "until I cancel" (auto-renewal language).
 *   4. Source states that the amount is legally required.
 *   5. The handleConfirm flow calls recordSubscriptionConsent BEFORE
 *      creditsOpenCheckout(tier) (legal anchor must land first).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
// node: prefix imports — vitest runs in node; declare via @ts-expect-error
// since the renderer tsconfig.web.json doesn't ship node types.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = resolve(__dirname, 'AutoRenewalConsentModal.tsx');

let recordConsentMock: ReturnType<
  typeof vi.fn<(args: { consent_version: string }) => Promise<{ ok: true } | { ok: false; code: string }>>
>;
let openCheckoutMock: ReturnType<
  typeof vi.fn<
    (kind: 'quest' | 'party' | 'topup_small' | 'topup_large') => Promise<
      { ok: true } | { ok: false; code: string }
    >
  >
>;
let consentCalledAt = 0;
let checkoutCalledAt = 0;
let nextTick = 0;

beforeEach(() => {
  vi.resetModules();
  consentCalledAt = 0;
  checkoutCalledAt = 0;
  nextTick = 0;
  recordConsentMock = vi.fn(async () => {
    consentCalledAt = ++nextTick;
    return { ok: true } as const;
  });
  openCheckoutMock = vi.fn(async () => {
    checkoutCalledAt = ++nextTick;
    return { ok: true } as const;
  });

  (globalThis as unknown as { window: unknown }).window = {
    sei: {
      recordSubscriptionConsent: recordConsentMock,
      creditsOpenCheckout: openCheckoutMock,
    },
  };
});

describe('AutoRenewalConsentModal', () => {
  it('Test 1: exports AutoRenewalConsentModal symbol', async () => {
    const mod = await import('./AutoRenewalConsentModal');
    expect(mod.AutoRenewalConsentModal).toBeDefined();
    expect(typeof mod.AutoRenewalConsentModal).toBe('function');
  });

  it('Test 2: the consent label carries the tier\'s per-month amount (CA ARL clear-and-conspicuous)', async () => {
    const source = readFileSync(SOURCE_PATH, 'utf-8');
    // The amount is interpolated from the tier so Quest and Party can never
    // disclose each other's price.
    expect(source.includes('${card.price}/month until I cancel')).toBe(true);
    // The catalog is the single source of those amounts.
    const { planCard } = await import('../lib/planCatalog');
    expect(planCard('quest').price).toBe('$8');
    expect(planCard('party').price).toBe('$18');
    expect(planCard('quest').chargeUsd).toBe('$8.00');
    expect(planCard('party').chargeUsd).toBe('$18.00');
  });

  it('Test 3: source contains literal "until I cancel" (auto-renewal language)', () => {
    const source = readFileSync(SOURCE_PATH, 'utf-8');
    expect(source.includes('until I cancel')).toBe(true);
  });

  it('Test 4: source records why the dollar amount must render here', () => {
    const source = readFileSync(SOURCE_PATH, 'utf-8');
    expect(source.includes('CA ARL §17602(a)(1)')).toBe(true);
  });

  it('Test 5: handleConfirm calls recordSubscriptionConsent BEFORE creditsOpenCheckout', async () => {
    const mod = await import('./AutoRenewalConsentModal');
    // The component exports an internal handler we can invoke directly without
    // a DOM. Mirror the pattern of unit-testing pure-data callbacks rather
    // than rendering React (no @testing-library/react in the project).
    expect(mod.handleConfirmForTest).toBeDefined();
    await mod.handleConfirmForTest('2026-05-26');

    expect(recordConsentMock).toHaveBeenCalledWith({ consent_version: '2026-05-26' });
    expect(openCheckoutMock).toHaveBeenCalledWith('party');
    // Order invariant: consent INSERT MUST land before the checkout opens so
    // the legal anchor is recorded server-side even if the user closes the
    // browser before completing the LS flow.
    expect(consentCalledAt).toBeGreaterThan(0);
    expect(checkoutCalledAt).toBeGreaterThan(consentCalledAt);
  });

  it('Test 6: handleConfirm proceeds to checkout even if consent INSERT fails', async () => {
    // The legal anchor is the user's affirmative checkbox click which the
    // renderer cannot lose; a 503 from record-consent is logged but does not
    // block the checkout (otherwise a flaky network would prevent purchase).
    recordConsentMock = vi.fn(async () => ({ ok: false, code: 'PROXY_NETWORK' }) as const);
    (globalThis as unknown as { window: { sei: { recordSubscriptionConsent: typeof recordConsentMock; creditsOpenCheckout: typeof openCheckoutMock } } }).window.sei.recordSubscriptionConsent =
      recordConsentMock;

    const mod = await import('./AutoRenewalConsentModal');
    await mod.handleConfirmForTest('2026-05-26');

    expect(recordConsentMock).toHaveBeenCalledTimes(1);
    expect(openCheckoutMock).toHaveBeenCalledWith('party');
  });

  it('Test 6b: the checkout kind follows the tier being purchased', async () => {
    const mod = await import('./AutoRenewalConsentModal');
    await mod.handleConfirmForTest('2026-05-26', undefined, 'quest');
    expect(openCheckoutMock).toHaveBeenCalledWith('quest');
  });

  it('Test 7: onProceed fires AFTER creditsOpenCheckout (hand-off to the checkout watch)', async () => {
    const mod = await import('./AutoRenewalConsentModal');
    let proceedAt = 0;
    const onProceed = vi.fn(() => {
      proceedAt = ++nextTick;
    });
    await mod.handleConfirmForTest('2026-05-26', onProceed);

    expect(onProceed).toHaveBeenCalledTimes(1);
    // The browser checkout must be open before we start polling for the grant.
    expect(checkoutCalledAt).toBeGreaterThan(0);
    expect(proceedAt).toBeGreaterThan(checkoutCalledAt);
  });
});
