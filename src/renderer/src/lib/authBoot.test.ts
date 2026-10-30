/**
 * 261029 (login lock on restart): the renderer's on-demand read of main's auth
 * state. The boot routing and the onboarding sign-in panel use it instead of
 * waiting on pushes that may have landed before they listened.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthSnapshot } from '@shared/ipc';

const bridge = vi.hoisted((): { authSnapshot?: () => Promise<unknown> } => ({}));
vi.mock('./ipcClient', () => ({ sei: bridge }));

import { AUTH_LOAD_WAIT_MS, readAuthSnapshot, waitForAuthScope } from './authBoot';

const signedIn = (scopeReady: boolean): AuthSnapshot => ({
  state: {
    kind: 'signed_in',
    user: { id: 'u1', email: 'a@b.c', emailVerified: true, createdAt: '2026-01-01T00:00:00Z' },
  },
  scopeReady,
  loaded: true,
  scope: scopeReady ? 'u1' : 'local',
});
const notLoaded: AuthSnapshot = { state: { kind: 'local' }, scopeReady: false, loaded: false, scope: 'local' };
const noSleep = (): Promise<void> => Promise.resolve();

/** A fake clock: `sleep` advances `now`. */
function fakeClock() {
  let t = 0;
  return {
    now: (): number => t,
    sleep: vi.fn(async (ms: number): Promise<void> => {
      t += ms;
    }),
  };
}

beforeEach(() => {
  delete bridge.authSnapshot;
});

describe('readAuthSnapshot', () => {
  it('is null when the bridge has no snapshot (older preload, test stubs)', async () => {
    expect(await readAuthSnapshot()).toBeNull();
  });
  it('is null when the call rejects or answers junk', async () => {
    bridge.authSnapshot = () => Promise.reject(new Error('no handler'));
    expect(await readAuthSnapshot()).toBeNull();
    bridge.authSnapshot = () => Promise.resolve({ nope: true });
    expect(await readAuthSnapshot()).toBeNull();
  });
  it("returns main's answer", async () => {
    bridge.authSnapshot = () => Promise.resolve(signedIn(true));
    expect(await readAuthSnapshot()).toEqual(signedIn(true));
  });
});

describe('waitForAuthScope', () => {
  it('does not wait when the scope is already ready', async () => {
    const fn = vi.fn(() => Promise.resolve(signedIn(true)));
    bridge.authSnapshot = fn;
    expect(await waitForAuthScope({ sleep: noSleep })).toEqual({ snapshot: signedIn(true), waited: false });
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it('polls through a scope switch and says it waited', async () => {
    const answers = [signedIn(false), signedIn(false), signedIn(true)];
    bridge.authSnapshot = () => Promise.resolve(answers.shift() ?? signedIn(true));
    expect(await waitForAuthScope({ sleep: noSleep })).toEqual({ snapshot: signedIn(true), waited: true });
  });
  it('gives up after the bound with the last answer', async () => {
    bridge.authSnapshot = () => Promise.resolve(signedIn(false));
    const clock = fakeClock();
    const res = await waitForAuthScope({ ...clock, timeoutMs: 900 });
    expect(res).toEqual({ snapshot: signedIn(false), waited: true });
    expect(clock.sleep).toHaveBeenCalledTimes(3);
  });
  it('polls while main has not loaded its auth state, then waits for the scope', async () => {
    // Review 261029: the old check returned at once on loaded === false and
    // the boot routed on main's default `local`.
    const answers = [notLoaded, notLoaded, notLoaded, signedIn(false), signedIn(true)];
    bridge.authSnapshot = () => Promise.resolve(answers.shift() ?? signedIn(true));
    const clock = fakeClock();
    expect(await waitForAuthScope(clock)).toEqual({ snapshot: signedIn(true), waited: true });
    expect(clock.sleep).toHaveBeenCalledTimes(4);
  });
  it('keeps polling an unloaded main for about 90 s, past the 10 s scope bound', async () => {
    bridge.authSnapshot = () => Promise.resolve(notLoaded);
    const clock = fakeClock();
    const res = await waitForAuthScope(clock);
    expect(res).toEqual({ snapshot: notLoaded, waited: true });
    expect(clock.now()).toBeGreaterThanOrEqual(AUTH_LOAD_WAIT_MS);
    expect(clock.now()).toBeLessThan(AUTH_LOAD_WAIT_MS + 1_000);
  });
  it('a main that loads after 51 s (an offline session refresh) is still waited for', async () => {
    const clock = fakeClock();
    bridge.authSnapshot = () => Promise.resolve(clock.now() < 51_000 ? notLoaded : signedIn(true));
    expect(await waitForAuthScope(clock)).toEqual({ snapshot: signedIn(true), waited: true });
  });
  it('the 90 s load bound is one deadline, even when each read itself waits on main', async () => {
    // Main's auth:snapshot handler can hold each call up to 30 s; the old
    // per-poll clock started after the first read and ran to ~150 s.
    let t = 0;
    const now = (): number => t;
    const sleep = vi.fn(async (ms: number) => {
      t += ms;
    });
    bridge.authSnapshot = async () => {
      t += 30_000;
      return notLoaded;
    };
    const res = await waitForAuthScope({ now, sleep });
    expect(res.snapshot).toEqual(notLoaded);
    expect(t).toBeLessThanOrEqual(AUTH_LOAD_WAIT_MS + 1_000);
  });
  it('retries a first read that failed (IPC threw) before giving up', async () => {
    const answers: Array<() => Promise<unknown>> = [
      () => Promise.reject(new Error('no handler yet')),
      () => Promise.reject(new Error('no handler yet')),
      () => Promise.resolve(signedIn(true)),
    ];
    bridge.authSnapshot = () => (answers.shift() ?? (() => Promise.resolve(signedIn(true))))();
    const clock = fakeClock();
    expect(await waitForAuthScope(clock)).toEqual({ snapshot: signedIn(true), waited: true });
    expect(clock.sleep).toHaveBeenCalledTimes(2);
  });
  it('falls back (null) after a few failed first reads', async () => {
    bridge.authSnapshot = () => Promise.reject(new Error('broken'));
    const clock = fakeClock();
    const res = await waitForAuthScope(clock);
    expect(res.snapshot).toBeNull();
    expect(clock.sleep).toHaveBeenCalledTimes(3);
  });
  it('stops when cancelled, and passes through a missing bridge', async () => {
    bridge.authSnapshot = () => Promise.resolve(signedIn(false));
    const sleep = vi.fn(noSleep);
    await waitForAuthScope({ sleep, isCancelled: () => true });
    expect(sleep).not.toHaveBeenCalled();
    delete bridge.authSnapshot;
    expect(await waitForAuthScope({ sleep })).toEqual({ snapshot: null, waited: false });
  });
});
