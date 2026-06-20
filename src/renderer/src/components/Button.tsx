/**
 * Button — primary / accent / ghost / quiet × sm / md / lg.
 *
 * Source: 04-UI-SPEC.md §Component Inventory → Button (variants × size matrix).
 * Visual contract: D-28 sharp corners; native :focus-visible 1.5px accent ring.
 */

import React from 'react';
import styles from './Button.module.css';

type Kind = 'primary' | 'accent' | 'ghost' | 'quiet' | 'danger';
type Size = 'sm' | 'md' | 'lg';

interface ButtonProps {
  children?: React.ReactNode;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  kind?: Kind;
  size?: Size;
  icon?: React.ReactNode;
  disabled?: boolean;
  fullWidth?: boolean;
  type?: 'button' | 'submit';
  'aria-label'?: string;
  'aria-disabled'?: boolean;
  /** Toggle/segmented selection state — also drives the pressed visual. */
  'aria-pressed'?: boolean;
  style?: React.CSSProperties;
  className?: string;
  title?: string;
}

export function Button({
  children,
  onClick,
  kind = 'primary',
  size = 'md',
  icon,
  disabled,
  fullWidth,
  type = 'button',
  style,
  className,
  title,
  ...rest
}: ButtonProps): React.ReactElement {
  const cls = [
    styles.button,
    styles[size],
    styles[kind],
    fullWidth ? styles.fullWidth : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type={type}
      className={cls}
      onClick={onClick}
      disabled={disabled}
      style={style}
      title={title}
      aria-label={rest['aria-label']}
      aria-disabled={rest['aria-disabled']}
      aria-pressed={rest['aria-pressed']}
    >
      {icon}
      {children}
    </button>
  );
}
