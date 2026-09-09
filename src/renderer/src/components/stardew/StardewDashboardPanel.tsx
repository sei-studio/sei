/**
 * StardewDashboardPanel — the live Stardew Valley view, in the game's own
 * register (redesigned 260909; the first cut borrowed the Minecraft panel's
 * vanilla-gray windows). A DELIBERATE, CONTAINED EXCEPTION to the design
 * tokens, the same contract as the Minecraft panel: the game's wooden menu
 * frames (dark outline, golden wood band, light highlight, cream face),
 * dark plum text with the tan drop shadow, rounded pixel type (Pixelify
 * Sans), and the HUD's own instruments:
 *
 *   - ENERGY and HEALTH as the vertical bars from the bottom-right of the
 *     screen: a black track in a wooden frame, the fill rising from the
 *     bottom, green turning yellow then red as it empties;
 *   - the DATE BOX from the top-right: weekday and day, the weather and
 *     season icons, the day dial with the sun crossing it, the time, and
 *     the gold count in its own little box underneath;
 *   - the INVENTORY as the game's 12 x 3 grid of cream slots, the held item
 *     framed in red like the toolbar's selection;
 *   - the status strip and the controls window as more of the same frames,
 *     driven by the shared useGameControls hook (same store actions as
 *     Minecraft's).
 *
 * Telemetry: useMcDashboardStore.gameSnapshots (the gamedash:snapshot push),
 * sampled at 1 Hz while watched. Scope stays inside this file and
 * StardewDashboardPanel.module.css.
 */
import React, { useEffect } from 'react';
import type { StardewDashboardSnapshot } from '@shared/stardewIpc';
import { isStardewDashboardSnapshot } from '@shared/stardewIpc';
import { useMcDashboardStore } from '../../lib/stores/useMcDashboardStore';
import { useDataStore } from '../../lib/stores/useDataStore';
import { sei } from '../../lib/ipcClient';
import { useT } from '../../lib/i18n';
import { useGameControls, GAME_CONTROL_DESCRIPTIONS } from '../games/useGameControls';
import {
  STARDEW_COLUMNS,
  STARDEW_SLOTS,
  SEASON_LABEL,
  WEATHER_LABEL,
  barTone,
  dayProgress,
  formatGold,
  hudTime,
  isEvening,
  normalizeSeason,
  normalizeWeather,
  pct,
  stardewWeekday,
} from './stardewDashboard';
import type { StardewSeason, StardewWeather } from './stardewDashboard';
import styles from './StardewDashboardPanel.module.css';

export interface StardewDashboardPanelProps {
  characterId: string;
}

const GAME_NAME = 'Stardew Valley';
const SLOTS = Array.from({ length: STARDEW_SLOTS }, (_, i) => i);

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/* ── A wooden menu frame around a cream face. ── */
function Frame({ className, label, children }: { className?: string; label?: string; children: React.ReactNode }): React.ReactElement {
  return (
    <section className={className ? `${styles.frame} ${className}` : styles.frame} aria-label={label}>
      <div className={styles.face}>{children}</div>
    </section>
  );
}

/* ── Icons, drawn as small crisp SVGs (no game textures in the repo). ── */

function WeatherIcon({ weather }: { weather: StardewWeather }): React.ReactElement {
  if (weather === 'rain' || weather === 'storm') {
    return (
      <svg viewBox="0 0 24 24" className={styles.icon} aria-hidden="true">
        <path d="M7 14 A4.5 4.5 0 0 1 7.6 5.2 A6 6 0 0 1 18.5 7.5 A3.5 3.5 0 0 1 18 14 Z" fill="#c9d3dd" stroke="#4d5a68" strokeWidth="1.2" />
        {weather === 'storm' ? (
          <path d="M12.5 13 L9.5 19 H12 L11 23 L15 16.5 H12.5 Z" fill="#f3d13c" stroke="#8a6a00" strokeWidth="0.8" />
        ) : (
          <g stroke="#3d7ec2" strokeWidth="1.6" strokeLinecap="round">
            <path d="M8 17 L7 21 M12 17 L11 21 M16 17 L15 21" />
          </g>
        )}
      </svg>
    );
  }
  if (weather === 'snow') {
    return (
      <svg viewBox="0 0 24 24" className={styles.icon} aria-hidden="true">
        <g stroke="#6fa8d8" strokeWidth="1.6" strokeLinecap="round">
          <path d="M12 3 V21 M4.2 7.5 L19.8 16.5 M4.2 16.5 L19.8 7.5" />
          <path d="M12 3 L10 5 M12 3 L14 5 M12 21 L10 19 M12 21 L14 19" />
        </g>
      </svg>
    );
  }
  if (weather === 'windy') {
    return (
      <svg viewBox="0 0 24 24" className={styles.icon} aria-hidden="true">
        <g fill="none" stroke="#6b8a3a" strokeWidth="1.8" strokeLinecap="round">
          <path d="M3 9 H14 A2.5 2.5 0 1 0 11.5 6.5" />
          <path d="M3 14 H18 A2.5 2.5 0 1 1 15.5 16.5" />
          <path d="M5 19 H11" />
        </g>
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" className={styles.icon} aria-hidden="true">
      <circle cx="12" cy="12" r="5" fill="#f5c542" stroke="#b7791a" strokeWidth="1.2" />
      <g stroke="#e0a520" strokeWidth="1.6" strokeLinecap="round">
        <path d="M12 2 V4.5 M12 19.5 V22 M2 12 H4.5 M19.5 12 H22 M4.9 4.9 L6.7 6.7 M17.3 17.3 L19.1 19.1 M4.9 19.1 L6.7 17.3 M17.3 6.7 L19.1 4.9" />
      </g>
    </svg>
  );
}

function SeasonIcon({ season }: { season: StardewSeason }): React.ReactElement {
  if (season === 'summer') {
    return (
      <svg viewBox="0 0 24 24" className={styles.icon} aria-hidden="true">
        <circle cx="12" cy="13" r="6" fill="#f2a53a" stroke="#a85f12" strokeWidth="1.2" />
        <path d="M6 20 Q12 15 18 20" fill="none" stroke="#3d8fd1" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }
  if (season === 'fall') {
    return (
      <svg viewBox="0 0 24 24" className={styles.icon} aria-hidden="true">
        <path d="M12 3 C7 6 5 11 6 17 L12 15 L18 17 C19 11 17 6 12 3 Z" fill="#d9772b" stroke="#7a3b0c" strokeWidth="1.2" />
        <path d="M12 6 V21" stroke="#7a3b0c" strokeWidth="1.2" />
      </svg>
    );
  }
  if (season === 'winter') {
    return (
      <svg viewBox="0 0 24 24" className={styles.icon} aria-hidden="true">
        <g stroke="#7fb5e6" strokeWidth="1.6" strokeLinecap="round">
          <path d="M12 3 V21 M4.2 7.5 L19.8 16.5 M4.2 16.5 L19.8 7.5" />
        </g>
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" className={styles.icon} aria-hidden="true">
      <path d="M12 21 V11" stroke="#4f8a2b" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M12 12 C12 8 9 6 5 6 C5 10 8 12 12 12 Z" fill="#6ec24a" stroke="#3f7a22" strokeWidth="1.2" />
      <path d="M12 14 C12 10 15 8 19 8 C19 12 16 14 12 14 Z" fill="#6ec24a" stroke="#3f7a22" strokeWidth="1.2" />
    </svg>
  );
}

function CoinIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 16 16" className={styles.coin} aria-hidden="true">
      <circle cx="8" cy="8" r="6.5" fill="#f2c230" stroke="#9a6a08" strokeWidth="1.2" />
      <circle cx="8" cy="8" r="3.5" fill="none" stroke="#c99a12" strokeWidth="1.2" />
    </svg>
  );
}

/* ── The day dial: a semicircle the sun (then the moon) crosses. ── */
function DayDial({ time }: { time: number }): React.ReactElement {
  const p = dayProgress(time);
  const a = Math.PI * (1 - p);
  const cx = 30;
  const cy = 26;
  const r = 20;
  const x = cx + r * Math.cos(a);
  const y = cy - r * Math.sin(a);
  const evening = isEvening(time);
  return (
    <svg viewBox="0 0 60 30" className={styles.dial} aria-hidden="true">
      <path d={`M${cx - r} ${cy} A${r} ${r} 0 0 1 ${cx + r} ${cy}`} fill="none" stroke="#a86a2a" strokeWidth="2" strokeDasharray="2 3" />
      <circle cx={x} cy={y} r="4" fill={evening ? '#dfe6f0' : '#f5c542'} stroke={evening ? '#5c6b80' : '#b7791a'} strokeWidth="1.2" />
    </svg>
  );
}

/* ── A vertical bar in a wooden frame. ── */
function VBar({ kind, label, value, max, caption }: { kind: 'energy' | 'health'; label: string; value: number; max: number; caption: string }): React.ReactElement {
  const p = pct(value, max);
  const tone = barTone(p);
  return (
    <div className={styles.vbar} data-kind={kind} data-tone={tone}>
      <span className={styles.vbarTag} aria-hidden="true">{label}</span>
      <div className={styles.vbarFrame}>
        <div className={styles.vbarTrack} role="meter" aria-label={caption} aria-valuemin={0} aria-valuemax={Math.round(max)} aria-valuenow={Math.round(value)}>
          <div className={styles.vbarFill} style={{ height: `${p}%` }} />
        </div>
      </div>
      <span className={styles.vbarValue}>{Math.round(value)}</span>
    </div>
  );
}

export function StardewDashboardPanel({ characterId }: StardewDashboardPanelProps): React.ReactElement {
  const t = useT();
  const raw = useMcDashboardStore((s) => s.gameSnapshots[characterId] ?? null);
  const setWatching = useMcDashboardStore((s) => s.setWatching);
  const character = useDataStore((s) => s.characters.find((c) => c.id === characterId));
  const name = character?.name ?? t('Companion');
  const snapshot: StardewDashboardSnapshot | null = isStardewDashboardSnapshot(raw) ? raw : null;
  const controls = useGameControls(characterId, 'stardew');

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

  const bySlot = new Map<number, StardewDashboardSnapshot['items'][number]>();
  for (const it of snapshot?.items ?? []) bySlot.set(it.slot, it);

  const season = normalizeSeason(snapshot?.season);
  const weather = normalizeWeather(snapshot?.weather);

  return (
    <div className={styles.panel} data-season={season} aria-label={t("{name}'s Stardew Valley dashboard", { name })}>
      <header className={styles.head}>
        <span className={styles.headTitle}>{t('{name} in Stardew Valley', { name })}</span>
      </header>

      {snapshot ? (
        <div className={styles.body}>
          {/* Status strip: what the AI is doing right now. */}
          <Frame className={styles.status} label={t('Status')}>
            <span className={styles.label}>{t('Status')}</span>
            <span className={styles.statusText} aria-live="polite">
              {controls.paused ? t('Paused') : sentenceCase(snapshot.activity || 'idling')}
            </span>
          </Frame>

          {/* Vitals: the two HUD bars. */}
          <section className={styles.bars} aria-label={t('Vitals')}>
            <VBar kind="energy" label="E" value={snapshot.stamina} max={snapshot.maxStamina} caption={t('Energy {value} of {max}', { value: snapshot.stamina, max: snapshot.maxStamina })} />
            <VBar kind="health" label="H" value={snapshot.health} max={snapshot.maxHealth} caption={t('Health {value} of {max}', { value: snapshot.health, max: snapshot.maxHealth })} />
          </section>

          {/* Date box + the gold box under it. */}
          <div className={styles.dateStack}>
            <Frame className={styles.date} label={t('Clock')}>
              <div className={styles.dateRow}>
                <span className={styles.dateDay}>{t(stardewWeekday(snapshot.day))} {snapshot.day}</span>
                <span className={styles.dateIcons} title={t(WEATHER_LABEL[weather])}>
                  <WeatherIcon weather={weather} />
                  <span className={styles.srOnly}>{t(WEATHER_LABEL[weather])}</span>
                </span>
              </div>
              <div className={styles.dateRow}>
                <span className={styles.dateIcons} title={t(SEASON_LABEL[season])}>
                  <SeasonIcon season={season} />
                  <span className={styles.srOnly}>{t(SEASON_LABEL[season])}</span>
                </span>
                <DayDial time={snapshot.time} />
              </div>
              <div className={styles.dateTime}>{hudTime(snapshot.timeText)}</div>
              <div className={styles.dateYear}>{t('{season}, year {year}', { season: t(SEASON_LABEL[season]), year: snapshot.year })}</div>
            </Frame>
            <Frame className={styles.gold} label={t('Gold')}>
              <CoinIcon />
              <span className={styles.goldValue}>{formatGold(snapshot.gold)}</span>
            </Frame>
          </div>

          {/* Controls window. */}
          <Frame className={styles.controls} label={t('Companion controls')}>
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
          </Frame>

          {/* Inventory: the 12 x 3 grid, held item framed in red. */}
          <Frame className={styles.inventory} label={t("{name}'s inventory", { name })}>
            <div className={styles.invGrid} style={{ gridTemplateColumns: `repeat(${STARDEW_COLUMNS}, 40px)` }}>
              {SLOTS.map((s) => {
                const it = bySlot.get(s);
                const held = !!it && !!snapshot.held && it.name === snapshot.held;
                return (
                  <div key={s} className={held ? `${styles.slot} ${styles.slotHeld}` : styles.slot} data-slot={s} title={it ? `${it.name} x${it.count}` : undefined}>
                    {it ? (
                      <>
                        <span className={styles.slotLabel}>{it.name}</span>
                        {it.count > 1 ? <span className={styles.slotCount}>{it.count}</span> : null}
                      </>
                    ) : null}
                  </div>
                );
              })}
            </div>
            <div className={styles.posLine}>
              {snapshot.location} {snapshot.x}, {snapshot.y}
              {snapshot.sleeping ? <span className={styles.dim}> {t('resting')}</span> : null}
            </div>
          </Frame>
        </div>
      ) : (
        <div className={styles.waiting}>{t('Waiting for {name}...', { name })}</div>
      )}
    </div>
  );
}
