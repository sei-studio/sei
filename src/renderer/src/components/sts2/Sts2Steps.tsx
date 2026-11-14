/**
 * useSts2SetupSteps (261115): the Slay the Spire 2 setup steps as DATA,
 * shared by the launch panel's one-step window (SetupStepper) and the setup
 * modal a pending summon opens (Sts2Steps, the token-styled numbered list).
 * One hook so the two surfaces can never disagree about what is missing.
 *
 *   1. the game is installed          (Sei finds it in the Steam libraries)
 *   2. the Sei mod is in the game     (one button: Sei copies it in)
 *   3. the mod is on in the game      (the player turns it on in Settings,
 *                                      Mods; done once the mod's heartbeat
 *                                      has been seen)
 *   4. a Sei co-op lobby is open      ("Play with Sei" in the main menu;
 *                                      main's watcher, worlds.sts2 = open)
 *
 * The companion then plays from a SECOND game window that main starts on
 * Launch and closes on stop; step 4 says so once.
 */
import React, { useEffect } from 'react';
import { useT } from '../../lib/i18n';
import { sei } from '../../lib/ipcClient';
import { Button } from '../Button';
import { useDataStore } from '../../lib/stores/useDataStore';
import { SearchingLine, type SetupStep, type StepButtonProps, type StepSkin } from '../games/SetupStepper';
import { useSts2Store } from './useSts2Store';
import styles from './sts2.module.css';

const POLL_MS = 3000;
export const STS2_GAME_NAME = 'Slay the Spire 2';

export interface Sts2Setup {
  steps: SetupStep[];
  /** The game is found, the mod is in and turned on: the panel may offer Launch. */
  complete: boolean;
  allDone: boolean;
  known: boolean;
}

/**
 * The mod's main-menu button. Fixed English text (the mod is English only),
 * so it stays verbatim inside every translated sentence.
 */
const PLAY_WITH_SEI = 'Play with Sei';

export function useSts2SetupSteps(skin: StepSkin): Sts2Setup {
  const t = useT();
  const setup = useSts2Store((s) => s.setup);
  const installBusy = useSts2Store((s) => s.installBusy);
  const starting = useSts2Store((s) => s.starting);
  const failure = useSts2Store((s) => s.failure);
  const refresh = useSts2Store((s) => s.refresh);
  const runInstall = useSts2Store((s) => s.runInstall);
  const startGame = useSts2Store((s) => s.startGame);
  const world = useDataStore((s) => s.worlds.sts2);
  const sw = world && world.game === 'sts2' ? world : null;
  const worldOpen = sw?.kind === 'open';
  const { Button: SkinButton } = skin;

  useEffect(() => {
    void refresh();
    if (worldOpen) return;
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [refresh, worldOpen]);

  const found = setup?.kind === 'found' ? setup : null;
  const modReady = found != null && found.modInstalled && found.modCurrent;
  // A heartbeat from the player's window proves the mod is on, whatever else detection said.
  const modOn = worldOpen || sw?.kind === 'no_lobby' || (found?.modLoaded ?? false);
  const lobbyOpen = worldOpen || (found?.lobbyOpen ?? false);
  const installFail = failure?.action === 'install' ? failure : null;
  const startFail = failure?.action === 'start' ? failure : null;
  const playWith = PLAY_WITH_SEI;

  const steps: SetupStep[] = [
    {
      id: 'game',
      title: STS2_GAME_NAME,
      done: worldOpen || found != null,
      body:
        setup == null ? (
          <span>{t('Looking for Slay the Spire 2 on this computer...')}</span>
        ) : setup.kind === 'not_found' ? (
          <>
            <span>{t('Sei looks for Slay the Spire 2 in your Steam libraries. Install it from Steam, then check again. We looked in:')}</span>
            {setup.searched.slice(0, 3).map((p) => (
              <span key={p} className={skin.mono}>{p}</span>
            ))}
            <div className={skin.actions}>
              <SkinButton kind="primary" onClick={() => void refresh()}>{t('Check again')}</SkinButton>
            </div>
          </>
        ) : (
          <span>{t('Slay the Spire 2 is installed.')}</span>
        ),
    },
    {
      id: 'mod',
      title: t('The Sei mod'),
      done: worldOpen || modReady,
      body: modReady || worldOpen ? (
        <span>{found?.modVersion ? t('The Sei mod is in the game (v{version}).', { version: found.modVersion }) : t('The Sei mod is in the game.')}</span>
      ) : (
        <>
          {installFail ? (
            <>
              <span role="alert">{installFailLine(installFail.reason, t)}</span>
              {installFail.reason === 'failed' ? <span className={skin.mono}>{installFail.message}</span> : null}
            </>
          ) : found?.grantNeeded ? (
            <span role="alert">{installFailLine('permission', t)}</span>
          ) : found?.modInstalled ? (
            <span>{t('A newer Sei mod is ready. Update it while the game is closed.')}</span>
          ) : (
            <span>{t('Add the Sei mod. Your companion plays and talks with you through it.')}</span>
          )}
          {found?.gameRunning ? <span className={skin.sub}>{t('Close Slay the Spire 2 first, then add the mod.')}</span> : null}
          {sei.platform === 'darwin' && !installFail ? (
            <span className={skin.sub}>{t('macOS may ask once for permission. Allow it so Sei can add the mod.')}</span>
          ) : null}
          <div className={skin.actions}>
            <SkinButton kind="primary" disabled={installBusy || starting || found == null || found.gameRunning} onClick={() => void runInstall()}>
              {installFail ? t('Try again') : found?.modInstalled ? t('Update the Sei mod') : t('Add the Sei mod')}
            </SkinButton>
          </div>
        </>
      ),
    },
    {
      id: 'enable',
      title: t('Turn the mod on'),
      done: modOn,
      body: modOn ? (
        <span>{t('The Sei mod is on in the game.')}</span>
      ) : (
        <>
          <span>{t('Start the game, open Settings, then Mods. Turn on Sei Companion and restart the game when it asks.')}</span>
          {startFail ? (
            <>
              <span role="alert">{startFailLine(startFail.reason, t)}</span>
              {startFail.reason === 'failed' ? <span className={skin.mono}>{startFail.message}</span> : null}
            </>
          ) : null}
          {found?.gameRunning ? null : (
            <div className={skin.actions}>
              <SkinButton kind="primary" disabled={starting || installBusy || !modReady} onClick={() => void startGame()}>
                {starting ? t('Starting Slay the Spire 2...') : t('Start Slay the Spire 2')}
              </SkinButton>
            </div>
          )}
          {modReady ? <SearchingLine label={t('Waiting for the mod...')} className={skin.sub} /> : null}
        </>
      ),
    },
    {
      id: 'lobby',
      title: t('A co-op lobby'),
      done: lobbyOpen,
      body: (
        <>
          {lobbyOpen ? (
            <span>{t('Your co-op lobby is open.')}</span>
          ) : sw?.kind === 'no_lobby' && sw.lobby === 'steam' ? (
            <span>{t('This is a Steam lobby, which your companion cannot join. Leave it, then click "{button}" in the main menu.', { button: playWith })}</span>
          ) : (
            <span>{t('In the main menu, click "{button}". It opens a co-op lobby on this computer.', { button: playWith })}</span>
          )}
          <span className={skin.sub}>
            {t('Your companion plays in a second game window. Sei opens it when you press Launch and closes it when you stop.')}
          </span>
          {!lobbyOpen && modOn ? <SearchingLine label={t('Waiting for your lobby...')} className={skin.sub} /> : null}
        </>
      ),
    },
  ];

  return {
    steps,
    complete: found != null && modReady && modOn,
    allDone: steps.every((s) => s.done),
    known: setup != null,
  };
}

function installFailLine(reason: string, t: ReturnType<typeof useT>): string {
  switch (reason) {
    case 'game_running':
      return t('Close Slay the Spire 2 first, then add the mod.');
    case 'permission':
      return t('macOS did not allow Sei to add the mod. Press Try again and allow it in the panel that opens.');
    case 'not_found':
      return t('Finish the steps above first.');
    default:
      return t("Couldn't add the Sei mod.");
  }
}

function startFailLine(reason: string, t: ReturnType<typeof useT>): string {
  switch (reason) {
    case 'game_running':
      return t('Slay the Spire 2 is already running.');
    case 'mod_missing':
    case 'not_found':
      return t('Finish the steps above first.');
    default:
      return t("Couldn't start Slay the Spire 2. Start it from Steam instead.");
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

export const STS2_TOKEN_SKIN: StepSkin = {
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
export function Sts2Steps(): React.ReactElement {
  const t = useT();
  const { steps } = useSts2SetupSteps(STS2_TOKEN_SKIN);
  const firstOpen = steps.findIndex((s) => !s.done);
  return (
    <ol className={styles.steps} aria-label={t('{game} setup steps', { game: STS2_GAME_NAME })}>
      {steps.map((s, i) => (
        <Step key={s.id} index={i + 1} tone={s.done ? 'done' : i === firstOpen ? 'now' : 'later'}>
          {s.body}
        </Step>
      ))}
    </ol>
  );
}
