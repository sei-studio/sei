/**
 * ComingSoonScreen — "Other games" stub.
 *
 * Source: 04-UI-SPEC.md §ComingSoonScreen + 04-07 Task 2.
 */

import React from 'react';
import { useUiStore } from '../lib/stores/useUiStore';
import { useT } from '../lib/i18n';
import { Button } from '../components/Button';
import styles from './ComingSoonScreen.module.css';

export function ComingSoonScreen(): React.ReactElement {
  const t = useT();
  const navigate = useUiStore((s) => s.navigate);
  return (
    <div className={styles.root}>
      <div className={styles.eyebrow}>{t('Other games')}</div>
      <h1 className={styles.title}>{t('Coming soon.')}</h1>
      <Button kind="primary" size="md" onClick={() => navigate({ kind: 'home' })}>
        {t('Back to Minecraft')}
      </Button>
    </div>
  );
}
