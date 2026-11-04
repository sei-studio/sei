/**
 * useStardewSetupSteps — the Stardew Valley setup steps as DATA (260909),
 * for the one-step-at-a-time window on the launch panel (SetupStepper).
 * The three states the panel used to draw as one big card (plan section
 * 4.2: set up / waiting / launch) are the three steps:
 *
 *   1. Stardew Valley is installed (the ported SMAPI game scan). Not found:
 *      the folders looked in + Check again.
 *   2. SMAPI + Sei's helper are in the game: the one-time install, with
 *      the running install's stage + percent and the failure copy.
 *   3. The farm is open: "Launch Stardew Valley (with Sei)" (or "load your
 *      farm" when the game sits on its title screen), the Windows-only
 *      Steam achievements note, and the waiting line.
 *
 * `complete` is the one-time part (1 + 2 = `install.ready`): it flips the
 * panel's button from "Set up" to "Launch" and reveals the help link. Step
 * 3 is per session; the summon flow's own setup modal covers a Launch
 * pressed with no farm open.
 */
import React, { useEffect, useRef, useState } from 'react';
import { STARDEW_MIN_GAME_VERSION, steamLaunchOption } from '@shared/stardewIpc';
import { sei } from '../../lib/ipcClient';
import { trackSetupStep } from '../../lib/setupTelemetry';
import { useT } from '../../lib/i18n';
import { useDataStore } from '../../lib/stores/useDataStore';
import { useStardewStore } from '../../lib/stores/useStardewStore';
import { PercentBar } from '../PercentBar';
import { SearchingLine, type SetupStep, type StepSkin } from '../games/SetupStepper';
import { progressLine, installErrorCopy, achievementsNoteSeen, markAchievementsNoteSeen } from './stardewCopy';
import { ERROR_COPY } from '../../lib/errors';

export interface StardewSetup {
  steps: SetupStep[];
  complete: boolean;
  allDone: boolean;
  known: boolean;
}

/** How often the farm step asks whether the game runs (261104). */
const GAME_PROBE_MS = 5000;
/** The game must run this long with the helper silent before the hint shows. */
const MOD_SILENT_AFTER_MS = 15_000;

/**
 * 261104: the game runs but the helper never answers (started from Steam or
 * the Xbox app without SMAPI, or the mod failed to load). Polls
 * stardew:game-running while `active` (set up, no farm, no title screen
 * hello) and turns true once the game has been up MOD_SILENT_AFTER_MS.
 */
function useModSilent(active: boolean): boolean {
  const [silent, setSilent] = useState(false);
  const since = useRef<number | null>(null);
  const reported = useRef(false);
  useEffect(() => {
    if (!active || typeof sei.stardewGameRunning !== 'function') {
      since.current = null;
      setSilent(false);
      return;
    }
    let alive = true;
    const probe = async (): Promise<void> => {
      try {
        const r = await sei.stardewGameRunning!();
        if (!alive) return;
        if (r.running !== true) {
          since.current = null;
          setSilent(false);
          return;
        }
        since.current ??= Date.now();
        if (Date.now() - since.current >= MOD_SILENT_AFTER_MS) {
          setSilent(true);
          if (!reported.current) {
            reported.current = true;
            trackSetupStep({
              game: 'stardew',
              step: 'mod_silent',
              outcome: 'fail',
              error_code: r.smapi ? 'STARDEW_MOD_SILENT' : 'STARDEW_STARTED_WITHOUT_SMAPI',
            });
          }
        }
      } catch {
        /* probe unavailable: no hint */
      }
    };
    void probe();
    const timer = setInterval(() => void probe(), GAME_PROBE_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [active]);
  return silent;
}

export function useStardewSetupSteps(skin: StepSkin): StardewSetup {
  const t = useT();
  const world = useDataStore((s) => s.worlds.stardew);
  const install = useStardewStore((s) => s.state);
  const progress = useStardewStore((s) => s.progress);
  const installing = useStardewStore((s) => s.installing);
  const installError = useStardewStore((s) => s.installError);
  const launching = useStardewStore((s) => s.launching);
  const lastLaunch = useStardewStore((s) => s.lastLaunch);
  const refresh = useStardewStore((s) => s.refresh);
  const runInstall = useStardewStore((s) => s.install);
  const launchGame = useStardewStore((s) => s.launchGame);
  const init = useStardewStore((s) => s.init);
  const chooseFolder = useStardewStore((s) => s.chooseFolder);
  const choosingFolder = useStardewStore((s) => s.choosingFolder);
  const folderError = useStardewStore((s) => s.folderError);
  const [noteSeen, setNoteSeen] = useState(achievementsNoteSeen);
  const [copied, setCopied] = useState(false);
  const { Button } = skin;

  useEffect(() => {
    const off = init();
    void refresh();
    return off;
  }, [init, refresh]);

  // worlds.stardew is typed as the cross-game union; narrow to the farm shape.
  const farm = world && world.game === 'stardew' && world.kind === 'open' ? world : null;
  const open = farm !== null;
  const noSave = world?.kind === 'game_running_no_save';
  const found = install == null ? null : install.gamePath != null;
  // A warning, never a gate: the dll version read is unverified on real
  // installs (261104), and a misread must not lock out an up-to-date game.
  const tooOld = install?.versionOk === false;
  const ready = install?.ready === true;
  const modSilent = useModSilent(ready && !open && !noSave);

  const copyLaunchOption = async (): Promise<void> => {
    if (!install?.gamePath) return;
    try {
      await navigator.clipboard.writeText(steamLaunchOption(install.gamePath));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard unavailable: the text is selectable */
    }
  };

  const dismissNote = (): void => {
    markAchievementsNoteSeen();
    setNoteSeen(true);
  };

  let gameBody: React.ReactNode;
  if (install == null) {
    gameBody = <span aria-live="polite">{t('Checking your Stardew Valley install...')}</span>;
  } else if (!install.gamePath) {
    gameBody = (
      <>
        <span>{t('Install Stardew Valley (Steam or GOG) on this computer, then check again. We looked in:')}</span>
        {install.candidates.slice(0, 4).map((p) => (
          <span key={p} className={skin.mono}>{p}</span>
        ))}
        <span className={skin.sub}>{t('Installed somewhere else? Choose the game folder.')}</span>
        {folderError ? (
          <span role="alert">
            {folderError === 'legacy'
              ? t('This Stardew Valley is too old for Sei. Update the game to {min} or newer, then check again.', { min: STARDEW_MIN_GAME_VERSION })
              : t("That folder doesn't have Stardew Valley in it. Pick the folder with Stardew Valley.dll in it.")}
          </span>
        ) : null}
        <div className={skin.actions}>
          <Button kind="primary" onClick={() => void refresh()}>{t('Check again')}</Button>
          {typeof sei.stardewChooseFolder === 'function' ? (
            <Button kind="quiet" disabled={choosingFolder} onClick={() => void chooseFolder()}>{t('Choose folder')}</Button>
          ) : null}
        </div>
      </>
    );
  } else if (tooOld) {
    gameBody = (
      <>
        <span role="alert">
          {t('This Stardew Valley is too old for Sei. Update the game to {min} or newer, then check again.', { min: STARDEW_MIN_GAME_VERSION })}
        </span>
        <span className={skin.mono}>{install.gamePath}{install.gameVersion ? ` (${install.gameVersion})` : ''}</span>
        <div className={skin.actions}>
          <Button kind="primary" onClick={() => void refresh()}>{t('Check again')}</Button>
        </div>
      </>
    );
  } else {
    gameBody = (
      <>
        <span>{t('Stardew Valley is installed.')}</span>
        <span className={skin.mono}>{install.gamePath}</span>
      </>
    );
  }

  let helperBody: React.ReactNode;
  if (ready) {
    helperBody = <span>{t("SMAPI and Sei's helper are in the game.")}</span>;
  } else {
    const line = progressLine(progress);
    const err = installErrorCopy(installError);
    helperBody = (
      <>
        <span>
          {install?.smapiInstalled
            ? t("SMAPI is installed. Sei's helper mod still needs to be added to your game, a few seconds of setup.")
            : t("This installs SMAPI, the mod loader Stardew Valley uses (about 42 MB, from its official release), and adds Sei's helper mod to your game. One-time setup; the game must be closed.")}
        </span>
        {installing ? (
          <>
            <span aria-live="polite">{t(line.key, { pct: line.pct ?? 0 })}</span>
            <PercentBar value={line.pct ?? 0} size="md" hideLabel label={t('Setup progress, {pct} percent', { pct: line.pct ?? 0 })} />
          </>
        ) : null}
        {err && !installing ? (
          <>
            <span role="alert">{t(err.copy)}</span>
            {err.detail ? <span className={skin.mono}>{err.detail}</span> : null}
          </>
        ) : install?.smapiRemoved && !installing ? (
          <span role="alert">{t(ERROR_COPY.SMAPI_ANTIVIRUS_SUSPECTED)}</span>
        ) : null}
        <div className={skin.actions}>
          <Button kind="primary" disabled={installing || !found} onClick={() => void runInstall()}>
            {installing ? t('Setting up...') : install?.smapiInstalled ? t("Add Sei's helper") : t("Install SMAPI + Sei's helper")}
          </Button>
          <Button kind="quiet" disabled={installing} onClick={() => void refresh()}>{t('Check again')}</Button>
        </div>
      </>
    );
  }

  let farmBody: React.ReactNode;
  if (open) {
    farmBody = <span>{t('Your farm is open: {farm}.', { farm: farm.label })}</span>;
  } else if (noSave) {
    farmBody = (
      <>
        <span>{t('Stardew Valley is running. Load the farm you want to play on; your companion joins as soon as it is open.')}</span>
        <SearchingLine label={t('Waiting for your farm...')} className={skin.sub} />
      </>
    );
  } else {
    farmBody = (
      <>
        <span>{t('Start Stardew Valley with Sei, load your farm, and press Launch. Sei keeps looking for your farm while you do.')}</span>
        <div className={skin.actions}>
          <Button kind="primary" disabled={launching || !ready} onClick={() => void launchGame()}>
            {launching ? t('Starting...') : t('Launch Stardew Valley (with Sei)')}
          </Button>
        </div>
        {lastLaunch && !lastLaunch.launched && lastLaunch.message ? (
          <span className={skin.sub}>{lastLaunch.message.replace(/^[A-Z_]+:\s*/, '')}</span>
        ) : null}
        {install?.platform === 'win32' && install.gamePath && !noteSeen ? (
          <>
            <span className={skin.sub}>
              {t('Started this way, Steam achievements do not unlock. To keep them, add this launch option to Stardew Valley in Steam (Properties, Launch Options):')}
            </span>
            <span className={skin.mono}>{steamLaunchOption(install.gamePath)}</span>
            <div className={skin.actions}>
              <Button kind="quiet" onClick={() => void copyLaunchOption()}>{copied ? t('Copied') : t('Copy')}</Button>
              <Button kind="quiet" onClick={dismissNote}>{t('Got it')}</Button>
            </div>
          </>
        ) : null}
        {modSilent ? (
          <span role="status">
            {t("Stardew Valley is running, but Sei's helper isn't answering. The game has to start through SMAPI: close it, then press Launch Stardew Valley (with Sei).")}
          </span>
        ) : ready ? (
          <SearchingLine label={t('Waiting for your farm...')} className={skin.sub} />
        ) : null}
      </>
    );
  }

  const steps: SetupStep[] = [
    { id: 'game', title: 'Stardew Valley', done: found === true, body: gameBody },
    { id: 'helper', title: t("SMAPI and Sei's helper"), done: ready, body: helperBody },
    { id: 'farm', title: t('Your farm'), done: open, body: farmBody },
  ];

  return {
    steps,
    complete: ready,
    allDone: steps.every((s) => s.done),
    known: install != null,
  };
}
