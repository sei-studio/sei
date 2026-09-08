/**
 * DstDashboardPanel — the live Don't Starve Together view (game adapters M2,
 * 260908): the shared status strip + controls window (GameControlsWindow,
 * the same store actions McDashboardPanel's controls use), the vitals row
 * (health / hunger / sanity with bars, day + phase, temperature), the
 * inventory list with the held item marked, and a location line (no minimap
 * in v1). Telemetry: gamedash:snapshot pushes into
 * useMcDashboardStore.gameSnapshots, sampled at 1 Hz while this panel is
 * mounted (gameDashboardSetWatching).
 */
import React, { useEffect } from 'react';
import type { DstDashboardSnapshot } from '@shared/dstIpc';
import { dstSurvivor } from '@shared/dstSurvivors';
import { useT } from '../../lib/i18n';
import { sei } from '../../lib/ipcClient';
import { useDataStore } from '../../lib/stores/useDataStore';
import { useMcDashboardStore } from '../../lib/stores/useMcDashboardStore';
import { GameControlsWindow, GameStatusStrip } from '../games/GameControlsWindow';
import styles from './dst.module.css';

export interface DstDashboardPanelProps {
  characterId: string;
}

function Vital({ label, value, max, lowBelow }: { label: string; value: number; max: number; lowBelow: number }): React.ReactElement {
  const pct = max > 0 ? Math.max(0, Math.min(100, Math.round((value / max) * 100))) : 0;
  const low = pct < lowBelow;
  return (
    <div className={styles.vital}>
      <span className={styles.vitalLabel}>{label}</span>
      <span className={styles.vitalValue}>{Math.round(value)} / {Math.round(max)}</span>
      <div className={styles.bar} aria-hidden="true">
        <div className={low ? styles.barFillLow : styles.barFill} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function prefabLabel(p: string): string {
  return p.replace(/_/g, ' ');
}

export function DstDashboardPanel({ characterId }: DstDashboardPanelProps): React.ReactElement {
  const t = useT();
  const raw = useMcDashboardStore((s) => s.gameSnapshots[characterId] ?? null);
  const character = useDataStore((s) => s.characters.find((c) => c.id === characterId));
  const name = character?.name ?? t('Companion');
  const snapshot = raw && raw.game === 'dontstarve' ? (raw as unknown as DstDashboardSnapshot) : null;

  useEffect(() => {
    void sei.gameDashboardSetWatching(characterId, true).catch(() => undefined);
    return () => {
      void sei.gameDashboardSetWatching(characterId, false).catch(() => undefined);
    };
  }, [characterId]);

  return (
    <div className={styles.dash} aria-label={t("{name}'s Don't Starve Together dashboard", { name })}>
      <h2 className={styles.dashHead}>{t("{name} in Don't Starve Together", { name })}</h2>
      <GameStatusStrip characterId={characterId} activity={snapshot?.activity} />
      {snapshot ? (
        <>
          <div className={styles.clockRow}>
            <span><strong>{dstSurvivor(snapshot.prefab).name}</strong></span>
            <span>{t('Day {day}', { day: snapshot.day })}</span>
            <span>{snapshot.season}</span>
            <span>{snapshot.phase}</span>
            <span>{t('{temp} degrees', { temp: snapshot.temperature })}</span>
          </div>
          <div className={styles.vitals}>
            <Vital label={t('Health')} value={snapshot.health} max={snapshot.healthMax} lowBelow={35} />
            <Vital label={t('Hunger')} value={snapshot.hunger} max={snapshot.hungerMax} lowBelow={25} />
            <Vital label={t('Sanity')} value={snapshot.sanity} max={snapshot.sanityMax} lowBelow={30} />
          </div>
          <h3 className={styles.invTitle}>{t('Inventory')}</h3>
          {snapshot.items.length ? (
            <ul className={styles.invList}>
              {snapshot.items.map((it, i) => (
                <li key={`${it.prefab}-${i}`} className={it.prefab === snapshot.held ? `${styles.invItem} ${styles.invHeld}` : styles.invItem}>
                  {prefabLabel(it.prefab)}{it.count > 1 ? ` x${it.count}` : ''}
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.hint}>{t('Nothing carried yet.')}</p>
          )}
          <p className={styles.location}>{t('at {x}, {z}', { x: Math.round(snapshot.x), z: Math.round(snapshot.z) })}</p>
        </>
      ) : (
        <div className={styles.waiting}>{t('Waiting for {name}...', { name })}</div>
      )}
      <GameControlsWindow characterId={characterId} game="dontstarve" />
    </div>
  );
}
