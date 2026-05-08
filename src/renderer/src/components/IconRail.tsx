/**
 * IconRail / Sidebar — 72px wide sidebar.
 *
 * Top→bottom (D-34): Home → divider → Minecraft (MCBlock, always active) →
 * Add game (Plus) → flex-spacer → Theme toggle → Settings.
 *
 * NO "Sei" wordmark in the rail (D-34 — user removed iteration 5).
 *
 * Source: 04-UI-SPEC.md §Component Inventory → IconRail/Sidebar.
 */

import React from 'react';
import styles from './IconRail.module.css';
import {
  HomeIcon,
  MCBlock,
  PlusIcon,
  SettingsIcon,
  SunIcon,
  MoonIcon,
} from './icons';
import { useUiStore } from '../lib/stores/useUiStore';
import { applyTheme } from '../lib/theme';

interface RailButtonProps {
  active?: boolean;
  onClick?: () => void;
  title?: string;
  badge?: boolean;
  muted?: boolean;
  children: React.ReactNode;
}

function RailButton({
  active,
  onClick,
  title,
  badge,
  muted,
  children,
}: RailButtonProps): React.ReactElement {
  const cls = [
    styles.railButton,
    active ? styles.active : '',
    muted ? styles.muted : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button onClick={onClick} title={title} className={cls} type="button">
      {active && <span className={styles.activeBar} aria-hidden="true" />}
      {children}
      {badge && <span className={styles.badge} aria-hidden="true" />}
    </button>
  );
}

export function IconRail(): React.ReactElement {
  const view = useUiStore((s) => s.view);
  const navigate = useUiStore((s) => s.navigate);
  const themeMode = useUiStore((s) => s.themeMode);
  const setThemeMode = useUiStore((s) => s.setThemeMode);

  // Resolve the *currently displayed* light/dark mode for the toggle icon
  // (themeMode='system' resolves via prefers-color-scheme).
  const resolvedDark =
    themeMode === 'dark' ||
    (themeMode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

  const homeActive =
    view.kind === 'home' || view.kind === 'character' || view.kind === 'add-character';

  const toggleTheme = () => {
    const next = resolvedDark ? 'light' : 'dark';
    setThemeMode(next);
    applyTheme(next);
  };

  return (
    <nav className={styles.rail} aria-label="Primary">
      <div className={styles.cluster}>
        <RailButton
          active={homeActive}
          onClick={() => navigate({ kind: 'home' })}
          title="Home"
        >
          <HomeIcon size={30} />
        </RailButton>
      </div>

      <div className={styles.divider} />

      <div className={styles.cluster}>
        {/* Minecraft — always active (only registered game). */}
        <RailButton active title="Minecraft">
          <MCBlock size={34} />
        </RailButton>
        <RailButton
          muted
          title="Add game"
          onClick={() => navigate({ kind: 'coming-soon' })}
        >
          <PlusIcon size={26} />
        </RailButton>
      </div>

      <div className={styles.spacer} />

      <div className={styles.cluster}>
        <RailButton
          onClick={toggleTheme}
          title={`Switch to ${resolvedDark ? 'light' : 'dark'} mode`}
        >
          {resolvedDark ? <SunIcon size={26} /> : <MoonIcon size={26} />}
        </RailButton>
        <RailButton
          active={view.kind === 'settings'}
          onClick={() => navigate({ kind: 'settings' })}
          title="Settings"
        >
          <SettingsIcon size={28} />
        </RailButton>
      </div>
    </nav>
  );
}
