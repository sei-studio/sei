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

import React, { useEffect, useState } from 'react';
import { useCreditsStore } from '../lib/stores/useCreditsStore';
import { useUiStore } from '../lib/stores/useUiStore';
import { sei } from '../lib/ipcClient';
import {
  tokensRemainingToPlaytime,
  DEFAULT_TOKENS_PER_MIN,
  VISION_MULTIPLIER,
} from '../lib/playtimeEstimate';
import { PercentBar } from './PercentBar';
import { Button } from './Button';
import { RefreshIcon } from './icons';
import styles from './UsageBar.module.css';

/** Shown on hover/focus of the estimate so the "~Xh left" is never read as a promise. */
export const ESTIMATE_TOOLTIP = 'This is an estimate; actual playtime can vary.';

/** "$1.20", or "$—" when the dollar figure isn't available (local/BYOK, no session, cold-load). */
export function formatUsd(n: number | undefined): string {
  return typeof n === 'number' && Number.isFinite(n) ? `$${n.toFixed(2)}` : '$—';
}

/** Cumulative playtime ms → "3h 17m". */
export function formatPlayed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 60000));
  return `${Math.floor(total / 60)}h ${total % 60}m`;
}

/**
 * Bar hover tooltip. Defaults to "$used/$total used, played Xh Ym", but the
 * dollar figures are developer-only: with `showUsd` false (the default UX —
 * developer console off) the tooltip is just "played Xh Ym", so end users never
 * see raw spend. Flip `showUsd` true (Settings → Show developer console) to
 * reveal the "$used/$total used" prefix.
 */
export function usageTooltip(
  usedUsd: number | undefined,
  totalUsd: number | undefined,
  totalPlaytimeMs: number,
  showUsd = true,
): string {
  const played = `played ${formatPlayed(totalPlaytimeMs)}`;
  return showUsd ? `${formatUsd(usedUsd)}/${formatUsd(totalUsd)} used, ${played}` : played;
}

export interface UsageBarProps {
  /** Bar size — 'lg' is the CreditsScreen hero; 'sm'/'md' for inline rows. */
  size?: 'sm' | 'md' | 'lg';
}

export function UsageBar({ size = 'lg' }: UsageBarProps): React.ReactElement {
  const usagePct = useCreditsStore((s) => s.usage_pct);
  const remainingTokens = useCreditsStore((s) => s.remaining_tokens);
  const usedUsd = useCreditsStore((s) => s.used_usd);
  const totalUsd = useCreditsStore((s) => s.total_usd);
  const refresh = useCreditsStore((s) => s.refresh);
  const loading = useCreditsStore((s) => s.loading);
  // The "$used/$total used" figures are developer-only. Off by default; shown
  // only when Settings → Show developer console is on (ui-A7 flag).
  const devConsoleVisible = useUiStore((s) => s.devConsoleVisible);
  // Cumulative playtime across all of this profile's characters (survives
  // deletion — accumulated at session-end in config). Read from UserConfig.
  const [totalPlaytimeMs, setTotalPlaytimeMs] = useState(0);
  // Phase 15 (D-07): when the vision tier is passive/active the bot renders
  // its surroundings as it plays ('continuous'), which uses more playtime — so
  // the "~Xh left" figure shrinks via VISION_MULTIPLIER on the burn rate. Read
  // the mode from UserConfig (the source of truth Settings writes). This is a
  // cloud-proxy-only surface (UsageBar lives only in CreditsScreen), so D-11
  // holds: BYO/local users never see this shrink. Re-fetched on mount so
  // returning from Settings with the mode changed reflects the new estimate.
  const [autoRenderOn, setAutoRenderOn] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void sei.getConfig().then((c) => {
      if (cancelled) return;
      setAutoRenderOn((c.vision_mode ?? 'on-demand') === 'continuous');
      setTotalPlaytimeMs(c.total_playtime_ms ?? 0);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const rate = autoRenderOn
    ? DEFAULT_TOKENS_PER_MIN * VISION_MULTIPLIER
    : DEFAULT_TOKENS_PER_MIN;
  const { display } = tokensRemainingToPlaytime(remainingTokens, rate);

  const tooltip = usageTooltip(usedUsd, totalUsd, totalPlaytimeMs, devConsoleVisible);

  return (
    <div className={styles.root}>
      <div
        className={styles.barWrap}
        data-tip={tooltip}
        aria-label={tooltip}
        tabIndex={0}
      >
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
        onClick={() => {
          void refresh();
          void sei.getConfig().then((c) => setTotalPlaytimeMs(c.total_playtime_ms ?? 0));
        }}
      />
    </div>
  );
}
