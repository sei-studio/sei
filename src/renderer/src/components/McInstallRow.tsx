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
// Dependency-free CJS data module — the same table the bot's networking stack
// (minecraft-protocol) enforces, so the version named in the pre-1.14 warning
// can never drift from what Sei actually joins. Deep import on purpose
// (mirrors UnsupportedVersionModal): the package root pulls the full protocol
// stack, which must never enter the renderer.
import { supportedVersions } from 'minecraft-protocol/src/version.js';
import type { McInstall } from '@shared/ipc';
import { StatusPill, type StatusPillTone } from './StatusPill';
import { t, useT } from '../lib/i18n';
import styles from './McInstallRow.module.css';

/** Highest Minecraft Java version Sei's networking stack can join. */
const LATEST_SUPPORTED: string = supportedVersions[supportedVersions.length - 1];

export interface McInstallRowProps {
  install: McInstall;
  selected: boolean;
  onToggle: () => void;
  /**
   * 260916: vanilla rows carry a Minecraft version picker. The wizard builds
   * one "Sei <version>" profile per pick, so a player can keep a 1.21.4
   * profile for their old world beside a 26.1 one. Absent = no picker
   * (Settings re-entry paths that predate it), main defaults to the newest.
   */
  versionOptions?: string[];
  version?: string;
  onVersionChange?: (version: string) => void;
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
      label: t('Limited'),
    };
  }

  // Sei-enabled paths first (more specific).
  if (install.sei_enabled) {
    if (install.csl_installed && install.loader && install.loader_version && install.csl_version) {
      // "Sei enabled" — green, full version line.
      const loaderName = install.loader === 'fabric' ? 'Fabric' : 'Forge';
      return {
        tone: 'green',
        label: t('Sei enabled'),
        secondary: `${loaderName} ${install.loader_version} · CSL ${install.csl_version}`,
      };
    }
    if (!install.csl_installed) {
      return {
        tone: 'red',
        label: t('Mod missing'),
        secondary: t('Re-run setup to reinstall.'),
      };
    }
    // Edge case: enabled + csl_installed but missing loader info — flag as drift.
    return {
      tone: 'warn',
      label: t('Version drift'),
      secondary: t('Re-run setup to update.'),
    };
  }

  // Not Sei-enabled — muted pill keyed off install kind.
  if (install.kind === 'vanilla') {
    // No secondary — the path is on its own line (see the lunar note above).
    return {
      tone: 'muted',
      label: t('Vanilla launcher'),
    };
  }
  return {
    tone: 'muted',
    label: install.label,
    secondary: `CurseForge · ${install.mc_version ?? '?'}`,
  };
}

export function McInstallRow({
  install,
  selected,
  onToggle,
  versionOptions,
  version,
  onVersionChange,
}: McInstallRowProps): React.ReactElement {
  // Subscribes to the language so pillFor's bare t() re-evaluates on toggle.
  const t = useT();
  const pill = pillFor(install);
  const readyVersions = install.sei_ready_versions ?? [];
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
        aria-label={t('Enable Sei for {name}', { name: install.label })}
        tabIndex={-1}
      />
      <div className={styles.text}>
        <div className={styles.label}>{install.label}</div>
        <div className={styles.path}>{install.path}</div>
        {install.kind === 'lunar' ? (
          <div className={styles.lunarCaption}>
            {t(
              "Sei can join the same server, but Lunar doesn't support custom skin mods, so the bot will appear with a default Mojang skin.",
            )}
          </div>
        ) : null}
        {/* 260916: the wizard no longer installs for the launcher's
            last-played version (that built Sei profiles the bot could not
            join once 26.2 shipped), so the old pre-1.14 warning about the
            detected version is gone. The row now says which profile will be
            built and lets the player pick its version. */}
        {install.kind === 'vanilla' && versionOptions && onVersionChange ? (
          <div className={styles.versionRow} onClick={(e) => e.stopPropagation()}>
            <label className={styles.versionLabel} htmlFor={`${checkboxId}-version`}>
              {t('Minecraft version for the Sei profile')}
            </label>
            <select
              id={`${checkboxId}-version`}
              className={styles.versionSelect}
              value={version ?? versionOptions[0]}
              onChange={(e) => onVersionChange(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
            >
              {versionOptions.map((v) => (
                <option key={v} value={v}>
                  {readyVersions.includes(v) ? t('{version} (set up)', { version: v }) : v}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {install.kind === 'vanilla' ? (
          <div className={styles.lunarCaption}>
            {readyVersions.length > 0
              ? t('Sei profiles already in your launcher: {versions}. Picking another version adds one more; your own profiles are not changed.', {
                  versions: readyVersions.join(', '),
                })
              : t('Adds a separate "Sei {version}" profile to your launcher. Your own profiles are not changed.', {
                  version: version ?? versionOptions?.[0] ?? LATEST_SUPPORTED,
                })}
          </div>
        ) : null}
      </div>
      <div className={styles.pillSlot}>
        <StatusPill tone={pill.tone} label={pill.label} secondary={pill.secondary} />
      </div>
    </div>
  );
}
