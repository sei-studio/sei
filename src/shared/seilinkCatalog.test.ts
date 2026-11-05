/**
 * The 261105 room catalog format: patterns, accents, light colour, cycle,
 * particles, shared files, cover fit, new slots and per-pack labels.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SLOT_LABEL, defaultRoomState, describeRoom, patternsFor, resolvePattern, slotLabel, type RoomPresetManifest } from './seilinkRoom';
import { coverCrop, cycleColour, roomDrawPlan, type SlotLayer } from './seilinkDraw';
import { parseRoomManifest, sanitizeRoomState } from './seilinkValidate';
import { toneOnTone } from './seilinkPatterns';
import { currentPattern, setItemAccent, setItemPattern, setSlotAccent, setSlotComponent, setSlotCycle, setSlotPattern, setSlotTint } from './seilinkEdit';
import { lightSlotsOf, roomShapeOf } from './seilinkTelemetry';

const raw = {
  format: 'sei-room',
  version: 1,
  id: 'forest',
  place: 'a campfire in the forest',
  canvas: [2560, 1440],
  avatar: { x: 1300, y: 1400, height: 900 },
  slots: {
    view: { z: 0, options: ['sky'], label: 'Sky' },
    shell: { z: 10, options: ['clearing'] },
    bed: { z: 50, options: ['tent'], label: 'Tent', group: 'fabrics' },
    lights: { z: 60, options: ['fireflies', 'string'], optional: true, label: 'Lights' },
    tree: { z: 70, options: ['oak'], optional: true },
  },
  components: [
    {
      id: 'sky',
      slot: 'view',
      name: 'sky',
      box: [0, 0, 2560, 800],
      fit: 'cover',
      focus: [0.5, 0.2],
      frames: { day: { src: '_shared/views/sky_day.webp' }, dusk: { src: '_shared/views/sky_dusk.webp', particles: [{ kind: 'rain', glass: true, density: 9 }, { kind: 'bogus' }] } },
    },
    { id: 'clearing', slot: 'shell', name: 'clearing', frames: { day: { src: 'clearing.webp' } } },
    {
      id: 'tent',
      slot: 'bed',
      name: 'tent',
      tintable: true,
      defaultTint: '#c87a4a',
      patternSurface: 'tents',
      patternQuads: [{ quad: [[100, 400], [900, 420], [940, 980], [60, 960]], size: [800, 560] }, { quad: [[1, 2], [3, 4]] }],
      frames: { day: { src: 'tent.webp', mask: 'tent_mask.webp' } },
    },
    { id: 'fireflies', slot: 'lights', name: 'fireflies', frames: { day: { src: '_shared/blank.webp' }, night: { src: '_shared/blank.webp', particles: [{ kind: 'fireflies', area: [0, 300, 2560, 900] }] } } },
    {
      id: 'string',
      slot: 'lights',
      name: 'string lights',
      tintable: true,
      cycle: true,
      defaultTint: '#ffd27a',
      frames: { day: { src: 's.webp', mask: 'sm.webp', glow: 'sg.webp', glowTint: true }, night: { src: 's.webp', mask: 'sm.webp', glow: 'sg.webp', glowTint: true, effect: 'pulse' } },
    },
    { id: 'oak', slot: 'tree', name: 'oak tree', frames: { day: { src: 'oak.webp' } } },
    { id: 'blanket', slot: 'item', name: 'blanket', placement: 'floor', tintable: true, patterns: ['gingham', 'ditsy', 'nope'], frames: { day: { src: 'b.webp', mask: 'bm.webp' } } },
  ],
  patternTiles: [
    { id: 'ditsy', name: 'Ditsy floral', adjective: 'flowery', tile: '_shared/patterns/ditsy.webp', period: [128, 128], surfaces: ['bedding', 'cushions', 'tents'] },
    { id: 'gingham', name: 'Fake', adjective: 'x', tile: '_shared/patterns/g.webp', period: [64, 64], surfaces: ['tents'] },
    { id: 'evil', name: 'Evil', adjective: 'x', tile: '../../etc/passwd.webp', period: [64, 64], surfaces: ['tents'] },
  ],
};

const manifest = parseRoomManifest(raw) as RoomPresetManifest;

describe('catalog manifest', () => {
  it('parses the new fields and drops bad entries', () => {
    expect(manifest).not.toBeNull();
    expect(manifest.slots.bed?.label).toBe('Tent');
    expect(manifest.slots.lights?.optional).toBe(true);
    const sky = manifest.components.find((c) => c.id === 'sky')!;
    expect(sky.fit).toBe('cover');
    expect(sky.focus).toEqual([0.5, 0.2]);
    expect(sky.frames.day.src).toBe('_shared/views/sky_day.webp');
    // Bad particle kinds are dropped, density is clamped.
    expect(sky.frames.dusk?.particles).toEqual([{ kind: 'rain', glass: true, density: 3 }]);
    const tent = manifest.components.find((c) => c.id === 'tent')!;
    expect(tent.patternSurface).toBe('tents');
    expect(tent.patternQuads).toHaveLength(1);
    const string = manifest.components.find((c) => c.id === 'string')!;
    expect(string.cycle).toBe(true);
    expect(string.frames.day.glowTint).toBe(true);
    // A tile never shadows a code pattern; a traversal path is dropped.
    expect(manifest.patternTiles?.map((t) => t.id)).toEqual(['ditsy']);
  });

  it('labels slots per pack, with the default names otherwise', () => {
    expect(slotLabel(manifest, 'bed')).toBe('Tent');
    expect(slotLabel(manifest, 'tree')).toBe('Tree');
    expect(slotLabel(manifest, 'shell')).toBe('Walls');
    expect(DEFAULT_SLOT_LABEL.lights).toBe('Lights');
  });

  it('offers patterns by surface or an explicit list (unknown ids skipped)', () => {
    const tent = manifest.components.find((c) => c.id === 'tent')!;
    const ids = patternsFor(manifest, tent).map((p) => p.id);
    expect(ids).toContain('gingham');
    expect(ids).toContain('plaid');
    expect(ids).toContain('ditsy');
    expect(ids).not.toContain('pinstripe'); // not made for tents
    const blanket = manifest.components.find((c) => c.id === 'blanket')!;
    expect(patternsFor(manifest, blanket).map((p) => p.id)).toEqual(['gingham', 'ditsy']);
    const oak = manifest.components.find((c) => c.id === 'oak')!;
    expect(patternsFor(manifest, oak)).toEqual([]);
  });

  it('defaults the accent to tone-on-tone of the base', () => {
    const tent = manifest.components.find((c) => c.id === 'tent')!;
    const p = resolvePattern(manifest, tent, '#3366aa', 'gingham', undefined)!;
    expect(p.accent).toBe(toneOnTone('#3366aa'));
    expect(resolvePattern(manifest, tent, '#3366aa', 'gingham', '#ff0000')!.accent).toBe('#ff0000');
    expect(resolvePattern(manifest, tent, '#3366aa', 'plain', undefined)).toBeNull();
    expect(resolvePattern(manifest, tent, '#3366aa', 'pinstripe', undefined)).toBeNull();
  });
});

describe('catalog state', () => {
  it('a room saved before patterns sanitizes and draws exactly as before', () => {
    const old = { version: 1, preset: 'forest', time: 'day', slots: { bed: { id: 'tent', tint: '#aa3355' } }, items: [], avatar: { kind: 'sei' } };
    const s = sanitizeRoomState(manifest, old);
    expect(s.slots.bed).toEqual({ id: 'tent', tint: '#aa3355' });
    const tent = roomDrawPlan(manifest, s, 'day').layers.find((l): l is SlotLayer => l.kind === 'slot' && l.slot === 'bed')!;
    expect(tent.tint).toBe('#aa3355');
    expect(tent.pattern).toBeUndefined();
  });

  it('keeps an offered pattern, an accent and cycle; drops the rest', () => {
    const s = sanitizeRoomState(manifest, {
      version: 1,
      preset: 'forest',
      time: 'night',
      slots: {
        bed: { id: 'tent', tint: '#AA3355', pattern: 'plaid', accent: '#112233' },
        lights: { id: 'string', cycle: true, pattern: 'gingham' },
        tree: { id: 'oak', pattern: 'gingham', accent: '#ffffff', cycle: true },
      },
      items: [{ id: 'blanket', x: 1200, y: 1300, pattern: 'pinstripe', accent: 'red' }],
      avatar: { kind: 'sei' },
    });
    expect(s.slots.bed).toEqual({ id: 'tent', tint: '#aa3355', pattern: 'plaid', accent: '#112233' });
    expect(s.slots.lights).toEqual({ id: 'string', cycle: true });
    expect(s.slots.tree).toEqual({ id: 'oak' });
    expect(s.items[0]?.pattern).toBeUndefined();
    expect(s.items[0]?.accent).toBeUndefined();
  });

  it('puts the pattern and its planes on the layer, and lights the glow in the tint', () => {
    const s = defaultRoomState('forest');
    s.slots.bed = { id: 'tent', pattern: 'gingham' };
    s.slots.lights = { id: 'string', tint: '#33ccff' };
    const plan = roomDrawPlan(manifest, s, 'night');
    const tent = plan.layers.find((l): l is SlotLayer => l.kind === 'slot' && l.slot === 'bed')!;
    expect(tent.pattern?.def.id).toBe('gingham');
    expect(tent.pattern?.accent).toBe(toneOnTone('#c87a4a'));
    expect(tent.quads).toHaveLength(1);
    expect(plan.glows).toEqual([expect.objectContaining({ src: 'sg.webp', tint: '#33ccff', effect: 'pulse' })]);
  });

  it('a cycling light draws its part in white and colours its glow per frame', () => {
    const s = defaultRoomState('forest');
    s.slots.lights = { id: 'string', tint: '#33ccff', cycle: true };
    const plan = roomDrawPlan(manifest, s, 'night');
    const light = plan.layers.find((l): l is SlotLayer => l.kind === 'slot' && l.slot === 'lights')!;
    expect(light.tint).toBe('#ffffff');
    expect(light.cycle).toBe(true);
    expect(plan.glows[0]).toEqual(expect.objectContaining({ cycle: true }));
    expect(plan.glows[0].tint).toBeUndefined();
  });

  it('lists frame particles with their area and where they draw', () => {
    const s = defaultRoomState('forest');
    s.slots.lights = { id: 'fireflies' };
    const dusk = roomDrawPlan(manifest, s, 'dusk');
    expect(dusk.particles).toEqual([expect.objectContaining({ where: 'outside', area: [0, 0, 2560, 800] })]);
    expect(dusk.particles[0].spec.kind).toBe('rain');
    const night = roomDrawPlan(manifest, s, 'night');
    expect(night.particles).toEqual([expect.objectContaining({ where: 'scene', area: [0, 300, 2560, 900] })]);
    expect(roomDrawPlan(manifest, s, 'day').particles).toEqual([]);
    // Taking the fireflies out takes them away.
    s.slots.lights = { id: null };
    expect(roomDrawPlan(manifest, s, 'night').particles).toEqual([]);
  });

  it('names patterns and cycling lights in look()', () => {
    const s = defaultRoomState('forest');
    s.time = 'day';
    s.slots.bed = { id: 'tent', tint: '#3366cc', pattern: 'plaid' };
    s.slots.lights = { id: 'string', cycle: true };
    const things = describeRoom(manifest, s).things;
    expect(things).toContain('blue plaid tent');
    expect(things).toContain('colour-changing string lights');
  });
});

describe('cover crop', () => {
  it('fills the box keeping the aspect, cropped around the focus', () => {
    // Same aspect: the whole frame.
    expect(coverCrop([1000, 500], [2000, 1000])).toEqual([0, 0, 1000, 500]);
    // A taller box crops the sides.
    const [sx, sy, sw, sh] = coverCrop([1000, 1000], [500, 1000]);
    expect([sx, sy, sw, sh]).toEqual([250, 0, 500, 1000]);
    // Focus left keeps the left edge; focus past the edge clamps.
    expect(coverCrop([1000, 1000], [500, 1000], [0, 0.5])[0]).toBe(0);
    expect(coverCrop([1000, 1000], [500, 1000], [1, 0.5])[0]).toBe(500);
    // A wider box crops top and bottom around fy.
    const c = coverCrop([1215, 1319], [1219, 1292], [0.5, 0.5]);
    expect(c[0]).toBe(0);
    expect(c[2]).toBe(1215);
    expect(c[3]).toBeCloseTo((1292 * 1215) / 1219, 6);
    expect(c[1]).toBeCloseTo((1319 - c[3]) / 2, 6);
  });
});

describe('colour cycle', () => {
  it('runs round the hues and comes back', () => {
    const a = cycleColour(0);
    expect(cycleColour(20_000)).toBe(a);
    const seen = new Set([0, 1, 2, 3, 4, 5].map((k) => cycleColour((k * 20_000) / 6)));
    expect(seen.size).toBe(6);
    for (const c of seen) expect(c).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('look() names the weather', () => {
  it('lists rain and fireflies for the time they show', () => {
    const s = defaultRoomState('forest');
    s.slots.lights = { id: 'fireflies' };
    s.time = 'dusk';
    expect(describeRoom(manifest, s).things).toContain('rain falling outside');
    s.time = 'night';
    const night = describeRoom(manifest, s).things;
    expect(night.filter((t) => t === 'fireflies')).toHaveLength(1);
    expect(night).not.toContain('rain falling outside');
    s.time = 'day';
    expect(describeRoom(manifest, s).things).not.toContain('fireflies');
  });
});

describe('catalog edit ops', () => {
  const s0 = defaultRoomState('forest');

  it('sets and clears a slot pattern and accent, leaving untouched rooms unchanged', () => {
    const p = setSlotPattern(manifest, s0, 'bed', 'gingham');
    expect(p.slots.bed).toEqual({ id: 'tent', pattern: 'gingham' });
    expect(setSlotPattern(manifest, s0, 'bed', 'pinstripe')).toBe(s0); // not offered on a tent
    expect(setSlotPattern(manifest, s0, 'tree', 'gingham')).toBe(s0); // not tintable
    const a = setSlotAccent(manifest, p, 'bed', '#AABBCC');
    expect(a.slots.bed).toEqual({ id: 'tent', pattern: 'gingham', accent: '#aabbcc' });
    expect(setSlotAccent(manifest, a, 'bed', 'red')).toBe(a);
    const plain = setSlotAccent(manifest, setSlotPattern(manifest, a, 'bed', 'plain'), 'bed', null);
    // Plain with no default pattern drops the key: same as never touched.
    expect(plain.slots.bed).toEqual({ id: 'tent' });
    expect(currentPattern(manifest.components.find((c) => c.id === 'tent'), undefined)).toBe('plain');
  });

  it('keeps pattern and colours across a tint change; picking a colour stops a cycle', () => {
    const p = setSlotTint(manifest, setSlotPattern(manifest, s0, 'bed', 'plaid'), 'bed', '#336699');
    expect(p.slots.bed).toEqual({ id: 'tent', pattern: 'plaid', tint: '#336699' });
    const lit = setSlotComponent(manifest, s0, 'lights', 'string');
    const cyc = setSlotCycle(manifest, lit, 'lights', true);
    expect(cyc.slots.lights).toEqual({ id: 'string', cycle: true });
    expect(setSlotTint(manifest, cyc, 'lights', '#ff0000').slots.lights).toEqual({ id: 'string', tint: '#ff0000' });
    expect(setSlotCycle(manifest, cyc, 'lights', false).slots.lights).toEqual({ id: 'string' });
    // Fireflies do not cycle.
    const ff = setSlotComponent(manifest, s0, 'lights', 'fireflies');
    expect(setSlotCycle(manifest, ff, 'lights', true)).toBe(ff);
    // Swapping to a part without the cycle drops it.
    expect(setSlotComponent(manifest, cyc, 'lights', 'fireflies').slots.lights).toEqual({ id: 'fireflies' });
  });

  it('item patterns follow the explicit list', () => {
    const s = { ...s0, items: [{ id: 'blanket', x: 10, y: 10 }] };
    const g = setItemPattern(manifest, s, 0, 'ditsy');
    expect(g.items[0]).toEqual({ id: 'blanket', x: 10, y: 10, pattern: 'ditsy' });
    expect(setItemPattern(manifest, s, 0, 'plaid')).toBe(s);
    const acc = setItemAccent(manifest, g, 0, '#112233');
    expect(acc.items[0].accent).toBe('#112233');
    expect(setItemAccent(manifest, setItemPattern(manifest, acc, 0, 'plain'), 0, null).items[0]).toEqual({ id: 'blanket', x: 10, y: 10 });
  });
});

describe('room shape for analytics', () => {
  it('finds the lights lit in their colour', () => {
    expect([...lightSlotsOf(manifest)]).toEqual(['lights']);
  });

  it('counts patterned parts, picked accents, cycling lights and particle parts', () => {
    const s0 = defaultRoomState('forest');
    // The sky's dusk rain and the default fireflies.
    expect(roomShapeOf(manifest, s0)).toEqual({ patterned: 0, accents: 0, cycling: 0, particles: 2, lastPattern: null, customColors: 0 });
    let s = setSlotAccent(manifest, setSlotPattern(manifest, s0, 'bed', 'gingham'), 'bed', '#112233');
    s = setSlotCycle(manifest, setSlotComponent(manifest, s, 'lights', 'string'), 'lights', true);
    s = { ...s, items: [{ id: 'blanket', x: 1, y: 1, pattern: 'ditsy' }] };
    expect(roomShapeOf(manifest, s, 'gingham')).toEqual({ patterned: 2, accents: 1, cycling: 1, particles: 1, lastPattern: 'gingham', customColors: 0 });
    expect(roomShapeOf(manifest, setSlotComponent(manifest, s0, 'lights', null)).particles).toBe(1);
  });
});
