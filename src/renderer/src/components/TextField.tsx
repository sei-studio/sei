/**
 * TextField — borderless 1.5px underline input. Single + multiline,
 * monospace + password modes.
 *
 * Source: 04-UI-SPEC.md §Component Inventory → TextField + D-31.
 *
 * Keyboard:
 *  - Enter on single-line invokes onEnter (used to submit onboarding steps).
 *  - Esc never consumed — propagates so modal close works above the field.
 */

import React, { useEffect, useRef } from 'react';
import styles from './TextField.module.css';

interface TextFieldProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: 'text' | 'password';
  autoFocus?: boolean;
  monospace?: boolean;
  multiline?: boolean;
  rows?: number;
  onEnter?: () => void;
  disabled?: boolean;
  'aria-label'?: string;
  'aria-invalid'?: boolean;
}

export function TextField({
  value,
  onChange,
  placeholder,
  type = 'text',
  autoFocus,
  monospace,
  multiline,
  rows = 4,
  onEnter,
  disabled,
  ...rest
}: TextFieldProps): React.ReactElement {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!autoFocus) return;
    // Defer focus so screen-mount fade-up animation doesn't fight focus.
    const t = window.setTimeout(() => {
      (multiline ? textareaRef.current : inputRef.current)?.focus();
    }, 60);
    return () => window.clearTimeout(t);
  }, [autoFocus, multiline]);

  const onKey = (e: React.KeyboardEvent) => {
    // IME guard (260709): the Enter that confirms a CJK composition candidate
    // must not fire onEnter (it would submit onboarding/settings forms while
    // typing a name). Mirrors the chat composer's guard in ChatScreen.tsx.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (!multiline && e.key === 'Enter' && onEnter) {
      e.preventDefault();
      onEnter();
    }
  };

  const cls = [
    styles.field,
    multiline ? styles.multi : styles.single,
    monospace ? styles.mono : '',
  ]
    .filter(Boolean)
    .join(' ');

  if (multiline) {
    return (
      <textarea
        ref={textareaRef}
        className={cls}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
        aria-label={rest['aria-label']}
        aria-invalid={rest['aria-invalid']}
      />
    );
  }
  return (
    <input
      ref={inputRef}
      className={cls}
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      onKeyDown={onKey}
      disabled={disabled}
      aria-label={rest['aria-label']}
      aria-invalid={rest['aria-invalid']}
    />
  );
}
