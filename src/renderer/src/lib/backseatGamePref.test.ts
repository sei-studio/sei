/**
 * Tests for backseatGamePref (260929): the backseat game tile's one-time intro.
 *
 * Invariants:
 *   1. Nothing stored -> the intro is owed.
 *   2. Marking it seen persists, per GAME (Roblox seen does not retire a
 *      future Valorant intro).
 *   3. Per ACCOUNT: a second account on the same machine still gets it.
 *   4. Storage that throws degrades to "not seen" and never crashes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AuthState } from '@shared/ipc';

let authState: AuthState = { kind: 'local' };
vi.mock('./stores/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ state: authState }) },
}));

const { backseatGameIntroSeen, markBackseatGameIntroSeen } = await import('./backseatGamePref');

const signedIn = (id: string): AuthState => ({
  kind: 'signed_in',
  user: { id, email: 'a@b.com', emailVerified: true, createdAt: '2026-01-01T00:00:00Z' },
});

function fakeStorage(opts?: { throws?: boolean }): { storage: Storage; map: Map<string, string> } {
  const map = new Map<string, string>();
  const storage = {
    getItem: (k: string) => {
      if (opts?.throws) throw new Error('denied');
      return map.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (opts?.throws) throw new Error('denied');
      map.set(k, v);
    },
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
  return { storage, map };
}

function install(storage: Storage): void {
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  });
}

let map: Map<string, string>;

beforeEach(() => {
  const fake = fakeStorage();
  map = fake.map;
  install(fake.storage);
  authState = { kind: 'local' };
});

afterEach(() => {
  Reflect.deleteProperty(globalThis as unknown as Record<string, unknown>, 'localStorage');
});

describe('backseatGamePref', () => {
  it('owes the intro when nothing is stored', () => {
    expect(backseatGameIntroSeen('roblox')).toBe(false);
  });

  it('remembers it once seen, under a versioned per-game per-scope key', () => {
    markBackseatGameIntroSeen('roblox');
    expect(backseatGameIntroSeen('roblox')).toBe(true);
    expect(map.get('sei.backseatGameIntro.v1.roblox.local')).toBe('1');
  });

  it('keeps each game separate', () => {
    markBackseatGameIntroSeen('roblox');
    expect(backseatGameIntroSeen('valorant')).toBe(false);
  });

  it('is per account', () => {
    authState = signedIn('user-a');
    markBackseatGameIntroSeen('roblox');
    expect(backseatGameIntroSeen('roblox')).toBe(true);
    authState = signedIn('user-b');
    expect(backseatGameIntroSeen('roblox')).toBe(false);
    authState = { kind: 'local' };
    expect(backseatGameIntroSeen('roblox')).toBe(false);
  });

  it('degrades to not-seen when storage throws', () => {
    install(fakeStorage({ throws: true }).storage);
    expect(() => markBackseatGameIntroSeen('roblox')).not.toThrow();
    expect(backseatGameIntroSeen('roblox')).toBe(false);
  });
});
