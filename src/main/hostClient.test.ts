/**
 * Tests for the LAN host-client detection stack (260709):
 *   - classifyCmdline: java command-line → client kind markers, including the
 *     two deliberate traps (CurseForge paths must NOT read as Forge; Lunar
 *     bundles Fabric internals so Lunar must win over the fabric marker).
 *   - forgeModCountFromStatus: Forge 1.13+ `forgeData` and 1.12- `modinfo`
 *     ping metadata extraction.
 *   - lanHostWarning: the shared disclaimer decision the renderer gate uses.
 *   - parseLsof / parseNetstat: pid extraction feeding the classifier.
 */
import { describe, it, expect } from 'vitest';
import { classifyCmdline } from './hostClient';
import { forgeModCountFromStatus } from './mcPing';
import { parseLsof, parseNetstat, parseTasklist } from './listeningPorts';
import { lanHostWarning, type LanHost } from '../shared/ipc';

const host = (client: LanHost['client'], forgeModCount: number | null = null): LanHost => ({
  client,
  forgeModCount,
});

describe('classifyCmdline', () => {
  it('detects vanilla by main class', () => {
    expect(
      classifyCmdline('/usr/bin/java -Xmx2G -cp ... net.minecraft.client.main.Main --version 1.21.1'),
    ).toBe('vanilla');
  });

  it('detects Fabric by loader main class', () => {
    expect(
      classifyCmdline('java -cp fabric-loader-0.16.9.jar net.fabricmc.loader.impl.launch.knot.KnotClient'),
    ).toBe('fabric');
  });

  it('detects Forge by bootstraplauncher', () => {
    expect(
      classifyCmdline('java -p ... cpw.mods.bootstraplauncher.BootstrapLauncher --fml.forgeVersion 47.3.0'),
    ).toBe('forge');
  });

  it('detects NeoForge', () => {
    expect(classifyCmdline('java ... --fml.neoForgeVersion 21.1.77 net.neoforged.fancymodloader ...')).toBe(
      'neoforge',
    );
  });

  it('detects Lunar Client by install path', () => {
    expect(
      classifyCmdline('/Users/x/.lunarclient/jre/bin/java -cp genesis.jar com.moonsworth.launch ...'),
    ).toBe('lunar');
  });

  it('prefers Lunar over its bundled Fabric internals', () => {
    expect(classifyCmdline('java -cp /home/x/.lunarclient/offline/net.fabricmc.loader.jar ...')).toBe('lunar');
  });

  it('does NOT read a vanilla CurseForge instance as Forge', () => {
    expect(
      classifyCmdline(
        'java -Djava.library.path=/Users/x/curseforge/minecraft/Instances/MyPack/natives net.minecraft.client.main.Main',
      ),
    ).toBe('vanilla');
  });

  it('returns unknown for empty or unrecognized command lines', () => {
    expect(classifyCmdline('')).toBe('unknown');
    expect(classifyCmdline('   ')).toBe('unknown');
    expect(classifyCmdline('node server.js')).toBe('unknown');
  });
});

describe('forgeModCountFromStatus', () => {
  it('reads forgeData.mods (1.13+)', () => {
    expect(forgeModCountFromStatus({ forgeData: { mods: [{ modId: 'a' }, { modId: 'b' }] } })).toBe(2);
  });

  it('reads modinfo.modList (1.12-)', () => {
    expect(forgeModCountFromStatus({ modinfo: { type: 'FML', modList: [{ modid: 'forge' }] } })).toBe(1);
  });

  it('returns 0 when forge metadata is present but unparseable', () => {
    expect(forgeModCountFromStatus({ forgeData: { fmlNetworkVersion: 3 } })).toBe(0);
  });

  it('returns null for vanilla pings', () => {
    expect(forgeModCountFromStatus({ version: { name: '1.21.1', protocol: 767 } })).toBe(null);
    expect(forgeModCountFromStatus(null)).toBe(null);
  });
});

describe('lanHostWarning', () => {
  it('maps loaders to the modded disclaimer', () => {
    expect(lanHostWarning(host('forge'))).toBe('modded');
    expect(lanHostWarning(host('neoforge'))).toBe('modded');
    expect(lanHostWarning(host('fabric'))).toBe('modded');
  });

  it('maps Lunar to the lunar disclaimer', () => {
    expect(lanHostWarning(host('lunar'))).toBe('lunar');
  });

  it('falls back to modded when only the ping carried forge metadata', () => {
    expect(lanHostWarning(host('unknown', 4))).toBe('modded');
  });

  it('stays silent for vanilla, unknown, and missing hosts', () => {
    expect(lanHostWarning(host('vanilla'))).toBe(null);
    expect(lanHostWarning(host('unknown'))).toBe(null);
    expect(lanHostWarning(undefined)).toBe(null);
  });
});

describe('listeningPorts pid extraction', () => {
  it('parseLsof reads the PID column', () => {
    const out = [
      'COMMAND   PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME',
      'java    41234 ouen   99u  IPv6 0x1234567890      0t0  TCP *:52345 (LISTEN)',
    ].join('\n');
    expect(parseLsof(out)).toEqual([{ port: 52345, command: 'java', pid: 41234 }]);
  });

  it('parseNetstat reads the trailing PID', () => {
    const out = ['  TCP    0.0.0.0:52345    0.0.0.0:0    LISTENING    9876'].join('\n');
    expect(parseNetstat(out)).toEqual([{ port: 52345, command: '', pid: 9876 }]);
  });

  // Issue #5: modern Java binds "Open to LAN" as a dual-stack socket that
  // netstat reports only in the IPv6 table, and localized Windows translates
  // the state word — so the parser must read `[::]` rows and must not depend
  // on the literal LISTENING string.
  it('parseNetstat reads dual-stack (IPv6) listener rows', () => {
    const out = ['  TCP    [::]:52345    [::]:0    LISTENING    9876'].join('\n');
    expect(parseNetstat(out)).toEqual([{ port: 52345, command: '', pid: 9876 }]);
  });

  it('parseNetstat is locale-proof: listening state detected by foreign port 0', () => {
    const out = [
      '',
      'Aktive Verbindungen',
      '',
      '  Proto  Lokale Adresse         Remoteadresse          Status           PID',
      '  TCP    0.0.0.0:135            0.0.0.0:0              ABHÖREN          1044',
      '  TCP    [::]:52345             [::]:0                 ABHÖREN          9876',
      '  TCP    192.168.1.5:52001      52.1.2.3:443           HERGESTELLT      4321',
      '  UDP    0.0.0.0:5353           *:*                                     2222',
    ].join('\n');
    expect(parseNetstat(out)).toEqual([
      { port: 135, command: '', pid: 1044 },
      { port: 52345, command: '', pid: 9876 },
    ]);
  });

  it('parseNetstat dedupes a port listed on both stacks', () => {
    const out = [
      '  TCP    0.0.0.0:52345    0.0.0.0:0    LISTENING    9876',
      '  TCP    [::]:52345       [::]:0       LISTENING    9876',
    ].join('\n');
    expect(parseNetstat(out)).toEqual([{ port: 52345, command: '', pid: 9876 }]);
  });

  it('parseTasklist maps pid to image name from csv rows', () => {
    const out = [
      '"System Idle Process","0","Services","0","8 K"',
      '"javaw.exe","41234","Console","1","1,204,556 K"',
      '"svchost.exe","1044","Services","0","12,332 K"',
      'INFO: not a csv row',
    ].join('\n');
    const names = parseTasklist(out);
    expect(names.get(41234)).toBe('javaw.exe');
    expect(names.get(1044)).toBe('svchost.exe');
    expect(names.has(0)).toBe(false);
  });
});
