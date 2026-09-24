/**
 * StardewSetupModal (game adapters M1): the body of the {kind:'game-setup',
 * game:'stardew'} modal the summon flow opens when no farm is open. Same
 * contract as the generic GameSetupModal (pending summon parked in
 * useUiStore, AUTO-RESUME when worlds.stardew flips open, Close drops the
 * attempt) with the Stardew-specific steps in the body: install when the
 * mod is missing, start the game when it is not running, load a farm when
 * it sits on the title screen.
 */
import React, { useEffect } from 'react';
import type { GameId } from '@shared/gameIpc';
import { useT } from '../../lib/i18n';
import { Button } from '../Button';
import { ModalShell, ModalFooter } from '../ModalShell';
import { useUiStore } from '../../lib/stores/useUiStore';
import { useDataStore } from '../../lib/stores/useDataStore';
import { useStardewStore } from '../../lib/stores/useStardewStore';
import { attemptSummon, launchSummon } from '../../lib/summonFlow';
import { progressLine, installErrorCopy } from './stardewCopy';
import styles from '../LanNotOpenModal.module.css';

export interface StardewSetupModalProps {
  game: GameId;
}

export function StardewSetupModal(_props: StardewSetupModalProps): React.ReactElement {
  const t = useT();
  const game: GameId = 'stardew';
  const closeModal = useUiStore((s) => s.closeModal);
  const pendingSummonId = useUiStore((s) => s.pendingSummonId);
  const pendingSummonGame = useUiStore((s) => s.pendingSummonGame);
  const returnToChat = useUiStore((s) => s.pendingSummonReturnToChat);
  const setPendingSummon = useUiStore((s) => s.setPendingSummon);
  const setPendingSummonReturnToChat = useUiStore((s) => s.setPendingSummonReturnToChat);
  const world = useDataStore((s) => s.worlds.stardew);
  const install = useStardewStore((s) => s.state);
  const installing = useStardewStore((s) => s.installing);
  const installError = useStardewStore((s) => s.installError);
  const progress = useStardewStore((s) => s.progress);
  const launching = useStardewStore((s) => s.launching);
  const refresh = useStardewStore((s) => s.refresh);
  const init = useStardewStore((s) => s.init);
  const runInstall = useStardewStore((s) => s.install);
  const launchGame = useStardewStore((s) => s.launchGame);
  const open = world?.kind === 'open';

  useEffect(() => {
    const off = init();
    void refresh();
    return off;
  }, [init, refresh]);

  // Auto-resume once the farm opens (mirrors McSetupModal's D-56 resume).
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
  }, [open, pendingSummonId, pendingSummonGame, returnToChat, closeModal, setPendingSummon, setPendingSummonReturnToChat]);

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

  let body: React.ReactNode;
  let action: React.ReactNode = null;
  if (!install) {
    body = <p className={styles.body}>{t('Checking your Stardew Valley install...')}</p>;
  } else if (!install.gamePath) {
    body = <p className={styles.body}>{t('Stardew Valley was not found on this computer. Install it from Steam or GOG, then try again.')}</p>;
  } else if (!install.ready) {
    const line = progressLine(progress);
    const err = installErrorCopy(installError);
    body = (
      <>
        <p className={styles.body}>{t("Sei's helper mod is not set up in your game yet. It is a one-time install (SMAPI plus the mod); the game must be closed.")}</p>
        {installing ? <p className={styles.hint}>{t(line.key, { pct: line.pct ?? 0 })}</p> : null}
        {err && !installing ? <p className={styles.hint}>{t(err.copy)}</p> : null}
      </>
    );
    action = (
      <Button kind="primary" size="md" disabled={installing} onClick={() => void runInstall()}>
        {installing ? t('Setting up...') : t("Install SMAPI + Sei's helper")}
      </Button>
    );
  } else if (world?.kind === 'game_running_no_save') {
    body = <p className={styles.body}>{t('Stardew Valley is running. Load the farm you want to play on; your companion joins as soon as it is open.')}</p>;
  } else {
    body = <p className={styles.body}>{t('Sei could not find an open farm. Start Stardew Valley with Sei, load your farm, and your companion joins as soon as it appears.')}</p>;
    action = (
      <Button kind="primary" size="md" disabled={launching} onClick={() => void launchGame()}>
        {launching ? t('Starting...') : t('Launch Stardew Valley (with Sei)')}
      </Button>
    );
  }

  const title = t('Open your {game} world', { game: 'Stardew Valley' });
  return (
    <ModalShell title={title} width={480} scrimClose onClose={onClose} aria-label={title}>
      {body}
      <p className={styles.hint}>{t('Sei keeps looking while this window is open.')}</p>
      <ModalFooter>
        <Button kind="quiet" size="md" onClick={onClose}>{t('Close')}</Button>
        {action}
        <Button kind={action ? 'ghost' : 'primary'} size="md" onClick={onTryAgain}>{t('Try again')}</Button>
      </ModalFooter>
    </ModalShell>
  );
}
