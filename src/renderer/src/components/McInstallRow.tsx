/**
 * McInstallRow — single Minecraft install row in the wizard's "Pick installs" step.
 *
 * Renders (left to right):
 *   - Native checkbox (controlled by `selected`)
 *   - Two-line label: persona-style name + mono path
 *   - StatusPill aligned to the right (UI-SPEC §"Status indicators — copy" matrix)
 *
 * The whole row is clickable AND keyboard-focusable; the checkbox itself is the
 * accessible affordance, but clicks on the row also toggle (matches Plan 04's
 * existing "the whole row toggles" pattern in lan + persona pickers).
 *
 * Source: 09-UI-SPEC.md §"Component Inventory" McInstallRow + §"Interaction States"
 *         McInstallRow selectable/selected/hover/focus + §"Status indicators — copy".
 */

import React from 'react';
import type { McInstall } from '@shared/ipc';
import { StatusPill, type StatusPillTone } from './StatusPill';
import styles from './McInstallRow.module.css';

export interface McInstallRowProps {
  install: McInstall;
  selected: boolean;
  onToggle: () => void;
}

interface PillSpec {
  tone: StatusPillTone;
  label: string;
  secondary?: string;
}

/**
 * Map a McInstall to its StatusPill descriptor per UI-SPEC §"Status indicators — copy".
 * The pill carries the meaningful status; never rely on color alone (a11y).
 */
function pillFor(install: McInstall): PillSpec {
  // Lunar Client — read-only "Limited" badge (260518-o1k T7).
  // Branched FIRST so it overrides any other state combo.
  if (install.kind === 'lunar') {
    return {
      tone: 'warn',
      label: 'Limited',
      secondary: install.path,
    };
  }

  // Sei-enabled paths first (more specific).
  if (install.sei_enabled) {
    if (install.csl_installed && install.loader && install.loader_version && install.csl_version) {
      // "Sei enabled" — green, full version line.
      const loaderName = install.loader === 'fabric' ? 'Fabric' : 'Forge';
      return {
        tone: 'green',
        label: 'Sei enabled',
        secondary: `${loaderName} ${install.loader_version} · CSL ${install.csl_version}`,
      };
    }
    if (!install.csl_installed) {
      return {
        tone: 'red',
        label: 'Mod missing',
        secondary: 'Re-run setup to reinstall.',
      };
    }
    // Edge case: enabled + csl_installed but missing loader info — flag as drift.
    return {
      tone: 'warn',
      label: 'Version drift',
      secondary: 'Re-run setup to update.',
    };
  }

  // Not Sei-enabled — muted pill keyed off install kind.
  if (install.kind === 'vanilla') {
    return {
      tone: 'muted',
      label: 'Vanilla launcher',
      secondary: install.path,
    };
  }
  return {
    tone: 'muted',
    label: install.label,
    secondary: `CurseForge · ${install.mc_version ?? '?'}`,
  };
}

export function McInstallRow({ install, selected, onToggle }: McInstallRowProps): React.ReactElement {
  const pill = pillFor(install);
  const checkboxId = `mc-install-${install.id}`;
  // 260518-o1k T7: Lunar rows are read-only — surfaced for transparency
  // only, with the checkbox disabled and the row's onClick a no-op.
  const isReadOnly = install.kind === 'lunar';

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (isReadOnly) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onToggle();
    }
  };

  const handleClick = (): void => {
    if (isReadOnly) return;
    onToggle();
  };

  return (
    <div
      role={isReadOnly ? undefined : 'button'}
      tabIndex={isReadOnly ? -1 : 0}
      aria-pressed={isReadOnly ? undefined : selected}
      aria-disabled={isReadOnly || undefined}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={[
        styles.row,
        selected && !isReadOnly ? styles.selected : '',
        isReadOnly ? styles.readOnly : '',
      ].filter(Boolean).join(' ')}
    >
      <input
        id={checkboxId}
        type="checkbox"
        className={styles.checkbox}
        checked={selected && !isReadOnly}
        onChange={onToggle}
        disabled={isReadOnly}
        // Stop propagation so the row's onClick doesn't double-toggle when the
        // user clicks the checkbox itself.
        onClick={(e) => e.stopPropagation()}
        aria-label={`Enable Sei for ${install.label}`}
        tabIndex={-1}
      />
      <div className={styles.text}>
        <div className={styles.label}>{install.label}</div>
        <div className={styles.path}>{install.path}</div>
        {install.kind === 'lunar' ? (
          <div className={styles.lunarCaption}>
            Sei can connect to the same server you play on, but Lunar doesn&rsquo;t
            support custom skin mods &mdash; the bot will appear with a default
            Mojang skin.
          </div>
        ) : null}
      </div>
      <div className={styles.pillSlot}>
        <StatusPill tone={pill.tone} label={pill.label} secondary={pill.secondary} />
      </div>
    </div>
  );
}
