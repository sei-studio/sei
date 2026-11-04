/** Picking through a shelf's lip (261105 plank pass): you can't click an item through the plank. */
import { describe, expect, it } from 'vitest';
import { defaultRoomState, type RoomPresetManifest, type RoomSlotId } from '@shared/seilinkRoom';
import { RoomPicker } from './roomPick';

const W = 200;
const H = 100;
// A shelf frame whose plank (y 40..60) is opaque, a 40 x 40 opaque box item.
const manifest: RoomPresetManifest = {
  format: 'sei-room',
  version: 1,
  id: 'cozy',
  place: 'a test room',
  canvas: [W, H],
  avatar: { x: 190, y: 20, height: 10 },
  wallAreas: [[[0, 0], [W, 0], [W, 30], [0, 30]]],
  slots: { shell: { z: 10, options: ['shell'] }, shelf: { z: 40, options: ['shelf'] } },
  components: [
    { id: 'shell', slot: 'shell', name: 'walls', frames: { day: { src: 'shell.png' } } },
    {
      id: 'shelf',
      slot: 'shelf',
      name: 'shelf',
      frames: { day: { src: 'shelf.png' } },
      surfaceTops: [{ area: [[20, 40], [180, 40], [180, 52], [20, 52]], lip: [[20, 50], [180, 50], [180, 60], [20, 60]] }],
    },
    { id: 'box', slot: 'item', name: 'box', placement: 'surface', foot: 4, box: [0, 0, 40, 40], frames: { day: { src: 'box.png' } } },
  ],
};

function picker(): RoomPicker {
  const p = new RoomPicker();
  const map = (w: number, h: number, on: (x: number, y: number) => boolean) => {
    const data = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = on(x, y) ? 255 : 0;
    return { nw: w, nh: h, w, h, data };
  };
  const maps = (p as unknown as { maps: Map<string, unknown> }).maps;
  maps.set('shell.png', map(W, H, () => true));
  maps.set('shelf.png', map(W, H, (x, y) => x >= 20 && x < 180 && y >= 40 && y < 60));
  maps.set('box.png', map(40, 40, () => true));
  return p;
}

describe('RoomPicker over a lipped top', () => {
  // The box at the front of the top, its bottom (y 62) tucked under the plank's front face.
  const state = { ...defaultRoomState('cozy'), time: 'day' as const, items: [{ id: 'box', x: 100, y: 62 }] };
  const pick = (x: number, y: number, slots: RoomSlotId[]) => picker().pick(manifest, state, 'day', (s) => s, x, y, new Set(slots));

  it('picks the item above the plank, the plank (not the item) on its front face', () => {
    expect(pick(100, 30, ['shell', 'shelf'])).toEqual({ kind: 'item', index: 0 });
    expect(pick(100, 45, ['shell', 'shelf'])).toEqual({ kind: 'item', index: 0 });
    expect(pick(100, 55, ['shell', 'shelf'])).toEqual({ kind: 'slot', slot: 'shelf' });
  });

  it('never reaches the item through a plank that is not pickable itself', () => {
    expect(pick(100, 55, ['shell'])).toEqual({ kind: 'slot', slot: 'shell' });
    expect(pick(100, 55, [])).toBeNull();
    // Above the plank's front face the item is picked as before.
    expect(pick(100, 45, ['shell'])).toEqual({ kind: 'item', index: 0 });
  });
});
