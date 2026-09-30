/**
 * 260929: the Microsoft Store / Xbox app launcher keeps its installations in
 * launcher_profiles_microsoft_store.json (same .minecraft). A Sei profile
 * that lives only there must still count as Sei-ready.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let userData = '';
vi.mock('electron', () => ({ app: { isPackaged: false } }));
vi.mock('./paths', () => ({
  paths: { userData: () => userData, wizardStatePath: () => path.join(userData, 'wizard-state.json') },
}));
vi.mock('./wizardStateStore', () => ({
  loadWizardState: async () => ({ version: 1, hasRunOnce: false, enabledInstallIds: [], lastRunAt: null, lastSkinServerPort: null }),
}));

import { scanMcInstalls } from './mcInstallScan';

let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'sei-scan-'));
  userData = path.join(home, 'userData');
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

describe('scanMcInstalls reads both launcher profile files', () => {
  it('finds a Sei profile that exists only in the Store launcher file', async () => {
    const mcDir = path.join(home, '.minecraft');
    const gameDir = path.join(mcDir, 'sei', '26.1');
    await fs.mkdir(path.join(gameDir, 'mods'), { recursive: true });
    await fs.writeFile(path.join(gameDir, 'mods', 'CustomSkinLoader_Fabric-14.28.jar'), 'jar');
    await fs.mkdir(path.join(mcDir, 'versions', 'fabric-loader-0.19.5-26.1'), { recursive: true });
    await fs.writeFile(path.join(mcDir, 'launcher_profiles.json'), JSON.stringify({ profiles: {} }));
    await fs.writeFile(
      path.join(mcDir, 'launcher_profiles_microsoft_store.json'),
      JSON.stringify({
        profiles: { 'sei-26.1': { name: 'Sei 26.1', lastVersionId: 'fabric-loader-0.19.5-26.1', gameDir } },
      }),
    );
    const installs = await scanMcInstalls({ homedirOverride: home, platformOverride: 'linux' });
    const vanilla = installs.find((i) => i.kind === 'vanilla');
    expect(vanilla?.sei_ready_versions).toEqual(['26.1']);
  });
});
