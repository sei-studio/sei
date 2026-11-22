/**
 * WorldLink wallpaper widgets (261119): the clock, date, text and progress
 * modules drawn over her room (shared/seilinkWidgets.ts has the format and
 * the rules). RoomCanvas mounts one layer per room, so the editor and the
 * desktop draw the same thing.
 *
 * Text is DOM text (crisp at any display scale), placed on the wallpaper box
 * in CSS px from the widget's 0..1 anchor, sized in thousandths of the box
 * height. One timer per layer: every second only while a clock shows
 * seconds, else just past each minute boundary; none while the wallpaper is
 * covered (`running` false), and none for text alone.
 */
import React, { useEffect, useState } from 'react';
import {
  clockFormatOf,
  clockParts,
  formatDate,
  formatPercent,
  nextTickDelay,
  spanProgress,
  widgetTick,
  WIDGET_FONT_STACK,
  type RoomWidget,
  type WidgetTick,
} from '@shared/seilinkWidgets';
import { uiLocaleTag, type UiLanguage } from '@shared/uiLanguage';
import { useLangStore, useT } from '../../lib/i18n';
import styles from './RoomWidgets.module.css';

/** The locale widgets format with: the system's own variant when it is the UI's language (en-GB under English), else the UI's. */
export function widgetLocale(lang: UiLanguage, nav: string | undefined = typeof navigator !== 'undefined' ? navigator.language : undefined): string {
  const ui = uiLocaleTag(lang);
  if (nav && nav.split('-')[0].toLowerCase() === ui.split('-')[0].toLowerCase()) return nav;
  return ui;
}

/**
 * Calls `onTick` just past every `tick` boundary (each second or each minute,
 * on the wall clock) until the returned stop function runs. One timer at a
 * time, re-armed from the time each tick actually read, so a late timer or a
 * sleep never drifts the next one. Exported for tests.
 */
export function startWidgetTicker(tick: Exclude<WidgetTick, null>, read: () => Date, onTick: (d: Date) => void): () => void {
  let id: ReturnType<typeof setTimeout>;
  const step = (): void => {
    const d = read();
    onTick(d);
    id = setTimeout(step, nextTickDelay(d.getTime(), tick, d.getTimezoneOffset()));
  };
  const d0 = read();
  id = setTimeout(step, nextTickDelay(d0.getTime(), tick, d0.getTimezoneOffset()));
  return () => clearTimeout(id);
}

/**
 * The time the widgets show, re-read on `tick` boundaries while `running`.
 * `clock` replaces Date.now (screenshots pin a time).
 */
export function useWidgetNow(tick: WidgetTick, running: boolean, clock?: () => Date): Date {
  const read = (): Date => (clock ? clock() : new Date());
  const [now, setNow] = useState(read);
  useEffect(() => {
    if (!running) return;
    setNow(read());
    if (!tick) return;
    return startWidgetTicker(tick, read, setNow);
    // `clock` is a stable prop in practice; a new one takes effect on the next tick change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, running]);
  return now;
}

/** Light text gets a dark shadow, dark text a light glow. */
function shadowFor(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const lum = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  return lum > 0.45 ? '0 1px 2px rgb(0 0 0 / 0.32), 0 2px 14px rgb(0 0 0 / 0.28)' : '0 1px 2px rgb(255 255 255 / 0.3), 0 2px 14px rgb(255 255 255 / 0.28)';
}

export interface RoomWidgetsProps {
  widgets: readonly RoomWidget[];
  /** The wallpaper box in CSS px (the display, or the app window in the editor). */
  width: number;
  height: number;
  /** False while the wallpaper is covered or paused: no ticking. */
  running: boolean;
  clock?: () => Date;
  /** Editor: an empty text line shows its placeholder, and the selected widget is marked. */
  editing?: boolean;
  selected?: string | null;
  /** Editor drag: this widget is drawn at this anchor instead. */
  moving?: { id: string; x: number; y: number } | null;
}

export function RoomWidgets(props: RoomWidgetsProps): React.ReactElement | null {
  const { widgets, width, height, running, editing, selected, moving } = props;
  const lang = useLangStore((s) => s.lang);
  const t = useT();
  const now = useWidgetNow(widgetTick(widgets), running, props.clock);
  if (!widgets.length || width <= 0 || height <= 0) return null;
  const locale = widgetLocale(lang);
  return (
    <div className={styles.layer} data-room-widgets="">
      {widgets.map((w) => {
        const at = moving && moving.id === w.id ? moving : w;
        const style: React.CSSProperties = {
          left: at.x * width,
          top: at.y * height,
          fontFamily: WIDGET_FONT_STACK[w.font],
          fontSize: (w.size / 1000) * height,
          fontWeight: w.weight,
          color: w.color,
          opacity: w.opacity,
          textAlign: w.align,
          textShadow: w.shadow ? shadowFor(w.color) : undefined,
          ['--bar-shadow' as string]: w.shadow ? 'drop-shadow(0 1px 6px rgb(0 0 0 / 0.3))' : 'none',
        };
        const cls = [styles.widget, styles[w.align], editing && selected === w.id ? styles.selected : ''].filter(Boolean).join(' ');
        return (
          <div key={w.id} className={cls} style={style} data-widget-id={w.id} data-widget-kind={w.kind}>
            <WidgetBody w={w} now={now} locale={locale} editing={editing === true} t={t} />
          </div>
        );
      })}
    </div>
  );
}

function WidgetBody({ w, now, locale, editing, t }: { w: RoomWidget; now: Date; locale: string; editing: boolean; t: (en: string) => string }): React.ReactElement | null {
  switch (w.kind) {
    case 'clock': {
      const p = clockParts(now, clockFormatOf(w), locale);
      const period = p.period ? <span className={styles.period}>{p.period}</span> : null;
      return (
        <>
          <div className={styles.time}>
            {p.periodFirst && period}
            <span>{p.time}</span>
            {!p.periodFirst && period}
          </div>
          {w.date && <div className={styles.subline}>{formatDate(now, w.date, locale)}</div>}
        </>
      );
    }
    case 'date':
      return <div className={styles.line}>{formatDate(now, w.date ?? 'long', locale)}</div>;
    case 'text':
      if (w.text) return <div className={styles.line}>{w.text}</div>;
      return editing ? <div className={`${styles.line} ${styles.placeholder}`}>{t('Your text here')}</div> : null;
    case 'progress': {
      const f = spanProgress(now, w.span ?? 'day');
      return (
        <div className={styles.progress}>
          <div className={styles.progressRow}>
            <span>{w.span === 'year' ? String(now.getFullYear()) : t('Today')}</span>
            <span>{formatPercent(f, locale)}</span>
          </div>
          <div className={styles.bar}>
            <div className={styles.fill} style={{ width: `${Math.floor(f * 100)}%` }} />
          </div>
        </div>
      );
    }
  }
}




