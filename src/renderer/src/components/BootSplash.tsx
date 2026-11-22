/**
 * BootSplash (261029): what the window shows while App's boot routing decides
 * the first view. That wait used to render an empty fragment, which was fine
 * while it took a frame, but it waits for main's auth state, and once the
 * startup splash window had closed an empty fragment was a blank window.
 *
 * 261123: the window's first paint is a static copy of this splash in
 * index.html (so the window can show before the bundle has run). This one
 * replaces it on mount on the same launch clock (lib/bootMark.ts), and both
 * can drag the window (it has no title bar yet on Windows).
 */
import React, { useState } from 'react';
import { SeiPixelMark } from './SeiPixelMark';
import { sei } from '../lib/ipcClient';
import { bootMarkDelayMs } from '../lib/bootMark';
import styles from './BootSplash.module.css';

function launchStartedAt(): unknown {
  try {
    return sei?.launchStartedAt;
  } catch {
    return undefined;
  }
}

export function BootSplash(): React.ReactElement {
  const [delayMs] = useState(() => bootMarkDelayMs(launchStartedAt(), Date.now()));
  return (
    <div className={styles.root} data-boot-splash="" role="status" aria-label="Loading Sei">
      <span className={styles.mark} style={{ animationDelay: `${delayMs}ms` }}>
        <SeiPixelMark height={92} color="currentColor" />
      </span>
    </div>
  );
}
