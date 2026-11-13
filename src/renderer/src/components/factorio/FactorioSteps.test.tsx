/**
 * useFactorioSetupSteps + FactorioLaunchPanel + useFactorioStore (261113).
 * Static renders over mocked stores. Invariants:
 *   1. Game found, mod missing: the window opens on the mod step with "Add
 *      the Sei mod"; the panel offers "Set up", no help link.
 *   2. Mod in: complete; the window opens on the launch step with "Launch
 *      Factorio"; the panel reads Launch with the help link.
 *   3. Factorio holds the link (no_game): the load step with the waiting line;
 *      open: "Your game is loaded."
 *   4. Unsupported version and not found read as the game step; a port
 *      failure and a running unlinked game read as the launch step.
 *   5. The token list renders all four steps.
 *   6. A refresh clears a failure only once what failed is fixed.
 *   7. Every t() key in the files has a zh entry and no em dash.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { FactorioSetupState, FactorioWorldState } from '@shared/factorioIpc';

const __dirname = dirname(fileURLToPath(import.meta.url));

const FOUND: FactorioSetupState = {
  kind: 'found',
  install: { binary: 'C:\\Program Files\\Factorio\\bin\\x64\\factorio.exe', store: 'standalone', version: '2.1.4', supported: true },
  others: [],
  userDataDir: 'C:\\Users\\you\\AppData\\Roaming\\Factorio',
  modsDir: 'C:\\Users\\you\\AppData\\Roaming\\Factorio\\mods',
  modInstalled: false,
  modVersion: null,
  modEnabled: true,
  gameRunning: false,
  port: null,
  portInUse: false,
};
const READY: FactorioSetupState = { ...FOUND, modInstalled: true, modVersion: '0.1.0' };
const CLOSED: FactorioWorldState = { game: 'factorio', kind: 'closed' };

beforeEach(() => {
  vi.resetModules();
  (globalThis as unknown as { window: unknown }).window = {
    sei: {
      gamePackState: vi.fn(async () => ({ kind: 'ready', root: '/r' })),
      gamePackEnsure: vi.fn(async () => ({ kind: 'ready', root: '/r' })),
      onGamePackProgress: vi.fn(() => () => undefined),
      factorioSetupState: vi.fn(async () => FOUND),
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
});

async function mockStores(setup: FactorioSetupState | null, world: FactorioWorldState = CLOSED): Promise<void> {
  vi.resetModules();
  const fct = { setup, installBusy: false, launching: false, failure: null, launchedAt: null, refresh: vi.fn(async () => setup), runInstall: vi.fn(), launchGame: vi.fn() };
  vi.doMock('./useFactorioStore', () => ({
    useFactorioStore: Object.assign((selector: (s: typeof fct) => unknown) => selector(fct), { getState: () => fct }),
  }));
  const data = { summons: { c1: { kind: 'idle', characterId: 'c1' } }, characters: [{ id: 'c1', name: 'Sui' }], worlds: { factorio: world } };
  vi.doMock('../../lib/stores/useDataStore', () => ({
    useDataStore: Object.assign((selector: (s: typeof data) => unknown) => selector(data), { getState: () => data }),
  }));
  const packs = { packs: { factorio: { kind: 'ready', root: '/r' } }, refresh: vi.fn(), ensure: vi.fn(), init: vi.fn() };
  vi.doMock('../../lib/stores/useGamePackStore', () => ({
    useGamePackStore: (selector: (s: typeof packs) => unknown) => selector(packs),
  }));
}

async function renderSteps(setup: FactorioSetupState | null, world: FactorioWorldState = CLOSED): Promise<string> {
  await mockStores(setup, world);
  const { useFactorioSetupSteps } = await import('./FactorioSteps');
  const { SetupStepper } = await import('../games/SetupStepper');
  const skin = {
    actions: 'actions', sub: 'sub', mono: 'mono', link: 'link',
    Button: ({ children, disabled }: { children: React.ReactNode; disabled?: boolean }) => React.createElement('button', { disabled }, children),
  };
  function Harness(): React.ReactElement {
    const s = useFactorioSetupSteps(skin);
    return React.createElement(
      'div',
      { 'data-complete': String(s.complete) },
      React.createElement(SetupStepper, { steps: s.steps, mode: 'setup', onClose: () => undefined, label: 'steps' }),
    );
  }
  return renderToStaticMarkup(React.createElement(Harness));
}

async function renderPanel(setup: FactorioSetupState | null, world: FactorioWorldState = CLOSED): Promise<string> {
  await mockStores(setup, world);
  const { FactorioLaunchPanel } = await import('./FactorioLaunchPanel');
  return renderToStaticMarkup(React.createElement(FactorioLaunchPanel, { characterId: 'c1' }));
}

// The first test pays for the cold import of the launch panel's module graph.
describe('useFactorioSetupSteps + FactorioLaunchPanel', { timeout: 30_000 }, () => {
  it('Test 1: mod missing: the mod step; the panel offers Set up', async () => {
    const steps = await renderSteps(FOUND);
    expect(steps).toContain('data-step="mod"');
    expect(steps).toContain('>Add the Sei mod<');
    expect(steps).toContain('data-complete="false"');
    const panel = await renderPanel(FOUND);
    expect(panel).toContain('>Set up<');
    expect(panel).not.toContain('How do I set up launch?');
  });

  it('Test 2: mod in: the launch step; the panel reads Launch with the help link', async () => {
    const steps = await renderSteps(READY);
    expect(steps).toContain('data-step="run"');
    expect(steps).toContain('>Launch Factorio<');
    expect(steps).toContain('data-complete="true"');
    const panel = await renderPanel(READY);
    expect(panel).toContain('>Launch<');
    expect(panel).toContain('How do I set up launch?');
  });

  it('Test 3: linked, then loaded', async () => {
    const linked = await renderSteps(READY, { game: 'factorio', kind: 'no_game', port: 34990 });
    expect(linked).toContain('data-step="load"');
    expect(linked).toContain('Waiting for your game...');
    const open: FactorioWorldState = {
      game: 'factorio', kind: 'open', label: 'Factorio', port: 34990, lastSeenAt: 1,
      detail: { players: [{ i: 1, name: 'ouen' }], multiplayer: false, world: '1-60', paused: false },
    };
    const panel = await renderPanel(READY, open);
    expect(panel).toContain('Your game is loaded.');
    const paused = await renderPanel(READY, { ...open, detail: { ...open.detail, paused: true } });
    expect(paused).toContain('Your game is loaded and paused.');
  });

  it('Test 4: the game step and the launch step problems', async () => {
    const old = await renderSteps({ ...FOUND, install: { ...FOUND.install, version: '2.0.72', supported: false } });
    expect(old).toContain('data-step="game"');
    expect(old).toContain('This computer has Factorio 2.0.72.');
    const none = await renderSteps({ kind: 'not_found', searched: ['/Applications/factorio.app/Contents/MacOS/factorio'] });
    expect(none).toContain('/Applications/factorio.app/Contents/MacOS/factorio');
    const port = await renderSteps(READY, { game: 'factorio', kind: 'unavailable', reason: 'udp_port_in_use' });
    expect(port).toContain('Factorio could not open the Sei link.');
    const unlinked = await renderSteps({ ...READY, gameRunning: true });
    expect(unlinked).toContain('it was not started from Sei');
  });

  it('Test 5: the token list renders all four steps', async () => {
    await mockStores(FOUND);
    const { FactorioSteps } = await import('./FactorioSteps');
    const html = renderToStaticMarkup(React.createElement(FactorioSteps));
    expect(html).toContain('Factorio 2.1.4 is installed.');
    expect(html).toContain('>02<');
    expect(html).toContain('>04<');
    expect(html).toContain('aria-current="step"');
  });

  it('Test 6: a refresh clears a failure only once it is fixed', async () => {
    vi.doUnmock('./useFactorioStore');
    vi.resetModules();
    const { failureAfterRefresh } = await import('./useFactorioStore');
    const running = { action: 'install' as const, reason: 'game_running' as const, message: 'x' };
    expect(failureAfterRefresh(running, { ...FOUND, gameRunning: true })).toBe(running);
    expect(failureAfterRefresh(running, FOUND)).toBeNull();
    const failed = { action: 'launch' as const, reason: 'failed' as const, message: 'spawn ENOENT' };
    expect(failureAfterRefresh(failed, READY)).toBe(failed);
    expect(failureAfterRefresh(null, READY)).toBeNull();
  });

  it('Test 7: every t() key has a zh entry and no em dash', async () => {
    const all: string[] = [];
    for (const file of ['FactorioSteps.tsx', 'FactorioLaunchPanel.tsx', 'FactorioSetupBody.tsx']) {
      const src = readFileSync(resolve(__dirname, file), 'utf8');
      all.push(...[...src.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\'/g, "'")));
      all.push(...[...src.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]));
    }
    expect(all.length).toBeGreaterThanOrEqual(30);
    const { ZH } = await import('../../lib/i18n/zh');
    for (const k of all) {
      expect(k, `em dash in "${k}"`).not.toContain('—');
      expect(ZH[k], `missing zh entry for "${k}"`).toBeTypeOf('string');
    }
  });
});
