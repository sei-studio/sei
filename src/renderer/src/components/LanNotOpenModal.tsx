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
import { useT } from '../lib/i18n';
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
  const t = useT();
  const closeModal = useUiStore((s) => s.closeModal);
  const rawName = useDataStore((s) => s.characters.find((c) => c.id === characterId)?.name ?? null);
  const name = rawName ?? t('Your companion');
  const onTryAgain = (): void => {
    closeModal();
    void attemptSummon(characterId);
  };
  // Keep the <strong> around the name: translate with the {name} placeholder
  // intact, then split on it and re-insert the styled node.
  const [bodyBefore, bodyAfter] = t(
    "{name} couldn't join because no open LAN world was found. To fix it:",
  ).split('{name}');
  return (
    <ModalShell
      title={t("Couldn't reach your world")}
      width={480}
      scrimClose
      onClose={closeModal}
      aria-label={t("Couldn't reach your world")}
    >
      <p className={styles.body}>
        {bodyBefore}
        <strong>{name}</strong>
        {bodyAfter}
      </p>
      <ol className={styles.steps}>
        {STEPS.map((step, i) => (
          <li key={i} className={styles.step}>
            <span className={styles.stepNumber}>{String(i + 1).padStart(2, '0')}</span>
            <span className={styles.stepBody}>{t(step)}</span>
          </li>
        ))}
      </ol>
      <p className={styles.hint}>
        {t(
          'The world must be running on this computer or another computer on the same network. Once it is open to LAN, Sei finds it automatically.',
        )}
      </p>
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
