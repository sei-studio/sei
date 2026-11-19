/**
 * The room editor's Utilities and Lighting panels (261119, product call 261119;
 * simplified after product call 261120). Utilities adds the wallpaper widgets
 * (clock, date, text, progress) and edits the selected one; Lighting darkens, veils and warms the room. Both are plain
 * views over shared/seilinkWidgets.ts: every change goes back through the
 * editor's `edit` (one undo step per slider drag, via the gesture key).
 * Built from the editor's own primitives (RoomEditor.module.css: panel,
 * section, title, option, swatches, pill) plus a few rows of their own.
 */
import React from 'react';
import {
  DATE_PRESETS,
  DEFAULT_LIGHTING,
  LIGHTING_RANGE,
  PROGRESS_SPANS,
  WIDGET_ALIGNS,
  WIDGET_FONTS,
  WIDGET_FONT_LABEL,
  WIDGET_FONT_STACK,
  WIDGET_KINDS,
  WIDGET_MAX,
  WIDGET_OPACITY_MIN,
  WIDGET_SIZE_MAX,
  WIDGET_SIZE_MIN,
  WIDGET_SWATCHES,
  WIDGET_TEXT_MAX,
  WIDGET_WEIGHTS,
  WIDGET_WEIGHT_LABEL,
  clockFormatOf,
  formatDate,
  isNeutralLighting,
  type RoomLighting,
  type RoomWidget,
  type WidgetAlign,
  type WidgetKind,
} from '@shared/seilinkWidgets';
import { useLangStore, useT } from '../../lib/i18n';
import { CustomColor } from './RoomColorPicker';
import { TrashIcon } from './roomEditorIcons';
import { widgetLocale } from './RoomWidgets';
import ed from './RoomEditor.module.css';
import styles from './RoomDesktopPanels.module.css';

// ── Icons (same drawing rules as roomEditorIcons.tsx) ───────────────────────

const Svg = ({ size = 18, children }: { size?: number; children: React.ReactNode }): React.ReactElement => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

/** Rail: Utilities (the wallpaper widgets). */
export const WidgetsIcon = ({ size }: { size?: number }): React.ReactElement => (
  <Svg size={size}>
    <rect x="3.5" y="3.5" width="7" height="7" rx="1.6" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="1.6" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="1.6" />
    <circle cx="17" cy="17" r="3.6" />
  </Svg>
);

/** Rail: Lighting. */
export const LightIcon = ({ size }: { size?: number }): React.ReactElement => (
  <Svg size={size}>
    <circle cx="12" cy="12" r="4.2" />
    <path d="M12 7.8a4.2 4.2 0 0 0 0 8.4z" fill="currentColor" />
    <path d="M12 2.8v2M12 19.2v2M2.8 12h2M19.2 12h2M5.5 5.5l1.4 1.4M17.1 17.1l1.4 1.4M5.5 18.5l1.4-1.4M17.1 6.9l1.4-1.4" />
  </Svg>
);

const KindIcon = ({ kind, size = 22 }: { kind: WidgetKind; size?: number }): React.ReactElement => {
  switch (kind) {
    case 'clock':
      return (
        <Svg size={size}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 7.5V12l3 2" />
        </Svg>
      );
    case 'date':
      return (
        <Svg size={size}>
          <rect x="4" y="5.5" width="16" height="14.5" rx="2" />
          <path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" />
        </Svg>
      );
    case 'text':
      return (
        <Svg size={size}>
          <path d="M5 6.5V5h14v1.5M12 5v14M9 19h6" />
        </Svg>
      );
    case 'progress':
      return (
        <Svg size={size}>
          <rect x="3.5" y="10" width="17" height="4.5" rx="2.25" />
          <path d="M5.5 12.25h7" strokeWidth={2.6} />
        </Svg>
      );
  }
};

const AlignIcon = ({ align }: { align: WidgetAlign }): React.ReactElement => {
  const lines = align === 'left' ? 'M4 7h16M4 12h10M4 17h13' : align === 'center' ? 'M4 7h16M7 12h10M5.5 17h13' : 'M4 7h16M10 12h10M7 17h13';
  return (
    <Svg size={16}>
      <path d={lines} />
    </Svg>
  );
};

// ── Labels (English; i18n keys) ─────────────────────────────────────────────

export const WIDGET_KIND_LABEL: Readonly<Record<WidgetKind, string>> = { clock: 'Clock', date: 'Date', text: 'Text', progress: 'Progress' };
const ALIGN_LABEL: Readonly<Record<WidgetAlign, string>> = { left: 'Align left', center: 'Center', right: 'Align right' };
const SPAN_LABEL = { day: 'Today', year: 'This year' } as const;

// ── Small controls ──────────────────────────────────────────────────────────

function Slider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  show?: string;
  onChange(v: number): void;
  onEnd(): void;
}): React.ReactElement {
  const { label, value, min, max, step = 1, show, onChange, onEnd } = props;
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <label className={styles.slider}>
      <span className={styles.sliderHead}>
        <span>{label}</span>
        {show !== undefined && <span className={styles.sliderValue}>{show}</span>}
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        style={{ ['--fill' as string]: `${pct}%` }}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={onEnd}
        onKeyUp={onEnd}
        onBlur={onEnd}
      />
    </label>
  );
}

function Toggle({ label, on, onChange }: { label: string; on: boolean; onChange(on: boolean): void }): React.ReactElement {
  return (
    <button type="button" role="switch" aria-checked={on} className={on ? `${styles.toggle} ${styles.toggleOn}` : styles.toggle} onClick={() => onChange(!on)}>
      <span>{label}</span>
      <span className={styles.knob} aria-hidden="true" />
    </button>
  );
}

function Chips<T extends string | number>(props: {
  label: string;
  value: T | null;
  options: ReadonlyArray<{ id: T; label: React.ReactNode; title?: string; style?: React.CSSProperties }>;
  onPick(id: T): void;
  wrap?: boolean;
  /** One row of equal chips (no wrap), for short labels like the font samples. */
  even?: boolean;
}): React.ReactElement {
  const cls = [styles.chips, props.wrap ? styles.chipsWrap : '', props.even ? styles.chipsEven : ''].filter(Boolean).join(' ');
  return (
    <div className={cls} role="radiogroup" aria-label={props.label}>
      {props.options.map((o) => {
        const on = o.id === props.value;
        return (
          <button
            key={String(o.id)}
            type="button"
            role="radio"
            aria-checked={on}
            title={o.title}
            aria-label={o.title}
            className={on ? `${styles.chip} ${styles.chipOn}` : styles.chip}
            style={o.style}
            onClick={() => props.onPick(o.id)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function ColorRow({ value, gesture, onTint, onGestureEnd }: { value: string; gesture: string; onTint(hex: string, gesture: string | null): void; onGestureEnd(): void }): React.ReactElement {
  const t = useT();
  const custom = !WIDGET_SWATCHES.includes(value.toLowerCase());
  return (
    <div className={ed.swatches} role="radiogroup" aria-label={t('Color')}>
      {WIDGET_SWATCHES.map((hex) => (
        <button
          key={hex}
          type="button"
          role="radio"
          aria-checked={value.toLowerCase() === hex}
          aria-label={hex}
          title={hex}
          className={value.toLowerCase() === hex ? `${ed.swatch} ${ed.swatchOn}` : ed.swatch}
          style={{ background: hex }}
          onClick={() => onTint(hex, null)}
        />
      ))}
      <CustomColor value={value} active={custom} gesture={gesture} label={t('Custom color')} onTint={onTint} onGestureEnd={onGestureEnd} />
    </div>
  );
}

// ── Utilities: the widgets ──────────────────────────────────────────────────

export interface WidgetsPanelProps {
  widgets: readonly RoomWidget[];
  selected: string | null;
  onSelect(id: string | null): void;
  onAdd(kind: WidgetKind): void;
  /** A change to one widget; `gesture` keys a slider or colour drag (one undo step). */
  onChange(id: string, patch: Partial<RoomWidget>, gesture?: string | null): void;
  onRemove(id: string): void;
  onGestureEnd(): void;
}

/** A widget's name in the list: its kind, or a text line's own words. */
function widgetName(w: RoomWidget, t: (en: string) => string): string {
  return w.kind === 'text' && w.text ? w.text : t(WIDGET_KIND_LABEL[w.kind]);
}

/**
 * Utilities (product call 261120): the add tiles, then one row per placed
 * widget (icon + name). Only the selected widget opens, its settings inline
 * under its row; a click on the row again, or on the room, closes it.
 */
export function WidgetsPanel(props: WidgetsPanelProps): React.ReactElement {
  const { widgets, selected, onSelect, onAdd, onChange, onRemove, onGestureEnd } = props;
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const locale = widgetLocale(lang);
  const full = widgets.length >= WIDGET_MAX;
  const panelRef = React.useRef<HTMLElement>(null);
  const first = React.useRef(true);
  // A widget picked on the desktop may open below the fold: bring its row
  // and as much of its settings as fit into view (never past the row's top).
  React.useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const panel = panelRef.current;
    const item = selected ? panel?.querySelector<HTMLElement>(`[data-widget-item="${CSS.escape(selected)}"]`) : null;
    if (!panel || !item) return;
    const p = panel.getBoundingClientRect();
    const r = item.getBoundingClientRect();
    if (r.top < p.top) panel.scrollTop -= p.top - r.top + 8;
    else if (r.bottom > p.bottom) panel.scrollTop += Math.min(r.bottom - p.bottom + 8, r.top - p.top - 8);
  }, [selected]);
  return (
    <section key="misc" ref={panelRef} className={`${ed.panel} ${ed.groupPanel}`} aria-label={t('Utilities')} data-panel="misc">
      <div className={ed.section}>
        <h2 className={ed.title}>{t('Utilities')}</h2>
        <div className={styles.addGrid}>
          {WIDGET_KINDS.map((kind) => (
            <button key={kind} type="button" className={styles.add} disabled={full} onClick={() => onAdd(kind)} data-add-widget={kind}>
              <KindIcon kind={kind} />
              <span>{t(WIDGET_KIND_LABEL[kind])}</span>
            </button>
          ))}
        </div>
        {widgets.length > 0 ? (
          <div className={styles.list} aria-label={t('On your desktop')}>
            {widgets.map((w) => {
              const open = w.id === selected;
              return (
                <div key={w.id} className={styles.item} data-widget-item={w.id}>
                  <div className={open ? `${styles.row} ${styles.rowOn}` : styles.row}>
                    <button type="button" className={styles.rowMain} aria-expanded={open} onClick={() => onSelect(open ? null : w.id)}>
                      <KindIcon kind={w.kind} size={16} />
                      <span className={styles.rowText}>{widgetName(w, t)}</span>
                    </button>
                    {open && (
                      <button type="button" className={`${ed.iconBtn} ${styles.remove}`} title={t('Remove')} aria-label={t('Remove')} onClick={() => onRemove(w.id)}>
                        <TrashIcon size={16} />
                      </button>
                    )}
                  </div>
                  {open && <WidgetSettings w={w} locale={locale} onChange={onChange} onGestureEnd={onGestureEnd} />}
                </div>
              );
            })}
          </div>
        ) : (
          <p className={ed.note}>{t('Drag them anywhere on your desktop.')}</p>
        )}
      </div>
    </section>
  );
}

/** A small name over a control row ("Font", "Weight", "Color"), styled like a slider's name. */
function Field({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className={styles.field} role="group" aria-label={label}>
      <span className={styles.fieldLabel} aria-hidden="true">
        {label}
      </span>
      {children}
    </div>
  );
}

function WidgetSettings({
  w,
  locale,
  onChange,
  onGestureEnd,
}: {
  w: RoomWidget;
  locale: string;
  onChange: WidgetsPanelProps['onChange'];
  onGestureEnd(): void;
}): React.ReactElement {
  const t = useT();
  const set = (patch: Partial<RoomWidget>, gesture: string | null = null): void => onChange(w.id, patch, gesture);
  const fmt = clockFormatOf(w);
  const today = new Date();
  const dateOptions = DATE_PRESETS.map((id) => ({ id, label: formatDate(today, id, locale) }));
  return (
    <div className={styles.settings} role="group" aria-label={t(WIDGET_KIND_LABEL[w.kind])} data-widget-settings={w.kind}>
      {w.kind === 'clock' && (
        <>
          <div className={styles.toggles}>
            <Toggle label={t('24-hour')} on={!fmt.hour12} onChange={(on) => set({ hour12: !on })} />
            <Toggle label={t('Seconds')} on={fmt.seconds} onChange={(on) => set({ seconds: on })} />
            <Toggle label={t('Leading zero')} on={fmt.pad} onChange={(on) => set({ pad: on })} />
            {fmt.hour12 && <Toggle label={t('AM/PM')} on={fmt.ampm} onChange={(on) => set({ ampm: on })} />}
            <Toggle label={t('Date below')} on={Boolean(w.date)} onChange={(on) => set({ date: on ? 'long' : undefined })} />
          </div>
          {w.date && <Chips label={t('Date format')} value={w.date} options={dateOptions} onPick={(id) => set({ date: id })} wrap />}
        </>
      )}
      {w.kind === 'date' && <Chips label={t('Date format')} value={w.date ?? 'long'} options={dateOptions} onPick={(id) => set({ date: id })} wrap />}
      {w.kind === 'text' && (
        <input
          className={styles.textInput}
          type="text"
          value={w.text ?? ''}
          maxLength={WIDGET_TEXT_MAX}
          placeholder={t('Your text here')}
          aria-label={t('Text')}
          onChange={(e) => set({ text: e.target.value }, `widget:${w.id}:text`)}
          onBlur={onGestureEnd}
        />
      )}
      {w.kind === 'progress' && (
        <Chips label={t('Progress')} value={w.span ?? 'day'} options={PROGRESS_SPANS.map((id) => ({ id, label: t(SPAN_LABEL[id]) }))} onPick={(id) => set({ span: id })} />
      )}
      <Field label={t('Font')}>
        <Chips
          label={t('Font')}
          value={w.font}
          options={WIDGET_FONTS.map((id) => ({ id, label: 'Aa', title: t(WIDGET_FONT_LABEL[id]), style: { fontFamily: WIDGET_FONT_STACK[id] } }))}
          onPick={(id) => set({ font: id })}
          even
        />
      </Field>
      <Field label={t('Weight')}>
        <Chips
          label={t('Weight')}
          value={w.weight}
          options={WIDGET_WEIGHTS.map((id) => ({ id, label: 'Aa', title: t(WIDGET_WEIGHT_LABEL[id]), style: { fontFamily: WIDGET_FONT_STACK[w.font], fontWeight: id } }))}
          onPick={(id) => set({ weight: id })}
        />
      </Field>
      <Field label={t('Color')}>
        <ColorRow value={w.color} gesture={`widget:${w.id}:color`} onTint={(hex, g) => set({ color: hex }, g)} onGestureEnd={onGestureEnd} />
      </Field>
      <Slider label={t('Size')} value={w.size} min={WIDGET_SIZE_MIN} max={WIDGET_SIZE_MAX} onChange={(v) => set({ size: v }, `widget:${w.id}:size`)} onEnd={onGestureEnd} />
      <Slider
        label={t('Opacity')}
        value={Math.round(w.opacity * 100)}
        min={Math.round(WIDGET_OPACITY_MIN * 100)}
        max={100}
        show={`${Math.round(w.opacity * 100)}%`}
        onChange={(v) => set({ opacity: v / 100 }, `widget:${w.id}:opacity`)}
        onEnd={onGestureEnd}
      />
      <div className={styles.styleRow}>
        <Chips
          label={t('Alignment')}
          value={w.align}
          options={WIDGET_ALIGNS.map((id) => ({ id, label: <AlignIcon align={id} />, title: t(ALIGN_LABEL[id]) }))}
          onPick={(id) => set({ align: id })}
        />
        <Toggle label={t('Shadow')} on={w.shadow} onChange={(on) => set({ shadow: on })} />
      </div>
    </div>
  );
}

// ── Lighting ────────────────────────────────────────────────────────────────

export interface LightingPanelProps {
  lighting: RoomLighting | undefined;
  /** Her name, for the "include her" switch (absent: "the character"). */
  name?: string;
  onChange(patch: Partial<RoomLighting>, gesture?: string | null): void;
  onReset(): void;
  onGestureEnd(): void;
}

const signed = (n: number): string => (n > 0 ? `+${n}` : String(n));

export function LightingPanel({ lighting, name, onChange, onReset, onGestureEnd }: LightingPanelProps): React.ReactElement {
  const t = useT();
  const l = lighting ?? DEFAULT_LIGHTING;
  return (
    <section key="lighting" className={ed.panel} aria-label={t('Lighting')} data-panel="lighting">
      <h2 className={ed.title}>{t('Lighting')}</h2>
      <Slider
        label={t('Brightness')}
        value={l.brightness}
        min={LIGHTING_RANGE.brightness[0]}
        max={LIGHTING_RANGE.brightness[1]}
        show={signed(l.brightness)}
        onChange={(v) => onChange({ brightness: v }, 'light:brightness')}
        onEnd={onGestureEnd}
      />
      <Slider
        label={t('Dim overlay')}
        value={l.dim}
        min={LIGHTING_RANGE.dim[0]}
        max={LIGHTING_RANGE.dim[1]}
        show={`${l.dim}%`}
        onChange={(v) => onChange({ dim: v }, 'light:dim')}
        onEnd={onGestureEnd}
      />
      <Slider
        label={t('Warmth')}
        value={l.warmth}
        min={LIGHTING_RANGE.warmth[0]}
        max={LIGHTING_RANGE.warmth[1]}
        show={signed(l.warmth)}
        onChange={(v) => onChange({ warmth: v }, 'light:warmth')}
        onEnd={onGestureEnd}
      />
      <Toggle label={name ? t('Include {name}', { name }) : t('Include the character')} on={l.character} onChange={(on) => onChange({ character: on })} />
      <div className={styles.resetRow}>
        <button type="button" className={ed.pill} disabled={isNeutralLighting(l) && !l.character} onClick={onReset}>
          {t('Reset')}
        </button>
      </div>
    </section>
  );
}
