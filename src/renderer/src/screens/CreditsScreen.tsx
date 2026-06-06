/**
 * CreditsScreen — Playtime plan-picker surface (revamped 260602-uv9, 260603).
 *
 * Layout:
 *   - BackRow + h1 "Playtime" + a USAGE section (UsageBar size="lg" hero +,
 *     for active subscribers, a "Next renewal" line). No plan label — the
 *     prior "No active plan" / "Depleted" text is gone (260603).
 *   - A single PLANS section with THREE side-by-side cards (Trial / Quest /
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
import { BackIcon } from '../components/icons';
// 260602-hbr: primary usage display is a usage-percent progress bar
// (used/available) with a "~Xh left" estimate beside it.
import { UsageBar } from '../components/UsageBar';
import { AutoRenewalConsentModal } from '../components/AutoRenewalConsentModal';
import { formatRenewal } from '../lib/formatRenewal';
import styles from './CreditsScreen.module.css';

/** Reused estimate-disclaimer copy (matches UsageBar's ESTIMATE_TOOLTIP spirit). */
const ESTIMATE_DISCLAIMER = 'Playtime shown is an estimate; actual playtime varies by usage.';

/** Plain-English copy for the (rare) trial-claim failure branches. */
function claimErrorCopy(code: string): string {
  switch (code) {
    case 'already_claimed':
      return 'Trial already claimed.';
    case 'device_claimed':
      // Per-device anti-abuse gate: this machine already spent its one free
      // trial (possibly under a different account). Distinct from the
      // account-level "already claimed" so the message isn't misleading.
      return 'This device already used its free trial. Try Quest or Party below.';
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
      return 'No billing to manage yet — purchase or subscribe first.';
    default:
      return 'Could not open billing. Please try again.';
  }
}

export function CreditsScreen(): React.ReactElement {
  // Separate selectors so React only re-subscribes the slices we read.
  // The UsageBar subscribes to usage_pct + remaining_tokens directly.
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

  return (
    <div className={styles.root}>
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
      <h1 className={styles.title}>Playtime</h1>

      {/* USAGE — usage-percent bar + "~Xh left" estimate + refresh (in UsageBar). */}
      <section className={styles.section}>
        <div className={styles.sectionTitle}>USAGE</div>
        <UsageBar size="lg" />
        {cancelScheduled && endsText ? (
          <p className={styles.muted}>Subscription will end {endsText}</p>
        ) : isSubscribed && renewalText ? (
          <p className={styles.muted}>Next renewal: {renewalText}</p>
        ) : null}
      </section>

      {/* PLANS — three side-by-side cards: Trial / Quest / Party. */}
      <section className={styles.section}>
        <div className={styles.sectionTitle}>PLANS</div>
        <div className={styles.plansRow}>
          {/* Trial — claim the one-time free trial (Supabase-backed). */}
          <div className={styles.planCard}>
            <div className={styles.planName}>Trial</div>
            <div className={styles.planPrice}>Free</div>
            <p className={styles.planPlaytime}>~1 hour of playtime</p>
            {claimError ? <p className={styles.claimError}>{claimError}</p> : null}
            <div className={styles.planCardActions}>
              <Button
                kind="accent"
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
            <div className={styles.planName}>Quest</div>
            <div className={styles.planPrice}>
              $5
              <span className={styles.planPriceQualifier}>one time</span>
            </div>
            <p className={styles.planPlaytime}>~5 hours of playtime</p>
            <div className={styles.planCardActions}>
              <Button kind="accent" disabled={checkoutActive} onClick={handlePurchase}>
                Purchase
              </Button>
            </div>
          </div>

          {/* Party — subscription; MUST flow through the consent gate. */}
          <div className={`${styles.planCard} ${isSubscribed ? styles.planCardActive : ''}`}>
            <div className={styles.planName}>Party</div>
            <div className={styles.planPrice}>
              $20
              <span className={styles.planPriceQualifier}>/month</span>
            </div>
            <p className={styles.planPlaytime}>~20 hours of playtime</p>
            <div className={styles.planCardActions}>
              {cancelScheduled ? (
                // Resume the existing to-be-cancelled sub (Polar portal uncancel)
                // rather than starting a new one that bills immediately.
                <Button kind="primary" disabled={checkoutActive} onClick={handleResume}>
                  Resume
                </Button>
              ) : isSubscribed ? (
                <Button kind="primary" disabled aria-disabled>
                  Subscribed
                </Button>
              ) : (
                <Button
                  kind="primary"
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
          Small note under the three plan cards for Party subscribers: the
          renewal date while auto-renewing, or a "won't renew" line once the
          subscription is cancel-scheduled (still active until ends_at). Shown
          only to subscribers; non-subscribers see nothing here.
        */}
        {cancelScheduled ? (
          <p className={styles.planRenewalNote}>
            {endsText
              ? `Your Party plan will not renew — access ends ${endsText}.`
              : 'Your Party plan will not renew.'}
          </p>
        ) : isSubscribed && renewalText ? (
          <p className={styles.planRenewalNote}>Your Party plan renews on {renewalText}.</p>
        ) : null}
      </section>

      {/*
        Single bottom "Manage billing" button (replaces the per-card portal /
        Unsubscribe links). Routes through handleManage() → Polar customer-portal
        flow. Shown for everyone; never-subscribed users no-op gracefully. FTC
        Click-to-Cancel: this is the online cancel path (no email round-trip).
      */}
      <div className={styles.manageBilling}>
        <Button
          kind="quiet"
          disabled={managing}
          aria-disabled={managing}
          onClick={() => void handleManage()}
        >
          {managing ? 'Opening…' : 'Manage billing'}
        </Button>
      </div>
      {manageError ? <p className={styles.manageError}>{manageError}</p> : null}
      <p className={styles.estimateDisclaimer}>{ESTIMATE_DISCLAIMER}</p>

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
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const isResume = kind === 'resume';
  const product = kind === 'pack' ? 'Quest' : 'Party';

  return (
    <div
      className={styles.checkoutScrim}
      role="dialog"
      aria-modal="true"
      aria-label={isResume ? 'Resume subscription status' : 'Checkout status'}
    >
      <div className={styles.checkoutCard}>
        {status === 'waiting' ? (
          <>
            <span className={styles.checkoutSpinner} aria-hidden="true" />
            <p className={styles.checkoutTitle}>
              {isResume ? 'Resume your subscription' : 'Complete your purchase'}
            </p>
            <p className={styles.checkoutMsg}>
              {isResume
                ? `Resume your ${product} subscription in your browser. This screen updates automatically once it's confirmed.`
                : `Finish checking out for ${product} in your browser. Your credits update here automatically once the payment is confirmed.`}
            </p>
            <div className={styles.checkoutActions}>
              <Button kind="quiet" size="md" onClick={onClose}>
                Close
              </Button>
            </div>
          </>
        ) : status === 'confirmed' ? (
          <>
            <span className={styles.checkoutCheck} aria-hidden="true">
              ✓
            </span>
            <p className={styles.checkoutTitle}>
              {isResume ? 'Subscription resumed' : 'Purchase complete'}
            </p>
            <p className={styles.checkoutMsg}>
              {isResume
                ? `Your ${product} subscription will continue, with no end date.`
                : `Your ${product} credits are now available.`}
            </p>
            <div className={styles.checkoutActions}>
              <Button kind="primary" size="md" onClick={onClose}>
                Done
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className={styles.checkoutTitle}>Still processing</p>
            <p className={styles.checkoutMsg}>
              This is taking longer than usual. You can close this; it will update here
              automatically once it completes.
            </p>
            <div className={styles.checkoutActions}>
              <Button kind="quiet" size="md" onClick={onClose}>
                Close
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
