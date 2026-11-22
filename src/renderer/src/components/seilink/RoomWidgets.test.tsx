import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { newWidget, type RoomWidget } from '@shared/seilinkWidgets';
import { RoomWidgets, startWidgetTicker, widgetLocale } from './RoomWidgets';

vi.mock('../../lib/ipcClient', () => ({ sei: {} }));

const at = new Date(2026, 10, 19, 21, 41, 7);
const clock = (): Date => at;

describe('RoomWidgets (261119)', () => {
  it('draws each widget at its anchor, sized from the box height', () => {
    const c: RoomWidget = { ...newWidget('clock', 'c1'), x: 0.25, y: 0.5, date: 'long' };
    const html = renderToStaticMarkup(<RoomWidgets widgets={[c]} width={1000} height={600} running={false} clock={clock} />);
    expect(html).toContain('data-widget-id="c1"');
    expect(html).toContain('left:250px');
    expect(html).toContain('top:300px');
    expect(html).toContain(`font-size:${(c.size / 1000) * 600}px`);
    expect(html).toContain('9:41');
    expect(html).toContain('Thursday, November 19');
  });

  it('the clock draws in its own colour, weight and size (product call 261120)', () => {
    const c: RoomWidget = { ...newWidget('clock', 'c1'), color: '#ffd28a', weight: 700, size: 200 };
    const html = renderToStaticMarkup(<RoomWidgets widgets={[c]} width={1000} height={500} running={false} clock={clock} />);
    expect(html).toContain('color:#ffd28a');
    expect(html).toContain('font-weight:700');
    expect(html).toContain('font-size:100px');
  });

  it('a text line shows its placeholder only in the editor; progress shows the day', () => {
    const t = newWidget('text', 't1');
    const p = newWidget('progress', 'p1');
    const live = renderToStaticMarkup(<RoomWidgets widgets={[t, p]} width={800} height={450} running={false} clock={clock} />);
    expect(live).not.toContain('Your text here');
    expect(live).toContain('Today');
    expect(live).toContain('90%');
    const edit = renderToStaticMarkup(<RoomWidgets widgets={[t]} width={800} height={450} running={false} clock={clock} editing selected="t1" />);
    expect(edit).toContain('Your text here');
  });

  it('nothing at all without widgets or a box', () => {
    expect(renderToStaticMarkup(<RoomWidgets widgets={[]} width={800} height={450} running={false} />)).toBe('');
    expect(renderToStaticMarkup(<RoomWidgets widgets={[newWidget('date', 'd')]} width={0} height={0} running={false} />)).toBe('');
  });

  it('formats in the system variant of the UI language', () => {
    expect(widgetLocale('en', 'en-GB')).toBe('en-GB');
    expect(widgetLocale('en', 'fr-FR')).toBe('en-US');
    expect(widgetLocale('ja', 'en-US')).toBe('ja-JP');
  });
});

describe('the widget ticker (261119)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ticks just past each minute boundary, one timer, and stops cleanly', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 19, 12, 0, 20));
    const seen: string[] = [];
    const stop = startWidgetTicker('minute', () => new Date(), (d) => seen.push(`${d.getMinutes()}:${d.getSeconds()}`));
    vi.advanceTimersByTime(39_000);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(2_000);
    expect(seen).toEqual(['1:0']);
    vi.advanceTimersByTime(60_000 * 3);
    expect(seen).toEqual(['1:0', '2:0', '3:0', '4:0']);
    expect(vi.getTimerCount()).toBe(1);
    stop();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(120_000);
    expect(seen).toHaveLength(4);
  });

  it('ticks every second when seconds show, without drifting', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 19, 12, 0, 0, 400));
    const seen: number[] = [];
    const stop = startWidgetTicker('second', () => new Date(), (d) => seen.push(d.getSeconds()));
    vi.advanceTimersByTime(10_000);
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    stop();
  });
});




