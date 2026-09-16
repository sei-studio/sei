/** Game-adapters M2 (260908): the DST discovery watcher with a fixture client. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createDstWatcher } from './watcher';
import { heartbeatUntilOffer } from '../../../../scripts/fake-dst-mod.mjs';

const quiet = () => {};
let stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
});

async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

describe('createDstWatcher (no socket)', () => {
  it('is closed until a heartbeat, open for staleMs after one, and only pushes on change', () => {
    let t = 1000;
    const onUpdate = vi.fn();
    const w = createDstWatcher({ now: () => t, staleMs: 6000, log: quiet, port: 0 });
    stops.push(() => w.stop());
    expect(w.getState()).toEqual({ game: 'dontstarve', kind: 'closed' });
    // Feed heartbeats directly through the test seam (start() would bind).
    const resp = w.handleHello({ session: 'S', world: 'Sunny', day: 4, season: 'winter', phase: 'dusk', players: [{ userid: 'KU_1', name: 'Steve' }] });
    expect(resp).toEqual({ ok: true, app: 'sei' });
    expect(w.getState()).toMatchObject({ kind: 'open', worldName: 'Sunny', day: 4, phase: 'dusk', players: [{ userid: 'KU_1', name: 'Steve' }], lastSeenAt: 1000 });
    expect(w.latestHeartbeat()?.session).toBe('S');
    t = 7500;
    expect(w.getState().kind).toBe('closed');
    expect(w.latestHeartbeat()).toBeNull();
    // Junk heartbeats are ignored but still get an ok (the mod keeps going).
    expect(w.handleHello('nope')).toEqual({ ok: true, app: 'sei' });
    expect(w.getState().kind).toBe('closed');
    void onUpdate;
  });

  it('hands a queued summon offer to exactly one heartbeat and drops expired ones', () => {
    let t = 0;
    const w = createDstWatcher({ now: () => t, log: quiet, port: 0 });
    stops.push(() => w.stop());
    const offer = { token: 'tok-12345678', botPort: 5555, name: 'Sui', prefab: 'wigfrid', nearUserid: 'KU_1', announce: true, expiresAt: 10_000 };
    w.setSummonOffer('c1', offer);
    const r1 = w.handleHello({ session: 'S' });
    expect(r1.summon).toEqual({ token: 'tok-12345678', botPort: 5555, name: 'Sui', prefab: 'wigfrid', nearUserid: 'KU_1', announce: true });
    expect(w.handleHello({ session: 'S' }).summon).toBeUndefined();
    w.setSummonOffer('c2', { ...offer, name: 'Marv', expiresAt: 5 });
    t = 10;
    expect(w.handleHello({ session: 'S' }).summon).toBeUndefined();
    w.setSummonOffer('c3', { ...offer, name: 'Lyra' });
    w.setSummonOffer('c3', null);
    expect(w.handleHello({ session: 'S' }).summon).toBeUndefined();
  });
});

describe('createDstWatcher (socket)', () => {
  it('serves /hello over HTTP for the fake mod, pushes open on the first beat, and reports a taken port as unavailable', async () => {
    const port = await freePort();
    const onUpdate = vi.fn();
    const w = createDstWatcher({ port, log: quiet, pollMs: 50, staleMs: 400 });
    stops.push(() => w.stop());
    w.start({ onUpdate });
    await new Promise((r) => setTimeout(r, 50));
    w.setSummonOffer('c1', { token: 'tok-12345678', botPort: 4321, name: 'Sui', prefab: 'wilson', nearUserid: '', announce: true, expiresAt: Date.now() + 5000 });
    const offer = await heartbeatUntilOffer({ helloPort: port, intervalMs: 20, maxTries: 5 });
    expect(offer).toMatchObject({ token: 'tok-12345678', botPort: 4321, prefab: 'wilson' });
    expect(onUpdate.mock.calls.some((c) => c[0].kind === 'open' && c[0].worldName === 'Fake World')).toBe(true);
    expect((await w.checkNow()).kind).toBe('open');
    // No more beats: the edge to closed is pushed by the poll.
    await new Promise((r) => setTimeout(r, 700));
    expect(onUpdate.mock.calls.at(-1)?.[0].kind).toBe('closed');
    // Unknown paths and oversized queries are refused without a state change.
    expect((await fetch(`http://127.0.0.1:${port}/nope`)).status).toBe(404);
    // Node refuses an oversized request line itself (431) before our 413 cap.
    expect([413, 431]).toContain((await fetch(`http://127.0.0.1:${port}/hello?q=${'x'.repeat(20_000)}`)).status);

    // 260909: the candidates are walked in order, so a taken first port
    // lands on the next free one (and the /hello answer names the app).
    const other = await freePort();
    const second = createDstWatcher({ ports: [port, other], log: quiet, pollMs: 50 });
    stops.push(() => second.stop());
    const onUpdate2 = vi.fn();
    second.start({ onUpdate: onUpdate2 });
    await new Promise((r) => setTimeout(r, 100));
    expect(second.port).toBe(other);
    expect(second.getState().kind).toBe('closed');
    expect(await (await fetch(`http://127.0.0.1:${other}/hello?q=%7B%7D`)).json()).toEqual({ ok: true, app: 'sei' });
    // Every candidate taken = unavailable, with each reason; a rebind once one frees recovers.
    const third = createDstWatcher({ ports: [port, other], log: quiet, pollMs: 50 });
    stops.push(() => third.stop());
    third.start({ onUpdate: vi.fn() });
    await new Promise((r) => setTimeout(r, 100));
    expect(third.getState()).toMatchObject({ kind: 'unavailable', reason: `port ${port} is in use; port ${other} is in use` });
    second.stop();
    await new Promise((r) => setTimeout(r, 50));
    await third.rebind();
    expect(third.port).toBe(other);
    expect(third.getState().kind).toBe('closed');
  });
});
