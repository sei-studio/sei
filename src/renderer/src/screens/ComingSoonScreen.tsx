/**
 * ComingSoonScreen — "Other games" stub.
 *
 * Source: 04-UI-SPEC.md §ComingSoonScreen + 04-07 Task 2.
 */

import React from 'react';
import { useUiStore } from '../lib/stores/useUiStore';
import { Button } from '../components/Button';
import styles from './ComingSoonScreen.module.css';

export function ComingSoonScreen(): React.ReactElement {
  const navigate = useUiStore((s) => s.navigate);
  return (
    <div className={styles.root}>
      <div className={styles.eyebrow}>Other games</div>
      <h1 className={styles.title}>Coming soon.</h1>
      <Button kind="primary" size="md" onClick={() => navigate({ kind: 'home' })}>
        Back to Minecraft
      </Button>
    </div>
  );
}
