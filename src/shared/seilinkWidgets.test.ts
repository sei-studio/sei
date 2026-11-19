import { describe, expect, it } from 'vitest';
import {
  CLOCK_SAMPLE,
  DEFAULT_LIGHTING,
  TICK_SLACK_MS,
  WIDGET_MAX,
  addWidget,
  formatClock,
  formatDate,
  formatPercent,
  lightingFilter,
  nextTickDelay,
  removeWidget,
  sanitizeLighting,
  sanitizeWidgets,
  setLighting,
  snapWidget,
  spanProgress,
  updateWidget,
  warmthMatrix,
  widgetChanges,
  widgetTick,
  type RoomWidget,
} from './seilinkWidgets';
import { bareRoomState, defaultRoomState, type RoomPresetManifest, type RoomState } from './seilinkRoom';
import { sanitizeRoomState } from './seilinkValidate';
import { switchPreset } from './seilinkEdit';
import { classifyEdit, desktopSaveEvents, isSeilinkRendererEvent, sanitizeSeilinkTrack, SEILINK_LIGHTING_EVENT, SEILINK_WIDGET_EVENT } from './seilinkTelemetry';

const manifest: RoomPresetManifest = {
  format: 'sei-room',
  version: 1,
  id: 'cozy',
  place: 'your bedroom',
  canvas: [2560, 1440],
  avatar: { x: 1280, y: 1440, height: 1100 },
  slots: {
    view: { z: 0, options: ['view-city'] },
    shell: { z: 10, options: ['shell-cozy'] },
    rug: { z: 30, options: ['rug-round'], optional: true },
  },
  components: [
    { id: 'view-city', slot: 'view', name: 'city view', frames: { day: { src: 'view/day.webp' } } },
    { id: 'shell-cozy', slot: 'shell', name: 'room', frames: { day: { src: 'shell/day.webp' } } },
    { id: 'rug-round', slot: 'rug', name: 'round rug', frames: { day: { src: 'r.webp' } } },
  ],
};

const clock = (over: Partial<RoomWidget> = {}): RoomWidget => ({
  id: 'c1',
  kind: 'clock',
  x: 0.5,
  y: 0.2,
  font: 'system',
  color: '#ffffff',
  size: 120,
  weight: 300,
  opacity: 0.9,
  shadow: true,
  align: 'center',
  hour12: true,
  pad: false,
  seconds: false,
  ampm: false,
  ...over,
});

describe('clock formats (261119)', () => {
  it('each switch changes one thing: 24-hour, seconds, leading zero, AM/PM', () => {
    const f = { hour12: true, pad: false, seconds: false, ampm: false };
    expect(formatClock(CLOCK_SAMPLE, f, 'en-US')).toBe('9:41');
    expect(formatClock(CLOCK_SAMPLE, { ...f, hour12: false }, 'en-US')).toBe('21:41');
    expect(formatClock(CLOCK_SAMPLE, { ...f, seconds: true }, 'en-US')).toBe('9:41:07');
    expect(formatClock(CLOCK_SAMPLE, { ...f, pad: true }, 'en-US')).toBe('09:41');
    expect(formatClock(CLOCK_SAMPLE, { ...f, pad: true, ampm: true }, 'en-US')).toBe('09:41 PM');
  });

  it('12 at noon and midnight on a 12-hour clock, 00 on a padded 24-hour one', () => {
    const f = { hour12: true, pad: false, seconds: false, ampm: true };
    expect(formatClock(new Date(2026, 0, 1, 0, 5), f, 'en-US')).toBe('12:05 AM');
    expect(formatClock(new Date(2026, 0, 1, 12, 5), f, 'en-US')).toBe('12:05 PM');
    expect(formatClock(new Date(2026, 0, 1, 0, 5), { hour12: false, pad: true, seconds: false, ampm: true }, 'en-US')).toBe('00:05');
  });

  it('the day period follows the locale, before the time where it goes first', () => {
    const f = { hour12: true, pad: false, seconds: false, ampm: true };
    expect(formatClock(CLOCK_SAMPLE, f, 'ja-JP')).toBe('午後9:41');
    expect(formatClock(CLOCK_SAMPLE, f, 'zh-CN')).toBe('下午9:41');
  });
});

describe('date formats (261119)', () => {
  const d = new Date(2026, 10, 19, 9, 0);
  it('locale-aware presets', () => {
    expect(formatDate(d, 'long', 'en-US')).toBe('Thursday, November 19');
    expect(formatDate(d, 'weekday', 'en-US')).toBe('Thursday');
    expect(formatDate(d, 'medium', 'en-US')).toBe('Nov 19, 2026');
    expect(formatDate(d, 'medium', 'en-GB')).toBe('19 Nov 2026');
    expect(formatDate(d, 'numeric', 'en-US')).toBe('11/19');
    expect(formatDate(d, 'full', 'en-US')).toBe('Thursday, November 19, 2026');
    expect(formatDate(d, 'iso', 'ja-JP')).toBe('2026-11-19');
    expect(formatDate(d, 'long', 'ja-JP')).toBe('11月19日木曜日');
  });
  it('a bad locale falls back instead of throwing', () => {
    expect(formatDate(d, 'weekday', 'not a locale!!')).toBe('Thursday');
  });
});

describe('progress (261119)', () => {
  it('day and year fractions, percent rounded down', () => {
    expect(spanProgress(new Date(2026, 10, 19, 12, 0), 'day')).toBeCloseTo(0.5, 5);
    expect(spanProgress(new Date(2026, 0, 1, 0, 0), 'year')).toBe(0);
    expect(spanProgress(new Date(2026, 6, 2, 12), 'year')).toBeGreaterThan(0.49);
    expect(formatPercent(0.999, 'en-US')).toBe('99%');
    expect(formatPercent(0.625, 'en-US')).toBe('62%');
  });
});

describe('tick scheduling (261119)', () => {
  it('seconds only while a clock shows them; minutes for clock, date, progress; none for text alone', () => {
    expect(widgetTick([])).toBeNull();
    expect(widgetTick(undefined)).toBeNull();
    expect(widgetTick([{ ...clock(), kind: 'text', text: 'hi' }])).toBeNull();
    expect(widgetTick([clock()])).toBe('minute');
    expect(widgetTick([{ ...clock(), kind: 'date', date: 'long' }])).toBe('minute');
    expect(widgetTick([{ ...clock(), kind: 'progress', span: 'day' }])).toBe('minute');
    expect(widgetTick([clock(), clock({ id: 'c2', seconds: true })])).toBe('second');
  });

  it('waits until just past the next boundary', () => {
    const t = new Date(2026, 10, 19, 12, 0, 0, 250).getTime();
    expect(nextTickDelay(t, 'second')).toBe(750 + TICK_SLACK_MS);
    const m = new Date(2026, 10, 19, 12, 0, 59, 900).getTime();
    expect(nextTickDelay(m, 'minute')).toBe(100 + TICK_SLACK_MS);
    // Exactly on a boundary: a whole unit later (never 0, never a busy loop).
    const z = new Date(2026, 10, 19, 12, 1, 0, 0).getTime();
    expect(nextTickDelay(z, 'minute')).toBe(60_000 + TICK_SLACK_MS);
  });
});

describe('widget edits and sanitizing (261119)', () => {
  it('adds at the kind default, below one already there, and caps the count', () => {
    let s: RoomState = defaultRoomState('cozy');
    const a = addWidget(s, 'clock', 'aa');
    const b = addWidget(a.state, 'clock', 'bb');
    expect(b.state.widgets?.map((w) => [w.x, w.y])).toEqual([
      [0.5, 0.2],
      [0.5, expect.closeTo(0.27, 5)],
    ]);
    s = b.state;
    for (let i = 0; i < WIDGET_MAX + 3; i++) s = addWidget(s, 'text').state;
    expect(s.widgets).toHaveLength(WIDGET_MAX);
    expect(addWidget(s, 'text').id).toBe('');
  });

  it('update re-sanitizes; removing the last widget drops the key', () => {
    const s = addWidget(defaultRoomState('cozy'), 'clock', 'aa').state;
    const big = updateWidget(s, 'aa', { size: 9999, color: 'red' as never, x: 3 });
    expect(big.widgets?.[0]).toMatchObject({ size: 260, color: '#ffffff', x: 1 });
    expect('widgets' in removeWidget(s, 'aa')).toBe(false);
  });

  it('keeps only sane widgets: bad ids and kinds dropped, duplicates dropped, text one line and capped', () => {
    const out = sanitizeWidgets([
      clock(),
      clock(), // duplicate id
      { ...clock(), id: '../x' },
      { ...clock(), id: 'k2', kind: 'weather' },
      { id: 't1', kind: 'text', text: `hello\nworld${'x'.repeat(500)}`, color: '#ABCDEF', opacity: 0, weight: 950, font: 'comic' },
      { id: 'd1', kind: 'date', date: 'nope', hour12: false },
      { id: 'p1', kind: 'progress', span: 'year', text: 'not mine' },
    ]);
    expect(out?.map((w) => w.id)).toEqual(['c1', 't1', 'd1', 'p1']);
    const t = out![1];
    expect(t.text).toMatch(/^hello world/);
    expect(t.text!.length).toBe(120);
    expect(t).toMatchObject({ color: '#abcdef', opacity: 0.15, weight: 400, font: 'serif' });
    expect(out![2]).toMatchObject({ date: 'long' });
    expect(out![2].hour12).toBeUndefined();
    expect(out![3]).toMatchObject({ span: 'year' });
    expect(out![3].text).toBeUndefined();
    expect(sanitizeWidgets('nope')).toBeUndefined();
    expect(sanitizeWidgets([])).toBeUndefined();
  });

  it('snaps to the centre line and to other widgets within 10 px', () => {
    const box = { w: 1000, h: 500 };
    expect(snapWidget(0.505, 0.3, [], box)).toMatchObject({ x: 0.5, guideX: 0.5, guideY: null });
    expect(snapWidget(0.304, 0.41, [{ x: 0.31, y: 0.4 }], box)).toMatchObject({ x: 0.31, y: 0.4, guideX: 0.31, guideY: 0.4 });
    expect(snapWidget(0.3, 0.3, [], box)).toMatchObject({ x: 0.3, y: 0.3, guideX: null, guideY: null });
    expect(snapWidget(-1, 2, [], box)).toMatchObject({ x: 0.01, y: 0.99 });
  });
});

describe('persistence with the room (261119)', () => {
  const room = (): RoomState => ({
    ...defaultRoomState('cozy'),
    widgets: [clock(), { ...clock({ id: 't1' }), kind: 'text', text: 'stay hydrated' }],
    lighting: { brightness: -20, dim: 40, warmth: 10, character: false },
  });

  it('sanitizeRoomState keeps widgets and lighting (a save and a load round-trip)', () => {
    const saved = JSON.parse(JSON.stringify(room()));
    const back = sanitizeRoomState(manifest, saved);
    expect(back.widgets).toEqual(sanitizeWidgets(room().widgets));
    expect(back.lighting).toEqual({ brightness: -20, dim: 40, warmth: 10, character: false });
  });

  it('a room type switch and the guided bare room keep them', () => {
    expect(switchPreset(room(), 'gamer')).toMatchObject({ preset: 'gamer', widgets: room().widgets, lighting: room().lighting });
    expect(bareRoomState(manifest, room())).toMatchObject({ widgets: room().widgets, lighting: room().lighting });
  });

  it('a room saved before widgets loads unchanged', () => {
    const back = sanitizeRoomState(manifest, defaultRoomState('cozy'));
    expect('widgets' in back).toBe(false);
    expect('lighting' in back).toBe(false);
  });
});

describe('lighting (261119)', () => {
  it('clamps, drops neutral, keeps the include-her switch alone', () => {
    expect(sanitizeLighting({ brightness: -999, dim: 300, warmth: 12.6, character: 'yes' })).toEqual({ brightness: -50, dim: 85, warmth: 13, character: false });
    expect(sanitizeLighting({ brightness: 0, dim: 0, warmth: 0 })).toBeUndefined();
    const s = defaultRoomState('cozy');
    expect('lighting' in setLighting(s, { dim: 0 })).toBe(false);
    expect(setLighting(s, { character: true }).lighting).toEqual({ ...DEFAULT_LIGHTING, character: true });
    expect('lighting' in setLighting(setLighting(s, { dim: 30 }), DEFAULT_LIGHTING)).toBe(false);
  });

  it('becomes one CSS filter: brightness times the veil, warmth as a colour matrix', () => {
    expect(lightingFilter(undefined, null)).toBeNull();
    expect(lightingFilter({ brightness: 0, dim: 50, warmth: 0, character: false }, null)).toBe('brightness(0.5)');
    expect(lightingFilter({ brightness: 20, dim: 50, warmth: 0, character: false }, null)).toBe('brightness(0.6)');
    expect(lightingFilter({ brightness: 0, dim: 0, warmth: 30, character: false }, 'url(#w)')).toBe('url(#w)');
    expect(warmthMatrix(0)).toBeNull();
    const [r, , , , , , g, , , , , , b] = warmthMatrix(50)!.split(/\s+/).map(Number);
    expect(r).toBeGreaterThan(1);
    expect(b).toBeLessThan(1);
    expect(g).toBeCloseTo(1, 1);
  });
});

describe('analytics, shape only (261119)', () => {
  it('classifies widget and lighting edits in the editor session', () => {
    const a = defaultRoomState('cozy');
    const b = addWidget(a, 'clock', 'aa').state;
    expect(classifyEdit(a, b)).toEqual(['widget_add']);
    expect(classifyEdit(b, updateWidget(b, 'aa', { x: 0.3 }))).toEqual(['widget_move']);
    expect(classifyEdit(b, updateWidget(b, 'aa', { font: 'mono', seconds: true }))).toEqual(['widget_edit']);
    expect(classifyEdit(b, removeWidget(b, 'aa'))).toEqual(['widget_remove']);
    expect(classifyEdit(a, setLighting(a, { dim: 40 }))).toEqual(['lighting']);
  });

  it('per save: which widgets changed and which settings, never their values', () => {
    const before = { widgets: [clock(), { ...clock({ id: 't1' }), kind: 'text' as const, text: 'old secret' }] };
    const after = {
      widgets: [clock({ x: 0.1, color: '#000000' }), { ...clock({ id: 't1' }), kind: 'text' as const, text: 'new secret' }, { ...clock({ id: 'd1' }), kind: 'date' as const, date: 'iso' as const }],
      lighting: { brightness: -17, dim: 44, warmth: 0, character: true },
    };
    expect(widgetChanges(before.widgets, after.widgets)).toEqual([
      { action: 'edited', kind: 'clock', changed: ['position', 'color'] },
      { action: 'edited', kind: 'text', changed: ['text'] },
      { action: 'added', kind: 'date' },
    ]);
    const events = desktopSaveEvents(before, after, { characterId: null, surface: 'desktop' });
    expect(events.map((e) => e.event)).toEqual([SEILINK_WIDGET_EVENT, SEILINK_WIDGET_EVENT, SEILINK_WIDGET_EVENT, SEILINK_LIGHTING_EVENT]);
    expect(events[0].props).toMatchObject({ action: 'edited', kind: 'clock', changed: 'color,position', widgets: 3 });
    expect(events[3].props).toMatchObject({ brightness: -20, dim: 40, warmth: 0, character: true, reset: false });
    expect(JSON.stringify(events)).not.toMatch(/secret|#000000/);
  });

  it('main rebuilds the events from the closed shapes', () => {
    expect(isSeilinkRendererEvent(SEILINK_WIDGET_EVENT)).toBe(true);
    expect(isSeilinkRendererEvent(SEILINK_LIGHTING_EVENT)).toBe(true);
    expect(sanitizeSeilinkTrack(SEILINK_WIDGET_EVENT, { action: 'edited', kind: 'text', changed: 'text,evil,size', text: 'hello', widgets: 4 })).toEqual({
      character_id: null,
      action: 'edited',
      kind: 'text',
      surface: 'app',
      changed: 'size,text',
      widgets: 4,
    });
    expect(sanitizeSeilinkTrack(SEILINK_LIGHTING_EVENT, { brightness: 33, dim: 999, warmth: 'x', character: true, extra: 1 })).toEqual({
      character_id: null,
      surface: 'app',
      brightness: 30,
      dim: 90,
      warmth: 0,
      character: true,
      reset: false,
    });
  });
});
