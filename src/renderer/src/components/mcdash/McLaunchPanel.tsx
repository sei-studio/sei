/**
 * McLaunchPanel — the Minecraft game-launch surface (260721, reworked
 * 260909).
 *
 * Mounted in the ChatScreen game aside (the chess slot, inside the shared
 * GameSurface chrome) when the Minecraft tile is picked and the bot is not
 * online yet. The game art sits under a dark scrim and the panel is
 * painted in the game's own register (the vanilla GUI: a light-gray dialog
 * with pixel bevels, raised gray buttons with the 1px text shadow, a pixel
 * face), centered:
 *
 *   title
 *   pack card         (the runtime download; nothing once the pack is ready)
 *   setup window      (only while open: ONE step at a time, SetupStepper)
 *   big button        "Set up" until the one-time setup is done, then
 *                     "Launch"; disabled with a "Launch" label while the
 *                     window is open on an unfinished setup, so it is
 *                     visible under the window and reads as the goal
 *   help link         "How do I set up launch?", only once the setup is
 *                     done: it reopens the same window on step 1, with
 *                     every step's live state, for anyone who wants to
 *                     read it through again
 *
 * Launch runs the shared summon flow (username-conflict guard, fresh LAN
 * check, host-compatibility gate). With no open world detected, that flow
 * opens the Minecraft setup modal on the "Connecting to world" tab WITH
 * the searching animation, and auto-resumes the summon when a world
 * opens. While the summon is in flight the button reads "Starting
 * companion..." then "Joining your world..." (lib/summonProgress),
 * (disabled); on failure a one-line plain-English reason (ERROR_COPY)
 * shows under it. Once the bot is online, ChatScreen swaps this panel for
 * the live dashboard (McDashboardPanel).
 */

import React from 'react';
import { useDataStore } from '../../lib/stores/useDataStore';
import { attemptSummon } from '../../lib/summonFlow';
import { requestGameLaunch } from '../../lib/gameLaunch';
import { errorCopyText } from '../../lib/errors';
import { connectingLabel } from '../../lib/summonProgress';
import { mcRangeVars, worldTooNewForSei } from '../../lib/mcVersions';
import { GamePackCard } from '../games/GamePackCard';
import { SetupStepper, useSetupWindow, type StepButtonProps, type StepSkin, type StepperSkin } from '../games/SetupStepper';
import { useMcSetupSteps } from './McSteps';
import { useT, uiLanguage } from '../../lib/i18n';
import { useResetLine } from '../../lib/useResetLine';
import styles from './McLaunchPanel.module.css';

/** Same renderer-relative art the picker tile uses (public/img). */
const MC_ART = './img/game-minecraft.webp';

/** The vanilla raised button, at step size. */
function McButton({ kind, disabled, onClick, children }: StepButtonProps): React.ReactElement {
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
  Button: McButton,
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

export interface McLaunchPanelProps {
  characterId: string;
}

export function McLaunchPanel({ characterId }: McLaunchPanelProps): React.ReactElement {
  const t = useT();
  const summon = useDataStore((s) => s.summons[characterId]);
  const connecting = summon?.kind === 'connecting';
  const resetLine = useResetLine();
  const failCopy = summon?.kind === 'error' ? errorCopyText(summon.error, t) : null;
  // 260926: the pre-flight credit gate's refusal also says when free play
  // comes back (the same line as the usage-limit popup).
  const failReason =
    failCopy && summon?.kind === 'error' && summon.error === 'CLOUD_CREDITS_DEPLETED' && resetLine
      ? `${failCopy}${uiLanguage() === 'zh' ? '' : ' '}${resetLine}`
      : failCopy;
  // 260926: say which Minecraft versions work BEFORE the first Launch, and
  // warn when the open world is already known to be too new (the LAN
  // watcher's status ping names its version). UNSUPPORTED_MC_VERSION was the
  // top summon blocker by people (19 in 30 days, mostly 26.2 / 26.3) and the
  // player only learned the rule after a failed launch.
  const lan = useDataStore((s) => s.lan);
  const worldVersion = lan.kind === 'open' ? (lan.versionName ?? null) : null;
  const worldTooNew = worldTooNewForSei(worldVersion);
  const setup = useMcSetupSteps(STEP_SKIN);
  const win = useSetupWindow(setup.allDone);

  const launch = (): void =>
    // 260721: shared cross-launch gate — a live chess game or screen share
    // confirms (and ends) before the summon runs.
    requestGameLaunch(characterId, { id: 'minecraft', name: 'Minecraft' }, () => void attemptSummon(characterId));

  const showSetUp = setup.known && !setup.complete && win.mode === null;
  const bigDisabled = connecting || !setup.known || (!setup.complete && win.mode !== null);

  return (
    <div
      className={styles.panel}
      style={{ backgroundImage: `url(${MC_ART})` }}
      aria-label="Minecraft"
    >
      <div className={styles.scrim} aria-hidden="true" />
      {/* 260721: no local close control; the GameSurface bottom-right "x"
          dismisses this panel. */}
      <div className={styles.content}>
        <h2 className={styles.title}>Minecraft</h2>
        {/* 260908 game packs: the Minecraft runtime is a download on first
            use; the card renders nothing once the pack is ready. */}
        <GamePackCard game="minecraft" />
        {win.mode ? (
          <SetupStepper
            key={win.mode}
            steps={setup.steps}
            mode={win.mode}
            onClose={win.close}
            skin={WINDOW_SKIN}
            label={t('{game} setup steps', { game: 'Minecraft' })}
          />
        ) : null}
        <button
          type="button"
          className={`${styles.btn} ${styles.btnBig}`}
          disabled={bigDisabled}
          onClick={showSetUp ? win.openSetup : launch}
        >
          {connecting ? connectingLabel(summon, t) : showSetUp ? t('Set up') : t('Launch')}
        </button>
        {failReason ? (
          <p className={styles.failLine} role="alert">
            {failReason}
          </p>
        ) : worldTooNew ? (
          <p className={styles.failLine} role="status">
            {t('Your open world is on Minecraft {version}, which Sei cannot join yet. Sei works with Minecraft Java {versions}.', { ...mcRangeVars(t), version: worldVersion ?? '' })}
          </p>
        ) : (
          <p className={styles.versionLine}>
            {t('Works with Minecraft Java {versions}.', mcRangeVars(t))}
          </p>
        )}
        {setup.complete && win.mode === null ? (
          <button type="button" className={styles.helpLink} onClick={win.openHelp}>
            {t('How do I set up launch?')}
          </button>
        ) : null}
      </div>
    </div>
  );
}
