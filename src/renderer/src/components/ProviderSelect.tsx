/**
 * ProviderSelect — dropdown picker for the LLM provider.
 *
 * Phase 14 landed all 13 backends; listing them as 13 tiles took a lot of
 * vertical space, so the picker is now a single dropdown (trigger + listbox).
 * Provider kinds match the factory `SUPPORTED_PROVIDERS` constant in
 * `src/bot/brain/llm/index.js` and the `provider` enum in
 * `src/shared/characterSchema.ts` (UserConfigSchema).
 *
 * Styling follows .planning/UI-DESIGN-SYSTEM.md: the trigger mirrors the
 * `ghost` Button / input (faint fill, --border-strong, mono uppercase tracked
 * label, accent on hover/focus); the menu is the modal/menu surface. Sharp
 * corners, one accent, no decorative per-provider color.
 *
 * Accessibility: a button trigger (aria-haspopup="listbox") opens a
 * role="listbox" with role="option" children; keyboard support covers
 * arrow/Home/End navigation, Enter/Space to choose, Escape to close, and
 * click-outside dismissal.
 */

import React, { useEffect, useId, useRef, useState } from 'react';
import { ArrowIcon } from './icons';
import styles from './ProviderSelect.module.css';

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

interface ProviderOption {
  id: Provider;
  label: string;
}

const PROVIDERS: ProviderOption[] = [
  { id: 'anthropic',  label: 'Anthropic' },
  { id: 'openai',     label: 'OpenAI' },
  { id: 'gemini',     label: 'Gemini' },
  { id: 'ollama',     label: 'Ollama' },
  { id: 'grok',       label: 'Grok' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'deepseek',   label: 'DeepSeek' },
  { id: 'mistral',    label: 'Mistral' },
  { id: 'together',   label: 'Together' },
  { id: 'groq',       label: 'Groq' },
  { id: 'fireworks',  label: 'Fireworks' },
  { id: 'cerebras',   label: 'Cerebras' },
  { id: 'perplexity', label: 'Perplexity' },
];

export interface ProviderSelectProps {
  value: Provider;
  onChange: (next: Provider) => void;
  /** Denser trigger sizing for inline use (Settings / modal). */
  compact?: boolean;
}

export function ProviderSelect({ value, onChange, compact = false }: ProviderSelectProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const selectedIndex = Math.max(0, PROVIDERS.findIndex((p) => p.id === value));
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const baseId = useId();
  const selected = PROVIDERS[selectedIndex];

  // Highlight the current value whenever the list (re)opens.
  useEffect(() => {
    if (open) setActiveIndex(selectedIndex);
  }, [open, selectedIndex]);

  // Move keyboard focus into the listbox when it opens.
  useEffect(() => {
    if (open) listRef.current?.focus();
  }, [open]);

  // Dismiss on an outside click while open.
  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open]);

  const choose = (i: number): void => {
    onChange(PROVIDERS[i].id);
    setOpen(false);
  };

  // Close and return focus to the trigger — used by keyboard paths so focus
  // doesn't fall to <body> when the listbox unmounts.
  const closeToTrigger = (): void => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onTriggerKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setOpen(true);
    }
  };

  const onListKeyDown = (e: React.KeyboardEvent): void => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActiveIndex((i) => Math.min(PROVIDERS.length - 1, i + 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIndex((i) => Math.max(0, i - 1));
        break;
      case 'Home':
        e.preventDefault();
        setActiveIndex(0);
        break;
      case 'End':
        e.preventDefault();
        setActiveIndex(PROVIDERS.length - 1);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        choose(activeIndex);
        triggerRef.current?.focus();
        break;
      case 'Escape':
        e.preventDefault();
        closeToTrigger();
        break;
      case 'Tab':
        setOpen(false);
        break;
      default:
        break;
    }
  };

  return (
    <div
      ref={rootRef}
      className={[styles.root, compact ? styles.compact : '', open ? styles.open : '']
        .filter(Boolean)
        .join(' ')}
    >
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Choose a model provider"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onTriggerKeyDown}
      >
        <span className={styles.label}>{selected.label}</span>
        <span className={`${styles.chevron} ${open ? styles.chevronOpen : ''}`} aria-hidden="true">
          <ArrowIcon size={14} dir="down" />
        </span>
      </button>
      {open ? (
        <ul
          ref={listRef}
          className={styles.list}
          role="listbox"
          tabIndex={-1}
          aria-label="Model provider"
          aria-activedescendant={`${baseId}-opt-${activeIndex}`}
          onKeyDown={onListKeyDown}
        >
          {PROVIDERS.map((p, i) => {
            const isSelected = p.id === value;
            const isActive = i === activeIndex;
            const cls = [styles.option, isActive ? styles.active : '', isSelected ? styles.selected : '']
              .filter(Boolean)
              .join(' ');
            return (
              <li
                key={p.id}
                id={`${baseId}-opt-${i}`}
                role="option"
                aria-selected={isSelected}
                className={cls}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => choose(i)}
              >
                <span className={styles.label}>{p.label}</span>
                {isSelected ? <span className={styles.check} aria-hidden="true">✓</span> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
