/**
 * DstLaunchPanel — the Don't Starve Together launch surface (game adapters
 * M2, 260908), hosted in the chat game aside like McLaunchPanel. What the
 * player sees after picking the tile, top to bottom:
 *
 *   Pack            the game pack card (the Lua mod download); renders
 *                   nothing once the pack is ready
 *   Steps           DstSteps (260909): the numbered list of what still has
 *                   to happen (game found, helper added, game open, world
 *                   hosted), each with its one button; a pending summon
 *                   auto-resumes when the heartbeat lands
 *   Launch          world open: the Launch button + the companion's in-game
 *                   name
 *   Survivor        "Marv wants to play as Wigfrid" with a change control
 *                   over the eligible roster
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
import { DstSteps, DST_GAME_NAME as GAME_NAME } from './DstSteps';
import styles from './dst.module.css';

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
  const pick = useDstStore((s) => s.survivors[characterId]);
  const pickBusy = useDstStore((s) => s.survivorBusy[characterId] ?? false);
  const loadSurvivor = useDstStore((s) => s.loadSurvivor);
  const setSurvivor = useDstStore((s) => s.setSurvivor);

  useEffect(() => {
    void loadSurvivor(characterId);
  }, [characterId, loadSurvivor]);

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

      {/* ── Steps (everything the player still has to do) ── */}
      <section className={styles.card} aria-label={t('Setup')}>
        <DstSteps />
      </section>

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
