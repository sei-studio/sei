/**
 * CrossLaunchConfirmModal — "X is still running. End it and start Y?" (260721).
 *
 * Opened by lib/gameLaunch.requestGameLaunch when a game launch is attempted
 * while ANOTHER game is active for the same companion. Confirming ends the
 * previous session via its normal end path (chess writes its unfinished
 * history row) and then runs the parked launch; Cancel drops it. Mounted at
 * the App shell level off the useUiStore modal.
 */

import React from 'react';
import { ModalShell, ModalFooter } from './ModalShell';
import { Button } from './Button';
import {
  cancelCrossLaunch,
  confirmCrossLaunch,
  type LaunchGameId,
} from '../lib/gameLaunch';
import confirmStyles from './confirmModal.module.css';

export interface CrossLaunchConfirmModalProps {
  characterId: string;
  fromId: LaunchGameId;
  fromName: string;
  toName: string;
}

export function CrossLaunchConfirmModal({
  characterId,
  fromId,
  fromName,
  toName,
}: CrossLaunchConfirmModalProps): React.ReactElement {
  return (
    <ModalShell title="Switch games" onClose={cancelCrossLaunch} scrimClose>
      <p className={confirmStyles.body}>
        {fromName} is still running. End it and start {toName}?
      </p>
      <ModalFooter>
        <Button kind="quiet" size="md" onClick={cancelCrossLaunch}>
          Cancel
        </Button>
        <Button
          kind="primary"
          size="md"
          onClick={() => void confirmCrossLaunch(characterId, fromId)}
        >
          End and start
        </Button>
      </ModalFooter>
    </ModalShell>
  );
}
