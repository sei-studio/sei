/**
 * MacosWindow / AppWindow — outer chrome (the "Summoning Terminal" shell).
 *
 * Full-bleed dark window with a thin top bar carrying a small "Sei Launcher"
 * mark. The bar doubles as the drag strip so the frameless window stays
 * movable and the OS window controls have clearance
 * (macOS draws the REAL traffic lights in the inset position — D-32; Windows
 * draws its overlay controls). Interactive children opt out via
 * -webkit-app-region: no-drag where needed.
 *
 * Mounts the HUD overlay layers (grain + vignette) once, above all content
 * (.hud-overlays in global.css), so every screen inherits the terminal
 * atmosphere. Overlays are pointer-events:none. (The mockup's scanline + accent
 * "sweep" layers are intentionally off — they read as a distracting scan.)
 *
 * Source: .planning/UI-DESIGN-SYSTEM.md §Window shell; mockup ui.jsx titlebar.
 */

import React from 'react';
import styles from './MacosWindow.module.css';

interface MacosWindowProps {
  /** Kept for back-compat; the window no longer renders a visible title bar. */
  subtitle?: string | null;
  children?: React.ReactNode;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function MacosWindow({ subtitle: _subtitle, children }: MacosWindowProps): React.ReactElement {
  return (
    <div className={styles.window}>
      {/*
        No visible title bar (the SEI mark + clock strip was removed). A thin
        transparent drag strip remains so the frameless window stays movable and
        the OS window controls (macOS traffic lights / Windows overlay) have
        clearance above the content.
      */}
      <div className={styles.dragStrip}>
        <span className={styles.titleLabel}>Sei Launcher</span>
        <span className={styles.versionTag}>v0.2.0</span>
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
