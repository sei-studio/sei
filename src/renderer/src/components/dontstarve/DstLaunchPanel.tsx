/**
 * DstLaunchPanel — the Don't Starve Together launch surface (game adapters
 * M2, 260908; reworked 260909), hosted in the chat game aside like
 * McLaunchPanel. Painted in the game's own register (ink ground over the
 * dimmed art, parchment sheets, hand-inked type), centered, the same shape
 * as the other two launch panels:
 *
 *   title
 *   pack card       (the Lua mod download; nothing once the pack is ready)
 *   setup window    (only while open: one step at a time, SetupStepper,
 *                    from useDstSetupSteps: game found, helper added, game
 *                    open, world hosted)
 *   big button      "Set up" until the helper is in the game, then
 *                   "Launch" (the shared summon flow); disabled under an
 *                   open window on an unfinished setup. 260909: the helper
 *                   seats ONE companion per world, so when another
 *                   companion is already in it the button gives way to a
 *                   line naming them.
 *   name + world    "{name} will appear as ..." and the day line once a
 *                   world is open
 *   help link       "How do I set up launch?", once the setup is done
 *   survivor        "Marv wants to play as Wigfrid" with a change control
 *                   over the eligible roster, on its own sheet
 */
import React, { useEffect } from 'react';
import { DST_SURVIVORS, dstSurvivor } from '@shared/dstSurvivors';
import { useT } from '../../lib/i18n';
import { ERROR_COPY } from '../../lib/errors';
import { attemptSummon } from '../../lib/summonFlow';
import { requestGameLaunch } from '../../lib/gameLaunch';
import { useDataStore } from '../../lib/stores/useDataStore';
import { GamePackCard } from '../games/GamePackCard';
import { SetupStepper, useSetupWindow, type StepButtonProps, type StepSkin, type StepperSkin } from '../games/SetupStepper';
import { useDstStore } from './useDstStore';
import { useDstSetupSteps, DST_GAME_NAME as GAME_NAME } from './DstSteps';
import styles from './DstLaunchPanel.module.css';

/** Same renderer-relative art the picker tile uses (public/img). */
const ART = './img/game-dontstarve.jpg';

/** The ink button (primary) and the parchment button (quiet), at step size. */
function DstButton({ kind, disabled, onClick, children }: StepButtonProps): React.ReactElement {
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
  Button: DstButton,
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

export interface DstLaunchPanelProps {
  characterId: string;
}

/** The character's in-game name (mirrors main's effectiveDstUsername). */
function dstName(name: string | undefined): string {
  const raw = String(name ?? '').replace(/\s+/g, ' ').trim();
  return (raw || 'Sei').slice(0, 32);
}

export function DstLaunchPanel({ characterId }: DstLaunchPanelProps): React.ReactElement {
  const t = useT();
  const character = useDataStore((s) => s.characters.find((c) => c.id === characterId));
  const summon = useDataStore((s) => s.summons[characterId]);
  // 260909: the helper seats ONE companion per world. Name who is already
  // there instead of offering a Launch that the supervisor would refuse.
  const occupantId = useDataStore((s) => {
    for (const st of Object.values(s.summons)) {
      if (st.characterId !== characterId && st.game === 'dontstarve' && (st.kind === 'connecting' || st.kind === 'online')) return st.characterId;
    }
    return null;
  });
  const occupantName = useDataStore((s) => (occupantId ? s.characters.find((c) => c.id === occupantId)?.name ?? null : null));
  const world = useDataStore((s) => s.worlds.dontstarve);
  const pick = useDstStore((s) => s.survivors[characterId]);
  const pickBusy = useDstStore((s) => s.survivorBusy[characterId] ?? false);
  const loadSurvivor = useDstStore((s) => s.loadSurvivor);
  const setSurvivor = useDstStore((s) => s.setSurvivor);
  const setup = useDstSetupSteps(STEP_SKIN);
  const win = useSetupWindow(setup.allDone);

  useEffect(() => {
    void loadSurvivor(characterId);
  }, [characterId, loadSurvivor]);

  const name = character?.name ?? t('Your companion');
  const connecting = summon?.kind === 'connecting';
  const failReason = summon?.kind === 'error' ? (ERROR_COPY[summon.error] ?? ERROR_COPY.BOT_CRASH) : null;
  // `worlds.dontstarve` is typed as the whole WorldState union; narrow on game.
  const dstWorld = world && world.game === 'dontstarve' ? world : null;
  const worldOpen = dstWorld?.kind === 'open';

  const onLaunch = (): void =>
    requestGameLaunch(characterId, { id: 'dontstarve', name: GAME_NAME }, () => void attemptSummon(characterId, 'dontstarve'));

  const showSetUp = setup.known && !setup.complete && win.mode === null;
  const bigDisabled = connecting || !setup.known || (!setup.complete && win.mode !== null);

  return (
    <div className={styles.panel} style={{ backgroundImage: `url(${ART})` }} aria-label={GAME_NAME}>
      <div className={styles.scrim} aria-hidden="true" />
      <div className={styles.content}>
        <h2 className={styles.title}>{GAME_NAME}</h2>
        <GamePackCard game="dontstarve" />
        {win.mode ? (
          <SetupStepper
            key={win.mode}
            steps={setup.steps}
            mode={win.mode}
            onClose={win.close}
            skin={WINDOW_SKIN}
            label={t('{game} setup steps', { game: GAME_NAME })}
          />
        ) : null}

        {occupantId && !connecting && setup.complete ? (
          <p className={styles.nameLine} role="status">
            {t("{other} is already in this world. Don't Starve Together fits one companion at a time, so disconnect {other} first.", {
              other: occupantName ?? t('Another companion'),
            })}
          </p>
        ) : (
          <button type="button" className={`${styles.btn} ${styles.btnBig}`} disabled={bigDisabled} onClick={showSetUp ? win.openSetup : onLaunch}>
            {connecting ? t('Connecting...') : showSetUp ? t('Set up') : t('Launch')}
          </button>
        )}
        {setup.complete ? (
          <p className={styles.nameLine}>{t('{name} will appear as "{ingame}" next to you.', { name, ingame: dstName(character?.name) })}</p>
        ) : null}
        {worldOpen && dstWorld?.kind === 'open' ? (
          <p className={styles.subLine}>{t('Day {day}, {season}, {phase}', { day: dstWorld.day, season: dstWorld.season || '?', phase: dstWorld.phase || '?' })}</p>
        ) : null}
        {failReason ? (
          <p className={styles.failLine} role="alert">{t(failReason)}</p>
        ) : null}
        {setup.complete && win.mode === null ? (
          <button type="button" className={styles.helpLink} onClick={win.openHelp}>
            {t('How do I set up launch?')}
          </button>
        ) : null}

        {/* ── Survivor sheet (any state once the pick has loaded) ── */}
        <section className={styles.sheet} aria-label={t('Survivor')}>
          {pick ? (
            <>
              <div className={styles.survivorRow}>
                <span>
                  {pick.source === 'user'
                    ? t('{name} will play as {survivor}.', { name, survivor: dstSurvivor(pick.prefab).name })
                    : t('{name} wants to play as {survivor}.', { name, survivor: dstSurvivor(pick.prefab).name })}
                </span>
                <label className={styles.survivorRow}>
                  <span className={styles.sub}>{t('Change')}</span>
                  <select
                    className={styles.select}
                    aria-label={t('Survivor')}
                    value={pick.prefab}
                    disabled={pickBusy || connecting}
                    onChange={(e) => void setSurvivor(characterId, e.target.value)}
                  >
                    {DST_SURVIVORS.map((s) => (
                      <option key={s.prefab} value={s.prefab}>{s.name}</option>
                    ))}
                  </select>
                </label>
                {pick.source === 'user' ? (
                  <DstButton kind="quiet" disabled={pickBusy || connecting} onClick={() => void setSurvivor(characterId, null)}>
                    {t('Let {name} choose', { name })}
                  </DstButton>
                ) : null}
              </div>
              {pick.reason ? <p className={styles.survivorReason}>{pick.reason}</p> : null}
              <p className={styles.sub}>{dstSurvivor(pick.prefab).perks}</p>
            </>
          ) : (
            <p className={styles.sub}>{pickBusy ? t('{name} is choosing a survivor...', { name }) : t('Survivor not chosen yet.')}</p>
          )}
        </section>
      </div>
    </div>
  );
}
