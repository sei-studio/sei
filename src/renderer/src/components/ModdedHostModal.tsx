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
 * 260929: also opened for a summon that TIMED OUT on a known modded host
 * (the supervisor reports that as MODDED_HOST_REJECTED; before, it was a
 * generic 30s timeout that said nothing about mods). A Fabric or Quilt host
 * gets its own body sentence, since "runs Forge or NeoForge" would be wrong.
 *
 * 261007: also Fabric when the kick itself says so (the host classifier reads
 * many Fabric clients as unknown), and the mods a Fabric kick names are shown.
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
import { messageSaysFabric, namedMods } from '../lib/moddedHost';
import styles from './LanNotOpenModal.module.css';

// 261007: the first option used to recommend "Fabric with only client-side
// mods like minimaps". In the 30 days to 261006 half of these rejections were
// Fabric worlds, and both on 0.6.7 named Xaero's Minimap and World Map as the
// mods the world required, so the copy pointed players at the cause.
const SEI_PROFILE_OPTION =
  'Open a world from the Sei profile in the Minecraft Launcher, open it to LAN, and press Launch again.';
const FABRIC_OPTION =
  "Or play this world without the mods that add content. Map mods count too: Xaero's Minimap and World Map make a world require them.";
const FORGE_OPTION =
  'If you host the modded world yourself, Sei can join it once the mods are not required on the client.';

export interface ModdedHostModalProps {
  characterId: string;
  /** The bot's humanized kick message (MODDED_HOST_REJECTED status). */
  message?: string;
}

export function ModdedHostModal({ characterId, message }: ModdedHostModalProps): React.ReactElement {
  const t = useT();
  const closeModal = useUiStore((s) => s.closeModal);
  const rawName = useDataStore((s) => s.characters.find((c) => c.id === characterId)?.name ?? null);
  const name = rawName ?? t('Your companion');
  const hostClient = useDataStore((s) => (s.lan.kind === 'open' ? s.lan.host?.client ?? null : null));
  // The host classifier often reads a Fabric client as 'unknown'; the kick
  // itself says Fabric, so either source counts (261007).
  const fabricLike = hostClient === 'fabric' || hostClient === 'quilt' || messageSaysFabric(message);
  const loader = hostClient === 'quilt' || (!hostClient && /\bquilt\b/i.test(message ?? '')) ? 'Quilt' : 'Fabric';
  const mods = fabricLike ? namedMods(message) : [];
  const options = [SEI_PROFILE_OPTION, fabricLike ? FABRIC_OPTION : FORGE_OPTION];
  // Keep the <strong> around the name: translate with the {name} placeholder
  // intact, then split on it and re-insert the styled node.
  const [bodyBefore, bodyAfter] = (
    fabricLike
      ? t(
          '{name} could not get into this world. It runs {loader} with other mods, and some mods only let in players who have them installed too.',
          { loader },
        )
      : t(
          '{name} was turned away by this world. It runs Forge or NeoForge, and it only lets in players who have the same mods installed.',
        )
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
      {mods.length ? (
        <p className={styles.body}>{t('The world asked for these mods: {mods}.', { mods: mods.join(', ') })}</p>
      ) : null}
      <ol className={styles.steps}>
        {options.map((option, i) => (
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
