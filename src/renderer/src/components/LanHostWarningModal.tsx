/**
 * LanHostWarningModal — pre-summon compatibility disclaimer (260709,
 * three-way classification 260721).
 *
 * Shown by summonFlow when the detected LAN host warrants a heads-up:
 *   - 'vanilla' → plain vanilla Minecraft, i.e. WITHOUT Sei's Fabric skin
 *                 setup. The companion joins and plays normally but renders
 *                 with a default Minecraft skin (CustomSkinLoader never runs).
 *   - 'modded'  → Forge/NeoForge/Quilt, or Fabric with mods besides Sei's
 *                 skin mod. Sei joins as a vanilla player; client-side mods
 *                 (minimaps etc.) are fine, but content mods can make the
 *                 world refuse the join.
 *   - 'lunar'   → Lunar Client detected. Joining works, but Lunar loads no
 *                 third-party mods, so the companion's custom skin can't be
 *                 shown there (CustomSkinLoader never runs).
 *
 * Fabric running ONLY Sei's own skin mod shows no modal at all (see
 * lanHostWarning in src/shared/ipc.ts) — that is our own setup, not "modded
 * Minecraft".
 *
 * Never blocks: "Summon anyway" acknowledges the warning for the rest of the
 * session and resumes the summon; Cancel drops the attempt. The vanilla and
 * modded variants also carry a "Don't show this again" checkbox persisted to
 * config (hide_vanilla_host_warning / hide_modded_host_warning) when ticked
 * and confirmed. Modeled on SummonConflictModal (scrim + centered panel via
 * ModalShell).
 */

import React from 'react';
import type { LanHost, LanHostWarning } from '@shared/ipc';
import { sei } from '../lib/ipcClient';
import { useT } from '../lib/i18n';
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
    case 'quilt':
      return 'Quilt';
    case 'fabric':
      return 'Fabric';
    default:
      return 'a mod loader';
  }
}

const TITLES: Record<LanHostWarning, string> = {
  vanilla: 'Vanilla Minecraft detected',
  modded: 'Modded Minecraft detected',
  lunar: 'Lunar Client detected',
};

/** Substitute {token} placeholders in a translated string with React nodes,
 * so styled spans (the bold companion name) survive translation without
 * concatenating sentence fragments. */
function richText(text: string, nodes: Record<string, React.ReactNode>): React.ReactNode[] {
  return text.split(/(\{\w+\})/g).map((part, i) => {
    const m = /^\{(\w+)\}$/.exec(part);
    return m && m[1] in nodes ? (
      <React.Fragment key={i}>{nodes[m[1]]}</React.Fragment>
    ) : (
      part
    );
  });
}

export function LanHostWarningModal({
  characterId,
  warning,
  host,
  fromChat,
}: LanHostWarningModalProps): React.ReactElement {
  const t = useT();
  const closeModal = useUiStore((s) => s.closeModal);
  const rawName = useDataStore((s) => s.characters.find((c) => c.id === characterId)?.name ?? null);
  const name = rawName ?? t('Your companion');
  const [dontShowAgain, setDontShowAgain] = React.useState(false);

  const title = t(TITLES[warning]);
  const modCount = host.forgeModCount;
  const hasMods = warning === 'modded' && modCount != null && modCount > 0;
  // Only the vanilla and modded warnings persist; lunar stays session-scoped.
  const showDontShowAgain = warning === 'vanilla' || warning === 'modded';
  const strongName = { name: <strong>{name}</strong> };

  const onSummonAnyway = (): void => {
    acknowledgeHostWarning(warning);
    if (showDontShowAgain && dontShowAgain) {
      // Best-effort persistence — never let a config hiccup block the summon.
      void sei
        .getConfig()
        .then((cfg) =>
          sei.saveConfig(
            warning === 'vanilla'
              ? { ...cfg, hide_vanilla_host_warning: true }
              : { ...cfg, hide_modded_host_warning: true },
          ),
        )
        .catch(() => {});
    }
    closeModal();
    launchSummon(characterId, fromChat);
  };

  return (
    <ModalShell title={title} width={440} scrimClose onClose={closeModal} aria-label={title}>
      {warning === 'lunar' ? (
        <>
          <p className={styles.body}>
            {richText(
              t(
                'Your world is hosted from Lunar Client. {name} can join and play normally, but Lunar does not load the skin mod, so {name} may appear with a default Minecraft skin.',
              ),
              strongName,
            )}
          </p>
          <p className={styles.hint}>
            {t(
              'To see custom skins, host the world from an install set up in skin setup (Settings).',
            )}
          </p>
        </>
      ) : warning === 'vanilla' ? (
        <>
          <p className={styles.body}>
            {richText(
              t(
                "Your world is running vanilla Minecraft without Sei's skin mod. {name} can join and play normally, but will appear with a default Minecraft skin.",
              ),
              strongName,
            )}
          </p>
          <p className={styles.hint}>
            {t(
              'To see custom skins, run skin setup (Settings) and host the world from the Sei profile.',
            )}
          </p>
        </>
      ) : (
        <>
          <p className={styles.body}>
            {richText(
              hasMods
                ? t(
                    'Your world is running {loader} with {count} mods. {name} joins as a vanilla player: client-side mods like minimaps are fine, but mods that add new blocks or items may stop {name} from joining.',
                    { loader: t(loaderLabel(host)), count: modCount as number },
                  )
                : t(
                    'Your world is running {loader}. {name} joins as a vanilla player: client-side mods like minimaps are fine, but mods that add new blocks or items may stop {name} from joining.',
                    { loader: t(loaderLabel(host)) },
                  ),
              strongName,
            )}
          </p>
          <p className={styles.hint}>
            {t('If the join fails, try a world without server-side mods.')}
          </p>
        </>
      )}
      {showDontShowAgain ? (
        <label className={styles.checkbox}>
          <input
            type="checkbox"
            checked={dontShowAgain}
            onChange={(e) => setDontShowAgain(e.target.checked)}
          />
          <span>{t("Don't show this again")}</span>
        </label>
      ) : null}
      <ModalFooter>
        <Button kind="ghost" size="md" onClick={closeModal}>
          {t('Cancel')}
        </Button>
        <Button kind="accent" size="md" onClick={onSummonAnyway}>
          {t('Summon anyway')}
        </Button>
      </ModalFooter>
    </ModalShell>
  );
}
