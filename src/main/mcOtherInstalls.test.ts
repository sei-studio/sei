import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BEDROCK_UWP_PACKAGE, LAUNCHER_STORE_PACKAGE, parseMmcPack, scanMcExtras, type OtherInstallsEnv } from './mcOtherInstalls';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'sei-mc-other-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function winEnv(): OtherInstallsEnv {
  const home = path.join(root, 'Users', 'p');
  return {
    platform: 'win32',
    home,
    env: { APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local') },
    driveRoots: [path.join(root, 'C'), path.join(root, 'D')],
    macAppDirs: [],
  };
}

describe('parseMmcPack', () => {
  it('reads the Minecraft version and the loader component', () => {
    expect(
      parseMmcPack({
        components: [
          { uid: 'net.minecraft', version: '1.21.1' },
          { uid: 'net.fabricmc.fabric-loader', version: '0.16.0' },
        ],
      }),
    ).toEqual({ mc_version: '1.21.1', loader: 'fabric' });
    expect(parseMmcPack({ components: [{ uid: 'net.minecraft', cachedVersion: '1.20.1' }, { uid: 'net.neoforged' }] })).toEqual({ mc_version: '1.20.1', loader: 'neoforge' });
    expect(parseMmcPack(null)).toEqual({ mc_version: null, loader: null });
  });
});

describe('scanMcExtras (Windows fixtures)', () => {
  it('finds nothing on an empty machine', async () => {
    expect(await scanMcExtras(winEnv())).toEqual({ others: [], bedrock: false, launcherInstalled: false });
  });

  it('sees a Store Bedrock install and the Store launcher', async () => {
    const e = winEnv();
    await mkdir(path.join(e.env.LOCALAPPDATA!, 'Packages', BEDROCK_UWP_PACKAGE), { recursive: true });
    await mkdir(path.join(e.env.LOCALAPPDATA!, 'Packages', LAUNCHER_STORE_PACKAGE), { recursive: true });
    expect(await scanMcExtras(e)).toMatchObject({ bedrock: true, launcherInstalled: true });
  });

  it('sees a GDK Bedrock install under <drive>\\XboxGames', async () => {
    const e = winEnv();
    await mkdir(path.join(root, 'D', 'XboxGames', 'Minecraft for Windows'), { recursive: true });
    expect((await scanMcExtras(e)).bedrock).toBe(true);
  });

  it('lists Prism and ATLauncher instances (detection only)', async () => {
    const e = winEnv();
    const prism = path.join(e.env.APPDATA!, 'PrismLauncher', 'instances', 'Fabulously Optimized');
    await mkdir(prism, { recursive: true });
    await writeFile(path.join(prism, 'instance.cfg'), 'name=FO\n');
    await writeFile(path.join(prism, 'mmc-pack.json'), JSON.stringify({ components: [{ uid: 'net.minecraft', version: '1.21.4' }, { uid: 'net.fabricmc.fabric-loader' }] }));
    // A folder without instance.cfg is not an instance.
    await mkdir(path.join(e.env.APPDATA!, 'PrismLauncher', 'instances', '.tmp'), { recursive: true });
    await mkdir(path.join(e.env.APPDATA!, 'PrismLauncher', 'instances', 'junk'), { recursive: true });
    const at = path.join(e.env.APPDATA!, 'ATLauncher', 'instances', 'Vanilla121');
    await mkdir(at, { recursive: true });
    await writeFile(path.join(at, 'instance.json'), JSON.stringify({ id: '1.21.1', launcher: {} }));
    const { others } = await scanMcExtras(e);
    expect(others).toEqual([
      { launcher: 'prism', label: 'Fabulously Optimized', mc_version: '1.21.4', loader: 'fabric' },
      { launcher: 'atlauncher', label: 'Vanilla121', mc_version: '1.21.1', loader: 'vanilla' },
    ]);
  });
});
