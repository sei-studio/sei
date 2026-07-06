/**
 * GameAboutModal — per-game info sheet (Party redesign §4.9, on ModalShell).
 *
 * Opened from a game row's (i) button. Shows the block icon + studio, the
 * companion-name-aware description, and the how-to-set-up steps. Footer: quiet
 * Close + an accent Play that launches through the shared summonFlow (username
 * guard → skin-setup nudge → LAN gate). Copy is preserved from the games catalog.
 *
 * Source: .planning/design/UI-REDESIGN-PARTY.md §4.9 + app-chat-and-memory §5.
 */

import React from 'react';
import { useUiStore } from '../lib/stores/useUiStore';
import { useDataStore } from '../lib/stores/useDataStore';
import { attemptSummon } from '../lib/summonFlow';
import { findGame } from '../lib/games';
import { Button } from './Button';
import { ModalShell, ModalFooter } from './ModalShell';
import { MCBlock, GamepadIcon, SparkleIcon } from './icons';
import styles from './GameAboutModal.module.css';

export interface GameAboutModalProps {
  characterId: string;
  gameId: string;
}

export function GameAboutModal({ characterId, gameId }: GameAboutModalProps): React.ReactElement {
  const closeModal = useUiStore((s) => s.closeModal);
  const character = useDataStore((s) => s.characters.find((c) => c.id === characterId));

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
    <ModalShell
      title={game?.name ?? 'Game'}
      width={440}
      scrimClose
      onClose={closeModal}
      aria-label={`About ${game?.name ?? 'game'}`}
    >
      <div className={styles.head}>
        <span className={styles.icon} aria-hidden="true">
          {game?.image ? (
            <img src={game.image} alt="" className={styles.iconImg} />
          ) : gameId === 'minecraft' ? (
            <MCBlock size={44} />
          ) : (
            <GamepadIcon size={36} />
          )}
        </span>
        {game?.studio ? <span className={styles.studio}>{game.studio}</span> : null}
      </div>

      <p className={styles.description}>{description}</p>

      {game && game.setup.length > 0 ? (
        <>
          <h4 className={styles.setupTitle}>How to set up</h4>
          <ol className={styles.setupList}>
            {game.setup.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
        </>
      ) : null}

      <ModalFooter>
        <Button kind="quiet" size="md" onClick={closeModal}>
          Close
        </Button>
        {game?.available ? (
          <Button kind="accent" size="md" icon={<SparkleIcon size={14} />} onClick={onPlay}>
            Play
          </Button>
        ) : null}
      </ModalFooter>
    </ModalShell>
  );
}
