/** Stardew hello watcher (M1) against a local http fixture. */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createStardewWatcher, stateFromHello } from './watcher';

function helloServer(getBody: () => unknown | null): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const body = req.url === '/hello' ? getBody() : null;
    if (body == null) {
      res.writeHead(503);
      res.end();
      return;
    }
    const json = JSON.stringify(body);
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) });
    res.end(json);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: (server.address() as { port: number }).port })));
}

const openHello = (day = 3) => ({ mod: 'SeiCompanion', version: '0.1.0', protocol: 1, save: { loaded: true, farmName: 'Sunny', uniqueId: '42', day, season: 'spring', year: 1 } });
const titleHello = () => ({ mod: 'SeiCompanion', version: '0.1.0', protocol: 1, save: { loaded: false } });

describe('stateFromHello', () => {
  it('maps hello payloads to world states', () => {
    expect(stateFromHello(openHello(), 1, 5)).toMatchObject({ kind: 'open', farmName: 'Sunny', uniqueId: '42', day: 3, season: 'spring', port: 1, lastSeenAt: 5, label: 'Sunny Farm, spring 3' });
    expect(stateFromHello(titleHello(), 1, 5)).toEqual({ kind: 'game_running_no_save', port: 1 });
    expect(stateFromHello({ mod: 'x', version: '1', protocol: 2, save: { loaded: true } }, 1, 5)).toEqual({ kind: 'closed' });
    expect(stateFromHello({ nope: true }, 1, 5)).toEqual({ kind: 'closed' });
  });
});

describe('createStardewWatcher', () => {
  let server: Server | null = null;
  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = null;
  });

  it('walks not_installed -> closed -> title -> open -> tolerates one miss -> closed, emitting on change only', async () => {
    let body: unknown | null = null;
    const started = await helloServer(() => body);
    server = started.server;
    let port: number | null = null;
    const seen: string[] = [];
    const w = createStardewWatcher({ getPort: async () => port, intervalMs: 60_000, helloTimeoutMs: 500, portRefreshPolls: 1 });
    w.start({ onUpdate: (s) => seen.push(s.kind) });
    expect(await w.checkNowRaw()).toEqual({ kind: 'not_installed' });
    port = started.port;
    expect((await w.checkNowRaw()).kind).toBe('closed');
    body = titleHello();
    expect((await w.checkNowRaw()).kind).toBe('game_running_no_save');
    body = openHello(3);
    const open = await w.checkNowRaw();
    expect(open).toMatchObject({ kind: 'open', farmName: 'Sunny', day: 3 });
    expect(await w.checkNow()).toMatchObject({ game: 'stardew', kind: 'open' });
    // Same save, same day: no new emit.
    await w.checkNowRaw();
    expect(seen).toEqual(['not_installed', 'closed', 'game_running_no_save', 'open']);
    // A day change is a change.
    body = openHello(4);
    await w.checkNowRaw();
    expect(seen.at(-1)).toBe('open');
    expect(seen.filter((k) => k === 'open')).toHaveLength(2);
    // One miss is tolerated while open; the second flips to closed.
    body = null;
    expect((await w.checkNowRaw()).kind).toBe('open');
    expect((await w.checkNowRaw()).kind).toBe('closed');
    expect(seen.at(-1)).toBe('closed');
    w.stop();
  });
});
