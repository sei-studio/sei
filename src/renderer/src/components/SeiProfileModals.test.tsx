/**
 * 260929 (R1b / R1c / R7 / R10): the summon modals point at the Sei profile
 * with one button, Start Minecraft when a Sei profile exists and Set up Sei
 * profile when it does not; no copy tells the player to build a launcher
 * installation by hand; Windows gets the firewall line; the LAN hint no
 * longer mentions another computer. Rendered with react-dom/server against
 * the real stores, seeded.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { McInstall } from '@shared/ipc';

const __dirname = dirname(fileURLToPath(import.meta.url));

const bridge: Record<string, unknown> = { platform: 'darwin' };
vi.mock('../lib/ipcClient', () => ({ sei: bridge }));
// SSR renders read a zustand store's INITIAL state, so the setup store is a
// plain selector over a mutable object here (as in McSteps.test.tsx).
const setup: { installs: McInstall[] | null; scanning: boolean; scan: () => Promise<void> } = {
  installs: null,
  scanning: false,
  scan: async () => undefined,
};
vi.mock('./mcdash/useMcSetupStore', async (orig) => {
  const real = await orig<typeof import('./mcdash/useMcSetupStore')>();
  return {
    ...real,
    useMcSetupStore: Object.assign((sel: (s: typeof setup) => unknown) => sel(setup), { getState: () => setup }),
  };
});

const { LanNotOpenModal } = await import('./LanNotOpenModal');
const { UnsupportedVersionModal } = await import('./UnsupportedVersionModal');
const { LanHostWarningModal } = await import('./LanHostWarningModal');
const { startMinecraftNote, launcherGoneNote, watchLauncher, LAUNCHER_CHECK_MS } = await import('./mcdash/useStartMinecraft');
const { t, useLangStore } = await import('../lib/i18n');

const VANILLA: McInstall = {
  id: 'v1', kind: 'vanilla', label: 'Vanilla Launcher', path: '/mc', mc_version: '26.1',
  loader: null, loader_version: null, fabric_mc_versions: [], csl_installed: false, csl_version: null,
  sei_enabled: false, compatibility: 'full',
};
const READY: McInstall = { ...VANILLA, loader: 'fabric', fabric_mc_versions: ['26.1'], csl_installed: true, sei_ready_versions: ['26.1'] };

function seed(installs: McInstall[] | null, platform = 'darwin'): void {
  bridge.platform = platform;
  setup.installs = installs;
}

const lanNotOpen = (): string => renderToStaticMarkup(<LanNotOpenModal characterId="c1" />);
const unsupported = (): string =>
  renderToStaticMarkup(<UnsupportedVersionModal characterId="c1" message="This world is running Minecraft 26.4, which Sei can't join yet." />);
const forge = (): string =>
  renderToStaticMarkup(
    <LanHostWarningModal characterId="c1" warning="forge" host={{ client: 'forge', forgeModCount: 3 }} fromChat={false} />,
  );

beforeEach(() => {
  useLangStore.getState().setLang('en');
  seed(null);
});

describe('LanNotOpenModal', () => {
  it('drops the other-computer line and offers Start Minecraft only with a Sei profile', () => {
    seed([READY]);
    const html = lanNotOpen();
    expect(html).not.toContain('another computer');
    expect(html).toContain('The world must be running on this computer.');
    expect(html).toContain('>Start Minecraft<');
    expect(html).toContain('>Try again<');
    seed([VANILLA]);
    const plain = lanNotOpen();
    expect(plain).not.toContain('Start Minecraft');
    // A player on their own profile is not pushed into setup from here.
    expect(plain).not.toContain('Set up Sei profile');
  });

  it('shows the Java firewall line on Windows only', () => {
    seed([READY], 'win32');
    expect(lanNotOpen()).toContain('You can press Cancel');
    seed([READY], 'darwin');
    expect(lanNotOpen()).not.toContain('You can press Cancel');
  });
});

describe('UnsupportedVersionModal', () => {
  it('points at the Sei profile: Start Minecraft when it exists', () => {
    seed([READY]);
    const html = unsupported();
    expect(html).toContain('Play from the Sei profile instead.');
    expect(html).toContain('keeps its own worlds');
    expect(html).toContain('Press Start Minecraft below.');
    expect(html).toContain('>Start Minecraft<');
    expect(html).not.toContain('New installation');
    expect(html).not.toContain('Installations tab');
  });

  it('Set up Sei profile when it does not', () => {
    seed([VANILLA]);
    const html = unsupported();
    expect(html).toContain('Press Set up Sei profile below.');
    expect(html).toContain('>Set up Sei profile<');
    expect(html).not.toContain('Start Minecraft');
  });
});

describe('Forge block', () => {
  it('Start Minecraft with a Sei profile, Set up Sei profile without', () => {
    seed([READY]);
    const ready = forge();
    expect(ready).toContain('>Start Minecraft<');
    expect(ready).not.toContain('Summon anyway');
    seed([VANILLA]);
    const missing = forge();
    expect(missing).toContain('>Set up Sei profile<');
    expect(missing).toContain('Press Set up Sei profile below.');
  });
});

describe('startMinecraftNote', () => {
  it('says what happened, with the profile name and no placeholders', () => {
    const lines = [
      startMinecraftNote(t, { ok: true, profileName: 'Sei 26.1', mcVersion: '26.1', launcher: 'mac', alreadyOpen: false }),
      startMinecraftNote(t, { ok: true, profileName: 'Sei 26.1', mcVersion: '26.1', launcher: 'windows-store', alreadyOpen: true }),
      startMinecraftNote(t, { ok: false, reason: 'no_profile' }),
      startMinecraftNote(t, { ok: false, reason: 'no_launcher', profileName: 'Sei 26.1' }),
      startMinecraftNote(t, { ok: false, reason: 'launch_failed' }),
    ];
    expect(lines[0]).toEqual({ tone: 'ok', text: 'The Minecraft Launcher is opening with "Sei 26.1" selected. Press Play.' });
    expect(lines[1].text).toContain('already open');
    expect(lines[2].tone).toBe('warn');
    expect(lines[3].text).toContain('pick "Sei 26.1" next to Play');
    for (const l of lines) {
      expect(l.text).not.toMatch(/\{\w+\}/);
      expect(l.text).not.toContain('—');
    }
    useLangStore.getState().setLang('zh');
    expect(startMinecraftNote(t, { ok: false, reason: 'no_launcher', profileName: 'Sei 26.1' }).text).toContain('「Sei 26.1」');
  });
});

describe('launcherGoneNote', () => {
  it('tells the player to open the launcher themselves, in en and zh', () => {
    useLangStore.getState().setLang('en');
    const en = launcherGoneNote(t, 'Sei 26.1');
    expect(en).toEqual({
      tone: 'warn',
      text: 'Didn\'t see the launcher? Open the Minecraft Launcher, pick "Sei 26.1" next to Play, and press Play.',
    });
    useLangStore.getState().setLang('zh');
    const zh = launcherGoneNote(t, 'Sei 26.1').text;
    expect(zh).toContain('「Sei 26.1」');
    for (const text of [en.text, zh]) {
      expect(text).not.toMatch(/\{\w+\}/);
      expect(text).not.toContain('—');
    }
    useLangStore.getState().setLang('en');
  });
});

describe('watchLauncher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    return () => vi.useRealTimers();
  });
  const flush = async (ms: number): Promise<void> => {
    await vi.advanceTimersByTimeAsync(ms);
  };

  it('stays quiet for 20s, then reports a launcher that is gone', async () => {
    const probe = vi.fn(async () => false);
    const on = { gone: vi.fn(), timeout: vi.fn() };
    watchLauncher(probe, on);
    await flush(LAUNCHER_CHECK_MS[0] - 1);
    expect(probe).not.toHaveBeenCalled();
    await flush(1);
    expect(on.gone).toHaveBeenCalledTimes(1);
    await flush(200_000);
    expect(probe).toHaveBeenCalledTimes(1); // the watch ends once it is gone
    expect(on.timeout).not.toHaveBeenCalled();
  });

  it('checks a handful of times while the launcher runs, then times the hint out', async () => {
    const probe = vi.fn(async () => true);
    const on = { gone: vi.fn(), timeout: vi.fn() };
    watchLauncher(probe, on);
    await flush(LAUNCHER_CHECK_MS[LAUNCHER_CHECK_MS.length - 1]);
    expect(probe).toHaveBeenCalledTimes(LAUNCHER_CHECK_MS.length);
    expect(on.timeout).toHaveBeenCalledTimes(1);
    expect(on.gone).not.toHaveBeenCalled();
    await flush(600_000);
    expect(probe).toHaveBeenCalledTimes(LAUNCHER_CHECK_MS.length);
  });

  it('treats an unsure or failing probe as still running', async () => {
    const answers: Array<boolean | null | Error> = [null, new Error('pgrep'), false];
    const probe = vi.fn(async () => {
      const a = answers.shift();
      if (a instanceof Error) throw a;
      return a ?? null;
    });
    const on = { gone: vi.fn(), timeout: vi.fn() };
    watchLauncher(probe, on);
    await flush(LAUNCHER_CHECK_MS[1]);
    expect(on.gone).not.toHaveBeenCalled();
    await flush(LAUNCHER_CHECK_MS[2] - LAUNCHER_CHECK_MS[1]);
    expect(on.gone).toHaveBeenCalledTimes(1);
  });

  it('stops on cancel, and only times out when there is no probe', async () => {
    const probe = vi.fn(async () => false);
    const on = { gone: vi.fn(), timeout: vi.fn() };
    const cancel = watchLauncher(probe, on);
    await flush(1_000);
    cancel();
    await flush(200_000);
    expect(probe).not.toHaveBeenCalled();
    expect(on.gone).not.toHaveBeenCalled();

    const bare = { gone: vi.fn(), timeout: vi.fn() };
    watchLauncher(undefined, bare);
    await flush(LAUNCHER_CHECK_MS[LAUNCHER_CHECK_MS.length - 1]);
    expect(bare.timeout).toHaveBeenCalledTimes(1);
    expect(bare.gone).not.toHaveBeenCalled();
  });
});

describe('copy', () => {
  it('every new or changed key has a zh entry, and no em dash in either language', async () => {
    const files = [
      'LanNotOpenModal.tsx',
      'UnsupportedVersionModal.tsx',
      'LanHostWarningModal.tsx',
      'McSetupModal.tsx',
      'SetupWizardModal.tsx',
    ];
    const keys = new Set<string>();
    for (const f of files) {
      const src = readFileSync(resolve(__dirname, f), 'utf8');
      for (const m of src.matchAll(/^const (?:FORGE_)?STEP_\w+ = '((?:[^'\\]|\\.)*)';$/gm)) keys.add(m[1]);
      for (const m of src.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)) {
        if (/Start Minecraft|Sei profile|this computer|Java can use/.test(m[1])) keys.add(m[1].replace(/\\'/g, "'"));
      }
    }
    expect(keys.size).toBeGreaterThanOrEqual(8);
    const { ZH } = await import('../lib/i18n/zh');
    for (const k of keys) {
      expect(k, `em dash in "${k}"`).not.toContain('—');
      expect(ZH[k], `missing zh entry for "${k}"`).toBeTypeOf('string');
      expect(ZH[k]).not.toContain('—');
    }
  });
});
