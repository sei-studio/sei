/**
 * useTerrariaSetupSteps (261113): the Terraria setup steps as DATA, shared
 * by the launch panel's one-step window (SetupStepper) and the setup modal a
 * pending summon opens (TerrariaSteps, the token-styled numbered list).
 *
 *   1. tModLoader is installed     (Sei reads the Steam library)
 *   2. the Sei mod is in           (one button: Sei copies + enables it)
 *   3. tModLoader is running       (the mod answers its hello)
 *   4. a world is open             (single player or Host and Play)
 *
 * While no world is open it polls detection every few seconds. Main's world
 * watcher (useDataStore.worlds.terraria) carries steps 3 and 4.
 */
import React, { useEffect } from 'react';
import { useT } from '../../lib/i18n';
import { Button } from '../Button';
import { useDataStore } from '../../lib/stores/useDataStore';
import { SearchingLine, type SetupStep, type StepButtonProps, type StepSkin } from '../games/SetupStepper';
import { useTerrariaStore } from './useTerrariaStore';
import styles from './terraria.module.css';

const POLL_MS = 3000;
export const TERRARIA_GAME_NAME = 'Terraria';

export interface TerrariaSetup {
  steps: SetupStep[];
  /** tModLoader is (or may be) there and the mod is in: the panel may offer Launch. */
  complete: boolean;
  allDone: boolean;
  known: boolean;
}

export function useTerrariaSetupSteps(skin: StepSkin): TerrariaSetup {
  const t = useT();
  const setup = useTerrariaStore((s) => s.setup);
  const installBusy = useTerrariaStore((s) => s.installBusy);
  const launching = useTerrariaStore((s) => s.launching);
  const failure = useTerrariaStore((s) => s.failure);
  const refresh = useTerrariaStore((s) => s.refresh);
  const runInstall = useTerrariaStore((s) => s.runInstall);
  const launchGame = useTerrariaStore((s) => s.launchGame);
  const world = useDataStore((s) => s.worlds.terraria);
  const tw = world && world.game === 'terraria' ? world : null;
  const worldOpen = tw?.kind === 'open';
  const { Button: SkinButton } = skin;

  useEffect(() => {
    void refresh();
    if (worldOpen) return;
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [refresh, worldOpen]);

  // The mod answering proves every earlier step whatever detection said.
  const running = worldOpen || tw?.kind === 'no_world' || tw?.kind === 'joined_other';
  // null = the Steam library could not be read: do not block on it.
  const tmlOk = running || (setup != null && setup.tmlInstalled !== false);
  const modReady = running || (setup != null && setup.modInstalled && setup.modEnabled && setup.linked);
  const installFail = failure?.action === 'install' ? failure : null;
  const launchFail = failure?.action === 'launch' ? failure : null;

  const steps: SetupStep[] = [
    {
      id: 'game',
      title: 'tModLoader',
      done: tmlOk,
      body:
        setup == null && !running ? (
          <span>{t('Looking for tModLoader on this computer...')}</span>
        ) : !tmlOk ? (
          <>
            <span>{t('Install tModLoader from Steam. It is free for everyone who owns Terraria. Then check again.')}</span>
            <div className={skin.actions}>
              <SkinButton kind="primary" onClick={() => void refresh()}>{t('Check again')}</SkinButton>
            </div>
          </>
        ) : setup?.tmlInstalled === null && !running ? (
          <span>{t('Sei could not read your Steam library. If tModLoader is installed, carry on.')}</span>
        ) : (
          <span>{t('tModLoader is installed.')}</span>
        ),
    },
    {
      id: 'mod',
      title: t('The Sei mod'),
      done: modReady,
      body: modReady ? (
        <span>{t('The Sei mod is in tModLoader (v{version}).', { version: setup?.modVersion ?? '?' })}</span>
      ) : (
        <>
          {installFail ? (
            <>
              <span role="alert">{t("Couldn't add the Sei mod.")}</span>
              <span className={skin.mono}>{installFail.message}</span>
            </>
          ) : (
            <>
              <span>{t('Add the Sei mod. Your companion joins your world through it.')}</span>
              <span className={skin.sub}>{t('Close tModLoader first if it is open.')}</span>
            </>
          )}
          <div className={skin.actions}>
            <SkinButton kind="primary" disabled={installBusy || launching || !tmlOk} onClick={() => void runInstall()}>
              {installFail ? t('Try again') : t('Add the Sei mod')}
            </SkinButton>
          </div>
        </>
      ),
    },
    {
      id: 'run',
      title: t('Start tModLoader'),
      done: running,
      body: running ? (
        <span>{t('tModLoader is running with the Sei mod.')}</span>
      ) : (
        <>
          <span>{t('Start tModLoader from here or from Steam.')}</span>
          {launchFail ? (
            <>
              <span role="alert">{launchFail.reason === 'failed' ? t("Couldn't start tModLoader.") : t('Finish the steps above first.')}</span>
              {launchFail.reason === 'failed' ? <span className={skin.mono}>{launchFail.message}</span> : null}
            </>
          ) : null}
          <div className={skin.actions}>
            <SkinButton kind="primary" disabled={launching || installBusy || !tmlOk} onClick={() => void launchGame()}>
              {launching ? t('Starting tModLoader...') : t('Launch tModLoader')}
            </SkinButton>
          </div>
        </>
      ),
    },
    {
      id: 'load',
      title: t('A world open'),
      done: worldOpen,
      body: worldOpen ? (
        <span>{t('Your world is open.')}</span>
      ) : tw?.kind === 'joined_other' ? (
        <span role="alert">{t("You joined someone else's server. Your companion can only join a world this computer runs.")}</span>
      ) : (
        <>
          <span>{t('Open a world in Single Player, or use Host and Play. Your companion joins worlds this computer runs.')}</span>
          {running ? <SearchingLine label={t('Waiting for your world...')} className={skin.sub} /> : null}
        </>
      ),
    },
  ];

  return {
    steps,
    complete: tmlOk && modReady,
    allDone: steps.every((s) => s.done),
    known: setup != null || running,
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

export const TERRARIA_TOKEN_SKIN: StepSkin = {
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
export function TerrariaSteps(): React.ReactElement {
  const t = useT();
  const { steps } = useTerrariaSetupSteps(TERRARIA_TOKEN_SKIN);
  const firstOpen = steps.findIndex((s) => !s.done);
  return (
    <ol className={styles.steps} aria-label={t('{game} setup steps', { game: TERRARIA_GAME_NAME })}>
      {steps.map((s, i) => (
        <Step key={s.id} index={i + 1} tone={s.done ? 'done' : i === firstOpen ? 'now' : 'later'}>
          {s.body}
        </Step>
      ))}
    </ol>
  );
}
