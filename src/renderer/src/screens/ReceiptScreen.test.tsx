/**
 * Tests for ReceiptScreen — quick/260525-sbo Task 6.
 *
 * RED phase: ReceiptScreen.tsx does not yet exist; import fails.
 *
 * Project convention (no @testing-library/react installed): exercise the
 * source contract via grep-style file presence checks plus the Back-to-Sei
 * CTA handler at the function level.
 *
 * Invariants under test:
 *   1. Module exports a ReceiptScreen symbol.
 *   2. The charge line renders the TIER's exact amount (FTC 16 CFR §425.5
 *      plain-language charge acknowledgement).
 *   3. Source contains literal 'Billed monthly' (frequency).
 *   4. Source contains literal 'Cancel anytime in Settings → Cloud AI →
 *      Cancel subscription' (cancellation steps).
 *   5. Source contains literal 'Back to Sei' (primary CTA label).
 *   6. The source records why the dollar amount must render here.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = resolve(__dirname, 'ReceiptScreen.tsx');

// ipcClient.ts reads `window.sei` at module init; stub a minimal window so
// the import chain works during vitest's node environment.
beforeEach(() => {
  (globalThis as unknown as { window: unknown }).window = {
    sei: {},
  };
});

describe('ReceiptScreen', () => {
  it('Test 1: exports ReceiptScreen symbol', async () => {
    const mod = await import('./ReceiptScreen');
    expect(mod.ReceiptScreen).toBeDefined();
    expect(typeof mod.ReceiptScreen).toBe('function');
  });

  it('Test 2: the charge line renders the tier\'s exact amount', async () => {
    const source = readFileSync(SOURCE_PATH, 'utf-8');
    expect(source.includes('charged today')).toBe(true);
    // The amount comes from the plan catalog, so Quest and Party can never
    // acknowledge each other's charge.
    expect(source.includes('{card.chargeUsd')).toBe(true);
    const { planCard, PLANS } = await import('../lib/planCatalog');
    expect(planCard(PLANS, 'quest').chargeUsd).toBe('$8.00');
    expect(planCard(PLANS, 'party').chargeUsd).toBe('$18.00');
  });

  it('Test 3: source contains literal "Billed monthly"', () => {
    const source = readFileSync(SOURCE_PATH, 'utf-8');
    expect(source.includes('Billed monthly')).toBe(true);
  });

  it('Test 4: source contains cancellation-steps copy', () => {
    const source = readFileSync(SOURCE_PATH, 'utf-8');
    expect(source.includes('Cancel anytime in Settings')).toBe(true);
    expect(source.includes('Cloud AI')).toBe(true);
    expect(source.includes('Cancel subscription')).toBe(true);
  });

  it('Test 5: source contains "Back to Sei" CTA label', () => {
    const source = readFileSync(SOURCE_PATH, 'utf-8');
    expect(source.includes('Back to Sei')).toBe(true);
  });

  it('Test 6: the source records why the dollar amount must render here', () => {
    const source = readFileSync(SOURCE_PATH, 'utf-8');
    expect(source.includes('FTC 16 CFR §425.5')).toBe(true);
  });
});
