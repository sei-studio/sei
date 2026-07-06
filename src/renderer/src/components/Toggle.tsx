/**
 * Toggle — the pill switch (mockup .toggle). 34×19, knob slides, accent when
 * on. Replaces On/Off button pairs across Settings and the share toggle.
 *
 * Source: .planning/design/UI-REDESIGN-PARTY.md §1.
 */

import React from 'react';
import styles from './Toggle.module.css';

interface ToggleProps {
  on: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  'aria-label': string;
}

export function Toggle({ on, onChange, disabled, ...rest }: ToggleProps): React.ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={rest['aria-label']}
      disabled={disabled}
      className={[styles.toggle, on ? styles.on : ''].filter(Boolean).join(' ')}
      onClick={() => onChange(!on)}
    />
  );
}
