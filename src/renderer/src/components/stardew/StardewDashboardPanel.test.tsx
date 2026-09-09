/**
 * StardewDashboardPanel (260909). Rendered with react-dom/server against
 * seeded stores (no @testing-library in this repo). Invariants:
 *   1. No snapshot -> the waiting line, nothing else.
 *   2. A snapshot -> the two HUD bars as meters, the date box (weekday from
 *      the day number, the HUD time, the season and weather names), the gold
 *      box, the activity line sentence-cased.
 *   3. A low bar changes tone.
 *   4. 36 slots, the held item framed, counts shown.
 *   5. Paused replaces the activity line.
 *   6. Every user-facing string the panel emits has a zh entry, and none
 *      carries an em dash.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { StardewDashboardSnapshot } from '@shared/stardewIpc';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ID = 'c1';

const SNAP: StardewDashboardSnapshot = {
  game: 'stardew',
  characterId: ID,
  ts: 1,
  location: 'Farm',
  x: 62,
  y: 18,
  stamina: 172,
  maxStamina: 270,
  health: 100,
  maxHealth: 100,
  gold: 1250,
  held: 'Watering Can',
  items: [
    { slot: 0, name: 'Axe', count: 1, kind: 'tool' },
    { slot: 2, name: 'Watering Can', count: 1, kind: 'tool' },
    { slot: 6, name: 'Wood', count: 38, kind: 'resource' },
  ],
  activity: 'watering the crops...',
  actionName: 'water',
  day: 3,
  season: 'spring',
  year: 1,
  time: 1330,
  timeText: '1:30 PM',
  weather: 'rain',
  paused: false,
  sleeping: false,
};

beforeEach(() => {
  vi.resetModules();
  (globalThis as unknown as { window: unknown }).window = {
    sei: {
      gameDashboardGet: vi.fn(async () => null),
      stop: vi.fn(async () => undefined),
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
});

async function render(snapshot: StardewDashboardSnapshot | null, controls?: { paused: boolean; mode: 'reactive' | 'proactive' }): Promise<string> {
  vi.resetModules();
  const dash = {
    gameSnapshots: { [ID]: snapshot },
    controls: { [ID]: controls },
    setPaused: vi.fn(),
    setMode: vi.fn(),
    setLaunch: vi.fn(),
    setWatching: vi.fn(),
  };
  const data = { characters: [{ id: ID, name: 'Marv' }], setStatus: vi.fn() };
  vi.doMock('../../lib/stores/useMcDashboardStore', () => ({
    useMcDashboardStore: Object.assign((selector: (s: typeof dash) => unknown) => selector(dash), { getState: () => dash, setState: vi.fn() }),
  }));
  vi.doMock('../../lib/stores/useDataStore', () => ({
    useDataStore: Object.assign((selector: (s: typeof data) => unknown) => selector(data), { getState: () => data }),
  }));
  const { StardewDashboardPanel } = await import('./StardewDashboardPanel');
  return renderToStaticMarkup(React.createElement(StardewDashboardPanel, { characterId: ID }));
}

describe('StardewDashboardPanel', () => {
  it('Test 1: no snapshot shows the waiting line only', async () => {
    const html = await render(null);
    expect(html).toContain('Waiting for Marv...');
    expect(html).not.toContain('role="meter"');
  });

  it('Test 2: the bars, the date box, the gold box and the activity line', async () => {
    const html = await render(SNAP);
    expect(html).toContain('aria-label="Energy 172 of 270" aria-valuemin="0" aria-valuemax="270" aria-valuenow="172"');
    expect(html).toContain('aria-label="Health 100 of 100" aria-valuemin="0" aria-valuemax="100" aria-valuenow="100"');
    expect(html).toContain('height:64%');
    expect(html).toContain('Wed. 3');
    expect(html).toContain('1:30 pm');
    expect(html).toContain('Spring, year 1');
    expect(html).toContain('title="Rain"');
    expect(html).toContain('1,250g');
    expect(html).toContain('Watering the crops...');
    expect(html).toContain('Farm 62, 18');
  });

  it('Test 3: a low bar changes tone', async () => {
    const html = await render({ ...SNAP, stamina: 20 });
    expect(html).toContain('data-kind="energy" data-tone="critical"');
    expect(html).toContain('data-kind="health" data-tone="full"');
  });

  it('Test 4: 36 slots, the held item framed, counts shown', async () => {
    const html = await render(SNAP);
    expect(html.match(/data-slot="/g)).toHaveLength(36);
    expect(html.match(/slotHeld/g)).toHaveLength(1);
    expect(html).toContain('title="Watering Can x1"');
    expect(html).toContain('>38<');
    expect(html).toContain('grid-template-columns:repeat(12, 40px)');
  });

  it('Test 5: paused replaces the activity line', async () => {
    const html = await render(SNAP, { paused: true, mode: 'proactive' });
    expect(html).toContain('Paused');
    expect(html).not.toContain('Watering the crops...');
    expect(html).toContain('>Resume<');
  });

  it('Test 6: every t() key in the panel has a zh entry and no em dash', async () => {
    const src = readFileSync(resolve(__dirname, 'StardewDashboardPanel.tsx'), 'utf8');
    const keys = [...src.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\'/g, "'"));
    const dq = [...src.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
    const helpers = await import('./stardewDashboard');
    const { GAME_CONTROL_DESCRIPTIONS } = await import('../games/useGameControls');
    const all = [
      ...keys,
      ...dq,
      ...Object.values(GAME_CONTROL_DESCRIPTIONS),
      ...Object.values(helpers.SEASON_LABEL),
      ...Object.values(helpers.WEATHER_LABEL),
      ...helpers.STARDEW_WEEKDAYS,
    ];
    expect(all.length).toBeGreaterThanOrEqual(30);
    const { ZH } = await import('../../lib/i18n/zh');
    for (const k of all) {
      expect(k, `em dash in "${k}"`).not.toContain('—');
      expect(ZH[k], `missing zh entry for "${k}"`).toBeTypeOf('string');
      expect(ZH[k]).not.toContain('—');
    }
  });
});
