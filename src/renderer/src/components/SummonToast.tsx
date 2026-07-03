/**
 * SummonToast — bottom-right "Summoning {name}…" notification.
 *
 * Auto-dismisses after 4200ms (UI-SPEC §Animation Tokens) or on click.
 * Inverted color scheme: dark `var(--text)` background with light `var(--window)`
 * text, sharp corners, --shadow-pop. role="status" aria-live="polite".
 *
 * Source: 04-UI-SPEC.md §SummonToast + §Component Inventory; D-59.
 */

import React, { useEffect } from 'react';
import { PixelPortrait } from './PixelPortrait';
import { pickPalette } from '../lib/portraitPalettes';
import styles from './SummonToast.module.css';

const DISMISS_MS = 4200;

export interface SummonToastProps {
  characterId: string;
  characterName: string;
  onDone: () => void;
}

export function SummonToast({
  characterId,
  characterName,
  onDone,
}: SummonToastProps): React.ReactElement {
  const themeAttr = document.documentElement.getAttribute('data-theme');
  const theme: 'light' | 'dark' = themeAttr === 'dark' ? 'dark' : 'light';
  const palette = pickPalette(characterId + characterName, theme);

  useEffect(() => {
    const t = window.setTimeout(onDone, DISMISS_MS);
    return () => window.clearTimeout(t);
  }, [onDone]);

  return (
    <div
      className={styles.toast}
      role="status"
      aria-live="polite"
      onClick={onDone}
    >
      <PixelPortrait
        seed={characterId + characterName}
        palette={palette}
        size={36}
        portraitImage={null}
      />
      <div className={styles.text}>{characterName} connected</div>
    </div>
  );
}
