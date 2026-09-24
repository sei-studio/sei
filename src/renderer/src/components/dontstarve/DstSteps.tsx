/**
 * useDstSetupSteps — the Don't Starve Together setup steps as DATA (260909),
 * shared by the launch panel's one-step window (SetupStepper, in the
 * game's register) and the setup modal a pending summon opens (DstSteps,
 * the token-styled numbered list below). One hook so the two surfaces can
 * never disagree about what is missing.
 *
 * Every step the player has to take themselves is written down, in order,
 * and each one carries the ONE button that does it. Steps that Sei does on
 * its own (finding the game, copying the helper) show as done the moment
 * they are. The list is what replaced a settings-page port row and a mod
 * option that had to agree (260909): discovery now probes a fixed port
 * list, so the only things left for the player are the three the game
 * itself insists on: the helper has to be in the game before it starts,
 * the game has to be open, and a world has to be hosted.
 *
 * While the world is not open it polls install detection every few seconds
 * so a game quit, relaunch or a Steam verify moves the list without a click.
 */
import React, { useEffect } from 'react';
import { DST_DISCOVERY_PORTS } from '@shared/dstIpc';
import { useT } from '../../lib/i18n';
import { Button } from '../Button';
import { useDataStore } from '../../lib/stores/useDataStore';
import { SearchingLine, type SetupStep, type StepButtonProps, type StepSkin } from '../games/SetupStepper';
import { useDstStore } from './useDstStore';
import styles from './dst.module.css';

const POLL_MS = 3000;
export const DST_GAME_NAME = "Don't Starve Together";

export interface DstSetup {
  steps: SetupStep[];
  /** The helper is in the game (the one-time part): the panel may offer Launch. */
  complete: boolean;
  allDone: boolean;
  known: boolean;
}

export function useDstSetupSteps(skin: StepSkin): DstSetup {
  const t = useT();
  const install = useDstStore((s) => s.install);
  const installBusy = useDstStore((s) => s.installBusy);
  const launching = useDstStore((s) => s.launching);
  const refreshInstall = useDstStore((s) => s.refreshInstall);
  const runInstall = useDstStore((s) => s.runInstall);
  const launchGame = useDstStore((s) => s.launchGame);
  const world = useDataStore((s) => s.worlds.dontstarve);
  const dstWorld = world && world.game === 'dontstarve' ? world : null;
  const worldOpen = dstWorld?.kind === 'open';
  const { Button } = skin;

  useEffect(() => {
    void refreshInstall();
    if (worldOpen) return;
    const id = setInterval(() => void refreshInstall(), POLL_MS);
    return () => clearInterval(id);
  }, [refreshInstall, worldOpen]);

  const found = install?.kind === 'found' ? install : null;
  const helperReady = found != null && found.modInstalled && found.enabled;
  // A live heartbeat proves every earlier step whatever detection last said.
  const gameRunning = worldOpen || (found?.gameRunning ?? false);
  const needsRestart = !worldOpen && (found?.needsRestart ?? false);
  // "Ready" for step 4 means the helper is in AND the game has loaded it: a
  // game that is running without the helper is not one a world can be hosted
  // in yet, so the waiting indicator must not spin under an unfinished step 2.
  const gameReady = helperReady && gameRunning && !needsRestart;
  const gameFound = install != null && install.kind !== 'not_found';

  const steps: SetupStep[] = [
    {
      id: 'game',
      title: DST_GAME_NAME,
      done: gameFound,
      body:
        install == null ? (
          <span>{t("Looking for Don't Starve Together on this computer...")}</span>
        ) : install.kind === 'not_found' ? (
          <>
            <span>{t("Install Don't Starve Together through Steam, then check again. We looked in:")}</span>
            {install.searched.slice(0, 3).map((p) => (
              <span key={p} className={skin.mono}>{p}</span>
            ))}
            <div className={skin.actions}>
              <Button kind="primary" onClick={() => void refreshInstall()}>{t('Check again')}</Button>
            </div>
          </>
        ) : (
          <span>{t("Don't Starve Together is installed.")}</span>
        ),
    },
    {
      id: 'helper',
      title: t("Sei's helper"),
      done: helperReady,
      body:
        install?.kind === 'installing' ? (
          <span aria-live="polite">{install.step === 'enabling' ? t('Enabling the helper in the game') : t('Copying the helper into the game folder')}</span>
        ) : install?.kind === 'error' && install.permission ? (
          <>
            <span role="alert">
              {t("macOS blocked Sei from adding the helper to the game (it needs App Management permission).")}
            </span>
            <div className={skin.actions}>
              <Button kind="primary" disabled={installBusy} onClick={() => void runInstall()}>{t('Try again')}</Button>
            </div>
          </>
        ) : install?.kind === 'error' ? (
          <>
            <span role="alert">{t("Couldn't add Sei's helper.")}</span>
            <span className={skin.mono}>{install.message}</span>
            <div className={skin.actions}>
              <Button kind="primary" disabled={installBusy} onClick={() => void runInstall()}>{t('Try again')}</Button>
            </div>
          </>
        ) : helperReady ? (
          <span>{t("Sei's helper is in the game (v{version}).", { version: found?.modVersion ?? '?' })}</span>
        ) : (
          <>
            <span>
              {t("Add Sei's helper. It is a small server-side mod that lets your companion join the worlds you host. Friends who join need nothing.")}
            </span>
            <div className={skin.actions}>
              <Button kind="primary" disabled={installBusy || found == null} onClick={() => void runInstall()}>
                {t("Add Sei's helper")}
              </Button>
            </div>
          </>
        ),
    },
    {
      id: 'run',
      title: t('The game'),
      done: gameReady,
      body: gameReady ? (
        <span>{t("Don't Starve Together is running.")}</span>
      ) : gameRunning && !helperReady ? (
        // Running without the helper: nothing to press here yet, and once
        // the helper lands this becomes the restart step.
        <span>{t("Don't Starve Together is running. It will need a restart once the helper is added.")}</span>
      ) : needsRestart ? (
        <>
          <span>{t("Quit Don't Starve Together and open it again. The helper loads when the game starts.")}</span>
          <span className={skin.sub}>{t('The game shows a "Mods Installed" notice at start. Press "I understand."')}</span>
          <SearchingLine label={t('Waiting for the game to close...')} className={skin.sub} />
        </>
      ) : (
        <>
          <span>{t("Open Don't Starve Together.")}</span>
          <span className={skin.sub}>{t('The game shows a "Mods Installed" notice at start. Press "I understand."')}</span>
          <div className={skin.actions}>
            <Button kind="primary" disabled={launching || !helperReady} onClick={() => void launchGame()}>
              {launching ? t('Opening Steam...') : t("Launch Don't Starve Together")}
            </Button>
          </div>
        </>
      ),
    },
    {
      id: 'host',
      title: t('A hosted world'),
      done: worldOpen,
      body: worldOpen ? (
        <span>
          {t('Your world is open: {world}, day {day}.', { world: dstWorld.worldName || t('Your world'), day: dstWorld.day })}
        </span>
      ) : dstWorld?.kind === 'unavailable' ? (
        <span role="alert">
          {t("Sei couldn't open a local port for Don't Starve Together (ports {first} to {last} are all in use). Close whatever is using them, then try again.", {
            first: DST_DISCOVERY_PORTS[0],
            last: DST_DISCOVERY_PORTS[DST_DISCOVERY_PORTS.length - 1],
          })}
        </span>
      ) : (
        <>
          <span>{t("Host a world: in the game choose Host Game, pick a world (new or saved, caves on or off), then choose your survivor and press Go. Sei's helper is on automatically.")}</span>
          {gameReady ? <SearchingLine label={t('Waiting for your world...')} className={skin.sub} /> : null}
        </>
      ),
    },
  ];

  return {
    steps,
    complete: helperReady,
    allDone: steps.every((s) => s.done),
    known: install != null,
  };
}

/* ── The token-styled numbered list (the setup modal's body) ── */

function TokenStepButton({ kind, disabled, onClick, children }: StepButtonProps): React.ReactElement {
  return (
    <Button kind={kind === 'primary' ? 'primary' : 'quiet'} size="sm" disabled={disabled} onClick={onClick}>
      {children}
    </Button>
  );
}

const TOKEN_SKIN: StepSkin = {
  actions: styles.actions,
  sub: styles.sub,
  mono: styles.mono,
  link: styles.link,
  Button: TokenStepButton,
};

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

/**
 * DstSteps — every step at once, in the app's tokens: the body of the setup
 * modal (DstSetupBody), where a player who pressed Play early sees what is
 * missing with the one button each step needs.
 */
export function DstSteps(): React.ReactElement {
  const t = useT();
  const { steps } = useDstSetupSteps(TOKEN_SKIN);
  const firstOpen = steps.findIndex((s) => !s.done);
  return (
    <ol className={styles.steps} aria-label={t('{game} setup steps', { game: DST_GAME_NAME })}>
      {steps.map((s, i) => (
        <Step key={s.id} index={i + 1} tone={s.done ? 'done' : i === firstOpen ? 'now' : 'later'}>
          {s.body}
        </Step>
      ))}
    </ol>
  );
}
