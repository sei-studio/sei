/**
 * CharacterCard — hover-overlay grid card with PixelPortrait + Summon button.
 *
 * Visual contract per UI-SPEC §HomeScreen §CharacterCard + D-49 (Summon icon
 * is sparkle, NOT play). Default badge for `id === 'sui'` (post-migration);
 * everything else is "CUSTOM".
 *
 * Click on the card body → onOpen (navigate to character page).
 * Click on the centered Summon overlay → onSummon (event stopPropagation
 * so the card click doesn't also fire).
 *
 * Source: 04-07 Task 1; design/project/screens.jsx CharacterCard.
 */

import React from 'react';
import type { Character } from '@shared/characterSchema';
import { PixelPortrait } from './PixelPortrait';
import { Button } from './Button';
import { ArrowIcon, SparkleIcon } from './icons';
import { pickPalette } from '../lib/portraitPalettes';
import styles from './CharacterCard.module.css';

export interface CharacterCardProps {
  character: Character;
  theme: 'light' | 'dark';
  onOpen: () => void;
  onSummon: () => void;
}

function formatLast(iso: string | null): string {
  if (!iso) return 'Never summoned';
  try {
    const d = new Date(iso);
    return `Last: ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  } catch {
    return 'Never summoned';
  }
}

export function CharacterCard({
  character: c,
  theme,
  onOpen,
  onSummon,
}: CharacterCardProps): React.ReactElement {
  const palette = pickPalette(c.id + c.name, theme);
  const isDefault = c.id === 'sui';
  return (
    <div className={styles.card} onClick={onOpen} role="button" tabIndex={0}>
      <div className={styles.portraitWrap}>
        <PixelPortrait
          seed={c.id + c.name}
          palette={palette}
          size={260}
          portraitImage={c.portrait_image}
        />
        <div className={styles.gradient} />
        <div
          className={`${styles.chip} ${isDefault ? styles.chipDefault : styles.chipCustom}`}
        >
          <span className={styles.chipDot} />
          {isDefault ? 'DEFAULT' : 'CUSTOM'}
        </div>
        <div className={styles.nameOverlay}>{c.name}</div>
        <div className={styles.hoverOverlay}>
          <Button
            kind="accent"
            size="md"
            icon={<SparkleIcon size={12} />}
            onClick={(e) => {
              e.stopPropagation();
              onSummon();
            }}
            aria-label={`Summon ${c.name}`}
          >
            Summon
          </Button>
        </div>
      </div>
      <div className={styles.infoRow}>
        <div className={styles.infoText}>
          <div className={styles.infoName}>{c.name}</div>
          <div className={styles.infoMeta}>{formatLast(c.last_launched)}</div>
        </div>
        <ArrowIcon size={14} />
      </div>
    </div>
  );
}
