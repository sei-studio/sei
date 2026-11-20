import { describe, expect, it } from 'vitest';
import { UserConfigSchema } from './characterSchema';
import {
  floatingAvatarIds,
  isPinSource,
  pinAvailable,
  pinDurationBucket,
  roomShowsHer,
  savedPinned,
  withPinned,
  worldlinkCompanion,
  type FloatingAvatarInputs,
} from './seilinkPin';

const SUI = '0b9e7a62-3c1f-4d7e-9a55-2f4c8d1e6b10';
const LYRA = '1c8f6b73-4d2e-4e8f-8b66-3e5d9f2a7c21';

const pinned: FloatingAvatarInputs = {
  available: true,
  status: { state: 'running', characterId: SUI, pinned: true },
  inRoomViews: [],
};

describe('who the overlay shows (floatingAvatarIds)', () => {
  it('shows the pinned WorldLink companion, and only her', () => {
    expect(floatingAvatarIds(pinned)).toEqual([SUI]);
  });

  it('nobody without WorldLink, whatever else says pinned', () => {
    expect(floatingAvatarIds({ ...pinned, available: false })).toEqual([]);
  });

  it('nobody while she is not pinned (unpinned = overlay closed)', () => {
    expect(floatingAvatarIds({ ...pinned, status: { ...pinned.status, pinned: undefined } })).toEqual([]);
    expect(floatingAvatarIds({ ...pinned, status: { ...pinned.status, pinned: false } })).toEqual([]);
  });

  it('nobody once she no longer lives there', () => {
    for (const state of ['off', 'unsupported'] as const) {
      expect(floatingAvatarIds({ ...pinned, status: { ...pinned.status, state } })).toEqual([]);
    }
    expect(floatingAvatarIds({ ...pinned, status: { ...pinned.status, characterId: null } })).toEqual([]);
  });

  it('keeps her while the host starts, restarts or failed (her move-in stands)', () => {
    for (const state of ['starting', 'restarting', 'failed'] as const) {
      expect(floatingAvatarIds({ ...pinned, status: { ...pinned.status, state } })).toEqual([SUI]);
    }
  });

  it('never two of her: hidden while the app draws her in her room', () => {
    expect(floatingAvatarIds({ ...pinned, inRoomViews: [SUI] })).toEqual([]);
    // Someone else's editor does not hide her.
    expect(floatingAvatarIds({ ...pinned, inRoomViews: [LYRA] })).toEqual([SUI]);
  });

  it('the room hides her exactly while she is pinned', () => {
    expect(roomShowsHer(true)).toBe(false);
    expect(roomShowsHer(false)).toBe(true);
    expect(roomShowsHer(undefined)).toBe(true);
  });

  it('the pin is only offered while someone lives in WorldLink', () => {
    expect(pinAvailable({ available: true, status: { state: 'running', characterId: SUI } })).toBe(true);
    expect(pinAvailable({ available: false, status: { state: 'running', characterId: SUI } })).toBe(false);
    expect(pinAvailable({ available: true, status: { state: 'off', characterId: null } })).toBe(false);
    expect(worldlinkCompanion({ state: 'off', characterId: SUI })).toBeNull();
  });
});

describe('pin persistence (seilink_moved_in.pinned)', () => {
  const movedIn = { seilink_moved_in: { character_id: SUI, moved_in_at: 5 } };

  it('pins and unpins only her own move-in', () => {
    const on = withPinned(movedIn, SUI, true);
    expect(on.seilink_moved_in).toEqual({ character_id: SUI, moved_in_at: 5, pinned: true });
    expect(savedPinned(on, SUI)).toBe(true);
    const off = withPinned(on, SUI, false);
    expect(off.seilink_moved_in).toEqual({ character_id: SUI, moved_in_at: 5 });
    expect(savedPinned(off, SUI)).toBe(false);
  });

  it('leaves the config alone for someone else, no move-in, or no change', () => {
    expect(withPinned(movedIn, LYRA, true)).toBe(movedIn);
    const none = { seilink_moved_in: null };
    expect(withPinned(none, SUI, true)).toBe(none);
    expect(withPinned(movedIn, SUI, false)).toBe(movedIn);
    expect(savedPinned(withPinned(movedIn, SUI, true), LYRA)).toBe(false);
    expect(savedPinned(null, SUI)).toBe(false);
  });

  it('the schema keeps the pin, and an old move-in without it parses unpinned', () => {
    const cfg = UserConfigSchema.parse({ seilink_moved_in: { character_id: SUI, moved_in_at: 5, pinned: true } });
    expect(savedPinned(cfg, SUI)).toBe(true);
    const old = UserConfigSchema.parse({ seilink_moved_in: { character_id: SUI, moved_in_at: 5 } });
    expect(savedPinned(old, SUI)).toBe(false);
  });
});

describe('migration: the retired Avatar setting', () => {
  it('old avatar_mode / call_overlay_enabled configs still parse', () => {
    for (const legacy of [
      { avatar_mode: 'always' },
      { avatar_mode: 'activity' },
      { avatar_mode: 'off', call_overlay_enabled: true },
      { call_overlay_enabled: true },
    ]) {
      expect(() => UserConfigSchema.parse(legacy)).not.toThrow();
    }
  });

  it('and never bring the overlay up by themselves', () => {
    // Someone who had "Always" on and has not moved anyone into WorldLink.
    const cfg = UserConfigSchema.parse({ avatar_mode: 'always', call_overlay_enabled: true });
    expect(cfg.seilink_moved_in ?? null).toBeNull();
    expect(floatingAvatarIds({ available: true, status: { state: 'off', characterId: null }, inRoomViews: [] })).toEqual([]);
    // Moved in but WorldLink cannot run here, or not pinned: still nothing.
    expect(floatingAvatarIds({ available: false, status: { state: 'running', characterId: SUI, pinned: true }, inRoomViews: [] })).toEqual([]);
    expect(floatingAvatarIds({ available: true, status: { state: 'running', characterId: SUI }, inRoomViews: [] })).toEqual([]);
  });
});

describe('pin analytics shapes', () => {
  it('buckets how long she floated', () => {
    expect(pinDurationBucket(0)).toBe('lt1m');
    expect(pinDurationBucket(59_999)).toBe('lt1m');
    expect(pinDurationBucket(60_000)).toBe('1_5m');
    expect(pinDurationBucket(5 * 60_000)).toBe('5_30m');
    expect(pinDurationBucket(30 * 60_000)).toBe('30m_2h');
    expect(pinDurationBucket(2 * 3_600_000)).toBe('2_8h');
    expect(pinDurationBucket(8 * 3_600_000)).toBe('gt8h');
    expect(pinDurationBucket(-5)).toBe('lt1m');
    expect(pinDurationBucket(Number.NaN)).toBe('lt1m');
  });

  it('accepts only known pin sources', () => {
    expect(isPinSource('dock')).toBe(true);
    expect(isPinSource('overlay')).toBe(true);
    expect(isPinSource('settings')).toBe(false);
    expect(isPinSource(undefined)).toBe(false);
  });
});
