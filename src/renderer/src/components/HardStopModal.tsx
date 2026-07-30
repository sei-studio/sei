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
 * 260725 — TWO reasons, two presentations. `reason: 'rate_limited'`
 * (botSupervisor relays the proxy's IP / abuse gate as DAILY_LIMIT_REACHED and
 * drains the bot) is a TIME window, not a balance: it spends no credits and no
 * billing action can clear it, so that branch gets its own copy, the retry
 * time from `rateLimitedUntil`, a single Close, and full immunity from the
 * over_limit auto-dismiss below.
 *
 * 260725 — auto-dismiss freshness. A hard-stop push carries no usage snapshot
 * and nothing else refetches one, so `over_limit` in the store is whatever the
 * last poll left behind (normally false). The old `if (hardStopActive &&
 * !overLimit) acknowledge()` therefore unmounted the popup on its FIRST effect
 * run: the companion left the world with no explanation and re-summoning
 * looked like a no-op (the pre-flight gate refuses, the popup flashes away
 * again). Now the modal pulls a fresh snapshot when a stop arrives, LATCHES the
 * confirmed limit, and only auto-dismisses when that confirmed limit clears (a
 * top up, an upgrade reset, or the weekly rollover).
 *
 * Sources: SPEC §5.B, AcceptToSModal.tsx (structural template),
 *          useCreditsStore.ts (hardStopActive / acknowledgeHardStop wire).
 */

import React, { useEffect, useState } from 'react';
import { useCreditsStore } from '../lib/stores/useCreditsStore';
import { useUiStore } from '../lib/stores/useUiStore';
import { Button } from './Button';
import { ModalShell, ModalFooter } from './ModalShell';
import { formatRenewal } from '../lib/formatRenewal';
import styles from './HardStopModal.module.css';

/**
 * When a rate-limit window ends: "9:30 PM" for later today, "Tuesday at
 * 9:30 AM" otherwise. Empty string when there is no usable window (null, or
 * already elapsed) so the copy drops the clause instead of inventing a time.
 * Exported for the unit test.
 */
export function formatRetryWhen(untilMs: number | null, nowMs: number): string {
  if (!untilMs || untilMs <= nowMs) return '';
  const until = new Date(untilMs);
  const time = until.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (until.toDateString() === new Date(nowMs).toDateString()) return time;
  return `${until.toLocaleDateString([], { weekday: 'long' })} at ${time}`;
}

export function HardStopModal(): React.ReactElement | null {
  const hardStopActive = useCreditsStore((s) => s.hardStopActive);
  const hardStopReason = useCreditsStore((s) => s.hardStopReason);
  const overLimit = useCreditsStore((s) => s.over_limit);
  const resetsAt = useCreditsStore((s) => s.resets_at);
  const rateLimitedUntil = useCreditsStore((s) => s.rateLimitedUntil);
  const snapshotFailed = useCreditsStore((s) => s.snapshotFailed);
  const refresh = useCreditsStore((s) => s.refresh);
  const acknowledgeHardStop = useCreditsStore((s) => s.acknowledgeHardStop);
  const requestTopUp = useCreditsStore((s) => s.requestTopUp);
  const navigate = useUiStore((s) => s.navigate);

  // A rate limit is a time window: no billing change clears it, so it never
  // takes part in the over_limit refresh/latch/auto-dismiss machinery below.
  const isRateLimited = hardStopReason === 'rate_limited';

  // ESC dismissal is owned by ModalShell (escClose default true → onClose).

  // The push tells us a limit was hit but ships no numbers. Pull the snapshot
  // that the auto-dismiss below is allowed to trust. refresh() never rejects
  // (it swallows its own failure into snapshotFailed).
  const [snapshotFresh, setSnapshotFresh] = useState(false);
  useEffect(() => {
    if (!hardStopActive || isRateLimited) {
      setSnapshotFresh(false);
      return;
    }
    let cancelled = false;
    void refresh().then(() => {
      if (!cancelled) setSnapshotFresh(true);
    });
    return () => {
      cancelled = true;
    };
  }, [hardStopActive, isRateLimited, refresh]);

  // Latch the limit once a FRESH snapshot confirms it. Only a confirmed limit
  // can later "clear" — a stale or failed snapshot can never dismiss the popup.
  const [confirmedOverLimit, setConfirmedOverLimit] = useState(false);
  useEffect(() => {
    if (!hardStopActive) {
      setConfirmedOverLimit(false);
      return;
    }
    if (snapshotFresh && !snapshotFailed && overLimit) setConfirmedOverLimit(true);
  }, [hardStopActive, snapshotFresh, snapshotFailed, overLimit]);

  // Auto-dismiss once that confirmed limit is gone (top up, upgrade reset, or
  // the weekly rollover reported by a later poll or push).
  useEffect(() => {
    if (!hardStopActive || isRateLimited) return;
    if (confirmedOverLimit && !overLimit && !snapshotFailed) acknowledgeHardStop();
  }, [
    hardStopActive,
    isRateLimited,
    confirmedOverLimit,
    overLimit,
    snapshotFailed,
    acknowledgeHardStop,
  ]);

  if (!hardStopActive) return null;

  if (isRateLimited) {
    // The proxy's abuse / IP gate tripped. Nothing was spent and nothing is
    // persisted, so there is no purchase that would help: honest copy, the
    // retry time, and a single Close. No billing CTAs.
    const retryWhen = formatRetryWhen(rateLimitedUntil, Date.now());
    return (
      <ModalShell title="Too many requests" width={440} onClose={acknowledgeHardStop}>
        <p className={styles.body}>
          {retryWhen
            ? `Sei's servers are limiting requests right now, so your companion has to sit this one out. This does not use up any of your credits. You can try again after ${retryWhen}.`
            : "Sei's servers are limiting requests right now, so your companion has to sit this one out. This does not use up any of your credits. You can try again in a little while."}
        </p>
        <ModalFooter>
          <Button kind="primary" size="md" onClick={acknowledgeHardStop}>
            Close
          </Button>
        </ModalFooter>
      </ModalShell>
    );
  }

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
    <ModalShell title="Usage limit reached" width={440} onClose={acknowledgeHardStop}>
      <p className={styles.body}>
        {resetsText
          ? `You've used this week's allowance. It refreshes ${resetsText}. Upgrade for a bigger weekly allowance, or top up to keep playing now.`
          : "You've used this week's allowance. Upgrade for a bigger weekly allowance, or top up to keep playing now."}
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
