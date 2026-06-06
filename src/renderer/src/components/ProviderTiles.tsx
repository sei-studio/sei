/**
 * ProviderTiles — picker for the LLM provider.
 *
 * ui-A1: Phase 14 multi-provider expansion landed all 13 backends; this
 * picker now lists every option as ENABLED (no "Coming soon" chip).
 * Provider kinds match the factory `SUPPORTED_PROVIDERS` constant in
 * `src/bot/brain/llm/index.js` and the `provider` enum in
 * `src/shared/characterSchema.ts` (UserConfigSchema).
 *
 * The dot color is purely visual — no semantics.
 *
 * Source: 04-07 Task 1; 04-UI-SPEC.md §Onboarding step 3; Phase 14 LLM matrix.
 */

import React from 'react';
import styles from './ProviderTiles.module.css';

export type Provider =
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'ollama'
  | 'grok'
  | 'openrouter'
  | 'deepseek'
  | 'mistral'
  | 'together'
  | 'groq'
  | 'fireworks'
  | 'cerebras'
  | 'perplexity';

interface Tile {
  id: Provider;
  label: string;
  dot: string;
}

const TILES: Tile[] = [
  { id: 'anthropic',  label: 'Anthropic',  dot: '#C96442' },
  { id: 'openai',     label: 'OpenAI',     dot: '#10A37F' },
  { id: 'gemini',     label: 'Gemini',     dot: '#4285F4' },
  { id: 'ollama',     label: 'Ollama',     dot: '#6E6E6E' },
  { id: 'grok',       label: 'Grok',       dot: '#1DA1F2' },
  { id: 'openrouter', label: 'OpenRouter', dot: '#8A6FF0' },
  { id: 'deepseek',   label: 'DeepSeek',   dot: '#4D6BFE' },
  { id: 'mistral',    label: 'Mistral',    dot: '#FF7000' },
  { id: 'together',   label: 'Together',   dot: '#0F6FFF' },
  { id: 'groq',       label: 'Groq',       dot: '#F55036' },
  { id: 'fireworks',  label: 'Fireworks',  dot: '#FB923C' },
  { id: 'cerebras',   label: 'Cerebras',   dot: '#A855F7' },
  { id: 'perplexity', label: 'Perplexity', dot: '#20808D' },
];

export interface ProviderTilesProps {
  value: Provider;
  onChange: (next: Provider) => void;
  /** ui-A1: when true, render in a denser 3-col layout (Settings inline). */
  compact?: boolean;
}

export function ProviderTiles({ value, onChange, compact = false }: ProviderTilesProps): React.ReactElement {
  return (
    <div
      className={`${styles.grid} ${compact ? styles.compact : ''}`}
      role="radiogroup"
      aria-label="Choose a model provider"
    >
      {TILES.map((tile) => {
        const selected = value === tile.id;
        const cls = [styles.tile, selected ? styles.selected : ''].filter(Boolean).join(' ');
        return (
          <button
            key={tile.id}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={0}
            className={cls}
            onClick={() => onChange(tile.id)}
          >
            <span className={styles.dot} style={{ background: tile.dot }} />
            <span className={styles.label}>{tile.label}</span>
          </button>
        );
      })}
    </div>
  );
}
