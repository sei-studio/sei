/**
 * UnsupportedVersionModal — the world runs a Minecraft version Sei can't join
 * (outside minecraft-protocol's supported set, e.g. a brand-new snapshot).
 *
 * Opened centrally by the onStatus subscription in useDataStore.wireIpc when a
 * summon dies with error class UNSUPPORTED_MC_VERSION. Before this popup, the
 * error only reached the character page's model row, so a summon started from
 * the Play flow appeared to do nothing (260709 report).
 *
 * The body renders the bot's already-humanized error text (with the
 * `UNSUPPORTED_MC_VERSION:` prefix stripped), which names the world's version
 * and the supported range, followed by numbered launcher steps (mirroring
 * LanNotOpenModal) for switching the world to a supported version.
 * Dismiss-only; the user resolves it by opening a world on a supported
 * version. Modeled on SummonConflictModal.
 */

import React from 'react';
// Dependency-free CJS data module — the same table the bot's networking stack
// (minecraft-protocol) enforces, so the stated ceiling can never drift from
// what Sei actually joins. Deep import on purpose: the package root pulls the
// full protocol stack, which must never enter the renderer.
import { supportedVersions } from 'minecraft-protocol/src/version.js';
import { t as tr, useT } from '../lib/i18n';
import { Button } from './Button';
import { ModalShell, ModalFooter } from './ModalShell';
import { useUiStore } from '../lib/stores/useUiStore';
import { useDataStore } from '../lib/stores/useDataStore';
import styles from './UnsupportedVersionModal.module.css';

/** Highest Minecraft Java version Sei's networking stack can join. */
const LATEST_SUPPORTED: string = supportedVersions[supportedVersions.length - 1];

// Rendered through t(step, { version }) — the {version} placeholder is filled
// at display time so the step copy stays a stable dictionary key.
const STEPS: readonly string[] = [
  'Open the Minecraft launcher and go to the Installations tab.',
  'Create or select an installation on {version} or another supported version.',
  'Open your world from that installation.',
  'Return to Sei and try the summon again.',
];

export interface UnsupportedVersionModalProps {
  characterId: string;
  message: string;
}

/**
 * Strip the machine-readable error-class prefix; keep the human sentence.
 * The bot's message names the world's version AND the supported range (built
 * from minecraft-protocol.supportedVersions in the bot adapter). When it is
 * missing, fall back to the LAN watcher's detected version so the popup still
 * states which version was seen, plus the ceiling from the same version table.
 */
function humanBody(message: string, detectedVersion: string | null): string {
  const stripped = message
    .replace(/^\s*UNSUPPORTED_MC_VERSION:\s*/, '')
    // The bot's message ends with its own one-line instruction (connect.js);
    // the numbered steps below replace it, so drop it when present.
    .replace(/Switch your world to a supported version and click Summon again\.\s*$/, '')
    .trim();
  if (stripped.length > 0) return stripped;
  if (detectedVersion) {
    return tr(
      'This world is running Minecraft {version}, which is not supported yet. Sei supports Java versions up to {latest}.',
      { version: detectedVersion, latest: LATEST_SUPPORTED },
    );
  }
  return tr(
    'This world runs a Minecraft version that is not supported yet. Sei supports Java versions up to {latest}.',
    { latest: LATEST_SUPPORTED },
  );
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
