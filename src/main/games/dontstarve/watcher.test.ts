/** Game-adapters M2 (260908): the DST discovery watcher with a fixture client. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createDstWatcher, dstOfferShard } from './watcher';
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

// A world with caves (261104): the helper heartbeats from BOTH server
// shards, each with only its own players. Replays of the sequences that sent
// the body into the dark caves, where Charlie killed it ~16 s after spawn.
describe('createDstWatcher with a caves world (two shards)', () => {
  const offerFor = (nearUserid: string, expiresAt = 60_000) => ({
    token: 'tok-12345678', botPort: 5555, name: 'Sui', prefab: 'wilson', nearUserid, announce: true, expiresAt,
  });
  // Helper 0.3.0 (no shard fields): told apart by `caves`.
  const forestOld = (players: { userid: string; name: string }[] = [{ userid: 'KU_host', name: 'Host' }]) =>
    ({ session: 'FOREST', world: 'Cozy', day: 5, season: 'autumn', phase: 'day', caves: false, players, mod: '0.3.0' });
  const cavesOld = (players: { userid: string; name: string }[] = []) =>
    ({ session: 'CAVES', world: 'Cozy', day: 5, season: 'autumn', phase: 'night', caves: true, players, mod: '0.3.0' });

  it('never hands the offer to the cave shard when the player is in the forest, even when the caves beat first', () => {
    let t = 0;
    const w = createDstWatcher({ now: () => t, log: quiet, port: 0 });
    stops.push(() => w.stop());
    w.handleHello(forestOld());
    t = 500;
    w.handleHello(cavesOld());
    w.setSummonOffer('c1', offerFor('KU_host'));
    // The live order on a real two-shard server: beats interleave ~1:1.
    t = 1000;
    expect(w.handleHello(cavesOld()).summon).toBeUndefined();
    t = 1500;
    expect(w.handleHello(cavesOld()).summon).toBeUndefined();
    t = 2000;
    expect(w.handleHello(forestOld()).summon).toMatchObject({ nearUserid: 'KU_host' });
    t = 2500;
    expect(w.handleHello(cavesOld()).summon).toBeUndefined();
  });

  it('merges the shards: players from both, world facts from the shard the host is on, no flapping', () => {
    let t = 0;
    const w = createDstWatcher({ now: () => t, log: quiet, port: 0 });
    stops.push(() => w.stop());
    w.handleHello(forestOld());
    t = 100;
    w.handleHello(cavesOld([{ userid: 'KU_friend', name: 'Friend' }]));
    const s = w.getState();
    expect(s).toMatchObject({ kind: 'open', phase: 'day', caves: false, players: [{ userid: 'KU_host' }, { userid: 'KU_friend' }], lastSeenAt: 100 });
    // A cave beat last no longer makes the world read as night / caves.
    expect(w.latestHeartbeat()).toMatchObject({ session: 'FOREST', phase: 'day', caves: false });
    expect(w.latestHeartbeat()?.players.map((p) => p.userid)).toEqual(['KU_host', 'KU_friend']);
    // The cave shard stops (world closing): the forest alone keeps it open.
    t = 5000;
    w.handleHello(forestOld());
    t = 8000;
    expect(w.getState()).toMatchObject({ kind: 'open', players: [{ userid: 'KU_host' }] });
  });

  it('spawns beside a player who is down in the caves on the cave shard', () => {
    let t = 0;
    const w = createDstWatcher({ now: () => t, log: quiet, port: 0 });
    stops.push(() => w.stop());
    w.handleHello(forestOld([]));
    w.handleHello(cavesOld([{ userid: 'KU_host', name: 'Host' }]));
    // The join target names the host where they are.
    expect(w.latestHeartbeat()).toMatchObject({ caves: true, players: [{ userid: 'KU_host' }] });
    w.setSummonOffer('c1', offerFor('KU_host'));
    t = 1000;
    expect(w.handleHello(forestOld([])).summon).toBeUndefined();
    expect(w.handleHello(cavesOld([{ userid: 'KU_host', name: 'Host' }])).summon).toMatchObject({ nearUserid: 'KU_host' });
  });

  it('with no player listed anywhere, or one it cannot find, the offer goes to the master shard only', () => {
    let t = 0;
    const w = createDstWatcher({ now: () => t, log: quiet, port: 0 });
    stops.push(() => w.stop());
    w.handleHello(forestOld([]));
    w.handleHello(cavesOld([]));
    w.setSummonOffer('c1', offerFor(''));
    w.setSummonOffer('c2', offerFor('KU_gone'));
    t = 1000;
    expect(w.handleHello(cavesOld([])).summon).toBeUndefined();
    expect(w.handleHello(forestOld([])).summon).toBeDefined();
    expect(w.handleHello(cavesOld([])).summon).toBeUndefined();
    expect(w.handleHello(forestOld([])).summon).toBeDefined();
  });

  it('holds the offer while only the cave shard is heard from (never alone in the dark)', () => {
    let t = 0;
    const w = createDstWatcher({ now: () => t, staleMs: 6000, log: quiet, port: 0 });
    stops.push(() => w.stop());
    w.handleHello(cavesOld([]));
    w.setSummonOffer('c1', offerFor('KU_host'));
    expect(w.handleHello(cavesOld([])).summon).toBeUndefined();
    t = 2000;
    expect(w.handleHello(forestOld()).summon).toMatchObject({ nearUserid: 'KU_host' });
  });

  it('keys shards by the 0.3.1 shard id and mastershard flag when the helper sends them', () => {
    let t = 0;
    const w = createDstWatcher({ now: () => t, log: quiet, port: 0 });
    stops.push(() => w.stop());
    const master = { ...forestOld(), mod: '0.3.1', shard: '1', mastershard: true };
    const caves = { ...cavesOld(), mod: '0.3.1', shard: '1462863447', mastershard: false };
    w.handleHello(master);
    w.handleHello(caves);
    w.setSummonOffer('c1', offerFor('KU_host'));
    t = 1000;
    expect(w.handleHello(caves).summon).toBeUndefined();
    expect(w.handleHello(master).summon).toBeDefined();
  });

  it('dstOfferShard picks the player\'s shard, else an occupied one for no name, else the master, never a stray cave', () => {
    const beat = (key: string, hb: Record<string, unknown>) => ({ key, at: 0, hb: { players: [], caves: false, ...hb } as never });
    const master = beat('master', { players: [{ userid: 'KU_a', name: 'A' }] });
    const caves = beat('caves', { caves: true, players: [{ userid: 'KU_b', name: 'B' }] });
    const emptyMaster = beat('master', {});
    expect(dstOfferShard('KU_b', [master, caves])).toBe('caves');
    expect(dstOfferShard('KU_a', [master, caves])).toBe('master');
    expect(dstOfferShard('KU_x', [master, caves])).toBe('master');
    expect(dstOfferShard('', [emptyMaster, caves])).toBe('caves');
    expect(dstOfferShard('KU_x', [caves])).toBeNull();
    expect(dstOfferShard('', [])).toBeNull();
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
