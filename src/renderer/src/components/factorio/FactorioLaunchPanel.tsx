/**
 * FactorioLaunchPanel (261113): the Factorio launch surface in the chat
 * game aside, in the app's tokens (no game art yet). The same shape as the
 * other launch panels:
 *
 *   title
 *   pack card       (the mod download; nothing once the pack is ready)
 *   setup window    (only while open: one step at a time, SetupStepper,
 *                    from useFactorioSetupSteps)
 *   big button      "Set up" until the game is supported and the mod is
 *                   in, then "Launch" (the shared summon flow)
 *   world line      once a game is loaded
 *   help link       "How do I set up launch?", once the setup is done
 */
import React from 'react';
import { useT } from '../../lib/i18n';
import { ERROR_COPY } from '../../lib/errors';
import { attemptSummon } from '../../lib/summonFlow';
import { requestGameLaunch } from '../../lib/gameLaunch';
import { useDataStore } from '../../lib/stores/useDataStore';
import { Button } from '../Button';
import { GamePackCard } from '../games/GamePackCard';
import { DEFAULT_STEPPER_SKIN, SetupStepper, useSetupWindow, type StepButtonProps, type StepSkin } from '../games/SetupStepper';
import { useFactorioSetupSteps, FACTORIO_GAME_NAME as GAME_NAME } from './FactorioSteps';
import styles from './factorio.module.css';

function StepButton({ kind, disabled, onClick, children }: StepButtonProps): React.ReactElement {
  return (
    <Button kind={kind === 'primary' ? 'primary' : 'quiet'} size="sm" disabled={disabled} onClick={onClick}>
      {children}
    </Button>
  );
}

const STEP_SKIN: StepSkin = {
  actions: styles.actions,
  sub: styles.sub,
  mono: styles.mono,
  link: styles.link,
  Button: StepButton,
};

export interface FactorioLaunchPanelProps {
  characterId: string;
}

export function FactorioLaunchPanel({ characterId }: FactorioLaunchPanelProps): React.ReactElement {
  const t = useT();
  const summon = useDataStore((s) => s.summons[characterId]);
  const world = useDataStore((s) => s.worlds.factorio);
  const setup = useFactorioSetupSteps(STEP_SKIN);
  const win = useSetupWindow(setup.allDone);

  const fw = world && world.game === 'factorio' ? world : null;
  const connecting = summon?.kind === 'connecting';
  const failReason = summon?.kind === 'error' ? (ERROR_COPY[summon.error] ?? ERROR_COPY.BOT_CRASH) : null;

  const onLaunch = (): void =>
    requestGameLaunch(characterId, { id: 'factorio', name: GAME_NAME }, () => void attemptSummon(characterId, 'factorio'));

  const showSetUp = setup.known && !setup.complete && win.mode === null;
  const bigDisabled = connecting || !setup.known || (!setup.complete && win.mode !== null);

  return (
    <div className={styles.panel} data-game="factorio" aria-label={GAME_NAME}>
      <h2 className={styles.title}>{GAME_NAME}</h2>
      <GamePackCard game="factorio" />
      {win.mode ? (
        <SetupStepper
          key={win.mode}
          steps={setup.steps}
          mode={win.mode}
          onClose={win.close}
          skin={DEFAULT_STEPPER_SKIN}
          label={t('{game} setup steps', { game: GAME_NAME })}
        />
      ) : null}
      <Button kind="primary" size="lg" disabled={bigDisabled} onClick={showSetUp ? win.openSetup : onLaunch}>
        {connecting ? t('Connecting...') : showSetUp ? t('Set up') : t('Launch')}
      </Button>
      {fw?.kind === 'open' ? (
        <p className={styles.worldLine}>{fw.detail.paused ? t('Your game is loaded and paused.') : t('Your game is loaded.')}</p>
      ) : null}
      {failReason ? (
        <p className={styles.failLine} role="alert">{t(failReason)}</p>
      ) : null}
      {setup.complete && win.mode === null ? (
        <button type="button" className={styles.helpLink} onClick={win.openHelp}>
          {t('How do I set up launch?')}
        </button>
      ) : null}
    </div>
  );
}
