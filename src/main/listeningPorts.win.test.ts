/**
 * Issue #52: Windows 11 26300.9818 (KB5127936) reports Minecraft's LAN
 * listener with state 0. netstat leaves the row out; Get-NetTCPConnection
 * shows it with an empty State. Fixtures use the reporter's values (ports
 * 56048 / 63711, pid 17240, local 0.0.0.0 and ::).
 */
import { describe, expect, it } from 'vitest';
import {
  isUnknownTcpState,
  netTcpConnectionScript,
  parseNetTcpConnection,
  parseNetstat,
  statelessListenerCandidates,
} from './listeningPorts';

describe('parseNetstat on the broken-state build', () => {
  it('the reporter shape: Minecraft port missing, other rows (some pid 0) still parse', () => {
    const out = [
      '',
      'Active Connections',
      '',
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1196',
      '  TCP    127.0.0.1:50411        127.0.0.1:63711        TIME_WAIT       0',
      '  TCP    192.168.1.20:50392     20.42.65.85:443        ESTABLISHED     17240',
      '  TCP    [::]:135               [::]:0                 LISTENING       1196',
      '  UDP    0.0.0.0:4445           *:*                                    17240',
    ].join('\n');
    // 63711 only appears as a TIME_WAIT peer, never as a listener: netstat
    // alone cannot find the world, which is why the fallbacks exist.
    expect(parseNetstat(out).map((p) => p.port)).toEqual([135]);
  });

  it('keeps a listener row printed with an empty state column', () => {
    const out = [
      '  TCP    0.0.0.0:63711          0.0.0.0:0                              17240',
      '  TCP    [::]:56048             [::]:0                                 17240',
    ].join('\n');
    expect(parseNetstat(out)).toEqual([
      { port: 63711, command: '', pid: 17240 },
      { port: 56048, command: '', pid: 17240 },
    ]);
  });

  it('still drops an empty-state row with a real peer (not a listener)', () => {
    const out = ['  TCP    127.0.0.1:50411        127.0.0.1:63711                        0'].join('\n');
    expect(parseNetstat(out)).toEqual([]);
  });
});

describe('Get-NetTCPConnection fallback', () => {
  // What our script prints for the reporter's rows (State raw: 0, or empty
  // when the CIM value is missing), plus an ordinary established row.
  const reporterOut = [
    '0.0.0.0|63711|0.0.0.0|0||17240',
    '::|56048|::|0|0|17240',
    '192.168.1.20|50392|20.42.65.85|443|5|17240',
    '127.0.0.1|50500|127.0.0.1|25565|Established|17240',
    '#sei-done',
    '',
  ].join('\r\n');

  it('parses rows and the completion sentinel', () => {
    const { rows, complete } = parseNetTcpConnection(reporterOut);
    expect(complete).toBe(true);
    expect(rows[0]).toEqual({
      localAddress: '0.0.0.0',
      localPort: 63711,
      remoteAddress: '0.0.0.0',
      remotePort: 0,
      state: '',
      pid: 17240,
    });
    expect(rows).toHaveLength(4);
  });

  it('reports incomplete output when the sentinel is missing (crash or timeout)', () => {
    expect(parseNetTcpConnection('0.0.0.0|63711|0.0.0.0|0||17240\r\n').complete).toBe(false);
    expect(parseNetTcpConnection('').complete).toBe(false);
  });

  it('an empty listing is complete, not a failure', () => {
    expect(parseNetTcpConnection('#sei-done\r\n')).toEqual({ rows: [], complete: true });
  });

  it('treats empty, 0 and unnamed states as unknown, real states as known', () => {
    for (const s of ['', '0', ' ', '42', 'Weird']) expect(isUnknownTcpState(s)).toBe(true);
    for (const s of ['2', 'Listen', '5', 'Established', 'TimeWait', '100', 'Bound']) expect(isUnknownTcpState(s)).toBe(false);
  });

  it('picks the broken-state listeners as candidates and flags the signature', () => {
    const { rows } = parseNetTcpConnection(reporterOut);
    const r = statelessListenerCandidates(rows, new Set([17240]));
    // 50500 is Established (a known state): never a candidate.
    expect(r.ports.map((p) => p.port).sort()).toEqual([56048, 63711]);
    expect(r.brokenStateSeen).toBe(true);
  });

  it('a real Listen row is a candidate; known non-listen states never are', () => {
    const rows = parseNetTcpConnection(
      ['::|56048|::|0|2|17240', '192.168.1.20|50392|20.42.65.85|443|5|17240', '0.0.0.0|50600|0.0.0.0|0|100|17240', '#sei-done'].join('\n'),
    ).rows;
    const r = statelessListenerCandidates(rows, new Set([17240]));
    expect(r.ports.map((p) => p.port)).toEqual([56048]);
    expect(r.brokenStateSeen).toBe(false);
  });

  it('an unknown state needs a listener shape or a Java owner', () => {
    const rows = parseNetTcpConnection(['192.168.1.20|50392|20.42.65.85|443||999', '#sei-done'].join('\n')).rows;
    expect(statelessListenerCandidates(rows, new Set()).ports).toEqual([]);
    expect(statelessListenerCandidates(rows, new Set([999])).ports.map((p) => p.port)).toEqual([50392]);
  });

  it('dedupes a port listed on both stacks', () => {
    const rows = parseNetTcpConnection(['0.0.0.0|63711|0.0.0.0|0||17240', '::|63711|::|0||17240', '#sei-done'].join('\n')).rows;
    expect(statelessListenerCandidates(rows, new Set([17240])).ports).toHaveLength(1);
  });

  it('builds a one-line script for the given pids that reads the raw state', () => {
    const script = netTcpConnectionScript([17240, 5, -1, 1.5]);
    expect(script).not.toContain('\n');
    expect(script).not.toContain('"');
    expect(script).toContain('-OwningProcess 17240,5 ');
    expect(script).toContain("CimInstanceProperties['State'].Value");
    expect(script.endsWith("'#sei-done'")).toBe(true);
  });
});
