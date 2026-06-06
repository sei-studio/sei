/**
 * AutoRenewalConsentModal — quick/260525-sbo Task 3.
 *
 * Blocking-ish consent gate that mounts BEFORE every Polar subscription
 * checkout (Party tile in CreditsScreen + HardStopModal). The user must (a)
 * check a checkbox whose label discloses the recurring charge amount and
 * frequency, and (b) click "Continue to checkout" — at which point the
 * renderer (1) records an immutable consent row via the record-consent Edge
 * Function and (2) opens the Polar hosted checkout.
 *
 * Required by California Bus & Prof Code §17602(a)(1) (clear-and-conspicuous
 * pre-CTA disclosure) + §17602(b) (recordkeeping). Without this surface Sei
 * cannot legally onboard California-resident subscribers.
 *
 * PROXY-05 carve-out: this modal MUST render the literal "$20/month" string
 * for CA ARL §17602(a)(1) clear-and-conspicuous compliance. The PROXY-05
 * invariant ("no dollar amounts in renderer") is suspended for the
 * at-purchase legal-disclosure surface only — all other UI surfaces
 * (Playtime pill, plan labels, hard-stop copy) remain dollar-free.
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
import React, { useEffect, useId, useState } from 'react';
import { sei } from '../lib/ipcClient';
// Use relative import (not @shared alias) so vitest can resolve without
// extra config — the legacy tsconfig.web.json paths are not registered in
// vitest.config.ts.
import { TOS_VERSION } from '../../../shared/legalVersions';
import { Button } from './Button';
import { PreCtaDisclosure } from './PreCtaDisclosure';
import styles from './AutoRenewalConsentModal.module.css';

export interface AutoRenewalConsentModalProps {
  /** Called on dismissal (ESC, Back CTA, or after Continue completes). */
  onClose: () => void;
  /**
   * Called AFTER consent is recorded and the hosted checkout has been opened in
   * the browser — the parent uses this to start the "complete your purchase"
   * watch (high-freq creditsGet polling). Fires only on the Continue path, not
   * on Back/ESC dismissal. Optional so non-watching callers can omit it.
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
  await w.sei.creditsOpenCheckout('subscription');
  // Hand off to the parent's checkout watch AFTER the browser checkout opened.
  onProceed?.();
}

export function AutoRenewalConsentModal({
  onClose,
  onProceed,
}: AutoRenewalConsentModalProps): React.ReactElement {
  const [checked, setChecked] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const titleId = useId();

  // ESC closes (non-blocking — the user CAN dismiss without consenting, in
  // which case no checkout opens). Mirrors SignInModal:74-81. ESC is
  // suppressed while submitting so we don't drop an in-flight INSERT.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !submitting) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, submitting]);

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
      // Step 2: open the LS hosted checkout. Modal closes immediately so the
      // user lands on the browser tab without a stale scrim covering the app.
      await sei.creditsOpenCheckout('subscription');
      // Step 3: hand off to the parent's checkout watch (the browser is already
      // open, so it polls without re-opening). Fires only on this Continue path.
      onProceed?.();
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={styles.scrim} role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className={styles.modal}>
        <h2 id={titleId} className={styles.title}>
          Confirm your subscription
        </h2>
        <p className={styles.body}>
          Party gives you heavier daily playtime that recharges every billing cycle. Polar
          handles secure checkout and payment.
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
        <PreCtaDisclosure renewsAt={null} />

        {/*
         * PROXY-05 carve-out (quick/260525-sbo Task 3): the literal "$20/month"
         * string MUST appear in the consent checkbox label per CA ARL
         * §17602(a)(1). The PROXY-05 bright-line ("no dollar amounts in
         * renderer") is suspended for the at-purchase legal-disclosure surface
         * only.
         */}
        <label className={styles.checkboxRow}>
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
            aria-label="I agree to be charged $20/month until I cancel"
          />
          <span>I agree to be charged $20/month until I cancel.</span>
        </label>

        <div className={styles.footer}>
          <Button kind="quiet" size="md" onClick={onClose} disabled={submitting}>
            Back
          </Button>
          <Button
            kind="primary"
            size="md"
            onClick={() => void handleConfirm()}
            disabled={!checked || submitting}
          >
            {submitting ? 'Opening in your browser…' : 'Continue to checkout'}
          </Button>
        </div>
      </div>
    </div>
  );
}
