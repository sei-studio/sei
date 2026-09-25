/**
 * scopeBarrier (260926): the write barrier an account switch drains before it
 * re-points the profile scope, and the teardown flag the fold defers on.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  trackScopedWrite,
  drainScopedWrites,
  pendingScopedWrites,
  withAccountTeardown,
  isAccountTeardownActive,
  _resetScopeBarrierForTests,
} from './scopeBarrier';

const later = (ms: number, fn: () => void = () => {}): Promise<void> =>
  new Promise((r) => setTimeout(() => { fn(); r(); }, ms));

beforeEach(() => _resetScopeBarrierForTests());

describe('scope write barrier', () => {
  it('drain waits for every tracked write', async () => {
    const done: string[] = [];
    void trackScopedWrite(later(20, () => done.push('a')));
    void trackScopedWrite(later(5, () => done.push('b')));
    expect(pendingScopedWrites()).toBe(2);
    expect(await drainScopedWrites()).toBe(true);
    expect(done.sort()).toEqual(['a', 'b']);
    expect(pendingScopedWrites()).toBe(0);
  });

  it('drain also waits for a write registered while it is draining', async () => {
    const done: string[] = [];
    // The bot's play row is registered only after its process exits, i.e.
    // after the drain may already have started.
    void trackScopedWrite(
      later(5, () => {
        void trackScopedWrite(later(15, () => done.push('late')));
      }),
    );
    expect(await drainScopedWrites()).toBe(true);
    expect(done).toEqual(['late']);
  });

  it('a rejected write neither throws from the drain nor blocks it', async () => {
    const p = trackScopedWrite(Promise.reject(new Error('disk full')));
    await expect(p).rejects.toThrow('disk full');
    expect(await drainScopedWrites()).toBe(true);
  });

  it('drain gives up at its timeout', async () => {
    void trackScopedWrite(new Promise(() => {}));
    expect(await drainScopedWrites(20)).toBe(false);
  });

  it('isAccountTeardownActive is true only inside withAccountTeardown', async () => {
    expect(isAccountTeardownActive()).toBe(false);
    let inside = false;
    await withAccountTeardown(async () => {
      await later(1);
      inside = isAccountTeardownActive();
    });
    expect(inside).toBe(true);
    expect(isAccountTeardownActive()).toBe(false);
    await expect(
      withAccountTeardown(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(isAccountTeardownActive()).toBe(false);
  });
});
