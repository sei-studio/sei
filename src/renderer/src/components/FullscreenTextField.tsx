/**
 * FullscreenTextField — a normal inline textarea with an expand affordance.
 *
 * 260725 redesign: the old version was a click-target button (rounded, with an
 * uppercase EXPAND hint) whose ONLY way to type was the fullscreen popup. Now
 * the field is a regular sharp-cornered textarea the user types in directly;
 * the corner icon (corner-arrows glyph) opens the roomy ModalShell editor for
 * long-form writing. Editing is live in both places (same value/onChange).
 */

import React, { useState } from 'react';
import { ModalShell, ModalFooter } from './ModalShell';
import { Button } from './Button';
import { FullscreenIcon } from './icons';
import styles from './FullscreenTextField.module.css';

interface FullscreenTextFieldProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** Popup header text. */
  modalTitle: string;
  'aria-label': string;
}

export function FullscreenTextField({
  value,
  onChange,
  placeholder,
  modalTitle,
  ...rest
}: FullscreenTextFieldProps): React.ReactElement {
  const [open, setOpen] = useState(false);

  return (
    <>
      <div className={styles.wrap}>
        <textarea
          className={styles.input}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-label={rest['aria-label']}
        />
        <button
          type="button"
          className={styles.expandBtn}
          onClick={() => setOpen(true)}
          aria-label={`Expand ${rest['aria-label']}`}
          title="Expand"
        >
          <FullscreenIcon size={14} />
        </button>
      </div>
      {open ? (
        <ModalShell
          title={modalTitle}
          width={960}
          escClose
          scrimClose
          onClose={() => setOpen(false)}
          panelClassName={styles.editorPanel}
          aria-label={modalTitle}
        >
          <textarea
            className={styles.editor}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            autoFocus
            aria-label={rest['aria-label']}
          />
          <ModalFooter>
            <Button kind="accent" onClick={() => setOpen(false)}>
              Done
            </Button>
          </ModalFooter>
        </ModalShell>
      ) : null}
    </>
  );
}
