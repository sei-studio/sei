/**
 * DashPortrait — a companion's art for the game dashboards' portrait card
 * (260909): the uploaded portrait when there is one, the procedural pixel
 * portrait otherwise, exactly as the Home wall paints it (same seed, same
 * palette pick), so the face on the dashboard is the face on the card.
 * Unstyled beyond filling its box; each game's card frames it its own way.
 */
import React from 'react';
import type { Character } from '@shared/characterSchema';
import { PixelPortrait } from '../PixelPortrait';
import { pickPalette } from '../../lib/portraitPalettes';
import { resolvedScheme } from '../../lib/theme';

export function DashPortrait({ character, className }: { character: Pick<Character, 'id' | 'name' | 'portrait_image'> | undefined; className?: string }): React.ReactElement | null {
  if (!character) return null;
  const seed = character.id + character.name;
  return (
    <PixelPortrait
      seed={seed}
      palette={pickPalette(seed, resolvedScheme())}
      portraitImage={character.portrait_image}
      size={320}
      className={className}
      style={{ width: '100%', height: '100%' }}
    />
  );
}
