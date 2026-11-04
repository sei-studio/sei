import { describe, expect, it } from 'vitest';
import { defaultRoomState, describeRoom, type RoomPresetManifest } from './seilinkRoom';
import { roomDrawPlan, planFiles } from './seilinkDraw';
import { parseRoomManifest, sanitizeRoomState } from './seilinkValidate';
import {
  addItem,
  canUndo,
  clampPlacement,
  clampScale,
  clampToAreas,
  commitEdit,
  createHistory,
  defaultSpot,
  endGesture,
  flipItem,
  isDirty,
  ITEM_SCALE_MAX,
  ITEM_SCALE_MIN,
  markSaved,
  moveItem,
  placementAreas,
  removeItem,
  scaleItem,
  setItemTint,
  setSlotComponent,
  setSlotTint,
  swatchesFor,
  switchPreset,
  undo,
  HISTORY_LIMIT,
} from './seilinkEdit';

const manifest: RoomPresetManifest = {
  format: 'sei-room',
  version: 1,
  id: 'cozy',
  place: 'your bedroom',
  canvas: [2000, 1000],
  avatar: { x: 1000, y: 1000, height: 600 },
  floor: [1200, 850, 800, 150],
  slots: {
    shell: { z: 10, options: ['shell'] },
    curtains: { z: 30, options: ['linen', 'velvet'], optional: true },
    shelf: { z: 40, options: ['shelves'], optional: true },
    chair: { z: 90, options: ['chair'] },
  },
  components: [
    { id: 'shell', slot: 'shell', name: 'walls', tintable: true, defaultTint: '#b5c2a0', frames: { day: { src: 's.webp', mask: 'sm.webp' } } },
    { id: 'linen', slot: 'curtains', name: 'curtains', tintable: true, defaultTint: '#ece6da', swatches: ['#7B4FC9', '#ece6da'], frames: { day: { src: 'c.webp', mask: 'cm.webp' } } },
    { id: 'velvet', slot: 'curtains', name: 'velvet curtains', frames: { day: { src: 'v.webp' } } },
    { id: 'shelves', slot: 'shelf', name: 'wall shelves', surfaces: [[0, 300, 500, 0], [0, 500, 500, 0]], frames: { day: { src: 'sh.webp' } } },
    { id: 'chair', slot: 'chair', name: 'armchair', frames: { day: { src: 'ch.webp' } } },
    { id: 'cushion', slot: 'item', name: 'floor cushion', placement: 'floor', tintable: true, defaultTint: '#e3a9a6', box: [1500, 800, 300, 200], frames: { day: { src: 'cu.webp', mask: 'cum.webp' } } },
    { id: 'books', slot: 'item', name: 'books', placement: 'surface', frames: { day: { src: 'b.webp' } } },
    { id: 'poster', slot: 'item', name: 'poster', placement: 'wall', frames: { day: { src: 'p.webp' } } },
  ],
};

describe('placement', () => {
  const s = defaultRoomState('cozy');
  const cushion = manifest.components.find((c) => c.id === 'cushion')!;
  const books = manifest.components.find((c) => c.id === 'books')!;
  const poster = manifest.components.find((c) => c.id === 'poster')!;

  it('keeps floor items on the floor box', () => {
    expect(clampPlacement(manifest, s, cushion, 100, 100)).toEqual([1200, 850]);
    expect(clampPlacement(manifest, s, cushion, 1500, 900)).toEqual([1500, 900]);
    expect(clampPlacement(manifest, s, cushion, 5000, 5000)).toEqual([2000, 1000]);
  });

  it('keeps wall items above the floor', () => {
    expect(placementAreas(manifest, s, poster)).toEqual([[0, 0, 2000, 850]]);
    expect(clampPlacement(manifest, s, poster, 400, 990)).toEqual([400, 850]);
  });

  it('snaps surface items to the nearest shelf top, or frees them when the room has none', () => {
    expect(clampPlacement(manifest, s, books, 200, 330)).toEqual([200, 300]);
    expect(clampPlacement(manifest, s, books, 200, 460)).toEqual([200, 500]);
    expect(clampPlacement(manifest, s, books, 900, 480)).toEqual([500, 500]);
    const noShelf = setSlotComponent(manifest, s, 'shelf', null);
    expect(clampPlacement(manifest, noShelf, books, 900, 480)).toEqual([900, 480]);
  });

  it('picks the nearest of several areas and rounds', () => {
    expect(clampToAreas([[0, 0, 10, 10], [100, 0, 10, 10]], 80.4, 5.6)).toEqual([100, 6]);
  });

  it('places a new item at the artist spot, then nudges copies', () => {
    expect(defaultSpot(manifest, s, cushion)).toEqual([1650, 1000]);
    const one = addItem(manifest, s, 'cushion').state;
    const [x2] = defaultSpot(manifest, one, cushion);
    expect(x2).toBeLessThan(1650);
  });

  it('clamps scale to the small range', () => {
    expect(clampScale(9)).toBe(ITEM_SCALE_MAX);
    expect(clampScale(0.1)).toBe(ITEM_SCALE_MIN);
    expect(clampScale(Number.NaN)).toBe(1);
    expect(clampScale(1.234)).toBe(1.23);
  });
});

describe('edit ops', () => {
  it('never mutates and only accepts valid changes', () => {
    const s = defaultRoomState('cozy');
    const frozen = JSON.stringify(s);
    const a = setSlotComponent(manifest, s, 'curtains', 'velvet');
    expect(a.slots.curtains).toEqual({ id: 'velvet' });
    expect(setSlotComponent(manifest, s, 'chair', null)).toBe(s); // chair is not optional
    expect(setSlotComponent(manifest, s, 'curtains', 'nope')).toBe(s);
    expect(setSlotTint(manifest, s, 'curtains', 'red')).toBe(s);
    expect(setSlotTint(manifest, s, 'curtains', '#AABBCC').slots.curtains).toEqual({ id: 'linen', tint: '#aabbcc' });
    expect(JSON.stringify(s)).toBe(frozen);
  });

  it('keeps a slot tint across a swap only onto a tintable part', () => {
    const s = setSlotTint(manifest, defaultRoomState('cozy'), 'curtains', '#112233');
    expect(setSlotComponent(manifest, s, 'curtains', 'velvet').slots.curtains).toEqual({ id: 'velvet' });
  });

  it('adds, moves (clamped), flips, scales, tints and removes items', () => {
    let { state, index } = addItem(manifest, defaultRoomState('cozy'), 'cushion');
    expect(index).toBe(0);
    state = moveItem(manifest, state, 0, 0, 0);
    expect(state.items[0]).toMatchObject({ x: 1200, y: 850 });
    state = flipItem(state, 0);
    expect(state.items[0].flip).toBe(true);
    state = flipItem(state, 0);
    expect(state.items[0].flip).toBeUndefined();
    state = scaleItem(state, 0, 1.4);
    expect(state.items[0].scale).toBe(1.4);
    state = scaleItem(state, 0, 1);
    expect(state.items[0].scale).toBeUndefined();
    state = setItemTint(manifest, state, 0, '#336699');
    expect(state.items[0].tint).toBe('#336699');
    expect(addItem(manifest, state, 'shell').index).toBe(-1);
    state = removeItem(state, 0);
    expect(state.items).toEqual([]);
  });

  it('switching preset keeps avatar and time, resets the rest', () => {
    const s = { ...defaultRoomState('cozy'), time: 'night' as const, avatar: { kind: 'live2d' as const, modelPath: 'm.model3.json' } };
    const g = switchPreset(addItem(manifest, s, 'books').state, 'gamer');
    expect(g).toMatchObject({ preset: 'gamer', time: 'night', items: [], slots: {}, avatar: { kind: 'live2d' } });
  });

  it('offers the default tint first, then the component swatches, deduped', () => {
    const linen = manifest.components.find((c) => c.id === 'linen')!;
    expect(swatchesFor(linen)).toEqual(['#ece6da', '#7b4fc9']);
    expect(swatchesFor(manifest.components[0]).length).toBeLessThanOrEqual(7);
    // A house swatch that looks like the default is dropped.
    expect(swatchesFor({ ...linen, swatches: undefined, defaultTint: '#f0eae0' })).not.toContain('#f2ece2');
  });
});

describe('history', () => {
  const base = defaultRoomState('cozy');

  it('undoes step by step and tracks dirty against the saved state', () => {
    let h = createHistory(base);
    expect(isDirty(h)).toBe(false);
    h = commitEdit(h, setSlotTint(manifest, h.present, 'shell', '#111111'));
    h = commitEdit(h, addItem(manifest, h.present, 'books').state);
    expect(isDirty(h)).toBe(true);
    expect(h.past).toHaveLength(2);
    h = undo(h);
    expect(h.present.items).toEqual([]);
    h = undo(h);
    expect(h.present).toBe(base);
    expect(isDirty(h)).toBe(false);
    expect(canUndo(h)).toBe(false);
    expect(undo(h)).toBe(h);
  });

  it('coalesces one gesture into one undo step', () => {
    let h = createHistory(base);
    for (const c of ['#100000', '#200000', '#300000']) h = commitEdit(h, setSlotTint(manifest, h.present, 'shell', c), 'tint:shell');
    expect(h.past).toHaveLength(1);
    expect(h.present.slots.shell?.tint).toBe('#300000');
    h = endGesture(h);
    h = commitEdit(h, setSlotTint(manifest, h.present, 'shell', '#400000'), 'tint:shell');
    expect(h.past).toHaveLength(2);
    h = undo(undo(h));
    expect(h.present).toBe(base);
  });

  it('ignores no-op edits and caps its length', () => {
    let h = createHistory(base);
    h = commitEdit(h, { ...base });
    expect(h.past).toHaveLength(0);
    for (let i = 0; i < HISTORY_LIMIT + 10; i++) h = commitEdit(h, { ...h.present, items: [{ id: 'books', x: i, y: 0 }] });
    expect(h.past).toHaveLength(HISTORY_LIMIT);
  });

  it('a save makes the sanitized state the clean point, key order aside', () => {
    let h = createHistory(base, null);
    expect(isDirty(h)).toBe(true);
    h = commitEdit(h, scaleItem(addItem(manifest, h.present, 'books').state, 0, 1.2));
    const fromMain = sanitizeRoomState(manifest, JSON.parse(JSON.stringify(h.present)));
    h = markSaved(h, fromMain);
    expect(isDirty(h)).toBe(false);
    expect(canUndo(h)).toBe(true);
  });

  it('keeps edits made while a save was in flight', () => {
    let h = createHistory(base);
    h = commitEdit(h, addItem(manifest, h.present, 'books').state);
    const sent = h.present;
    h = commitEdit(h, flipItem(h.present, 0));
    h = markSaved(h, sanitizeRoomState(manifest, JSON.parse(JSON.stringify(sent))), sent);
    expect(h.present.items[0].flip).toBe(true);
    expect(isDirty(h)).toBe(true);
  });
});

describe('format additions round-trip', () => {
  it('keeps surfaces, swatches and item tints through validation', () => {
    const parsed = parseRoomManifest(JSON.parse(JSON.stringify(manifest)))!;
    expect(parsed).not.toBeNull();
    expect(parsed.components.find((c) => c.id === 'shelves')?.surfaces).toEqual([[0, 300, 500, 0], [0, 500, 500, 0]]);
    expect(parsed.components.find((c) => c.id === 'linen')?.swatches).toEqual(['#7b4fc9', '#ece6da']);

    let s = addItem(parsed, defaultRoomState('cozy'), 'cushion').state;
    s = setItemTint(parsed, s, 0, '#5577AA');
    s = flipItem(scaleItem(s, 0, 1.3), 0);
    s = setSlotComponent(parsed, setSlotTint(parsed, s, 'curtains', '#7b4fc9'), 'shelf', null);
    const back = sanitizeRoomState(parsed, JSON.parse(JSON.stringify(s)));
    expect(back).toEqual(s);
    // An untintable item's tint is dropped.
    const bad = sanitizeRoomState(parsed, { ...s, items: [{ id: 'books', x: 1, y: 1, tint: '#ffffff' }] });
    expect(bad.items[0].tint).toBeUndefined();
  });

  it('draws and describes a tinted item', () => {
    let s = addItem(manifest, defaultRoomState('cozy'), 'cushion').state;
    s = setItemTint(manifest, s, 0, '#3355cc');
    const plan = roomDrawPlan(manifest, s, 'day');
    const item = plan.layers.find((l) => l.kind === 'item');
    expect(item && item.kind === 'item' && item.tint).toBe('#3355cc');
    expect(planFiles(plan)).toContain('cum.webp');
    expect(describeRoom(manifest, s).things).toContain('blue floor cushion');
  });
});
