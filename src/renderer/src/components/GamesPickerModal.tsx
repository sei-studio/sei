/**
 * GamesPickerModal — "Play together" tiled game grid (Phase 18/19).
 *
 * Opened from the chat header's Games button, the CharacterCard "Play" CTA, and
 * the CharacterPage "Play together" deploy button. Clicking an available game
 * tile launches it immediately through the shared summonFlow (skin-setup nudge →
 * LAN gate; a not-connected launch surfaces the LAN "open your world" modal —
 * the instruction to connect). Each available tile carries a top-right (i)
 * button that opens the two-column info window (game-about) instead of playing.
 * "More games" is a single dimmed coming-soon placeholder. Scrim-click / ESC
 * closes.
 *
 * Source: .planning/design/app-chat-and-memory.md §5 (GamesPickerModal) + R7.
 */

import React, { useEffect } from 'react';
import { useUiStore } from '../lib/stores/useUiStore';
import { attemptSummon } from '../lib/summonFlow';
import { GAMES, type GameDef } from '../lib/games';
import { MCBlock, GamepadIcon, InfoIcon } from './icons';
import styles from './GamesPickerModal.module.css';

export interface GamesPickerModalProps {
  characterId: string;
}

export function GamesPickerModal({ characterId }: GamesPickerModalProps): React.ReactElement {
  const openModal = useUiStore((s) => s.openModal);
  const closeModal = useUiStore((s) => s.closeModal);

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeModal();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [closeModal]);

  const onPlay = (g: GameDef): void => {
    if (!g.available) return;
    // Launch right away — attemptSummon runs the skin-setup nudge then the LAN
    // gate (opening the "open your world" modal if not connected).
    void attemptSummon(characterId);
    closeModal();
  };

  return (
    <div
      className={styles.scrim}
      role="dialog"
      aria-modal="true"
      aria-labelledby="games-picker-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeModal();
      }}
    >
      <div className={styles.modal}>
        <div className={styles.header}>
          <h2 id="games-picker-title" className={styles.title}>
            Play together
          </h2>
          <p className={styles.subtitle}>Pick a game to play with your companion.</p>
        </div>
        <div className={styles.grid}>
          {GAMES.map((g) => (
            <div
              key={g.id}
              className={`${styles.tile} ${g.available ? '' : styles.tileLocked} ${
                g.image ? styles.tileImage : ''
              }`}
              style={g.image ? { backgroundImage: `url(${g.image})` } : undefined}
            >
              <button
                type="button"
                className={styles.tileMain}
                disabled={!g.available}
                aria-disabled={!g.available}
                onClick={() => onPlay(g)}
              >
                {g.image ? null : (
                  <span className={styles.tileIcon}>
                    {g.id === 'minecraft' ? <MCBlock size={40} /> : <GamepadIcon size={30} />}
                  </span>
                )}
                <span className={styles.tileName}>{g.name}</span>
              </button>
              {g.available ? (
                <button
                  type="button"
                  className={styles.infoBtn}
                  onClick={(e) => {
                    e.stopPropagation();
                    openModal({ kind: 'game-about', characterId, gameId: g.id });
                  }}
                  aria-label={`About ${g.name}`}
                  title={`About ${g.name}`}
                >
                  <InfoIcon size={16} />
                </button>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
