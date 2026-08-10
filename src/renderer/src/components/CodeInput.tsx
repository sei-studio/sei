/**
 * CodeInput — segmented entry for the 6-digit code Sei emails (260804).
 *
 * Controlled on ONE string, not on per-cell state. Each cell is a view of
 * `value[i]`, which is what makes paste, autofill and backspace-across-cells
 * fall out for free instead of needing three separate code paths.
 *
 * `length` is a prop with a 6 default rather than a constant, because Supabase's
 * token length is a dashboard setting (6-10 digits). Raising it there should
 * mean passing a number here, not editing a component.
 *
 * Keyboard contract:
 *  - a digit fills the focused cell and advances
 *  - Backspace clears the focused cell, or steps back when it is already empty
 *  - Left/Right move without editing
 *  - paste fills forward from the focused cell, ignoring separators, so a
 *    "123-456" copied out of a mail client lands correctly
 *  - Enter submits via onComplete when the code is full
 *
 * Non-digits never enter the value. The mail client is free to render the code
 * however it likes; the field only ever holds what Supabase will accept.
 */
import React, { useEffect, useRef } from 'react';
import { backspaceAt, digitsOnly, typedInto, writeAt } from '../lib/codeEntry';
import styles from './CodeInput.module.css';

export interface CodeInputProps {
  value: string;
  onChange: (v: string) => void;
  /** Fired when the value reaches `length`, and on Enter with a full value. */
  onComplete?: (v: string) => void;
  length?: number;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Marks every cell, not just the focused one — the code is one value. */
  invalid?: boolean;
  /**
   * Styling seam for surfaces that do not use the app palette. The onboarding
   * scene renders on a light frosted panel with its own tokens, so its cells
   * come from onboard.module.css; everything else takes the defaults. Classes
   * are appended, so a caller overrides only what it names.
   */
  rowClassName?: string;
  cellClassName?: string;
  'aria-label'?: string;
}

export function CodeInput({
  value,
  onChange,
  onComplete,
  length = 6,
  disabled,
  autoFocus,
  invalid,
  rowClassName,
  cellClassName,
  ...rest
}: CodeInputProps): React.ReactElement {
  const cells = useRef<Array<HTMLInputElement | null>>([]);
  /**
   * onComplete must fire once per arrival at a full code, not on every render
   * that happens to see one — otherwise a failed submit that leaves the value
   * intact re-fires it on the next keystroke elsewhere in the panel.
   */
  const firedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!autoFocus) return;
    // Same deferral as TextField: mount animations fight an immediate focus.
    const t = window.setTimeout(() => cells.current[0]?.focus(), 60);
    return () => window.clearTimeout(t);
  }, [autoFocus]);

  useEffect(() => {
    if (value.length === length && firedFor.current !== value) {
      firedFor.current = value;
      onComplete?.(value);
    }
    if (value.length !== length) firedFor.current = null;
  }, [value, length, onComplete]);

  const focusCell = (i: number): void => {
    const el = cells.current[Math.max(0, Math.min(length - 1, i))];
    el?.focus();
    el?.select();
  };

  const apply = (edit: { next: string; focus: number }): void => {
    onChange(edit.next);
    focusCell(edit.focus);
  };

  const onCellChange = (i: number, raw: string): void => {
    apply(writeAt(value, i, typedInto(value[i], raw), length));
  };

  const onKeyDown = (i: number, e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Backspace') {
      e.preventDefault();
      apply(backspaceAt(value, i, length));
      return;
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      focusCell(i - 1);
      return;
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      focusCell(i + 1);
      return;
    }
    if (e.key === 'Enter' && value.length === length) {
      e.preventDefault();
      onComplete?.(value);
    }
  };

  const onPaste = (i: number, e: React.ClipboardEvent<HTMLInputElement>): void => {
    e.preventDefault();
    apply(writeAt(value, i, digitsOnly(e.clipboardData.getData('text')), length));
  };

  return (
    <div
      className={[styles.row, invalid ? styles.invalid : '', rowClassName ?? '']
        .filter(Boolean)
        .join(' ')}
      role="group"
      aria-label={rest['aria-label']}
    >
      {Array.from({ length }, (_, i) => (
        <input
          key={i}
          ref={(el) => {
            cells.current[i] = el;
          }}
          className={cellClassName ? `${styles.cell} ${cellClassName}` : styles.cell}
          type="text"
          inputMode="numeric"
          // Lets the OS offer the code straight from the notification. Only the
          // first cell claims it: the browser fills the whole value from there
          // via the paste path, and six competing claims confuse the heuristic.
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          value={value[i] ?? ''}
          disabled={disabled}
          aria-label={`${rest['aria-label'] ?? 'Code'} ${i + 1}`}
          aria-invalid={invalid || undefined}
          onChange={(e) => onCellChange(i, e.target.value)}
          onKeyDown={(e) => onKeyDown(i, e)}
          onPaste={(e) => onPaste(i, e)}
          onFocus={(e) => e.target.select()}
        />
      ))}
    </div>
  );
}
