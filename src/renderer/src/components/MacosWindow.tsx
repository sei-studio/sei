/**
 * MacosWindow / AppWindow — outer chrome (the "Summoning Terminal" shell).
 *
 * Full-bleed dark window with a thin top bar carrying a small "Sei"
 * mark. The bar doubles as the drag strip so the frameless window stays
 * movable and the OS window controls have clearance.
 *
 * Platform chrome:
 *  - macOS: native traffic lights (titleBarStyle: hiddenInset). The "Sei
 *    Launcher" mark is pushed right, past the rail, so it clears them.
 *  - Windows / Linux: frameless. The mark sits at the far LEFT (where macOS
 *    puts its traffic lights — there is nothing there on Windows) and we render
 *    our own min / maximize / close controls on the RIGHT, styled to match the
 *    dark chrome (the old native titleBarOverlay buttons clashed and sometimes
 *    went missing). Controls opt out of the drag region via no-drag.
 *
 * Mounts the HUD overlay layers (grain + vignette) once, above all content.
 *
 * Source: .planning/UI-DESIGN-SYSTEM.md §Window shell; mockup ui.jsx titlebar.
 */

import React, { useEffect, useState } from 'react';
import { sei } from '../lib/ipcClient';
import styles from './MacosWindow.module.css';

interface MacosWindowProps {
  /** Kept for back-compat; the window no longer renders a visible title bar. */
  subtitle?: string | null;
  /**
   * True on the full-page entry surfaces (onboarding / auth / skin-setup) where
   * App.tsx omits the IconRail. When set, the top-bar hairline spans the full
   * width — including the segment under the macOS traffic lights — instead of
   * being inset to the content area (its default, which avoids a seam where the
   * bar meets the rail).
   */
  railHidden?: boolean;
  children?: React.ReactNode;
}

/**
 * Custom window controls for frameless (Windows/Linux) builds. Each button
 * opts out of the drag region and calls the matching main-process handler.
 */
function WindowControls(): React.ReactElement {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    void sei.windowIsMaximized().then(setMaximized).catch(() => {});
    return sei.onWindowMaximizedChanged(setMaximized);
  }, []);

  return (
    <div className={styles.controls}>
      <button
        className={styles.ctlBtn}
        onClick={() => void sei.windowMinimize()}
        aria-label="Minimize"
        title="Minimize"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <rect x="1" y="4.5" width="8" height="1" fill="currentColor" />
        </svg>
      </button>
      <button
        className={styles.ctlBtn}
        onClick={() => void sei.windowMaximizeToggle()}
        aria-label={maximized ? 'Restore' : 'Maximize'}
        title={maximized ? 'Restore' : 'Maximize'}
      >
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="1" y="2.5" width="6" height="6" fill="none" stroke="currentColor" strokeWidth="1" />
            <path d="M3.5 2.5 V1 H9 V6.5 H7.5" fill="none" stroke="currentColor" strokeWidth="1" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="1" y="1" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="1" />
          </svg>
        )}
      </button>
      <button
        className={`${styles.ctlBtn} ${styles.ctlClose}`}
        onClick={() => void sei.windowClose()}
        aria-label="Close"
        title="Close"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M1 1 L9 9 M9 1 L1 9" stroke="currentColor" strokeWidth="1.1" />
        </svg>
      </button>
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function MacosWindow({ subtitle: _subtitle, railHidden = false, children }: MacosWindowProps): React.ReactElement {
  // Track the real packaged version (app.getVersion via IPC) instead of a
  // hardcoded literal — Settings reads the same source, so the two never drift.
  const [version, setVersion] = useState<string>('');
  useEffect(() => {
    void sei
      .getVersion()
      .then(setVersion)
      .catch(() => setVersion(''));
  }, []);

  // Only Windows runs frameless with our custom controls (mark at far left,
  // min/max/close at right). macOS keeps native traffic lights + the
  // rail-cleared mark; Linux keeps its native window frame, so neither renders
  // the custom controls.
  const isWindows = sei.platform === 'win32';

  return (
    <div className={styles.window}>
      {/*
        Thin drag strip — keeps the frameless window movable and gives the OS /
        custom window controls clearance above the content.
      */}
      <div
        className={`${styles.dragStrip} ${isWindows ? styles.dragStripCustom : ''} ${railHidden ? styles.fullDivider : ''}`}
      >
        <span className={styles.titleLabel}>Sei</span>
        <span className={styles.versionTag}>{version ? `v${version}` : ''}</span>
        {isWindows && <WindowControls />}
      </div>
      <div className={styles.body}>{children}</div>

      {/* HUD atmosphere — mounted once, above all content, never interactive.
          Grain + vignette only (the mockup's scanline + sweep layers are off). */}
      <div className="hud-overlays" aria-hidden="true">
        <div className="hud-grain" />
        <div className="hud-vignette" />
      </div>
    </div>
  );
}
