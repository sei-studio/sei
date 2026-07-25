/**
 * AutoRenewalConsentModal — quick/260525-sbo Task 3.
 *
 * Blocking-ish consent gate that mounts BEFORE every Polar subscription
 * purchase or tier change (the plan cards in CreditsScreen + HardStopModal).
 * The user must (a) check a checkbox whose label discloses the recurring
 * charge amount and frequency, and (b) click Continue — at which point the
 * renderer (1) records an immutable consent row via the record-consent Edge
 * Function and (2) either opens the Polar hosted checkout (a NEW subscription)
 * or asks the proxy to update the existing subscription (a tier CHANGE).
 *
 * Required by California Bus & Prof Code §17602(a)(1) (clear-and-conspicuous
 * pre-CTA disclosure) + §17602(b) (recordkeeping). Without this surface Sei
 * cannot legally onboard California-resident subscribers.
 *
 * This modal MUST render the literal per-month amount ($8/month for Quest,
 * $18/month for Party) for CA ARL §17602(a)(1) clear-and-conspicuous
 * compliance. Dollar amounts otherwise appear only on the plan cards and the
 * top up packages.
 *
 * Structural template: SignInModal.tsx (scrim + role="dialog" + aria-modal +
 * useId for titleId + ESC closes via window keydown listener).
 *
 * Modal-in-modal stacking: AutoRenewalConsentModal uses a scrim z-index of
 * 1100 so it stacks above HardStopModal's 1000 scrim (mirrors the
 * OAuthInterstitialModal sibling pattern from SignInModal:285-306).
 *
 * Source:
 *   - quick/260525-sbo Cluster F Task 3
 *   - SignInModal.tsx (structural template)
 *   - src/main/cloud/proxyClient.ts recordSubscriptionConsent (IPC backend)
 *   - src/shared/legalVersions.ts TOS_VERSION (consent_version source)
 */
import React, { useState } from 'react';
import type { PlanTier } from '@shared/ipc';
import { sei } from '../lib/ipcClient';
import { planCard, planName } from '../lib/planCatalog';
// Use relative import (not @shared alias) so vitest can resolve without
// extra config — the legacy tsconfig.web.json paths are not registered in
// vitest.config.ts.
import { TOS_VERSION } from '../../../shared/legalVersions';
import { Button } from './Button';
import { ModalShell, ModalFooter } from './ModalShell';
import { PreCtaDisclosure } from './PreCtaDisclosure';
import styles from './AutoRenewalConsentModal.module.css';

export interface AutoRenewalConsentModalProps {
  /** Which tier the user is agreeing to be charged for. */
  tier: Exclude<PlanTier, 'free'>;
  /**
   * 'checkout' (default) starts a NEW subscription through the hosted Polar
   * checkout. 'change' updates an EXISTING subscription to `tier` in place (no
   * browser hop); the consent record is required either way because the
   * recurring amount changes.
   */
  mode?: 'checkout' | 'change';
  /** Called on dismissal (ESC, Back CTA, or after Continue completes). */
  onClose: () => void;
  /**
   * Called AFTER consent is recorded and the purchase action has been started —
   * the parent uses this to begin the "complete your purchase" watch (high-freq
   * creditsGet polling). Fires only on the Continue path, not on Back/ESC
   * dismissal. Optional so non-watching callers can omit it.
   */
  onProceed?: () => void;
}

/**
 * Test-only handler export. Mirrors the pattern of exposing the pure data
 * flow without a React render tree (the project does not ship
 * @testing-library/react). Production code goes through the component's
 * onClick → handleConfirm closure; this exported function calls the same
 * sei.* IPC methods in the same order so the test asserts the order
 * invariant without rendering.
 *
 * The order is critical: record-consent MUST run before openCheckout
 * because if the user closes the browser before completing the LS flow we
 * still want the legal anchor on record. A failed record-consent does NOT
 * block the checkout — the user's affirmative checkbox click is the legal
 * anchor the renderer cannot lose; the server INSERT is the audit-trail
 * backstop. Log on failure so the operator can backfill if a dispute
 * requires it.
 */
export async function handleConfirmForTest(
  consentVersion: string,
  onProceed?: () => void,
  tier: Exclude<PlanTier, 'free'> = 'party',
): Promise<void> {
  const w = (globalThis as unknown as { window: { sei: typeof sei } }).window;
  try {
    const res = await w.sei.recordSubscriptionConsent({ consent_version: consentVersion });
    if (!res.ok) {
      console.warn(
        `[AutoRenewalConsentModal] record-consent returned not-ok: ${res.code} — proceeding to checkout anyway (legal anchor = affirmative click).`,
      );
    }
  } catch (err) {
    console.warn(
      `[AutoRenewalConsentModal] record-consent threw: ${(err as Error).message} — proceeding to checkout anyway.`,
    );
  }
  await w.sei.creditsOpenCheckout(tier);
  // Hand off to the parent's checkout watch AFTER the browser checkout opened.
  onProceed?.();
}

export function AutoRenewalConsentModal({
  tier,
  mode = 'checkout',
  onClose,
  onProceed,
}: AutoRenewalConsentModalProps): React.ReactElement {
  const [checked, setChecked] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const card = planCard(tier);
  // CA ARL §17602(a)(1): the amount in the affirmative-consent label is the
  // amount the consumer will actually be charged.
  const consentLabel = `I agree to be charged ${card.price}/month until I cancel.`;

  // ESC closes (non-blocking — the user CAN dismiss without consenting, in
  // which case no checkout opens), but is suppressed while submitting so we
  // don't drop an in-flight INSERT. ModalShell owns the listener.

  const handleConfirm = async (): Promise<void> => {
    if (!checked || submitting) return;
    setSubmitting(true);
    try {
      // Step 1: record the consent (best-effort — see handleConfirmForTest
      // docblock for the legal-anchor rationale).
      try {
        const res = await sei.recordSubscriptionConsent({ consent_version: TOS_VERSION });
        if (!res.ok) {
          console.warn(
            `[AutoRenewalConsentModal] record-consent returned not-ok: ${res.code} — proceeding to checkout anyway (legal anchor = affirmative click).`,
          );
        }
      } catch (err) {
        console.warn(
          `[AutoRenewalConsentModal] record-consent threw: ${(err as Error).message} — proceeding to checkout anyway.`,
        );
      }
      // Step 2: start the purchase. A new subscription opens the Polar hosted
      // checkout (the modal closes immediately so the user lands on the browser
      // tab without a stale scrim covering the app); a tier change is applied
      // by the proxy in place, with no browser hop.
      if (mode === 'change') {
        await sei.creditsChangePlan(tier);
      } else {
        await sei.creditsOpenCheckout(tier);
      }
      // Step 3: hand off to the parent's checkout watch (the browser is already
      // open, so it polls without re-opening). Fires only on this Continue path.
      onProceed?.();
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    // Stacked tier (1100) so it layers above HardStopModal's base scrim when the
    // consent gate fires from the hard-stop CTA path. ESC suppressed mid-submit.
    <ModalShell
      title="Confirm your subscription"
      width={440}
      tier="stacked"
      escClose={!submitting}
      onClose={onClose}
    >
      <p className={styles.body}>
        {planName(tier)} gives you {card.blurb}, refreshed every week. Polar handles
        secure checkout and payment.
      </p>

      {/*
       * CA ARL §17602(a)(1) clear-and-conspicuous pre-purchase disclosure
       * (price + frequency + auto-renew + cancellation method). This modal is
       * the actual "request for consent" surface, so the disclosure lives HERE
       * in visual proximity to the checkbox — the duplicate box that used to
       * sit on the CreditsScreen Party card was removed 260603. renewsAt=null:
       * a first-time subscriber has no renewal date yet, so PreCtaDisclosure
       * renders the "Auto-renews monthly until you cancel" fallback.
       */}
      <PreCtaDisclosure renewsAt={null} tier={tier} />

      {/*
       * The literal per-month amount MUST appear in the consent checkbox label
       * per CA ARL §17602(a)(1), and it must match the tier being purchased.
       */}
      <label className={styles.checkboxRow}>
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => setChecked(e.target.checked)}
          aria-label={consentLabel}
        />
        <span>{consentLabel}</span>
      </label>

      <ModalFooter>
        <Button kind="quiet" size="md" onClick={onClose} disabled={submitting}>
          Back
        </Button>
        <Button
          kind="primary"
          size="md"
          onClick={() => void handleConfirm()}
          disabled={!checked || submitting}
        >
          {submitting
            ? mode === 'change'
              ? 'Updating your plan…'
              : 'Opening in your browser…'
            : mode === 'change'
              ? 'Confirm plan change'
              : 'Continue to checkout'}
        </Button>
      </ModalFooter>
    </ModalShell>
  );
}
