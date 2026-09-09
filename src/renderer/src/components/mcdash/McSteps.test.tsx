/**
 * useMcSetupSteps + the Minecraft launch panel (260909). Rendered with
 * react-dom/server against seeded stores. Invariants:
 *   1. Nothing scanned yet: the looking line; the panel's button is a
 *      disabled Launch (no "Set up" flash before the scan answers).
 *   2. No install: Get Minecraft + Check again on step 1; the panel offers
 *      "Set up" and no help link.
 *   3. An install without a Sei-ready profile: the window opens on step 2,
 *      names the supported ceiling, offers Set up and Do not show again.
 *   4. Fabric for an UNSUPPORTED version + skin mod is not ready; Fabric for
 *      a supported one is, and the window moves on to the world step.
 *   5. Dismissed hides the setup step (two steps left) and counts as
 *      complete: the panel reads Launch with the help link.
 *   6. An open LAN world marks the last step done.
 *   7. The bridge's `{ installs }` shape is what the store reads (the bug
 *      that hid a real install behind "not found").
 *   8. Every t() key has a zh entry and no em dash.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { McInstall } from '@shared/ipc';

const __dirname = dirname(fileURLToPath(import.meta.url));

const VANILLA: McInstall = {
  id: 'v1', kind: 'vanilla', label: 'Vanilla Launcher', path: '/mc', mc_version: '1.21.4',
  loader: null, loader_version: null, fabric_mc_versions: [], csl_installed: false, csl_version: null,
  sei_enabled: false, compatibility: 'full',
};

const SUPPORTED = ['1.20.1', '1.21.4', '26.1'];

beforeEach(() => {
  vi.resetModules();
  (globalThis as unknown as { window: unknown }).window = {
    sei: {
      detectMcInstalls: vi.fn(async () => ({ installs: [] })),
      getConfig: vi.fn(async () => ({})),
      saveConfig: vi.fn(async () => undefined),
      openExternal: vi.fn(),
      gamePackState: vi.fn(async () => ({ kind: 'ready', root: '/r' })),
      gamePackEnsure: vi.fn(async () => ({ kind: 'ready', root: '/r' })),
      onGamePackProgress: vi.fn(() => () => undefined),
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
});

interface Opts {
  installs: McInstall[] | null;
  dismissed?: boolean;
  lanOpen?: boolean;
}

async function mockStores(opts: Opts): Promise<void> {
  vi.resetModules();
  vi.doMock('minecraft-protocol/src/version.js', () => ({ supportedVersions: SUPPORTED }));
  const setup = { installs: opts.installs, scanning: false, dismissed: opts.dismissed ?? false, scan: vi.fn(), hydrate: vi.fn(), dismiss: vi.fn() };
  const { selectReadyVersion } = await import('./useMcSetupStore');
  vi.doMock('./useMcSetupStore', () => ({
    useMcSetupStore: Object.assign((selector: (s: typeof setup) => unknown) => selector(setup), { getState: () => setup }),
    selectReadyVersion,
  }));
  vi.doMock('../../lib/stores/useWizardStore', () => ({
    useWizardStore: (selector: (s: { open: boolean; openWizard: () => void }) => unknown) => selector({ open: false, openWizard: vi.fn() }),
  }));
  const data = {
    lan: opts.lanOpen ? { kind: 'open', port: 1, motd: '', lastSeenAt: 1 } : { kind: 'closed' },
    summons: {},
    characters: [],
  };
  vi.doMock('../../lib/stores/useDataStore', () => ({
    useDataStore: Object.assign((selector: (s: typeof data) => unknown) => selector(data), { getState: () => data }),
  }));
  const packs = { packs: { minecraft: { kind: 'ready', root: '/r' } }, refresh: vi.fn(), ensure: vi.fn(), init: vi.fn() };
  vi.doMock('../../lib/stores/useGamePackStore', () => ({
    useGamePackStore: (selector: (s: typeof packs) => unknown) => selector(packs),
  }));
}

/** The window in setup mode over the live steps. */
async function renderSteps(opts: Opts): Promise<string> {
  await mockStores(opts);
  const { useMcSetupSteps } = await import('./McSteps');
  const { SetupStepper } = await import('../games/SetupStepper');
  const skin = {
    actions: 'actions', sub: 'sub', mono: 'mono', link: 'link',
    Button: ({ children, disabled }: { children: React.ReactNode; disabled?: boolean }) => React.createElement('button', { disabled }, children),
  };
  function Harness(): React.ReactElement {
    const s = useMcSetupSteps(skin);
    return React.createElement(
      'div',
      { 'data-complete': String(s.complete), 'data-known': String(s.known), 'data-count': String(s.steps.length) },
      React.createElement(SetupStepper, { steps: s.steps, mode: 'setup', onClose: () => undefined, label: 'steps' }),
    );
  }
  return renderToStaticMarkup(React.createElement(Harness));
}

async function renderPanel(opts: Opts): Promise<string> {
  await mockStores(opts);
  const { McLaunchPanel } = await import('./McLaunchPanel');
  return renderToStaticMarkup(React.createElement(McLaunchPanel, { characterId: 'c1' }));
}

describe('useMcSetupSteps + McLaunchPanel', () => {
  it('Test 1: before the first scan, the looking line and a disabled Launch', async () => {
    const steps = await renderSteps({ installs: null });
    expect(steps).toContain('Looking for Minecraft on this computer...');
    expect(steps).toContain('data-known="false"');
    const panel = await renderPanel({ installs: null });
    expect(panel).toContain('>Launch<');
    expect(panel).not.toContain('>Set up<');
    expect(panel).not.toContain('How do I set up launch?');
  });

  it('Test 2: no install: Get Minecraft on step 1; the panel offers Set up', async () => {
    const steps = await renderSteps({ installs: [] });
    expect(steps).toContain('data-step="game"');
    expect(steps).toContain('Get Minecraft');
    expect(steps).toContain('Check again');
    expect(steps).toContain('data-complete="false"');
    const panel = await renderPanel({ installs: [] });
    expect(panel).toContain('>Set up<');
    expect(panel).not.toContain('How do I set up launch?');
  });

  it('Test 3: an install without a Sei-ready profile opens on the setup step', async () => {
    const html = await renderSteps({ installs: [VANILLA] });
    expect(html).toContain('data-step="install"');
    expect(html).toContain('Step 2 of 3');
    expect(html).toContain('up to 26.1');
    expect(html).toContain('>Set up<');
    expect(html).toContain('Do not show again');
    expect(html).not.toContain('Minecraft Java Edition is installed.');
  });

  it('Test 4: Fabric for an unsupported version is not ready; for a supported one the world step is next', async () => {
    const snap = await renderSteps({ installs: [{ ...VANILLA, loader: 'fabric', loader_version: '0.16.5', fabric_mc_versions: ['27.1'], csl_installed: true }] });
    expect(snap).toContain('data-step="install"');
    const ready = await renderSteps({ installs: [{ ...VANILLA, loader: 'fabric', loader_version: '0.16.5', fabric_mc_versions: ['27.1', '1.21.4'], csl_installed: true }] });
    expect(ready).toContain('data-step="world"');
    expect(ready).toContain('Open a world to LAN:');
    expect(ready).toContain('Waiting for your world...');
    expect(ready).toContain('data-complete="true"');
  });

  it('Test 5: dismissed hides the setup step and counts as complete', async () => {
    const steps = await renderSteps({ installs: [VANILLA], dismissed: true });
    expect(steps).toContain('data-count="2"');
    expect(steps).toContain('data-step="world"');
    expect(steps).toContain('data-complete="true"');
    const panel = await renderPanel({ installs: [VANILLA], dismissed: true });
    expect(panel).toContain('>Launch<');
    expect(panel).toContain('How do I set up launch?');
    const done = await renderSteps({ installs: [{ ...VANILLA, loader: 'fabric', fabric_mc_versions: ['1.21.4'], csl_installed: true }], dismissed: true });
    expect(done).toContain('data-count="3"');
  });

  it('Test 6: an open LAN world marks the last step done', async () => {
    const html = await renderSteps({ installs: [{ ...VANILLA, loader: 'fabric', fabric_mc_versions: ['1.21.4'], csl_installed: true }], lanOpen: true });
    expect(html).toContain('Your world is open to LAN.');
    expect(html).toContain('✓ A world open to LAN');
  });

  it('Test 7: the store reads the bridge\'s { installs } shape', async () => {
    vi.resetModules();
    // Earlier tests registered a doMock for the store; resetModules keeps the registry.
    vi.doUnmock('./useMcSetupStore');
    (globalThis as unknown as { window: { sei: { detectMcInstalls: unknown } } }).window.sei.detectMcInstalls = vi.fn(async () => ({ installs: [VANILLA] }));
    const { useMcSetupStore } = await import('./useMcSetupStore');
    await useMcSetupStore.getState().scan();
    expect(useMcSetupStore.getState().installs).toEqual([VANILLA]);
  });

  it('Test 8: every t() key has a zh entry and no em dash', async () => {
    const all: string[] = [];
    for (const file of ['McSteps.tsx', 'McLaunchPanel.tsx']) {
      const src = readFileSync(resolve(__dirname, file), 'utf8');
      all.push(...[...src.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\'/g, "'")));
      all.push(...[...src.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]));
      all.push(...[...src.matchAll(/^\s+'([^']+)',$/gm)].map((m) => m[1]));
    }
    expect(all.length).toBeGreaterThanOrEqual(16);
    const { ZH } = await import('../../lib/i18n/zh');
    for (const k of all) {
      expect(k, `em dash in "${k}"`).not.toContain('—');
      expect(ZH[k], `missing zh entry for "${k}"`).toBeTypeOf('string');
      expect(ZH[k]).not.toContain('—');
    }
  });
});
