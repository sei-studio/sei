/** 261031 (T278): a keep-alive socket cannot hold the quit teardown open. */
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { stopHttpServer } from './httpServerStop';

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

describe('stopHttpServer', () => {
  it('resolves promptly with an idle keep-alive connection open', async () => {
    const server = http.createServer((_req, res) => res.end('ok'));
    const port = await listen(server);
    const agent = new http.Agent({ keepAlive: true });
    await new Promise<void>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, agent }, (res) => {
        res.resume();
        res.on('end', () => resolve());
      }).on('error', reject);
    });
    const t0 = Date.now();
    await stopHttpServer(server, 2000);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(server.listening).toBe(false);
    agent.destroy();
  });

  it('gives up after the timeout when a request never finishes', async () => {
    // The handler never responds: the connection stays active, not idle.
    const server = http.createServer(() => {});
    const port = await listen(server);
    const sock = net.connect(port, '127.0.0.1');
    sock.on('error', () => {});
    await new Promise<void>((resolve) => sock.on('connect', () => resolve()));
    sock.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n');
    await new Promise((r) => setTimeout(r, 50));
    const t0 = Date.now();
    await stopHttpServer(server, 300);
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(250);
    expect(took).toBeLessThan(1500);
    sock.destroy();
  });
});
