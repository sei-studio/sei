/**
 * TerrariaLaunchPanel (261113): the Terraria launch surface in the chat
 * game aside, in the app's tokens (no game art: the Terraria terms rule out
 * generated game art). The same shape as the other launch panels:
 *
 *   title, pack card, setup window (one step at a time, SetupStepper),
 *   big button ("Set up" until tModLoader and the mod are in, then
 *   "Launch"), world line, help link.
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
import { useTerrariaSetupSteps, TERRARIA_GAME_NAME as GAME_NAME } from './TerrariaSteps';
import styles from './terraria.module.css';

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

export interface TerrariaLaunchPanelProps {
  characterId: string;
}

export function TerrariaLaunchPanel({ characterId }: TerrariaLaunchPanelProps): React.ReactElement {
  const t = useT();
  const summon = useDataStore((s) => s.summons[characterId]);
  const world = useDataStore((s) => s.worlds.terraria);
  const setup = useTerrariaSetupSteps(STEP_SKIN);
  const win = useSetupWindow(setup.allDone);

  const tw = world && world.game === 'terraria' ? world : null;
  const connecting = summon?.kind === 'connecting';
  const failReason = summon?.kind === 'error' ? (ERROR_COPY[summon.error] ?? ERROR_COPY.BOT_CRASH) : null;

  const onLaunch = (): void =>
    requestGameLaunch(characterId, { id: 'terraria', name: GAME_NAME }, () => void attemptSummon(characterId, 'terraria'));

  const showSetUp = setup.known && !setup.complete && win.mode === null;
  const bigDisabled = connecting || !setup.known || (!setup.complete && win.mode !== null);

  return (
    <div className={styles.panel} data-game="terraria" aria-label={GAME_NAME}>
      <h2 className={styles.title}>{GAME_NAME}</h2>
      <GamePackCard game="terraria" />
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
      {tw?.kind === 'open' ? <p className={styles.worldLine}>{t('Your world is open.')}</p> : null}
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
