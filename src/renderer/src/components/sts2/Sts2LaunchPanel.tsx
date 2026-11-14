/**
 * Sts2LaunchPanel (261115): the Slay the Spire 2 launch surface in the chat
 * game aside, in the app's tokens (text only: no game logos or key art).
 * The same shape as the other launch panels:
 *
 *   title
 *   pack card       (the mod download; nothing once the pack is ready)
 *   setup window    (only while open: one step at a time, SetupStepper,
 *                    from useSts2SetupSteps)
 *   big button      "Set up" until the mod is in and on, then "Launch"
 *                   (the shared summon flow; main opens the companion's
 *                   own game window, which joins the lobby)
 *   world line      once a Sei co-op lobby or run is open
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
import { useSts2SetupSteps, STS2_GAME_NAME as GAME_NAME } from './Sts2Steps';
import styles from './sts2.module.css';

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

export interface Sts2LaunchPanelProps {
  characterId: string;
}

export function Sts2LaunchPanel({ characterId }: Sts2LaunchPanelProps): React.ReactElement {
  const t = useT();
  const summon = useDataStore((s) => s.summons[characterId]);
  const world = useDataStore((s) => s.worlds.sts2);
  const setup = useSts2SetupSteps(STEP_SKIN);
  const win = useSetupWindow(setup.allDone);

  const sw = world && world.game === 'sts2' ? world : null;
  const connecting = summon?.kind === 'connecting';
  const failReason = summon?.kind === 'error' ? (ERROR_COPY[summon.error] ?? ERROR_COPY.BOT_CRASH) : null;

  const onLaunch = (): void =>
    requestGameLaunch(characterId, { id: 'sts2', name: GAME_NAME }, () => void attemptSummon(characterId, 'sts2'));

  const showSetUp = setup.known && !setup.complete && win.mode === null;
  const bigDisabled = connecting || !setup.known || (!setup.complete && win.mode !== null);

  return (
    <div className={styles.panel} data-game="sts2" aria-label={GAME_NAME}>
      <h2 className={styles.title}>{GAME_NAME}</h2>
      <GamePackCard game="sts2" />
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
      {sw?.kind === 'open' ? (
        <p className={styles.worldLine}>{sw.detail.inRun ? t('Your co-op run is on.') : t('Your co-op lobby is open.')}</p>
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
