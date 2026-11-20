import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { newWidget, type RoomWidget } from '@shared/seilinkWidgets';
import { LightingPanel, WidgetsPanel } from './RoomDesktopPanels';

vi.mock('../../lib/ipcClient', () => ({ sei: {} }));

const noop = (): void => {};
const widgets: RoomWidget[] = [{ ...newWidget('clock', 'c1'), date: 'long' }, newWidget('date', 'd1'), { ...newWidget('text', 't1'), text: 'one thing at a time' }];
const panel = (selected: string | null): string =>
  renderToStaticMarkup(<WidgetsPanel widgets={widgets} selected={selected} onSelect={noop} onAdd={noop} onChange={noop} onRemove={noop} onGestureEnd={noop} />);
const count = (html: string, s: string): number => html.split(s).length - 1;

describe('Utilities panel (product call 261120)', () => {
  it('nothing selected: the heading, one plain row per widget and a closed Add row, no settings', () => {
    const html = panel(null);
    expect(html).toContain('>Utilities</h2>');
    expect(html).not.toContain('Add to your desktop');
    // No add tiles next to the list: the kinds only show once Add is opened.
    expect(count(html, 'data-add-widget=')).toBe(0);
    expect(html).toMatch(/aria-expanded="false" data-add-open=""/);
    expect(count(html, 'data-widget-item=')).toBe(3);
    expect(html).toContain('>Clock</span>');
    expect(html).toContain('>one thing at a time</span>');
    expect(html).not.toContain('data-widget-settings');
    expect(html).not.toContain('aria-label="Remove"');
  });

  it('a selected clock opens under its own row, each format choice once, with font, weight, color and size', () => {
    const html = panel('c1');
    expect(count(html, 'data-widget-settings=')).toBe(1);
    // Its settings sit inside its own list item, before the next row.
    const item = html.slice(html.indexOf('data-widget-item="c1"'), html.indexOf('data-widget-item="d1"'));
    expect(item).toContain('data-widget-settings="clock"');
    expect(item).toContain('aria-label="Remove"');
    expect(item).toContain('aria-expanded="true"');
    // Switches only: no preset chips repeating them.
    for (const label of ['24-hour', 'Seconds', 'Leading zero', 'AM/PM', 'Date below']) expect(count(item, `<span>${label}</span>`)).toBe(1);
    expect(item).not.toContain('09:41 PM');
    expect(count(item, 'aria-label="Date format"')).toBe(1);
    for (const label of ['Font', 'Weight', 'Color']) expect(item).toContain(`role="group" aria-label="${label}"`);
    expect(item).toContain('aria-label="Size"');
    expect(item).toContain('font-weight:700');
  });

  it('with nothing placed the four kinds show straight away, and no Add row', () => {
    const html = renderToStaticMarkup(<WidgetsPanel widgets={[]} selected={null} onSelect={noop} onAdd={noop} onChange={noop} onRemove={noop} onGestureEnd={noop} />);
    expect(count(html, 'data-add-widget=')).toBe(4);
    expect(html).not.toContain('data-add-open');
  });

  it('the date choice only shows while the clock has its date on', () => {
    const off = renderToStaticMarkup(
      <WidgetsPanel widgets={[newWidget('clock', 'c1')]} selected="c1" onSelect={noop} onAdd={noop} onChange={noop} onRemove={noop} onGestureEnd={noop} />,
    );
    expect(off).not.toContain('aria-label="Date format"');
  });
});

describe('Lighting panel (product call 261120)', () => {
  it('sliders show their name and value only, no end words or helper line', () => {
    const html = renderToStaticMarkup(<LightingPanel lighting={{ brightness: -10, dim: 45, warmth: 0, character: false }} onChange={noop} onReset={noop} onGestureEnd={noop} />);
    for (const gone of ['Darker', 'Brighter', 'Cooler', 'Warmer', 'stand out']) expect(html).not.toContain(gone);
    expect(html).toContain('Brightness');
    expect(html).toContain('-10');
    expect(html).toContain('45%');
    expect(html).toContain('Include the character');
    expect(html).toContain('Reset');
  });
});
