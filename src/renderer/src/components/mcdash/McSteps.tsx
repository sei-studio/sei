/**
 * useMcSetupSteps — the Minecraft setup steps as DATA (260909), for the
 * one-step-at-a-time window on the launch panel (SetupStepper). It used to
 * be a numbered list (McSteps) drawn on the panel itself, which put three
 * steps of copy and buttons between the title and Launch; the window shows
 * one step, and the panel's big button reads "Set up" until the one-time
 * part is done.
 *
 *   1. Minecraft Java is installed (the same install scan the skin wizard
 *      runs). Not found: a Get Minecraft link + Check again.
 *   2. A Sei-ready Minecraft: Fabric for a version Sei can join, as a
 *      separate "Sei" profile in the launcher, plus the companion-skin mod.
 *      One button runs the existing wizard. The step is offered until an
 *      install is ready (shared/mcSetup.ts) or the player presses "Do not
 *      show again" (UserConfig.mc_setup_dismissed); a ready install shows
 *      as done even after a dismissal.
 *   3. A world open to LAN, with the in-game steps and the waiting line.
 *
 * `complete` is the ONE-TIME part (1 and 2, or 2 dismissed): it is what
 * flips the panel's button from "Set up" to "Launch" and reveals the
 * "How do I set up launch?" link. Step 3 is per session, and the summon
 * flow's own setup modal covers a Launch pressed with no world open.
 *
 * Why a standing step and not the modal alone: the wizard was offered once
 * at onboarding and once on the first Minecraft open, and a player who
 * clicked past it had no path back except Settings. The step is also where
 * the VERSION requirement lives: before this, a player whose launcher was
 * on a snapshot found out from a summon error, after opening a world.
 */
import React, { useEffect } from 'react';
import { supportedVersions } from 'minecraft-protocol/src/version.js';
import { useT } from '../../lib/i18n';
import { sei } from '../../lib/ipcClient';
import { useDataStore } from '../../lib/stores/useDataStore';
import { useWizardStore } from '../../lib/stores/useWizardStore';
import { SearchingLine, type SetupStep, type StepSkin } from '../games/SetupStepper';
import { useMcSetupStore, selectReadyVersion } from './useMcSetupStore';

const POLL_MS = 10_000;
const GET_MINECRAFT_URL = 'https://www.minecraft.net/download';

/** Highest Minecraft Java version Sei's networking stack can join. */
const LATEST_SUPPORTED: string = supportedVersions[supportedVersions.length - 1];

const LAN_STEPS: readonly string[] = [
  'Launch Minecraft and open your singleplayer world.',
  'Press ESC, then choose Open to LAN.',
  'Click Start LAN World.',
];

export interface McSetup {
  steps: SetupStep[];
  /** The one-time part is done (or dismissed): the panel may offer Launch. */
  complete: boolean;
  /** Every step, the open world included. */
  allDone: boolean;
  /** The first scan has answered; before that the panel shows a disabled Launch. */
  known: boolean;
}

export function useMcSetupSteps(skin: StepSkin): McSetup {
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
  const { Button } = skin;

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

  const steps: SetupStep[] = [
    {
      id: 'game',
      title: t('Minecraft Java Edition'),
      done: found === true,
      body:
        found === null ? (
          <span>{t('Looking for Minecraft on this computer...')}</span>
        ) : found ? (
          <span>{t('Minecraft Java Edition is installed.')}</span>
        ) : (
          <>
            <span>{t('Install Minecraft Java Edition from minecraft.net, then check again.')}</span>
            <div className={skin.actions}>
              <Button kind="primary" onClick={() => void sei.openExternal(GET_MINECRAFT_URL)}>{t('Get Minecraft')}</Button>
              <Button kind="quiet" onClick={() => void scan()}>{t('Check again')}</Button>
            </div>
          </>
        ),
    },
  ];

  if (showInstallStep) {
    steps.push({
      id: 'install',
      title: t('A Sei-ready Minecraft'),
      done: installDone,
      body: installDone ? (
        <span>{t('Your Minecraft is Sei-ready: Fabric for {version} with companion skins. Pick the "Sei" profile in the launcher.', { version: readyVersion })}</span>
      ) : (
        <>
          <span>
            {t('Set up a Sei-ready Minecraft: a separate "Sei" profile in your launcher on a version Sei can join (up to {latest}), with Fabric and the companion-skin mod. One time, about a minute. Your own profile is not changed.', { latest: LATEST_SUPPORTED })}
          </span>
          <div className={skin.actions}>
            <Button kind="primary" disabled={!found} onClick={() => openWizard(false)}>{t('Set up')}</Button>
            <button type="button" className={skin.link} onClick={() => void dismiss()}>{t('Do not show again')}</button>
          </div>
        </>
      ),
    });
  }

  steps.push({
    id: 'world',
    title: t('A world open to LAN'),
    done: worldOpen,
    body: worldOpen ? (
      <span>{t('Your world is open to LAN.')}</span>
    ) : (
      <>
        <span>{t('Open a world to LAN:')}</span>
        {LAN_STEPS.map((step) => (
          <span key={step} className={skin.sub}>{t(step)}</span>
        ))}
        <span className={skin.sub}>{t('Your world needs a supported Minecraft Java version. Sei supports versions up to {latest}.', { latest: LATEST_SUPPORTED })}</span>
        {found ? <SearchingLine label={t('Waiting for your world...')} className={skin.sub} /> : null}
      </>
    ),
  });

  return {
    steps,
    complete: found === true && (installDone || dismissed === true),
    allDone: steps.every((s) => s.done),
    known: installs != null,
  };
}
