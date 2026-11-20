/**
 * ExperimentalUpdatesRow — Settings → About toggle that opts this install into
 * the beta update channel (config key `advanced_updates`, which keeps its old
 * name because shipped clients store it). Shown to users as "Experimental
 * updates" (261103): beta builds carry features early and not all of them
 * reach stable, so "advanced" undersold the risk.
 *
 * Turning it ON does not save right away. An inline confirm opens under the
 * row; Continue runs the caller's save, Cancel leaves the toggle off. Turning
 * it OFF saves directly, no confirm.
 *
 * Split into a stateless view + a handler factory so the flow is testable
 * without a DOM (no @testing-library in this repo).
 */
import React, { useState } from 'react';
import { Button } from '../Button';
import { InfoTip } from '../InfoTip';
import { Toggle } from '../Toggle';
import { useT } from '../../lib/i18n';
import styles from '../../screens/SettingsScreen.module.css';

export interface ExperimentalUpdatesHandlers {
  onToggle: (next: boolean) => void;
  onContinue: () => void;
  onCancel: () => void;
}

/** The row's flow: ON asks first, OFF saves at once. */
export function experimentalUpdatesHandlers(
  setConfirming: (v: boolean) => void,
  onSave: (next: boolean) => void,
): ExperimentalUpdatesHandlers {
  return {
    onToggle: (next) => {
      if (next) {
        setConfirming(true);
        return;
      }
      setConfirming(false);
      onSave(false);
    },
    onContinue: () => {
      setConfirming(false);
      onSave(true);
    },
    onCancel: () => setConfirming(false),
  };
}

export function ExperimentalUpdatesRowView({
  on,
  confirming,
  onToggle,
  onContinue,
  onCancel,
}: { on: boolean; confirming: boolean } & ExperimentalUpdatesHandlers): React.ReactElement {
  const t = useT();
  return (
    <>
      <div className={[styles.row, confirming ? styles.rowOpen : ''].filter(Boolean).join(' ')}>
        <span className={styles.label}>
          {t('Experimental updates')}
          <InfoTip
            label={t('About experimental updates')}
            text={t(
              'Try new features early. These builds can be buggy, and not every experimental feature makes it into the stable version.',
            )}
          />
        </span>
        <Toggle aria-label={t('Experimental updates')} on={on} onChange={onToggle} />
      </div>
      {confirming && !on ? (
        <div className={styles.inlineConfirm} role="group" aria-label={t('Experimental updates')}>
          <p className={styles.inlineConfirmText} aria-live="polite">
            {t("You'll get new features early, but they can be buggy. Continue?")}
          </p>
          <Button kind="secondary" size="sm" onClick={onCancel}>
            {t('Cancel')}
          </Button>
          <Button kind="primary" size="sm" onClick={onContinue}>
            {t('Continue')}
          </Button>
        </div>
      ) : null}
    </>
  );
}

export function ExperimentalUpdatesRow({
  on,
  onSave,
}: {
  on: boolean;
  onSave: (next: boolean) => void;
}): React.ReactElement {
  const [confirming, setConfirming] = useState(false);
  const handlers = experimentalUpdatesHandlers(setConfirming, onSave);
  return <ExperimentalUpdatesRowView on={on} confirming={confirming} {...handlers} />;
}
