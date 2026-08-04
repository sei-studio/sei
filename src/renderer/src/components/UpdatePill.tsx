/**
 * UpdatePill — non-blocking updater status (260801).
 *
 * An update download used to take over the app: `app:update-progress` pushed
 * the UpdatePopup into its `downloading` state, which is a full ModalShell with
 * a scrim and no dismiss path, so the user sat behind "Downloading update"
 * until it finished. Worse, MANDATORY patch downloads are supposed to be
 * SILENT (updater.ts downloads them without asking), but they emit the same
 * progress events, so a routine patch release blocked a user who never asked
 * for anything.
 *
 * The download is now background work and this is how it reports: a small
 * corner card that never takes the pointer away from the app.
 *
 *   - downloading → label + thin PercentBar, no controls (nothing to decide).
 *   - ready       → "Restart now" / "Later". Either way the update is already
 *                   on disk and autoInstallOnAppQuit applies it on the next
 *                   quit, so "Later" costs the user nothing.
 *
 * The only updater state that still blocks is `forced` (version.json
 * apply:"now"), which stays in UpdatePopup because main is about to restart the
 * app regardless.
 *
 * Sits at z 700: above the MiniTile return card (600) so an overlap stays
 * readable, below every ModalShell tier (1000+).
 */
import React from 'react';
import { useT } from '../lib/i18n';
import { Button } from './Button';
import { PercentBar } from './PercentBar';
import styles from './UpdatePill.module.css';

export type UpdatePillState =
  | { kind: 'downloading'; percent: number }
  | { kind: 'ready' };

export interface UpdatePillProps {
  state: UpdatePillState;
  /** Quit and install the downloaded update now. */
  onRestart: () => void;
  /** Dismiss the ready card for the rest of the session. */
  onDismiss: () => void;
}

export function UpdatePill({ state, onRestart, onDismiss }: UpdatePillProps): React.ReactElement {
  const t = useT();

  if (state.kind === 'downloading') {
    return (
      <div className={styles.card} role="status" aria-live="polite">
        <div className={styles.title}>{t('Downloading update…')}</div>
        <PercentBar
          value={state.percent}
          label={t('Downloading update, {percent} percent', {
            percent: Math.round(state.percent),
          })}
          size="sm"
        />
      </div>
    );
  }

  return (
    <div className={styles.card} role="status" aria-live="polite">
      <div className={styles.title}>{t('Update ready')}</div>
      <p className={styles.body}>{t('Restart Sei to apply it.')}</p>
      <div className={styles.actions}>
        <Button kind="quiet" size="sm" onClick={onDismiss}>
          {t('Later')}
        </Button>
        <Button kind="primary" size="sm" onClick={onRestart}>
          {t('Restart now')}
        </Button>
      </div>
    </div>
  );
}
