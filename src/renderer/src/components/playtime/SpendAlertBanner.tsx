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
import { CloseIcon } from '../icons';
import styles from '../../screens/PlaytimeScreen.module.css';

export function SpendAlertBanner(): React.ReactElement | null {
  const t = useT();
  const navigate = useUiStore((s) => s.navigate);
  const [alert, setAlert] = useState<{ limitUsd: number } | null>(null);

  useEffect(() => sei.onSpendAlert?.((e) => setAlert({ limitUsd: e.limitUsd })) ?? undefined, []);
  // 261120: main keeps the alert until it is dismissed, so a banner that
  // mounts after it fired (no window was open, a full-screen scene, a reload)
  // still shows it.
  useEffect(() => {
    let live = true;
    void Promise.resolve(sei.usageSpendAlertPending?.())
      .then((e) => {
        if (live && e) setAlert((cur) => cur ?? { limitUsd: e.limitUsd });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  if (!alert) return null;
  const dismiss = (): void => {
    setAlert(null);
    void Promise.resolve(sei.usageSpendAlertAck?.()).catch(() => undefined);
  };
  // One line: the text opens My keys, the x dismisses it.
  return (
    <div className={styles.alertBanner} role="status" data-testid="spend-alert-banner">
      <button
        type="button"
        className={styles.alertText}
        onClick={() => {
          dismiss();
          navigate({ kind: 'credits', tab: 'mykeys' });
        }}
      >
        {t('Your own key spend passed {amount} this month.', { amount: formatUsd(alert.limitUsd) })}
      </button>
      <button type="button" className={styles.alertClose} onClick={dismiss} aria-label={t('Dismiss')}>
        <CloseIcon size={14} />
      </button>
    </div>
  );
}




