/**
 * ProfileRow (261107, profile v0.7): one settings row on a companion's
 * profile. Label, current value, action button(s). Nothing else: an
 * explanation is a hover tooltip on the label (HoverTip), and a row the
 * player cannot change shows its value plus a Locked marker whose tooltip
 * says why.
 */
import React from 'react';
import { useT } from '../../lib/i18n';
import { InfoIcon, LockIcon } from '../icons';
import { HoverTip } from './HoverTip';
import styles from './Profile.module.css';

export interface ProfileRowProps {
  label: string;
  /** Hover / focus explanation on the label (was the row's subtext line). */
  tip?: string;
  /** Analytics key for `tip` (profile_tooltip_opened). */
  tipKey?: string;
  value?: React.ReactNode;
  actions?: React.ReactNode;
  /** Show the Locked marker instead of `actions`; the string is its tooltip. */
  lockedTip?: string | null;
  onTipOpen?: (key: string) => void;
  /** Value cell aligns to the top (multi-line values such as the description). */
  tall?: boolean;
  /** Danger zone styling for the label. */
  danger?: boolean;
  /** For tests and the screenshot harness. */
  rowId?: string;
}

export function ProfileRow({
  label,
  tip,
  tipKey,
  value,
  actions,
  lockedTip,
  onTipOpen,
  tall,
  danger,
  rowId,
}: ProfileRowProps): React.ReactElement {
  const t = useT();
  const locked = typeof lockedTip === 'string';
  return (
    <div
      className={`${styles.row} ${tall ? styles.rowTall : ''} ${locked ? styles.rowLocked : ''}`}
      data-row={rowId}
      data-locked={locked ? 'true' : undefined}
    >
      <div className={`${styles.label} ${danger ? styles.labelDanger : ''}`}>
        {tip ? (
          <HoverTip tip={tip} onOpen={tipKey ? () => onTipOpen?.(tipKey) : undefined} className={styles.labelTip}>
            <span>{label}</span>
            <span className={styles.infoMark} aria-hidden="true">
              <InfoIcon size={12} />
            </span>
          </HoverTip>
        ) : (
          <span>{label}</span>
        )}
      </div>
      {/* Value + actions share one cell that wraps: when the actions do not
          fit beside the value (long translations), they drop under it. */}
      <div className={styles.body}>
        <div className={styles.value}>{value}</div>
        <div className={styles.actions}>
          {locked ? (
            <HoverTip
              tip={lockedTip as string}
              align="end"
              onOpen={() => onTipOpen?.('locked')}
              className={styles.lock}
              aria-label={t('Locked: {reason}', { reason: lockedTip as string })}
            >
              <LockIcon size={12} />
              <span>{t('Locked')}</span>
            </HoverTip>
          ) : (
            actions
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * A value cell: optional leading visual (thumb, head, dot) + text. One line
 * with an ellipsis, or up to two lines with `wrap` (beside a tall thumb).
 */
export function RowValue({
  lead,
  text,
  mono,
  wrap,
}: {
  lead?: React.ReactNode;
  text: React.ReactNode;
  mono?: boolean;
  wrap?: boolean;
}): React.ReactElement {
  return (
    <span className={styles.val}>
      {lead}
      <span className={`${wrap ? styles.valWrap : styles.valText} ${mono ? styles.mono : ''}`}>{text}</span>
    </span>
  );
}

/** The small count chip inside an action button ("2 left"). */
export function ActionChip({ children }: { children: React.ReactNode }): React.ReactElement {
  return <span className={styles.chip}>{children}</span>;
}
