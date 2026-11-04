import { describe, expect, it } from 'vitest';
import { defaultRoomState, describeRoom, resolveSlots, roomTimeAt, tintName, type RoomPresetManifest } from './seilinkRoom';

const manifest: RoomPresetManifest = {
  format: 'sei-room',
  version: 1,
  id: 'cozy',
  place: 'your bedroom',
  canvas: [2560, 1440],
  avatar: { x: 1280, y: 1440, height: 1100 },
  slots: {
    view: { z: 0, options: ['view-city'] },
    shell: { z: 10, options: ['shell-cozy'] },
    curtains: { z: 20, options: ['curtains-plain'] },
    rug: { z: 30, options: ['rug-round'], optional: true },
    chair: { z: 90, options: ['chair-office'] },
  },
  components: [
    { id: 'view-city', slot: 'view', name: 'city view', frames: { day: { src: 'view/day.webp' } } },
    { id: 'shell-cozy', slot: 'shell', name: 'room', frames: { day: { src: 'shell/day.webp' } } },
    { id: 'curtains-plain', slot: 'curtains', name: 'curtains', tintable: true, defaultTint: '#7b4fc9', frames: { day: { src: 'c.webp', mask: 'cm.webp' } } },
    { id: 'rug-round', slot: 'rug', name: 'round rug', frames: { day: { src: 'r.webp' } } },
    { id: 'chair-office', slot: 'chair', name: 'desk chair', frames: { day: { src: 'ch.webp' } } },
    { id: 'trophy-sei-2026', slot: 'item', name: 'Sei 2026 trophy', placement: 'surface', frames: { day: { src: 't.webp' } } },
  ],
};

describe('seilinkRoom', () => {
  it('follows the clock: day, dusk at both ends, night', () => {
    expect(roomTimeAt(new Date(2026, 10, 4, 12))).toBe('day');
    expect(roomTimeAt(new Date(2026, 10, 4, 6))).toBe('dusk');
    expect(roomTimeAt(new Date(2026, 10, 4, 18))).toBe('dusk');
    expect(roomTimeAt(new Date(2026, 10, 4, 23))).toBe('night');
  });

  it('fills slots with defaults, keeps z order, drops an emptied optional slot', () => {
    const s = defaultRoomState('cozy');
    expect(resolveSlots(manifest, s).map((x) => x.slot)).toEqual(['view', 'shell', 'curtains', 'rug', 'chair']);
    s.slots.rug = { id: null };
    expect(resolveSlots(manifest, s).map((x) => x.slot)).not.toContain('rug');
  });

  it('describes the room in plain words with colours, items, and without the shell', () => {
    const s = defaultRoomState('cozy');
    s.items.push({ id: 'trophy-sei-2026', x: 10, y: 10 });
    s.time = 'night';
    expect(describeRoom(manifest, s)).toEqual({ place: 'your bedroom', time: 'night', things: ['purple curtains', 'round rug', 'desk chair', 'Sei 2026 trophy'] });
    s.slots.curtains = { id: 'curtains-plain', tint: '#2f6fd6' };
    expect(describeRoom(manifest, s).things[0]).toBe('blue curtains');
  });

  it('names basic tints', () => {
    expect(tintName('#ffffff')).toBe('white');
    expect(tintName('#d63a3a')).toBe('red');
    expect(tintName('#3aa04a')).toBe('green');
    expect(tintName('nope')).toBeNull();
  });
});
