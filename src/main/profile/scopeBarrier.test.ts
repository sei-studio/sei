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
  beginScopeSwitch,
  isScopeSwitchPending,
  noteScopeChanged,
  beginSessionStart,
  withScopedTurn,
  scopedTurnCurrent,
  ACCOUNT_SWITCHING,
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

describe('teardown ceiling', () => {
  it('a hung teardown resolves undefined at the ceiling and drops the flag', async () => {
    const t0 = Date.now();
    const out = await withAccountTeardown(() => new Promise<string>(() => {}), 30);
    expect(out).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(isAccountTeardownActive()).toBe(false);
  });

  it('a teardown that finishes in time returns its value', async () => {
    await expect(withAccountTeardown(async () => 'done', 1_000)).resolves.toBe('done');
    expect(isAccountTeardownActive()).toBe(false);
  });

  it('a throwing teardown still drops the flag', async () => {
    await expect(withAccountTeardown(async () => { throw new Error('boom'); }, 1_000)).rejects.toThrow('boom');
    expect(isAccountTeardownActive()).toBe(false);
  });
});

describe('session start guard', () => {
  it('refuses a start while a switch is pending, allows it after the release', () => {
    const release = beginScopeSwitch();
    expect(isScopeSwitchPending()).toBe(true);
    expect(() => beginSessionStart()).toThrow(ACCOUNT_SWITCHING);
    release();
    release(); // idempotent
    expect(isScopeSwitchPending()).toBe(false);
    expect(() => beginSessionStart()).not.toThrow();
  });

  it('refuses a start while the teardown runs', async () => {
    let inside: unknown = null;
    await withAccountTeardown(async () => {
      try { beginSessionStart(); } catch (err) { inside = err; }
    });
    expect((inside as { code?: string })?.code).toBe(ACCOUNT_SWITCHING);
  });

  it('stillValid turns false once a switch begins or the scope moves', () => {
    const a = beginSessionStart();
    expect(a.stillValid()).toBe(true);
    const release = beginScopeSwitch();
    expect(a.stillValid()).toBe(false);
    release();
    // The switch was requested and released without the scope moving (a
    // same-scope refresh): the start is fine again.
    expect(a.stillValid()).toBe(true);
    noteScopeChanged();
    expect(a.stillValid()).toBe(false);
  });
});

describe('chat turn scope', () => {
  it('withScopedTurn is refused while a switch is pending', async () => {
    const release = beginScopeSwitch();
    await expect(withScopedTurn(async () => 1)).rejects.toMatchObject({ code: ACCOUNT_SWITCHING });
    release();
    await expect(withScopedTurn(async () => 1)).resolves.toBe(1);
  });

  it('a turn stops being current when the scope moves under it', async () => {
    const seen: boolean[] = [];
    await withScopedTurn(async () => {
      seen.push(scopedTurnCurrent());
      await later(5);
      noteScopeChanged();
      await later(5);
      seen.push(scopedTurnCurrent());
    });
    expect(seen).toEqual([true, false]);
    // A turn started after the move is current again.
    await withScopedTurn(async () => {
      seen.push(scopedTurnCurrent());
    });
    expect(seen).toEqual([true, false, true]);
  });

  it('outside any turn only a running switch blocks', () => {
    expect(scopedTurnCurrent()).toBe(true);
    const release = beginScopeSwitch();
    expect(scopedTurnCurrent()).toBe(false);
    release();
    expect(scopedTurnCurrent()).toBe(true);
  });
});
