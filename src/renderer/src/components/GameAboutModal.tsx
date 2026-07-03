/**
 * GameAboutModal — two-column game info window (Phase 18/19).
 *
 * Opened from a game tile's top-right (i) button. Left column: a game image
 * (placeholder for now) with the game name + studio underneath. Right column:
 * the description and how-to-set-up steps, plus a Play CTA that launches through
 * the shared summonFlow (skin-setup nudge → LAN gate). Scrim-click / ESC closes.
 *
 * Source: .planning/design/app-chat-and-memory.md §5 (GameAboutModal) + R7.
 */

import React, { useEffect } from 'react';
import { useUiStore } from '../lib/stores/useUiStore';
import { useDataStore } from '../lib/stores/useDataStore';
import { attemptSummon } from '../lib/summonFlow';
import { findGame } from '../lib/games';
import { Button } from './Button';
import { MCBlock, GamepadIcon, SparkleIcon } from './icons';
import styles from './GameAboutModal.module.css';

export interface GameAboutModalProps {
  characterId: string;
  gameId: string;
}

export function GameAboutModal({ characterId, gameId }: GameAboutModalProps): React.ReactElement {
  const closeModal = useUiStore((s) => s.closeModal);
  const character = useDataStore((s) => s.characters.find((c) => c.id === characterId));

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeModal();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [closeModal]);

  const game = findGame(gameId);
  const companionName = character?.name ?? 'your companion';
  const description = game?.description(companionName) ?? '';

  const onPlay = (): void => {
    // Canonical path: username-conflict guard, one-time skin-setup nudge, and
    // the LAN "open your world" modal if not connected.
    void attemptSummon(characterId);
    closeModal();
  };

  return (
    <div
      className={styles.scrim}
      role="dialog"
      aria-modal="true"
      aria-labelledby="game-about-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeModal();
      }}
    >
      <div className={styles.modal}>
        {/* Left — image placeholder + name + studio */}
        <div className={styles.left}>
          <div className={styles.image} aria-hidden="true">
            {game?.image ? (
              <img src={game.image} alt="" className={styles.imageImg} />
            ) : gameId === 'minecraft' ? (
              <MCBlock size={72} />
            ) : (
              <GamepadIcon size={56} />
            )}
          </div>
          <h2 id="game-about-title" className={styles.name}>
            {game?.name ?? 'Game'}
          </h2>
          {game?.studio ? <span className={styles.studio}>{game.studio}</span> : null}
        </div>

        {/* Right — description + how to set up */}
        <div className={styles.right}>
          <p className={styles.description}>{description}</p>

          {game && game.setup.length > 0 ? (
            <>
              <h3 className={styles.setupTitle}>How to set up</h3>
              <ol className={styles.setupList}>
                {game.setup.map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
              </ol>
            </>
          ) : null}

          <div className={styles.actions}>
            <Button kind="quiet" size="md" onClick={closeModal}>
              Close
            </Button>
            {game?.available ? (
              <Button kind="accent" size="md" icon={<SparkleIcon size={14} />} onClick={onPlay}>
                Play
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
