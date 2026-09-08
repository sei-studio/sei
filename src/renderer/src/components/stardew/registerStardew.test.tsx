/**
 * Stardew renderer surfaces (M1): the registration module wires every
 * registry, and the launch panel renders its three states (set up / waiting /
 * launch) from seeded stores. Static server renders, no jsdom (the
 * GamePackCard.test pattern).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { StardewInstallState } from '@shared/stardewIpc';
import type { WorldState } from '@shared/gameIpc';

const installState = (over: Partial<StardewInstallState> = {}): StardewInstallState => ({
  gamePath: '/Users/x/Stardew Valley/Contents/MacOS',
  candidates: ['/Users/x/Stardew Valley/Contents/MacOS', '/Applications/Stardew Valley.app/Contents/MacOS'],
  smapiInstalled: true,
  smapiVersion: '4.5.2',
  modInstalled: true,
  modVersion: '0.1.0',
  modConfig: { port: 27431, hasToken: true },
  store: 'steam',
  platform: 'darwin',
  ready: true,
  ...over,
});

beforeEach(() => {
  vi.resetModules();
  (globalThis as unknown as { window: unknown }).window = {
    sei: {
      gamePackState: vi.fn(async () => ({ kind: 'ready', root: '/r' })),
      gamePackEnsure: vi.fn(async () => ({ kind: 'ready', root: '/r' })),
      onGamePackProgress: vi.fn(() => () => undefined),
      stardewInstallState: vi.fn(async () => installState()),
      stardewInstall: vi.fn(async () => installState()),
      stardewLaunch: vi.fn(async () => ({ launched: true, via: 'launcher' })),
      onStardewInstallProgress: vi.fn(() => () => undefined),
      onMcDashboardSnapshot: vi.fn(() => () => undefined),
      onGameDashboardSnapshot: vi.fn(() => () => undefined),
      worldCheckNow: vi.fn(async () => ({ game: 'stardew', kind: 'closed' })),
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
});

async function renderLaunch(opts: { install: StardewInstallState | null; world?: WorldState; summon?: unknown }): Promise<string> {
  // Two renders in one test must not share the first render's mocked stores.
  vi.resetModules();
  const stardew = {
    state: opts.install, progress: null, installing: false, installError: null, launching: false, lastLaunch: null,
    init: vi.fn(() => () => undefined), refresh: vi.fn(async () => opts.install), install: vi.fn(), launchGame: vi.fn(),
  };
  vi.doMock('../../lib/stores/useStardewStore', () => ({
    useStardewStore: Object.assign((selector: (s: typeof stardew) => unknown) => selector(stardew), { getState: () => stardew }),
  }));
  const data = {
    summons: { c1: opts.summon ?? { kind: 'idle', characterId: 'c1' } },
    characters: [{ id: 'c1', name: 'Sui', username: null }],
    worlds: { stardew: opts.world ?? { game: 'stardew', kind: 'closed' } },
  };
  vi.doMock('../../lib/stores/useDataStore', () => ({
    useDataStore: Object.assign((selector: (s: typeof data) => unknown) => selector(data), { getState: () => data }),
  }));
  const packs = { packs: { stardew: { kind: 'ready', root: '/r' } }, refresh: vi.fn(), ensure: vi.fn(), init: vi.fn() };
  vi.doMock('../../lib/stores/useGamePackStore', () => ({
    useGamePackStore: (selector: (s: typeof packs) => unknown) => selector(packs),
  }));
  const { StardewLaunchPanel } = await import('./StardewLaunchPanel');
  return renderToStaticMarkup(React.createElement(StardewLaunchPanel, { characterId: 'c1' }));
}

describe('registerStardew', () => {
  it('registers the surfaces, the summon flow, the error routes, the settings group and the setup modal', async () => {
    await import('./registerStardew');
    const { GAME_SURFACES } = await import('../../lib/gameSurfaces');
    const { StardewLaunchPanel } = await import('./StardewLaunchPanel');
    const { StardewDashboardPanel } = await import('./StardewDashboardPanel');
    expect(GAME_SURFACES.stardew.LaunchPanel).toBe(StardewLaunchPanel);
    expect(GAME_SURFACES.stardew.DashboardPanel).toBe(StardewDashboardPanel);
    const { BOT_ERROR_ROUTES, modalForBotStatus } = await import('../../lib/botErrorRouting');
    expect(typeof BOT_ERROR_ROUTES.stardew.STARDEW_FARMHAND_NO_MOD).toBe('function');
    expect(modalForBotStatus({ kind: 'error', error: 'SMAPI_INSTALL_FAILED', message: 'x', characterId: 'c1', game: 'stardew' })).toMatchObject({ kind: 'game-error', game: 'stardew', error: 'SMAPI_INSTALL_FAILED' });
    const { GAME_SETTINGS_SECTIONS } = await import('../../lib/gameSettingsSections');
    expect(GAME_SETTINGS_SECTIONS.map((s) => s.game)).toContain('stardew');
    const { summonFlows } = await import('../../lib/summonFlow');
    expect(summonFlows.stardew.attempt).toBeDefined();
  });

  it('the summon flow parks the attempt behind the setup modal when the mod is not installed', async () => {
    (globalThis as unknown as { window: { sei: { stardewInstallState: unknown } } }).window.sei.stardewInstallState = vi.fn(async () => installState({ modInstalled: false, ready: false }));
    await import('./registerStardew');
    const { summonFlows } = await import('../../lib/summonFlow');
    const { useUiStore } = await import('../../lib/stores/useUiStore');
    await summonFlows.stardew.attempt('c1');
    const ui = useUiStore.getState();
    expect(ui.modal).toEqual({ kind: 'game-setup', game: 'stardew' });
    expect(ui.pendingSummonId).toBe('c1');
    expect(ui.pendingSummonGame).toBe('stardew');
  });
});

describe('StardewLaunchPanel states', () => {
  it('set up: the install card with the detected path and the install button', async () => {
    const html = await renderLaunch({ install: installState({ smapiInstalled: false, modInstalled: false, modConfig: null, ready: false }) });
    expect(html).toContain('data-state="setup"');
    expect(html).toContain('Set up Stardew Valley for Sei');
    expect(html).toContain('/Users/x/Stardew Valley/Contents/MacOS');
    expect(html).toContain("Install SMAPI + Sei&#x27;s helper");
    expect(html).not.toContain('>Launch<');
  });

  it('not found: lists the folders it looked in', async () => {
    const html = await renderLaunch({ install: installState({ gamePath: null, ready: false, smapiInstalled: false, modInstalled: false }) });
    expect(html).toContain('Stardew Valley was not found');
    expect(html).toContain('/Applications/Stardew Valley.app/Contents/MacOS');
    expect(html).toContain('Check again');
  });

  it('waiting: the launch-the-game button, and the title-screen variant', async () => {
    const html = await renderLaunch({ install: installState() });
    expect(html).toContain('data-state="waiting"');
    expect(html).toContain('Launch Stardew Valley (with Sei)');
    expect(html).toContain('In game as Sui');
    const title = await renderLaunch({ install: installState(), world: { game: 'stardew', kind: 'game_running_no_save', port: 27431 } });
    expect(title).toContain('Load your farm');
    expect(title).not.toContain('Launch Stardew Valley (with Sei)');
  });

  it('launch: the farm line and the summon button, and the connecting state', async () => {
    const open: WorldState = { game: 'stardew', kind: 'open', farmName: 'Sunny', uniqueId: '1', day: 3, season: 'spring', year: 1, port: 27431, lastSeenAt: 1, label: 'Sunny Farm, spring 3' };
    const html = await renderLaunch({ install: installState(), world: open });
    expect(html).toContain('data-state="launch"');
    expect(html).toContain('Sunny Farm, spring 3');
    expect(html).toContain('Sui walks in beside you');
    expect(html).toContain('>Launch<');
    const connecting = await renderLaunch({ install: installState(), world: open, summon: { kind: 'connecting', characterId: 'c1' } });
    expect(connecting).toContain('Connecting...');
  });
});
