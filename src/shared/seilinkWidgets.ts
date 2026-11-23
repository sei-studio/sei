/**
 * WorldLink desktop widgets and room lighting (261119, product call 261119). Pure.
 *
 * Widgets are small overlay modules drawn on the wallpaper with her room
 * (RoomCanvas, components/seilink/RoomWidgets.tsx): a clock, a date, a line
 * of text and a day or year progress bar. They live in the room state
 * (`RoomState.widgets`), so they are saved, undone and sanitized with the
 * room, and follow her through a room type switch.
 *
 * Position is a point on the DISPLAY (0..1 of the wallpaper box, not the
 * room canvas), so a widget stays where it was put whatever the room's crop.
 * The anchor is the widget's left edge, centre or right edge (by `align`),
 * vertically its middle. Size is in thousandths of the box height, so the
 * editor's preview (the app window) and the desktop (the display) agree.
 *
 * Lighting (`RoomState.lighting`) darkens or brightens the room, lays a dark
 * veil over it (the desktop icons and windows stand out) and warms or cools
 * it. It never touches the widgets; `character` says whether it also covers
 * her (default no: the scene recedes, she stays bright).
 */

// ── Widgets ─────────────────────────────────────────────────────────────────

export const WIDGET_KINDS = ['clock', 'date', 'text', 'progress'] as const;
export type WidgetKind = (typeof WIDGET_KINDS)[number];

/** Font choices. Every one is bundled (fonts.css) or a system face: nothing is fetched at runtime. */
export const WIDGET_FONTS = ['system', 'oswald', 'rajdhani', 'serif', 'mono', 'pixel', 'hand'] as const;
export type WidgetFont = (typeof WIDGET_FONTS)[number];

const CJK_FALLBACK = "'Hiragino Sans', 'PingFang SC', 'Yu Gothic UI', 'Microsoft YaHei UI', 'Noto Sans CJK JP'";
export const WIDGET_FONT_STACK: Readonly<Record<WidgetFont, string>> = {
  system: `-apple-system, BlinkMacSystemFont, 'Segoe UI Variable Display', 'Segoe UI', system-ui, ${CJK_FALLBACK}, sans-serif`,
  oswald: `'Oswald', 'Noto Sans', ${CJK_FALLBACK}, sans-serif`,
  rajdhani: `'Rajdhani', 'Noto Sans', ${CJK_FALLBACK}, sans-serif`,
  serif: `'New York', 'Iowan Old Style', 'Palatino Linotype', Georgia, 'Times New Roman', 'Hiragino Mincho ProN', 'Yu Mincho', serif`,
  mono: `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`,
  pixel: `'Pixelify Sans', 'Noto Sans', ${CJK_FALLBACK}, sans-serif`,
  hand: `'Architects Daughter', 'Noto Sans', ${CJK_FALLBACK}, cursive`,
};
/** Editor names (English; i18n keys). */
export const WIDGET_FONT_LABEL: Readonly<Record<WidgetFont, string>> = {
  system: 'System',
  oswald: 'Condensed',
  rajdhani: 'Tech',
  serif: 'Serif',
  mono: 'Mono',
  pixel: 'Pixel',
  hand: 'Handwritten',
};

export const WIDGET_WEIGHTS = [300, 400, 600, 700] as const;
export type WidgetWeight = (typeof WIDGET_WEIGHTS)[number];
export const WIDGET_WEIGHT_LABEL: Readonly<Record<WidgetWeight, string>> = { 300: 'Light', 400: 'Regular', 600: 'Semibold', 700: 'Bold' };

export const WIDGET_ALIGNS = ['left', 'center', 'right'] as const;
export type WidgetAlign = (typeof WIDGET_ALIGNS)[number];

/** Date formats. Locale-aware through Intl except `iso`. */
export const DATE_PRESETS = ['long', 'weekday', 'medium', 'numeric', 'full', 'iso'] as const;
export type DatePreset = (typeof DATE_PRESETS)[number];

export const PROGRESS_SPANS = ['day', 'year'] as const;
export type ProgressSpan = (typeof PROGRESS_SPANS)[number];

/** Size, in thousandths of the wallpaper's height. */
export const WIDGET_SIZE_MIN = 15;
export const WIDGET_SIZE_MAX = 260;
export const WIDGET_OPACITY_MIN = 0.15;
export const WIDGET_TEXT_MAX = 120;
/** Hard cap per room (a hostile file must not make the page lay out thousands). */
export const WIDGET_MAX = 12;

/** Colour presets: whites, a black, and a few that sit well on a painted room. */
export const WIDGET_SWATCHES: readonly string[] = ['#ffffff', '#f6efe4', '#1b1c22', '#bcd2ff', '#ffc9d6', '#c8f0d8', '#ffd28a', '#c9b8ff'];

export interface WidgetStyle {
  font: WidgetFont;
  /** Hex colour. */
  color: string;
  size: number;
  weight: WidgetWeight;
  /** 0.15..1. */
  opacity: number;
  /** A soft shadow under the text (reads on light rooms). */
  shadow: boolean;
  align: WidgetAlign;
}

/** One widget. Kind-specific fields are only kept for their kind (sanitizeWidgets). */
export interface RoomWidget extends WidgetStyle {
  /** Stable id within the room (editor selection, analytics diffing). */
  id: string;
  kind: WidgetKind;
  /** Anchor on the wallpaper, 0..1 of its width and height. */
  x: number;
  y: number;
  // clock
  hour12?: boolean;
  /** Leading zero on the hour (09:41). */
  pad?: boolean;
  seconds?: boolean;
  /** AM/PM after (or before, by locale) a 12-hour time. */
  ampm?: boolean;
  /** clock: a date line under the time (absent = none); date: its format. */
  date?: DatePreset;
  // text
  text?: string;
  // progress
  span?: ProgressSpan;
}

/** Setting keys the editor changes (analytics name these, never their values). */
export const WIDGET_SETTING_KEYS = ['position', 'font', 'color', 'size', 'weight', 'opacity', 'shadow', 'align', 'hour12', 'pad', 'seconds', 'ampm', 'date', 'text', 'span'] as const;
export type WidgetSettingKey = (typeof WIDGET_SETTING_KEYS)[number];

const STYLE_DEFAULT: Omit<WidgetStyle, 'size'> = { font: 'system', color: '#ffffff', weight: 400, opacity: 0.92, shadow: true, align: 'center' };

/** A new widget of `kind`, before it is placed (addWidget picks the spot). */
export function newWidget(kind: WidgetKind, id: string): RoomWidget {
  switch (kind) {
    case 'clock':
      return { ...STYLE_DEFAULT, id, kind, x: 0.5, y: 0.2, size: 120, weight: 300, hour12: true, pad: false, seconds: false, ampm: false };
    case 'date':
      return { ...STYLE_DEFAULT, id, kind, x: 0.5, y: 0.3, size: 30, weight: 600, date: 'long' };
    case 'text':
      return { ...STYLE_DEFAULT, id, kind, x: 0.5, y: 0.36, size: 26, font: 'serif', text: '' };
    case 'progress':
      return { ...STYLE_DEFAULT, id, kind, x: 0.5, y: 0.42, size: 22, weight: 600, span: 'day' };
  }
}

/** A short id not used in `taken`. `rand` is injectable for tests. */
export function widgetId(taken: Iterable<string>, rand: () => number = Math.random): string {
  const used = new Set(taken);
  for (let i = 0; i < 50; i++) {
    const id = Math.floor(rand() * 36 ** 6)
      .toString(36)
      .padStart(6, '0');
    if (!used.has(id)) return id;
  }
  let n = used.size;
  while (used.has(`w${n}`)) n++;
  return `w${n}`;
}

/**
 * Where a new widget goes: its kind's default spot, moved down past any
 * widget already sitting there (so a second clock never lands on the first).
 */
export function freeSpot(widgets: readonly Pick<RoomWidget, 'x' | 'y'>[], x: number, y: number): [number, number] {
  let yy = y;
  for (let i = 0; i < 12; i++) {
    if (!widgets.some((w) => Math.abs(w.x - x) < 0.05 && Math.abs(w.y - yy) < 0.05)) break;
    yy += 0.07;
  }
  return [x, Math.min(0.95, yy)];
}

// ── Formatting ──────────────────────────────────────────────────────────────

const pad2 = (n: number): string => String(n).padStart(2, '0');

export interface ClockFormat {
  hour12: boolean;
  pad: boolean;
  seconds: boolean;
  ampm: boolean;
}

/** A sample time for tests and previews (21:41:07, a Thursday). */
export const CLOCK_SAMPLE = new Date(2026, 10, 19, 21, 41, 7);

export function clockFormatOf(w: Pick<RoomWidget, 'hour12' | 'pad' | 'seconds' | 'ampm'>): ClockFormat {
  return { hour12: w.hour12 !== false, pad: w.pad === true, seconds: w.seconds === true, ampm: w.ampm === true };
}

/** The clock's text: the digits, and the day period (AM/PM in the locale's words) and which side it goes on. */
export function clockParts(d: Date, f: ClockFormat, locale: string): { time: string; period: string | null; periodFirst: boolean } {
  let h = d.getHours();
  if (f.hour12) {
    h %= 12;
    if (h === 0) h = 12;
  }
  const hh = f.pad ? pad2(h) : String(h);
  const time = `${hh}:${pad2(d.getMinutes())}${f.seconds ? `:${pad2(d.getSeconds())}` : ''}`;
  if (!f.hour12 || !f.ampm) return { time, period: null, periodFirst: false };
  try {
    const parts = new Intl.DateTimeFormat(locale, { hour: 'numeric', hour12: true }).formatToParts(d);
    const pi = parts.findIndex((p) => p.type === 'dayPeriod');
    const hi = parts.findIndex((p) => p.type === 'hour');
    const period = pi >= 0 ? parts[pi].value.trim() : d.getHours() < 12 ? 'AM' : 'PM';
    return { time, period, periodFirst: pi >= 0 && hi >= 0 && pi < hi };
  } catch {
    return { time, period: d.getHours() < 12 ? 'AM' : 'PM', periodFirst: false };
  }
}

/** The clock as one string (tests, aria labels). */
export function formatClock(d: Date, f: ClockFormat, locale: string): string {
  const p = clockParts(d, f, locale);
  if (!p.period) return p.time;
  return p.periodFirst ? `${p.period}${p.time}` : `${p.time} ${p.period}`;
}

const DATE_OPTIONS: Readonly<Record<Exclude<DatePreset, 'iso'>, Intl.DateTimeFormatOptions>> = {
  long: { weekday: 'long', month: 'long', day: 'numeric' },
  weekday: { weekday: 'long' },
  medium: { day: 'numeric', month: 'short', year: 'numeric' },
  numeric: { month: 'numeric', day: 'numeric' },
  full: { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' },
};

/** "Thursday, November 19", "Thursday", "Nov 19, 2026", "11/19", "Thursday, November 19, 2026", "2026-11-19" (en-US). */
export function formatDate(d: Date, preset: DatePreset, locale: string): string {
  if (preset === 'iso') return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  try {
    return new Intl.DateTimeFormat(locale, DATE_OPTIONS[preset]).format(d);
  } catch {
    return new Intl.DateTimeFormat('en-US', DATE_OPTIONS[preset]).format(d);
  }
}

/** How far through the day or year `d` is, 0..1 (local time; DST days are 23 or 25 hours). */
export function spanProgress(d: Date, span: ProgressSpan): number {
  const start = span === 'day' ? new Date(d.getFullYear(), d.getMonth(), d.getDate()) : new Date(d.getFullYear(), 0, 1);
  const end = span === 'day' ? new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1) : new Date(d.getFullYear() + 1, 0, 1);
  const f = (d.getTime() - start.getTime()) / (end.getTime() - start.getTime());
  return Math.min(1, Math.max(0, f));
}

/** The percent shown (whole, rounded down so 100% only at the very end). */
export function formatPercent(f: number, locale: string): string {
  const v = Math.floor(f * 100) / 100;
  try {
    return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(v);
  } catch {
    return `${Math.round(v * 100)}%`;
  }
}

// ── Ticking ─────────────────────────────────────────────────────────────────

export type WidgetTick = 'second' | 'minute' | null;

/** How often the widgets must redraw: every second only while a clock shows seconds, else on the minute; text alone never. */
export function widgetTick(widgets: readonly RoomWidget[] | undefined): WidgetTick {
  let tick: WidgetTick = null;
  for (const w of widgets ?? []) {
    if (w.kind === 'clock' && w.seconds) return 'second';
    if (w.kind !== 'text') tick = 'minute';
  }
  return tick;
}

/** Slack after the boundary, so a timer that fires a hair early never shows the old second. */
export const TICK_SLACK_MS = 30;

/** Milliseconds from `nowMs` to just past the next second or minute boundary of the local clock.
 * `tzOffsetMin` is Date#getTimezoneOffset() (minutes west of UTC). */
export function nextTickDelay(nowMs: number, tick: Exclude<WidgetTick, null>, tzOffsetMin = 0): number {
  const unit = tick === 'second' ? 1000 : 60_000;
  // Local minute boundaries: shift by the zone offset (whole minutes everywhere today, so this is 0 in practice).
  const local = nowMs - tzOffsetMin * 60_000;
  const rest = unit - (((local % unit) + unit) % unit);
  return rest + TICK_SLACK_MS;
}

// ── Edits ───────────────────────────────────────────────────────────────────

/** Widget ops on anything that carries `widgets` (RoomState). Return a new object; never mutate. */
export function addWidget<S extends { widgets?: RoomWidget[] }>(state: S, kind: WidgetKind, id?: string): { state: S; id: string } {
  const list = state.widgets ?? [];
  if (list.length >= WIDGET_MAX) return { state, id: '' };
  const wid = id ?? widgetId(list.map((w) => w.id));
  const w = newWidget(kind, wid);
  const [x, y] = freeSpot(list, w.x, w.y);
  return { state: { ...state, widgets: [...list, { ...w, x, y }] }, id: wid };
}

export function updateWidget<S extends { widgets?: RoomWidget[] }>(state: S, id: string, patch: Partial<Omit<RoomWidget, 'id' | 'kind'>>): S {
  const list = state.widgets ?? [];
  const i = list.findIndex((w) => w.id === id);
  if (i < 0) return state;
  const next = sanitizeWidget({ ...list[i], ...patch });
  if (!next) return state;
  const widgets = list.slice();
  widgets[i] = next;
  return { ...state, widgets };
}

export function removeWidget<S extends { widgets?: RoomWidget[] }>(state: S, id: string): S {
  const list = state.widgets ?? [];
  if (!list.some((w) => w.id === id)) return state;
  const widgets = list.filter((w) => w.id !== id);
  if (widgets.length) return { ...state, widgets };
  const { widgets: _gone, ...rest } = state;
  return rest as S;
}

/** Snap distance, CSS px. */
export const WIDGET_SNAP_PX = 10;

/**
 * Snap a dragged anchor (0..1) to the centre lines and to other widgets'
 * anchors when within `WIDGET_SNAP_PX`. Returns the snapped point and the
 * guide lines to show (fractions; null = none on that axis).
 */
export function snapWidget(
  x: number,
  y: number,
  others: readonly Pick<RoomWidget, 'x' | 'y'>[],
  box: { w: number; h: number },
): { x: number; y: number; guideX: number | null; guideY: number | null } {
  const tx = box.w > 0 ? WIDGET_SNAP_PX / box.w : 0;
  const ty = box.h > 0 ? WIDGET_SNAP_PX / box.h : 0;
  const pick = (v: number, cands: number[], t: number): number | null => {
    let best: number | null = null;
    for (const c of cands) if (Math.abs(c - v) <= t && (best === null || Math.abs(c - v) < Math.abs(best - v))) best = c;
    return best;
  };
  const gx = pick(x, [0.5, ...others.map((o) => o.x)], tx);
  const gy = pick(y, [0.5, ...others.map((o) => o.y)], ty);
  const clamp = (v: number): number => Math.min(0.99, Math.max(0.01, v));
  return { x: clamp(gx ?? x), y: clamp(gy ?? y), guideX: gx, guideY: gy };
}

// ── Sanitizing ──────────────────────────────────────────────────────────────

const HEX_RE = /^#[0-9a-f]{6}$/i;
const ID_RE = /^[a-z0-9]{1,16}$/i;
const oneOf = <T>(list: readonly T[], v: unknown): v is T => (list as readonly unknown[]).includes(v);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Printable text, one line, capped. */
export function cleanWidgetText(v: unknown): string {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').slice(0, WIDGET_TEXT_MAX);
}

/** One stored widget made safe, or null when it cannot be (no id, unknown kind). */
export function sanitizeWidget(raw: unknown): RoomWidget | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !ID_RE.test(r.id) || !oneOf(WIDGET_KINDS, r.kind)) return null;
  const base = newWidget(r.kind, r.id);
  const w: RoomWidget = {
    id: r.id,
    kind: r.kind,
    x: num(r.x) ? clamp(r.x, 0, 1) : base.x,
    y: num(r.y) ? clamp(r.y, 0, 1) : base.y,
    font: oneOf(WIDGET_FONTS, r.font) ? r.font : base.font,
    color: typeof r.color === 'string' && HEX_RE.test(r.color) ? r.color.toLowerCase() : base.color,
    size: num(r.size) ? Math.round(clamp(r.size, WIDGET_SIZE_MIN, WIDGET_SIZE_MAX)) : base.size,
    weight: oneOf(WIDGET_WEIGHTS, r.weight) ? r.weight : base.weight,
    opacity: num(r.opacity) ? Math.round(clamp(r.opacity, WIDGET_OPACITY_MIN, 1) * 100) / 100 : base.opacity,
    shadow: typeof r.shadow === 'boolean' ? r.shadow : base.shadow,
    align: oneOf(WIDGET_ALIGNS, r.align) ? r.align : base.align,
  };
  if (w.kind === 'clock') {
    w.hour12 = typeof r.hour12 === 'boolean' ? r.hour12 : true;
    w.pad = r.pad === true;
    w.seconds = r.seconds === true;
    w.ampm = r.ampm === true;
    if (oneOf(DATE_PRESETS, r.date)) w.date = r.date;
  } else if (w.kind === 'date') {
    w.date = oneOf(DATE_PRESETS, r.date) ? r.date : 'long';
  } else if (w.kind === 'text') {
    w.text = cleanWidgetText(r.text);
  } else {
    w.span = oneOf(PROGRESS_SPANS, r.span) ? r.span : 'day';
  }
  return w;
}

/** A stored widget list made safe: bad entries dropped, ids unique, capped. Undefined when empty. */
export function sanitizeWidgets(raw: unknown): RoomWidget[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: RoomWidget[] = [];
  const ids = new Set<string>();
  for (const it of raw.slice(0, WIDGET_MAX * 2)) {
    const w = sanitizeWidget(it);
    if (!w || ids.has(w.id)) continue;
    ids.add(w.id);
    out.push(w);
    if (out.length >= WIDGET_MAX) break;
  }
  return out.length ? out : undefined;
}

// ── Lighting ────────────────────────────────────────────────────────────────

export interface RoomLighting {
  /** -50 (darker) .. 50 (brighter), percent. */
  brightness: number;
  /** 0 .. 85: a dark veil over the room, percent. */
  dim: number;
  /** -50 (cooler) .. 50 (warmer). */
  warmth: number;
  /** The lighting covers her too (default: only the room). */
  character: boolean;
}

export const LIGHTING_RANGE = { brightness: [-50, 50], dim: [0, 85], warmth: [-50, 50] } as const;
export const DEFAULT_LIGHTING: Readonly<RoomLighting> = { brightness: 0, dim: 0, warmth: 0, character: false };

export function sanitizeLighting(raw: unknown): RoomLighting | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const val = (k: keyof typeof LIGHTING_RANGE): number => (num(r[k]) ? Math.round(clamp(r[k] as number, LIGHTING_RANGE[k][0], LIGHTING_RANGE[k][1])) : 0);
  const out: RoomLighting = { brightness: val('brightness'), dim: val('dim'), warmth: val('warmth'), character: r.character === true };
  return isNeutralLighting(out) ? undefined : out;
}

/** Nothing to draw: no change to the room (the `character` switch alone changes nothing). */
export function isNeutralLighting(l: RoomLighting | undefined | null): boolean {
  return !l || (l.brightness === 0 && l.dim === 0 && l.warmth === 0);
}

/** Set lighting on a state; neutral lighting with the default switch is dropped from the state. */
export function setLighting<S extends { lighting?: RoomLighting }>(state: S, patch: Partial<RoomLighting>): S {
  const next: RoomLighting = { ...DEFAULT_LIGHTING, ...state.lighting, ...patch };
  const clean = sanitizeLighting(next);
  const out = { ...state };
  if (clean) out.lighting = clean;
  else if (next.character) out.lighting = { ...DEFAULT_LIGHTING, character: true };
  else delete out.lighting;
  return out;
}

/** Brightness factor for the CSS filter: the slider times the veil (a black veil of alpha a = brightness(1 - a)). */
export function lightingBrightness(l: RoomLighting): number {
  return Math.round((1 + l.brightness / 100) * (1 - l.dim / 100) * 1000) / 1000;
}

/**
 * Warmth as an feColorMatrix (red up and blue down when warm, the other way
 * when cool; green barely moves). Null when neutral.
 */
export function warmthMatrix(warmth: number): string | null {
  if (!warmth) return null;
  const k = warmth / 100;
  const r = 1 + 0.22 * k;
  const g = 1 + 0.03 * k;
  const b = 1 - 0.3 * k;
  const f = (n: number): string => String(Math.round(n * 1000) / 1000);
  return `${f(r)} 0 0 0 0  0 ${f(g)} 0 0 0  0 0 ${f(b)} 0 0  0 0 0 1 0`;
}

/** The CSS filter for the room layers (null = none). `warmUrl` is the url(#id) of the warmth matrix when there is one. */
export function lightingFilter(l: RoomLighting | undefined | null, warmUrl: string | null): string | null {
  if (!l || isNeutralLighting(l)) return null;
  const parts: string[] = [];
  const b = lightingBrightness(l);
  if (b !== 1) parts.push(`brightness(${b})`);
  if (l.warmth && warmUrl) parts.push(warmUrl);
  return parts.length ? parts.join(' ') : null;
}

// ── Analytics (shape only) ──────────────────────────────────────────────────

export interface WidgetChange {
  action: 'added' | 'removed' | 'edited';
  kind: WidgetKind;
  /** Edited: the setting keys that changed (never their values). */
  changed?: WidgetSettingKey[];
}

/** What changed in the widgets between two saved states (matched by id). */
export function widgetChanges(before: readonly RoomWidget[] | undefined, after: readonly RoomWidget[] | undefined): WidgetChange[] {
  const a = new Map((before ?? []).map((w) => [w.id, w]));
  const b = new Map((after ?? []).map((w) => [w.id, w]));
  const out: WidgetChange[] = [];
  for (const [id, w] of b) {
    const old = a.get(id);
    if (!old || old.kind !== w.kind) {
      out.push({ action: 'added', kind: w.kind });
      continue;
    }
    const changed: WidgetSettingKey[] = [];
    for (const k of WIDGET_SETTING_KEYS) {
      if (k === 'position') {
        if (old.x !== w.x || old.y !== w.y) changed.push(k);
      } else if ((old[k] ?? null) !== (w[k] ?? null)) changed.push(k);
    }
    if (changed.length) out.push({ action: 'edited', kind: w.kind, changed });
  }
  for (const [id, w] of a) if (!b.has(id) || b.get(id)!.kind !== w.kind) out.push({ action: 'removed', kind: w.kind });
  return out;
}

/** A slider value to the nearest 10 (analytics buckets). */
export function lightingBucket(v: number): number {
  return Math.round(v / 10) * 10;
}
