/**
 * useFactorioSetupSteps (261113): the Factorio setup steps as DATA, shared
 * by the launch panel's one-step window (SetupStepper) and the setup modal a
 * pending summon opens (FactorioSteps, the token-styled numbered list). One
 * hook so the two surfaces can never disagree about what is missing.
 *
 *   1. Factorio 2.1 is installed       (Sei finds it)
 *   2. the Sei mod is in Factorio      (one button: Sei copies + enables it)
 *   3. Factorio was started from Sei   (one button: the link flag only exists
 *                                       when Sei starts the game)
 *   4. a game is loaded                (the mod answers the hello)
 *
 * While no game is loaded it polls detection every few seconds so a game
 * quit or an update moves the list without a click. Main's world watcher
 * (useDataStore.worlds.factorio) carries steps 3 and 4.
 */
import React, { useEffect } from 'react';
import { useT } from '../../lib/i18n';
import { Button } from '../Button';
import { useDataStore } from '../../lib/stores/useDataStore';
import { SearchingLine, type SetupStep, type StepButtonProps, type StepSkin } from '../games/SetupStepper';
import { useFactorioStore } from './useFactorioStore';
import styles from './factorio.module.css';

const POLL_MS = 3000;
export const FACTORIO_GAME_NAME = 'Factorio';

export interface FactorioSetup {
  steps: SetupStep[];
  /** The game is supported and the mod is in: the panel may offer Launch. */
  complete: boolean;
  allDone: boolean;
  known: boolean;
}

export function useFactorioSetupSteps(skin: StepSkin): FactorioSetup {
  const t = useT();
  const setup = useFactorioStore((s) => s.setup);
  const installBusy = useFactorioStore((s) => s.installBusy);
  const launching = useFactorioStore((s) => s.launching);
  const failure = useFactorioStore((s) => s.failure);
  const refresh = useFactorioStore((s) => s.refresh);
  const runInstall = useFactorioStore((s) => s.runInstall);
  const launchGame = useFactorioStore((s) => s.launchGame);
  const world = useDataStore((s) => s.worlds.factorio);
  const fw = world && world.game === 'factorio' ? world : null;
  const worldOpen = fw?.kind === 'open';
  const { Button: SkinButton } = skin;

  useEffect(() => {
    void refresh();
    if (worldOpen) return;
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [refresh, worldOpen]);

  const found = setup?.kind === 'found' ? setup : null;
  const gameOk = found != null && found.install.supported !== false;
  const modReady = found != null && found.modInstalled && found.modEnabled;
  // The mod answering proves every earlier step whatever detection said.
  const linked = worldOpen || fw?.kind === 'no_game';
  const portFailed = fw?.kind === 'unavailable';
  const runningUnlinked = !linked && !portFailed && found?.gameRunning === true;
  const installFail = failure?.action === 'install' ? failure : null;
  const launchFail = failure?.action === 'launch' ? failure : null;

  const steps: SetupStep[] = [
    {
      id: 'game',
      title: FACTORIO_GAME_NAME,
      done: worldOpen || gameOk,
      body:
        setup == null ? (
          <span>{t('Looking for Factorio on this computer...')}</span>
        ) : setup.kind === 'not_found' ? (
          <>
            <span>{t('Install Factorio 2.1, then check again. We looked in:')}</span>
            {setup.searched.slice(0, 3).map((p) => (
              <span key={p} className={skin.mono}>{p}</span>
            ))}
            <div className={skin.actions}>
              <SkinButton kind="primary" onClick={() => void refresh()}>{t('Check again')}</SkinButton>
            </div>
          </>
        ) : setup.install.supported === false ? (
          <>
            <span role="alert">
              {t('Sei needs Factorio 2.1. This computer has Factorio {version}. Update the game, then check again.', {
                version: setup.install.version ?? '?',
              })}
            </span>
            <div className={skin.actions}>
              <SkinButton kind="primary" onClick={() => void refresh()}>{t('Check again')}</SkinButton>
            </div>
          </>
        ) : (
          <span>{t('Factorio {version} is installed.', { version: setup.install.version ?? '2.1' })}</span>
        ),
    },
    {
      id: 'mod',
      title: t('The Sei mod'),
      done: worldOpen || modReady,
      body: modReady || worldOpen ? (
        <span>{t('The Sei mod is in Factorio (v{version}).', { version: found?.modVersion ?? '?' })}</span>
      ) : (
        <>
          {installFail ? (
            <>
              <span role="alert">{t("Couldn't add the Sei mod.")}</span>
              <span className={skin.mono}>{installFail.message}</span>
            </>
          ) : found?.modInstalled && !found.modEnabled ? (
            <span>{t('The Sei mod is turned off in Factorio. Add it again to turn it back on.')}</span>
          ) : (
            <>
              <span>{t('Add the Sei mod. Your companion joins your game through it.')}</span>
              <span className={skin.sub}>{t('Factorio turns off achievements while mods are on.')}</span>
            </>
          )}
          {found?.gameRunning === true ? <span className={skin.sub}>{t('Close Factorio first, then add the mod.')}</span> : null}
          <div className={skin.actions}>
            <SkinButton kind="primary" disabled={installBusy || launching || !gameOk || found?.gameRunning === true} onClick={() => void runInstall()}>
              {installFail ? t('Try again') : t('Add the Sei mod')}
            </SkinButton>
          </div>
        </>
      ),
    },
    {
      id: 'run',
      title: t('Start Factorio from Sei'),
      done: linked,
      body: linked ? (
        <span>{t('Factorio is running with the Sei link.')}</span>
      ) : (
        <>
          {portFailed ? (
            <span role="alert">
              {t('Factorio could not open the Sei link. Close Factorio, then start it from Sei again. Sei will try another port.')}
            </span>
          ) : runningUnlinked ? (
            <span>{t('Factorio is running, but it was not started from Sei. Close it, then start it here so your companion can connect.')}</span>
          ) : (
            <span>{t('Start Factorio from here. Sei opens it with a link your companion uses.')}</span>
          )}
          {found?.install.store === 'steam' && !runningUnlinked ? (
            <span className={skin.sub}>{t('If Steam asks whether to allow the launch options, press OK.')}</span>
          ) : null}
          {launchFail ? (
            <>
              <span role="alert">{launchFailLine(launchFail.reason, t)}</span>
              {launchFail.reason === 'failed' ? <span className={skin.mono}>{launchFail.message}</span> : null}
            </>
          ) : null}
          <div className={skin.actions}>
            <SkinButton kind="primary" disabled={launching || installBusy || !gameOk || runningUnlinked} onClick={() => void launchGame()}>
              {launching ? t('Starting Factorio...') : t('Launch Factorio')}
            </SkinButton>
          </div>
        </>
      ),
    },
    {
      id: 'load',
      title: t('A game loaded'),
      done: worldOpen,
      body: worldOpen ? (
        <span>{t('Your game is loaded.')}</span>
      ) : (
        <>
          <span>{t('Load a save or start a new game. Single player and games you host both work.')}</span>
          {linked ? <SearchingLine label={t('Waiting for your game...')} className={skin.sub} /> : null}
        </>
      ),
    },
  ];

  return {
    steps,
    complete: gameOk && modReady,
    allDone: steps.every((s) => s.done),
    known: setup != null,
  };
}

/** The launch step's failure line (the reasons main returns). */
function launchFailLine(reason: string, t: ReturnType<typeof useT>): string {
  switch (reason) {
    case 'game_running':
      return t('Factorio is already running. Close it first.');
    case 'no_free_port':
      return t('Sei could not find a free local port for the link. Close other apps, then try again.');
    case 'mod_missing':
    case 'not_found':
    case 'unsupported_version':
      return t('Finish the steps above first.');
    default:
      return t("Couldn't start Factorio.");
  }
}

/* ── The token-styled numbered list (the setup modal's body) ── */

function TokenStepButton({ kind, disabled, onClick, children }: StepButtonProps): React.ReactElement {
  return (
    <Button kind={kind === 'primary' ? 'primary' : 'quiet'} size="sm" disabled={disabled} onClick={onClick}>
      {children}
    </Button>
  );
}

export const FACTORIO_TOKEN_SKIN: StepSkin = {
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
    <li className={`${styles.step} ${cls ?? ''}`} aria-current={tone === 'now' ? 'step' : undefined}>
      <span className={styles.stepNumber} aria-hidden="true">
        {tone === 'done' ? '✓' : String(index).padStart(2, '0')}
      </span>
      <div className={styles.stepBody}>{children}</div>
    </li>
  );
}

/** Every step at once, in the app's tokens: the setup modal's body. */
export function FactorioSteps(): React.ReactElement {
  const t = useT();
  const { steps } = useFactorioSetupSteps(FACTORIO_TOKEN_SKIN);
  const firstOpen = steps.findIndex((s) => !s.done);
  return (
    <ol className={styles.steps} aria-label={t('{game} setup steps', { game: FACTORIO_GAME_NAME })}>
      {steps.map((s, i) => (
        <Step key={s.id} index={i + 1} tone={s.done ? 'done' : i === firstOpen ? 'now' : 'later'}>
          {s.body}
        </Step>
      ))}
    </ol>
  );
}
