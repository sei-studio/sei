/**
 * openGame / dropIdleBoardPanels: picking another surface must close an idle
 * board-game panel (a launch card or a finished game), or ChatScreen keeps
 * showing it ahead of the surface the player just picked.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

let ends: string[] = [];

beforeEach(() => {
  vi.resetModules();
  ends = [];
  const end = (name: string) => vi.fn(async () => void ends.push(name));
  (globalThis as unknown as { window: unknown }).window = {
    sei: {
      track: () => undefined,
      chessEnd: end('chess'),
      CONNECT4End: end('connect4'),
      BATTLESHIPEnd: end('battleship'),
      wizardPromptShown: async () => ({ shown: true }),
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
});

async function load() {
  const { useChessStore } = await import('./stores/useChessStore');
  const { useConnect4Store } = await import('./stores/useConnect4Store');
  const { useBattleshipStore } = await import('./stores/useBattleshipStore');
  const launch = await import('./gameLaunch');
  return { useChessStore, useConnect4Store, useBattleshipStore, ...launch };
}

const ID = 'sui';

describe('openGame', () => {
  it('closes a Four in a Row launch card when Minecraft is picked', async () => {
    const { useConnect4Store, openGame } = await load();
    useConnect4Store.setState({ panelIntent: { [ID]: true }, games: {} });
    openGame(ID, 'minecraft');
    expect(useConnect4Store.getState().panelIntent[ID]).toBe(false);
    expect(useConnect4Store.getState().games[ID] ?? null).toBeNull();
  });

  it('closes a finished Fleet Battle when Four in a Row is picked, and opens Four in a Row', async () => {
    const { useConnect4Store, useBattleshipStore, openGame } = await load();
    useBattleshipStore.setState({
      panelIntent: { [ID]: true },
      games: { [ID]: { characterId: ID, status: 'ended' } as never },
    });
    openGame(ID, 'CONNECT4');
    expect(useBattleshipStore.getState().games[ID] ?? null).toBeNull();
    expect(useBattleshipStore.getState().panelIntent[ID]).toBe(false);
    expect(useConnect4Store.getState().panelIntent[ID]).toBe(true);
  });

  it('closes an idle Four in a Row panel on the Draw! branch too', async () => {
    const { useConnect4Store, openGame } = await load();
    useConnect4Store.setState({
      panelIntent: { [ID]: false },
      games: { [ID]: { characterId: ID, status: 'ended' } as never },
    });
    openGame(ID, 'draw');
    expect(useConnect4Store.getState().games[ID] ?? null).toBeNull();
  });

  it("keeps the picked game's own finished panel", async () => {
    const { useConnect4Store, openGame } = await load();
    useConnect4Store.setState({
      panelIntent: { [ID]: true },
      games: { [ID]: { characterId: ID, status: 'ended' } as never },
    });
    openGame(ID, 'CONNECT4');
    expect(useConnect4Store.getState().games[ID]).not.toBeNull();
    expect(ends).not.toContain('connect4');
  });
});

describe('dropIdleBoardPanels', () => {
  it('never ends a live game', async () => {
    const { useConnect4Store, useBattleshipStore, dropIdleBoardPanels } = await load();
    useConnect4Store.setState({ games: { [ID]: { characterId: ID, status: 'active' } as never } });
    useBattleshipStore.setState({ games: { [ID]: { characterId: ID, status: 'preparing' } as never } });
    dropIdleBoardPanels(ID);
    expect(useConnect4Store.getState().games[ID]).not.toBeNull();
    expect(useBattleshipStore.getState().games[ID]).not.toBeNull();
    expect(ends.filter((e) => e !== 'chess')).toEqual([]);
  });

  it('leaves untouched a game that was never opened (no IPC call)', async () => {
    const { dropIdleBoardPanels } = await load();
    dropIdleBoardPanels(ID);
    await Promise.resolve();
    expect(ends.filter((e) => e !== 'chess')).toEqual([]);
  });
});
