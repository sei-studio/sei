/**
 * BotCrashModal — a LIVE bot session (past summon-ready) died unexpectedly:
 * the child process crashed or was killed with no stop requested. Before this
 * popup a mid-session death was completely silent — the widget just vanished.
 *
 * Opened centrally by the onStatus subscription in useDataStore.wireIpc
 * (mirrors LanNotOpenModal / UnsupportedVersionModal) on a BotStatus error
 * carrying `midSession: true`, for error classes without a dedicated surface
 * (LAN_NOT_OPEN and UNSUPPORTED_MC_VERSION open their own modals instead).
 *
 * Copy branches on the analytics opt-out state so the "a crash report was
 * sent" line is honest: captureDiagnostic no-ops when the user opted out.
 */

import React from 'react';
import { Button } from './Button';
import { ModalShell, ModalFooter } from './ModalShell';
import { useUiStore } from '../lib/stores/useUiStore';
import { useDataStore } from '../lib/stores/useDataStore';
import { attemptSummon } from '../lib/summonFlow';
import styles from './BotCrashModal.module.css';

export interface BotCrashModalProps {
  characterId: string;
}

export function BotCrashModal({ characterId }: BotCrashModalProps): React.ReactElement {
  const closeModal = useUiStore((s) => s.closeModal);
  const analyticsOptOut = useUiStore((s) => s.analyticsOptOut);
  const name = useDataStore(
    (s) => s.characters.find((c) => c.id === characterId)?.name ?? 'Your companion',
  );
  const onSummonAgain = (): void => {
    closeModal();
    void attemptSummon(characterId);
  };
  return (
    <ModalShell
      title="Connection lost"
      width={480}
      scrimClose
      onClose={closeModal}
      aria-label="Connection lost"
    >
      <p className={styles.body}>
        Something went wrong and <strong>{name}</strong> disconnected. Sorry about that.{' '}
        {analyticsOptOut
          ? 'Crash reports are turned off, so nothing was sent. You can turn them on in Settings to help us fix issues like this.'
          : 'A crash report was sent automatically and we will work on a fix. You can turn off crash reports in Settings.'}
      </p>
      <ModalFooter>
        <Button kind="quiet" size="md" onClick={closeModal}>
          Close
        </Button>
        <Button kind="primary" size="md" onClick={onSummonAgain}>
          Summon again
        </Button>
      </ModalFooter>
    </ModalShell>
  );
}
