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
 *   Start Minecraft   (260929) once set up, with a Sei profile and no open
 *                     world: selects the Sei profile in the Minecraft
 *                     Launcher and opens it (useStartMinecraft)
 *   version line      "Works with most Minecraft Java versions from 1.8 to
 *                     26.3." + "Which versions?" (260929), which opens a
 *                     small GUI window listing every joinable span, one
 *                     per slot (the inline list was a wall of numbers),
 *                     as a modal over the panel (McVersionsWindow)
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
import { MC_RANGE_VARS, mcVersionSpanList, worldTooNewForSei } from '../../lib/mcVersions';
import { GamePackCard } from '../games/GamePackCard';
import { SetupStepper, useSetupWindow, type StepButtonProps, type StepSkin, type StepperSkin } from '../games/SetupStepper';
import { useMcSetupSteps } from './McSteps';
import { useSeiProfile, useStartMinecraft } from './useStartMinecraft';
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

/**
 * "Which versions?" (260929): every joinable span as a slot in the vanilla
 * dialog, so the gaps (1.9.0 to 1.9.2, 1.11, ...) are readable instead of
 * buried in one sentence. Derived from the same table as the short line.
 *
 * 260929 (v0.6.5 smoke test): it used to open IN the column under the version
 * line, which at a 720pt window is below the panel's fold, so the link looked
 * dead. It is now a small modal over the whole panel (the pause-menu
 * darkening under the dialog), centered in what is visible: x, Esc, or a
 * click outside the dialog closes it.
 */
function McVersionsWindow({ onClose }: { onClose: () => void }): React.ReactElement {
  const t = useT();
  const spans = mcVersionSpanList(t);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div
      className={styles.overlay}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section className={`${styles.window} ${styles.versionsWindow}`} role="dialog" aria-label={t('Versions Sei can join')} data-slot="mc-versions">
        <div className={styles.head}>
          <span className={styles.stepTitle}>{t('Versions Sei can join')}</span>
          <button type="button" className={styles.close} onClick={onClose} aria-label={t('Close')} autoFocus>
            ×
          </button>
        </div>
        <ul className={styles.spans}>
          {spans.map((span) => (
            <li key={span} className={styles.span}>
              {span}
            </li>
          ))}
        </ul>
        <span className={styles.sub}>{t('Versions not listed here will not work.')}</span>
      </section>
    </div>
  );
}

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
  const [versionsOpen, setVersionsOpen] = React.useState(false);
  const versionsLinkRef = React.useRef<HTMLButtonElement | null>(null);
  const closeVersions = React.useCallback(() => {
    setVersionsOpen(false);
    versionsLinkRef.current?.focus();
  }, []);
  // The short range needs its list beside it; an unrelated failure line
  // (credits, a crash) does not name versions, so it gets no link.
  const namesRange = !failReason || (summon?.kind === 'error' && summon.error === 'UNSUPPORTED_MC_VERSION');
  const versionsLink = namesRange ? (
    <>
      {' '}
      <button
        ref={versionsLinkRef}
        type="button"
        className={styles.inlineLink}
        aria-haspopup="dialog"
        aria-expanded={versionsOpen}
        onClick={() => setVersionsOpen((v) => !v)}
      >
        {t('Which versions?')}
      </button>
    </>
  ) : null;

  const launch = (): void =>
    // 260721: shared cross-launch gate — a live chess game or screen share
    // confirms (and ends) before the summon runs.
    requestGameLaunch(characterId, { id: 'minecraft', name: 'Minecraft' }, () => void attemptSummon(characterId));

  const seiProfile = useSeiProfile();
  const launcher = useStartMinecraft();
  const showStart =
    setup.complete && seiProfile.version != null && lan.kind !== 'open' && !connecting && win.mode === null;

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
        <GamePackCard game="minecraft" className={styles.pack} />
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
        {showStart ? (
          <McButton kind="primary" disabled={launcher.busy} onClick={() => void launcher.start(seiProfile.version)}>
            {t('Start Minecraft')}
          </McButton>
        ) : null}
        {showStart && launcher.note ? (
          <p className={styles.versionLine} role="status">
            {launcher.note.text}
          </p>
        ) : null}
        {failReason ? (
          <p className={styles.failLine} role="alert">
            {failReason}
            {versionsLink}
          </p>
        ) : worldTooNew ? (
          <p className={styles.failLine} role="status">
            {t('Your open world is on Minecraft {version}, which Sei cannot join yet. Sei works with most Minecraft Java versions from {oldest} to {newest}.', { ...MC_RANGE_VARS, version: worldVersion ?? '' })}
            {versionsLink}
          </p>
        ) : (
          <p className={styles.versionLine}>
            {t('Works with most Minecraft Java versions from {oldest} to {newest}.', MC_RANGE_VARS)}
            {versionsLink}
          </p>
        )}
        {setup.complete && win.mode === null ? (
          <button type="button" className={styles.helpLink} onClick={win.openHelp}>
            {t('How do I set up launch?')}
          </button>
        ) : null}
      </div>
      {versionsOpen && namesRange ? <McVersionsWindow onClose={closeVersions} /> : null}
    </div>
  );
}
