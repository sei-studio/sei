import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultRoomState, plainRoomState, type RoomPresetManifest, type RoomState } from './seilinkRoom';
import { parseRoomManifest, sanitizeRoomState } from './seilinkValidate';
import { addItem, commitEdit, createHistory, moveItem, setSlotTint, slotChoice, swatchesFor, undo } from './seilinkEdit';
import {
  applyRoomOps,
  colourWord,
  DECORATE_MAX_CHANGES,
  decorateCatalog,
  decorateResultText,
  decorateTool,
  isRoomEditOp,
  opTargets,
  paletteWords,
  resolveChange,
  resolveDecorate,
  roomNowLine,
} from './seilinkDecorate';

function pack(id: string): RoomPresetManifest {
  const raw = JSON.parse(readFileSync(path.join(__dirname, '../../resources/seilink-packs', id, 'manifest.json'), 'utf8'));
  const m = parseRoomManifest(raw);
  if (!m) throw new Error(`bad manifest ${id}`);
  return m;
}

const cozy = pack('cozy');
const gamer = pack('gamer');
const forest = pack('forest');

function room(m: RoomPresetManifest = cozy, edit: (s: RoomState) => void = () => {}): RoomState {
  const s = defaultRoomState(m.id);
  edit(s);
  return sanitizeRoomState(m, JSON.parse(JSON.stringify(s)));
}

const comp = (m: RoomPresetManifest, id: string) => m.components.find((c) => c.id === id)!;

describe('colour words', () => {
  it('names plain colours', () => {
    expect(colourWord('#2f3a5e')).toBe('navy');
    expect(colourWord('#a7b591')).toBe('sage');
  });
  it('gives every swatch of a row its own word', () => {
    for (const m of [cozy, gamer, forest]) {
      for (const c of m.components.filter((x) => x.tintable)) {
        const words = paletteWords(swatchesFor(c)).map((w) => w.word);
        expect(new Set(words).size).toBe(words.length);
      }
    }
  });
});

describe('resolveChange refuses what the pack does not have', () => {
  const s = room();
  it('an item that does not exist', () => {
    expect(resolveChange(cozy, s, { do: 'add', target: 'grand piano' })).toMatch(/not something this room has/);
  });
  it('a colour outside the part palette, naming the real ones', () => {
    const r = resolveChange(cozy, s, { do: 'color', target: 'curtains', value: 'neon green' });
    expect(typeof r).toBe('string');
    expect(r).toMatch(/its colours are .*navy/);
  });
  it('a hex that is not one of the swatches', () => {
    expect(typeof resolveChange(cozy, s, { do: 'color', target: 'curtains', value: '#123456' })).toBe('string');
  });
  it('a pattern the part does not take', () => {
    expect(resolveChange(cozy, s, { do: 'pattern', target: 'rug', value: 'leopard' })).toMatch(/it can be plain or/);
  });
  it('a part this pack has no slot for', () => {
    expect(typeof resolveChange(forest, room(forest), { do: 'color', target: 'walls', value: 'white' })).toBe('string');
  });
  it('a placement other than left, right or middle', () => {
    const withPlant = room(cozy, (x) => void (x.items = [{ id: 'monstera', x: 600, y: 1320 }]));
    expect(resolveChange(cozy, withPlant, { do: 'move', target: 'monstera', value: 'on the ceiling' })).toMatch(/left, right or middle/);
  });
  it('moving a room part (only items move)', () => {
    expect(resolveChange(cozy, s, { do: 'move', target: 'bed', value: 'left' })).toMatch(/only items can be moved/);
  });
  it('removing a part that cannot be left out', () => {
    const r = resolveChange(cozy, s, { do: 'remove', target: 'walls' });
    expect(r).toMatch(/cannot be taken out/);
  });
  it('an unknown verb', () => {
    expect(resolveChange(cozy, s, { do: 'paint_everything' })).toMatch(/not a change you can make/);
  });
  it('a time that is not one of the four', () => {
    expect(resolveChange(cozy, s, { do: 'time', value: 'noon on mars' })).toMatch(/auto, day, dusk or night/);
  });
});

describe('resolveChange accepts real parts', () => {
  const s = room();
  it('a palette colour by word', () => {
    const navy = paletteWords(swatchesFor(comp(cozy, slotChoice(cozy, s, 'curtains')!))).find((w) => w.word === 'navy')!.hex;
    expect(resolveChange(cozy, s, { do: 'color', target: 'the curtains', value: 'navy' })).toEqual({ op: 'slot_tint', slot: 'curtains', tint: navy });
  });
  it('an item by part of its name, with a side', () => {
    expect(resolveChange(cozy, s, { do: 'add', target: 'monstera', value: 'on the left' })).toEqual({ op: 'add', id: 'monstera', side: 'left' });
  });
  it('a view option by name', () => {
    const r = resolveChange(cozy, s, { do: 'swap', target: 'view', value: 'seaside town' });
    expect(r).toMatchObject({ op: 'swap', slot: 'view' });
  });
  it('taking out an optional part', () => {
    expect(resolveChange(cozy, s, { do: 'remove', target: 'curtains' })).toEqual({ op: 'swap', slot: 'curtains', id: null });
  });
});

describe('resolveDecorate', () => {
  it(`stops at ${DECORATE_MAX_CHANGES} changes`, () => {
    const changes = [
      { do: 'add', target: 'monstera' },
      { do: 'add', target: 'floor cushion' },
      { do: 'add', target: 'stack of books' },
      { do: 'add', target: 'succulent' },
      { do: 'time', value: 'night' },
      { do: 'color', target: 'bed', value: 'navy' },
      { do: 'color', target: 'rug', value: 'mustard' },
    ];
    const r = resolveDecorate(cozy, room(), { changes });
    expect(r.ops).toHaveLength(DECORATE_MAX_CHANGES);
    expect(r.rejected.join(' ')).toMatch(/only 5 changes/);
  });
  it('applies changes in order, a later one seeing the earlier', () => {
    const r = resolveDecorate(cozy, room(), {
      changes: [
        { do: 'add', target: 'floor cushion' },
        { do: 'color', target: 'floor cushion', value: 'plum' },
      ],
    });
    expect(r.ops.map((o) => o.op)).toEqual(['add', 'item_tint']);
    expect(r.state.items.at(-1)).toMatchObject({ id: 'cushion' });
    expect(r.done.length).toBeGreaterThan(0);
  });
  it('refuses a change that is already so', () => {
    const s = room();
    const def = swatchesFor(comp(cozy, slotChoice(cozy, s, 'bed')!))[0];
    const r = resolveDecorate(cozy, setSlotTint(cozy, s, 'bed', def), { changes: [{ do: 'color', target: 'bed', value: def }] });
    expect(r.ops).toEqual([]);
    expect(r.rejected[0]).toMatch(/already/);
  });
  it('suggest resolves the same ops without changing the mode default', () => {
    const r = resolveDecorate(cozy, room(), { mode: 'suggest', changes: [{ do: 'time', value: 'dusk' }] });
    expect(r.mode).toBe('suggest');
    expect(r.ops).toEqual([{ op: 'time', time: 'dusk' }]);
    expect(decorateResultText(r)).toMatch(/Nothing has changed yet/);
  });
  it('ignores junk input', () => {
    const r = resolveDecorate(cozy, room(), { changes: 'make it cozy' });
    expect(r.ops).toEqual([]);
    expect(r.rejected).toEqual(['no changes were given']);
  });
});

describe('ops are the editor ops', () => {
  it('add with a side lands where moveItem would put it', () => {
    const s = room();
    const { state: added, index } = addItem(cozy, s, 'monstera');
    const byHand = moveItem(cozy, added, index, Math.round(cozy.canvas[0] * 0.22), added.items[index].y);
    expect(applyRoomOps(cozy, s, [{ op: 'add', id: 'monstera', side: 'left' }]).state).toEqual(byHand);
  });
  it('an item op whose item moved away is skipped, not misapplied', () => {
    const s = room(cozy, (x) => void (x.items = [{ id: 'cushion', x: 1500, y: 1300 }]));
    const r = applyRoomOps(cozy, s, [{ op: 'remove', index: 0, id: 'monstera' }]);
    expect(r.applied).toEqual([]);
    expect(r.state).toBe(s);
  });
  it('her whole request is ONE undo step', () => {
    const s = room();
    let h = createHistory(s);
    h = commitEdit(h, setSlotTint(cozy, s, 'bed', swatchesFor(comp(cozy, slotChoice(cozy, s, 'bed')!))[3]), null);
    const mine = h.present;
    const r = resolveDecorate(cozy, mine, {
      changes: [
        { do: 'add', target: 'monstera', value: 'right' },
        { do: 'time', value: 'night' },
        { do: 'color', target: 'rug', value: 'mustard' },
      ],
    });
    const applied = applyRoomOps(cozy, mine, r.ops).state;
    expect(applied).toEqual(r.state);
    h = commitEdit(h, applied, null);
    h = undo(h);
    expect(h.present).toEqual(mine);
  });
  it('opTargets names the changed items and slots', () => {
    const s = room(cozy, (x) => void (x.items = [{ id: 'cushion', x: 1500, y: 1300 }]));
    const r = resolveDecorate(cozy, s, {
      changes: [
        { do: 'add', target: 'monstera' },
        { do: 'color', target: 'curtains', value: 'navy' },
      ],
    });
    expect(opTargets(cozy, s, r.ops)).toEqual({ items: [1], slots: ['curtains'] });
  });
  it('isRoomEditOp rejects malformed ops', () => {
    expect(isRoomEditOp({ op: 'add', id: 'monstera' })).toBe(true);
    expect(isRoomEditOp({ op: 'slot_tint', slot: 'bed', tint: 'red' })).toBe(false);
    expect(isRoomEditOp({ op: 'move', index: -1, id: 'x', side: 'left' })).toBe(false);
    expect(isRoomEditOp({ op: 'rm -rf' })).toBe(false);
  });
});

describe('tool text', () => {
  it('the catalog is small and has no room state in it', () => {
    for (const m of [cozy, gamer, forest]) {
      const t = decorateCatalog(m);
      expect(t.length).toBeLessThan(1600);
      expect(t).not.toMatch(/—|friend/);
    }
  });
  it('the schema caps the change list', () => {
    const t = decorateTool(cozy);
    expect(t.name).toBe('decorate');
    expect((t.input_schema.properties as { changes: { maxItems: number } }).changes.maxItems).toBe(DECORATE_MAX_CHANGES);
    expect(t.description).not.toMatch(/—|friend/);
  });
});

describe('the plain first state (261106, first-link v3)', () => {
  it('her first change sets the bare room up, so it shows', () => {
    const plain = sanitizeRoomState(cozy, JSON.parse(JSON.stringify(plainRoomState(cozy))));
    expect(plain.plain).toBe(true);
    const r = resolveDecorate(cozy, plain, { changes: [{ do: 'add', target: 'floor cushion' }] });
    expect(r.ops.length).toBe(1);
    expect(r.state.plain).toBeUndefined();
    expect(r.state.items.at(-1)).toMatchObject({ id: 'cushion' });
    expect(r.done.length).toBeGreaterThan(0);
    // The ops replay the same way in the editor and the store.
    expect(applyRoomOps(cozy, plain, r.ops).state).toEqual(r.state);
  });
  it('a refused change keeps her plain', () => {
    const plain = plainRoomState(cozy);
    const r = resolveDecorate(cozy, plain, { changes: [{ do: 'add', target: 'spaceship' }] });
    expect(r.ops).toEqual([]);
    expect(r.state).toBe(plain);
  });
  it('a change that does nothing keeps her plain', () => {
    const plain = plainRoomState(cozy);
    expect(applyRoomOps(cozy, plain, []).state.plain).toBe(true);
  });
  it('says there is no room yet', () => {
    expect(roomNowLine(cozy, plainRoomState(cozy))).toMatch(/no room yet/);
    expect(roomNowLine(cozy, room())).not.toMatch(/no room yet/);
  });
});
