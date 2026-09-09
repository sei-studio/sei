/**
 * useDstSetupSteps + DstLaunchPanel (260909). Static renders over a mocked
 * install store. Invariants:
 *   1. Game found, helper missing: the window opens on the helper step
 *      with "Add Sei's helper"; the panel offers "Set up", no help link.
 *   2. Helper in: complete; the window opens on the game step with the
 *      launch button; the panel reads Launch with the help link and the
 *      in-game name line.
 *   3. Game running with the helper: the host step, with the waiting line.
 *   4. The token list (the setup modal body) renders all four steps.
 *   5. Every t() key in the two files has a zh entry and no em dash.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { DstInstallState } from '@shared/dstIpc';

const __dirname = dirname(fileURLToPath(import.meta.url));

const FOUND: DstInstallState = {
  kind: 'found', installPath: '/Applications/dontstarve_steam.app', modsDir: '/Applications/dontstarve_steam.app/Contents/mods',
  modInstalled: false, modVersion: null, enabled: false, gameRunning: false, needsRestart: false,
};

beforeEach(() => {
  vi.resetModules();
  (globalThis as unknown as { window: unknown }).window = {
    sei: {
      gamePackState: vi.fn(async () => ({ kind: 'ready', root: '/r' })),
      gamePackEnsure: vi.fn(async () => ({ kind: 'ready', root: '/r' })),
      onGamePackProgress: vi.fn(() => () => undefined),
      dstInstallState: vi.fn(async () => FOUND),
      onDstInstallProgress: vi.fn(() => () => undefined),
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
});

async function mockStores(install: DstInstallState | null, worldOpen = false): Promise<void> {
  vi.resetModules();
  const dst = {
    install, installBusy: false, launching: false,
    survivors: { c1: { prefab: 'wickerbottom', source: 'auto', reason: 'She reads.' } }, survivorBusy: {},
    refreshInstall: vi.fn(async () => install), runInstall: vi.fn(), launchGame: vi.fn(), openAppManagement: vi.fn(),
    loadSurvivor: vi.fn(), setSurvivor: vi.fn(),
  };
  vi.doMock('./useDstStore', () => ({
    useDstStore: Object.assign((selector: (s: typeof dst) => unknown) => selector(dst), { getState: () => dst }),
  }));
  const data = {
    summons: { c1: { kind: 'idle', characterId: 'c1' } },
    characters: [{ id: 'c1', name: 'Sui' }],
    worlds: { dontstarve: worldOpen ? { game: 'dontstarve', kind: 'open', worldName: 'Camp', day: 4, season: 'autumn', phase: 'day', port: 1, lastSeenAt: 1 } : { game: 'dontstarve', kind: 'closed' } },
  };
  vi.doMock('../../lib/stores/useDataStore', () => ({
    useDataStore: Object.assign((selector: (s: typeof data) => unknown) => selector(data), { getState: () => data }),
  }));
  const packs = { packs: { dontstarve: { kind: 'ready', root: '/r' } }, refresh: vi.fn(), ensure: vi.fn(), init: vi.fn() };
  vi.doMock('../../lib/stores/useGamePackStore', () => ({
    useGamePackStore: (selector: (s: typeof packs) => unknown) => selector(packs),
  }));
}

async function renderSteps(install: DstInstallState | null, worldOpen = false): Promise<string> {
  await mockStores(install, worldOpen);
  const { useDstSetupSteps } = await import('./DstSteps');
  const { SetupStepper } = await import('../games/SetupStepper');
  const skin = {
    actions: 'actions', sub: 'sub', mono: 'mono', link: 'link',
    Button: ({ children, disabled }: { children: React.ReactNode; disabled?: boolean }) => React.createElement('button', { disabled }, children),
  };
  function Harness(): React.ReactElement {
    const s = useDstSetupSteps(skin);
    return React.createElement(
      'div',
      { 'data-complete': String(s.complete) },
      React.createElement(SetupStepper, { steps: s.steps, mode: 'setup', onClose: () => undefined, label: 'steps' }),
    );
  }
  return renderToStaticMarkup(React.createElement(Harness));
}

async function renderPanel(install: DstInstallState | null): Promise<string> {
  await mockStores(install);
  const { DstLaunchPanel } = await import('./DstLaunchPanel');
  return renderToStaticMarkup(React.createElement(DstLaunchPanel, { characterId: 'c1' }));
}

describe('useDstSetupSteps + DstLaunchPanel', () => {
  it('Test 1: helper missing: the helper step; the panel offers Set up', async () => {
    const steps = await renderSteps(FOUND);
    expect(steps).toContain('data-step="helper"');
    expect(steps).toContain("Add Sei&#x27;s helper");
    expect(steps).toContain('data-complete="false"');
    const panel = await renderPanel(FOUND);
    expect(panel).toContain('>Set up<');
    expect(panel).not.toContain('How do I set up launch?');
    expect(panel).toContain('wants to play as Wickerbottom');
  });

  it('Test 2: helper in: the game step; the panel reads Launch with the help link', async () => {
    const ready = { ...FOUND, modInstalled: true, modVersion: '0.2.0', enabled: true };
    const steps = await renderSteps(ready);
    expect(steps).toContain('data-step="run"');
    expect(steps).toContain("Launch Don&#x27;t Starve Together");
    expect(steps).toContain('data-complete="true"');
    const panel = await renderPanel(ready);
    expect(panel).toContain('>Launch<');
    expect(panel).toContain('How do I set up launch?');
    expect(panel).toContain('will appear as');
  });

  it('Test 3: game running with the helper: the host step with the waiting line', async () => {
    const running = { ...FOUND, modInstalled: true, modVersion: '0.2.0', enabled: true, gameRunning: true };
    const steps = await renderSteps(running);
    expect(steps).toContain('data-step="host"');
    expect(steps).toContain('Host a world');
    expect(steps).toContain('Waiting for your world...');
    const open = await renderSteps(running, true);
    expect(open).toContain('Your world is open: Camp, day 4.');
  });

  it('Test 4: the token list renders all four steps', async () => {
    await mockStores(FOUND);
    const { DstSteps } = await import('./DstSteps');
    const html = renderToStaticMarkup(React.createElement(DstSteps));
    expect(html).toContain("Don&#x27;t Starve Together is installed.");
    expect(html).toContain('>02<');
    expect(html).toContain('>04<');
    expect(html).toContain('aria-current="step"');
  });

  it('Test 5: every t() key has a zh entry and no em dash', async () => {
    const all: string[] = [];
    for (const file of ['DstSteps.tsx', 'DstLaunchPanel.tsx']) {
      const src = readFileSync(resolve(__dirname, file), 'utf8');
      all.push(...[...src.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\'/g, "'")));
      all.push(...[...src.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]));
    }
    expect(all.length).toBeGreaterThanOrEqual(20);
    const { ZH } = await import('../../lib/i18n/zh');
    for (const k of all) {
      expect(k, `em dash in "${k}"`).not.toContain('—');
      expect(ZH[k], `missing zh entry for "${k}"`).toBeTypeOf('string');
      expect(ZH[k]).not.toContain('—');
    }
  });
});
