/**
 * HardStopModal — PROXY-06 out-of-credits / rate-limited blocking modal.
 *
 * Mounted at the App root when `useCreditsStore.hardStopActive === true`.
 * The proxy fires `credits:hardStop` with reason ∈ {'depleted', 'rate_limited'}
 * after a 402/429; `useCreditsStore.onCreditsHardStop` sets `hardStopActive`,
 * which gates this modal's render.
 *
 * Simplified surface (260605): the modal says only "You're out of playtime" and
 * offers exactly TWO actions —
 *   - "Charge playtime" → dismiss + navigate to the Playtime (Credits) screen,
 *     where the Trial / Quest / Party plan cards live. Dismissing first is
 *     required: the modal renders at the App root over every screen, so leaving
 *     `hardStopActive` set would keep it covering the Playtime page.
 *   - "Use my own API key" → open the BYOK setup prompt (ApiKeySetupModal):
 *     pick a provider, paste a key, switch the AI backend to local. The switch
 *     only commits once the key is saved (see ApiKeySetupModal), so a cancel
 *     leaves the user on cloud-proxy, still hard-stopped.
 *
 * The prior persona-aware body copy, the CA ARL §17602(a)(1) pre-CTA price
 * disclosure, and the "Join a Party" subscription CTA were removed here: this
 * modal no longer initiates a subscription purchase, so the disclosure/consent
 * gate is not required on this surface. Subscribing now happens on the Playtime
 * screen, which keeps its own AutoRenewalConsentModal (disclosure + consent).
 *
 * ESC suppressed unconditionally — blocking gate (mirrors AcceptToSModal:54-62).
 *
 * Auto-dismiss is gated on `hardStopReason === 'depleted'` only — rate-limited
 * hard-stops require an explicit retry-window expiry (handled by 13-17's
 * rate-limit banner, not this modal).
 *
 * T-13-19-04 (DoS — modal blocks permanently if proxyConfigure fails):
 *   the BYOK switch is owned by ApiKeySetupModal, which only flips the backend
 *   AFTER the key save succeeds and surfaces an inline error (keeping itself
 *   mounted) on failure — the hard-stop modal underneath is never left in a
 *   permanently-blocked state. "Charge playtime" remains reachable regardless.
 *
 * Sources: 13-19-PLAN.md, AcceptToSModal.tsx (structural template),
 *          useCreditsStore.ts (hardStopActive / acknowledgeHardStop wire).
 */

import React, { useEffect, useId, useState } from 'react';
import { useCreditsStore } from '../lib/stores/useCreditsStore';
import { useUiStore } from '../lib/stores/useUiStore';
import { Button } from './Button';
import { ApiKeySetupModal } from './ApiKeySetupModal';
import styles from './HardStopModal.module.css';

export function HardStopModal(): React.ReactElement | null {
  const hardStopActive = useCreditsStore((s) => s.hardStopActive);
  const hardStopReason = useCreditsStore((s) => s.hardStopReason);
  const remainingPct = useCreditsStore((s) => s.remaining_pct);
  const acknowledgeHardStop = useCreditsStore((s) => s.acknowledgeHardStop);
  const navigate = useUiStore((s) => s.navigate);
  const titleId = useId();
  // BYOK setup overlay (sibling, z-index 1100 — stacks above this modal's 1000).
  const [showApiKeySetup, setShowApiKeySetup] = useState(false);

  // ESC suppression — unconditional. Verbatim port of AcceptToSModal:54-62.
  // The handler is mounted/unmounted with the modal so we don't leak a
  // global keydown listener when the modal isn't visible.
  useEffect(() => {
    if (!hardStopActive) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hardStopActive]);

  // Auto-dismiss on balance refill. Gated on reason==='depleted' so a
  // rate-limited hard-stop doesn't clear just because the balance is
  // non-zero (the user still can't call until the retry window expires).
  useEffect(() => {
    if (hardStopActive && hardStopReason === 'depleted' && remainingPct > 0) {
      acknowledgeHardStop();
    }
  }, [hardStopActive, hardStopReason, remainingPct, acknowledgeHardStop]);

  if (!hardStopActive) return null;

  // Dismiss the blocking modal THEN route to Playtime — otherwise this modal
  // (mounted at the App root) would keep covering the Credits screen.
  const handleChargePlaytime = (): void => {
    acknowledgeHardStop();
    navigate({ kind: 'credits' });
  };

  return (
    // Click-outside suppressed — no onClick on scrim (blocking modal,
    // mirrors AcceptToSModal).
    <>
      <div className={styles.scrim} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className={styles.modal}>
          <h2 id={titleId} className={styles.title}>
            You&rsquo;re out of playtime
          </h2>
          <div className={styles.footer}>
            <Button kind="accent" onClick={handleChargePlaytime}>
              Charge playtime
            </Button>
            <Button
              kind="ghost"
              className={styles.muted}
              onClick={() => setShowApiKeySetup(true)}
            >
              Use my own API key
            </Button>
          </div>
        </div>
      </div>
      {showApiKeySetup ? (
        <ApiKeySetupModal
          onCancel={() => setShowApiKeySetup(false)}
          onComplete={() => {
            // Provider + key saved, backend switched to local. Clear the
            // hard-stop and land on home so the user can re-summon.
            setShowApiKeySetup(false);
            acknowledgeHardStop();
            navigate({ kind: 'home' });
          }}
        />
      ) : null}
    </>
  );
}
