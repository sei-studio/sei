/**
 * GameErrorModal — a bot-backed game session failed with one of the
 * game-neutral error classes (GAME_*; game adapters M0, 260908). Opened
 * centrally from useDataStore's onStatus routing (lib/botErrorRouting) so
 * every summon entry point is covered. Shows ERROR_COPY for the class plus
 * the bot's own message; "Try again" re-runs the game's summon flow.
 */
import React from 'react';
import type { GameId } from '@shared/gameIpc';
import type { ErrorClass } from '@shared/errorClasses';
import { useT } from '../lib/i18n';
import { Button } from './Button';
import { ModalShell, ModalFooter } from './ModalShell';
import { useUiStore } from '../lib/stores/useUiStore';
import { useDataStore } from '../lib/stores/useDataStore';
import { attemptSummon } from '../lib/summonFlow';
import { botGameName } from '../lib/gameLaunch';
import { ERROR_COPY, errorCopyText } from '../lib/errors';
import styles from './LanNotOpenModal.module.css';

export interface GameErrorModalProps {
  game: GameId;
  characterId: string;
  error: ErrorClass;
  message: string;
}

export function GameErrorModal({ game, characterId, error, message }: GameErrorModalProps): React.ReactElement {
  const t = useT();
  const closeModal = useUiStore((s) => s.closeModal);
  const rawName = useDataStore((s) => s.characters.find((c) => c.id === characterId)?.name ?? null);
  const name = rawName ?? t('Your companion');
  const gameName = botGameName(game);
  const copy = ERROR_COPY[error] ? errorCopyText(error, t) : message;
  const onTryAgain = (): void => {
    closeModal();
    void attemptSummon(characterId, game);
  };
  const title = t("{name} couldn't join {game}", { name, game: gameName });
  return (
    <ModalShell title={title} width={480} scrimClose onClose={closeModal} aria-label={title}>
      <p className={styles.body}>{copy}</p>
      {message && message !== copy ? <p className={styles.hint}>{message}</p> : null}
      <ModalFooter>
        <Button kind="quiet" size="md" onClick={closeModal}>
          {t('Close')}
        </Button>
        <Button kind="primary" size="md" onClick={onTryAgain}>
          {t('Try again')}
        </Button>
      </ModalFooter>
    </ModalShell>
  );
}
