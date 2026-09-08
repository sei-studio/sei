/**
 * GameSetupModal — the generic per-game setup window (game adapters M0,
 * 260908). Minecraft has its own (McSetupModal); this is the placeholder the
 * generic summon flow opens for the other bot-backed games when their world
 * is not open. The game agents fill the body (the install / enable / launch
 * steps) — the contract they inherit:
 *
 *   - opened as {kind:'game-setup', game} with useUiStore.pendingSummonId +
 *     pendingSummonGame set by summonFlows[game];
 *   - AUTO-RESUME: when useDataStore.worlds[game] flips to 'open' while a
 *     summon is pending for this game, launch it (launchSummon) and close;
 *   - "Try again" runs the game's summon flow; Close drops the attempt.
 */
import React, { useEffect } from 'react';
import type { GameId } from '@shared/gameIpc';
import { useT } from '../lib/i18n';
import { Button } from './Button';
import { ModalShell, ModalFooter } from './ModalShell';
import { useUiStore } from '../lib/stores/useUiStore';
import { useDataStore } from '../lib/stores/useDataStore';
import { attemptSummon, launchSummon } from '../lib/summonFlow';
import { botGameName } from '../lib/gameLaunch';
import styles from './LanNotOpenModal.module.css';

export interface GameSetupModalProps {
  game: GameId;
}

/**
 * Per-game bodies (game adapters M1): a game registers its own setup modal
 * component here and this generic one steps aside for it. Same contract
 * (pending summon, auto-resume, Close drops the attempt).
 */
const GAME_SETUP_MODALS: Partial<Record<GameId, React.ComponentType<GameSetupModalProps>>> = {};

export function registerGameSetupModal(game: GameId, Component: React.ComponentType<GameSetupModalProps>): void {
  GAME_SETUP_MODALS[game] = Component;
}

export function GameSetupModal(props: GameSetupModalProps): React.ReactElement {
  const Override = GAME_SETUP_MODALS[props.game];
  if (Override) return <Override {...props} />;
  return <GenericGameSetupModal {...props} />;
}

function GenericGameSetupModal({ game }: GameSetupModalProps): React.ReactElement {
  const t = useT();
  const name = botGameName(game);
  const closeModal = useUiStore((s) => s.closeModal);
  const pendingSummonId = useUiStore((s) => s.pendingSummonId);
  const pendingSummonGame = useUiStore((s) => s.pendingSummonGame);
  const returnToChat = useUiStore((s) => s.pendingSummonReturnToChat);
  const setPendingSummon = useUiStore((s) => s.setPendingSummon);
  const setPendingSummonReturnToChat = useUiStore((s) => s.setPendingSummonReturnToChat);
  const world = useDataStore((s) => s.worlds[game]);
  const open = world?.kind === 'open';

  // Auto-resume once the world opens (mirrors McSetupModal's D-56 resume).
  useEffect(() => {
    if (!open) return;
    if (!pendingSummonId || pendingSummonGame !== game) {
      closeModal();
      return;
    }
    const id = pendingSummonId;
    const toChat = returnToChat;
    setPendingSummon(null);
    setPendingSummonReturnToChat(false);
    closeModal();
    launchSummon(id, toChat, game);
  }, [open, game, pendingSummonId, pendingSummonGame, returnToChat, closeModal, setPendingSummon, setPendingSummonReturnToChat]);

  const onTryAgain = (): void => {
    const id = pendingSummonId;
    closeModal();
    if (id) void attemptSummon(id, game);
  };
  const onClose = (): void => {
    setPendingSummon(null);
    setPendingSummonReturnToChat(false);
    closeModal();
  };

  return (
    <ModalShell title={t('Open your {game} world', { game: name })} width={480} scrimClose onClose={onClose} aria-label={t('Open your {game} world', { game: name })}>
      <p className={styles.body}>
        {t('Sei could not find an open {game} world. Open your world in the game with the Sei mod enabled; your companion joins as soon as it appears.', { game: name })}
      </p>
      <p className={styles.hint}>{t('Sei keeps looking while this window is open.')}</p>
      <ModalFooter>
        <Button kind="quiet" size="md" onClick={onClose}>
          {t('Close')}
        </Button>
        <Button kind="primary" size="md" onClick={onTryAgain}>
          {t('Try again')}
        </Button>
      </ModalFooter>
    </ModalShell>
  );
}
