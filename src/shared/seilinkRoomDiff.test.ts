import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultRoomState, type RoomPresetManifest, type RoomState } from './seilinkRoom';
import { parseRoomManifest, sanitizeRoomState } from './seilinkValidate';
import { roomChangeBucket, roomChangeLine, roomChanges, withArticle } from './seilinkRoomDiff';

function pack(id: string): RoomPresetManifest {
  const raw = JSON.parse(readFileSync(path.join(__dirname, '../../resources/seilink-packs', id, 'manifest.json'), 'utf8'));
  const m = parseRoomManifest(raw);
  if (!m) throw new Error(`bad manifest ${id}`);
  return m;
}

const cozy = pack('cozy');
const forest = pack('forest');

/** A cozy room as the store keeps it (sanitized), with a cushion and a succulent. */
function room(edit: (s: RoomState) => void = () => {}): RoomState {
  const s = defaultRoomState('cozy');
  s.items = [
    { id: 'cushion', x: 1500, y: 1300 },
    { id: 'monstera', x: 600, y: 1320 },
  ];
  edit(s);
  return sanitizeRoomState(cozy, JSON.parse(JSON.stringify(s)));
}

const diff = (a: RoomState, b: RoomState) => roomChanges(cozy, a, cozy, b);

describe('roomChanges (261105, T335)', () => {
  it('no change for the same room, and for an undo back to the start', () => {
    expect(diff(room(), room())).toEqual([]);
    // A slot saved with its default tint, an item re-saved where it was: what she sees is the same.
    const tinted = room((s) => {
      s.slots.curtains = { id: 'linen_curtains', tint: '#ECE6DA' };
    });
    expect(diff(room(), tinted)).toEqual([]);
  });

  it('names a move with its direction', () => {
    const a = room();
    const b = room((s) => {
      s.items[1].x = 300;
    });
    const ch = diff(a, b);
    expect(ch.map((c) => c.kind)).toEqual(['move']);
    expect(ch[0].text).toBe('moved the potted monstera plant to the left');
  });

  it('a slip of the mouse is not a move', () => {
    const b = room((s) => {
      s.items[1].x += 3;
    });
    expect(diff(room(), b)).toEqual([]);
  });

  it('names a recolour with the colour words look() uses', () => {
    const b = room((s) => {
      s.slots.curtains = { id: 'linen_curtains', tint: '#d04060' };
    });
    expect(diff(room(), b)).toEqual([{ kind: 'recolour', text: 'changed the curtains from white to red' }]);
  });

  it('names patterns put on, changed and taken off', () => {
    const striped = room((s) => {
      s.slots.bed = { id: 'wooden_bed', pattern: 'wide_stripe' };
    });
    const dotted = room((s) => {
      s.slots.bed = { id: 'wooden_bed', pattern: 'polka' };
    });
    expect(diff(room(), striped)).toEqual([{ kind: 'pattern', text: 'gave the bed a striped pattern' }]);
    expect(diff(striped, dotted)).toEqual([{ kind: 'pattern', text: 'changed the pattern on the bed to polka-dot' }]);
    expect(diff(striped, room())).toEqual([{ kind: 'pattern', text: 'took the pattern off the bed' }]);
  });

  it('names items added and taken away, and room parts removed or swapped', () => {
    const b = room((s) => {
      s.items.push({ id: 'books', x: 1200, y: 1300 });
      s.items = s.items.filter((i) => i.id !== 'monstera');
      s.slots.rug = { id: null };
      s.slots.view = { id: 'view_sea' };
    });
    const texts = diff(room(), b).map((c) => c.text);
    expect(texts).toContain('took away the round rug');
    expect(texts).toContain('changed the view outside to a seaside town');
    expect(texts).toContain('added a stack of books');
    expect(texts).toContain('took away the potted monstera plant');
    // Room parts first, the bigger changes before the smaller.
    expect(diff(room(), b)[0].kind).toBe('remove_part');
  });

  it('a new preset is one change, named by its place', () => {
    const f = sanitizeRoomState(forest, defaultRoomState('forest'));
    expect(roomChanges(cozy, room(), forest, f)).toEqual([{ kind: 'preset', text: 'moved you to a campfire in the forest' }]);
  });

  it('caps the line at five, biggest first, and folds repeats', () => {
    const b = room((s) => {
      s.slots.rug = { id: null };
      s.slots.curtains = { id: 'linen_curtains', tint: '#3050d0' };
      s.slots.bed = { id: 'wooden_bed', pattern: 'gingham' };
      s.time = 'night';
      s.items[0].x = 1900;
      s.items[1].flip = true;
      s.items.push({ id: 'succulent', x: 1000, y: 1310 }, { id: 'succulent', x: 1100, y: 1310 });
    });
    const ch = diff(room(), b);
    expect(ch.length).toBe(8);
    expect(roomChangeLine(ch)).toBe(
      'took away the round rug; added a little succulent, twice; changed the curtains from white to blue; gave the bed a gingham pattern; moved the floor cushion to the right; and 2 smaller changes',
    );
    expect(roomChangeBucket(ch.length)).toBe('6-10');
    expect([0, 1, 2, 3, 5, 6, 11].map(roomChangeBucket)).toEqual(['0', '1', '2', '3-5', '3-5', '6-10', '11+']);
  });

  it('picks an article that reads naturally', () => {
    expect(withArticle('stack of books')).toBe('a stack of books');
    expect(withArticle('little mushrooms')).toBe('some little mushrooms');
    expect(withArticle('hiking backpack')).toBe('a hiking backpack');
    expect(withArticle('old lamp')).toBe('an old lamp');
    expect(withArticle('headset on a stand')).toBe('a headset on a stand');
  });
});
