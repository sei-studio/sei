/**
 * UsageBar — the weekly-allowance usage bar (260724).
 *
 * A lean primitive: a usage-percent progress bar (PercentBar fed `usage_pct`
 * from useCreditsStore, red once the allowance is spent) with a quiet refresh
 * affordance. The bar carries a "played Xh Ym" hover tooltip sourced from
 * UserConfig.total_playtime_ms.
 *
 * The bar surfaces a PERCENT only. There are no dollar figures, no token counts
 * and no playtime ESTIMATES anywhere on it: the "$used/$total" tooltip and the
 * "~Xh left" text both went away with the weekly-subscription model, which
 * meters an allowance rather than a balance.
 */

import React, { useEffect, useState } from 'react';
import { useCreditsStore } from '../lib/stores/useCreditsStore';
import { sei } from '../lib/ipcClient';
import { PercentBar } from './PercentBar';
import { Button } from './Button';
import { RefreshIcon } from './icons';
import styles from './UsageBar.module.css';

/** Cumulative playtime ms → "3h 17m". */
export function formatPlayed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 60000));
  return `${Math.floor(total / 60)}h ${total % 60}m`;
}

/** Bar hover tooltip: total time played across every companion on this profile. */
export function usageTooltip(totalPlaytimeMs: number): string {
  return `Played ${formatPlayed(totalPlaytimeMs)} total`;
}

export interface UsageBarProps {
  /** Bar size — 'lg' is the hero; 'sm'/'md' for inline rows. */
  size?: 'sm' | 'md' | 'lg';
}

export function UsageBar({ size = 'lg' }: UsageBarProps): React.ReactElement {
  const usagePct = useCreditsStore((s) => s.usage_pct);
  const overLimit = useCreditsStore((s) => s.over_limit);
  const refresh = useCreditsStore((s) => s.refresh);
  const loading = useCreditsStore((s) => s.loading);
  // Last snapshot fetch failed and nothing fresher landed: the store's zeros
  // are placeholders, so don't present "0 percent used" as account truth.
  const snapshotFailed = useCreditsStore((s) => s.snapshotFailed);
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

  const tooltip = snapshotFailed
    ? "Couldn't check your account right now. Refresh to try again."
    : usageTooltip(totalPlaytimeMs);

  return (
    <div className={styles.root}>
      <div
        className={styles.barWrap}
        data-tip={tooltip}
        aria-label={tooltip}
        tabIndex={0}
      >
        <PercentBar
          value={snapshotFailed ? 0 : usagePct}
          size={size}
          overLimit={!snapshotFailed && overLimit}
          label={snapshotFailed ? 'usage unavailable' : `${Math.round(usagePct)} percent used`}
        />
      </div>
      {/* Quiet refresh — immediate creditsGet() on top of any polling caller. */}
      <Button
        kind="quiet"
        size="sm"
        icon={<RefreshIcon size={14} />}
        disabled={loading}
        title="Refresh"
        aria-label="Refresh plan usage"
        onClick={() => {
          void refresh();
          void sei.getConfig().then((c) => setTotalPlaytimeMs(c.total_playtime_ms ?? 0));
        }}
      />
    </div>
  );
}
