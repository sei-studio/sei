/**
 * McInstallRow — single Minecraft install row in the wizard's "Pick installs" step.
 *
 * Renders (left to right):
 *   - Native checkbox (controlled by `selected`)
 *   - Two-line label: persona-style name + mono path
 *   - StatusPill aligned to the right
 *
 * The whole row is clickable AND keyboard-focusable; the checkbox itself is the
 * accessible affordance, but clicks on the row also toggle (matches the
 * "whole-row toggles" pattern in the lan + persona pickers).
 */

import React from 'react';
import type { McInstall } from '@shared/ipc';
import { StatusPill, type StatusPillTone } from './StatusPill';
import { WARN_COPY } from '../lib/errors';
import styles from './McInstallRow.module.css';

export interface McInstallRowProps {
  install: McInstall;
  selected: boolean;
  onToggle: () => void;
}

/**
 * Detect pre-1.14 MC versions (260518-o1k T8). Fabric Loader's current
 * builds require MC ≥ 1.14, so anything older surfaces a warning so
 * the user can deselect that row.
 *
 * Parses `major.minor[.patch]`. Returns false for any unparseable or
 * null input — we don't warn on what we can't read; the link/install
 * step will surface its own error if it actually fails.
 */
function isPre114(v: string | null | undefined): boolean {
  if (typeof v !== 'string') return false;
  const m = /^(\d+)\.(\d+)/.exec(v.trim());
  if (!m) return false;
  const major = parseInt(m[1], 10);
  const minor = parseInt(m[2], 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false;
  if (major < 1) return true; // never occurs for MC, defensive
  return major === 1 && minor < 14;
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
    // No secondary: the path already renders on its own wrapping line in the
    // row. Duplicating a long path into the flex-shrink:0 pill slot squeezed
    // `.text` to near-zero width, so the path wrapped character-by-character
    // straight down the page (the reported "narrow filepath box → scrollable"
    // bug). The lunarCaption below already explains the Limited state.
    return {
      tone: 'warn',
      label: 'Limited',
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
    // No secondary — the path is on its own line (see the lunar note above).
    return {
      tone: 'muted',
      label: 'Vanilla launcher',
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
            Sei can join the same server, but Lunar doesn&rsquo;t support custom
            skin mods, so the bot will appear with a default Mojang skin.
          </div>
        ) : null}
        {/* 260518-o1k T8: pre-1.14 MC inline warning (vanilla only).
            Informational — Continue is not disabled (per D4: no version
            override picker in this task). User can deselect this row and
            proceed. */}
        {install.kind === 'vanilla' && isPre114(install.mc_version) ? (
          <div className={styles.warning}>
            {WARN_COPY.MC_VERSION_PRE_1_14.replace('{version}', install.mc_version!)}
          </div>
        ) : null}
      </div>
      <div className={styles.pillSlot}>
        <StatusPill tone={pill.tone} label={pill.label} secondary={pill.secondary} />
      </div>
    </div>
  );
}
