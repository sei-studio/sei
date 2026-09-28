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
 * minecraft-protocol's table, followed by steps that point at the Sei
 * profile (260929, R1c): the setup wizard's "Sei <version>" launcher profile
 * is on a version Sei joins, with companion skins, so the fix is "open the
 * Sei profile", with one button: Start Minecraft when the profile exists,
 * else Set up Sei profile (opens the wizard). The earlier copy walked the
 * player through building a launcher installation by hand.
 * 260926: the body used to be the bot's raw English sentence, so it was never
 * translated.
 * Modeled on SummonConflictModal.
 */

import React from 'react';
import { t as tr, useT } from '../lib/i18n';
import { MC_RECOMMENDED, mcRangeVars } from '../lib/mcVersions';
import { Button } from './Button';
import { ModalShell, ModalFooter } from './ModalShell';
import { useUiStore } from '../lib/stores/useUiStore';
import { useDataStore } from '../lib/stores/useDataStore';
import styles from './UnsupportedVersionModal.module.css';
import noteStyles from './LanNotOpenModal.module.css';
import { useSeiProfileAction } from './mcdash/useStartMinecraft';

/**
 * The version the Sei profile runs: the one the setup wizard builds
 * (lib/mcVersions MC_RECOMMENDED, capped by WIZARD_MAX_MC), so this copy never
 * names a version the wizard would not build or where skins do not work. The
 * body's {versions} list still names every version Sei can join (incl. newer
 * ones like 26.2 / 26.3).
 */
const RECOMMENDED: string = MC_RECOMMENDED;

// Step 2 depends on whether a Sei profile exists; the others are shared.
const STEP_QUIT = 'Save and quit your world.';
const STEP_START = 'Press Start Minecraft below. The launcher opens with the Sei profile selected. Press Play.';
const STEP_SETUP = 'Press Set up Sei profile below. Sei adds a "Sei {version}" profile to your launcher in about a minute. Then open the launcher, pick that profile, and press Play.';
const STEP_LAN = 'Open or create a world, choose Open to LAN, then press Launch in Sei again.';

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
    return tr('This world is running Minecraft {version}, which Sei cannot join yet. Sei works with Minecraft Java {versions}.', {
      ...mcRangeVars(tr),
      version,
    });
  }
  return tr('This world runs a Minecraft version Sei cannot join yet. Sei works with Minecraft Java {versions}.', mcRangeVars(tr));
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
  const action = useSeiProfileAction({ onBeforeSetup: closeModal });
  const steps = [STEP_QUIT, action.ready ? STEP_START : STEP_SETUP, STEP_LAN];
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
        {t('Play from the Sei profile instead. It runs {version}, with companion skins:', { version: RECOMMENDED })}
      </p>
      <ol className={styles.steps}>
        {steps.map((step, i) => (
          <li key={i} className={styles.step}>
            <span className={styles.stepNumber}>{String(i + 1).padStart(2, '0')}</span>
            <span className={styles.stepBody}>{t(step, { version: RECOMMENDED })}</span>
          </li>
        ))}
      </ol>
      <p className={styles.hint}>
        {t(
          'The Sei profile keeps its own worlds, apart from your other profiles. If its world list is empty, create a new world there.',
        )}
      </p>
      {action.note ? (
        <p className={noteStyles.note} role="status" data-tone={action.note.tone}>
          {action.note.text}
        </p>
      ) : null}
      <ModalFooter>
        <Button kind="quiet" size="md" onClick={closeModal}>
          {t('Close')}
        </Button>
        {action.known ? (
          <Button kind="accent" size="md" disabled={action.busy} onClick={action.onClick}>
            {action.label}
          </Button>
        ) : null}
      </ModalFooter>
    </ModalShell>
  );
}
