/**
 * CreditsScreen — plan + weekly usage surface (260724 subscription model).
 *
 * Layout: a centered column —
 *   - BackRow + a usage HERO: "{pct}% used" (Oswald) over a flat bar, with a
 *     "Resets {date}" sub-line. At 100% the number and the bar turn red: a full
 *     bar has to read as a limit, not as an achievement.
 *   - An EXTRA CREDITS row: a quieter muted bar, "x / y extra credits used",
 *     and a Top up button. Extra credits are a separate, non-expiring bucket
 *     spent only after the week's allowance is gone.
 *   - Three PLAN cards (Free / Quest / Party). The current plan is highlighted
 *     and its button reads "Current plan"; the others offer Upgrade or
 *     Downgrade. A first subscription goes through the hosted checkout; a tier
 *     change on an existing subscription is applied in place by the proxy. Both
 *     pass through the auto-renewal consent gate, which is LEGALLY REQUIRED
 *     (CA ARL §17602(b)) and must never be bypassed. Downgrading to Free is a
 *     cancellation, so it routes to the Polar customer portal.
 *   - A "Manage billing" footer (Polar customer-portal flow via handleManage)
 *     plus the carry-over note. The button shows an "Opening…" pending state and
 *     an inline error when the portal can't be opened, so it is never a silent
 *     no-op.
 *
 * Checkout opens in the user's system browser (shell.openExternal in the main
 * process).
 *
 * Money on this screen is limited to the plan cards and the top up packages;
 * there are no time estimates and no per-usage cost figures anywhere. The store
 * carries percentages, credit counts and dates only.
 *
 * Sources:
 *   - .planning/quick/260724-sub-weekly-subscription-model/SPEC.md
 *   - src/renderer/src/lib/stores/useCreditsStore.ts (selectors + actions)
 */

import React, { useEffect, useState } from 'react';
import type { PlanTier } from '@shared/ipc';
import { useCreditsStore, type CheckoutKind } from '../lib/stores/useCreditsStore';
import { useUiStore } from '../lib/stores/useUiStore';
import { Button } from '../components/Button';
import { ModalShell, ModalFooter } from '../components/ModalShell';
import { PercentBar } from '../components/PercentBar';
import { BackIcon, RefreshIcon } from '../components/icons';
import { sei } from '../lib/ipcClient';
import { AutoRenewalConsentModal } from '../components/AutoRenewalConsentModal';
import { TopUpModal } from '../components/TopUpModal';
import { FeedbackRewardCard } from '../components/FeedbackRewardCard';
import { FeedbackModal } from '../components/FeedbackModal';
import { formatRenewal } from '../lib/formatRenewal';
import { PLANS, TIER_ORDER, planName } from '../lib/planCatalog';
import styles from './CreditsScreen.module.css';

/** Footer note: what carries over between weeks and what does not (SPEC §2). */
const CARRY_OVER_NOTE =
  'Unused weekly credits do not carry over. Extra credits never expire.';

/**
 * 260706 — how much of the weekly allowance must be spent before the one-time
 * feedback prompt appears. By a quarter of the week's credits the user has
 * played enough to have real opinions. (It used to key off lifetime dollars
 * spent, which no longer reaches the renderer.)
 */
const FEEDBACK_PROMPT_USAGE_PCT = 25;

/**
 * Plain-English copy for the "Manage billing" failure branches. Without this the
 * portal call failed silently (the result was discarded), so the button looked
 * dead. Codes come from proxyClient.cancelSubscription (PROXY_* constants).
 */
function manageErrorCopy(code: string): string {
  switch (code) {
    case 'PROXY_NO_SESSION':
      return 'Sign in to manage billing.';
    case 'PROXY_NO_PORTAL_URL':
      // No Polar customer on record yet (never purchased) or the billing
      // backend is unavailable, so there is nothing to manage.
      return 'No billing to manage yet. Subscribe or top up first.';
    default:
      return 'Could not open billing. Please try again.';
  }
}

export function CreditsScreen(): React.ReactElement {
  // Separate selectors so React only re-subscribes the slices we read.
  const usagePct = useCreditsStore((s) => s.usage_pct);
  const overLimit = useCreditsStore((s) => s.over_limit);
  const resetsAt = useCreditsStore((s) => s.resets_at);
  const extraUsed = useCreditsStore((s) => s.extra_credits_used);
  const extraTotal = useCreditsStore((s) => s.extra_credits_total);
  const loading = useCreditsStore((s) => s.loading);
  // Last snapshot fetch failed and nothing fresher landed: the store's zeros
  // are placeholders, so the hero must not present "0% used" as account truth.
  const snapshotFailed = useCreditsStore((s) => s.snapshotFailed);
  const plan = useCreditsStore((s) => s.plan);
  const renewsAt = useCreditsStore((s) => s.renews_at);
  const endsAt = useCreditsStore((s) => s.ends_at);
  const subscriptionStatusRaw = useCreditsStore((s) => s.subscription_status_raw);
  const beginPurchase = useCreditsStore((s) => s.beginPurchase);
  const beginResume = useCreditsStore((s) => s.beginResume);
  const dismissCheckout = useCreditsStore((s) => s.dismissCheckout);
  const checkoutStatus = useCreditsStore((s) => s.checkoutStatus);
  const checkoutKind = useCreditsStore((s) => s.checkoutKind);
  const cancelSubscription = useCreditsStore((s) => s.cancelSubscription);
  const refresh = useCreditsStore((s) => s.refresh);
  const topUpRequested = useCreditsStore((s) => s.topUpRequested);
  const clearTopUpRequest = useCreditsStore((s) => s.clearTopUpRequest);
  const navigate = useUiStore((s) => s.navigate);
  // Every paid move routes through the consent gate (CA ARL §17602(b)) before
  // the checkout or the subscription update runs.
  const [consentFor, setConsentFor] = useState<{
    tier: Exclude<PlanTier, 'free'>;
    mode: 'checkout' | 'change';
  } | null>(null);
  const [showTopUp, setShowTopUp] = useState(false);
  // "Manage billing" portal request: pending label + inline error so a failed
  // (or no-op) portal open is visible instead of silently doing nothing.
  const [managing, setManaging] = useState(false);
  const [manageError, setManageError] = useState<string | null>(null);
  // A checkout is "in flight" from the click until the watch modal is dismissed.
  // Drives the plan-button disabled state so the user can't kick off a second
  // purchase while one is being watched.
  const checkoutActive = checkoutStatus !== 'idle';

  const usedPct = Math.max(0, Math.min(100, Math.round(usagePct)));
  const atLimit = usedPct >= 100;

  // 260706 — feedback reward banner. `null` = config not read yet (render
  // neither the banner nor the standing button, so nothing flashes).
  const [rewardClaimed, setRewardClaimed] = useState<boolean | null>(null);
  const [showFeedbackModal, setShowFeedbackModal] = useState(false);
  // Feedback surfaces are cloud-only: the proxy endpoints need a Supabase
  // session, and the reward is a server-side usage reset. BYOK/local users never
  // see the banner or the standing button.
  const cloudMode = useCreditsStore((s) => s.ai_backend_kind) === 'cloud-proxy';
  // Analytics (260707): pricing/plan surface viewed — top of the monetization
  // funnel (pairs with checkout_opened downstream).
  useEffect(() => {
    sei.track('pricing_viewed');
  }, []);

  useEffect(() => {
    let cancelled = false;
    void sei.getConfig().then((c) => {
      if (cancelled) return;
      setRewardClaimed(c.feedback_reward_claimed ?? false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Arriving from the hard-stop popup's "Top up" CTA: open the packages here,
  // where the checkout watcher lives, then clear the request so a later visit
  // doesn't re-open it.
  useEffect(() => {
    if (!topUpRequested) return;
    setShowTopUp(true);
    clearTopUpRequest();
  }, [topUpRequested, clearTopUpRequest]);

  // Pull a fresh snapshot when the page opens, then poll every 60s while it
  // stays open. The app-level init() seeds + subscribes to IPC pushes, but those
  // only fire on a proxied bot call; without this, an idle plan screen would
  // show stale usage. Cleared on unmount.
  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 60_000);
    return () => clearInterval(id);
  }, [refresh]);

  // Single bottom "Manage billing" button → Polar customer-portal flow. The
  // store action returns { ok, code }; surface a pending label while the portal
  // request is in flight and an inline error when it can't be opened (no Polar
  // customer yet, signed out, network) so the button isn't a silent no-op.
  const handleManage = async (): Promise<void> => {
    if (managing) return;
    setManageError(null);
    setManaging(true);
    try {
      const res = await cancelSubscription();
      if (!res.ok) setManageError(manageErrorCopy(res.code));
    } finally {
      setManaging(false);
    }
  };

  const handleResume = (): void => {
    if (checkoutActive) return;
    // Opens the Polar customer portal (Polar's uncancel = subscription.uncanceled)
    // and shows the "continue in browser" watch modal that polls until the sub
    // flips off 'cancelled'. NOT a new subscription that would bill immediately.
    void beginResume();
  };

  const renewalText = formatRenewal(renewsAt);
  const endsText = formatRenewal(endsAt);
  const resetsText = formatRenewal(resetsAt);
  const isSubscribed = plan !== 'free';
  // "To be cancelled": still on the paid tier but set to cancel at period end.
  const cancelScheduled = isSubscribed && subscriptionStatusRaw === 'cancelled';

  // Extra credits: the bar fills as the non-expiring bucket is spent. An account
  // that never topped up shows an empty bar and the Top up button.
  const extraPct = extraTotal > 0 ? (extraUsed / extraTotal) * 100 : 0;
  const extraLabel = `${extraUsed.toLocaleString()} / ${extraTotal.toLocaleString()} extra credits used`;

  return (
    <div className={styles.root}>
      <div className={styles.col}>
        <div className={styles.backRow}>
          <Button
            kind="quiet"
            size="sm"
            icon={<BackIcon size={14} />}
            onClick={() => navigate({ kind: 'home' })}
          >
            Back
          </Button>
        </div>

        {/* One-time feedback banner: appears once a quarter of the weekly
            allowance is spent, retires permanently once submitted (260706). */}
        {cloudMode && rewardClaimed === false && usedPct >= FEEDBACK_PROMPT_USAGE_PCT ? (
          <FeedbackRewardCard onDone={() => setRewardClaimed(true)} />
        ) : null}

        {/* Hero — "{pct}% used" + refresh beside it + a matching usage fill. */}
        <div className={styles.hero}>
          <div className={styles.heroTop}>
            <div className={`${styles.heroBig} ${atLimit && !snapshotFailed ? styles.heroBigOver : ''}`}>
              {snapshotFailed ? (
                <>
                  –%<small>used</small>
                </>
              ) : (
                <>
                  {usedPct}%<small>used</small>
                </>
              )}
            </div>
            {/* Immediate creditsGet() on top of the 60s poll. */}
            <Button
              kind="quiet"
              size="sm"
              icon={<RefreshIcon size={14} />}
              disabled={loading}
              title="Refresh"
              aria-label="Refresh plan usage"
              onClick={() => void refresh()}
            />
          </div>
          <div className={styles.heroBar}>
            <i
              className={atLimit && !snapshotFailed ? styles.heroBarOver : undefined}
              style={{ width: snapshotFailed ? '0%' : `${usedPct}%` }}
            />
          </div>
          {snapshotFailed ? (
            <p className={styles.heroSub}>
              Couldn't check your account right now. Refresh to try again.
            </p>
          ) : resetsText ? (
            <p className={styles.heroSub}>Resets {resetsText}</p>
          ) : null}
        </div>

        {/* Extra credits — the separate, non-expiring top up bucket. */}
        <div className={styles.extra}>
          <div className={styles.extraBar}>
            <PercentBar
              value={snapshotFailed ? 0 : extraPct}
              size="sm"
              tone="muted"
              hideLabel
              label={extraLabel}
            />
          </div>
          <span className={styles.extraText}>{extraLabel}</span>
          <Button kind="ghost" size="sm" disabled={checkoutActive} onClick={() => setShowTopUp(true)}>
            Top up
          </Button>
        </div>

        {/* Plans — Free / Quest / Party, current one highlighted. */}
        <div className={styles.plans}>
          <h3 className={styles.plansTitle}>Plans</h3>
          <div className={styles.plansRow}>
            {PLANS.map((card) => {
              const isCurrent = card.tier === plan;
              const isUpgrade = TIER_ORDER[card.tier] > TIER_ORDER[plan];
              return (
                <div
                  key={card.tier}
                  className={`${styles.planCard} ${isCurrent ? styles.planCardActive : ''}`}
                >
                  <span className={styles.planName}>{card.name}</span>
                  <span className={styles.planPrice}>
                    {card.price}
                    {card.priceQualifier ? (
                      <span className={styles.planPriceQualifier}>{card.priceQualifier}</span>
                    ) : null}
                  </span>
                  <span className={styles.planBlurb}>{card.blurb}</span>
                  <div className={styles.planCardActions}>
                    {isCurrent && cancelScheduled ? (
                      // Resume the existing to-be-cancelled sub (Polar portal
                      // uncancel) rather than starting a new one that bills now.
                      <Button
                        kind="primary"
                        size="sm"
                        fullWidth
                        disabled={checkoutActive}
                        onClick={handleResume}
                      >
                        Resume
                      </Button>
                    ) : isCurrent ? (
                      <Button kind="primary" size="sm" fullWidth disabled aria-disabled>
                        Current plan
                      </Button>
                    ) : card.tier === 'free' ? (
                      // Moving to Free is a cancellation: Polar owns that flow.
                      <Button
                        kind="ghost"
                        size="sm"
                        fullWidth
                        disabled={managing}
                        onClick={() => void handleManage()}
                      >
                        {managing ? 'Opening…' : 'Downgrade'}
                      </Button>
                    ) : (
                      <Button
                        kind={isUpgrade ? 'accent' : 'ghost'}
                        size="sm"
                        fullWidth
                        disabled={checkoutActive}
                        onClick={() =>
                          setConsentFor({
                            tier: card.tier as Exclude<PlanTier, 'free'>,
                            // No subscription yet → hosted checkout. Already
                            // subscribed → update the existing one in place.
                            mode: isSubscribed ? 'change' : 'checkout',
                          })
                        }
                      >
                        {isUpgrade ? 'Upgrade' : 'Downgrade'}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/*
            Renewal note under the cards for subscribers: the renewal date while
            auto-renewing, or a "won't renew" line once the subscription is
            cancel-scheduled (still active until ends_at).
          */}
          {cancelScheduled ? (
            <p className={styles.planRenewalNote}>
              {endsText
                ? `Your ${planName(plan)} plan will not renew. It ends ${endsText}.`
                : `Your ${planName(plan)} plan will not renew.`}
            </p>
          ) : isSubscribed && renewalText ? (
            <p className={styles.planRenewalNote}>
              Your {planName(plan)} plan renews on {renewalText}.
            </p>
          ) : null}
          {subscriptionStatusRaw === 'past_due' ? (
            <p className={styles.planRenewalNote}>
              Your last payment did not go through. Update your card in Manage billing.
            </p>
          ) : null}
        </div>

        {/*
          Footer: "Manage billing" (Polar customer-portal flow via handleManage,
          shown for everyone; never-subscribed users no-op gracefully — FTC
          Click-to-Cancel online cancel path) + the carry-over note.
        */}
        <div className={styles.foot}>
          <Button
            kind="ghost"
            size="sm"
            disabled={managing}
            aria-disabled={managing}
            onClick={() => void handleManage()}
          >
            {managing ? 'Opening…' : 'Manage billing'}
          </Button>
          <span className={styles.disc}>{CARRY_OVER_NOTE}</span>
        </div>
        {manageError ? <p className={styles.manageError}>{manageError}</p> : null}

        {/* Standing feedback entry point once the one-time reward banner has
            been used (260706). Sits under Manage billing, same style. */}
        {cloudMode && rewardClaimed === true ? (
          <div className={styles.footFeedback}>
            <Button kind="ghost" size="sm" onClick={() => setShowFeedbackModal(true)}>
              Submit feedback
            </Button>
          </div>
        ) : null}
      </div>

      {consentFor ? (
        <AutoRenewalConsentModal
          tier={consentFor.tier}
          mode={consentFor.mode}
          onClose={() => setConsentFor(null)}
          // Consent recorded and the purchase started → start the watch. On the
          // checkout path the browser is already open, so don't re-open it.
          onProceed={() =>
            void beginPurchase(consentFor.tier, { alreadyOpened: consentFor.mode === 'checkout' })
          }
        />
      ) : null}

      {showTopUp ? (
        <TopUpModal
          onClose={() => setShowTopUp(false)}
          onProceed={(kind) => void beginPurchase(kind)}
        />
      ) : null}

      {/* "Complete your purchase in your browser" watcher — stays up while we
          poll for the webhook-driven change (useCreditsStore.beginPurchase).
          Dismissing it stops polling; the focus-refetch backstop still catches
          a payment completed after the user closes this. */}
      {checkoutStatus !== 'idle' ? (
        <CheckoutWaitingModal
          status={checkoutStatus}
          kind={checkoutKind}
          onClose={dismissCheckout}
        />
      ) : null}

      {/* Standing feedback form (260706) — reachable once the reward banner
          has been used. */}
      {showFeedbackModal ? <FeedbackModal onClose={() => setShowFeedbackModal(false)} /> : null}
    </div>
  );
}

/**
 * Modal shown after the user is sent to the hosted checkout in their browser.
 * Standard "waiting for an out-of-band payment" surface: a spinner + "we'll
 * update automatically" copy while polling, a success state when the change
 * lands, and a timeout state that reassures the plan will still update once
 * the payment completes (the store's focus-refetch backstop + push channel).
 * ESC / the button dismiss it without cancelling the browser purchase.
 */
function CheckoutWaitingModal({
  status,
  kind,
  onClose,
}: {
  status: 'waiting' | 'confirmed' | 'timeout';
  kind: CheckoutKind | null;
  onClose: () => void;
}): React.ReactElement {
  const isResume = kind === 'resume';
  const isTopUp = kind === 'topup_small' || kind === 'topup_large';
  const product = isTopUp ? 'extra credits' : kind ? planName(kind as PlanTier) : 'your plan';

  const title =
    status === 'waiting'
      ? isResume
        ? 'Resume your subscription'
        : 'Complete your purchase'
      : status === 'confirmed'
        ? isResume
          ? 'Subscription resumed'
          : 'Purchase complete'
        : 'Still processing';

  return (
    // Stacked tier (1100): this watcher sits above the base plan screen.
    // ESC / the footer button dismiss it without cancelling the browser purchase.
    <ModalShell
      title={title}
      tier="stacked"
      onClose={onClose}
      aria-label={isResume ? 'Resume subscription status' : 'Checkout status'}
    >
      <div className={styles.checkoutBody}>
        {status === 'waiting' ? (
          <>
            <span className={styles.checkoutSpinner} aria-hidden="true" />
            <p className={styles.checkoutMsg}>
              {isResume
                ? `Resume your ${product} subscription in your browser. This screen updates automatically once it's confirmed.`
                : `Finish checking out for ${product} in your browser. This screen updates automatically once the payment is confirmed.`}
            </p>
          </>
        ) : status === 'confirmed' ? (
          <>
            <span className={styles.checkoutCheck} aria-hidden="true">
              ✓
            </span>
            <p className={styles.checkoutMsg}>
              {isResume
                ? `Your ${product} subscription will continue, with no end date.`
                : isTopUp
                  ? 'Your extra credits are now available.'
                  : `Your ${product} plan is active.`}
            </p>
          </>
        ) : (
          <p className={styles.checkoutMsg}>
            This is taking longer than usual. You can close this; it will update here
            automatically once it completes.
          </p>
        )}
      </div>
      <ModalFooter>
        {status === 'confirmed' ? (
          <Button kind="primary" size="md" onClick={onClose}>
            Done
          </Button>
        ) : (
          <Button kind="quiet" size="md" onClick={onClose}>
            Close
          </Button>
        )}
      </ModalFooter>
    </ModalShell>
  );
}
