/**
 * DstDashboardPanel (260909). Rendered with react-dom/server against seeded
 * stores (no @testing-library in this repo). Invariants:
 *   1. No snapshot -> the waiting line, nothing else.
 *   2. A snapshot -> the three HUD badges as meters with the game's values,
 *      the day in the clock, the lit phase, the survivor name, the activity
 *      line sentence-cased.
 *   3. Low meters mark themselves; a freezing body shows the warning.
 *   4. The bar shows 15 slots plus the hand slot with the held item; the
 *      item names are the in-game ones.
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
import type { DstDashboardSnapshot } from '@shared/dstIpc';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ID = 'c1';

const SNAP: DstDashboardSnapshot = {
  game: 'dontstarve',
  characterId: ID,
  ts: 1,
  activity: 'gathering twigs...',
  actionName: 'gather',
  x: 112.4,
  z: -38.9,
  health: 96,
  healthMax: 125,
  hunger: 41,
  hungerMax: 150,
  sanity: 188,
  sanityMax: 250,
  temperature: 24,
  held: 'axe',
  items: [
    { prefab: 'twigs', count: 14 },
    { prefab: 'cutgrass', count: 9 },
    { prefab: 'goldnugget', count: 1 },
  ],
  day: 7,
  season: 'autumn',
  phase: 'dusk',
  prefab: 'wickerbottom',
};

beforeEach(() => {
  vi.resetModules();
  (globalThis as unknown as { window: unknown }).window = {
    sei: {
      gameDashboardSetWatching: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
});

async function render(snapshot: DstDashboardSnapshot | null, controls?: { paused: boolean; mode: 'reactive' | 'proactive' }): Promise<string> {
  vi.resetModules();
  const dash = {
    gameSnapshots: { [ID]: snapshot },
    controls: { [ID]: controls },
    setPaused: vi.fn(),
    setMode: vi.fn(),
    setLaunch: vi.fn(),
    setWatching: vi.fn(),
  };
  const data = { characters: [{ id: ID, name: 'Sui' }], setStatus: vi.fn() };
  vi.doMock('../../lib/stores/useMcDashboardStore', () => ({
    useMcDashboardStore: Object.assign((selector: (s: typeof dash) => unknown) => selector(dash), { getState: () => dash, setState: vi.fn() }),
  }));
  vi.doMock('../../lib/stores/useDataStore', () => ({
    useDataStore: Object.assign((selector: (s: typeof data) => unknown) => selector(data), { getState: () => data }),
  }));
  const { DstDashboardPanel } = await import('./DstDashboardPanel');
  return renderToStaticMarkup(React.createElement(DstDashboardPanel, { characterId: ID }));
}

describe('DstDashboardPanel', () => {
  it('Test 1: no snapshot shows the waiting line only', async () => {
    const html = await render(null);
    expect(html).toContain('Waiting for Sui...');
    expect(html).not.toContain('role="meter"');
  });

  it('Test 2: the badges, the clock, the survivor and the activity line', async () => {
    const html = await render(SNAP);
    expect(html).toContain('aria-label="Health" aria-valuemin="0" aria-valuemax="125" aria-valuenow="96"');
    expect(html).toContain('aria-label="Hunger" aria-valuemin="0" aria-valuemax="150" aria-valuenow="41"');
    expect(html).toContain('aria-label="Sanity" aria-valuemin="0" aria-valuemax="250" aria-valuenow="188"');
    expect(html).toContain('Wickerbottom');
    expect(html).toContain('Gathering twigs...');
    expect(html).toContain('data-season="autumn" data-phase="dusk"');
    // 16 clock segments, the 4 dusk ones lit.
    expect(html.match(/data-phase="(day|dusk|night)" d="M/g)).toHaveLength(16);
    expect(html.match(/segLit[^>]*data-phase="dusk"/g)).toHaveLength(4);
    expect(html).toContain('>7</text>');
    expect(html).toContain('Dusk');
    expect(html).toContain('24 degrees');
  });

  it('Test 3: low meters mark themselves and a freezing body warns', async () => {
    const html = await render({ ...SNAP, health: 20, temperature: -2 });
    expect(html).toContain('badgeLow');
    expect(html).toContain('data-band="freezing"');
    expect(html).toContain('Freezing');
    const fine = await render(SNAP);
    expect(fine).not.toContain('Freezing');
    expect(fine).not.toContain('badgeLow');
  });

  it('Test 4: fifteen slots, the hand slot, in-game item names', async () => {
    const html = await render(SNAP);
    // 15 bar slots + 1 hand slot.
    expect(html.match(/data-slot="/g)).toHaveLength(16);
    expect(html).toContain('Cut Grass');
    expect(html).toContain('Gold Nugget');
    expect(html).toContain('>14<');
    expect(html).toContain('slotHeld');
    expect(html).toContain('title="Axe"');
    expect(html).toContain('at 112, -39');
  });

  it('Test 5: paused replaces the activity line', async () => {
    const html = await render(SNAP, { paused: true, mode: 'reactive' });
    expect(html).toContain('Paused');
    expect(html).not.toContain('Gathering twigs...');
    expect(html).toContain('>Resume<');
  });

  it('Test 6: every t() key in the panel has a zh entry and no em dash', async () => {
    const src = readFileSync(resolve(__dirname, 'DstDashboardPanel.tsx'), 'utf8');
    const keys = [...src.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\'/g, "'"));
    const dq = [...src.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
    const { GAME_CONTROL_DESCRIPTIONS } = await import('../games/useGameControls');
    const all = [...keys, ...dq, ...Object.values(GAME_CONTROL_DESCRIPTIONS)];
    expect(all.length).toBeGreaterThanOrEqual(20);
    const { ZH } = await import('../../lib/i18n/zh');
    for (const k of all) {
      expect(k, `em dash in "${k}"`).not.toContain('—');
      expect(ZH[k], `missing zh entry for "${k}"`).toBeTypeOf('string');
      expect(ZH[k]).not.toContain('—');
    }
  });
});
