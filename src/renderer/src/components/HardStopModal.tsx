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
 * 261103: ONE CTA (Shawn: two buttons to the same page read as if topping up
 * beat upgrading). Free and Quest get "Upgrade"; Party, which has no tier
 * above it, gets "Top up". The copy no longer pitches either.
 * Close and ESC dismiss it: the bot has already left or was never summoned, so
 * this is a notice, not a blocking gate. 261023: the two CTAs are full-width
 * PlanButtons under the copy (Upgrade the loud one); Close stays in the footer.
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
 * 261103 (T307) — "Keep playing free". A week is a long wait for a free
 * player who hits the wall on their first day, so a free player at the wall
 * now also gets two ways to keep playing on an account of their own, under
 * an "or" below Upgrade (wallFreeOptions), own key first, ChatGPT last:
 *   - "Use your ChatGPT plan": the startup popup's chatgpt-plan flow
 *     (startChatgptPlan, lib/popupActions.ts): Settings at the ChatGPT plan
 *     row, then the sign-in or the switch that row's own button would run.
 *     Hidden when the plan is already the provider in use. Never hidden by
 *     region: like the Settings row, the provider decides (Shawn, 261103).
 *   - "Use your own API key or a local model": Settings at the AI Backend row
 *     (view.focus 'ai-backend').
 * Both dismiss the popup FIRST, like Upgrade, then navigate.
 *
 * Sources: SPEC §5.B, AcceptToSModal.tsx (structural template),
 *          useCreditsStore.ts (hardStopActive / acknowledgeHardStop wire).
 */

import React, { useEffect, useState } from 'react';
import { t as tr, uiLocale, useT } from '../lib/i18n';
import { useCreditsStore } from '../lib/stores/useCreditsStore';
import { useUiStore } from '../lib/stores/useUiStore';
import type { PlanTier } from '@shared/ipc';
import { startChatgptPlan } from '../lib/popupActions';
import { Button } from './Button';
import { ChatgptLogo } from './ChatgptLogo';
import { KeyIcon } from './icons';
import { ModalShell, ModalFooter } from './ModalShell';
import { PlanButton } from './PlanButton';
import { useResetLine } from '../lib/useResetLine';
import { sei } from '../lib/ipcClient';
import styles from './HardStopModal.module.css';

/**
 * Below this window the retry time is presented as "in a moment" instead of a
 * clock time (260810). A short window is usually a guess: a 429 with no
 * Retry-After gets a 60s fallback in usageLimit.ts while Cloudflare's actual
 * flood-guard window is 10 seconds, and a wall-clock stamp ("9:31 PM") lends
 * that number a precision it does not have.
 */
const RETRY_TIME_MIN_MS = 5 * 60_000;

/**
 * When a rate-limit window ends: "9:30 PM" for later today, "Tuesday at
 * 9:30 AM" otherwise. Empty string when there is no usable window (null,
 * already elapsed, or too short to be worth a clock time — see
 * RETRY_TIME_MIN_MS) so the copy uses the "in a moment" clause instead of
 * inventing a time. Exported for the unit test.
 */
export function formatRetryWhen(untilMs: number | null, nowMs: number): string {
  if (!untilMs || untilMs - nowMs < RETRY_TIME_MIN_MS) return '';
  const until = new Date(untilMs);
  const time = until.toLocaleTimeString(uiLocale(), { hour: 'numeric', minute: '2-digit' });
  if (until.toDateString() === new Date(nowMs).toDateString()) return time;
  return tr('{weekday} at {time}', {
    weekday: until.toLocaleDateString(uiLocale(), { weekday: 'long' }),
    time,
  });
}

/**
 * 261005: what the player did at the wall (`credit_wall_action`). The wall
 * itself is `credit_wall_hit`, fired in main; this is the other half of the
 * funnel (close vs top up vs upgrade, and since 261103 the two free options:
 * 'chatgpt' and 'own_key'). Shape only. Never throws.
 */
export type WallAction = 'close' | 'topup' | 'upgrade' | 'chatgpt' | 'own_key';

function trackWallAction(action: WallAction, reason: string | null, openedAt: number): void {
  try {
    sei.track('credit_wall_action', {
      action,
      reason: reason ?? 'unknown',
      ms_open: Math.max(0, Date.now() - openedAt),
    });
  } catch {
    /* analytics is never load-bearing */
  }
}

/** Which "Keep playing free" options the popup shows (261103). */
export interface WallFreeOptions {
  chatgpt: boolean;
  ownKey: boolean;
}

/**
 * Pure: the free options for this wall. Only a free plan at the credit wall
 * gets them (a rate limit is not a balance, and a subscriber's wall keeps its
 * plain Top up / Upgrade). The ChatGPT option is left out when the plan is
 * already the provider in use (`llmProvider === 'chatgpt'`).
 */
export function wallFreeOptions(input: {
  reason: string | null;
  plan: PlanTier;
  llmProvider: string | null;
}): WallFreeOptions {
  const freeWall = input.reason !== 'rate_limited' && input.plan === 'free';
  return {
    chatgpt: freeWall && input.llmProvider !== 'chatgpt',
    ownKey: freeWall,
  };
}

/**
 * A "Keep playing free" click: track it, dismiss the popup (it would cover
 * Settings otherwise), then route. 'chatgpt' runs the same flow as the
 * startup popup's chatgpt-plan action; 'own_key' opens Settings at the AI
 * Backend row. Exported for the unit test.
 */
export function takeWallFreeOption(option: 'chatgpt' | 'own_key', reason: string | null, openedAt: number): void {
  trackWallAction(option, reason, openedAt);
  useCreditsStore.getState().acknowledgeHardStop();
  if (option === 'chatgpt') {
    // Another chatgpt-plan run still in flight (a popup click a moment ago):
    // this one does nothing, so at least land on the row it is using.
    void startChatgptPlan().then((ran) => {
      if (!ran) useUiStore.getState().navigate({ kind: 'settings', focus: 'chatgpt-plan' });
    });
  } else {
    useUiStore.getState().navigate({ kind: 'settings', focus: 'ai-backend' });
  }
}

export function HardStopModal(): React.ReactElement | null {
  const t = useT();
  const hardStopActive = useCreditsStore((s) => s.hardStopActive);
  const hardStopReason = useCreditsStore((s) => s.hardStopReason);
  const overLimit = useCreditsStore((s) => s.over_limit);
  // 260926: "Free play resets in 3 days (Wednesday, Sep 30)." The wall is a
  // pause, not an exit, and this is the line that says so. null (omitted)
  // when the snapshot carries no reset time.
  const resetLine = useResetLine();
  const rateLimitedUntil = useCreditsStore((s) => s.rateLimitedUntil);
  const snapshotFailed = useCreditsStore((s) => s.snapshotFailed);
  const refresh = useCreditsStore((s) => s.refresh);
  const acknowledgeHardStop = useCreditsStore((s) => s.acknowledgeHardStop);
  const requestTopUp = useCreditsStore((s) => s.requestTopUp);
  const plan = useCreditsStore((s) => s.plan);
  const navigate = useUiStore((s) => s.navigate);
  const llmProvider = useUiStore((s) => s.llmProvider);

  // A rate limit is a time window: no billing change clears it, so it never
  // takes part in the over_limit refresh/latch/auto-dismiss machinery below.
  const isRateLimited = hardStopReason === 'rate_limited';

  // When this wall's modal opened, for credit_wall_action.ms_open.
  const [openedAt, setOpenedAt] = useState(() => Date.now());
  useEffect(() => {
    if (hardStopActive) setOpenedAt(Date.now());
  }, [hardStopActive]);
  const closeTracked = (): void => {
    trackWallAction('close', hardStopReason, openedAt);
    acknowledgeHardStop();
  };

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
      <ModalShell title={t('Too many requests')} width={440} onClose={closeTracked}>
        <p className={styles.body}>
          {retryWhen
            ? t(
                "Sei's servers are limiting requests right now, so your companion has to sit this one out. This does not use up any of your credits. You can try again after {when}.",
                { when: retryWhen },
              )
            : t(
                "Sei's servers are limiting requests right now, so your companion has to sit this one out. This does not use up any of your credits. You can try again in a moment.",
              )}
        </p>
        <ModalFooter>
          <Button kind="primary" size="md" onClick={closeTracked}>
            {t('Close')}
          </Button>
        </ModalFooter>
      </ModalShell>
    );
  }

  // Dismiss the popup THEN route to the plan screen — otherwise this modal
  // (mounted at the App root) would keep covering it.
  const handleUpgrade = (): void => {
    trackWallAction('upgrade', hardStopReason, openedAt);
    acknowledgeHardStop();
    navigate({ kind: 'credits' });
  };

  // Same destination, but the plan screen opens the packages on arrival.
  const handleTopUp = (): void => {
    trackWallAction('topup', hardStopReason, openedAt);
    requestTopUp();
    acknowledgeHardStop();
    navigate({ kind: 'credits' });
  };

  const free = wallFreeOptions({ reason: hardStopReason, plan, llmProvider });

  return (
    // Click-outside intentionally does NOT dismiss (scrimClose omitted) — Close,
    // the CTAs, and ESC are the deliberate dismiss paths. Base tier: the consent
    // gate and the top up modal stack above this at 1100.
    <ModalShell title={t('Usage limit reached')} width={440} onClose={closeTracked}>
      {/* 261103 spacing pass: one stack, one rhythm. The shell's gap parts
          the title, this stack and the footer; inside it the copy, the CTA
          and the free options are groups a step further apart, and each
          group keeps its own lines tight. */}
      <div className={styles.stack}>
        <div className={styles.copy}>
          <p className={styles.body}>{t("You've used this week's allowance.")}</p>
          {resetLine ? <p className={`${styles.body} ${styles.resetLine}`}>{resetLine}</p> : null}
        </div>
        {/* 261103: one way forward, full width. Party has no tier above it,
            so its button is Top up. Close stays a quiet footer link. */}
        {plan === 'party' ? (
          <PlanButton kind="primary" size="md" arrow onClick={handleTopUp}>
            {t('Top up')}
          </PlanButton>
        ) : (
          <PlanButton kind="primary" size="md" arrow onClick={handleUpgrade}>
            {t('Upgrade')}
          </PlanButton>
        )}
        {/* 261103: ways to keep playing that cost Sei nothing, one step
            quieter than Upgrade: an "or", then sm buttons. ChatGPT goes last so
            its note is the bottom line (Shawn: less text in the lower half). */}
        {free.chatgpt || free.ownKey ? (
          <div className={styles.free} data-testid="wall-free-options">
            <p className={styles.freeTitle}>{t('or')}</p>
            {free.ownKey ? (
              <PlanButton
                kind="secondary"
                size="sm"
                icon={<KeyIcon size={16} />}
                onClick={() => takeWallFreeOption('own_key', hardStopReason, openedAt)}
              >
                {t('Use your own API key or a local model')}
              </PlanButton>
            ) : null}
            {free.chatgpt ? (
              <div className={styles.withNote}>
                <PlanButton
                  kind="secondary"
                  size="sm"
                  icon={
                    <span className={styles.chatgptLogo}>
                      <ChatgptLogo size={16} />
                    </span>
                  }
                  onClick={() => takeWallFreeOption('chatgpt', hardStopReason, openedAt)}
                >
                  {t('Use your ChatGPT plan')}
                </PlanButton>
                <p className={styles.freeNote}>{t('Works with ChatGPT Plus or Pro.')}</p>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      <ModalFooter>
        <Button kind="quiet" size="md" onClick={closeTracked}>
          {t('Close')}
        </Button>
      </ModalFooter>
    </ModalShell>
  );
}
