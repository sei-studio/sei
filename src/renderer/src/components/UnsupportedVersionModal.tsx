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
 * and the supported range. Dismiss-only; the user resolves it by opening a
 * world on a supported version. Modeled on SummonConflictModal.
 */

import React from 'react';
import { Button } from './Button';
import { ModalShell, ModalFooter } from './ModalShell';
import { useUiStore } from '../lib/stores/useUiStore';
import { useDataStore } from '../lib/stores/useDataStore';
import styles from './UnsupportedVersionModal.module.css';

export interface UnsupportedVersionModalProps {
  characterId: string;
  message: string;
}

/**
 * Strip the machine-readable error-class prefix; keep the human sentence.
 * The bot's message names the world's version AND the supported range (built
 * from minecraft-protocol.supportedVersions in the bot adapter). When it is
 * missing, fall back to the LAN watcher's detected version so the popup still
 * states which version was seen; the supported range is not cleanly available
 * on the renderer side, so the fallback stays honest and names none.
 */
function humanBody(message: string, detectedVersion: string | null): string {
  const stripped = message.replace(/^\s*UNSUPPORTED_MC_VERSION:\s*/, '').trim();
  if (stripped.length > 0) return stripped;
  if (detectedVersion) {
    return `This world is running Minecraft ${detectedVersion}, which is not supported yet. Open a world on a supported version and try again.`;
  }
  return 'This world runs a Minecraft version that is not supported yet. Open a world on a supported version and try again.';
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
        <strong>{name}</strong> couldn&apos;t join. {humanBody(message, detectedVersion)}
      </p>
      <p className={styles.hint}>
        Tip: in the Minecraft launcher you can create an Installation pinned to
        an older version, then open your world from it.
      </p>
      <ModalFooter>
        <Button kind="accent" size="md" onClick={closeModal}>
          Got it
        </Button>
      </ModalFooter>
    </ModalShell>
  );
}
