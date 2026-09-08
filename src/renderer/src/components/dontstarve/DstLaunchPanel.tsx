/**
 * DstLaunchPanel — the Don't Starve Together launch surface (game adapters
 * M2, 260908), hosted in the chat game aside like McLaunchPanel. Three
 * states, top to bottom (plan section 4.2):
 *
 *   Set up          the game was found but Sei's helper is not in it yet:
 *                   the "Add Sei's helper" card with progress; or the game
 *                   was not found at all (the paths we looked in + Check again)
 *   Waiting         helper installed, no hosted world answering: "Launch Don't
 *                   Starve Together" (Steam) and the host-a-world hint; the
 *                   pending summon auto-resumes when the heartbeat lands
 *   Launch          world open: the Launch button, the companion's in-game
 *                   name, and the survivor row ("Marv wants to play as
 *                   Wigfrid" with a change control over the eligible roster)
 *
 * The game pack card (the Lua mod download) sits above all three; it renders
 * nothing once the pack is ready.
 */
import React, { useEffect } from 'react';
import { DST_SURVIVORS, dstSurvivor } from '@shared/dstSurvivors';
import { useT } from '../../lib/i18n';
import { ERROR_COPY } from '../../lib/errors';
import { attemptSummon } from '../../lib/summonFlow';
import { requestGameLaunch } from '../../lib/gameLaunch';
import { useDataStore } from '../../lib/stores/useDataStore';
import { Button } from '../Button';
import { GamePackCard } from '../games/GamePackCard';
import { useDstStore } from './useDstStore';
import styles from './dst.module.css';

const GAME_NAME = "Don't Starve Together";

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
  const world = useDataStore((s) => s.worlds.dontstarve);
  const install = useDstStore((s) => s.install);
  const installBusy = useDstStore((s) => s.installBusy);
  const launching = useDstStore((s) => s.launching);
  const refreshInstall = useDstStore((s) => s.refreshInstall);
  const runInstall = useDstStore((s) => s.runInstall);
  const launchGame = useDstStore((s) => s.launchGame);
  const pick = useDstStore((s) => s.survivors[characterId]);
  const pickBusy = useDstStore((s) => s.survivorBusy[characterId] ?? false);
  const loadSurvivor = useDstStore((s) => s.loadSurvivor);
  const setSurvivor = useDstStore((s) => s.setSurvivor);

  useEffect(() => {
    void refreshInstall();
    void loadSurvivor(characterId);
  }, [characterId, refreshInstall, loadSurvivor]);

  const name = character?.name ?? t('Your companion');
  const connecting = summon?.kind === 'connecting';
  const failReason = summon?.kind === 'error' ? (ERROR_COPY[summon.error] ?? ERROR_COPY.BOT_CRASH) : null;
  // `worlds.dontstarve` is typed as the whole WorldState union; narrow on game.
  const dstWorld = world && world.game === 'dontstarve' ? world : null;
  const worldOpen = dstWorld?.kind === 'open';
  const helperReady = install?.kind === 'found' && install.modInstalled;

  const onLaunch = (): void =>
    requestGameLaunch(characterId, { id: 'dontstarve', name: GAME_NAME }, () => void attemptSummon(characterId, 'dontstarve'));

  return (
    <div className={styles.panel} aria-label={GAME_NAME}>
      <h2 className={styles.title}>{GAME_NAME}</h2>
      <GamePackCard game="dontstarve" />

      {/* ── Set up ── */}
      {install == null ? (
        <p className={styles.hint}>{t('Looking for Don\'t Starve Together on this computer...')}</p>
      ) : install.kind === 'not_found' ? (
        <section className={styles.card}>
          <h3 className={styles.cardTitle}>{t("We couldn't find Don't Starve Together")}</h3>
          <p className={styles.cardBody}>{t('Install it through Steam, then check again. We looked in:')}</p>
          {install.searched.slice(0, 4).map((p) => (
            <span key={p} className={styles.mono}>{p}</span>
          ))}
          <div className={styles.actions}>
            <Button kind="primary" size="md" onClick={() => void refreshInstall()}>{t('Check again')}</Button>
          </div>
        </section>
      ) : install.kind === 'installing' ? (
        <section className={styles.card} aria-live="polite">
          <h3 className={styles.cardTitle}>{t("Adding Sei's helper...")}</h3>
          <p className={styles.cardBody}>{install.step === 'enabling' ? t('Enabling the helper in the game') : t('Copying the helper into the game folder')}</p>
        </section>
      ) : install.kind === 'error' ? (
        <section className={styles.card} role="alert">
          <h3 className={styles.cardTitle}>{t("Couldn't add Sei's helper")}</h3>
          <p className={styles.cardBody}>{t(ERROR_COPY.GAME_INSTALL_FAILED)}</p>
          <span className={styles.mono}>{install.message}</span>
          <div className={styles.actions}>
            <Button kind="primary" size="md" disabled={installBusy} onClick={() => void runInstall()}>{t('Try again')}</Button>
          </div>
        </section>
      ) : !install.modInstalled ? (
        <section className={styles.card}>
          <h3 className={styles.cardTitle}>{t("Add Sei's helper to Don't Starve Together")}</h3>
          <p className={styles.cardBody}>
            {t('A small server-side mod lets your companion join the worlds you host. Friends who join need nothing. It stays quiet until Sei asks it to spawn someone.')}
          </p>
          <span className={styles.mono}>{install.installPath}</span>
          <div className={styles.actions}>
            <Button kind="primary" size="md" disabled={installBusy} onClick={() => void runInstall()}>{t("Add Sei's helper")}</Button>
          </div>
        </section>
      ) : null}

      {/* ── Waiting for your world ── */}
      {helperReady && !worldOpen ? (
        <section className={styles.card}>
          <h3 className={styles.cardTitle}>{t('Waiting for your world')}</h3>
          <p className={styles.cardBody}>
            {t('Open the game and host a world. Sei\'s helper is enabled automatically; your companion can join as soon as the world is running.')}
          </p>
          <div className={styles.actions}>
            <Button kind="primary" size="md" disabled={launching} onClick={() => void launchGame()}>
              {launching ? t('Opening Steam...') : t("Launch Don't Starve Together")}
            </Button>
          </div>
        </section>
      ) : null}

      {/* ── Launch ── */}
      {helperReady && worldOpen ? (
        <section className={styles.card}>
          <h3 className={styles.cardTitle}>{t('Your world is open')}</h3>
          <p className={styles.nameLine}>{t('{name} will appear as "{ingame}" next to you.', { name, ingame: dstName(character?.name) })}</p>
          <p className={styles.cardBody}>
            {dstWorld?.kind === 'open' ? t('Day {day}, {season}, {phase}', { day: dstWorld.day, season: dstWorld.season || '?', phase: dstWorld.phase || '?' }) : ''}
          </p>
          <div className={styles.actions}>
            <Button kind="accent" size="lg" disabled={connecting} onClick={onLaunch}>
              {connecting ? t('Connecting...') : t('Launch')}
            </Button>
          </div>
          {failReason ? (
            <p className={styles.failLine} role="alert">{t(failReason)}</p>
          ) : null}
        </section>
      ) : failReason ? (
        <p className={styles.failLine} role="alert">{t(failReason)}</p>
      ) : null}

      {/* ── Survivor row (any state once the pick has loaded) ── */}
      <section className={styles.card} aria-label={t('Survivor')}>
        {pick ? (
          <>
            <div className={styles.survivorRow}>
              <span>
                {pick.source === 'user'
                  ? t('{name} will play as {survivor}.', { name, survivor: dstSurvivor(pick.prefab).name })
                  : t('{name} wants to play as {survivor}.', { name, survivor: dstSurvivor(pick.prefab).name })}
              </span>
              <label className={styles.survivorRow}>
                <span className={styles.hint}>{t('Change')}</span>
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
                <Button kind="quiet" size="sm" disabled={pickBusy || connecting} onClick={() => void setSurvivor(characterId, null)}>
                  {t('Let {name} choose', { name })}
                </Button>
              ) : null}
            </div>
            {pick.reason ? <p className={styles.survivorReason}>{pick.reason}</p> : null}
            <p className={styles.cardBody}>{dstSurvivor(pick.prefab).perks}</p>
          </>
        ) : (
          <p className={styles.hint}>{pickBusy ? t('{name} is choosing a survivor...', { name }) : t('Survivor not chosen yet.')}</p>
        )}
      </section>
    </div>
  );
}
