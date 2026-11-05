import { describe, expect, it, vi } from 'vitest';
import type { RoomPresetManifest } from '@shared/seilinkRoom';
import type { SeilinkPack } from '@shared/seilinkPack';
import { firstRoomState } from './MoveInSheet';

vi.mock('../../lib/ipcClient', () => ({ sei: {} }));

const pack = (id: string): SeilinkPack =>
  ({ id, manifest: { id, slots: { rug: { z: 30, options: ['r'], optional: true }, bed: { z: 40, options: ['b'] } } } as unknown as RoomPresetManifest }) as unknown as SeilinkPack;

describe('firstRoomState (261106, first-link v3)', () => {
  it('starts her on the plain background in the cozy frame when it is there', () => {
    const r = firstRoomState([pack('forest'), pack('cozy')]);
    expect(r?.plain).toBe(true);
    expect(r?.state).toMatchObject({ preset: 'cozy', plain: true, items: [], slots: { rug: { id: null } } });
  });
  it('falls back to the first pack, and to nothing with no packs', () => {
    expect(firstRoomState([pack('forest')])?.state.preset).toBe('forest');
    expect(firstRoomState([])).toBeNull();
  });
});
