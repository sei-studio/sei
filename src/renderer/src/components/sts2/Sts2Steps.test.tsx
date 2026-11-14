/**
 * useSts2SetupSteps + Sts2LaunchPanel + useSts2Store (261115). Static
 * renders over mocked stores. Invariants:
 *   1. Game found, mod missing: the window opens on the mod step with "Add
 *      the Sei mod"; the panel offers "Set up", no help link.
 *   2. Mod in but not yet turned on: the enable step with "Start Slay the
 *      Spire 2"; still "Set up".
 *   3. Mod on, no lobby: complete; the lobby step names the companion's
 *      "Play with" button and says the companion plays in a second window;
 *      the panel reads Launch with the help link.
 *   4. A Steam lobby is called out; an open lobby / run reads as such.
 *   5. Not found lists where Sei looked; a permission refusal reads as one.
 *   6. The token list renders all four steps.
 *   7. A refresh clears a failure only once it is fixed.
 *   8. Every t() key in the files has a zh entry and no em dash.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { Sts2SetupState, Sts2WorldState } from '@shared/sts2Ipc';

const __dirname = dirname(fileURLToPath(import.meta.url));

const FOUND: Sts2SetupState = {
  kind: 'found',
  install: { gameDir: 'C:\\Steam\\steamapps\\common\\Slay the Spire 2', binary: 'C:\\Steam\\steamapps\\common\\Slay the Spire 2\\SlayTheSpire2.exe', store: 'steam' },
  modsDir: 'C:\\Steam\\steamapps\\common\\Slay the Spire 2\\mods',
  modInstalled: false,
  modVersion: null,
  modCurrent: false,
  modLoaded: false,
  gameRunning: false,
  lobbyOpen: false,
  companionRunning: false,
  grantNeeded: false,
};
const INSTALLED: Sts2SetupState = { ...FOUND, modInstalled: true, modVersion: '0.1.0', modCurrent: true };
const ON: Sts2SetupState = { ...INSTALLED, modLoaded: true };
const CLOSED: Sts2WorldState = { game: 'sts2', kind: 'closed' };

beforeEach(() => {
  vi.resetModules();
  (globalThis as unknown as { window: unknown }).window = {
    sei: {
      platform: 'win32',
      gamePackState: vi.fn(async () => ({ kind: 'ready', root: '/r' })),
      gamePackEnsure: vi.fn(async () => ({ kind: 'ready', root: '/r' })),
      onGamePackProgress: vi.fn(() => () => undefined),
      sts2SetupState: vi.fn(async () => FOUND),
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
});

async function mockStores(setup: Sts2SetupState | null, world: Sts2WorldState = CLOSED, failure: unknown = null): Promise<void> {
  vi.resetModules();
  const st = { setup, installBusy: false, starting: false, failure, refresh: vi.fn(async () => setup), runInstall: vi.fn(), startGame: vi.fn() };
  vi.doMock('./useSts2Store', () => ({
    useSts2Store: Object.assign((selector: (s: typeof st) => unknown) => selector(st), { getState: () => st }),
  }));
  const data = { summons: { c1: { kind: 'idle', characterId: 'c1' } }, characters: [{ id: 'c1', name: 'Sui' }], worlds: { sts2: world } };
  vi.doMock('../../lib/stores/useDataStore', () => ({
    useDataStore: Object.assign((selector: (s: typeof data) => unknown) => selector(data), { getState: () => data }),
  }));
  const packs = { packs: { sts2: { kind: 'ready', root: '/r' } }, refresh: vi.fn(), ensure: vi.fn(), init: vi.fn() };
  vi.doMock('../../lib/stores/useGamePackStore', () => ({
    useGamePackStore: (selector: (s: typeof packs) => unknown) => selector(packs),
  }));
}

async function renderSteps(setup: Sts2SetupState | null, world: Sts2WorldState = CLOSED, failure: unknown = null): Promise<string> {
  await mockStores(setup, world, failure);
  const { useSts2SetupSteps } = await import('./Sts2Steps');
  const { SetupStepper } = await import('../games/SetupStepper');
  const skin = {
    actions: 'actions', sub: 'sub', mono: 'mono', link: 'link',
    Button: ({ children, disabled }: { children: React.ReactNode; disabled?: boolean }) => React.createElement('button', { disabled }, children),
  };
  function Harness(): React.ReactElement {
    const s = useSts2SetupSteps(skin);
    return React.createElement(
      'div',
      { 'data-complete': String(s.complete) },
      React.createElement(SetupStepper, { steps: s.steps, mode: 'setup', onClose: () => undefined, label: 'steps' }),
    );
  }
  return renderToStaticMarkup(React.createElement(Harness));
}

async function renderPanel(setup: Sts2SetupState | null, world: Sts2WorldState = CLOSED): Promise<string> {
  await mockStores(setup, world);
  const { Sts2LaunchPanel } = await import('./Sts2LaunchPanel');
  return renderToStaticMarkup(React.createElement(Sts2LaunchPanel, { characterId: 'c1' }));
}

// The first test pays for the cold import of the launch panel's module graph.
describe('useSts2SetupSteps + Sts2LaunchPanel', { timeout: 30_000 }, () => {
  it('Test 1: mod missing: the mod step; the panel offers Set up', async () => {
    const steps = await renderSteps(FOUND);
    expect(steps).toContain('data-step="mod"');
    expect(steps).toContain('>Add the Sei mod<');
    expect(steps).toContain('data-complete="false"');
    const panel = await renderPanel(FOUND);
    expect(panel).toContain('>Set up<');
    expect(panel).not.toContain('How do I set up launch?');
  });

  it('Test 2: mod in, not on yet: the enable step', async () => {
    const steps = await renderSteps(INSTALLED);
    expect(steps).toContain('data-step="enable"');
    expect(steps).toContain('>Start Slay the Spire 2<');
    expect(steps).toContain('Turn on Sei Companion');
    expect(steps).toContain('data-complete="false"');
  });

  it('Test 3: mod on: the lobby step names the button; Launch with the help link', async () => {
    const steps = await renderSteps(ON);
    expect(steps).toContain('data-step="lobby"');
    expect(steps).toContain('Play with Sei');
    expect(steps).not.toContain('Play with Sui');
    expect(steps).toContain('second game window');
    expect(steps).toContain('data-complete="true"');
    const panel = await renderPanel(ON);
    expect(panel).toContain('>Launch<');
    expect(panel).toContain('How do I set up launch?');
  });

  it('Test 4: Steam lobby, open lobby, run', async () => {
    const steam = await renderSteps(ON, { game: 'sts2', kind: 'no_lobby', screen: 'lobby', lobby: 'steam' });
    expect(steam).toContain('This is a Steam lobby');
    const open: Sts2WorldState = { game: 'sts2', kind: 'open', label: 'Slay the Spire 2', lastSeenAt: 1, detail: { screen: 'lobby', players: ['ouen'], inRun: false } };
    expect(await renderPanel(ON, open)).toContain('Your co-op lobby is open.');
    expect(await renderPanel(ON, { ...open, detail: { ...open.detail, inRun: true } })).toContain('Your co-op run is on.');
  });

  it('Test 5: not found and a permission refusal', async () => {
    const none = await renderSteps({ kind: 'not_found', searched: ['/Users/you/Library/Application Support/Steam/steamapps/common/Slay the Spire 2'] });
    expect(none).toContain('Steam libraries');
    expect(none).toContain('steamapps/common/Slay the Spire 2');
    const refused = await renderSteps(FOUND, CLOSED, { action: 'install', reason: 'permission', message: 'EPERM' });
    expect(refused).toContain('macOS did not allow Sei to add the mod.');
    expect(refused).toContain('>Try again<');
  });

  it('Test 6: the token list renders all four steps', async () => {
    await mockStores(FOUND);
    const { Sts2Steps } = await import('./Sts2Steps');
    const html = renderToStaticMarkup(React.createElement(Sts2Steps));
    expect(html).toContain('Slay the Spire 2 is installed.');
    expect(html).toContain('>02<');
    expect(html).toContain('>04<');
    expect(html).toContain('aria-current="step"');
  });

  it('Test 7: a refresh clears a failure only once it is fixed', async () => {
    vi.doUnmock('./useSts2Store');
    vi.resetModules();
    const { failureAfterRefresh } = await import('./useSts2Store');
    const running = { action: 'install' as const, reason: 'game_running' as const, message: 'x' };
    expect(failureAfterRefresh(running, { ...FOUND, gameRunning: true })).toBe(running);
    expect(failureAfterRefresh(running, FOUND)).toBeNull();
    const perm = { action: 'install' as const, reason: 'permission' as const, message: 'EPERM' };
    expect(failureAfterRefresh(perm, FOUND)).toBe(perm);
    expect(failureAfterRefresh(perm, INSTALLED)).toBeNull();
    const failed = { action: 'start' as const, reason: 'failed' as const, message: 'spawn ENOENT' };
    expect(failureAfterRefresh(failed, ON)).toBe(failed);
    expect(failureAfterRefresh(null, ON)).toBeNull();
  });

  it('Test 8: every t() key has a zh entry and no em dash', async () => {
    const all: string[] = [];
    for (const file of ['Sts2Steps.tsx', 'Sts2LaunchPanel.tsx', 'Sts2SetupBody.tsx']) {
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
