/**
 * 261029 review: App's boot routing on main's auth state. Drives the real
 * waitForAuthScope (fake clock) into resolveBootRoute, the function App's
 * boot effect calls, so a snapshot sequence maps to the first view.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthSnapshot, AuthState } from '@shared/ipc';

const bridge = vi.hoisted((): { authSnapshot?: () => Promise<unknown> } => ({}));
vi.mock('./ipcClient', () => ({ sei: bridge }));

import { waitForAuthScope } from './authBoot';
import { bootDestination, resolveBootRoute, type BootProfile } from './bootRoute';

const ID = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const signedIn: AuthState = {
  kind: 'signed_in',
  user: { id: ID, email: 'p@x.y', emailVerified: true, createdAt: '2026-01-01T00:00:00Z' },
};
const local: AuthState = { kind: 'local' };
const notLoaded: AuthSnapshot = { state: local, scopeReady: false, loaded: false, scope: 'local' };
const loadedSignedIn = (scopeReady = true): AuthSnapshot => ({
  state: signedIn,
  scopeReady,
  loaded: true,
  scope: scopeReady ? ID : 'local',
});

/** App's side: the store, the profile reads, a fake clock. */
function harness(opts: { store?: AuthState; profiles: BootProfile[]; snapshots: () => AuthSnapshot | null }) {
  let t = 0;
  let store: AuthState = opts.store ?? local;
  const profiles = [...opts.profiles];
  let profile = profiles.shift()!;
  bridge.authSnapshot = async () => opts.snapshots();
  const applied: AuthState[] = [];
  const rehydrate = vi.fn(async () => {
    profile = profiles.shift() ?? profile;
    return true;
  });
  const deps = {
    waitForScope: () =>
      waitForAuthScope({
        now: () => t,
        sleep: async (ms: number) => {
          t += ms;
        },
      }),
    applyAuthState: (s: AuthState) => {
      applied.push(s);
      store = s;
    },
    currentAuth: () => store,
    rehydrate,
    scopeChangedSinceHydrate: () => false,
    profile: () => profile,
    isCancelled: () => false,
  };
  return {
    deps,
    applied,
    rehydrate,
    clock: () => t,
    push: (s: AuthState) => (store = s),
  };
}

beforeEach(() => {
  delete bridge.authSnapshot;
});

describe('bootDestination', () => {
  const done: BootProfile = { onboardedName: 'Ann', skinPending: false };
  it('maps auth state and profile to the first view', () => {
    expect(bootDestination(signedIn, done)).toBe('home');
    expect(bootDestination(signedIn, { onboardedName: 'Ann', skinPending: true })).toBe('skin-setup');
    expect(bootDestination(signedIn, { onboardedName: '', skinPending: false })).toBe('onboard');
    expect(bootDestination(local, done)).toBe('signin');
    expect(bootDestination(local, { onboardedName: '', skinPending: false })).toBe('onboard');
  });

  it('T283: a nameless profile that was set up before is never onboarded', () => {
    const recovered: BootProfile = { onboardedName: '', skinPending: false, returning: true };
    expect(bootDestination(signedIn, recovered)).toBe('home');
    expect(bootDestination(local, recovered)).toBe('signin');
    // returning: false is the fresh install it always was.
    expect(bootDestination(signedIn, { ...recovered, returning: false })).toBe('onboard');
    expect(bootDestination(local, { ...recovered, returning: false })).toBe('onboard');
  });
});

describe('resolveBootRoute with a loaded:false snapshot (review 261029)', () => {
  it('main still loading for a while, then signed in: goes home, never to the sign-in panel', async () => {
    // The boot read the LOCAL profile (onboarded) while main was not loaded;
    // once loaded, the account's profile is read.
    let calls = 0;
    const h = harness({
      profiles: [
        { onboardedName: 'LocalName', skinPending: false },
        { onboardedName: 'Ann', skinPending: false },
      ],
      snapshots: () => (++calls < 50 ? notLoaded : loadedSignedIn()),
    });
    expect(await resolveBootRoute(h.deps)).toBe('home');
    expect(h.applied).toEqual([signedIn]);
    expect(h.rehydrate).toHaveBeenCalledTimes(1);
    expect(h.clock()).toBeGreaterThan(10_000); // past the old 10 s scope bound
  });

  it('loaded and signed in but the profile still moving: waits, re-reads, goes home', async () => {
    const answers = [loadedSignedIn(false), loadedSignedIn(false), loadedSignedIn(true)];
    const h = harness({
      profiles: [
        { onboardedName: 'LocalName', skinPending: false },
        { onboardedName: 'Ann', skinPending: false },
      ],
      snapshots: () => answers.shift() ?? loadedSignedIn(),
    });
    expect(await resolveBootRoute(h.deps)).toBe('home');
    expect(h.rehydrate).toHaveBeenCalledTimes(1);
  });

  it("past the bound, an unloaded snapshot's local default is not applied over a signed-in push", async () => {
    const h = harness({
      store: signedIn, // main's push landed in the store
      profiles: [{ onboardedName: 'Ann', skinPending: false }],
      snapshots: () => notLoaded,
    });
    expect(await resolveBootRoute(h.deps)).toBe('home');
    expect(h.applied).toEqual([]);
  });

  it('a genuinely signed-out, onboarded profile still lands on the sign-in panel', async () => {
    const h = harness({
      profiles: [{ onboardedName: 'Ann', skinPending: false }],
      snapshots: () => ({ state: local, scopeReady: true, loaded: true, scope: 'local' }),
    });
    expect(await resolveBootRoute(h.deps)).toBe('signin');
    expect(h.rehydrate).not.toHaveBeenCalled();
  });

  it('re-reads the profile when a scope change landed while it decided', async () => {
    const h = harness({
      profiles: [
        { onboardedName: '', skinPending: false },
        { onboardedName: 'Ann', skinPending: true },
      ],
      snapshots: () => loadedSignedIn(),
    });
    const dest = await resolveBootRoute({ ...h.deps, scopeChangedSinceHydrate: () => true });
    expect(dest).toBe('skin-setup');
  });

  it('returns null when the boot is cancelled', async () => {
    const h = harness({ profiles: [{ onboardedName: 'Ann', skinPending: false }], snapshots: () => loadedSignedIn() });
    expect(await resolveBootRoute({ ...h.deps, isCancelled: () => true })).toBeNull();
  });
});
