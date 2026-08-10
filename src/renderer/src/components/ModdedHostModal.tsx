/**
 * ModdedHostModal — a summon was rejected because the world runs Forge or
 * NeoForge and its mods have to be on the client too (260806).
 *
 * This used to be classified LAN_NOT_OPEN, so the player got the "open your
 * world to LAN" steps for a world that was open, reachable, and answering
 * status pings. Measured live: one user re-opened their world to LAN four times
 * across five summons before giving up and switching worlds. Nothing in the
 * product ever said the word "mods".
 *
 * Deliberately NO "Try again" button, unlike LanNotOpenModal and BotCrashModal.
 * A modded world rejects a vanilla client deterministically, so retrying is the
 * one action guaranteed not to work, and offering it is what produced the loop
 * in the first place. The actions offered are the two that actually resolve it.
 *
 * Opened centrally by the onStatus subscription in useDataStore.wireIpc,
 * mirroring LanNotOpenModal / UnsupportedVersionModal, so every summon entry
 * point is covered.
 */

import React from 'react';
import { useT } from '../lib/i18n';
import { Button } from './Button';
import { ModalShell, ModalFooter } from './ModalShell';
import { useUiStore } from '../lib/stores/useUiStore';
import { useDataStore } from '../lib/stores/useDataStore';
import styles from './LanNotOpenModal.module.css';

const OPTIONS: readonly string[] = [
  'Open a world with no mods, or with Fabric and only client-side mods like minimaps.',
  'If you host the modded world yourself, Sei can join it once the mods are not required on the client.',
];

export interface ModdedHostModalProps {
  characterId: string;
}

export function ModdedHostModal({ characterId }: ModdedHostModalProps): React.ReactElement {
  const t = useT();
  const closeModal = useUiStore((s) => s.closeModal);
  const rawName = useDataStore((s) => s.characters.find((c) => c.id === characterId)?.name ?? null);
  const name = rawName ?? t('Your companion');
  // Keep the <strong> around the name: translate with the {name} placeholder
  // intact, then split on it and re-insert the styled node.
  const [bodyBefore, bodyAfter] = t(
    '{name} was turned away by this world. It runs Forge or NeoForge, and it only lets in players who have the same mods installed.',
  ).split('{name}');
  return (
    <ModalShell
      title={t('This world needs mods')}
      width={480}
      scrimClose
      onClose={closeModal}
      aria-label={t('This world needs mods')}
    >
      <p className={styles.body}>
        {bodyBefore}
        <strong>{name}</strong>
        {bodyAfter}
      </p>
      <ol className={styles.steps}>
        {OPTIONS.map((option, i) => (
          <li key={i} className={styles.step}>
            <span className={styles.stepNumber}>{String(i + 1).padStart(2, '0')}</span>
            <span className={styles.stepBody}>{t(option)}</span>
          </li>
        ))}
      </ol>
      <p className={styles.hint}>
        {t(
          'Sei joins as a normal Minecraft client, so it cannot load a world that requires mods. Your world stays exactly as it is, Sei just cannot get in.',
        )}
      </p>
      <ModalFooter>
        <Button kind="primary" size="md" onClick={closeModal}>
          {t('Got it')}
        </Button>
      </ModalFooter>
    </ModalShell>
  );
}
