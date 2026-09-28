/**
 * LanHostWarningModal — pre-summon compatibility disclaimer (260709,
 * three-way classification 260721).
 *
 * Shown by summonFlow when the detected LAN host warrants a heads-up:
 *   - 'vanilla' → plain vanilla Minecraft, i.e. WITHOUT Sei's Fabric skin
 *                 setup. The companion joins and plays normally but renders
 *                 with a default Minecraft skin (CustomSkinLoader never runs).
 *   - 'forge'   → Forge/NeoForge host (260929). BLOCKING: no "Summon
 *                 anyway". Every Forge-hosted summon in the 09-22..28 data
 *                 was kicked or timed out, costing players 2 to 32 minutes of
 *                 retries, so the modal says Sei can't join and points at the
 *                 Sei profile instead (ForgeHostBlocked below).
 *   - 'modded'  → Quilt, or Fabric with mods besides Sei's skin mod. Sei
 *                 joins as a vanilla player; client-side mods (minimaps etc.)
 *                 are fine, but content mods can make the world refuse the
 *                 join.
 *   - 'lunar'   → Lunar Client detected. Joining works, but Lunar loads no
 *                 third-party mods, so the companion's custom skin can't be
 *                 shown there (CustomSkinLoader never runs).
 *
 * Fabric running ONLY Sei's own skin mod shows no modal at all (see
 * lanHostWarning in src/shared/ipc.ts) — that is our own setup, not "modded
 * Minecraft".
 *
 * The other kinds never block: "Summon anyway" acknowledges the warning for the rest of the
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
import stepStyles from './LanNotOpenModal.module.css';

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

const TITLES: Record<Exclude<LanHostWarning, 'forge'>, string> = {
  vanilla: 'Vanilla Minecraft detected',
  modded: 'Modded Minecraft detected',
  lunar: 'Lunar Client detected',
};

/** 'forge' covers NeoForge too; a ping-only detection reads as Forge. */
function forgeLabel(host: LanHost): string {
  return host.client === 'neoforge' ? 'NeoForge' : 'Forge';
}

// Launcher steps for the Forge block, in the numbered style of LanNotOpenModal.
const FORGE_STEPS: readonly string[] = [
  'Save and quit your world, then open the Minecraft Launcher.',
  'Pick the Sei profile (named "Sei" and a version number) and press Play. No Sei profile yet? Use Set up Sei profile below.',
  'Open a world, choose Open to LAN, then press Launch in Sei again.',
];

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

/**
 * 260929: the blocking Forge/NeoForge variant. Deliberately no summon button:
 * the join cannot work, and offering it is what produced the retry loops. The
 * one-click guide opens the Minecraft setup window on its skin tab, which runs
 * the wizard that builds the "Sei <version>" launcher profile.
 */
function ForgeHostBlocked({ characterId, host }: { characterId: string; host: LanHost }): React.ReactElement {
  const t = useT();
  const closeModal = useUiStore((s) => s.closeModal);
  const openModal = useUiStore((s) => s.openModal);
  const rawName = useDataStore((s) => s.characters.find((c) => c.id === characterId)?.name ?? null);
  const name = rawName ?? t('Your companion');
  const loader = forgeLabel(host);
  const title = t("Sei can't join {loader} worlds", { loader });
  return (
    <ModalShell title={title} width={480} scrimClose onClose={closeModal} aria-label={title}>
      <p className={stepStyles.body}>
        {richText(
          t(
            'Your world is hosted from {loader}. {name} joins as a normal Minecraft player, and {loader} worlds turn those players away, so the summon would fail. To play together, host your world from the Sei profile instead:',
            { loader },
          ),
          { name: <strong>{name}</strong> },
        )}
      </p>
      <ol className={stepStyles.steps}>
        {FORGE_STEPS.map((step, i) => (
          <li key={i} className={stepStyles.step}>
            <span className={stepStyles.stepNumber}>{String(i + 1).padStart(2, '0')}</span>
            <span className={stepStyles.stepBody}>{t(step)}</span>
          </li>
        ))}
      </ol>
      <p className={stepStyles.hint}>
        {t('A world that needs {loader} mods may not open without them. If yours will not, make a new world in the Sei profile.', {
          loader,
        })}
      </p>
      <ModalFooter>
        <Button
          kind="ghost"
          size="md"
          onClick={() => openModal({ kind: 'mc-setup', tab: 'skin', searching: false })}
        >
          {t('Set up Sei profile')}
        </Button>
        <Button kind="accent" size="md" onClick={closeModal}>
          {t('Got it')}
        </Button>
      </ModalFooter>
    </ModalShell>
  );
}

export function LanHostWarningModal(props: LanHostWarningModalProps): React.ReactElement {
  if (props.warning === 'forge') return <ForgeHostBlocked characterId={props.characterId} host={props.host} />;
  return <LanHostWarningPrompt {...props} warning={props.warning} />;
}

function LanHostWarningPrompt({
  characterId,
  warning,
  host,
  fromChat,
}: LanHostWarningModalProps & { warning: Exclude<LanHostWarning, 'forge'> }): React.ReactElement {
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
