/**
 * UpdatedToast: the "Updated to vX" confirmation after an accepted update
 * relaunches Sei (261023).
 *
 * The user read the changelog in the "Update available" popup before saying
 * yes, so the relaunch does not open the full what's-new modal again; it says
 * the update landed and repeats the headline. Mandatory updates (whose
 * changelog was never shown) still get the modal (UpdatePopup whats-new).
 *
 * Top-right under the header row, clear of the chat composer. Never blocks,
 * closes itself after TOAST_MS, and has a close button. This file
 * used to be UpdatePill, the corner download/restart card that the sidebar
 * button replaced.
 *
 * Sits at z 700: above the MiniTile return card (600), below every ModalShell
 * tier (1000+).
 */
import React, { useEffect } from 'react';
import { useT } from '../lib/i18n';
import { useUpdateStore } from '../lib/stores/useUpdateStore';
import { CloseIcon } from './icons';
import styles from './UpdatedToast.module.css';

export const TOAST_MS = 10_000;

export function UpdatedToast(): React.ReactElement | null {
  const t = useT();
  const toast = useUpdateStore((s) => s.toast);
  const dismiss = useUpdateStore((s) => s.dismissToast);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(dismiss, TOAST_MS);
    return () => clearTimeout(id);
  }, [toast, dismiss]);

  if (!toast) return null;
  return (
    <div className={styles.card} role="status" aria-live="polite">
      <div className={styles.text}>
        <div className={styles.title}>{t('Updated to Sei {version}', { version: toast.version })}</div>
        {toast.headline ? <p className={styles.body}>{toast.headline}</p> : null}
      </div>
      <button type="button" className={styles.close} onClick={dismiss} aria-label={t('Close')}>
        <CloseIcon size={14} />
      </button>
    </div>
  );
}




