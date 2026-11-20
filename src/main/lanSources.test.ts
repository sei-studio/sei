import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { mcPing } from './mcPing';
import { diagnoseNoWorld, mergeCandidates, pingTiers, verifyCandidates, type LanCandidate } from './lanSources';

describe('mergeCandidates: source priority and dedupe', () => {
  it('dedupes by port, keeps every source in priority order regardless of input order', () => {
    const merged = mergeCandidates([
      { source: 'multicast', ports: [{ port: 63711, pid: null, command: '' }] },
      { source: 'stateless_enum', ports: [{ port: 63711, pid: 17240, command: 'javaw.exe' }] },
      { source: 'netstat', ports: [{ port: 135, pid: 1196, command: 'svchost.exe' }] },
    ]);
    expect(merged).toEqual([
      { port: 135, pid: 1196, command: 'svchost.exe', sources: ['netstat'] },
      { port: 63711, pid: 17240, command: 'javaw.exe', sources: ['stateless_enum', 'multicast'] },
    ]);
  });

  it('fills a missing pid / command from a lower-priority source', () => {
    const merged = mergeCandidates([
      { source: 'netstat', ports: [{ port: 50000, pid: null, command: '' }] },
      { source: 'stateless_enum', ports: [{ port: 50000, pid: 42, command: 'java.exe' }] },
    ]);
    expect(merged[0]).toMatchObject({ pid: 42, command: 'java.exe', sources: ['netstat', 'stateless_enum'] });
  });
});

describe('pingTiers', () => {
  const c = (port: number, command: string, sources: LanCandidate['sources']): LanCandidate => ({ port, pid: null, command, sources });
  it('java first, then fallback-hinted, then the rest; empty tiers dropped', () => {
    const tiers = pingTiers([c(1, 'svchost.exe', ['netstat']), c(2, '', ['multicast']), c(3, 'javaw.exe', ['netstat'])]);
    expect(tiers.map((t) => t.map((x) => x.port))).toEqual([[3], [2], [1]]);
    expect(pingTiers([c(1, '', ['netstat'])])).toHaveLength(1);
    expect(pingTiers([])).toEqual([]);
  });
});

// ---- candidate verification against real loopback sockets -----------------

function writeVarInt(v: number): Buffer {
  const out: number[] = [];
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
}

/** A loopback server that answers the status ping like an open LAN world. */
function fakeMcServer(motd: string): Promise<net.Server> {
  const server = tracked(net.createServer((sock) => {
    sock.once('data', () => {
      const json = Buffer.from(JSON.stringify({ version: { name: '26.1', protocol: 775 }, description: { text: motd } }));
      const body = Buffer.concat([writeVarInt(0), writeVarInt(json.length), json]);
      sock.end(Buffer.concat([writeVarInt(body.length), body]));
    });
  }));
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** A loopback listener that is not Minecraft (answers garbage). */
function fakeOtherServer(): Promise<net.Server> {
  const server = tracked(net.createServer((sock) => sock.end('HTTP/1.1 400 Bad Request\r\n\r\n')));
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const portOf = (s: net.Server): number => (s.address() as net.AddressInfo).port;

/** close() waits for open connections; destroy them so teardown is prompt. */
function closeHard(s: net.Server): Promise<void> {
  return new Promise((resolve) => {
    for (const sock of (s as net.Server & { _seiSocks?: Set<net.Socket> })._seiSocks ?? []) sock.destroy();
    s.close(() => resolve());
  });
}

function tracked(s: net.Server): net.Server {
  const socks = new Set<net.Socket>();
  (s as net.Server & { _seiSocks?: Set<net.Socket> })._seiSocks = socks;
  s.on('connection', (sock) => {
    socks.add(sock);
    sock.on('close', () => socks.delete(sock));
  });
  return s;
}

describe('verifyCandidates', () => {
  const servers: net.Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(closeHard));
  });
  const ping = (port: number) => mcPing(port, '127.0.0.1', 700);

  it('returns the candidate that speaks Minecraft, with its MOTD and source', async () => {
    const mc = await fakeMcServer('TorikaiYuki - New World');
    const other = await fakeOtherServer();
    servers.push(mc, other);
    const cands = mergeCandidates([
      { source: 'netstat', ports: [{ port: portOf(other), pid: 1, command: 'httpd.exe' }] },
      { source: 'stateless_enum', ports: [{ port: portOf(mc), pid: 17240, command: 'javaw.exe' }] },
    ]);
    const found = await verifyCandidates(pingTiers(cands), ping);
    expect(found?.status.port).toBe(portOf(mc));
    expect(found?.status.motd).toBe('TorikaiYuki - New World');
    expect(found?.candidate.sources).toEqual(['stateless_enum']);
  });

  it('a hint that does not answer (closed port, non-Minecraft, another PC) is rejected', async () => {
    const other = await fakeOtherServer();
    servers.push(other);
    const closed = await fakeOtherServer();
    const closedPort = portOf(closed);
    await closeHard(closed);
    const cands = mergeCandidates([
      { source: 'multicast', ports: [{ port: closedPort, pid: null, command: '' }] },
      { source: 'netstat', ports: [{ port: portOf(other), pid: 1, command: '' }] },
    ]);
    expect(await verifyCandidates(pingTiers(cands), ping)).toBeNull();
  });

  it('falls through tiers: a later tier still finds the world', async () => {
    const mc = await fakeMcServer('w');
    const other = await fakeOtherServer();
    servers.push(mc, other);
    const cands = mergeCandidates([
      { source: 'netstat', ports: [{ port: portOf(other), pid: 1, command: 'java.exe' }, { port: portOf(mc), pid: 2, command: '' }] },
    ]);
    const found = await verifyCandidates(pingTiers(cands), ping);
    expect(found?.candidate.port).toBe(portOf(mc));
  });
});

describe('diagnoseNoWorld', () => {
  const java = (sources: LanCandidate['sources']): LanCandidate => ({ port: 1, pid: 1, command: 'javaw.exe', sources });
  const other: LanCandidate = { port: 2, pid: 2, command: 'svchost.exe', sources: ['netstat'] };
  const win = (o: Partial<{ java: 'unknown' | 'none' | 'running'; pending: boolean; statelessFailed: boolean }>) => ({
    java: 'running' as const,
    pending: false,
    statelessFailed: false,
    ...o,
  });

  it('classifies each no-world case', () => {
    expect(diagnoseNoWorld({ primaryFailed: true, candidates: [], win: null })).toBe('enum_failed');
    expect(diagnoseNoWorld({ primaryFailed: false, candidates: [other], win: win({ java: 'none' }) })).toBe('no_java');
    expect(diagnoseNoWorld({ primaryFailed: false, candidates: [other, java(['stateless_enum'])], win: win({}) })).toBe('unverified');
    expect(diagnoseNoWorld({ primaryFailed: false, candidates: [other], win: win({ statelessFailed: true }) })).toBe('stateless_failed');
    expect(diagnoseNoWorld({ primaryFailed: false, candidates: [other], win: win({ pending: true }) })).toBe('pending');
    expect(diagnoseNoWorld({ primaryFailed: false, candidates: [other], win: win({}) })).toBe('no_java_listener');
    expect(diagnoseNoWorld({ primaryFailed: false, candidates: [other], win: null })).toBe('no_java_listener');
    expect(diagnoseNoWorld({ primaryFailed: false, candidates: [java(['lsof'])], win: null })).toBe('unverified');
  });
});
