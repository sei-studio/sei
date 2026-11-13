import { afterEach, describe, expect, it } from 'vitest';
import dgram from 'node:dgram';
import { frames, parseFrame } from '../../../bot/adapter/factorio/client.js';
import type { WorldState } from '../../../shared/gameIpc';
import { createFactorioWatcher, probeHello, stateFromProbe, type ProbeResult } from './watcher';

const HELLO = {
  ok: true,
  mod: 'sei-companion',
  game: '2.1.4',
  protocol: 1,
  tick: 1200,
  player_index: 1,
  players: [{ i: 1, name: 'ouen' }],
  multiplayer: false,
  world: '123456-60',
  seed: 123456,
};

describe('stateFromProbe', () => {
  it('maps the three answers', () => {
    expect(stateFromProbe({ kind: 'refused' }, 34990, 5)).toEqual({ game: 'factorio', kind: 'closed' });
    expect(stateFromProbe({ kind: 'silent' }, 34990, 5)).toEqual({ game: 'factorio', kind: 'no_game', port: 34990 });
    expect(stateFromProbe({ kind: 'reply', reply: HELLO }, 34990, 5)).toEqual({
      game: 'factorio',
      kind: 'open',
      label: 'Factorio',
      lastSeenAt: 5,
      port: 34990,
      detail: { players: [{ i: 1, name: 'ouen' }], multiplayer: false, world: '123456-60', paused: false },
    });
  });

  it('treats a bad reply or another protocol as no game', () => {
    expect(stateFromProbe({ kind: 'reply', reply: { ok: false } }, 1, 0).kind).toBe('no_game');
    expect(stateFromProbe({ kind: 'reply', reply: { ...HELLO, protocol: 2 } }, 1, 0).kind).toBe('no_game');
  });
});

describe('createFactorioWatcher', () => {
  it('emits on change only, tolerates one miss, reads later silence as paused', async () => {
    const answers: ProbeResult[] = [
      { kind: 'silent' }, // Factorio holds the port, no game yet
      { kind: 'reply', reply: HELLO },
      { kind: 'reply', reply: HELLO },
      { kind: 'silent' }, // one miss: unchanged
      { kind: 'silent' }, // still quiet: paused
      { kind: 'reply', reply: HELLO }, // ticking again
      { kind: 'refused' }, // one miss
      { kind: 'refused' }, // the game quit
    ];
    const seen: WorldState[] = [];
    const w = createFactorioWatcher({ getPort: () => 34990, probe: async () => answers.shift() ?? { kind: 'refused' }, intervalMs: 60_000 });
    w.start({ onUpdate: (s) => seen.push(s) });
    for (let i = 0; i < 8; i++) await w.checkNow(); // the start tick is shared with the first checkNow
    w.stop();
    const label = (s: WorldState): string => (s.kind === 'open' && s.game === 'factorio' ? `open${s.detail.paused ? '/paused' : ''}` : s.kind);
    expect(seen.map(label)).toEqual(['no_game', 'open', 'open/paused', 'open', 'closed']);
  });

  it('is closed without a probe when no port is known', async () => {
    let probes = 0;
    const w = createFactorioWatcher({ getPort: () => null, probe: async () => (probes++, { kind: 'silent' }) });
    expect((await w.checkNow()).kind).toBe('closed');
    expect(probes).toBe(0);
  });
});

describe('probeHello over real localhost UDP', () => {
  const sockets: dgram.Socket[] = [];
  afterEach(() => {
    for (const s of sockets.splice(0)) s.close();
  });

  async function fakeMod(answer: boolean): Promise<number> {
    const s = dgram.createSocket('udp4');
    sockets.push(s);
    s.on('message', (msg, rinfo) => {
      const f = parseFrame(msg);
      if (!f || !answer) return;
      for (const dg of frames(f.id, JSON.stringify(HELLO))) s.send(dg, rinfo.port, rinfo.address);
    });
    await new Promise<void>((r) => s.bind(0, '127.0.0.1', () => r()));
    return s.address().port;
  }

  it('reads a reply, a silent port and a refused port', async () => {
    expect(await probeHello(await fakeMod(true), 1500)).toEqual({ kind: 'reply', reply: expect.objectContaining({ ok: true, protocol: 1 }) });
    expect(await probeHello(await fakeMod(false), 600)).toEqual({ kind: 'silent' });
    const closed = await fakeMod(false);
    sockets.pop()!.close();
    const r = await probeHello(closed, 1500);
    // Linux and macOS report ICMP port-unreachable on a connected UDP socket.
    expect(['refused', 'silent']).toContain(r.kind);
  });
});
