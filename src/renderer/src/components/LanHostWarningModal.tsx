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
 *   - 'modded'  → Quilt, Forge/NeoForge seen only in weak cmdline markers
 *                 (a possible misread, so never a hard stop), or Fabric
 *                 with mods besides Sei's skin mod. Sei
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
import { forgeHostBlock, type LanHost, type LanHostWarning } from '@shared/ipc';
import { sei } from '../lib/ipcClient';
import { useT } from '../lib/i18n';
import { Button } from './Button';
import { ModalShell, ModalFooter } from './ModalShell';
import { useUiStore } from '../lib/stores/useUiStore';
import { useDataStore } from '../lib/stores/useDataStore';
import { acknowledgeHostWarning, launchSummon } from '../lib/summonFlow';
import styles from './LanHostWarningModal.module.css';
import { useSeiProfileAction } from './mcdash/useStartMinecraft';
import { MC_RECOMMENDED } from '../lib/mcVersions';
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


// Launcher steps for the Forge block, in the numbered style of LanNotOpenModal.
// Step 2 follows the footer button: Start Minecraft when a Sei profile
// exists, Set up Sei profile when it does not (260929).
const FORGE_STEP_QUIT = 'Save and quit your world.';
const FORGE_STEP_START = 'Press Start Minecraft below. The launcher opens with the Sei profile selected. Press Play.';
const FORGE_STEP_SETUP = 'Press Set up Sei profile below. Sei adds a "Sei {version}" profile to your launcher in about a minute. Then open the launcher, pick that profile, and press Play.';
const FORGE_STEP_LAN = 'Open or create a world, choose Open to LAN, then press Launch in Sei again.';

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
 * footer button is Start Minecraft (opens the launcher on the Sei profile) or,
 * with no Sei profile yet, Set up Sei profile (opens the wizard that builds
 * the "Sei <version>" launcher profile).
 */
function ForgeHostBlocked({ characterId, host }: { characterId: string; host: LanHost }): React.ReactElement {
  const t = useT();
  const closeModal = useUiStore((s) => s.closeModal);
  const action = useSeiProfileAction({ onBeforeSetup: closeModal });
  const forgeSteps = [FORGE_STEP_QUIT, action.ready ? FORGE_STEP_START : FORGE_STEP_SETUP, FORGE_STEP_LAN];
  const rawName = useDataStore((s) => s.characters.find((c) => c.id === characterId)?.name ?? null);
  const name = rawName ?? t('Your companion');
  // Shared with main's pre-gate and the chat launch() refusal; a ping-only
  // detection reads as Forge.
  const loader = forgeHostBlock(host)?.loader ?? 'Forge';
  const title = t("Sei can't join {loader} worlds", { loader });
  return (
    <ModalShell title={title} width={480} scrimClose onClose={closeModal} aria-label={title}>
      <p className={stepStyles.body}>
        {richText(
          t(
            'Your world is hosted from {loader}. {name} joins as a normal Minecraft player, and {loader} worlds turn those players away, so the summon would fail. To play together, host a world from the Sei profile instead:',
            { loader },
          ),
          { name: <strong>{name}</strong> },
        )}
      </p>
      <ol className={stepStyles.steps}>
        {forgeSteps.map((step, i) => (
          <li key={i} className={stepStyles.step}>
            <span className={stepStyles.stepNumber}>{String(i + 1).padStart(2, '0')}</span>
            <span className={stepStyles.stepBody}>{t(step, { version: MC_RECOMMENDED })}</span>
          </li>
        ))}
      </ol>
      <p className={stepStyles.hint}>
        {t('The Sei profile keeps its own worlds, apart from your other profiles. If its world list is empty, create a new world there.')}
      </p>
      {action.note ? (
        <p className={stepStyles.note} role="status" data-tone={action.note.tone}>
          {action.note.text}
        </p>
      ) : null}
      <ModalFooter>
        <Button kind="quiet" size="md" onClick={closeModal}>
          {t('Got it')}
        </Button>
        <Button kind="accent" size="md" disabled={action.busy || !action.known} onClick={action.onClick}>
          {action.known ? action.label : t('Set up Sei profile')}
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
  const maybeForge = warning === 'modded' && (host.client === 'forge' || host.client === 'neoforge');
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
      ) : maybeForge ? (
        // 260929: Forge/NeoForge seen only in weak cmdline markers (no ping
        // forgeData, no launch target). Could be a misread, so this stays a
        // heads-up with "Summon anyway" instead of the hard stop.
        <>
          <p className={styles.body}>
            {richText(
              t(
                "Your world looks like it may be running {loader}. {name} can't join {loader} worlds, so if it is, the summon will fail.",
                { loader: t(loaderLabel(host)) },
              ),
              strongName,
            )}
          </p>
          <p className={styles.hint}>
            {t('If the join fails, host your world from the Sei profile in the Minecraft Launcher.')}
          </p>
        </>
      ) : (
        <>
          <p className={styles.body}>
            {richText(
              hasMods
                ? t(
                    "Your world is running {loader} with {count} mods. {name} joins as a vanilla player: performance and shader mods are fine, but mods that add new blocks or items, and some map mods like Xaero's, may stop {name} from joining.",
                    { loader: t(loaderLabel(host)), count: modCount as number },
                  )
                : t(
                    "Your world is running {loader}. {name} joins as a vanilla player: performance and shader mods are fine, but mods that add new blocks or items, and some map mods like Xaero's, may stop {name} from joining.",
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
