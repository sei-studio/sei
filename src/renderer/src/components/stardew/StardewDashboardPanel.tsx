/**
 * StardewDashboardPanel (game adapters M1, 260908): the live view of a
 * companion in Stardew Valley, in the same vanilla-gray windows as the
 * Minecraft dashboard (a documented exception to the design tokens), with
 * the status strip and the controls window REUSED from McDashControls (not
 * copied). Vitals row: energy + health bars, the clock, season and weather;
 * a 36-slot inventory grid with text labels; a location line instead of the
 * minimap in v1. Telemetry: useMcDashboardStore.gameSnapshots (the
 * gamedash:snapshot push); the watch flag and the pause/mode controls ride
 * the same game-agnostic supervisor messages Minecraft's do.
 */
import React, { useEffect } from 'react';
import type { StardewDashboardSnapshot } from '@shared/stardewIpc';
import { isStardewDashboardSnapshot } from '@shared/stardewIpc';
import type { McGameMode } from '@shared/ipc';
import { useMcDashboardStore } from '../../lib/stores/useMcDashboardStore';
import { useDataStore } from '../../lib/stores/useDataStore';
import { sei } from '../../lib/ipcClient';
import { useT } from '../../lib/i18n';
import { McDashStatusStrip, McDashControls } from '../mcdash/McDashControls';
import { PercentBar } from '../PercentBar';
import mc from '../mcdash/McDashboardPanel.module.css';
import styles from './StardewDashboardPanel.module.css';

export interface StardewDashboardPanelProps {
  characterId: string;
}

const SLOTS = Array.from({ length: 36 }, (_, i) => i);

function pct(v: number, max: number): number {
  if (!(max > 0)) return 0;
  return Math.max(0, Math.min(100, Math.round((v / max) * 100)));
}

export function StardewDashboardPanel({ characterId }: StardewDashboardPanelProps): React.ReactElement {
  const t = useT();
  const raw = useMcDashboardStore((s) => s.gameSnapshots[characterId] ?? null);
  const controls = useMcDashboardStore((s) => s.controls[characterId]);
  const storeSetPaused = useMcDashboardStore((s) => s.setPaused);
  const storeSetMode = useMcDashboardStore((s) => s.setMode);
  const setWatching = useMcDashboardStore((s) => s.setWatching);
  const character = useDataStore((s) => s.characters.find((c) => c.id === characterId));
  const name = character?.name ?? t('Companion');
  const snapshot: StardewDashboardSnapshot | null = isStardewDashboardSnapshot(raw) ? raw : null;

  // Watch flag + one hydration pull (the push only carries changes after mount).
  useEffect(() => {
    setWatching(characterId, true);
    void sei.gameDashboardGet?.(characterId)
      .then((snap) => {
        if (snap && isStardewDashboardSnapshot(snap)) {
          useMcDashboardStore.setState((s) => ({ gameSnapshots: { ...s.gameSnapshots, [characterId]: snap } }));
        }
      })
      .catch(() => {});
    return () => setWatching(characterId, false);
  }, [characterId, setWatching]);

  const paused = controls?.paused ?? false;
  const mode: McGameMode = controls?.mode ?? 'proactive';

  const disconnect = (): void => {
    useDataStore.getState().setStatus({ kind: 'idle', characterId });
    useMcDashboardStore.getState().setLaunch(characterId, 'stardew');
    void sei.stop(characterId).catch(() => {});
  };

  const bySlot = new Map<number, StardewDashboardSnapshot['items'][number]>();
  for (const it of snapshot?.items ?? []) bySlot.set(it.slot, it);

  return (
    <div className={mc.panel} aria-label={t("{name}'s Stardew Valley dashboard", { name })}>
      <header className={mc.head}>
        <span className={mc.headTitle}>{t('{name} in Stardew Valley', { name })}</span>
      </header>
      {snapshot ? (
        <div className={mc.body}>
          <McDashStatusStrip activity={snapshot.activity} paused={paused} />

          {/* Vitals window: energy + health, the clock, season, weather, gold. */}
          <section className={mc.dialog} aria-label={t('Vitals')}>
            <div className={styles.vitals}>
              <div className={styles.vitalRow}>
                <span className={styles.vitalLabel}>{t('Energy')}</span>
                <span className={styles.vitalBar}>
                  <PercentBar value={pct(snapshot.stamina, snapshot.maxStamina)} size="sm" hideLabel label={t('Energy {value} of {max}', { value: snapshot.stamina, max: snapshot.maxStamina })} />
                </span>
                <span className={styles.vitalValue}>{snapshot.stamina}/{snapshot.maxStamina}</span>
              </div>
              <div className={styles.vitalRow}>
                <span className={styles.vitalLabel}>{t('Health')}</span>
                <span className={styles.vitalBar}>
                  <PercentBar value={pct(snapshot.health, snapshot.maxHealth)} size="sm" hideLabel tone="muted" overLimit={snapshot.health <= snapshot.maxHealth * 0.3} label={t('Health {value} of {max}', { value: snapshot.health, max: snapshot.maxHealth })} />
                </span>
                <span className={styles.vitalValue}>{snapshot.health}/{snapshot.maxHealth}</span>
              </div>
              <div className={styles.meta}>
                <span>{snapshot.timeText}</span>
                <span>{t('{season} {day}, year {year}', { season: snapshot.season, day: snapshot.day, year: snapshot.year })}</span>
                <span>{snapshot.weather}</span>
                <span className={styles.gold}>{snapshot.gold}g</span>
              </div>
            </div>
          </section>

          {/* Inventory window: 36 slots, text labels (no item textures in v1). */}
          <section className={mc.dialog} aria-label={t("{name}'s inventory", { name })}>
            <div className={mc.invTitle}>{t('Inventory')}</div>
            <div className={mc.invGrid}>
              {SLOTS.map((s) => {
                const it = bySlot.get(s);
                const held = !!it && !!snapshot.held && it.name === snapshot.held;
                return (
                  <div key={s} className={held ? `${mc.slot} ${mc.slotHeld}` : mc.slot} title={it ? `${it.name} x${it.count}` : undefined}>
                    {it ? (
                      <>
                        <span className={mc.slotLabel}>{it.name}</span>
                        {it.count > 1 ? <span className={mc.slotCount}>{it.count}</span> : null}
                      </>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </section>

          {/* Location window (the Minecraft minimap's slot; text only in v1). */}
          <section className={mc.dialog} aria-label={t('Location')}>
            <div className={mc.posLine}>
              {snapshot.location} {snapshot.x} {snapshot.y}
              {snapshot.sleeping ? <span className={mc.dim}> {t('resting')}</span> : null}
            </div>
          </section>

          <McDashControls
            paused={paused}
            mode={mode}
            onPause={(next) => storeSetPaused(characterId, next)}
            onMode={(next) => storeSetMode(characterId, next)}
            onDisconnect={disconnect}
            gameName="Stardew Valley"
          />
        </div>
      ) : (
        <div className={mc.waiting}>{t('Waiting for {name}...', { name })}</div>
      )}
    </div>
  );
}
