/**
 * UsageBar — the credits usage bar (Party redesign restyle of 260602-hbr).
 *
 * A lean primitive: a usage-percent progress bar (PercentBar fed `usage_pct`
 * from useCreditsStore) with a quiet refresh affordance. The bar carries the
 * "$used/$total used, played Xh Ym" hover tooltip (developer-gated dollars).
 *
 * The standalone "~Xh left" estimate text was lifted out of here in the Party
 * redesign — it now lives inline in the CreditsScreen hero (mockup .pt-hero).
 * The estimate helpers + ESTIMATE_TOOLTIP still export from this module so that
 * hero (and any other consumer) can reuse them.
 *
 * PROXY-05: the bar surfaces a PERCENT only. The dollar figures ride the
 * developer-gated tooltip (260615 owner-approved exception), never the markup.
 */

import React, { useEffect, useState } from 'react';
import { useCreditsStore } from '../lib/stores/useCreditsStore';
import { useUiStore } from '../lib/stores/useUiStore';
import { sei } from '../lib/ipcClient';
import { PercentBar } from './PercentBar';
import { Button } from './Button';
import { RefreshIcon } from './icons';
import styles from './UsageBar.module.css';

/** Shown on hover/focus of the estimate so the "~Xh left" is never read as a promise. */
export const ESTIMATE_TOOLTIP = 'This is an estimate; actual playtime can vary.';

/** "$1.20", or "$—" when the dollar figure isn't available (local/BYOK, no session, cold-load). */
export function formatUsd(n: number | undefined): string {
  return typeof n === 'number' && Number.isFinite(n) ? `$${n.toFixed(2)}` : '$–';
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
  /** Bar size — 'lg' is the hero; 'sm'/'md' for inline rows. */
  size?: 'sm' | 'md' | 'lg';
}

export function UsageBar({ size = 'lg' }: UsageBarProps): React.ReactElement {
  const usagePct = useCreditsStore((s) => s.usage_pct);
  const usedUsd = useCreditsStore((s) => s.used_usd);
  const totalUsd = useCreditsStore((s) => s.total_usd);
  const refresh = useCreditsStore((s) => s.refresh);
  const loading = useCreditsStore((s) => s.loading);
  // The "$used/$total used" figures are developer-only. Off by default; shown
  // only when Settings → Show developer console is on (ui-A7 flag).
  const devConsoleVisible = useUiStore((s) => s.devConsoleVisible);
  // Cumulative playtime across all of this profile's characters (survives
  // deletion — accumulated at session-end in config). Feeds the bar tooltip.
  const [totalPlaytimeMs, setTotalPlaytimeMs] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void sei.getConfig().then((c) => {
      if (cancelled) return;
      setTotalPlaytimeMs(c.total_playtime_ms ?? 0);
    });
    return () => {
      cancelled = true;
    };
  }, []);

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
      {/* Quiet refresh — immediate creditsGet() on top of any polling caller. */}
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
