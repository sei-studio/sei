/**
 * DstDashboardPanel — the live Don't Starve Together view, in the game's
 * own register (redesigned 260909; the first cut was a tokens-only list).
 * A DELIBERATE, CONTAINED EXCEPTION to the design tokens, exactly like the
 * Minecraft panel: ink-black ground, aged-parchment windows with burnt
 * edges, hand-inked type (Fredericka the Great for figures, Metamorphous
 * for labels), and the HUD's own instruments:
 *
 *   - the three vitals as the HUD BADGES: a dark ring, a parchment face,
 *     the meter as coloured liquid rising from the bottom, the organ icon
 *     on top (heart / stomach / brain), pulsing when low;
 *   - the CLOCK: sixteen segments split day / dusk / night per season, the
 *     current phase lit, "Day N" in the middle; season and body temperature
 *     beside it, with the freezing / overheating warning the game gives;
 *   - the INVENTORY BAR: dark slots in rows of fifteen (a backpack adds a
 *     row), the equipped hand item in its own slot at the end;
 *   - the status strip and the controls window in parchment, driven by the
 *     shared useGameControls hook (same store actions as Minecraft's).
 *
 * Telemetry: gamedash:snapshot -> useMcDashboardStore.gameSnapshots,
 * sampled at 1 Hz while this panel is mounted (gameDashboardSetWatching).
 * Scope stays inside this file and DstDashboardPanel.module.css.
 */
import React, { useEffect } from 'react';
import type { DstDashboardSnapshot } from '@shared/dstIpc';
import { dstSurvivor } from '@shared/dstSurvivors';
import { useT } from '../../lib/i18n';
import { sei } from '../../lib/ipcClient';
import { useDataStore } from '../../lib/stores/useDataStore';
import { useMcDashboardStore } from '../../lib/stores/useMcDashboardStore';
import { useGameControls, GAME_CONTROL_DESCRIPTIONS } from '../games/useGameControls';
import { clockSegments, dstItemLabel, meterPct, normalizePhase, normalizeSeason, slotCount, tempBand } from './dstDashboard';
import type { DstPhase, DstSeason } from './dstDashboard';
import styles from './DstDashboardPanel.module.css';

export interface DstDashboardPanelProps {
  characterId: string;
}

const GAME_NAME = "Don't Starve Together";

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/* ── The organ icons, drawn once in ink on a 64x64 badge ─────────────── */

function HeartIcon(): React.ReactElement {
  return (
    <path
      className={styles.organ}
      d="M32 45 L19 32 C14 27 15 19 21 18 C25 17 29 20 32 25 C35 20 39 17 43 18 C49 19 50 27 45 32 Z"
    />
  );
}

function StomachIcon(): React.ReactElement {
  return (
    <g className={styles.organ}>
      <path d="M27 18 C21 18 18 23 19 28 C20 33 25 35 29 37 C33 39 34 43 38 45 C43 47 47 43 46 38 C45 32 39 31 36 28 C33 25 34 18 27 18 Z" />
      <path className={styles.organLine} d="M24 24 C26 27 29 28 32 30" />
    </g>
  );
}

function BrainIcon(): React.ReactElement {
  return (
    <g className={styles.organ}>
      <path d="M32 19 C25 19 20 24 20 30 C20 33 21 35 23 37 C24 41 27 44 32 44 C37 44 40 41 41 37 C43 35 44 33 44 30 C44 24 39 19 32 19 Z" />
      <path className={styles.organLine} d="M32 20 V43 M24 29 C26 27 29 28 30 30 M34 26 C36 24 39 25 40 27 M25 36 C27 34 30 35 31 37 M34 38 C36 36 39 37 40 39" />
    </g>
  );
}

/* ── One HUD badge: ring, parchment face, liquid meter, icon ─────────── */

type VitalKind = 'health' | 'hunger' | 'sanity';

function Badge({ kind, label, value, max, lowBelow }: { kind: VitalKind; label: string; value: number; max: number; lowBelow: number }): React.ReactElement {
  const p = meterPct(value, max);
  const low = p < lowBelow;
  const clipId = `dst-badge-${kind}`;
  // The face is a circle of radius 25 centred at 32: the liquid is a rect
  // clipped to it, its top edge at (57 - 50 * pct).
  const top = 57 - (50 * p) / 100;
  return (
    <div className={low ? `${styles.badge} ${styles.badgeLow}` : styles.badge} data-vital={kind}>
      <svg
        viewBox="0 0 64 64"
        className={styles.badgeSvg}
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={Math.round(max)}
        aria-valuenow={Math.round(value)}
      >
        <defs>
          <clipPath id={clipId}>
            <circle cx="32" cy="32" r="25" />
          </clipPath>
        </defs>
        <circle className={styles.badgeRing} cx="32" cy="32" r="30" />
        <circle className={styles.badgeFace} cx="32" cy="32" r="25" />
        <rect className={styles.badgeLiquid} x="4" y={top} width="56" height="60" clipPath={`url(#${clipId})`} />
        <circle className={styles.badgeRim} cx="32" cy="32" r="25" />
        {kind === 'health' ? <HeartIcon /> : kind === 'hunger' ? <StomachIcon /> : <BrainIcon />}
      </svg>
      <span className={styles.badgeValue}>{Math.round(value)}</span>
      <span className={styles.badgeLabel}>{label}</span>
    </div>
  );
}

/* ── The clock: 16 segments, the live phase lit, the day in the middle ── */

function Clock({ season, phase, day, dayLabel }: { season: DstSeason; phase: DstPhase; day: number; dayLabel: string }): React.ReactElement {
  const segs = clockSegments(season);
  const step = (Math.PI * 2) / segs.length;
  const r0 = 22;
  const r1 = 38;
  const cx = 40;
  const cy = 40;
  const wedges = segs.map((p, i) => {
    // Clockwise from the top, a hairline gap between segments.
    const a0 = -Math.PI / 2 + i * step + 0.03;
    const a1 = -Math.PI / 2 + (i + 1) * step - 0.03;
    const x0 = cx + r1 * Math.cos(a0);
    const y0 = cy + r1 * Math.sin(a0);
    const x1 = cx + r1 * Math.cos(a1);
    const y1 = cy + r1 * Math.sin(a1);
    const x2 = cx + r0 * Math.cos(a1);
    const y2 = cy + r0 * Math.sin(a1);
    const x3 = cx + r0 * Math.cos(a0);
    const y3 = cy + r0 * Math.sin(a0);
    const d = `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r1} ${r1} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)} L${x2.toFixed(2)} ${y2.toFixed(2)} A${r0} ${r0} 0 0 0 ${x3.toFixed(2)} ${y3.toFixed(2)} Z`;
    const cls = p === phase ? `${styles.seg} ${styles.segLit}` : styles.seg;
    return <path key={i} className={cls} data-phase={p} d={d} />;
  });
  return (
    <svg viewBox="0 0 80 80" className={styles.clockSvg} aria-hidden="true">
      <circle className={styles.clockRing} cx={cx} cy={cy} r={39.5} />
      {wedges}
      <circle className={styles.clockCenter} cx={cx} cy={cy} r={r0 - 1} />
      <text className={styles.clockDayWord} x={cx} y={cy - 3} textAnchor="middle">{dayLabel}</text>
      <text className={styles.clockDayNum} x={cx} y={cy + 13} textAnchor="middle">{day}</text>
    </svg>
  );
}

function Thermometer(): React.ReactElement {
  return (
    <svg viewBox="0 0 16 28" className={styles.thermo} aria-hidden="true">
      <rect className={styles.thermoTube} x="5" y="2" width="6" height="18" rx="3" />
      <circle className={styles.thermoBulb} cx="8" cy="22" r="5" />
      <rect className={styles.thermoMercury} x="7" y="8" width="2" height="12" />
    </svg>
  );
}

export function DstDashboardPanel({ characterId }: DstDashboardPanelProps): React.ReactElement {
  const t = useT();
  const raw = useMcDashboardStore((s) => s.gameSnapshots[characterId] ?? null);
  const character = useDataStore((s) => s.characters.find((c) => c.id === characterId));
  const name = character?.name ?? t('Companion');
  const snapshot = raw && raw.game === 'dontstarve' ? (raw as unknown as DstDashboardSnapshot) : null;
  const controls = useGameControls(characterId, 'dontstarve');

  useEffect(() => {
    void sei.gameDashboardSetWatching(characterId, true).catch(() => undefined);
    return () => {
      void sei.gameDashboardSetWatching(characterId, false).catch(() => undefined);
    };
  }, [characterId]);

  const season = normalizeSeason(snapshot?.season);
  const phase = normalizePhase(snapshot?.phase);
  const band = tempBand(snapshot?.temperature ?? 20);
  const seasonLabel: Record<DstSeason, string> = { autumn: t('Autumn'), winter: t('Winter'), spring: t('Spring'), summer: t('Summer') };
  const phaseLabel: Record<DstPhase, string> = { day: t('Daytime'), dusk: t('Dusk'), night: t('Night') };
  const bandLabel = band === 'freezing' ? t('Freezing') : band === 'cold' ? t('Cold') : band === 'overheating' ? t('Overheating') : band === 'hot' ? t('Hot') : null;

  const items = snapshot?.items ?? [];
  const slots = slotCount(items.length);

  return (
    <div className={styles.panel} data-season={season} data-phase={phase} aria-label={t("{name}'s Don't Starve Together dashboard", { name })}>
      <header className={styles.head}>
        <span className={styles.headTitle}>{t('{name} in Don\'t Starve Together', { name })}</span>
        {snapshot ? <span className={styles.headSurvivor}>{dstSurvivor(snapshot.prefab).name}</span> : null}
      </header>

      {snapshot ? (
        <div className={styles.body}>
          {/* Status strip: what the AI is doing right now. */}
          <section className={`${styles.paper} ${styles.status}`} aria-label={t('Status')}>
            <span className={styles.label}>{t('Status')}</span>
            <span className={styles.statusText} aria-live="polite">
              {controls.paused ? t('Paused') : sentenceCase(snapshot.activity || 'idling')}
            </span>
          </section>

          {/* Vitals: the three HUD badges. */}
          <section className={`${styles.paper} ${styles.vitals}`} aria-label={t('Vitals')}>
            <Badge kind="health" label={t('Health')} value={snapshot.health} max={snapshot.healthMax} lowBelow={35} />
            <Badge kind="hunger" label={t('Hunger')} value={snapshot.hunger} max={snapshot.hungerMax} lowBelow={25} />
            <Badge kind="sanity" label={t('Sanity')} value={snapshot.sanity} max={snapshot.sanityMax} lowBelow={30} />
          </section>

          {/* Clock + season + temperature. */}
          <section className={`${styles.paper} ${styles.clock}`} aria-label={t('Clock')}>
            <Clock season={season} phase={phase} day={snapshot.day} dayLabel={t('Day')} />
            <div className={styles.clockText}>
              <span className={styles.clockPhase}>{phaseLabel[phase]}</span>
              <span className={styles.clockSeason} data-season={season}>{seasonLabel[season]}</span>
              <span className={band === 'fine' ? styles.temp : `${styles.temp} ${styles.tempWarn}`} data-band={band}>
                <Thermometer />
                <span className={styles.tempValue}>{t('{temp} degrees', { temp: snapshot.temperature })}</span>
                {bandLabel ? <span className={styles.tempBand}>{bandLabel}</span> : null}
              </span>
            </div>
          </section>

          {/* Controls window. */}
          <section className={`${styles.paper} ${styles.controls}`} aria-label={t('Companion controls')}>
            <button
              type="button"
              className={controls.paused ? `${styles.btn} ${styles.btnOn}` : styles.btn}
              aria-pressed={controls.paused}
              onClick={() => controls.setPaused(!controls.paused)}
              {...controls.hintHandlers('pause')}
            >
              {controls.paused ? t('Resume') : t('Pause')}
            </button>
            <span className={styles.label}>{t('Mode')}</span>
            <div className={styles.modeRow}>
              <button
                type="button"
                className={controls.mode === 'reactive' ? `${styles.btn} ${styles.btnOn}` : styles.btn}
                aria-pressed={controls.mode === 'reactive'}
                onClick={() => controls.setMode('reactive')}
                {...controls.hintHandlers('reactive')}
              >
                {t('Reactive')}
              </button>
              <button
                type="button"
                className={controls.mode === 'proactive' ? `${styles.btn} ${styles.btnOn}` : styles.btn}
                aria-pressed={controls.mode === 'proactive'}
                onClick={() => controls.setMode('proactive')}
                {...controls.hintHandlers('proactive')}
              >
                {t('Proactive')}
              </button>
            </div>
            <div className={styles.hint} aria-live="polite">
              {controls.hint ? t(GAME_CONTROL_DESCRIPTIONS[controls.hint], { game: GAME_NAME }) : ''}
            </div>
            <button type="button" className={`${styles.btn} ${styles.btnLeave}`} onClick={controls.disconnect} {...controls.hintHandlers('disconnect')}>
              {t('Disconnect')}
            </button>
          </section>

          {/* Inventory bar: fifteen dark slots per row, the hand slot at the end. */}
          <section className={styles.invBar} aria-label={t("{name}'s inventory", { name })}>
            <div className={styles.invSlots}>
              {Array.from({ length: slots }, (_, i) => {
                const it = items[i];
                return (
                  <div key={i} className={styles.slot} data-slot="bar" title={it ? `${dstItemLabel(it.prefab)} x${it.count}` : undefined}>
                    {it ? (
                      <>
                        <span className={styles.slotLabel}>{dstItemLabel(it.prefab)}</span>
                        {it.count > 1 ? <span className={styles.slotCount}>{it.count}</span> : null}
                      </>
                    ) : null}
                  </div>
                );
              })}
            </div>
            <div className={styles.handWrap}>
              <div className={snapshot.held ? `${styles.slot} ${styles.slotHeld}` : styles.slot} data-slot="hand" title={snapshot.held ? dstItemLabel(snapshot.held) : undefined}>
                {snapshot.held ? <span className={styles.slotLabel}>{dstItemLabel(snapshot.held)}</span> : null}
              </div>
              <span className={styles.handLabel}>{t('Hand')}</span>
            </div>
          </section>

          <p className={styles.location}>{t('at {x}, {z}', { x: Math.round(snapshot.x), z: Math.round(snapshot.z) })}</p>
        </div>
      ) : (
        <div className={styles.waiting}>{t('Waiting for {name}...', { name })}</div>
      )}
    </div>
  );
}
