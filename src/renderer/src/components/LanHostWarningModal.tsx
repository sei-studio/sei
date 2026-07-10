/**
 * LanHostWarningModal — pre-summon compatibility disclaimer (260709).
 *
 * Shown by summonFlow when the detected LAN host client warrants a heads-up:
 *   - 'modded'  → Forge/NeoForge/Fabric detected. Sei joins as a vanilla
 *                 player; client-side mods (minimaps etc.) are fine, but
 *                 content mods can make the world refuse the join.
 *   - 'lunar'   → Lunar Client detected. Joining works, but Lunar loads no
 *                 third-party mods, so the companion's custom skin can't be
 *                 shown there (CustomSkinLoader never runs).
 *
 * Never blocks: "Summon anyway" acknowledges the warning for the rest of the
 * session and resumes the summon; Cancel drops the attempt. Modeled on
 * SummonConflictModal (scrim + centered panel via ModalShell).
 */

import React from 'react';
import type { LanHost, LanHostWarning } from '@shared/ipc';
import { Button } from './Button';
import { ModalShell, ModalFooter } from './ModalShell';
import { useUiStore } from '../lib/stores/useUiStore';
import { useDataStore } from '../lib/stores/useDataStore';
import { acknowledgeHostWarning, launchSummon } from '../lib/summonFlow';
import styles from './LanHostWarningModal.module.css';

export interface LanHostWarningModalProps {
  characterId: string;
  warning: LanHostWarning;
  host: LanHost;
  fromChat: boolean;
}

function loaderLabel(host: LanHost): string {
  switch (host.client) {
    case 'neoforge':
      return 'NeoForge';
    case 'forge':
      return 'Forge';
    case 'fabric':
      return 'Fabric';
    default:
      return 'a mod loader';
  }
}

export function LanHostWarningModal({
  characterId,
  warning,
  host,
  fromChat,
}: LanHostWarningModalProps): React.ReactElement {
  const closeModal = useUiStore((s) => s.closeModal);
  const name = useDataStore(
    (s) => s.characters.find((c) => c.id === characterId)?.name ?? 'Your companion',
  );

  const title = warning === 'lunar' ? 'Lunar Client detected' : 'Modded Minecraft detected';
  const modCount = host.forgeModCount;
  const withMods =
    warning === 'modded' && modCount != null && modCount > 0 ? ` with ${modCount} mods` : '';

  const onSummonAnyway = (): void => {
    acknowledgeHostWarning(warning);
    closeModal();
    launchSummon(characterId, fromChat);
  };

  return (
    <ModalShell title={title} width={440} scrimClose onClose={closeModal} aria-label={title}>
      {warning === 'lunar' ? (
        <>
          <p className={styles.body}>
            Your world is hosted from Lunar Client. <strong>{name}</strong> can join and play
            normally, but Lunar does not load the skin mod, so {name} may appear with a default
            Minecraft skin.
          </p>
          <p className={styles.hint}>
            To see custom skins, host the world from an install set up in skin setup (Settings).
          </p>
        </>
      ) : (
        <>
          <p className={styles.body}>
            Your world is running {loaderLabel(host)}{withMods}. <strong>{name}</strong> joins as a
            vanilla player: client-side mods like minimaps are fine, but mods that add new blocks
            or items may stop {name} from joining.
          </p>
          <p className={styles.hint}>
            If the join fails, try a world without server-side mods.
          </p>
        </>
      )}
      <ModalFooter>
        <Button kind="ghost" size="md" onClick={closeModal}>
          Cancel
        </Button>
        <Button kind="accent" size="md" onClick={onSummonAnyway}>
          Summon anyway
        </Button>
      </ModalFooter>
    </ModalShell>
  );
}
