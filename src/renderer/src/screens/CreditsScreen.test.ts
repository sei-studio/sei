/**
 * Tests for CreditsScreen — the in-place tier-change path (260725 regression
 * fixes).
 *
 * Project convention (no @testing-library/react installed): exercise the
 * source contract via grep-style file presence checks. Mirrors
 * src/renderer/src/screens/SettingsScreen.test.tsx.
 *
 * Invariants:
 *   C.1 — an existing subscriber's plan click opens an in-app confirmation
 *         instead of firing changePlan() straight away. The hosted Polar page
 *         carries the recurring terms only for a FIRST subscription; an
 *         in-place change never opens a browser page.
 *   C.2 — the confirmation discloses the recurring amount, the cadence, the
 *         card on file / proration, and how to cancel.
 *   C.3 — beginPurchase() snapshots its baseline BEFORE changePlan() runs.
 *         changePlan() refreshes internally, so the old order made the
 *         baseline equal the post-change state and isPurchaseConfirmed could
 *         never fire: every successful change ended in the watcher's timeout.
 *   C.4 — a rejected change stops the watch and says so, instead of timing out.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, 'CreditsScreen.tsx'), 'utf-8');

describe('CreditsScreen (in-place plan change)', () => {
  it('C.1: a subscriber click opens the confirmation, it does not change the plan', () => {
    expect(SRC.includes('PlanChangeConfirmModal')).toBe(true);
    expect(SRC.includes('setPendingChange(tier)')).toBe(true);
    // The one-click regression: changePlan awaited straight out of the picker.
    const select = SRC.slice(
      SRC.indexOf('const handlePlanSelect'),
      SRC.indexOf('// Confirmed in PlanChangeConfirmModal'),
    );
    expect(select.length).toBeGreaterThan(0);
    expect(select.includes('changePlan(')).toBe(false);
  });

  it('C.2: the confirmation discloses amount, cadence, the stored card and cancellation', () => {
    const modal = SRC.slice(SRC.indexOf('function PlanChangeConfirmModal'));
    expect(modal.includes('per month')).toBe(true);
    expect(modal.includes('renews automatically')).toBe(true);
    expect(modal.includes('card on file')).toBe(true);
    expect(modal.includes('cancel anytime')).toBe(true);
    // The amount comes from the (server-driven) catalog, not a literal.
    expect(modal.includes('card.chargeUsd')).toBe(true);
  });

  it('C.3: beginPurchase snapshots the baseline BEFORE changePlan runs', () => {
    const confirm = SRC.slice(
      SRC.indexOf('const handleConfirmChange'),
      SRC.indexOf('const handleResume'),
    );
    const begin = confirm.indexOf('beginPurchase(tier');
    const change = confirm.indexOf('changePlan(tier)');
    expect(begin).toBeGreaterThan(-1);
    expect(change).toBeGreaterThan(-1);
    expect(begin).toBeLessThan(change);
    // No browser hop for an in-place change.
    expect(confirm.includes('alreadyOpened: true')).toBe(true);
  });

  it('C.4: a rejected change stops the watch and surfaces a reason', () => {
    expect(SRC.includes('dismissCheckout();')).toBe(true);
    expect(SRC.includes('setChangeError(changeErrorCopy(res.code))')).toBe(true);
    expect(SRC.includes('function changeErrorCopy')).toBe(true);
  });

  it('C.5: the watch modal does not send an in-place change to the browser', () => {
    expect(SRC.includes('inPlace')).toBe(true);
    expect(SRC.includes('Updating your plan')).toBe(true);
  });

  it('C.6: no em dash in the confirmation body copy', () => {
    const body = SRC.slice(
      SRC.indexOf('<div className={styles.confirmBody}>'),
      SRC.indexOf('<ModalFooter>', SRC.indexOf('<div className={styles.confirmBody}>')),
    );
    expect(body.length).toBeGreaterThan(0);
    expect(body.includes('—')).toBe(false);
  });
});
