/**
 * ProviderTiles — 2×2 picker for model provider.
 *
 * D-26 / D-27: Anthropic enabled; OpenAI / Google / Local rendered with a
 * "Coming soon" chip and aria-disabled. T-04-33 mitigation: disabled tiles
 * have tabIndex=-1 and the click handler no-ops; main re-validates via the
 * UserConfigSchema enum (only `'anthropic'` passes Zod today).
 *
 * Source: 04-07 Task 1; 04-UI-SPEC.md §Onboarding step 3.
 */

import React from 'react';
import styles from './ProviderTiles.module.css';

export type Provider = 'anthropic' | 'openai' | 'google' | 'local';

interface Tile {
  id: Provider;
  label: string;
  dot: string;
  enabled: boolean;
}

const TILES: Tile[] = [
  { id: 'anthropic', label: 'Anthropic', dot: '#C96442', enabled: true },
  { id: 'openai', label: 'OpenAI', dot: '#10A37F', enabled: false },
  { id: 'google', label: 'Google', dot: '#4285F4', enabled: false },
  { id: 'local', label: 'Local', dot: '#6E6E6E', enabled: false },
];

export interface ProviderTilesProps {
  value: Provider;
  onChange: (next: Provider) => void;
}

export function ProviderTiles({ value, onChange }: ProviderTilesProps): React.ReactElement {
  return (
    <div className={styles.grid} role="radiogroup" aria-label="Choose a model provider">
      {TILES.map((tile) => {
        const selected = value === tile.id;
        const cls = [
          styles.tile,
          selected ? styles.selected : '',
          tile.enabled ? '' : styles.disabled,
        ]
          .filter(Boolean)
          .join(' ');
        return (
          <button
            key={tile.id}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-disabled={!tile.enabled}
            tabIndex={tile.enabled ? 0 : -1}
            className={cls}
            onClick={() => {
              if (tile.enabled) onChange(tile.id);
            }}
          >
            <span className={styles.dot} style={{ background: tile.dot }} />
            <span className={styles.label}>{tile.label}</span>
            {tile.enabled ? null : <span className={styles.chip}>Coming soon</span>}
          </button>
        );
      })}
    </div>
  );
}
