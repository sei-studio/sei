/**
 * mcPing (261125): a non-Minecraft listener that hangs up fails the ping at
 * once instead of holding it to the timeout, and a real status answer that
 * is followed by a close still resolves.
 */
import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import { mcPing } from './mcPing';

const servers: net.Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function listen(onConn: (s: net.Socket) => void): Promise<number> {
  const srv = net.createServer(onConn);
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return (srv.address() as net.AddressInfo).port;
}

function varInt(n: number): Buffer {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return Buffer.from(out);
}

function statusPacket(json: string): Buffer {
  const body = Buffer.concat([varInt(0x00), varInt(Buffer.byteLength(json)), Buffer.from(json)]);
  return Buffer.concat([varInt(body.length), body]);
}

describe('mcPing', () => {
  it.each([
    ['closes without a word', (s: net.Socket) => s.once('data', () => s.end())],
    ['short TLS alert, then close', (s: net.Socket) => s.once('data', () => s.end(Buffer.from([0x15, 0x03, 0x01, 0x00, 0x02, 0x02, 0x32])))],
    ['HTTP 400, then close', (s: net.Socket) => s.once('data', () => s.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n'))],
  ])('a listener that %s fails fast, not at the timeout', async (_l, onConn) => {
    const port = await listen(onConn);
    const t0 = Date.now();
    await expect(mcPing(port, '127.0.0.1', 5_000)).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it('a silent listener still times out', async () => {
    const port = await listen(() => {});
    await expect(mcPing(port, '127.0.0.1', 150)).rejects.toThrow('LAN_PING_TIMEOUT');
  });

  it('a status answer followed by a close resolves', async () => {
    const json = JSON.stringify({ version: { name: '1.21.1', protocol: 767 }, description: { text: 'My World' } });
    const port = await listen((s) => s.once('data', () => s.end(statusPacket(json))));
    const st = await mcPing(port, '127.0.0.1', 2_000);
    expect(st).toMatchObject({ port, motd: 'My World', versionName: '1.21.1', protocol: 767 });
  });
});
