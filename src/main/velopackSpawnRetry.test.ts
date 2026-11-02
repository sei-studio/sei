import { describe, expect, it, vi } from 'vitest';
import { isBusySpawnError, SPAWN_BUSY_DELAYS_MS, spawnWhenFree } from './velopackSpawnRetry';

/** What Node throws from spawn() for a Windows sharing violation. */
function spawnError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`spawn ${code}`), { code, syscall: 'spawn' });
}

function harness() {
  const slept: number[] = [];
  return { slept, sleep: async (ms: number) => void slept.push(ms) };
}

describe('spawnWhenFree', () => {
  it('waits about 3 s in total over 5 tries', () => {
    expect(SPAWN_BUSY_DELAYS_MS.length + 1).toBe(5);
    const total = SPAWN_BUSY_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(2500);
    expect(total).toBeLessThanOrEqual(3500);
  });

  it('starts at once when the file is free, without a recheck', async () => {
    const recheck = vi.fn(async () => null);
    const h = harness();
    const r = await spawnWhenFree(() => 'child', { recheck, sleep: h.sleep });
    expect(r).toEqual({ ok: true, value: 'child', retries: 0 });
    expect(recheck).not.toHaveBeenCalled();
    expect(h.slept).toEqual([]);
  });

  it('retries EBUSY, re-checking the file before each retry, then starts', async () => {
    const order: string[] = [];
    let tries = 0;
    const start = () => {
      order.push('start');
      if (++tries < 3) throw spawnError('EBUSY');
      return 'child';
    };
    const h = harness();
    const r = await spawnWhenFree(start, {
      recheck: async () => (order.push('recheck'), null),
      sleep: h.sleep,
    });
    expect(r).toEqual({ ok: true, value: 'child', retries: 2 });
    expect(order).toEqual(['start', 'recheck', 'start', 'recheck', 'start']);
    expect(h.slept).toEqual(SPAWN_BUSY_DELAYS_MS.slice(0, 2));
  });

  it('gives up with the spawn error when the file stays busy for every try', async () => {
    const start = vi.fn(() => {
      throw spawnError('EBUSY');
    });
    const onBusy = vi.fn();
    const h = harness();
    const r = await spawnWhenFree(start, { recheck: async () => null, sleep: h.sleep, onBusy });
    expect(r).toEqual({ ok: false, error: 'spawn EBUSY', retries: SPAWN_BUSY_DELAYS_MS.length });
    expect(start).toHaveBeenCalledTimes(SPAWN_BUSY_DELAYS_MS.length + 1);
    expect(h.slept).toEqual([...SPAWN_BUSY_DELAYS_MS]);
    expect(onBusy.mock.calls.map((c) => c[0])).toEqual([1, 2, 3, 4]);
  });

  it.each(['EPERM', 'EACCES', 'ENOENT', 'UNKNOWN'])('fails at once on %s', async (code) => {
    const start = vi.fn(() => {
      throw spawnError(code);
    });
    const recheck = vi.fn(async () => null);
    const h = harness();
    const r = await spawnWhenFree(start, { recheck, sleep: h.sleep });
    expect(r).toEqual({ ok: false, error: `spawn ${code}`, retries: 0 });
    expect(start).toHaveBeenCalledTimes(1);
    expect(recheck).not.toHaveBeenCalled();
    expect(h.slept).toEqual([]);
  });

  it('never starts a file whose recheck fails', async () => {
    const start = vi.fn(() => {
      throw spawnError('EBUSY');
    });
    const h = harness();
    const r = await spawnWhenFree(start, { recheck: async () => 'setup changed after its check', sleep: h.sleep });
    expect(r).toEqual({ ok: false, error: 'setup changed after its check', retries: 1 });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('only treats the EBUSY code as busy', () => {
    expect(isBusySpawnError(spawnError('EBUSY'))).toBe(true);
    expect(isBusySpawnError(new Error('spawn EBUSY'))).toBe(false);
    expect(isBusySpawnError(spawnError('EPERM'))).toBe(false);
    expect(isBusySpawnError(null)).toBe(false);
  });
});
