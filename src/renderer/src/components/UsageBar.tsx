/**
 * UsageBar — primary credits usage display (260602-hbr).
 *
 * Replaces the "~Xh left" PlaytimePill as the hero usage affordance in
 * CreditsScreen. Renders:
 *   - a usage-percent progress bar (PercentBar fed `usage_pct` from
 *     useCreditsStore) — 0% on a fresh grant, filling to 100% as credits are
 *     spent. A subscription + Quest-pack top-up is additive on the denominator
 *     server-side, so a top-up moves the bar LEFT rather than resetting it.
 *   - a small "~Xh left" playtime estimate beside the bar, with a tooltip
 *     noting it is only an estimate.
 *
 * PROXY-05: the bar surfaces a PERCENT only — no token/dollar counts. The
 * "~Xh left" string is a time estimate derived from `remaining_tokens` via the
 * flat DEFAULT_TOKENS_PER_MIN multiplier, never a raw token/dollar figure.
 */

import React from 'react';
import { useCreditsStore } from '../lib/stores/useCreditsStore';
import { tokensRemainingToPlaytime } from '../lib/playtimeEstimate';
import { PercentBar } from './PercentBar';
import { Button } from './Button';
import { RefreshIcon } from './icons';
import styles from './UsageBar.module.css';

/** Shown on hover/focus of the estimate so the "~Xh left" is never read as a promise. */
export const ESTIMATE_TOOLTIP = 'This is an estimate; actual playtime can vary.';

export interface UsageBarProps {
  /** Bar size — 'lg' is the CreditsScreen hero; 'sm'/'md' for inline rows. */
  size?: 'sm' | 'md' | 'lg';
}

export function UsageBar({ size = 'lg' }: UsageBarProps): React.ReactElement {
  const usagePct = useCreditsStore((s) => s.usage_pct);
  const remainingTokens = useCreditsStore((s) => s.remaining_tokens);
  const refresh = useCreditsStore((s) => s.refresh);
  const loading = useCreditsStore((s) => s.loading);
  const { display } = tokensRemainingToPlaytime(remainingTokens);

  return (
    <div className={styles.root}>
      <div className={styles.barWrap}>
        <PercentBar value={usagePct} size={size} label={`${Math.round(usagePct)} percent used`} />
      </div>
      <span
        className={styles.estimate}
        title={ESTIMATE_TOOLTIP}
        aria-label={`${display}. ${ESTIMATE_TOOLTIP}`}
      >
        {display}
      </span>
      {/* Manual refresh sits to the RIGHT of the estimate — immediate
          creditsGet() on top of CreditsScreen's 60s poll (260606). */}
      <Button
        kind="quiet"
        size="sm"
        icon={<RefreshIcon size={14} />}
        disabled={loading}
        title="Refresh playtime"
        aria-label="Refresh playtime"
        onClick={() => void refresh()}
      />
    </div>
  );
}
