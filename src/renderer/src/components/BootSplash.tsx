/**
 * BootSplash (261029): what the window shows while App's boot routing decides
 * the first view. That wait used to render an empty fragment, a transparent
 * window once the startup splash window had closed.
 *
 * product call (261123): no logo here. Users read the Sei mark fading in as
 * a loading screen and called launch slow, and the mark itself was only
 * cosmetic. The wait now shows the plain app background until the first view.
 */
import React from 'react';
import styles from './BootSplash.module.css';

export function BootSplash(): React.ReactElement {
  return <div className={styles.root} data-boot-splash="" role="status" aria-label="Loading Sei" />;
}
