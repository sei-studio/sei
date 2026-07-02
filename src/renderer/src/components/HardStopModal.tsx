/**
 * HardStopModal — out-of-playtime popup (PROXY-06, simplified 260616).
 *
 * Mounted at the App root when `useCreditsStore.hardStopActive === true`. The
 * main process fires `credits:hard-stop` (reason ∈ {'depleted','rate_limited'})
 * and `useCreditsStore.onCreditsHardStop` flips `hardStopActive`, gating this
 * popup. Two trigger paths, both surfaced here:
 *   - pre-flight summon gate (botSupervisor → cloudCreditsDepleted): you tried
 *     to summon while below the playable minimum, so the bot never joined.
 *   - mid-session 402 (orchestrator latches + tears down, botSupervisor relays
 *     CLOUD_CREDITS_DEPLETED → emitHardStop): the running bot drew its balance
 *     below the playable minimum and quietly left the world.
 *
 * Dismissable informational popup with exactly two actions (owner spec 260616):
 *   - "Recharge" → dismiss + navigate to the Playtime (Credits) screen. Dismiss
 *     FIRST: this modal renders at the App root over every screen, so leaving
 *     `hardStopActive` set would keep it covering the Playtime page.
 *   - "Close"    → dismiss (acknowledgeHardStop). The bot has already left / was
 *     never summoned, so this is a notice, not a blocking gate — ESC and Close
 *     both dismiss it.
 *
 * BYOK ("Use my own API key") is no longer offered on this surface — it stays
 * reachable from Settings.
 *
 * Auto-dismiss is gated on `hardStopReason === 'depleted'` + `remaining_pct > 0`
 * — a top-up raises the balance above the playable minimum (MIN_PLAYABLE_-
 * BALANCE_MICRO in proxyClient), which rounds remaining_pct above 0 and clears
 * the popup. rate_limited hard-stops never auto-clear on balance.
 *
 * Sources: 13-19-PLAN.md, AcceptToSModal.tsx (structural template),
 *          useCreditsStore.ts (hardStopActive / acknowledgeHardStop wire).
 */

import React, { useEffect, useId } from 'react';
import { useCreditsStore } from '../lib/stores/useCreditsStore';
import { useUiStore } from '../lib/stores/useUiStore';
import { Button } from './Button';
import styles from './HardStopModal.module.css';

/** "Come back after 9:30 PM" / "Come back Tuesday after 2:00 AM" for the daily-limit copy. */
function formatResetWhen(untilMs: number | null): string {
  if (!untilMs || untilMs <= Date.now()) return 'Come back soon';
  const until = new Date(untilMs);
  const time = until.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const sameDay = until.toDateString() === new Date().toDateString();
  if (sameDay) return `Come back after ${time}`;
  return `Come back ${until.toLocaleDateString([], { weekday: 'long' })} after ${time}`;
}

export function HardStopModal(): React.ReactElement | null {
  const hardStopActive = useCreditsStore((s) => s.hardStopActive);
  const hardStopReason = useCreditsStore((s) => s.hardStopReason);
  const remainingPct = useCreditsStore((s) => s.remaining_pct);
  const rateLimitedUntil = useCreditsStore((s) => s.rateLimitedUntil);
  const acknowledgeHardStop = useCreditsStore((s) => s.acknowledgeHardStop);
  const navigate = useUiStore((s) => s.navigate);
  const titleId = useId();

  // ESC dismisses the popup (informational notice, not a blocking gate). The
  // handler mounts/unmounts with the modal so we never leak a global keydown
  // listener while it's hidden.
  useEffect(() => {
    if (!hardStopActive) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        acknowledgeHardStop();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hardStopActive, acknowledgeHardStop]);

  // Auto-dismiss on balance refill. Gated on reason==='depleted' so a
  // rate-limited hard-stop doesn't clear just because the balance is non-zero
  // (the user still can't call until the retry window expires).
  useEffect(() => {
    if (hardStopActive && hardStopReason === 'depleted' && remainingPct > 0) {
      acknowledgeHardStop();
    }
  }, [hardStopActive, hardStopReason, remainingPct, acknowledgeHardStop]);

  if (!hardStopActive) return null;

  // 'rate_limited' is the daily non-subscriber play cap ($5/day): different copy
  // + a reset time + a Party-upgrade CTA. 'depleted' is the out-of-credits case.
  const isDaily = hardStopReason === 'rate_limited';

  // Dismiss the popup THEN route to Playtime — otherwise this modal (mounted at
  // the App root) would keep covering the Credits screen. Both CTAs land on the
  // Playtime/Credits screen (where the Party plan + top-ups live).
  const handlePrimary = (): void => {
    acknowledgeHardStop();
    navigate({ kind: 'credits' });
  };

  return (
    // Click-outside intentionally does NOT dismiss (no onClick on scrim) — Close,
    // the primary CTA, and ESC are the deliberate dismiss paths.
    <div className={styles.scrim} role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className={styles.modal}>
        <h2 id={titleId} className={styles.title}>
          {isDaily ? 'Daily limit reached' : <>You&rsquo;re out of playtime</>}
        </h2>
        <p className={styles.body}>
          {isDaily
            ? `Sorry — we don't have many servers this early, so daily play is limited for non-subscribers. ${formatResetWhen(rateLimitedUntil)}, or upgrade to a Party plan to keep playing.`
            : 'Sei has run out of cloud credits. Recharge to keep playing.'}
        </p>
        <div className={styles.footer}>
          <Button kind="accent" onClick={handlePrimary}>
            {isDaily ? 'Upgrade to Party' : 'Recharge'}
          </Button>
          <Button kind="ghost" className={styles.muted} onClick={acknowledgeHardStop}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}
