/**
 * 261029 review: when the onboarding sign-in panel may move on. Behavior
 * tests over the gate OnboardApp wires its pushes and snapshot reads into.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AuthSnapshot, AuthState, ScopeChangedEvent } from '@shared/ipc';
import { createSignInScopeGate, scopeIsAccount, snapshotConfirmsAccount, CONFIRM_RETRY_MS } from './signInScopeGate';

const A = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const B = '7a2b3c4d-5e6f-4a70-8b8c-9d0e1f2a3b4c';
const signedIn = (id: string): AuthState => ({
  kind: 'signed_in',
  user: { id, email: `${id.slice(0, 4)}@x.y`, emailVerified: true, createdAt: '2026-01-01T00:00:00Z' },
});
const local: AuthState = { kind: 'local' };
const snap = (state: AuthState, scope: string, scopeReady = true, loaded = true): AuthSnapshot => ({
  state,
  scope,
  scopeReady,
  loaded,
});
const scopeEv = (scope: string, reason: ScopeChangedEvent['reason'] = 'sign-in'): ScopeChangedEvent =>
  ({ scope, reason }) as ScopeChangedEvent;
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function harness(initial: AuthState, readSnapshot: () => Promise<AuthSnapshot | null>) {
  const auth = { current: initial };
  const ready = { current: false };
  const onChange = vi.fn();
  const sleep = vi.fn(async () => {});
  const gate = createSignInScopeGate({ auth, ready, readSnapshot, onChange, sleep, retries: 5 });
  return { auth, ready, onChange, sleep, gate };
}

describe('scopeIsAccount / snapshotConfirmsAccount', () => {
  it("match only the signed-in account's own profile, case-insensitively", () => {
    expect(scopeIsAccount(A.toUpperCase(), signedIn(A))).toBe(true);
    expect(scopeIsAccount(B, signedIn(A))).toBe(false);
    expect(scopeIsAccount('local', signedIn(A))).toBe(false);
    expect(scopeIsAccount(A, local)).toBe(false);
    expect(snapshotConfirmsAccount(snap(signedIn(A), A), signedIn(A))).toBe(true);
    expect(snapshotConfirmsAccount(snap(signedIn(A), A, false), signedIn(A))).toBe(false);
    expect(snapshotConfirmsAccount(snap(signedIn(A), 'local'), signedIn(A))).toBe(false);
    expect(snapshotConfirmsAccount(snap(signedIn(B), B), signedIn(A))).toBe(false);
    expect(snapshotConfirmsAccount(null, signedIn(A))).toBe(false);
  });
});

describe('createSignInScopeGate', () => {
  it("a scope push for account A does not make a sign-in as B ready", () => {
    const h = harness(signedIn(B), async () => null);
    h.gate.onScopeChanged(scopeEv(A));
    expect(h.ready.current).toBe(false);
    expect(h.onChange).not.toHaveBeenCalled();
    h.gate.onScopeChanged(scopeEv(B));
    expect(h.ready.current).toBe(true);
    expect(h.onChange).toHaveBeenCalledTimes(1);
  });

  it('a move to local (sign-out) or a sign-in push while local is never ready', () => {
    const h = harness(local, async () => null);
    h.gate.onScopeChanged(scopeEv(A));
    expect(h.ready.current).toBe(false);
    h.auth.current = signedIn(A);
    h.ready.current = true;
    h.gate.onScopeChanged(scopeEv('local', 'sign-out'));
    expect(h.ready.current).toBe(false);
  });

  it("confirms with main's snapshot when no push is coming (scope already right)", async () => {
    const read = vi.fn(async () => snap(signedIn(A), A));
    const h = harness(signedIn(A), read);
    h.gate.confirm();
    await tick();
    expect(h.ready.current).toBe(true);
    expect(h.onChange).toHaveBeenCalledTimes(1);
  });

  it('keeps asking while main is still moving the profile, then confirms', async () => {
    const answers = [snap(signedIn(A), 'local', false), snap(signedIn(A), 'local', false), snap(signedIn(A), A)];
    const read = vi.fn(async () => answers.shift() ?? snap(signedIn(A), A));
    const h = harness(signedIn(A), read);
    h.gate.confirm();
    h.gate.confirm(); // single-flight
    for (let i = 0; i < 10; i++) await tick();
    expect(h.ready.current).toBe(true);
    expect(read).toHaveBeenCalledTimes(3);
    expect(h.sleep).toHaveBeenCalledWith(CONFIRM_RETRY_MS);
  });

  it("a snapshot of another account's profile never confirms (gives up after the retries)", async () => {
    const read = vi.fn(async () => snap(signedIn(B), B));
    const h = harness(signedIn(A), read);
    h.gate.confirm();
    for (let i = 0; i < 20; i++) await tick();
    expect(h.ready.current).toBe(false);
    expect(read).toHaveBeenCalledTimes(6);
  });

  it('stops asking when main is loaded and signed out, or has no bridge', async () => {
    const out = vi.fn(async () => snap(local, 'local'));
    const h = harness(signedIn(A), out);
    h.gate.confirm();
    for (let i = 0; i < 5; i++) await tick();
    expect(out).toHaveBeenCalledTimes(1);
    const none = vi.fn(async () => null);
    const h2 = harness(signedIn(A), none);
    h2.gate.confirm();
    for (let i = 0; i < 5; i++) await tick();
    expect(none).toHaveBeenCalledTimes(1);
  });

  it('an auth push for a different account resets readiness and re-checks; the same account keeps it', async () => {
    const read = vi.fn(async () => snap(signedIn(A), A, false));
    const h = harness(signedIn(A), read);
    h.ready.current = true;
    h.gate.onAuth(signedIn(A)); // token refresh for the same account
    expect(h.ready.current).toBe(true);
    h.gate.onAuth(signedIn(B));
    expect(h.ready.current).toBe(false);
    expect(h.auth.current).toEqual(signedIn(B));
    await tick();
    expect(read).toHaveBeenCalled();
  });

  it('does nothing after dispose', async () => {
    const read = vi.fn(async () => snap(signedIn(A), A));
    const h = harness(signedIn(A), read);
    h.gate.dispose();
    h.gate.confirm();
    await tick();
    expect(h.ready.current).toBe(false);
  });
});
