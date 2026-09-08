/**
 * Tests for useGamePackStore (260908). Invariants:
 *   1. init() subscribes to the push and pulls every known game's state.
 *   2. A push updates that game's state in place.
 *   3. ensure() flips to an optimistic `downloading` before main answers, then
 *      settles on the returned state (ready).
 *   4. ensure() on a ready pack does not call main.
 *   5. ensure() returns the error state (no throw) so the card can retry.
 *
 * Mock strategy mirrors useNoticesStore.test.ts: stub window.sei before the
 * store module is imported (ipcClient reads window.sei at module init).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GamePackProgressPush, GamePackState } from '@shared/gamePacks';

let stateMock: ReturnType<typeof vi.fn<(game: string) => Promise<GamePackState>>>;
let ensureMock: ReturnType<typeof vi.fn<(game: string) => Promise<GamePackState>>>;
let pushHandler: ((p: GamePackProgressPush) => void) | null;
let unsub: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  vi.resetModules();
  pushHandler = null;
  unsub = vi.fn();
  stateMock = vi.fn(async () => ({ kind: 'missing' }) as GamePackState);
  ensureMock = vi.fn(async () => ({ kind: 'ready', root: '/r' }) as GamePackState);
  (globalThis as unknown as { window: unknown }).window = {
    sei: {
      gamePackState: stateMock,
      gamePackEnsure: ensureMock,
      onGamePackProgress: vi.fn((cb: (p: GamePackProgressPush) => void) => {
        pushHandler = cb;
        return unsub;
      }),
    },
  };
});

async function load() {
  return (await import('./useGamePackStore')).useGamePackStore;
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('useGamePackStore', () => {
  it('Test 1: init subscribes and pulls', async () => {
    const store = await load();
    const off = store.getState().init();
    await flush();
    expect(stateMock).toHaveBeenCalledWith('minecraft');
    expect(store.getState().packs.minecraft).toEqual({ kind: 'missing' });
    off();
    expect(unsub).toHaveBeenCalled();
  });

  it('Test 2: a push updates the game in place', async () => {
    const store = await load();
    store.getState().init();
    await flush();
    pushHandler?.({ game: 'minecraft', state: { kind: 'downloading', received: 5, total: 10 } });
    expect(store.getState().packs.minecraft).toEqual({ kind: 'downloading', received: 5, total: 10 });
  });

  it('Test 3: ensure is optimistic, then settles on the returned state', async () => {
    const store = await load();
    let resolveEnsure: (s: GamePackState) => void = () => {};
    ensureMock.mockImplementation(() => new Promise<GamePackState>((r) => (resolveEnsure = r)));
    const p = store.getState().ensure('minecraft');
    expect(store.getState().packs.minecraft?.kind).toBe('downloading');
    resolveEnsure({ kind: 'ready', root: '/packs/minecraft/1.0.0' });
    expect(await p).toEqual({ kind: 'ready', root: '/packs/minecraft/1.0.0' });
    expect(store.getState().packs.minecraft).toEqual({ kind: 'ready', root: '/packs/minecraft/1.0.0' });
  });

  it('Test 4: ensure on a ready pack does not call main', async () => {
    const store = await load();
    store.setState({ packs: { minecraft: { kind: 'ready', root: '/r' } } });
    await store.getState().ensure('minecraft');
    expect(ensureMock).not.toHaveBeenCalled();
  });

  it('Test 5: ensure returns the error state without throwing', async () => {
    const store = await load();
    const err: GamePackState = { kind: 'error', error: 'GAME_PACK_DOWNLOAD_FAILED', message: 'sha256 mismatch' };
    ensureMock.mockResolvedValue(err);
    expect(await store.getState().ensure('minecraft')).toEqual(err);
    expect(store.getState().packs.minecraft).toEqual(err);
  });
});
