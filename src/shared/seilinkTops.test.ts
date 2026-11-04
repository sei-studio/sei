/**
 * Surface tops (261105 shelf pass): a plank's whole top face as the surface,
 * forgiving capture, the lip drawn over the items on its top, soft tops.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultRoomState, type RoomComponent, type RoomPresetManifest, type RoomState } from './seilinkRoom';
import { roomDrawPlan, sinkKeep, sinkLook, sunkRect, type ItemLayer, type SlotLayer } from './seilinkDraw';
import { parseRoomManifest, sanitizeRoomState } from './seilinkValidate';
import {
  chooseSurface,
  contactY,
  depthOnSurface,
  END_INSET,
  fitsSurface,
  placedItemZ,
  placementRegions,
  snapSpot,
  spotValid,
  spriteFit,
  surfaceAt,
  SURFACE_CAPTURE,
  topKeep,
} from './seilinkPlace';

// Two planks on the left wall: the upper one slopes down 40 px over its 400 px, both
// 20 px deep from the back edge to the front of the top face, with a front face band
// (the lip) under each. A bed with a soft top. Planks 120 px apart (front of one to
// the back of the next), so capture and the downward lean can be told apart.
const plank1 = { area: [[100, 280], [500, 320], [500, 340], [100, 300]], lip: [[97, 300], [503, 340], [503, 352], [97, 312]] };
const plank2 = { area: [[100, 460], [500, 460], [500, 480], [100, 480]], lip: [[97, 480], [503, 480], [503, 490], [97, 490]] };
const manifest: RoomPresetManifest = {
  format: 'sei-room',
  version: 1,
  id: 'cozy',
  place: 'your bedroom',
  canvas: [2000, 1000],
  avatar: { x: 1000, y: 1000, height: 600 },
  horizon: 500,
  floorAreas: [[[0, 800], [2000, 800], [2000, 1000], [0, 1000]]],
  wallAreas: [[[0, 0], [2000, 0], [2000, 790], [0, 790]]],
  slots: {
    shell: { z: 10, options: ['shell'] },
    shelf: { z: 40, options: ['shelves'], optional: true },
    bed: { z: 50, options: ['bed'], optional: true },
  },
  components: [
    { id: 'shell', slot: 'shell', name: 'walls', frames: { day: { src: 's.webp' } } },
    {
      id: 'shelves',
      slot: 'shelf',
      name: 'wall shelves',
      surfaceTops: [plank1, plank2] as RoomComponent['surfaceTops'],
      frames: { day: { src: 'sh.webp', glow: 'sh_glow.webp' } },
    },
    {
      id: 'bed',
      slot: 'bed',
      name: 'bed',
      tintable: true,
      defaultTint: '#eeeeee',
      surfaceTops: [{ area: [[0, 650], [400, 650], [400, 700], [0, 700]], sink: 8 }],
      frames: { day: { src: 'b.webp', mask: 'bm.webp' } },
    },
    { id: 'books', slot: 'item', name: 'books', placement: 'surface', foot: 10, box: [0, 0, 120, 80], frames: { day: { src: 'bk.webp' } } },
    { id: 'vase', slot: 'item', name: 'tall vase', placement: 'surface', foot: 4, box: [0, 0, 40, 260], frames: { day: { src: 'v.webp' } } },
  ],
};
const comp = (id: string): RoomComponent => manifest.components.find((c) => c.id === id)!;
const room = defaultRoomState('cozy');
const R = placementRegions(manifest, room);
const books = comp('books');
const fit = spriteFit(R, books, 1);
/** Anchor y for a books contact at y (foot 10). */
const at = (contact: number): number => contact + 10;

describe('band snapping', () => {
  it('reads each top as an area with its lip, a soft top with its sink', () => {
    expect(R.surfaces.map((s) => [s.kind, s.slot, s.kind === 'area' && Boolean(s.lip), s.kind === 'area' ? s.sink : -1])).toEqual([
      ['area', 'shelf', true, 0],
      ['area', 'shelf', true, 0],
      ['area', 'bed', false, 8],
    ]);
  });

  it('lets the contact rest anywhere in the depth of the plank, x free along it', () => {
    // Plank 2 runs from its back edge (y 460) to the front of its top face (480). Books
    // keep the back of their base (a foot, 10 px) on it too, so contacts 470..480 hold.
    for (const contact of [470, 474, 480]) {
      const s = snapSpot(R, books, 300, at(contact), { fit });
      expect(s, `contact ${contact}`).toMatchObject({ x: 300, y: at(contact), surface: 1 });
      expect(spotValid(R, 'surface', s.x, s.y, fit)).toBe(true);
    }
    // On the sloped plank the band follows the slope: at x 300 it spans 300..320.
    expect(snapSpot(R, books, 300, at(316), { fit })).toMatchObject({ x: 300, y: at(316), surface: 0 });
    expect(snapSpot(R, books, 420, at(326), { fit })).toMatchObject({ x: 420, y: at(326), surface: 0 });
  });

  it('lands a contact held above the band at its back (base kept on), below it at its front', () => {
    const above = snapSpot(R, books, 300, at(440), { fit });
    expect(above).toMatchObject({ x: 300, surface: 1 });
    expect(contactY(R, books, above)).toBeCloseTo(470, 0);
    const below = snapSpot(R, books, 300, at(500), { fit });
    expect(below).toMatchObject({ x: 300, surface: 1 });
    expect(contactY(R, books, below)).toBeCloseTo(480, 0);
  });

  it('keeps a minimal end margin so nothing hangs off', () => {
    const inset = 120 * END_INSET;
    const s = snapSpot(R, books, 900, at(470), { fit });
    expect(s.surface).toBe(1);
    expect(s.x).toBe(500 - inset);
    expect(snapSpot(R, books, 0, at(470), { fit }).x).toBe(100 + inset);
    // With no size known, the contact alone: right to the end.
    expect(snapSpot(R, books, 900, at(470)).x).toBe(500);
    // A stored item hanging off the end settles back in.
    expect(spotValid(R, 'surface', 490, at(470), fit)).toBe(false);
  });

  it('never asks more of a top than it has (a sprite wider than the plank sits in its middle)', () => {
    const huge = spriteFit(R, books, 1);
    const wide = (y: number) => ({ ...huge(y)!, w: 2000 });
    const s = snapSpot(R, books, 900, at(470), { fit: wide });
    expect(s.surface).toBe(1);
    expect(s.x).toBeGreaterThanOrEqual(299);
    expect(s.x).toBeLessThanOrEqual(301);
    expect(fitsSurface(R.surfaces[1], s.x, s.y - 10, topKeep({ w: 2000, foot: 10 }))).toBe(true);
  });

  it('orders items on a top back to front', () => {
    const top = R.surfaces[2];
    expect(depthOnSurface(top, 200, 650)).toBe(0);
    expect(depthOnSurface(top, 200, 700)).toBe(1);
    const back = placedItemZ(R, books, { x: 200, y: at(662) });
    const front = placedItemZ(R, books, { x: 200, y: at(698) });
    expect(front).toBeGreaterThan(back);
    expect(back).toBeGreaterThan(50);
    expect(front).toBeLessThan(51);
  });
});

describe('capture distance', () => {
  it(`lands a contact within ${SURFACE_CAPTURE} px above a plank on it, whatever it came from`, () => {
    // 40 px above plank 2's back edge, 120 below plank 1: plank 2, even when it was on plank 1.
    expect(snapSpot(R, books, 300, at(420), { fit }).surface).toBe(1);
    expect(snapSpot(R, books, 300, at(420), { fit, prefer: 0 }).surface).toBe(1);
  });

  it('keeps the plank it is on while within capture below it, though the next one is nearer by the lean', () => {
    // Plank 1's front at x 300 is 320, plank 2's back 460. Held 46 px under plank 1 (366):
    // plank 1 is 46 away, plank 2 94 (75 leaned).
    expect(snapSpot(R, books, 300, at(366), { fit, prefer: 0 }).surface).toBe(0);
    // Not on it before: still the nearest, plank 1.
    expect(snapSpot(R, books, 300, at(366), { fit }).surface).toBe(0);
    // Out of capture (75 px under), and leaning down wins: plank 2 (75 v 65 x 0.8 = 52, more than 14 nearer).
    expect(snapSpot(R, books, 300, at(395), { fit, prefer: 0 }).surface).toBe(1);
  });

  it('lands a contact a little past the end of a plank on that plank', () => {
    const s = snapSpot(R, books, 540, at(470), { fit });
    expect(s.surface).toBe(1);
    expect(s.x).toBe(500 - 120 * END_INSET);
  });

  it('chooses: on a surface first, then the kept one within capture, then the nearest within capture, then the lean', () => {
    const p = (d: number, down = false) => ({ d, biased: d * (down ? 0.8 : 1) });
    expect(chooseSurface([p(30), p(0)], 0)).toBe(1);
    expect(chooseSurface([p(40), p(20)], 0)).toBe(0);
    expect(chooseSurface([p(60), p(20)], 0)).toBe(1);
    expect(chooseSurface([p(100), p(110, true)])).toBe(1);
    // Beyond capture the kept surface wins unless another is KEEP_SURFACE (14) nearer.
    expect(chooseSurface([p(100), p(90)], 0)).toBe(0);
    expect(chooseSurface([p(100), p(80)], 0)).toBe(1);
    expect(chooseSurface([])).toBe(-1);
  });
});

describe('lip occlusion order', () => {
  const state = (items: RoomState['items']): RoomState => ({ ...room, items });
  const names = (st: RoomState): string[] =>
    roomDrawPlan(manifest, st, 'day', { avatar: false }).layers.map((l) =>
      l.kind === 'slot' ? (l.clip ? `lip:${l.clip[0][0][1]}` : l.slot) : l.kind === 'item' ? `${l.component.id}@${l.y}` : 'avatar',
    );

  it('draws each used lip over the items on its top and under the items on the top below', () => {
    const st = state([
      { id: 'books', x: 300, y: at(316) }, // plank 1, near its front
      { id: 'vase', x: 200, y: 484 }, // plank 2 (contact 480): tall, reaches up over plank 1
    ]);
    expect(names(st)).toEqual(['shell', 'shelf', `books@${at(316)}`, 'lip:300', 'vase@484', 'lip:480', 'bed']);
    const plan = roomDrawPlan(manifest, st, 'day');
    const lips = plan.layers.filter((l): l is SlotLayer => l.kind === 'slot' && Boolean(l.clip));
    expect(lips.map((l) => l.clip)).toEqual([[plank1.lip], [plank2.lip]]);
    // The lip is the shelf's own frame, nothing else, and its glow is not drawn twice.
    expect(lips.every((l) => l.component.id === 'shelves' && l.frame.src === 'sh.webp')).toBe(true);
    expect(plan.glows.filter((g) => g.src === 'sh_glow.webp')).toHaveLength(1);
    // All of it between the shelf and the bed.
    const z = plan.layers.map((l) => l.z);
    expect(z.slice(1, 6).every((v) => v >= 40 && v < 41)).toBe(true);
  });

  it('adds a lip only for a top that holds something', () => {
    expect(names(state([{ id: 'books', x: 300, y: at(474) }]))).toEqual(['shell', 'shelf', `books@${at(474)}`, 'lip:480', 'bed']);
    expect(names(state([]))).toEqual(['shell', 'shelf', 'bed']);
    // An item on the bed (no lip) adds none.
    expect(names(state([{ id: 'books', x: 200, y: at(680) }]))).toEqual(['shell', 'shelf', 'bed', `books@${at(680)}`]);
  });

  it('keeps a lip of a tinted part tinted', () => {
    const m: RoomPresetManifest = JSON.parse(JSON.stringify(manifest));
    m.components.find((c) => c.id === 'bed')!.surfaceTops![0].lip = [[0, 700], [400, 700], [400, 720], [0, 720]];
    const plan = roomDrawPlan(m, state([{ id: 'books', x: 200, y: at(680) }]), 'day');
    const lip = plan.layers.find((l): l is SlotLayer => l.kind === 'slot' && Boolean(l.clip));
    expect(lip).toMatchObject({ slot: 'bed', tint: '#eeeeee' });
  });
});

describe('soft tops', () => {
  it('sinks an item on the bed: drawn lower, its base fading out just under the surface', () => {
    const plan = roomDrawPlan(manifest, { ...room, items: [{ id: 'books', x: 200, y: at(680), scale: 1.2 }] }, 'day');
    const l = plan.layers.find((x): x is ItemLayer => x.kind === 'item')!;
    expect(l.sink?.depth).toBeCloseTo(8 * 1.2);
    expect(l.sink?.foot).toBeCloseTo(10 * 1.2);
    const look = sinkLook(l)!;
    expect(look.contact).toBeCloseTo(at(680) - 12);
    expect(sunkRect([0, 0, 10, 10], look)[1]).toBeCloseTo(9.6);
    expect(sinkKeep(look, look.fadeTop - 1)).toBe(1);
    expect(sinkKeep(look, look.contact)).toBeGreaterThan(0);
    expect(sinkKeep(look, look.contact)).toBeLessThan(1);
    expect(sinkKeep(look, look.fadeEnd)).toBe(0);
  });

  it('leaves items on a hard top as they are', () => {
    const plan = roomDrawPlan(manifest, { ...room, items: [{ id: 'books', x: 300, y: at(474) }] }, 'day');
    const l = plan.layers.find((x): x is ItemLayer => x.kind === 'item')!;
    expect(l.sink).toBeNull();
    expect(sinkLook(l)).toBeNull();
  });
});

describe('format', () => {
  it('parses surface tops and drops bad ones without rejecting the pack', () => {
    const raw = JSON.parse(JSON.stringify(manifest));
    raw.components.find((c: RoomComponent) => c.id === 'shelves').surfaceTops.push({ area: [[0, 0], [1, 1]] }, 'x', { area: plank1.area, lip: 'no', sink: -2 });
    const m = parseRoomManifest(raw)!;
    expect(m).not.toBeNull();
    const tops = m.components.find((c) => c.id === 'shelves')!.surfaceTops!;
    expect(tops).toHaveLength(3);
    expect(tops[2]).toEqual({ area: plank1.area });
    expect(m.components.find((c) => c.id === 'bed')!.surfaceTops).toEqual([{ area: [[0, 650], [400, 650], [400, 700], [0, 700]], sink: 8 }]);
  });
});

describe('the bundled cozy pack', () => {
  const cozy = parseRoomManifest(JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../resources/seilink-packs/cozy/manifest.json'), 'utf8')))!;
  const base = defaultRoomState('cozy');
  const r = placementRegions(cozy, base);
  const cbooks = cozy.components.find((c) => c.id === 'books')!;
  const cfit = spriteFit(r, cbooks, 1);

  it('migrates a room saved on the old middle-of-plank lines: onto the band, kept there', () => {
    // The old middle plank line was [0, 421, 524, 480]: at x 300 its contact was y 454.8.
    const old: RoomState = { ...base, items: [{ id: 'books', x: 300, y: 454.8 + 14 }, { id: 'succulent', x: 390, y: 471 }] };
    const s = sanitizeRoomState(cozy, old);
    for (const it of s.items) {
      const c = cozy.components.find((x) => x.id === it.id)!;
      expect(spotValid(r, 'surface', it.x, it.y, spriteFit(r, c, 1)), it.id).toBe(true);
      expect(r.surfaces[surfaceAt(r, it.x, contactY(r, c, it))].slot).toBe('shelf');
    }
    // The succulent stood well inside the band: untouched. The books moved down a little, x all but kept.
    expect(s.items[1]).toEqual(old.items[1]);
    expect(Math.abs(s.items[0].x - 300)).toBeLessThanOrEqual(2);
    expect(s.items[0].y - old.items[0].y).toBeGreaterThan(0);
    expect(s.items[0].y - old.items[0].y).toBeLessThan(12);
    expect(sanitizeRoomState(cozy, s)).toEqual(s);
  });

  it('gives every plank a band about 20 px deep and lands a drop 40 px above a plank on it', () => {
    for (const [i, s] of r.surfaces.entries()) {
      if (s.kind !== 'area' || s.slot !== 'shelf') continue;
      expect(s.across[1] - s.across[0], `plank ${i}`).toBeGreaterThan(18);
      expect(s.across[1] - s.across[0], `plank ${i}`).toBeLessThan(28);
    }
    // Middle plank at x 300: back edge ~445. Held 40 px above it.
    const s = snapSpot(r, cbooks, 300, 405 + 14, { fit: cfit, prefer: 0 });
    expect(r.surfaces[s.surface].slot).toBe('shelf');
    expect(contactY(r, cbooks, s)).toBeGreaterThan(445);
    expect(contactY(r, cbooks, s)).toBeLessThan(470);
  });
});

describe('the bundled gamer and forest packs (261105)', () => {
  const load = (id: string): RoomPresetManifest =>
    parseRoomManifest(JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../resources/seilink-packs/${id}/manifest.json`), 'utf8')))!;
  const settled = (m: RoomPresetManifest) => {
    const st = defaultRoomState(m.id);
    const r = placementRegions(m, st);
    const items = m.components.filter((c) => c.slot === 'item').map((c) => ({ id: c.id, x: c.box![0] + c.box![2] / 2, y: c.box![1] + c.box![3] }));
    return { r, items, out: sanitizeRoomState(m, { ...st, items }).items };
  };
  const slotOf = (r: ReturnType<typeof placementRegions>, m: RoomPresetManifest, it: { id: string; x: number; y: number }): string => {
    const c = m.components.find((x) => x.id === it.id)!;
    const i = surfaceAt(r, it.x, contactY(r, c, it));
    return i >= 0 ? r.surfaces[i].slot : 'none';
  };

  it.each(['gamer', 'forest'])('%s is labelled with surface tops, blocks, a horizon and item feet', (id) => {
    const m = load(id);
    expect(m).not.toBeNull();
    const r = placementRegions(m, defaultRoomState(m.id));
    expect(r.labelled && r.perspective).toBe(true);
    expect(r.surfaces.length).toBeGreaterThan(2);
    expect(r.surfaces.every((s) => s.kind === 'area')).toBe(true);
    expect(m.components.some((c) => c.surfaces || c.surfaceLines || c.surfaceAreas)).toBe(false);
    expect(m.components.filter((c) => c.slot === 'item').every((c) => (c.foot ?? 0) > 0)).toBe(true);
  });

  it('gamer: three shelf planks with lips, a soft bed, every item settles where the designer put it', () => {
    const m = load('gamer');
    const { r, items, out } = settled(m);
    const tops = r.surfaces.map((s) => [s.slot, s.kind === 'area' && Boolean(s.lip), s.kind === 'area' ? s.sink : 0]);
    expect(tops).toEqual([['shelf', true, 0], ['shelf', true, 0], ['shelf', true, 0], ['bed', false, 8]]);
    for (const [i, it] of out.entries()) {
      expect(Math.hypot(it.x - items[i].x, it.y - items[i].y), it.id).toBeLessThan(16);
      expect(slotOf(r, m, it), it.id).toBe(it.id === 'controller' ? 'bed' : 'shelf');
    }
  });

  it('forest: the mug stays on the log, floor items stay on open ground', () => {
    const m = load('forest');
    const { r, items, out } = settled(m);
    expect(r.surfaces.map((s) => s.slot)).toEqual(['shelf', 'chair', 'chair']);
    for (const [i, it] of out.entries()) {
      expect(it, it.id).toEqual(items[i]);
      const c = m.components.find((x) => x.id === it.id)!;
      expect(spotValid(r, c.placement!, it.x, it.y, spriteFit(r, c, 1)), it.id).toBe(true);
    }
    expect(slotOf(r, m, out.find((it) => it.id === 'camp_mug')!)).toBe('chair');
    // Nothing on the ground where the campfire, the tent or Sei's seat stand.
    const backpack = m.components.find((c) => c.id === 'backpack')!;
    const fit = spriteFit(r, backpack, 1);
    expect(spotValid(r, 'floor', 1860, 1100, fit)).toBe(false);
    expect(spotValid(r, 'floor', 500, 960, fit)).toBe(false);
    expect(spotValid(r, 'floor', 1300, 1300, fit)).toBe(false);
    expect(spotValid(r, 'floor', 300, 1300, fit)).toBe(true);
  });
});
