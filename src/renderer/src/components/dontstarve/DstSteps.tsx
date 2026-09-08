/**
 * DstSteps — the numbered setup steps for Don't Starve Together (260909),
 * shown wherever the player lands after picking the tile: the launch panel
 * in the chat aside and the setup modal a pending summon opens. One
 * component so the two surfaces can never disagree about what is missing.
 *
 * Mirrors McSetupModal's "open to LAN" list: every step the player has to
 * take themselves is written down, in order, and each one carries the ONE
 * button that does it. Steps that Sei does on its own (finding the game,
 * copying the helper) show as done the moment they are. The list is what
 * replaced a settings-page port row and a mod option that had to agree
 * (260909): discovery now probes a fixed port list, so the only things left
 * for the player are the three the game itself insists on: the helper has
 * to be in the game before it starts, the game has to be open, and a world
 * has to be hosted.
 *
 * While the world is not open it polls install detection every few seconds
 * so a game quit, relaunch or a Steam verify moves the list without a click.
 */
import React, { useEffect } from 'react';
import { DST_DISCOVERY_PORTS } from '@shared/dstIpc';
import { useT } from '../../lib/i18n';
import { Button } from '../Button';
import { useDataStore } from '../../lib/stores/useDataStore';
import { useDstStore } from './useDstStore';
import styles from './dst.module.css';

const POLL_MS = 3000;
export const DST_GAME_NAME = "Don't Starve Together";

type Tone = 'done' | 'now' | 'later';

function Step({ index, tone, children }: { index: number; tone: Tone; children: React.ReactNode }): React.ReactElement {
  const cls = tone === 'done' ? styles.stepDone : tone === 'now' ? styles.stepNow : styles.stepLater;
  return (
    <li className={`${styles.step} ${cls}`} aria-current={tone === 'now' ? 'step' : undefined}>
      <span className={styles.stepNumber} aria-hidden="true">
        {tone === 'done' ? '✓' : String(index).padStart(2, '0')}
      </span>
      <div className={styles.stepBody}>{children}</div>
    </li>
  );
}

function Searching({ label }: { label: string }): React.ReactElement {
  return (
    <div className={styles.searching}>
      <span className={styles.searchDots} aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      {label}
    </div>
  );
}

export function DstSteps(): React.ReactElement {
  const t = useT();
  const install = useDstStore((s) => s.install);
  const installBusy = useDstStore((s) => s.installBusy);
  const launching = useDstStore((s) => s.launching);
  const refreshInstall = useDstStore((s) => s.refreshInstall);
  const runInstall = useDstStore((s) => s.runInstall);
  const launchGame = useDstStore((s) => s.launchGame);
  const world = useDataStore((s) => s.worlds.dontstarve);
  const dstWorld = world && world.game === 'dontstarve' ? world : null;
  const worldOpen = dstWorld?.kind === 'open';

  useEffect(() => {
    void refreshInstall();
    if (worldOpen) return;
    const id = setInterval(() => void refreshInstall(), POLL_MS);
    return () => clearInterval(id);
  }, [refreshInstall, worldOpen]);

  const found = install?.kind === 'found' ? install : null;
  const helperReady = found != null && found.modInstalled && found.enabled;
  // A live heartbeat proves every earlier step whatever detection last said.
  const gameRunning = worldOpen || (found?.gameRunning ?? false);
  const needsRestart = !worldOpen && (found?.needsRestart ?? false);
  const gameReady = gameRunning && !needsRestart;

  const gameTone: Tone = install == null ? 'now' : install.kind === 'not_found' ? 'now' : 'done';
  const helperTone: Tone = install == null || install.kind === 'not_found' ? 'later' : helperReady ? 'done' : 'now';
  const runTone: Tone = !helperReady ? 'later' : gameReady ? 'done' : 'now';
  const hostTone: Tone = !gameReady ? 'later' : worldOpen ? 'done' : 'now';

  return (
    <ol className={styles.steps} aria-label={t('{game} setup steps', { game: DST_GAME_NAME })}>
      <Step index={1} tone={gameTone}>
        {install == null ? (
          <span>{t('Looking for Don\'t Starve Together on this computer...')}</span>
        ) : install.kind === 'not_found' ? (
          <>
            <span>{t("Install Don't Starve Together through Steam, then check again. We looked in:")}</span>
            {install.searched.slice(0, 3).map((p) => (
              <span key={p} className={styles.mono}>{p}</span>
            ))}
            <div className={styles.actions}>
              <Button kind="primary" size="sm" onClick={() => void refreshInstall()}>{t('Check again')}</Button>
            </div>
          </>
        ) : (
          <span>{t("Don't Starve Together is installed.")}</span>
        )}
      </Step>

      <Step index={2} tone={helperTone}>
        {install?.kind === 'installing' ? (
          <span aria-live="polite">{install.step === 'enabling' ? t('Enabling the helper in the game') : t('Copying the helper into the game folder')}</span>
        ) : install?.kind === 'error' ? (
          <>
            <span role="alert">{t("Couldn't add Sei's helper.")}</span>
            <span className={styles.mono}>{install.message}</span>
            <div className={styles.actions}>
              <Button kind="primary" size="sm" disabled={installBusy} onClick={() => void runInstall()}>{t('Try again')}</Button>
            </div>
          </>
        ) : helperReady ? (
          <span>{t("Sei's helper is in the game (v{version}).", { version: found?.modVersion ?? '?' })}</span>
        ) : (
          <>
            <span>
              {t("Add Sei's helper. It is a small server-side mod that lets your companion join the worlds you host. Friends who join need nothing.")}
            </span>
            <div className={styles.actions}>
              <Button kind="primary" size="sm" disabled={installBusy || found == null} onClick={() => void runInstall()}>
                {t("Add Sei's helper")}
              </Button>
            </div>
          </>
        )}
      </Step>

      <Step index={3} tone={runTone}>
        {gameReady ? (
          <span>{t("Don't Starve Together is running.")}</span>
        ) : needsRestart ? (
          <>
            <span>{t('Quit Don\'t Starve Together and open it again. The helper loads when the game starts.')}</span>
            <Searching label={t('Waiting for the game to close...')} />
          </>
        ) : (
          <>
            <span>{t("Open Don't Starve Together.")}</span>
            <div className={styles.actions}>
              <Button kind="primary" size="sm" disabled={launching || !helperReady} onClick={() => void launchGame()}>
                {launching ? t('Opening Steam...') : t("Launch Don't Starve Together")}
              </Button>
            </div>
          </>
        )}
      </Step>

      <Step index={4} tone={hostTone}>
        {worldOpen ? (
          <span>
            {t('Your world is open: {world}, day {day}.', { world: dstWorld.worldName || t('Your world'), day: dstWorld.day })}
          </span>
        ) : dstWorld?.kind === 'unavailable' ? (
          <span role="alert">
            {t("Sei couldn't open a local port for Don't Starve Together (ports {first} to {last} are all in use). Close whatever is using them, then try again.", {
              first: DST_DISCOVERY_PORTS[0],
              last: DST_DISCOVERY_PORTS[DST_DISCOVERY_PORTS.length - 1],
            })}
          </span>
        ) : (
          <>
            <span>{t('Host a world: in the game choose Play, then Host, pick a world (new or saved, caves on or off) and start it. Sei\'s helper is on automatically.')}</span>
            {gameReady ? <Searching label={t('Waiting for your world...')} /> : null}
          </>
        )}
      </Step>
    </ol>
  );
}
