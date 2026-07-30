/**
 * CreditsScreen — plan + weekly usage surface (260724 subscription model,
 * 260725 sketch layout).
 *
 * Layout: a centered column —
 *   - BackRow + a USAGE section (sketch 260725): two label/bar/value rows.
 *     Row 1: "{Plan} plan" + "Resets in Xd Yh" on the left, the allowance bar,
 *     "{pct}%" on the right (plain text color at every value; only the bar
 *     fill goes red at 100). Row 2: "Extra credits" + "x/y used" on the left, the muted
 *     bar, the Top up button on the right. The carry-over note sits directly
 *     under the extra-credits row. Extra credits are a separate, non-expiring
 *     bucket spent only after the week's allowance is gone.
 *   - Three PLAN cards (Free / Quest / Party). The current plan is highlighted
 *     and its button reads "Current plan"; the others offer Upgrade or
 *     Downgrade. A first subscription goes straight to the hosted Polar
 *     checkout; a tier change on an existing subscription is applied in place
 *     by the proxy. 260725 operator decision: the in-app auto-renewal consent
 *     modal was REMOVED — the recurring terms are disclosed on the Polar
 *     hosted checkout page instead (Polar is the Merchant of Record).
 *     260725 follow-up: that only covers the NOT-yet-subscribed branch. An
 *     existing subscriber's tier change never opens a browser page (it is a
 *     Polar subscription update billed against the card on file), so
 *     PlanChangeConfirmModal below carries the recurring amount, the cadence
 *     and the proration disclosure in-app before changePlan() fires.
 *     Downgrading to Free is a cancellation, so it routes to the Polar
 *     customer portal.
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
import { BackIcon, RefreshIcon } from '../components/icons';
import { sei } from '../lib/ipcClient';
import { TopUpModal } from '../components/TopUpModal';
import { FeedbackRewardCard } from '../components/FeedbackRewardCard';
import { FeedbackModal } from '../components/FeedbackModal';
import { useNoticesStore } from '../lib/stores/useNoticesStore';
import { formatRenewal } from '../lib/formatRenewal';
import { TIER_ORDER, planCard, planName } from '../lib/planCatalog';
import { t, useT } from '../lib/i18n';
import styles from './CreditsScreen.module.css';

/** Note under the extra-credits bar: what carries over and what does not (SPEC §2). */
const CARRY_OVER_NOTE =
  'Unused weekly credits do not carry over. Extra credits never expire.';

/**
 * "3 days 4 hr" / "4 hr 30 min" / "30 min" / "soon" from the resets_at ISO
 * stamp (260725 wording). Two largest units only; minute precision is all the
 * surface needs, and the screen re-renders on a 60s tick while open. Empty
 * string on a bad date so the sub-line simply doesn't render.
 */
export function formatResetsIn(resetsAt: string, nowMs: number): string {
  const t = Date.parse(resetsAt);
  if (Number.isNaN(t)) return '';
  const left = t - nowMs;
  if (left <= 60_000) return 'soon';
  const mins = Math.floor(left / 60_000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  // Compact consistent units (260725): "3d 4h" / "4h 30m" / "30m".
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

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
      return t('Sign in to manage billing.');
    case 'PROXY_NO_PORTAL_URL':
      // No Polar customer on record yet (never purchased) or the billing
      // backend is unavailable, so there is nothing to manage.
      return t('No billing to manage yet. Subscribe or top up first.');
    default:
      return t('Could not open billing. Please try again.');
  }
}

/**
 * Plain-English copy for a failed in-place tier change. Codes come from
 * proxyClient.changePlan (PROXY_NO_SESSION / PROXY_RATE_LIMITED /
 * PROXY_NETWORK). Without this the failure was invisible: the watcher would
 * simply poll for 3 minutes and report a timeout.
 */
function changeErrorCopy(code: string): string {
  switch (code) {
    case 'PROXY_NO_SESSION':
      return t('Sign in to change your plan.');
    case 'PROXY_RATE_LIMITED':
      return t('Too many requests. Wait a moment and try again.');
    default:
      return t('Could not change your plan. Please try again.');
  }
}

export function CreditsScreen(): React.ReactElement {
  const t = useT();
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
  const feedbackRewardAvailable = useCreditsStore((s) => s.feedback_reward_available);
  const beginPurchase = useCreditsStore((s) => s.beginPurchase);
  const beginResume = useCreditsStore((s) => s.beginResume);
  const dismissCheckout = useCreditsStore((s) => s.dismissCheckout);
  const checkoutStatus = useCreditsStore((s) => s.checkoutStatus);
  const checkoutKind = useCreditsStore((s) => s.checkoutKind);
  const cancelSubscription = useCreditsStore((s) => s.cancelSubscription);
  const changePlan = useCreditsStore((s) => s.changePlan);
  const refresh = useCreditsStore((s) => s.refresh);
  const topUpRequested = useCreditsStore((s) => s.topUpRequested);
  const clearTopUpRequest = useCreditsStore((s) => s.clearTopUpRequest);
  // 260725: server-driven catalog (bundled fallback until loadCatalog lands).
  const planCards = useCreditsStore((s) => s.planCards);
  const navigate = useUiStore((s) => s.navigate);
  const [showTopUp, setShowTopUp] = useState(false);
  // "Manage billing" portal request: pending label + inline error so a failed
  // (or no-op) portal open is visible instead of silently doing nothing.
  const [managing, setManaging] = useState(false);
  const [manageError, setManageError] = useState<string | null>(null);
  // 260725: the tier the user clicked on an EXISTING subscription, awaiting the
  // in-app confirmation (recurring amount + cadence + proration). null = no
  // confirmation open. `changeError` surfaces a rejected change inline.
  const [pendingChange, setPendingChange] = useState<Exclude<PlanTier, 'free'> | null>(null);
  const [changeError, setChangeError] = useState<string | null>(null);
  // True while the watch modal is following an IN-PLACE tier change rather than
  // a browser checkout, so it doesn't tell the user to finish something in a
  // browser tab that never opened. Set by whichever purchase path starts.
  const [inPlaceChange, setInPlaceChange] = useState(false);
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
  // Notices inbox (260725) — the standing re-entry point under Submit feedback.
  const openInbox = useNoticesStore((s) => s.openInbox);
  const unreadNotices = useNoticesStore((s) => s.unreadCount());
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

  // No subscription yet: open the hosted Polar checkout (its page carries the
  // recurring terms) and watch. Already subscribed: the change is applied in
  // place against the card on file, with no browser page to disclose anything,
  // so it goes through the in-app confirmation first (260725).
  const handlePlanSelect = (tier: Exclude<PlanTier, 'free'>): void => {
    if (checkoutActive) return;
    if (isSubscribed) {
      setChangeError(null);
      setPendingChange(tier);
      return;
    }
    setInPlaceChange(false);
    void beginPurchase(tier);
  };

  // Confirmed in PlanChangeConfirmModal. Order matters (260725): changePlan()
  // refreshes internally, so calling it FIRST wrote the new tier into the store
  // and beginPurchase's baseline then equalled the post-change state. No
  // isPurchaseConfirmed clause could fire, the watcher polled for its full 3
  // minutes and ended in 'timeout' — a successful change presented as a
  // failure. beginPurchase snapshots the baseline synchronously (alreadyOpened
  // skips the browser hop), so taking it before the change makes the flip
  // detectable on the first poll.
  const handleConfirmChange = async (): Promise<void> => {
    const tier = pendingChange;
    if (tier === null) return;
    setPendingChange(null);
    setChangeError(null);
    setInPlaceChange(true);
    void beginPurchase(tier, { alreadyOpened: true });
    const res = await changePlan(tier);
    if (!res.ok) {
      // Nothing is coming: stop the watch instead of letting it time out.
      dismissCheckout();
      setChangeError(changeErrorCopy(res.code));
    }
  };

  const handleResume = (): void => {
    if (checkoutActive) return;
    // Opens the Polar customer portal (Polar's uncancel = subscription.uncanceled)
    // and shows the "continue in browser" watch modal that polls until the sub
    // flips off 'cancelled'. NOT a new subscription that would bill immediately.
    setInPlaceChange(false);
    void beginResume();
  };

  // 60s tick so the "Resets in Xd Yh" countdown stays fresh while the screen
  // is open (matches the refresh poll cadence; no 1Hz re-render).
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const renewalText = formatRenewal(renewsAt);
  const endsText = formatRenewal(endsAt);
  const resetsIn = resetsAt ? formatResetsIn(resetsAt, nowMs) : '';
  const isSubscribed = plan !== 'free';
  // "To be cancelled": still on the paid tier but set to cancel at period end.
  const cancelScheduled = isSubscribed && subscriptionStatusRaw === 'cancelled';

  // Extra credits: the bar fills as the non-expiring bucket is spent. An account
  // that never topped up shows an empty bar and the Top up button.
  const extraPct = extraTotal > 0 ? (extraUsed / extraTotal) * 100 : 0;
  const extraLabel = t('{used}/{total} credits used', {
    used: extraUsed.toLocaleString(),
    total: extraTotal.toLocaleString(),
  });

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
            {t('Back')}
          </Button>
        </div>

        {/* One-time feedback banner: appears once a quarter of the weekly
            allowance is spent, retires permanently once submitted (260706).
            260726: the SERVER decides whether the reward is still there
            (usage_periods.feedback_reset_at). The local `rewardClaimed` mirror
            is per profile, so a fresh profile or a re-onboard used to re-offer
            a reward the account had already spent, and the user only found out
            after writing the feedback. Only an explicit `false` suppresses the
            banner: unknown (signed out, cold load, failed read) still falls
            back to the local mirror. */}
        {cloudMode &&
        rewardClaimed === false &&
        feedbackRewardAvailable !== false &&
        usedPct >= FEEDBACK_PROMPT_USAGE_PCT ? (
          <FeedbackRewardCard onDone={() => setRewardClaimed(true)} />
        ) : null}

        {/* Usage — two label/bar/value rows per the 260725 sketch. */}
        <div className={styles.usage}>
          <div className={styles.usageHead}>
            <h3 className={styles.sectionTitle}>{t('Usage')}</h3>
            {/* Immediate creditsGet() on top of the 60s poll. */}
            <Button
              kind="quiet"
              size="sm"
              icon={<RefreshIcon size={14} />}
              disabled={loading}
              title={t('Refresh')}
              aria-label={t('Refresh plan usage')}
              onClick={() => void refresh()}
            />
          </div>

          {/* Row 1: the weekly allowance. */}
          <div className={styles.usageRow}>
            <div className={styles.usageLabel}>
              <span className={styles.usageName}>
                {t('{name} plan', { name: planName(planCards, plan) })}
              </span>
              {snapshotFailed ? (
                <span className={styles.usageSubWarn}>
                  {t("Couldn't check your account. Refresh to try again.")}
                </span>
              ) : resetsIn ? (
                <span className={styles.usageSub}>{t('Resets in {time}', { time: resetsIn })}</span>
              ) : null}
            </div>
            <div className={styles.usageTrack}>
              <i
                className={atLimit && !snapshotFailed ? styles.usageFillOver : undefined}
                style={{ width: snapshotFailed ? '0%' : `${usedPct}%` }}
              />
            </div>
            {/* 260725: the percentage stays the normal text color at 100. The
                bar fill still turns red, which is signal enough. */}
            <span className={styles.usagePct}>{snapshotFailed ? '–%' : `${usedPct}%`}</span>
          </div>

          {/* Row 2: the separate, non-expiring extra-credits bucket. */}
          <div className={styles.usageRow}>
            <div className={styles.usageLabel}>
              <span className={styles.usageName}>{t('Extra credits')}</span>
              <span className={styles.usageSub}>{extraLabel}</span>
            </div>
            <div className={styles.usageTrack}>
              <i
                className={styles.usageFillMuted}
                style={{ width: snapshotFailed ? '0%' : `${Math.max(0, Math.min(100, extraPct))}%` }}
              />
            </div>
            <Button
              kind="ghost"
              size="sm"
              disabled={checkoutActive}
              onClick={() => setShowTopUp(true)}
            >
              {t('Top up')}
            </Button>
          </div>

          <p className={styles.usageNote}>{t(CARRY_OVER_NOTE)}</p>
        </div>

        {/* Plans — Free / Quest / Party, current one highlighted. */}
        <div className={styles.plans}>
          <h3 className={styles.sectionTitle}>{t('Plan')}</h3>
          <div className={styles.plansRow}>
            {planCards.map((card) => {
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
                        {t('Resume')}
                      </Button>
                    ) : isCurrent ? (
                      <Button kind="primary" size="sm" fullWidth disabled aria-disabled>
                        {t('Current plan')}
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
                        {managing ? t('Opening…') : t('Downgrade')}
                      </Button>
                    ) : (
                      <Button
                        kind={isUpgrade ? 'accent' : 'ghost'}
                        size="sm"
                        fullWidth
                        disabled={checkoutActive}
                        onClick={() => handlePlanSelect(card.tier as Exclude<PlanTier, 'free'>)}
                      >
                        {isUpgrade ? t('Upgrade') : t('Downgrade')}
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
                ? t('Your {name} plan will not renew. It ends {date}.', {
                    name: planName(planCards, plan),
                    date: endsText,
                  })
                : t('Your {name} plan will not renew.', { name: planName(planCards, plan) })}
            </p>
          ) : isSubscribed && renewalText ? (
            <p className={styles.planRenewalNote}>
              {t('Your {name} plan renews on {date}.', {
                name: planName(planCards, plan),
                date: renewalText,
              })}
            </p>
          ) : null}
          {subscriptionStatusRaw === 'past_due' ? (
            <p className={styles.planRenewalNote}>
              {t('Your last payment did not go through. Update your card in Manage billing.')}
            </p>
          ) : null}
          {/* A rejected in-place tier change (260725). Without this the failure
              was silent and the watcher's timeout was the only signal. */}
          {changeError ? <p className={styles.manageError}>{changeError}</p> : null}
        </div>

        {/*
          Footer: "Manage billing" (Polar customer-portal flow via handleManage,
          shown for everyone; never-subscribed users no-op gracefully — FTC
          Click-to-Cancel online cancel path). The carry-over note lives under
          the extra-credits bar (260725).
        */}
        <div className={styles.foot}>
          <Button
            kind="ghost"
            size="sm"
            disabled={managing}
            aria-disabled={managing}
            onClick={() => void handleManage()}
          >
            {managing ? t('Opening…') : t('Manage billing')}
          </Button>
        </div>
        {manageError ? <p className={styles.manageError}>{manageError}</p> : null}

        {/* Standing feedback entry point once the one-time reward banner has
            been used (260706). Sits under Manage billing, same style. */}
        {cloudMode && rewardClaimed === true ? (
          <div className={styles.footFeedback}>
            <Button kind="ghost" size="sm" onClick={() => setShowFeedbackModal(true)}>
              {t('Submit feedback')}
            </Button>
          </div>
        ) : null}

        {/* Notices inbox (260725). Sits under "Submit feedback" and is shown to
            everyone, cloud or local: announcements are not a paid surface. The
            inbox opens itself once per new notice; this is the way back in. */}
        <div className={styles.footFeedback}>
          <Button kind="ghost" size="sm" onClick={openInbox}>
            {unreadNotices > 0 ? t('Inbox ({n})', { n: unreadNotices }) : t('Inbox')}
          </Button>
        </div>
      </div>

      {showTopUp ? (
        <TopUpModal
          onClose={() => setShowTopUp(false)}
          onProceed={(kind) => {
            setInPlaceChange(false);
            void beginPurchase(kind);
          }}
        />
      ) : null}

      {/* In-app confirmation for a tier change on an EXISTING subscription: the
          one purchase path with no hosted Polar page to disclose the recurring
          terms (260725). */}
      {pendingChange !== null ? (
        <PlanChangeConfirmModal
          tier={pendingChange}
          currentTier={plan}
          onCancel={() => setPendingChange(null)}
          onConfirm={() => void handleConfirmChange()}
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
          inPlace={inPlaceChange}
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
 * PlanChangeConfirmModal — in-app confirmation for a tier change on an EXISTING
 * subscription (260725).
 *
 * The hosted Polar checkout page carries the recurring terms for a FIRST
 * subscription, but a tier change never opens it: it is a Polar subscription
 * update, prorated against the card already on file, and it used to fire on a
 * single click with no disclosure and no way back. This modal states the new
 * plan, its recurring amount, the billing cadence, that the stored card is
 * used, and how to cancel, before `changePlan()` runs. Wording carried over
 * from the removed AutoRenewalConsentModal where it still applies (the
 * checkbox is not: Polar's hosted page is the consent-of-record surface for a
 * new subscription, and this is an existing subscriber changing a tier).
 */
function PlanChangeConfirmModal({
  tier,
  currentTier,
  onCancel,
  onConfirm,
}: {
  tier: Exclude<PlanTier, 'free'>;
  currentTier: PlanTier;
  onCancel: () => void;
  onConfirm: () => void;
}): React.ReactElement {
  const t = useT();
  const planCards = useCreditsStore((s) => s.planCards);
  const card = planCard(planCards, tier);
  // The exact-charge form ("$8.00") is what the disclosure must state; the
  // card face ("$8") is the fallback if the catalog omitted it.
  const amount = card.chargeUsd ?? card.price;
  const isUpgrade = TIER_ORDER[tier] > TIER_ORDER[currentTier];

  return (
    // Stacked tier (1100) so it sits above the plan screen like the other
    // billing modals. ESC / Back dismiss without changing anything.
    <ModalShell
      title={t('Confirm your plan change')}
      width={440}
      tier="stacked"
      onClose={onCancel}
      aria-label={t('Confirm plan change')}
    >
      <div className={styles.confirmBody}>
        <p className={styles.confirmLead}>
          {t(
            '{name} is {amount} per month, billed through Polar. It renews automatically until you cancel.',
            { name: card.name, amount },
          )}
        </p>
        <p className={styles.checkoutMsg}>
          {isUpgrade
            ? t(
                'The change takes effect right away. Your card on file is charged now, prorated for the time left in your current billing period. After that you pay {amount} each month.',
                { amount },
              )
            : t(
                'The change takes effect right away. Polar prorates the difference against your card on file for the time left in your current billing period. After that you pay {amount} each month.',
                { amount },
              )}
        </p>
        <p className={styles.checkoutMsg}>
          {t('You can cancel anytime from Manage billing.')}
        </p>
      </div>
      <ModalFooter>
        <Button kind="quiet" size="md" onClick={onCancel}>
          {t('Back')}
        </Button>
        <Button kind="primary" size="md" onClick={onConfirm}>
          {t('Confirm plan change')}
        </Button>
      </ModalFooter>
    </ModalShell>
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
  inPlace,
  onClose,
}: {
  status: 'waiting' | 'confirmed' | 'timeout';
  kind: CheckoutKind | null;
  /**
   * 260725 — this watch is following an in-place tier change (the proxy applies
   * it against the card on file), so there is no browser tab to finish in and
   * the copy must not send the user looking for one.
   */
  inPlace: boolean;
  onClose: () => void;
}): React.ReactElement {
  const t = useT();
  const planCards = useCreditsStore((s) => s.planCards);
  const isResume = kind === 'resume';
  // 260725: top up SKUs are an open, server-driven set — anything that is not
  // a paid tier or 'resume' is a top up (mirrors isPurchaseConfirmed).
  const isPlan = kind === 'quest' || kind === 'party';
  const isTopUp = kind !== null && !isResume && !isPlan;
  const product = isTopUp
    ? t('extra credits')
    : isPlan
      ? planName(planCards, kind as PlanTier)
      : t('your plan');

  const title =
    status === 'waiting'
      ? isResume
        ? t('Resume your subscription')
        : inPlace
          ? t('Updating your plan')
          : t('Complete your purchase')
      : status === 'confirmed'
        ? isResume
          ? t('Subscription resumed')
          : inPlace
            ? t('Plan updated')
            : t('Purchase complete')
        : t('Still processing');

  return (
    // Stacked tier (1100): this watcher sits above the base plan screen.
    // ESC / the footer button dismiss it without cancelling the browser purchase.
    <ModalShell
      title={title}
      tier="stacked"
      onClose={onClose}
      aria-label={isResume ? t('Resume subscription status') : t('Checkout status')}
    >
      <div className={styles.checkoutBody}>
        {status === 'waiting' ? (
          <>
            <span className={styles.checkoutSpinner} aria-hidden="true" />
            <p className={styles.checkoutMsg}>
              {isResume
                ? t(
                    "Resume your {product} subscription in your browser. This screen updates automatically once it's confirmed.",
                    { product },
                  )
                : inPlace
                  ? t(
                      "Applying your {product} plan. This screen updates automatically once it's confirmed.",
                      { product },
                    )
                  : t(
                      'Finish checking out for {product} in your browser. This screen updates automatically once the payment is confirmed.',
                      { product },
                    )}
            </p>
          </>
        ) : status === 'confirmed' ? (
          <>
            <span className={styles.checkoutCheck} aria-hidden="true">
              ✓
            </span>
            <p className={styles.checkoutMsg}>
              {isResume
                ? t('Your {product} subscription will continue, with no end date.', { product })
                : isTopUp
                  ? t('Your extra credits are now available.')
                  : t('Your {product} plan is active.', { product })}
            </p>
          </>
        ) : (
          <p className={styles.checkoutMsg}>
            {t(
              'This is taking longer than usual. You can close this; it will update here automatically once it completes.',
            )}
          </p>
        )}
      </div>
      <ModalFooter>
        {status === 'confirmed' ? (
          <Button kind="primary" size="md" onClick={onClose}>
            {t('Done')}
          </Button>
        ) : (
          <Button kind="quiet" size="md" onClick={onClose}>
            {t('Close')}
          </Button>
        )}
      </ModalFooter>
    </ModalShell>
  );
}
