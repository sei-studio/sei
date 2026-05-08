/**
 * Banner — top-of-window dismissible notification strip (GUI-05).
 *
 * Used for system-level warnings that aren't tied to a specific action,
 * e.g. KEYCHAIN_FALLBACK_PLAINTEXT on Linux without kwallet/libsecret.
 *
 * Source: 04-09 PLAN Task 1; 04-UI-SPEC §"Plain-English error copy".
 */
import React from 'react';
import styles from './Banner.module.css';

export interface BannerProps {
  kind: 'warn' | 'error' | 'info';
  message: string;
  onDismiss?: () => void;
}

export function Banner({ kind, message, onDismiss }: BannerProps): React.ReactElement {
  return (
    <div className={`${styles.banner} ${styles[kind]}`} role="alert">
      <span className={styles.message}>{message}</span>
      {onDismiss ? (
        <button
          type="button"
          className={styles.dismiss}
          onClick={onDismiss}
          aria-label="Dismiss"
        >
          ×
        </button>
      ) : null}
    </div>
  );
}
