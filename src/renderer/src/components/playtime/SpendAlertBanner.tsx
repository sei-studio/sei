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
import { Button } from '../Button';
import styles from '../../screens/PlaytimeScreen.module.css';

export function SpendAlertBanner(): React.ReactElement | null {
  const t = useT();
  const navigate = useUiStore((s) => s.navigate);
  const [alert, setAlert] = useState<{ limitUsd: number } | null>(null);

  useEffect(() => sei.onSpendAlert?.((e) => setAlert({ limitUsd: e.limitUsd })) ?? undefined, []);

  if (!alert) return null;
  return (
    <div className={styles.alertBanner} role="status" data-testid="spend-alert-banner">
      <span>{t('Your own key spend passed {amount} this month.', { amount: formatUsd(alert.limitUsd) })}</span>
      <Button
        kind="secondary"
        size="sm"
        onClick={() => {
          setAlert(null);
          navigate({ kind: 'credits', tab: 'mykeys' });
        }}
      >
        {t('Open Playtime')}
      </Button>
      <Button kind="quiet" size="sm" onClick={() => setAlert(null)}>
        {t('Dismiss')}
      </Button>
    </div>
  );
}
