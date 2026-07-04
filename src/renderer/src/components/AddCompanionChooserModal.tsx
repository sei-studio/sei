/**
 * AddCompanionChooserModal — the three-way "how do you want to fill this slot?"
 * chooser (260703 procgen, spec items 2+3). Opened when the user clicks an empty
 * Home companion slot.
 *
 * Three square tiles side by side, each framed with the corner-bracket utility
 * (.u-brk), an icon, a title and a one-line sub:
 *   - "Meet your unique companion" — the flagship system-generated path (accent
 *     treatment). Gating (sign-in / cloud) + questionnaire happen in the caller.
 *   - "Create from scratch"        — the existing custom add-character wizard.
 *   - "Invite an existing companion" — switches the Home view to the World tab.
 *
 * Dismissible (ESC / scrim click / "Not now") — mirrors CreationLimitModal, the
 * canonical dismissible modal idiom. Tokens only (no literal hex/px in colors).
 */

import React, { useEffect, useId } from 'react';
import { SparkleIcon, PencilIcon, CompassIcon } from './icons';
import styles from './AddCompanionChooserModal.module.css';

export interface AddCompanionChooserModalProps {
  /** Flagship system-generated path. */
  onPickUnique: () => void;
  /** The existing "create from scratch" custom wizard. */
  onPickCustom: () => void;
  /** Switch to the World tab to invite an existing public companion. */
  onPickWorld: () => void;
  onClose: () => void;
}

export function AddCompanionChooserModal({
  onPickUnique,
  onPickCustom,
  onPickWorld,
  onClose,
}: AddCompanionChooserModalProps): React.ReactElement {
  const titleId = useId();

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className={styles.scrim}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={onClose}
    >
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <h2 id={titleId} className={styles.title}>
          Add a companion
        </h2>
        <p className={styles.subtitle}>Choose how to fill this slot.</p>

        <div className={styles.tiles}>
          <button
            type="button"
            className={`${styles.tile} ${styles.tileFlagship}`}
            onClick={onPickUnique}
          >
            <span className={styles.tileIcon}>
              <SparkleIcon size={26} />
            </span>
            <span className={styles.tileTitle}>Meet your unique companion</span>
            <span className={styles.tileSub}>A one-of-a-kind soul, cast just for you.</span>
            <span className="u-brk tl" aria-hidden="true" />
            <span className="u-brk tr" aria-hidden="true" />
            <span className="u-brk bl" aria-hidden="true" />
            <span className="u-brk br" aria-hidden="true" />
          </button>

          <button type="button" className={styles.tile} onClick={onPickCustom}>
            <span className={styles.tileIcon}>
              <PencilIcon size={24} />
            </span>
            <span className={styles.tileTitle}>Create from scratch</span>
            <span className={styles.tileSub}>Design every detail yourself.</span>
            <span className="u-brk tl" aria-hidden="true" />
            <span className="u-brk tr" aria-hidden="true" />
            <span className="u-brk bl" aria-hidden="true" />
            <span className="u-brk br" aria-hidden="true" />
          </button>

          <button type="button" className={styles.tile} onClick={onPickWorld}>
            <span className={styles.tileIcon}>
              <CompassIcon size={24} />
            </span>
            <span className={styles.tileTitle}>Invite an existing companion</span>
            <span className={styles.tileSub}>Bring one over from the World.</span>
            <span className="u-brk tl" aria-hidden="true" />
            <span className="u-brk tr" aria-hidden="true" />
            <span className="u-brk bl" aria-hidden="true" />
            <span className="u-brk br" aria-hidden="true" />
          </button>
        </div>

        <div className={styles.footer}>
          <button type="button" className={styles.dismiss} onClick={onClose}>
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
