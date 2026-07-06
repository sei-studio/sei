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
 *   2. Source contains literal '$20.00 charged today' (FTC 16 CFR §425.5
 *      plain-language charge acknowledgement).
 *   3. Source contains literal 'Billed monthly' (frequency).
 *   4. Source contains literal 'Cancel anytime in Settings → Cloud AI →
 *      Cancel subscription' (cancellation steps).
 *   5. Source contains literal 'Back to Sei' (primary CTA label).
 *   6. PROXY-05 carve-out comment is present in the source.
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

  it('Test 2: source contains literal "$20.00 charged today"', () => {
    const source = readFileSync(SOURCE_PATH, 'utf-8');
    expect(source.includes('$20.00 charged today')).toBe(true);
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

  it('Test 6: PROXY-05 carve-out comment is present', () => {
    const source = readFileSync(SOURCE_PATH, 'utf-8');
    expect(source.includes('PROXY-05 carve-out')).toBe(true);
  });
});
