/**
 * StatusPill — 8px-square dot + uppercase label primitive with optional mono secondary caption.
 *
 * Extracted from the inline patterns in LanModal.headerEyebrow +
 * CharacterPage.modelRow to a shared primitive consumed by SkinEditor empty-
 * states, "Default skin" badge adjacency, MC-install rows, and the wizard
 * "Setup complete" panel.
 *
 * Source: UI-SPEC §"Status dot system (D-22 family, extended)" — the 5-state
 * dot/label matrix (green / red / warn / muted / pulse-in-flight).
 *
 * Visual contract:
 *   - 8px square dots, sharp corners (D-28 — NO border-radius)
 *   - Label is rendered as-is (caller controls casing). UI-SPEC says uppercase but
 *     we don't text-transform here so the component is callsite-truthful.
 *   - Optional mono secondary caption underneath the primary label, --text-2.
 *   - Tone 'pulse' is the in-flight (Installing… / Detecting… / Searching skin…) state:
 *     --text-2 dot with a 1.4s opacity pulse; the animation is disabled under
 *     `prefers-reduced-motion: reduce`.
 *
 * a11y:
 *   - The colored dot is `aria-hidden` because the textual label carries the meaning;
 *     status pills must never convey information by color alone (UI-SPEC §Accessibility).
 */

import React from 'react';
import styles from './StatusPill.module.css';

export type StatusPillTone = 'green' | 'red' | 'warn' | 'muted' | 'pulse';

/**
 * ITEM 15 (quick/260523-t8d): `size` selects between the original sans-serif
 * StatusPill (used in modals, MC-install rows, model row) and a compact
 * 'tag' variant that matches the CharacterCard PUBLIC/CUSTOM chip styling
 * (mono / 10px / letter-spacing 1.2px). The tag variant is used by the
 * SYNCING pill overlay on CharacterCard so the three pills (PUBLIC, CUSTOM,
 * SYNCING) read at byte-identical heights regardless of label length.
 */
export type StatusPillSize = 'default' | 'tag';

export interface StatusPillProps {
  tone: StatusPillTone;
  /** Primary text. Caller controls uppercasing — component does not text-transform. */
  label: string;
  /** Optional mono caption under the label (e.g. version string, path). */
  secondary?: string;
  className?: string;
  /** ITEM 15: 'tag' matches the CharacterCard chip (mono/10px/1.2px). Default keeps the original sans/11px/0.08em. */
  size?: StatusPillSize;
}

function cls(...parts: Array<string | false | undefined | null>): string {
  return parts.filter(Boolean).join(' ');
}

export function StatusPill({
  tone,
  label,
  secondary,
  className,
  size = 'default',
}: StatusPillProps): React.ReactElement {
  return (
    <div className={cls(styles.pill, size === 'tag' && styles.size_tag, className)}>
      <span className={cls(styles.dot, styles['dot_' + tone])} aria-hidden="true" />
      <span className={styles.labels}>
        <span className={styles.label}>{label}</span>
        {secondary ? <span className={styles.secondary}>{secondary}</span> : null}
      </span>
    </div>
  );
}
