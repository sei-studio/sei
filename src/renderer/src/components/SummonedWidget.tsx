/**
 * SummonedWidget — a floating "in your world" popup (chat change #7).
 *
 * Whenever one or more companions have a live in-game session (summon status
 * online/connecting), this renders a small stack of call-popup-style cards in
 * the bottom-right — portrait + name + status + an Unsummon button — so the user
 * can end a session from anywhere in the app. Rendered once at the App shell
 * level so it persists across navigation. Renders nothing when no bot is live.
 */

import React from 'react';
import { useDataStore } from '../lib/stores/useDataStore';
import { sei } from '../lib/ipcClient';
import { pickPalette } from '../lib/portraitPalettes';
import { PixelPortrait } from './PixelPortrait';
import { Button } from './Button';
import { UserIcon } from './icons';
import styles from './SummonedWidget.module.css';

export function SummonedWidget(): React.ReactElement | null {
  const summons = useDataStore((s) => s.summons);
  const characters = useDataStore((s) => s.characters);

  const active = Object.values(summons).filter(
    (st) => st.kind === 'online' || st.kind === 'connecting',
  );
  if (active.length === 0) return null;

  const theme: 'light' | 'dark' =
    (document.documentElement.getAttribute('data-theme') as 'light' | 'dark') ?? 'light';

  return (
    <div className={styles.stack}>
      {active.map((st) => {
        const c = characters.find((ch) => ch.id === st.characterId);
        const name = c?.name ?? 'Companion';
        const connecting = st.kind === 'connecting';
        return (
          <div key={st.characterId} className={styles.widget}>
            <div className={styles.avatar}>
              {c ? (
                <PixelPortrait
                  seed={c.id + c.name}
                  palette={pickPalette(c.id + c.name, theme)}
                  size={30}
                  portraitImage={c.portrait_image}
                  style={{ width: '100%', height: '100%' }}
                />
              ) : (
                <UserIcon size={16} />
              )}
            </div>
            <div className={styles.meta}>
              <span className={styles.name}>{name}</span>
              <span className={styles.status}>
                <span
                  className={`${styles.dot} ${connecting ? styles.dotConnecting : ''}`}
                  aria-hidden="true"
                />
                {connecting ? 'Summoning…' : 'In your world'}
              </span>
            </div>
            <Button kind="danger" size="sm" onClick={() => void sei.stop(st.characterId)}>
              Unsummon
            </Button>
          </div>
        );
      })}
    </div>
  );
}
