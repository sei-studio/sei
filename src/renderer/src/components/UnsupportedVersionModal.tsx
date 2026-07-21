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
import { Button } from './Button';
import { ModalShell, ModalFooter } from './ModalShell';
import { useUiStore } from '../lib/stores/useUiStore';
import { useDataStore } from '../lib/stores/useDataStore';
import styles from './UnsupportedVersionModal.module.css';

/** Highest Minecraft Java version Sei's networking stack can join. */
const LATEST_SUPPORTED: string = supportedVersions[supportedVersions.length - 1];

const STEPS: readonly string[] = [
  'Open the Minecraft launcher and go to the Installations tab.',
  `Create or select an installation on ${LATEST_SUPPORTED} or another supported version.`,
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
    return `This world is running Minecraft ${detectedVersion}, which is not supported yet. Sei supports Java versions up to ${LATEST_SUPPORTED}.`;
  }
  return `This world runs a Minecraft version that is not supported yet. Sei supports Java versions up to ${LATEST_SUPPORTED}.`;
}

export function UnsupportedVersionModal({
  characterId,
  message,
}: UnsupportedVersionModalProps): React.ReactElement {
  const closeModal = useUiStore((s) => s.closeModal);
  const name = useDataStore(
    (s) => s.characters.find((c) => c.id === characterId)?.name ?? 'Your companion',
  );
  // The LAN watcher's status ping names the world's version even when the
  // bot's error text is empty (fallback body only).
  const detectedVersion = useDataStore((s) =>
    s.lan.kind === 'open' ? (s.lan.versionName ?? null) : null,
  );
  return (
    <ModalShell
      title="Minecraft version not supported"
      width={440}
      scrimClose
      onClose={closeModal}
      aria-label="Minecraft version not supported"
    >
      <p className={styles.body}>
        <strong>{name}</strong> couldn&apos;t join. {humanBody(message, detectedVersion)} To switch
        to a supported version:
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
        Minecraft may not open worlds saved on a newer version. If your world will not open, create
        a new world on the supported version and play there.
      </p>
      <ModalFooter>
        <Button kind="accent" size="md" onClick={closeModal}>
          Got it
        </Button>
      </ModalFooter>
    </ModalShell>
  );
}
