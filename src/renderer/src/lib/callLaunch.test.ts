/**
 * isGameSurfaceOpen: the phone button starts a call in place behind any open
 * game surface, the board minigames included (same open meaning as chess).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  (globalThis as unknown as { window: unknown }).window = {
    sei: { track: () => undefined },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
});

describe('isGameSurfaceOpen', () => {
  it('counts an open Four in a Row or Fleet Battle panel', async () => {
    const { isGameSurfaceOpen } = await import('./callLaunch');
    const { useConnect4Store } = await import('./stores/useConnect4Store');
    const { useBattleshipStore } = await import('./stores/useBattleshipStore');
    expect(isGameSurfaceOpen('sui')).toBe(false);
    useConnect4Store.setState({ panelIntent: { sui: true } });
    expect(isGameSurfaceOpen('sui')).toBe(true);
    useConnect4Store.setState({ panelIntent: {} });
    useBattleshipStore.setState({ games: { sui: { characterId: 'sui', status: 'ended' } as never } });
    expect(isGameSurfaceOpen('sui')).toBe(true);
    expect(isGameSurfaceOpen('lyra')).toBe(false);
  });
});
