/**
 * HardStopModal — weekly-limit popup (260724).
 *
 * Mounted at the App root when `useCreditsStore.hardStopActive === true`. The
 * main process fires `credits:hard-stop` and `useCreditsStore.onCreditsHardStop`
 * flips `hardStopActive`, gating this popup. Two trigger paths, both surfaced
 * here with the SAME copy:
 *   - pre-flight summon gate (botSupervisor → cloudOverLimit): you tried to
 *     summon while over the limit, so the bot never joined.
 *   - mid-session 402 (orchestrator latches + tears down, botSupervisor relays
 *     CLOUD_CREDITS_DEPLETED → emitHardStop): the running bot spent the last of
 *     the weekly allowance and quietly left the world.
 *
 * Single state (the SPEC's "one modal") with exactly two CTAs:
 *   - "Upgrade" → dismiss + navigate to the plan screen. Dismiss FIRST: this
 *     modal renders at the App root over every screen, so leaving
 *     `hardStopActive` set would keep it covering that page.
 *   - "Top up"  → the same navigation, with `requestTopUp()` so the plan screen
 *     opens the packages on arrival. The purchase then runs where the checkout
 *     watcher lives, instead of polling behind a popup with no progress UI.
 * Close and ESC dismiss it: the bot has already left or was never summoned, so
 * this is a notice, not a blocking gate.
 *
 * Auto-dismiss is gated on `!over_limit` — a top up or an upgrade reset clears
 * the limit server-side, the next snapshot reports it, and the popup closes on
 * its own.
 *
 * Sources: SPEC §5.B, AcceptToSModal.tsx (structural template),
 *          useCreditsStore.ts (hardStopActive / acknowledgeHardStop wire).
 */

import React, { useEffect } from 'react';
import { useCreditsStore } from '../lib/stores/useCreditsStore';
import { useUiStore } from '../lib/stores/useUiStore';
import { Button } from './Button';
import { ModalShell, ModalFooter } from './ModalShell';
import { formatRenewal } from '../lib/formatRenewal';
import styles from './HardStopModal.module.css';

export function HardStopModal(): React.ReactElement | null {
  const hardStopActive = useCreditsStore((s) => s.hardStopActive);
  const overLimit = useCreditsStore((s) => s.over_limit);
  const resetsAt = useCreditsStore((s) => s.resets_at);
  const acknowledgeHardStop = useCreditsStore((s) => s.acknowledgeHardStop);
  const requestTopUp = useCreditsStore((s) => s.requestTopUp);
  const navigate = useUiStore((s) => s.navigate);

  // ESC dismissal is owned by ModalShell (escClose default true → onClose).

  // Auto-dismiss once the account is no longer over its limit (a top up, an
  // upgrade reset, or the weekly rollover).
  useEffect(() => {
    if (hardStopActive && !overLimit) acknowledgeHardStop();
  }, [hardStopActive, overLimit, acknowledgeHardStop]);

  if (!hardStopActive) return null;

  // Dismiss the popup THEN route to the plan screen — otherwise this modal
  // (mounted at the App root) would keep covering it.
  const handleUpgrade = (): void => {
    acknowledgeHardStop();
    navigate({ kind: 'credits' });
  };

  // Same destination, but the plan screen opens the packages on arrival.
  const handleTopUp = (): void => {
    requestTopUp();
    acknowledgeHardStop();
    navigate({ kind: 'credits' });
  };

  const resetsText = formatRenewal(resetsAt);

  return (
    // Click-outside intentionally does NOT dismiss (scrimClose omitted) — Close,
    // the CTAs, and ESC are the deliberate dismiss paths. Base tier: the consent
    // gate and the top up modal stack above this at 1100.
    <ModalShell title="You've used this week's credits" width={440} onClose={acknowledgeHardStop}>
      <p className={styles.body}>
        {resetsText
          ? `Your credits refresh ${resetsText}. Upgrade for a bigger weekly allowance, or top up to keep playing now.`
          : 'Upgrade for a bigger weekly allowance, or top up to keep playing now.'}
      </p>
      <ModalFooter>
        <Button kind="quiet" size="md" onClick={acknowledgeHardStop}>
          Close
        </Button>
        <Button kind="ghost" size="md" onClick={handleTopUp}>
          Top up
        </Button>
        <Button kind="accent" size="md" onClick={handleUpgrade}>
          Upgrade
        </Button>
      </ModalFooter>
    </ModalShell>
  );
}
