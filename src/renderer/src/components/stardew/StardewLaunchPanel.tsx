/**
 * StardewLaunchPanel (game adapters M1, 260908; reworked 260909): the
 * Stardew Valley launch surface in the chat game aside, mounted through
 * GAME_SURFACES while the bot is offline. Painted in the game's own
 * register (the wooden menu frame with the cream face, dark-plum pixel
 * text with the tan shadow) over the game art, centered, the same shape
 * as the Minecraft panel:
 *
 *   title
 *   pack card       (the built mod; nothing once the pack is ready)
 *   setup window    (only while open: one step at a time, SetupStepper,
 *                    from useStardewSetupSteps)
 *   big button      "Set up" until SMAPI + the helper are in the game,
 *                   then "Launch" (the shared summon flow); disabled
 *                   under an open window on an unfinished setup
 *   name line       the companion's in-game name
 *   help link       "How do I set up launch?", once the setup is done
 */
import React from 'react';
import { effectiveStardewName } from '../../lib/stardewName';
import { useDataStore } from '../../lib/stores/useDataStore';
import { attemptSummon } from '../../lib/summonFlow';
import { requestGameLaunch } from '../../lib/gameLaunch';
import { ERROR_COPY } from '../../lib/errors';
import { useT } from '../../lib/i18n';
import { GamePackCard } from '../games/GamePackCard';
import { SetupStepper, useSetupWindow, type StepButtonProps, type StepSkin, type StepperSkin } from '../games/SetupStepper';
import { useStardewSetupSteps } from './StardewSteps';
import styles from './StardewLaunchPanel.module.css';

/** Same renderer-relative art the picker tile uses (public/img). */
const ART = './img/game-stardew.jpg';

/** The wood-framed cream button, at step size. */
function SdvButton({ kind, disabled, onClick, children }: StepButtonProps): React.ReactElement {
  return (
    <button type="button" className={`${styles.btn} ${kind === 'quiet' ? styles.btnQuiet : ''}`} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

const STEP_SKIN: StepSkin = {
  actions: styles.actions,
  sub: styles.sub,
  mono: styles.mono,
  link: styles.link,
  Button: SdvButton,
};

const WINDOW_SKIN: StepperSkin = {
  window: styles.window,
  head: styles.head,
  count: styles.count,
  title: styles.stepTitle,
  close: styles.close,
  body: styles.body,
  nav: styles.nav,
  dots: styles.dots,
  dot: styles.dot,
  dotDone: styles.dotDone,
  dotNow: styles.dotNow,
  navBtn: styles.navBtn,
};

export interface StardewLaunchPanelProps {
  characterId: string;
}

export function StardewLaunchPanel({ characterId }: StardewLaunchPanelProps): React.ReactElement {
  const t = useT();
  const summon = useDataStore((s) => s.summons[characterId]);
  const character = useDataStore((s) => s.characters.find((c) => c.id === characterId));
  const setup = useStardewSetupSteps(STEP_SKIN);
  const win = useSetupWindow(setup.allDone);

  const connecting = summon?.kind === 'connecting';
  const summonFail = summon?.kind === 'error' ? (ERROR_COPY[summon.error] ?? ERROR_COPY.BOT_CRASH) : null;
  const inGameName = character ? effectiveStardewName(character) : '';

  const summonNow = (): void => {
    requestGameLaunch(characterId, { id: 'stardew', name: 'Stardew Valley' }, () => void attemptSummon(characterId, 'stardew'));
  };

  const showSetUp = setup.known && !setup.complete && win.mode === null;
  const bigDisabled = connecting || !setup.known || (!setup.complete && win.mode !== null);

  return (
    <div className={styles.panel} style={{ backgroundImage: `url(${ART})` }} aria-label="Stardew Valley">
      <div className={styles.scrim} aria-hidden="true" />
      <div className={styles.content}>
        <h2 className={styles.title}>Stardew Valley</h2>
        <GamePackCard game="stardew" />
        {win.mode ? (
          <SetupStepper
            key={win.mode}
            steps={setup.steps}
            mode={win.mode}
            onClose={win.close}
            skin={WINDOW_SKIN}
            label={t('{game} setup steps', { game: 'Stardew Valley' })}
          />
        ) : null}
        <button type="button" className={`${styles.btn} ${styles.btnBig}`} disabled={bigDisabled} onClick={showSetUp ? win.openSetup : summonNow}>
          {connecting ? t('Connecting...') : showSetUp ? t('Set up') : t('Launch')}
        </button>
        {inGameName && setup.complete ? <p className={styles.nameLine}>{t('In game as {name}', { name: inGameName })}</p> : null}
        {summonFail ? (
          <p className={styles.failLine} role="alert">{t(summonFail)}</p>
        ) : null}
        {setup.complete && win.mode === null ? (
          <button type="button" className={styles.helpLink} onClick={win.openHelp}>
            {t('How do I set up launch?')}
          </button>
        ) : null}
      </div>
    </div>
  );
}
