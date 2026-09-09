/**
 * McSteps (260909). Rendered with react-dom/server against seeded stores.
 * Invariants:
 *   1. Nothing scanned yet: the looking line.
 *   2. No install: Get Minecraft + Check again; the setup step is 'later'.
 *   3. An install without a Sei-ready profile: the setup step is current,
 *      names the supported ceiling, offers Set up and Do not show again.
 *   4. Fabric for an UNSUPPORTED version + skin mod is not ready; Fabric for
 *      a supported one is, and the step reads done with that version.
 *   5. Dismissed hides the setup step (numbering closes up) unless ready.
 *   6. An open LAN world marks the last step done.
 *   7. Every t() key has a zh entry and no em dash.
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

beforeEach(() => {
  vi.resetModules();
  (globalThis as unknown as { window: unknown }).window = {
    sei: { detectMcInstalls: vi.fn(async () => []), getConfig: vi.fn(async () => ({})), saveConfig: vi.fn(async () => undefined), openExternal: vi.fn() },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  vi.doMock('minecraft-protocol/src/version.js', () => ({ supportedVersions: ['1.20.1', '1.21.4', '26.1'] }));
});

async function render(opts: { installs: McInstall[] | null; dismissed?: boolean; lanOpen?: boolean }): Promise<string> {
  vi.resetModules();
  vi.doMock('minecraft-protocol/src/version.js', () => ({ supportedVersions: ['1.20.1', '1.21.4', '26.1'] }));
  const setup = { installs: opts.installs, scanning: false, dismissed: opts.dismissed ?? false, scan: vi.fn(), hydrate: vi.fn(), dismiss: vi.fn() };
  const { selectReadyVersion } = await import('./useMcSetupStore');
  vi.doMock('./useMcSetupStore', () => ({
    useMcSetupStore: Object.assign((selector: (s: typeof setup) => unknown) => selector(setup), { getState: () => setup }),
    selectReadyVersion,
  }));
  vi.doMock('../../lib/stores/useWizardStore', () => ({
    useWizardStore: (selector: (s: { open: boolean; openWizard: () => void }) => unknown) => selector({ open: false, openWizard: vi.fn() }),
  }));
  const data = { lan: opts.lanOpen ? { kind: 'open', port: 1, motd: '', lastSeenAt: 1 } : { kind: 'closed' } };
  vi.doMock('../../lib/stores/useDataStore', () => ({
    useDataStore: Object.assign((selector: (s: typeof data) => unknown) => selector(data), { getState: () => data }),
  }));
  const { McSteps } = await import('./McSteps');
  return renderToStaticMarkup(React.createElement(McSteps));
}

describe('McSteps', () => {
  it('Test 1: before the first scan, the looking line', async () => {
    const html = await render({ installs: null });
    expect(html).toContain('Looking for Minecraft on this computer...');
    expect(html).not.toContain('Get Minecraft');
  });

  it('Test 2: no install: Get Minecraft, and the setup step waits', async () => {
    const html = await render({ installs: [] });
    expect(html).toContain('Get Minecraft');
    expect(html).toContain('Check again');
    expect(html).toContain('>Set up<');
    expect(html.match(/stepLater/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('Test 3: an install without a Sei-ready profile makes setup the current step', async () => {
    const html = await render({ installs: [VANILLA] });
    expect(html).toContain('Minecraft Java Edition is installed.');
    expect(html).toContain('up to 26.1');
    expect(html).toContain('>Set up<');
    expect(html).toContain('Do not show again');
    expect(html).toContain('aria-current="step"');
  });

  it('Test 4: Fabric for an unsupported version is not ready; for a supported one it is', async () => {
    const snap = await render({ installs: [{ ...VANILLA, loader: 'fabric', loader_version: '0.16.5', fabric_mc_versions: ['27.1'], csl_installed: true }] });
    expect(snap).toContain('>Set up<');
    const ready = await render({ installs: [{ ...VANILLA, loader: 'fabric', loader_version: '0.16.5', fabric_mc_versions: ['27.1', '1.21.4'], csl_installed: true }] });
    expect(ready).toContain('Sei-ready: Fabric for 1.21.4');
    expect(ready).not.toContain('>Set up<');
  });

  it('Test 5: dismissed hides the setup step unless it is done', async () => {
    const hidden = await render({ installs: [VANILLA], dismissed: true });
    expect(hidden).not.toContain('>Set up<');
    expect(hidden).not.toContain('Do not show again');
    // Two steps left: 01 and 02, no 03.
    expect(hidden).toContain('>02<');
    expect(hidden).not.toContain('>03<');
    const done = await render({ installs: [{ ...VANILLA, loader: 'fabric', fabric_mc_versions: ['1.21.4'], csl_installed: true }], dismissed: true });
    expect(done).toContain('Sei-ready: Fabric for 1.21.4');
  });

  it('Test 6: an open LAN world marks the last step done', async () => {
    const html = await render({ installs: [VANILLA], lanOpen: true });
    expect(html).toContain('Your world is open to LAN.');
    expect(html).not.toContain('Click Start LAN World.');
  });

  it('Test 7: every t() key has a zh entry and no em dash', async () => {
    const src = readFileSync(resolve(__dirname, 'McSteps.tsx'), 'utf8');
    const keys = [...src.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\'/g, "'"));
    const dq = [...src.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
    const steps = [...src.matchAll(/^\s+'([^']+)',$/gm)].map((m) => m[1]);
    const all = [...keys, ...dq, ...steps];
    expect(all.length).toBeGreaterThanOrEqual(14);
    const { ZH } = await import('../../lib/i18n/zh');
    for (const k of all) {
      expect(k, `em dash in "${k}"`).not.toContain('—');
      expect(ZH[k], `missing zh entry for "${k}"`).toBeTypeOf('string');
      expect(ZH[k]).not.toContain('—');
    }
  });
});
