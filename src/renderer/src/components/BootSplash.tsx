/**
 * BootSplash (261029): what the window shows while App's boot routing decides
 * the first view. That wait used to render an empty fragment, which was fine
 * while it took a frame, but it waits for main's auth state, and once the
 * startup splash window had closed an empty fragment was a blank window.
 */
import React from 'react';
import { SeiPixelMark } from './SeiPixelMark';
import styles from './BootSplash.module.css';

export function BootSplash(): React.ReactElement {
  return (
    <div className={styles.root} data-boot-splash="" role="status" aria-label="Loading Sei">
      <SeiPixelMark height={92} color="currentColor" className={styles.mark} />
    </div>
  );
}
