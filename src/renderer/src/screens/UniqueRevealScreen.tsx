/**
 * UniqueRevealScreen — the meeting moment after a successful unique-companion
 * cast (260703 procgen, spec item 3). Loads the freshly-generated character,
 * shows a large portrait, a "Meet <name>" heading, the public_id tag (when the
 * cloud row has assigned one), and a short intro pulled from the character's
 * description (falling back to the first sentences of persona.source). Two CTAs:
 *   - "Say hello" → open the in-app chat with the new companion.
 *   - "Later"     → home.
 */

import React, { useEffect, useState } from 'react';
import { sei } from '../lib/ipcClient';
import { useUiStore } from '../lib/stores/useUiStore';
import { useDataStore } from '../lib/stores/useDataStore';
import { PixelPortrait } from '../components/PixelPortrait';
import { Button } from '../components/Button';
import { IdTag } from '../components/IdTag';
import { pickPalette } from '../lib/portraitPalettes';
import type { Character } from '@shared/characterSchema';
import styles from './UniqueRevealScreen.module.css';

/** First 2 sentences (max ~240 chars) of a longer blob, for the fallback intro. */
function firstSentences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  const parts = trimmed.split(/(?<=[.!?])\s+/).slice(0, 2).join(' ');
  return parts.length > 240 ? parts.slice(0, 240).trimEnd() + '…' : parts;
}

export interface UniqueRevealScreenProps {
  characterId: string;
}

export function UniqueRevealScreen({ characterId }: UniqueRevealScreenProps): React.ReactElement {
  const navigate = useUiStore((s) => s.navigate);
  const [character, setCharacter] = useState<Character | null>(null);
  const [loadError, setLoadError] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const c = await sei.getCharacter(characterId);
        if (cancelled) return;
        if (c) setCharacter(c);
        else setLoadError(true);
      } catch {
        if (!cancelled) setLoadError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [characterId]);

  const sayHello = (): void => {
    void useDataStore.getState().refreshCharacter(characterId).catch(() => {
      /* ChatScreen re-fetches on its own */
    });
    navigate({ kind: 'chat', characterId });
  };

  if (loadError) {
    return (
      <div className={styles.root}>
        <div className={styles.center}>
          <div className={styles.heading}>Your companion is ready</div>
          <p className={styles.intro}>They’re waiting in your library.</p>
          <div className={styles.actions}>
            <Button kind="accent" size="lg" onClick={() => navigate({ kind: 'home' })}>
              Go home
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (!character) {
    return (
      <div className={styles.root}>
        <div className={styles.center}>
          <div className={styles.eyebrow}>Casting complete</div>
        </div>
      </div>
    );
  }

  const themeAttr = document.documentElement.getAttribute('data-theme');
  const theme: 'light' | 'dark' = themeAttr === 'dark' ? 'dark' : 'light';
  const palette = pickPalette(character.id + character.name, theme);
  // description is now the full backstory paragraph (150-300 words) — clamp it
  // to a couple of sentences here so the reveal stays a short intro with the
  // CTAs above the fold; the full text lives on the character page.
  const intro =
    firstSentences(character.description ?? '') || firstSentences(character.persona?.source ?? '');

  return (
    <div className={styles.root}>
      <div className={styles.center}>
        <div className={styles.portraitFrame}>
          <PixelPortrait
            seed={character.id + character.name}
            palette={palette}
            size={280}
            portraitImage={character.portrait_image}
            style={{ width: '100%', height: '100%' }}
          />
          <span className="u-brk tl" aria-hidden="true" />
          <span className="u-brk tr" aria-hidden="true" />
          <span className="u-brk bl" aria-hidden="true" />
          <span className="u-brk br" aria-hidden="true" />
        </div>

        <div className={styles.eyebrow}>Say hello to</div>
        <div className={styles.nameRow}>
          <h1 className={styles.heading}>{character.name}</h1>
          {character.public_id ? <IdTag id={character.public_id} size="md" /> : null}
        </div>

        {intro ? <p className={styles.intro}>{intro}</p> : null}

        <div className={styles.actions}>
          <Button kind="quiet" size="lg" onClick={() => navigate({ kind: 'home' })}>
            Later
          </Button>
          <Button kind="accent" size="lg" onClick={sayHello}>
            Say hello
          </Button>
        </div>
      </div>
    </div>
  );
}
