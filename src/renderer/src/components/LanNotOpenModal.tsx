/**
 * LanNotOpenModal — a summon failed with error class LAN_NOT_OPEN: the world
 * closed, kicked the bot, or was never reachable. 45-day prod data showed
 * users hitting this repeatedly (one churned after 8 hits in a day) with only
 * a one-line status for guidance, so the failure now opens this popup with
 * the numbered "open to LAN" steps.
 *
 * Opened centrally by the onStatus subscription in useDataStore.wireIpc
 * (mirrors UnsupportedVersionModal) so every summon entry point is covered.
 * "Try again" re-runs the normal summon flow: if the world is still closed it
 * lands on the searching LanModal, which auto-resumes once LAN opens.
 */

import React from 'react';
import { Button } from './Button';
import { ModalShell, ModalFooter } from './ModalShell';
import { useUiStore } from '../lib/stores/useUiStore';
import { useDataStore } from '../lib/stores/useDataStore';
import { attemptSummon } from '../lib/summonFlow';
import styles from './LanNotOpenModal.module.css';

const STEPS: readonly string[] = [
  'Open your world in Minecraft Java.',
  'Press Esc and choose Open to LAN.',
  'Click Start LAN World.',
  'Return to Sei and try the summon again.',
];

export interface LanNotOpenModalProps {
  characterId: string;
}

export function LanNotOpenModal({ characterId }: LanNotOpenModalProps): React.ReactElement {
  const closeModal = useUiStore((s) => s.closeModal);
  const name = useDataStore(
    (s) => s.characters.find((c) => c.id === characterId)?.name ?? 'Your companion',
  );
  const onTryAgain = (): void => {
    closeModal();
    void attemptSummon(characterId);
  };
  return (
    <ModalShell
      title="Couldn't reach your world"
      width={480}
      scrimClose
      onClose={closeModal}
      aria-label="Couldn't reach your world"
    >
      <p className={styles.body}>
        <strong>{name}</strong> couldn&apos;t join because no open LAN world was found. To fix it:
      </p>
      <ol className={styles.steps}>
        {STEPS.map((step, i) => (
          <li key={i} className={styles.step}>
            <span className={styles.stepNumber}>{String(i + 1).padStart(2, '0')}</span>
            <span className={styles.stepBody}>{step}</span>
          </li>
        ))}
      </ol>
      <p className={styles.hint}>
        The world must be running on this computer or another computer on the same network. Once
        it is open to LAN, Sei finds it automatically.
      </p>
      <ModalFooter>
        <Button kind="quiet" size="md" onClick={closeModal}>
          Close
        </Button>
        <Button kind="primary" size="md" onClick={onTryAgain}>
          Try again
        </Button>
      </ModalFooter>
    </ModalShell>
  );
}
