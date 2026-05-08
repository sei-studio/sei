/**
 * HomeScreen — character grid + LAN pill + "+ New" header.
 *
 * UI-SPEC §HomeScreen + D-43..D-45:
 *  - H1 "Characters" sans 32 / 600 -0.6 letter-spacing.
 *  - LAN pill button → openModal({kind:'lan', mode:'info'}); colored 7px dot.
 *  - "+ New" → navigate({kind:'add-character'}).
 *  - Grid: repeat(auto-fill, minmax(220px, 1fr)) 18px gap; AddCard at end.
 *
 * Summon flow:
 *  - LAN connected → fire-and-forget sei.summon(id) and navigate to character.
 *  - Otherwise → setPendingSummon(id) + openModal({kind:'lan', mode:'searching'}).
 *    Plan 08's LanModal in 'searching' mode reads pendingSummonId and watches
 *    useDataStore.lan to auto-resume on connected.
 *
 * Source: 04-07 Task 3.
 */

import React from 'react';
import { sei } from '../lib/ipcClient';
import { useUiStore } from '../lib/stores/useUiStore';
import { useDataStore } from '../lib/stores/useDataStore';
import { Button } from '../components/Button';
import { CharacterCard } from '../components/CharacterCard';
import { AddCard } from '../components/AddCard';
import styles from './HomeScreen.module.css';

function lanLabel(kind: 'connected' | 'not_connected' | 'unavailable'): string {
  if (kind === 'connected') return 'CONNECTED';
  if (kind === 'not_connected') return 'NOT CONNECTED';
  return 'UNAVAILABLE';
}

export function HomeScreen(): React.ReactElement {
  const characters = useDataStore((s) => s.characters);
  const lan = useDataStore((s) => s.lan);
  const navigate = useUiStore((s) => s.navigate);
  const openModal = useUiStore((s) => s.openModal);
  const setPendingSummon = useUiStore((s) => s.setPendingSummon);

  // Resolve theme by reading data-theme attribute set by lib/theme.ts applyTheme.
  // CharacterCard's PixelPortrait palette index is theme-stable across switches —
  // only the colors at that index change.
  const theme: 'light' | 'dark' =
    (document.documentElement.getAttribute('data-theme') as 'light' | 'dark') ?? 'light';

  const lanDotColor =
    lan.kind === 'connected'
      ? 'var(--green)'
      : lan.kind === 'not_connected'
        ? 'var(--red)'
        : 'var(--muted)';
  const lanTitle =
    lan.kind === 'unavailable' ? 'LAN auto-detect unavailable on this network.' : undefined;

  const handleSummon = (id: string) => {
    if (lan.kind === 'connected') {
      // Errors surface via onStatus; fire-and-forget here.
      sei.summon(id).catch(() => {
        /* error variant lands in BotStatus; CharacterPage renders it */
      });
      navigate({ kind: 'character', id });
    } else {
      setPendingSummon(id);
      openModal({ kind: 'lan', mode: 'searching' });
    }
  };

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <h1 className={styles.title}>Characters</h1>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.lanPill}
            onClick={() => openModal({ kind: 'lan', mode: 'info' })}
            title={lanTitle}
            aria-label={`LAN: ${lanLabel(lan.kind).toLowerCase()}`}
          >
            <span className={styles.lanDot} style={{ background: lanDotColor }} />
            {lanLabel(lan.kind)}
          </button>
          <Button kind="ghost" size="md" onClick={() => navigate({ kind: 'add-character' })}>
            + New
          </Button>
        </div>
      </header>
      <section className={styles.grid}>
        {characters.map((c) => (
          <CharacterCard
            key={c.id}
            character={c}
            theme={theme}
            onOpen={() => navigate({ kind: 'character', id: c.id })}
            onSummon={() => handleSummon(c.id)}
          />
        ))}
        <AddCard onClick={() => navigate({ kind: 'add-character' })} />
      </section>
    </div>
  );
}
