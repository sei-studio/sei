/**
 * The own-key spend alert (261110): one line at the top of the app when this
 * month's estimated own-key spend passes the "Alert me at $N a month" amount
 * (main's usage ledger fires it once a month, usage:spend-alert). It only
 * warns: nothing is paused or blocked.
 */
import React, { useEffect, useState } from 'react';
import { formatUsd } from '@shared/llmUsage';
import { sei } from '../../lib/ipcClient';
import { useT } from '../../lib/i18n';
import { useUiStore } from '../../lib/stores/useUiStore';
import { NoticeLine } from '../NoticeLine';
import styles from '../../screens/PlaytimeScreen.module.css';

export function SpendAlertBanner(): React.ReactElement | null {
  const t = useT();
  const navigate = useUiStore((s) => s.navigate);
  const [alert, setAlert] = useState<{ limitUsd: number } | null>(null);

  useEffect(() => sei.onSpendAlert?.((e) => setAlert({ limitUsd: e.limitUsd })) ?? undefined, []);

  if (!alert) return null;
  // The quiet register's one-line notice: the line itself opens My keys.
  return (
    <div className={styles.alertBanner}>
      <NoticeLine
        text={t('Your own key spend passed {amount} this month.', { amount: formatUsd(alert.limitUsd) })}
        onAction={() => {
          setAlert(null);
          navigate({ kind: 'credits', tab: 'mykeys' });
        }}
        onDismiss={() => setAlert(null)}
        dataAttrs={{ 'data-testid': 'spend-alert-banner' }}
      />
    </div>
  );
}
