/** Game adapters (M0, 260908): dashboard snapshots dispatch on snapshot.game. */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  initGameDashboardService,
  publishGameDashboardSnapshot,
  getGameDashboardSnapshot,
  clearGameDashboard,
} from './gameDashboardService';
import { initMcDashboardService } from '../mcDashboard/mcDashboardService';

const mcSnapshot = {
  ts: 1,
  dimension: 'overworld',
  pos: { x: 1, y: 64, z: 2 },
  yaw: 0,
  health: 20,
  food: 20,
  held: null,
  items: [],
  activity: 'idle',
  actionName: null,
  map: null,
};

describe('publishGameDashboardSnapshot', () => {
  const mcPush = vi.fn();
  const genericPush = vi.fn();
  beforeEach(() => {
    mcPush.mockClear();
    genericPush.mockClear();
    initMcDashboardService({ pushSnapshot: mcPush });
    initGameDashboardService({ pushSnapshot: genericPush });
    clearGameDashboard('c1');
  });

  it('routes an untagged (older bot) or minecraft snapshot to the Minecraft service, stamped game: minecraft', () => {
    publishGameDashboardSnapshot('c1', mcSnapshot);
    expect(mcPush).toHaveBeenCalledTimes(1);
    expect(mcPush.mock.calls[0][0]).toMatchObject({ game: 'minecraft', characterId: 'c1', dimension: 'overworld' });
    publishGameDashboardSnapshot('c1', { ...mcSnapshot, game: 'minecraft' });
    expect(mcPush).toHaveBeenCalledTimes(2);
    expect(genericPush).not.toHaveBeenCalled();
    expect(getGameDashboardSnapshot('c1')).toMatchObject({ game: 'minecraft', characterId: 'c1' });
  });

  it('validates and pushes a stardew snapshot on the generic channel, keeping extra fields', () => {
    publishGameDashboardSnapshot('c1', { game: 'stardew', ts: 5, activity: 'watering the parsnips...', actionName: 'water', energy: 180 });
    expect(genericPush).toHaveBeenCalledTimes(1);
    expect(genericPush.mock.calls[0][0]).toEqual({
      game: 'stardew', ts: 5, activity: 'watering the parsnips...', actionName: 'water', energy: 180, characterId: 'c1',
    });
    expect(getGameDashboardSnapshot('c1')).toMatchObject({ game: 'stardew', energy: 180 });
    clearGameDashboard('c1');
    expect(getGameDashboardSnapshot('c1')).toBeNull();
  });

  it('drops an invalid or unknown-game snapshot', () => {
    publishGameDashboardSnapshot('c1', { game: 'stardew' }); // no ts
    publishGameDashboardSnapshot('c1', { game: 'roblox', ts: 1 });
    expect(genericPush).not.toHaveBeenCalled();
    expect(mcPush).not.toHaveBeenCalled();
  });
});
