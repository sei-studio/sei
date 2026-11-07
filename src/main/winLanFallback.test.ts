import { describe, expect, it, vi } from 'vitest';
import type { BeaconEntry, BeaconHandle } from './lanBeacon';
import type { ListeningPort } from './listeningPorts';
import {
  STATELESS_EMPTY_RUNS_BEFORE_SLOW,
  STATELESS_INTERVAL_MS,
  STATELESS_SLOW_INTERVAL_MS,
  createWinLanFallback,
  type WinFallbackDeps,
} from './winLanFallback';

const HEALTHY = { primaryFailed: false, primaryListenerCount: 12 };

function harness(over: Partial<WinFallbackDeps> & { beaconEntries?: BeaconEntry[] } = {}) {
  let t = 0;
  const beaconStop = vi.fn();
  const beacon: BeaconHandle = { entries: () => over.beaconEntries ?? [], listening: true, stop: beaconStop };
  const deps: WinFallbackDeps = {
    javaPids: over.javaPids ?? vi.fn(async () => [17240]),
    statelessEnum: over.statelessEnum ?? vi.fn(async () => ({ ports: [] as ListeningPort[], brokenStateSeen: false })),
    startBeacon: over.startBeacon ?? vi.fn(() => beacon),
    now: () => t,
  };
  const fb = createWinLanFallback(deps);
  return {
    fb,
    deps,
    beaconStop,
    advance: (ms: number) => {
      t += ms;
    },
    /** One poll: read candidates, then let any refresh it kicked finish. */
    poll: async (ctx = HEALTHY) => {
      const snap = fb.candidates(ctx);
      await fb.idle();
      return snap;
    },
  };
}

describe('winLanFallback', () => {
  it('no Java running: tasklist only, never PowerShell, never the beacon', async () => {
    const h = harness({ javaPids: vi.fn(async () => []) });
    await h.poll();
    const snap = await h.poll();
    expect(h.deps.statelessEnum).not.toHaveBeenCalled();
    expect(h.deps.startBeacon).not.toHaveBeenCalled();
    expect(snap).toMatchObject({ java: 'none', lists: [], pending: false });
  });

  it('broken-state Java listener: lists it as stateless_enum and starts the beacon', async () => {
    const h = harness({
      statelessEnum: vi.fn(async () => ({ ports: [{ port: 63711, pid: 17240, command: 'javaw.exe' }], brokenStateSeen: true })),
      beaconEntries: [{ port: 63711, motd: 'w', lastSeenAt: 0 }],
    });
    const first = await h.poll();
    expect(first.pending).toBe(true); // the listing was still running when the poll read it
    const snap = await h.poll();
    expect(h.deps.statelessEnum).toHaveBeenCalledWith([17240]);
    expect(h.deps.startBeacon).toHaveBeenCalledTimes(1);
    expect(snap.lists.map((l) => l.source)).toEqual(['stateless_enum', 'multicast']);
    expect(snap.lists[0].ports[0].port).toBe(63711);
    expect(snap).toMatchObject({ java: 'running', pending: false, brokenStateSeen: true, beaconActive: true });
  });

  it('healthy machine (Java up, not open to LAN): no beacon, so no firewall prompt', async () => {
    const h = harness();
    for (let i = 0; i < 5; i++) {
      await h.poll();
      h.advance(STATELESS_INTERVAL_MS);
    }
    expect(h.deps.startBeacon).not.toHaveBeenCalled();
  });

  it('PowerShell failing starts the beacon and reports stateless_failed', async () => {
    const h = harness({ statelessEnum: vi.fn(async () => Promise.reject(new Error('blocked'))) });
    await h.poll();
    const snap = await h.poll();
    expect(snap.statelessFailed).toBe(true);
    expect(h.deps.startBeacon).toHaveBeenCalledTimes(1);
  });

  it('netstat listing nothing at all (or failing) starts the beacon', async () => {
    const h = harness();
    await h.poll({ primaryFailed: false, primaryListenerCount: 0 });
    expect(h.deps.startBeacon).toHaveBeenCalledTimes(1);
    const h2 = harness();
    await h2.poll({ primaryFailed: true, primaryListenerCount: 0 });
    expect(h2.deps.startBeacon).toHaveBeenCalledTimes(1);
  });

  it('throttles PowerShell to the interval, then slows down after repeated empty runs', async () => {
    const h = harness();
    await h.poll();
    h.advance(2000);
    await h.poll();
    expect(h.deps.statelessEnum).toHaveBeenCalledTimes(1); // 2s later: not due
    for (let i = 1; i < STATELESS_EMPTY_RUNS_BEFORE_SLOW; i++) {
      h.advance(STATELESS_INTERVAL_MS);
      await h.poll();
    }
    expect(h.deps.statelessEnum).toHaveBeenCalledTimes(STATELESS_EMPTY_RUNS_BEFORE_SLOW);
    h.advance(STATELESS_INTERVAL_MS);
    await h.poll();
    expect(h.deps.statelessEnum).toHaveBeenCalledTimes(STATELESS_EMPTY_RUNS_BEFORE_SLOW); // now on the slow interval
    h.advance(STATELESS_SLOW_INTERVAL_MS - STATELESS_INTERVAL_MS);
    await h.poll();
    expect(h.deps.statelessEnum).toHaveBeenCalledTimes(STATELESS_EMPTY_RUNS_BEFORE_SLOW + 1);
  });

  it('once netstat has found a world, the PowerShell fallback stops for the session', async () => {
    const h = harness();
    h.fb.noteFound('netstat');
    await h.poll();
    h.advance(STATELESS_SLOW_INTERVAL_MS);
    await h.poll();
    expect(h.deps.javaPids).not.toHaveBeenCalled();
    expect(h.deps.statelessEnum).not.toHaveBeenCalled();
  });

  it('stop() stops the beacon', async () => {
    const h = harness({ statelessEnum: vi.fn(async () => ({ ports: [], brokenStateSeen: true })) });
    await h.poll();
    h.fb.stop();
    expect(h.beaconStop).toHaveBeenCalled();
  });
});
