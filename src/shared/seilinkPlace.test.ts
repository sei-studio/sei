import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AVATAR_Z, defaultRoomState, ITEM_Z, type RoomComponent, type RoomPresetManifest, type RoomState } from './seilinkRoom';
import { roomDrawPlan, type ItemLayer } from './seilinkDraw';
import { parseRoomManifest, sanitizeRoomState } from './seilinkValidate';
import { addItem, moveItem, scaleItem, setSlotComponent } from './seilinkEdit';
import {
  contactY,
  depthScale,
  lineYAt,
  nearestOnSegment,
  onPolygonEdge,
  placedItemZ,
  placementRegions,
  pointInPolygon,
  scaleRangeAt,
  settleItems,
  snapSpot,
  spotValid,
  spriteFit,
  surfaceAt,
} from './seilinkPlace';

// A 2000x1000 room: floor is a trapezoid along the bottom, a bed blocks its left end,
// two shelf lines and a desk top area, a wall area with a window cut out (two wall polygons).
const manifest: RoomPresetManifest = {
  format: 'sei-room',
  version: 1,
  id: 'cozy',
  place: 'your bedroom',
  canvas: [2000, 1000],
  avatar: { x: 1000, y: 1000, height: 600 },
  horizon: 500,
  floorAreas: [
    [
      [0, 800],
      [2000, 800],
      [2000, 1000],
      [0, 1000],
    ],
  ],
  wallAreas: [
    [
      [0, 0],
      [1200, 0],
      [1200, 790],
      [0, 790],
    ],
    [
      [1600, 0],
      [2000, 0],
      [2000, 790],
      [1600, 790],
    ],
  ],
  slots: {
    shell: { z: 10, options: ['shell'] },
    shelf: { z: 40, options: ['shelves'], optional: true },
    bed: { z: 50, options: ['bed'], optional: true },
    chair: { z: 90, options: ['chair'] },
  },
  components: [
    { id: 'shell', slot: 'shell', name: 'walls', frames: { day: { src: 's.webp' } } },
    {
      id: 'shelves',
      slot: 'shelf',
      name: 'wall shelves',
      surfaceLines: [
        [100, 300, 500, 340],
        [100, 500, 500, 500],
      ],
      blocks: { wall: [[[100, 290], [500, 290], [500, 520], [100, 520]]] },
      frames: { day: { src: 'sh.webp' } },
    },
    {
      id: 'bed',
      slot: 'bed',
      name: 'bed',
      surfaceAreas: [
        [
          [0, 650],
          [400, 650],
          [400, 700],
          [0, 700],
        ],
      ],
      blocks: { floor: [[[0, 780], [400, 780], [400, 900], [0, 900]]] },
      frames: { day: { src: 'b.webp' } },
    },
    { id: 'chair', slot: 'chair', name: 'armchair', frames: { day: { src: 'ch.webp' } } },
    { id: 'plant', slot: 'item', name: 'plant', placement: 'floor', foot: 20, box: [900, 600, 200, 400], frames: { day: { src: 'p.webp' } } },
    { id: 'books', slot: 'item', name: 'books', placement: 'surface', foot: 10, box: [0, 0, 120, 80], frames: { day: { src: 'bk.webp' } } },
    { id: 'poster', slot: 'item', name: 'poster', placement: 'wall', box: [0, 0, 200, 300], frames: { day: { src: 'po.webp' } } },
    { id: 'pin', slot: 'item', name: 'pin', placement: 'wall', frames: { day: { src: 'pin.webp' } } },
  ],
};
const comp = (id: string): RoomComponent => manifest.components.find((c) => c.id === id)!;
const room = defaultRoomState('cozy');
const R = placementRegions(manifest, room);
const withItems = (items: RoomState['items'], base: RoomState = room): RoomState => ({ ...base, items });

describe('geometry', () => {
  const square: Array<[number, number]> = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ];
  const ell: Array<[number, number]> = [
    [0, 0],
    [10, 0],
    [10, 4],
    [4, 4],
    [4, 10],
    [0, 10],
  ];

  it('tests containment, concave shapes included', () => {
    expect(pointInPolygon(square, 5, 5)).toBe(true);
    expect(pointInPolygon(square, 15, 5)).toBe(false);
    expect(pointInPolygon(ell, 2, 8)).toBe(true);
    expect(pointInPolygon(ell, 8, 8)).toBe(false);
    expect(onPolygonEdge(ell, 7, 4)).toBe(true);
    expect(onPolygonEdge(ell, 7, 5)).toBe(false);
  });

  it('projects onto segments and reads a line y', () => {
    expect(nearestOnSegment([0, 0, 10, 0], 5, 7)).toMatchObject({ x: 5, y: 0, t: 0.5, d: 7 });
    expect(nearestOnSegment([0, 0, 10, 0], -5, 0)).toMatchObject({ x: 0, y: 0, t: 0 });
    expect(lineYAt([100, 300, 500, 340], 300)).toBe(320);
    expect(lineYAt([100, 300, 500, 340], 900)).toBe(340);
  });
});

describe('floor', () => {
  const plant = comp('plant');
  const fit = spriteFit(R, plant, 1);

  it('keeps a valid spot as it is', () => {
    expect(snapSpot(R, plant, 1500, 950, { fit })).toMatchObject({ x: 1500, y: 950 });
  });

  it('pulls a spot on the wall down onto the floor, with the foot on the floor too', () => {
    const s = snapSpot(R, plant, 1500, 300, { fit });
    expect(s.x).toBe(1500);
    // Contact 20 px (foot) above the anchor and the back of the base 30 px above: both on the floor.
    const f = fit(s.y)!;
    expect(s.y - 1.5 * f.foot).toBeGreaterThanOrEqual(800);
    expect(s.y - 1.5 * f.foot).toBeLessThan(802);
    expect(spotValid(R, 'floor', s.x, s.y, fit)).toBe(true);
  });

  it('keeps floor items out of a part footprint, and frees it when the part goes', () => {
    expect(spotValid(R, 'floor', 200, 880, fit)).toBe(false);
    const s = snapSpot(R, plant, 200, 880, { fit });
    expect(spotValid(R, 'floor', s.x, s.y, fit)).toBe(true);
    // Nearest way out of the bed's footprint is down in front of it.
    expect(s.x).toBe(200);
    expect(s.y).toBeGreaterThan(900);
    const noBed = placementRegions(manifest, setSlotComponent(manifest, room, 'bed', null));
    expect(spotValid(noBed, 'floor', 200, 880, fit)).toBe(true);
  });

  it('scales with depth: 1 at the artist spot, smaller further back, clamped', () => {
    expect(depthScale(R, plant, 1000)).toBe(1);
    expect(depthScale(R, plant, 800)).toBeCloseTo(0.6, 5);
    expect(depthScale(R, plant, 400)).toBe(0.3);
    expect(depthScale(R, comp('books'), 300)).toBe(1);
    // No horizon: a typical eye level is guessed from the floor (back of the floor about half size).
    const guess = placementRegions({ ...manifest, horizon: undefined }, room);
    expect(depthScale(guess, plant, 800)).toBeGreaterThan(0.4);
    expect(depthScale(guess, plant, 800)).toBeLessThan(0.7);
    // A legacy box floor has no perspective.
    const legacy = placementRegions({ ...manifest, floorAreas: undefined, floor: [0, 800, 2000, 200] }, room);
    expect(depthScale(legacy, plant, 800)).toBe(1);
  });

  it('draws nearer floor items over further ones, all behind her', () => {
    const back = placedItemZ(R, comp('plant'), { x: 1500, y: 850 });
    const front = placedItemZ(R, comp('plant'), { x: 1500, y: 990 });
    expect(back).toBeGreaterThan(ITEM_Z.floor);
    expect(front).toBeGreaterThan(back);
    expect(front).toBeLessThan(90);
    expect(placedItemZ(R, comp('plant'), { x: 1500, y: 990, z: 12 })).toBe(12);
    const plan = roomDrawPlan(manifest, withItems([{ id: 'plant', x: 1500, y: 990 }, { id: 'plant', x: 1200, y: 850, scale: 1.2 }]), 'day');
    const items = plan.layers.filter((l): l is ItemLayer => l.kind === 'item');
    // Sorted back to front, and the far one is scaled by depth on top of its own scale.
    expect(items.map((l) => l.index)).toEqual([1, 0]);
    expect(items[0].scale).toBeCloseTo(1.2 * 0.7, 5);
    expect(items[1].scale).toBeCloseTo(0.98, 5);
    const avatarAt = plan.layers.findIndex((l) => l.kind === 'avatar');
    expect(plan.layers.findIndex((l) => l.kind === 'item')).toBeLessThan(avatarAt);
    expect(Math.max(...items.map((l) => l.z))).toBeLessThan(AVATAR_Z);
  });
});

describe('surface', () => {
  const books = comp('books');
  const fit = spriteFit(R, books, 1);

  it('sits the contact exactly on the nearest line, x free along it', () => {
    const s = snapSpot(R, books, 300, 290, { fit });
    expect(s.x).toBe(300);
    // Contact on the sloped top line (y 320 at x 300), the anchor a foot (10 px) below it.
    expect(s.y).toBe(330);
    expect(surfaceAt(R, s.x, s.y - 10)).toBe(s.surface);
    expect(R.surfaces[s.surface]).toMatchObject({ kind: 'line', slot: 'shelf' });
    expect(spotValid(R, 'surface', s.x, s.y, fit)).toBe(true);
    expect(spotValid(R, 'surface', 300, 360, fit)).toBe(false);
  });

  it('leans down: held between two shelves it drops onto the lower one', () => {
    // Contact at 420: 100 px under the top line (320), 80 px over the lower one (500), with the foot.
    expect(snapSpot(R, books, 300, 430, { fit }).y).toBe(510);
    // Just past the middle upward it still drops (the downward lean), well above it goes up.
    expect(snapSpot(R, books, 300, 415, { fit }).y).toBe(510);
    expect(snapSpot(R, books, 300, 360, { fit }).y).toBe(330);
  });

  it('keeps the surface it is on until another is clearly nearer', () => {
    const first = snapSpot(R, books, 300, 430, { fit });
    // Without the preference this lands on the top shelf; with it the item stays on the lower one.
    expect(snapSpot(R, books, 300, 405, { fit }).y).toBe(330);
    expect(snapSpot(R, books, 300, 405, { fit, prefer: first.surface }).y).toBe(510);
  });

  it('keeps most of the sprite on the plank at its ends', () => {
    // Width 120: the anchor stays 40 px in from the line end at x 500.
    expect(snapSpot(R, books, 900, 500, { fit }).x).toBe(460);
    expect(snapSpot(R, books, 900, 500).x).toBe(500);
  });

  it('rests anywhere inside a surface area and takes its part z', () => {
    const s = snapSpot(R, books, 200, 690, { fit });
    expect(s).toMatchObject({ x: 200, y: 690 });
    expect(R.surfaces[s.surface]).toMatchObject({ kind: 'area', slot: 'bed' });
    const onBed = placedItemZ(R, books, { x: 200, y: 690 });
    expect(onBed).toBeGreaterThan(50);
    expect(onBed).toBeLessThan(51);
    const onShelf = placedItemZ(R, books, { x: 300, y: 330 });
    expect(onShelf).toBeGreaterThan(40);
    expect(onShelf).toBeLessThan(41);
    // Outside the area: pulled onto its edge.
    const out = snapSpot(R, books, 200, 760, { fit: () => ({ w: 0, h: 0, foot: 10 }) });
    expect(out.x).toBe(200);
    expect(out.y).toBe(710);
  });

  it('falls to the floor when its parts leave the room', () => {
    let s = withItems([{ id: 'books', x: 300, y: 330 }]);
    s = setSlotComponent(manifest, s, 'shelf', null);
    s = setSlotComponent(manifest, s, 'bed', null);
    const it = s.items[0];
    expect(it.x).toBe(300);
    expect(contactY(placementRegions(manifest, s), books, it)).toBeGreaterThanOrEqual(800);
  });

  it('caps decor scale by the surface it is on', () => {
    expect(scaleRangeAt(R, books, { x: 300, y: 330 })).toEqual([0.6, 1.25]);
    const wide = { ...books, box: [0, 0, 400, 80] as [number, number, number, number] };
    expect(scaleRangeAt(R, wide, { x: 300, y: 330 })).toEqual([0.6, 0.9]);
    expect(scaleRangeAt(R, comp('plant'), { x: 1500, y: 950 })).toEqual([0.6, 1.5]);
  });
});

describe('wall', () => {
  const poster = comp('poster');
  const fit = spriteFit(R, poster, 1);

  it('hangs the whole sprite on bare wall: not over the window, not over a shelf', () => {
    expect(spotValid(R, 'wall', 800, 700, fit)).toBe(true);
    // Over the window gap (1200..1600).
    expect(spotValid(R, 'wall', 1300, 700, fit)).toBe(false);
    const s = snapSpot(R, poster, 1300, 700, { fit });
    expect(spotValid(R, 'wall', s.x, s.y, fit)).toBe(true);
    // Its right edge (half of 200 px, less the 1 px sample inset) on the window's edge.
    expect(s.x).toBe(1101);
    // Over the shelves' block.
    expect(spotValid(R, 'wall', 300, 700, fit)).toBe(false);
    const t = snapSpot(R, poster, 300, 700, { fit });
    expect(spotValid(R, 'wall', t.x, t.y, fit)).toBe(true);
  });

  it('checks the anchor alone when the sprite size is unknown', () => {
    expect(spotValid(R, 'wall', 1100, 700, null)).toBe(true);
    expect(snapSpot(R, comp('pin'), 1300, 700)).toMatchObject({ x: 1200, y: 700 });
  });

  it('settles for the anchor alone when the sprite fits nowhere', () => {
    const huge = spriteFit(R, poster, 9);
    const s = snapSpot(R, poster, 1300, 700, { fit: huge });
    expect(spotValid(R, 'wall', s.x, s.y, null)).toBe(true);
  });
});

describe('migration and edit ops', () => {
  it('settles stored items at invalid spots, never drops them, and leaves valid ones alone', () => {
    const state = withItems([
      { id: 'plant', x: 1500, y: 950 },
      { id: 'plant', x: 1500, y: 200 },
      { id: 'books', x: 900, y: 900, scale: 1.1 },
      { id: 'poster', x: 1400, y: 500, flip: true },
    ]);
    const out = settleItems(manifest, state);
    expect(out.items).toHaveLength(4);
    expect(out.items[0]).toBe(state.items[0]);
    expect(out.items[1].y).toBeGreaterThan(800);
    expect(out.items[2]).toMatchObject({ id: 'books', scale: 1.1 });
    expect(surfaceAt(R, out.items[2].x, contactY(R, comp('books'), out.items[2]))).toBeGreaterThanOrEqual(0);
    expect(out.items[3]).toMatchObject({ id: 'poster', flip: true });
    expect(spotValid(R, 'wall', out.items[3].x, out.items[3].y, spriteFit(R, comp('poster'), 1))).toBe(true);
    // Settling is stable: a settled room settles to itself.
    expect(settleItems(manifest, out)).toBe(out);
    const clean = withItems([{ id: 'plant', x: 1500, y: 950 }]);
    expect(settleItems(manifest, clean)).toBe(clean);
  });

  it('sanitize settles too', () => {
    const s = sanitizeRoomState(manifest, { version: 1, preset: 'cozy', items: [{ id: 'books', x: 300, y: 100 }] });
    expect(s.items).toEqual([{ id: 'books', x: 300, y: 330 }]);
  });

  it('adds, moves and scales items onto real spots', () => {
    const { state, index } = addItem(manifest, room, 'books');
    const it = state.items[index];
    expect(surfaceAt(R, it.x, it.y - 10)).toBeGreaterThanOrEqual(0);
    const moved = moveItem(manifest, state, index, 1500, 100);
    expect(spotValid(R, 'surface', moved.items[index].x, moved.items[index].y, spriteFit(R, comp('books'), 1))).toBe(true);
    // Scale is held to the class range (decor: 1.25).
    expect(scaleItem(moved, index, 3, manifest).items[index].scale).toBe(1.25);
    // Without the manifest, the old global range.
    expect(scaleItem(moved, index, 3).items[index].scale).toBe(1.5);
  });
});

describe('validator', () => {
  const json = JSON.parse(JSON.stringify(manifest));

  it('reads the placement fields', () => {
    const m = parseRoomManifest(json)!;
    expect(m.floorAreas).toEqual(manifest.floorAreas);
    expect(m.wallAreas).toEqual(manifest.wallAreas);
    expect(m.horizon).toBe(500);
    const shelves = m.components.find((c) => c.id === 'shelves')!;
    expect(shelves.surfaceLines).toEqual([
      [100, 300, 500, 340],
      [100, 500, 500, 500],
    ]);
    expect(shelves.blocks?.wall).toHaveLength(1);
    expect(m.components.find((c) => c.id === 'bed')!.surfaceAreas).toHaveLength(1);
    expect(m.components.find((c) => c.id === 'plant')!.foot).toBe(20);
  });

  it('drops bad regions without rejecting the pack', () => {
    const bad = JSON.parse(JSON.stringify(manifest));
    bad.floorAreas = [[[0, 0], [1, 1]], 'x', [[0, 0], [10, 0], [Number.NaN, 5]], [[0, 0], [10, 0], [10, 10]]];
    bad.wallAreas = [[[0, 0], [1e9, 0], [0, 5]]];
    bad.horizon = 'high';
    const sh = bad.components.find((c: RoomComponent) => c.id === 'shelves');
    sh.surfaceLines = [[0, 0, 0, 0], [0, 1, 2], [0, 0, 50, 0]];
    sh.blocks = { floor: 'nope', wall: [[[0, 0], [5, 0], [5, 5]]] };
    bad.components.find((c: RoomComponent) => c.id === 'plant').foot = -3;
    const m = parseRoomManifest(bad)!;
    expect(m).not.toBeNull();
    expect(m.floorAreas).toEqual([
      [
        [0, 0],
        [10, 0],
        [10, 10],
      ],
    ]);
    expect(m.wallAreas).toBeUndefined();
    expect(m.horizon).toBeUndefined();
    const shelves = m.components.find((c) => c.id === 'shelves')!;
    expect(shelves.surfaceLines).toEqual([[0, 0, 50, 0]]);
    expect(shelves.blocks).toEqual({ wall: [[[0, 0], [5, 0], [5, 5]]] });
    expect(m.components.find((c) => c.id === 'plant')!.foot).toBeUndefined();
  });
});

describe('the bundled cozy pack', () => {
  const cozy = parseRoomManifest(JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../resources/seilink-packs/cozy/manifest.json'), 'utf8')))!;
  const base = defaultRoomState('cozy');
  const r = placementRegions(cozy, base);
  const byId = (id: string): RoomComponent => cozy.components.find((c) => c.id === id)!;

  it('is labelled: floor, wall, shelf lines, a bed top, part blocks, a horizon', () => {
    expect(cozy).not.toBeNull();
    expect(r.labelled && r.perspective).toBe(true);
    expect(r.surfaces.filter((s) => s.kind === 'line' && s.slot === 'shelf')).toHaveLength(3);
    expect(r.surfaces.filter((s) => s.kind === 'area' && s.slot === 'bed')).toHaveLength(1);
    expect(r.floorBlocks.length).toBeGreaterThanOrEqual(4);
    expect(cozy.horizon).toBeLessThan(r.floorTop);
  });

  it('tags each item with where it goes', () => {
    expect(Object.fromEntries(cozy.components.filter((c) => c.slot === 'item').map((c) => [c.id, c.placement]))).toEqual({
      desk_lamp: 'surface',
      books: 'surface',
      succulent: 'surface',
      monstera: 'floor',
      cushion: 'floor',
    });
  });

  it('keeps every item at its artist spot, within a pixel (they all rest on something there)', () => {
    for (const c of cozy.components.filter((x) => x.slot === 'item')) {
      const { state, index } = addItem(cozy, base, c.id);
      const it = state.items[index];
      const [bx, by, bw, bh] = c.box!;
      expect(it.x, c.id).toBe(bx + bw / 2);
      expect(Math.abs(it.y - (by + bh)), c.id).toBeLessThanOrEqual(1);
      expect(spotValid(r, c.placement!, it.x, it.y, spriteFit(r, c, 1)), c.id).toBe(true);
    }
  });

  it('puts the shelf decor on the shelves, the books on the bed, and draws them over their part', () => {
    const plan = roomDrawPlan(cozy, sanitizeRoomState(cozy, { ...base, items: ['desk_lamp', 'succulent', 'books', 'monstera', 'cushion'].map((id) => ({ id, ...spot(id) })) }), 'day');
    const z = Object.fromEntries(plan.layers.filter((l): l is ItemLayer => l.kind === 'item').map((l) => [l.component.id, l.z]));
    expect(z.desk_lamp).toBeGreaterThan(40);
    expect(z.desk_lamp).toBeLessThan(41);
    expect(z.succulent).toBeLessThan(41);
    expect(z.books).toBeGreaterThan(50);
    expect(z.books).toBeLessThan(51);
    expect(z.monstera).toBeGreaterThan(70);
    expect(z.cushion).toBeLessThan(90);
  });

  function spot(id: string): { x: number; y: number } {
    const [bx, by, bw, bh] = byId(id).box!;
    return { x: bx + bw / 2, y: by + bh };
  }

  it('moves a plant to the back of the floor smaller, and never behind the bed or into the chair', () => {
    const monstera = byId('monstera');
    const fit = spriteFit(r, monstera, 1);
    // Held up on the back wall: dropped onto the back of the floor, not jumped to the front.
    const back = snapSpot(r, monstera, 2000, 1000, { fit });
    expect(Math.abs(back.x - 2000)).toBeLessThan(60);
    expect(back.y).toBeLessThan(1380);
    expect(depthScale(r, monstera, back.y)).toBeLessThan(0.9);
    expect(spotValid(r, 'floor', back.x, back.y, fit)).toBe(true);
    // Into her chair: pushed out to its side.
    const chair = snapSpot(r, monstera, 1300, 1400, { fit });
    expect(chair.x < 960 || chair.x > 1650).toBe(true);
    // Under the bed: out in front of its rail.
    expect(spotValid(r, 'floor', 300, 1250, fit)).toBe(false);
  });

  it('drops books from a removed shelf onto the floor', () => {
    let s: RoomState = { ...base, items: [{ id: 'books', ...spot('succulent') }] };
    s = sanitizeRoomState(cozy, s);
    expect(surfaceAt(r, s.items[0].x, contactY(r, byId('books'), s.items[0]))).toBeGreaterThanOrEqual(0);
    s = setSlotComponent(cozy, s, 'shelf', null);
    s = setSlotComponent(cozy, s, 'bed', null);
    const after = placementRegions(cozy, s);
    expect(spotValid(after, 'floor', s.items[0].x, contactY(after, byId('books'), s.items[0]))).toBe(true);
  });
});
