/**
 * CreditsScreen — Playtime plan-picker surface (revamped 260602-uv9, 260603).
 *
 * Layout (Party redesign, mockup .pt-*): a centered 620px column —
 *   - BackRow + a percent-used HERO: "{pct}% used" (Oswald) + a flat accent
 *     usage bar and a quiet refresh, with a renewal/end-date sub-line for
 *     active subscribers. (260705: was "{pct}% left" over a remaining-fill
 *     bar, which read as its opposite; the "~Xh left" estimate was removed.)
 *   - An "Add playtime" section with THREE plan cards (Encounter / Quest /
 *     Party). Each card body reads: plan NAME → big money number → small
 *     "~X hours of playtime" line → button.
 *       - Trial: "Free", "~1 hour", "Claim" → claimTrial() → "Claimed" once the
 *         server confirms the grant. Claim is one-shot and SERVER-AUTHORITATIVE:
 *         the button only mirrors `trial_claimed` from the credits snapshot; it
 *         never grants anything itself (see useCreditsStore.claimTrial).
 *       - Quest: "$5" (one time), "~5 hours", "Purchase" → openCheckout('pack')
 *         directly (one-time pack; NO consent gate).
 *       - Party: "$20" (/month), "~20 hours", "Subscribe" → AutoRenewalConsentModal
 *         → openCheckout('subscription'). When already subscribed the button reads
 *         "Subscribed" (disabled) and the card outline is highlighted. The consent
 *         gate is LEGALLY REQUIRED (CA ARL §17602(b)) and must never be bypassed;
 *         the CA ARL §17602(a)(1) pre-purchase disclosure now lives INSIDE that
 *         modal (the request-for-consent surface) rather than as a box on the card.
 *     Below the three cards, Party subscribers see a small note: the renewal
 *     date while auto-renewing, or "will not renew — access ends {date}" once
 *     the subscription is cancel-scheduled.
 *   - A single bottom "Manage billing" button (Polar customer-portal flow via
 *     handleManage) + a muted estimate disclaimer. The button shows an "Opening…"
 *     pending state and an inline error when the portal can't be opened (no Polar
 *     customer yet, signed out, network) so it's never a silent no-op.
 *
 * Checkout opens in the user's system browser (shell.openExternal in the main
 * process) — 260603 reverted the in-app popup BrowserWindow.
 *
 * 260602-uv9 PROXY-05 override: this screen INTENTIONALLY renders dollar amounts
 * ($0 / $5 one-time / $20 per month) and "~X hours" marketing copy on the plan
 * cards — an explicit user reversal of the prior "no monetary amounts"
 * bright-line for this surface. The PROXY-05 percent-only rule still governs the
 * IPC / store state shape (useCreditsStore carries NO token/dollar/micro fields,
 * `usage_pct` / `remaining_tokens` only); only the RENDERED card copy changes.
 *
 * Layout idioms (BackRow + h1 + section + sectionTitle) mirror SettingsScreen.tsx
 * for visual rhythm with the sibling icon-rail screen.
 *
 * Sources:
 *   - 260602-uv9-CONTEXT.md (domain + decisions; PROXY-05 override)
 *   - src/renderer/src/lib/stores/useCreditsStore.ts (selectors + claimTrial)
 */

import React, { useEffect, useState } from 'react';
import { useCreditsStore } from '../lib/stores/useCreditsStore';
import { useUiStore } from '../lib/stores/useUiStore';
import { Button } from '../components/Button';
import { ModalShell, ModalFooter } from '../components/ModalShell';
import { BackIcon, RefreshIcon } from '../components/icons';
import { formatPlayed } from '../components/UsageBar';
import { sei } from '../lib/ipcClient';
import { AutoRenewalConsentModal } from '../components/AutoRenewalConsentModal';
import { FeedbackRewardCard } from '../components/FeedbackRewardCard';
import { FeedbackModal } from '../components/FeedbackModal';
import { formatRenewal } from '../lib/formatRenewal';
import styles from './CreditsScreen.module.css';

/** Estimate disclaimer shown in the footer (matches ESTIMATE_TOOLTIP spirit). */
const ESTIMATE_DISCLAIMER = 'Estimates only. Actual playtime varies by usage.';

/**
 * 260706 — lifetime spend (used_usd) at which the one-time feedback-for-reward
 * banner appears. By $0.50 the user has played enough to have real opinions.
 */
const FEEDBACK_PROMPT_USD = 0.5;

/** Plain-English copy for the (rare) trial-claim failure branches. */
function claimErrorCopy(code: string): string {
  switch (code) {
    case 'already_claimed':
      return 'Encounter already claimed.';
    case 'device_claimed':
      // Per-device anti-abuse gate: this machine already spent its one free
      // trial (possibly under a different account). Distinct from the
      // account-level "already claimed" so the message isn't misleading.
      return 'This device already used its free Encounter. Try Quest or Party below.';
    default:
      return 'Could not claim. Please try again.';
  }
}

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
      // No Polar customer on record yet (trial-only / never purchased) or the
      // billing backend is unavailable — nothing to manage.
      return 'No billing to manage yet. Purchase or subscribe first.';
    default:
      return 'Could not open billing. Please try again.';
  }
}

export function CreditsScreen(): React.ReactElement {
  // Separate selectors so React only re-subscribes the slices we read.
  // The hero reads usage_pct (number + bar fill).
  const usagePct = useCreditsStore((s) => s.usage_pct);
  const loading = useCreditsStore((s) => s.loading);
  const plan = useCreditsStore((s) => s.plan);
  const renewsAt = useCreditsStore((s) => s.renews_at);
  const endsAt = useCreditsStore((s) => s.ends_at);
  const subscriptionStatusRaw = useCreditsStore((s) => s.subscription_status_raw);
  const trialClaimed = useCreditsStore((s) => s.trial_claimed);
  const claimTrial = useCreditsStore((s) => s.claimTrial);
  const beginPurchase = useCreditsStore((s) => s.beginPurchase);
  const beginResume = useCreditsStore((s) => s.beginResume);
  const dismissCheckout = useCreditsStore((s) => s.dismissCheckout);
  const checkoutStatus = useCreditsStore((s) => s.checkoutStatus);
  const checkoutKind = useCreditsStore((s) => s.checkoutKind);
  const cancelSubscription = useCreditsStore((s) => s.cancelSubscription);
  const refresh = useCreditsStore((s) => s.refresh);
  const navigate = useUiStore((s) => s.navigate);
  // Party ('Subscribe') routes through the consent gate (CA ARL §17602(b))
  // before checkout. Quest ('Purchase') is a one-time pack — no consent gate.
  const [showConsentModal, setShowConsentModal] = useState(false);
  // Trial claim is one-shot + server-authoritative; local state only drives the
  // button's transient label and the (rare) failure note.
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  // Terminal "this DEVICE already used its trial" state. Once the server tells
  // us the per-device gate refused the grant, re-clicking "Claim" can only
  // re-fail — so we lock the button into a disabled "Unavailable" state instead
  // of leaving it a clickable dead-end (account stays trial_claimed=false, so
  // the button would otherwise re-enable).
  const [deviceBlocked, setDeviceBlocked] = useState(false);
  // "Manage billing" portal request: pending label + inline error so a failed
  // (or no-op) portal open is visible instead of silently doing nothing.
  const [managing, setManaging] = useState(false);
  const [manageError, setManageError] = useState<string | null>(null);
  // A checkout is "in flight" from the click until the watch modal is dismissed.
  // Drives the Purchase/Subscribe button disabled state so the user can't kick
  // off a second checkout while one is being watched.
  const checkoutActive = checkoutStatus !== 'idle';

  // Hero shows percent USED with a matching usage fill (260705: the previous
  // "{pct}% left" number over a remaining-fill bar read as its opposite — a
  // filled bar universally parses as consumption). The "~Xh left" playtime
  // estimate that sat beside the bar is removed (user direction, same date).
  const usedPct = Math.max(0, Math.min(100, Math.round(usagePct)));

  // Hover on the bar shows total time played (260705). Sourced from
  // UserConfig.total_playtime_ms — accumulated at session-end in botSupervisor
  // and seeded from historical characters, so it survives deletion (same
  // source the old UsageBar tooltip used).
  const [totalPlaytimeMs, setTotalPlaytimeMs] = useState(0);
  // 260706 — feedback reward banner. `null` = config not read yet (render
  // neither the banner nor the standing button, so nothing flashes).
  const [rewardClaimed, setRewardClaimed] = useState<boolean | null>(null);
  const [showFeedbackModal, setShowFeedbackModal] = useState(false);
  const usedUsd = useCreditsStore((s) => s.used_usd);
  // Feedback surfaces are cloud-only: the proxy endpoints need a Supabase
  // session, and the reward is a cloud-ledger grant. BYOK/local users never
  // see the banner or the standing button.
  const cloudMode = useCreditsStore((s) => s.ai_backend_kind) === 'cloud-proxy';
  useEffect(() => {
    let cancelled = false;
    void sei.getConfig().then((c) => {
      if (cancelled) return;
      setTotalPlaytimeMs(c.total_playtime_ms ?? 0);
      setRewardClaimed(c.feedback_reward_claimed ?? false);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const playedTip = `Played ${formatPlayed(totalPlaytimeMs)} total`;

  // Immediate creditsGet() on top of the 60s poll; re-read the playtime total
  // so the tooltip stays fresh after a session ends.
  const handleRefresh = (): void => {
    void refresh();
    void sei.getConfig().then((c) => setTotalPlaytimeMs(c.total_playtime_ms ?? 0));
  };

  // Pull a fresh playtime snapshot when the page opens, then poll every 60s
  // while it stays open (260606). The app-level init() seeds + subscribes to IPC
  // pushes, but those only fire on a proxied bot call; without this, an idle
  // Playtime screen would show a stale estimate. Cleared on unmount.
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
    // flips off 'cancelled' — NOT a new subscription that would bill immediately.
    void beginResume();
  };

  const handleClaim = async (): Promise<void> => {
    if (trialClaimed || claiming || deviceBlocked) return;
    setClaimError(null);
    setClaiming(true);
    try {
      const res = await claimTrial();
      if (!res.ok) {
        setClaimError(claimErrorCopy(res.code));
        // Device-gate refusal is terminal for this machine — lock the button so
        // it isn't a dead-end the user keeps clicking.
        if (res.code === 'device_claimed') setDeviceBlocked(true);
      }
    } finally {
      setClaiming(false);
    }
  };

  const handlePurchase = (): void => {
    if (checkoutActive) return;
    // Opens the pack checkout in the browser AND starts the high-freq watch
    // (modal + polling) — see useCreditsStore.beginPurchase.
    void beginPurchase('pack');
  };

  const renewalText = formatRenewal(renewsAt);
  // 'unlimited' is the internal subscription enum; user-facing label is 'Party'.
  // Cancel-scheduled subs keep plan='unlimited' (full access until ends_at), so
  // the active interface (highlighted card) is preserved either way.
  const isSubscribed = plan === 'unlimited';
  // "To be cancelled": still subscribed but set to cancel at period end — show
  // the end date + a Resume CTA instead of the renewal line + "Subscribed".
  const cancelScheduled = isSubscribed && subscriptionStatusRaw === 'cancelled';
  const endsText = formatRenewal(endsAt);

  // Renewal / end-date sub-line beside the hero (kept from the prior USAGE
  // section — subscribers only).
  const heroSub = cancelScheduled && endsText
    ? `Subscription ends ${endsText}`
    : isSubscribed && renewalText
      ? `Next renewal ${renewalText}`
      : null;

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
          {/* Standing feedback entry point once the one-time reward banner
              has been used (260706). */}
          {cloudMode && rewardClaimed === true ? (
            <Button kind="quiet" size="sm" onClick={() => setShowFeedbackModal(true)}>
              Submit feedback
            </Button>
          ) : null}
        </div>

        {/* One-time feedback-for-reward banner: appears after $0.50 of
            lifetime spend, retires permanently once submitted (260706). */}
        {cloudMode && rewardClaimed === false && (usedUsd ?? 0) >= FEEDBACK_PROMPT_USD ? (
          <FeedbackRewardCard onDone={() => setRewardClaimed(true)} />
        ) : null}

        {/* Hero — "{pct}% used" + refresh beside it + matching usage fill (260705). */}
        <div className={styles.hero}>
          <div className={styles.heroTop}>
            <div className={styles.heroBig}>
              {usedPct}%<small>used</small>
            </div>
            {/* Immediate creditsGet() on top of the 60s poll (260606). */}
            <Button
              kind="quiet"
              size="sm"
              icon={<RefreshIcon size={14} />}
              disabled={loading}
              title="Refresh playtime"
              aria-label="Refresh playtime"
              onClick={handleRefresh}
            />
          </div>
          <div
            className={styles.heroBar}
            data-tip={playedTip}
            data-tip-instant=""
            aria-label={playedTip}
            tabIndex={0}
          >
            <i style={{ width: `${usedPct}%` }} />
          </div>
          {heroSub ? <p className={styles.heroSub}>{heroSub}</p> : null}
        </div>

        {/* Add playtime — three plan cards: Encounter / Quest / Party (mockup .plans). */}
        <div className={styles.plans}>
          <h3 className={styles.plansTitle}>Add playtime</h3>
          <div className={styles.plansRow}>
            {/* Encounter — claim the one-time free trial (Supabase-backed). */}
            <div className={styles.planCard}>
              <span className={styles.planName}>Encounter</span>
              <span className={styles.planPrice}>Free</span>
              <span className={styles.planPlaytime}>~1 hour to try</span>
              {claimError ? <p className={styles.claimError}>{claimError}</p> : null}
              <div className={styles.planCardActions}>
                <Button
                  kind="accent"
                  size="sm"
                  fullWidth
                  disabled={trialClaimed || claiming || deviceBlocked}
                  aria-disabled={trialClaimed || claiming || deviceBlocked}
                  onClick={() => void handleClaim()}
                >
                  {trialClaimed
                    ? 'Claimed'
                    : deviceBlocked
                      ? 'Unavailable'
                      : claiming
                        ? 'Claiming…'
                        : 'Claim'}
                </Button>
              </div>
            </div>

            {/* Quest — one-time pack; opens checkout directly (no consent gate). */}
            <div className={styles.planCard}>
              <span className={styles.planName}>Quest</span>
              <span className={styles.planPrice}>
                $5<span className={styles.planPriceQualifier}>one time</span>
              </span>
              <span className={styles.planPlaytime}>~5 hours</span>
              <div className={styles.planCardActions}>
                <Button
                  kind="accent"
                  size="sm"
                  fullWidth
                  disabled={checkoutActive}
                  onClick={handlePurchase}
                >
                  Purchase
                </Button>
              </div>
            </div>

            {/* Party — subscription; MUST flow through the consent gate. */}
            <div className={`${styles.planCard} ${isSubscribed ? styles.planCardActive : ''}`}>
              <span className={styles.planName}>Party</span>
              <span className={styles.planPrice}>
                $20<span className={styles.planPriceQualifier}>/mo</span>
              </span>
              <span className={styles.planPlaytime}>~20 hours monthly</span>
              <div className={styles.planCardActions}>
                {cancelScheduled ? (
                  // Resume the existing to-be-cancelled sub (Polar portal uncancel)
                  // rather than starting a new one that bills immediately.
                  <Button
                    kind="primary"
                    size="sm"
                    fullWidth
                    disabled={checkoutActive}
                    onClick={handleResume}
                  >
                    Resume
                  </Button>
                ) : isSubscribed ? (
                  <Button kind="primary" size="sm" fullWidth disabled aria-disabled>
                    Subscribed
                  </Button>
                ) : (
                  <Button
                    kind="primary"
                    size="sm"
                    fullWidth
                    disabled={checkoutActive}
                    onClick={() => setShowConsentModal(true)}
                  >
                    Subscribe
                  </Button>
                )}
              </div>
            </div>
          </div>

          {/*
            Renewal note under the cards for Party subscribers: the renewal date
            while auto-renewing, or a "won't renew" line once the subscription is
            cancel-scheduled (still active until ends_at). Subscribers only.
          */}
          {cancelScheduled ? (
            <p className={styles.planRenewalNote}>
              {endsText
                ? `Your Party plan will not renew. Access ends ${endsText}.`
                : 'Your Party plan will not renew.'}
            </p>
          ) : isSubscribed && renewalText ? (
            <p className={styles.planRenewalNote}>Your Party plan renews on {renewalText}.</p>
          ) : null}
        </div>

        {/*
          Footer: "Manage billing" (Polar customer-portal flow via handleManage,
          shown for everyone; never-subscribed users no-op gracefully — FTC
          Click-to-Cancel online cancel path) + the estimate disclaimer.
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
          <span className={styles.disc}>{ESTIMATE_DISCLAIMER}</span>
        </div>
        {manageError ? <p className={styles.manageError}>{manageError}</p> : null}
      </div>

      {showConsentModal ? (
        <AutoRenewalConsentModal
          onClose={() => setShowConsentModal(false)}
          // Consent recorded + browser checkout opened → start the watch (the
          // browser is already open, so don't re-open it).
          onProceed={() => void beginPurchase('subscription', { alreadyOpened: true })}
        />
      ) : null}

      {/* "Complete your purchase in your browser" watcher — stays up while we
          poll for the webhook-driven grant (useCreditsStore.beginPurchase).
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
 * update automatically" copy while polling, a success state when the grant
 * lands, and a timeout state that reassures the credits will still update once
 * the payment completes (the store's focus-refetch backstop + push channel).
 * ESC / the button dismiss it without cancelling the browser purchase.
 */
function CheckoutWaitingModal({
  status,
  kind,
  onClose,
}: {
  status: 'waiting' | 'confirmed' | 'timeout';
  kind: 'pack' | 'subscription' | 'resume' | null;
  onClose: () => void;
}): React.ReactElement {
  const isResume = kind === 'resume';
  const product = kind === 'pack' ? 'Quest' : 'Party';

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
    // Stacked tier (1100): this watcher sits above the base playtime screen.
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
                : `Finish checking out for ${product} in your browser. Your credits update here automatically once the payment is confirmed.`}
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
                : `Your ${product} credits are now available.`}
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
