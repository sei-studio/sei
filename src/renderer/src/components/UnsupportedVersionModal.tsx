/**
 * UnsupportedVersionModal — the world runs a Minecraft version Sei can't join
 * (outside minecraft-protocol's supported set, e.g. a brand-new snapshot).
 *
 * Opened centrally by the onStatus subscription in useDataStore.wireIpc when a
 * summon dies with error class UNSUPPORTED_MC_VERSION. Before this popup, the
 * error only reached the character page's model row, so a summon started from
 * the Play flow appeared to do nothing (260709 report).
 *
 * The body names the world's version (parsed from the bot's error text, else
 * the LAN watcher's ping) and the exact supported range from
 * minecraft-protocol's table, followed by numbered launcher steps (mirroring
 * LanNotOpenModal) for making an installation on a supported version. 260926:
 * the body used to be the bot's raw English sentence, so it was never
 * translated.
 * Dismiss-only; the user resolves it by opening a world on a supported
 * version. Modeled on SummonConflictModal.
 */

import React from 'react';
import { t as tr, useT } from '../lib/i18n';
import { MC_RANGE_VARS, MC_SUPPORTED_RANGE } from '../lib/mcVersions';
import { Button } from './Button';
import { ModalShell, ModalFooter } from './ModalShell';
import { useUiStore } from '../lib/stores/useUiStore';
import { useDataStore } from '../lib/stores/useDataStore';
import styles from './UnsupportedVersionModal.module.css';

/**
 * Highest Minecraft Java version Sei's networking stack can join. Derived from
 * minecraft-protocol's table (lib/mcVersions), and the same version the setup
 * wizard installs by, so this copy never names a version the wizard would
 * not build.
 */
const LATEST_SUPPORTED: string = MC_SUPPORTED_RANGE.newest;

// Rendered through t(step, { version }). The {version} placeholder is filled
// at display time so the step copy stays a stable dictionary key. 260926:
// spells out the launcher's own path (Installations, New installation,
// Version) since the old "create or select an installation" left players
// guessing where the version is chosen.
const STEPS: readonly string[] = [
  'Open the Minecraft Launcher and go to the Installations tab.',
  'Click New installation, pick release {version} in the Version list, then click Create.',
  'Press Play on that installation, open your world, then choose Open to LAN.',
  'Return to Sei and press Launch again.',
];

export interface UnsupportedVersionModalProps {
  characterId: string;
  message: string;
}

/**
 * The world's version as the bot reported it ("This world is running
 * Minecraft 26.2, which ..."), or null. Only the version is taken from the
 * bot's text: the sentence itself is rebuilt here so it is translated and
 * always carries the supported range.
 */
export function reportedVersion(message: string): string | null {
  const m = message.match(/running Minecraft (.+?), which/);
  return m ? m[1].trim() : null;
}

/** The body sentence: which version the world runs and what Sei supports. */
export function humanBody(message: string, detectedVersion: string | null): string {
  const version = reportedVersion(message) ?? detectedVersion;
  if (version) {
    return tr('This world is running Minecraft {version}, which Sei cannot join yet. Sei works with Minecraft Java {oldest} to {newest}.', {
      ...MC_RANGE_VARS,
      version,
    });
  }
  return tr('This world runs a Minecraft version Sei cannot join yet. Sei works with Minecraft Java {oldest} to {newest}.', MC_RANGE_VARS);
}

export function UnsupportedVersionModal({
  characterId,
  message,
}: UnsupportedVersionModalProps): React.ReactElement {
  const t = useT();
  const closeModal = useUiStore((s) => s.closeModal);
  const rawName = useDataStore((s) => s.characters.find((c) => c.id === characterId)?.name ?? null);
  const name = rawName ?? t('Your companion');
  // The LAN watcher's status ping names the world's version even when the
  // bot's error text is empty (fallback body only).
  const detectedVersion = useDataStore((s) =>
    s.lan.kind === 'open' ? (s.lan.versionName ?? null) : null,
  );
  // Keep the <strong> around the name: translate with the {name} placeholder
  // intact, then split on it and re-insert the styled node.
  const [joinBefore, joinAfter] = t("{name} couldn't join.").split('{name}');
  return (
    <ModalShell
      title={t('Minecraft version not supported')}
      width={440}
      scrimClose
      onClose={closeModal}
      aria-label={t('Minecraft version not supported')}
    >
      <p className={styles.body}>
        {joinBefore}
        <strong>{name}</strong>
        {joinAfter} {humanBody(message, detectedVersion)}{' '}
        {t('To switch to a supported version:')}
      </p>
      <ol className={styles.steps}>
        {STEPS.map((step, i) => (
          <li key={i} className={styles.step}>
            <span className={styles.stepNumber}>{String(i + 1).padStart(2, '0')}</span>
            <span className={styles.stepBody}>{t(step, { version: LATEST_SUPPORTED })}</span>
          </li>
        ))}
      </ol>
      <p className={styles.hint}>
        {t(
          'Alternatively, run the skin setup in Sei settings. It installs our modded Fabric version of Minecraft, which is supported and shows character skins.',
        )}
      </p>
      <p className={styles.hint}>
        {t(
          'Minecraft may not open worlds saved on a newer version. If your world will not open, create a new world on the supported version and play there.',
        )}
      </p>
      <ModalFooter>
        <Button kind="accent" size="md" onClick={closeModal}>
          {t('Got it')}
        </Button>
      </ModalFooter>
    </ModalShell>
  );
}
