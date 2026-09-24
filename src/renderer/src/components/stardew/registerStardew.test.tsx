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

async function mockPanelStores(opts: { install: StardewInstallState | null; world?: WorldState; summon?: unknown }): Promise<void> {
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
}

async function renderLaunch(opts: { install: StardewInstallState | null; world?: WorldState; summon?: unknown }): Promise<string> {
  await mockPanelStores(opts);
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

describe('StardewLaunchPanel states (260909: one-step window, Set up / Launch)', () => {
  async function renderSteps(opts: { install: StardewInstallState | null; world?: WorldState }): Promise<string> {
    await mockPanelStores(opts);
    const { useStardewSetupSteps } = await import('./StardewSteps');
    const { SetupStepper } = await import('../games/SetupStepper');
    const skin = {
      actions: 'actions', sub: 'sub', mono: 'mono', link: 'link',
      Button: ({ children, disabled }: { children: React.ReactNode; disabled?: boolean }) => React.createElement('button', { disabled }, children),
    };
    function Harness(): React.ReactElement {
      const s = useStardewSetupSteps(skin);
      return React.createElement('div', { 'data-complete': String(s.complete) }, React.createElement(SetupStepper, { steps: s.steps, mode: 'setup', onClose: () => undefined, label: 'steps' }));
    }
    return renderToStaticMarkup(React.createElement(Harness));
  }

  it('set up: the helper step with the detected path context and the install button; the panel offers Set up', async () => {
    const install = installState({ smapiInstalled: false, modInstalled: false, modConfig: null, ready: false });
    const steps = await renderSteps({ install });
    expect(steps).toContain('data-step="helper"');
    expect(steps).toContain("Install SMAPI + Sei&#x27;s helper");
    expect(steps).toContain('data-complete="false"');
    const panel = await renderLaunch({ install });
    expect(panel).toContain('>Set up<');
    expect(panel).not.toContain('>Launch<');
    expect(panel).not.toContain('How do I set up launch?');
  });

  it('not found: step 1 lists the folders it looked in', async () => {
    const steps = await renderSteps({ install: installState({ gamePath: null, ready: false, smapiInstalled: false, modInstalled: false }) });
    expect(steps).toContain('data-step="game"');
    expect(steps).toContain('/Applications/Stardew Valley.app/Contents/MacOS');
    expect(steps).toContain('Check again');
  });

  it('waiting: the farm step with the launch-the-game button, and the title-screen variant; the panel reads Launch', async () => {
    const steps = await renderSteps({ install: installState() });
    expect(steps).toContain('data-step="farm"');
    expect(steps).toContain('Launch Stardew Valley (with Sei)');
    expect(steps).toContain('Waiting for your farm...');
    const title = await renderSteps({ install: installState(), world: { game: 'stardew', kind: 'game_running_no_save', port: 27431 } });
    expect(title).toContain('Load the farm you want to play on');
    expect(title).not.toContain('Launch Stardew Valley (with Sei)');
    const panel = await renderLaunch({ install: installState() });
    expect(panel).toContain('>Launch<');
    expect(panel).toContain('In game as Sui');
    expect(panel).toContain('How do I set up launch?');
  });

  it('launch: the open farm line, and the connecting state', async () => {
    const open: WorldState = { game: 'stardew', kind: 'open', farmName: 'Sunny', uniqueId: '1', day: 3, season: 'spring', year: 1, port: 27431, lastSeenAt: 1, label: 'Sunny Farm, spring 3' };
    const steps = await renderSteps({ install: installState(), world: open });
    expect(steps).toContain('Your farm is open: Sunny Farm, spring 3.');
    expect(steps).toContain('✓ Your farm');
    const connecting = await renderLaunch({ install: installState(), world: open, summon: { kind: 'connecting', characterId: 'c1' } });
    expect(connecting).toContain('Connecting...');
  });
});
