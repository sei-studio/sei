/**
 * McSteps — the numbered setup list for Minecraft (260909), on the launch
 * panel above Launch, the way DstSteps sits on the Don't Starve panel. It
 * turns the Minecraft one-time setup from a modal offered once into a
 * standing suggestion:
 *
 *   1. Minecraft Java is installed (the same install scan the skin wizard
 *      runs). Not found: a Get Minecraft link + Check again.
 *   2. A Sei-ready Minecraft: Fabric for a version Sei can join, as a
 *      separate "Sei" profile in the launcher, plus the companion-skin mod.
 *      One button runs the existing wizard. The step shows on EVERY open of
 *      the panel until an install is ready (shared/mcSetup.ts) or the player
 *      presses "Do not show again" (UserConfig.mc_setup_dismissed). A ready
 *      install shows as done even after a dismissal.
 *   3. A world open to LAN, with the live detection pill and the in-game
 *      steps. Done while a world is detected.
 *
 * Why a list and not the modal alone: the wizard was offered once at
 * onboarding and once on the first Minecraft open, and a player who clicked
 * past it had no path back except Settings. The list is also where the
 * VERSION requirement lives: before this, a player whose launcher was on a
 * snapshot found out from a summon error, after opening a world.
 */
import React, { useEffect } from 'react';
import { supportedVersions } from 'minecraft-protocol/src/version.js';
import { useT } from '../../lib/i18n';
import { sei } from '../../lib/ipcClient';
import { Button } from '../Button';
import { useDataStore } from '../../lib/stores/useDataStore';
import { useWizardStore } from '../../lib/stores/useWizardStore';
import { useMcSetupStore, selectReadyVersion } from './useMcSetupStore';
import styles from './McLaunchPanel.module.css';

const POLL_MS = 10_000;
const GET_MINECRAFT_URL = 'https://www.minecraft.net/download';

/** Highest Minecraft Java version Sei's networking stack can join. */
const LATEST_SUPPORTED: string = supportedVersions[supportedVersions.length - 1];

const LAN_STEPS: readonly string[] = [
  'Launch Minecraft and open your singleplayer world.',
  'Press ESC, then choose Open to LAN.',
  'Click Start LAN World.',
];

type Tone = 'done' | 'now' | 'later';

function Step({ index, tone, children }: { index: number; tone: Tone; children: React.ReactNode }): React.ReactElement {
  const cls = tone === 'done' ? styles.stepDone : tone === 'now' ? styles.stepNow : styles.stepLater;
  return (
    <li className={`${styles.step} ${cls}`} aria-current={tone === 'now' ? 'step' : undefined}>
      <span className={styles.stepNumber} aria-hidden="true">
        {tone === 'done' ? '✓' : String(index).padStart(2, '0')}
      </span>
      <div className={styles.stepBody}>{children}</div>
    </li>
  );
}

export function McSteps(): React.ReactElement {
  const t = useT();
  const installs = useMcSetupStore((s) => s.installs);
  const dismissed = useMcSetupStore((s) => s.dismissed);
  const scan = useMcSetupStore((s) => s.scan);
  const hydrate = useMcSetupStore((s) => s.hydrate);
  const dismiss = useMcSetupStore((s) => s.dismiss);
  const openWizard = useWizardStore((s) => s.openWizard);
  const wizardOpen = useWizardStore((s) => s.open);
  const lan = useDataStore((s) => s.lan);
  const worldOpen = lan.kind === 'open';

  const readyVersion = selectReadyVersion(installs, supportedVersions);
  const found = installs == null ? null : installs.length > 0;
  const installDone = readyVersion != null;
  // Hidden once dismissed, unless it has since become true (a cheap positive).
  const showInstallStep = installDone || dismissed !== true;

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // Scan on mount, on a slow poll while the setup is not done, and whenever
  // the wizard closes (a finished run flips the step without a click).
  useEffect(() => {
    if (wizardOpen) return;
    void scan();
    if (installDone) return;
    const id = setInterval(() => void scan(), POLL_MS);
    return () => clearInterval(id);
  }, [scan, installDone, wizardOpen]);

  const gameTone: Tone = found === null ? 'now' : found ? 'done' : 'now';
  const installTone: Tone = installDone ? 'done' : found ? 'now' : 'later';
  const worldTone: Tone = worldOpen ? 'done' : found && (installDone || !showInstallStep) ? 'now' : 'later';
  let n = 0;

  return (
    <ol className={styles.steps} aria-label={t('Minecraft setup steps')}>
      <Step index={++n} tone={gameTone}>
        {found === null ? (
          <span>{t('Looking for Minecraft on this computer...')}</span>
        ) : found ? (
          <span>{t('Minecraft Java Edition is installed.')}</span>
        ) : (
          <>
            <span>{t('Install Minecraft Java Edition from minecraft.net, then check again.')}</span>
            <div className={styles.actions}>
              <Button kind="primary" size="sm" onClick={() => void sei.openExternal(GET_MINECRAFT_URL)}>{t('Get Minecraft')}</Button>
              <Button kind="quiet" size="sm" onClick={() => void scan()}>{t('Check again')}</Button>
            </div>
          </>
        )}
      </Step>

      {showInstallStep ? (
        <Step index={++n} tone={installTone}>
          {installDone ? (
            <span>{t('Your Minecraft is Sei-ready: Fabric for {version} with companion skins. Pick the "Sei" profile in the launcher.', { version: readyVersion })}</span>
          ) : (
            <>
              <span>
                {t('Set up a Sei-ready Minecraft: a separate "Sei" profile in your launcher on a version Sei can join (up to {latest}), with Fabric and the companion-skin mod. One time, about a minute. Your own profile is not changed.', { latest: LATEST_SUPPORTED })}
              </span>
              <div className={styles.actions}>
                <Button kind="primary" size="sm" disabled={!found} onClick={() => openWizard(false)}>{t('Set up')}</Button>
                <button type="button" className={styles.dismissLink} onClick={() => void dismiss()}>{t('Do not show again')}</button>
              </div>
            </>
          )}
        </Step>
      ) : null}

      <Step index={++n} tone={worldTone}>
        {worldOpen ? (
          <span>{t('Your world is open to LAN.')}</span>
        ) : (
          <>
            <span>{t('Open a world to LAN:')}</span>
            {LAN_STEPS.map((step) => (
              <span key={step} className={styles.subStep}>{t(step)}</span>
            ))}
            <span className={styles.stepHint}>{t('Your world needs a supported Minecraft Java version. Sei supports versions up to {latest}.', { latest: LATEST_SUPPORTED })}</span>
          </>
        )}
      </Step>
    </ol>
  );
}
