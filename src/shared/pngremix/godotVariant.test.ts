import { describe, it, expect } from 'vitest';
import { decodeStoredVar, decodeVariant, GodotVariantError, T, type GDict } from './godotVariant';
import { col, encodeStoredVar, encodeVariant, f, obj, raw, v2, words } from './__fixtures__/godotEncode';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof GodotVariantError) return err.code;
    throw err;
  }
  return 'ok';
}

const KIND_SCRIPT = 3;

describe('decodeVariant: plain values', () => {
  it('reads the plain types a Remix save uses', () => {
    const png = Uint8Array.from([1, 2, 3, 4, 5]);
    const { value } = decodeVariant(
      encodeVariant({
        n: null,
        b: true,
        i: -7,
        fl: f(1.5),
        s: 'héllo',
        p: v2(3, -4),
        c: col(1, 0.5, 0, 1),
        bytes: png,
        list: [1, 'two', [false]],
        nested: { inner: { deep: 9 } },
      }),
    );
    const d = value as GDict;
    expect(d.get('n')).toBeNull();
    expect(d.get('b')).toBe(true);
    expect(d.get('i')).toBe(-7);
    expect(d.get('fl')).toBe(1.5);
    expect(d.get('s')).toBe('héllo');
    expect(d.get('p')).toEqual({ t: 'v2', x: 3, y: -4 });
    expect(d.get('c')).toEqual({ t: 'color', r: 1, g: 0.5, b: 0, a: 1 });
    expect(Array.from(d.get('bytes') as Uint8Array)).toEqual([1, 2, 3, 4, 5]);
    expect(d.get('list')).toEqual([1, 'two', [false]]);
    expect(((d.get('nested') as GDict).get('inner') as GDict).get('deep')).toBe(9);
  });

  it('skips math types it never reads and keeps going', () => {
    // A Transform2D (6 floats), then a string after it in the same array.
    const transform = words(T.TRANSFORM2D, 0, 0, 0, 0, 0, 0);
    const { value } = decodeVariant(encodeVariant([raw(transform), 'after']));
    expect(value).toEqual([{ t: 'opaque', type: T.TRANSFORM2D }, 'after']);
  });

  it('walks past an allowed object class with no script, without building it', () => {
    const ev = obj('InputEventKey', [
      ['keycode', 65],
      ['script', null],
    ]);
    const { value } = decodeVariant(encodeVariant({ hotkey: ev }));
    expect((value as GDict).get('hotkey')).toEqual({ t: 'object', cls: 'InputEventKey' });
  });

  it('decodeStoredVar checks the stored length against the value', () => {
    const good = encodeStoredVar({ a: 1 });
    expect((decodeStoredVar(good) as GDict).get('a')).toBe(1);
    const longer = new Uint8Array(good.length + 4);
    longer.set(good);
    new DataView(longer.buffer).setUint32(0, good.length, true); // claims 4 more bytes than the value uses
    expect(codeOf(() => decodeStoredVar(longer))).toBe('bad_type');
    const short = good.slice(0, good.length - 4);
    expect(codeOf(() => decodeStoredVar(short))).toBe('truncated');
  });
});

describe('decodeVariant: unsafe input is rejected', () => {
  it('an object that carries a script', () => {
    const bad = obj('InputEventKey', [['script', obj('InputEventKey', [])]]);
    expect(codeOf(() => decodeVariant(encodeVariant({ x: bad })))).toBe('script');
  });

  it('an object of a class outside the allow-list', () => {
    for (const cls of ['GDScript', 'Node2D', 'Resource', 'PackedScene']) {
      expect(codeOf(() => decodeVariant(encodeVariant([obj(cls, [])])))).toBe('object_class');
    }
  });

  it('a typed array or dictionary whose element type is a script', () => {
    expect(codeOf(() => decodeVariant(words(T.ARRAY | (KIND_SCRIPT << 16), 0)))).toBe('script');
    expect(codeOf(() => decodeVariant(words(T.DICTIONARY | (KIND_SCRIPT << 18), 0)))).toBe('script');
  });

  it('Callable and Signal', () => {
    expect(codeOf(() => decodeVariant(words(T.CALLABLE)))).toBe('unsupported');
    expect(codeOf(() => decodeVariant(words(T.SIGNAL)))).toBe('unsupported');
  });

  it('unknown type tags', () => {
    expect(codeOf(() => decodeVariant(words(99)))).toBe('bad_type');
  });
});

describe('decodeVariant: malformed input fails cleanly', () => {
  it('truncated values', () => {
    const full = encodeVariant({ name: 'a long enough string' });
    for (let cut = 0; cut < full.length; cut += 3) {
      expect(codeOf(() => decodeVariant(full.subarray(0, cut)))).toBe('truncated');
    }
  });

  it('a huge count is refused before any loop or allocation', () => {
    expect(codeOf(() => decodeVariant(words(T.ARRAY, 0x7fffffff)))).toBe('truncated');
    expect(codeOf(() => decodeVariant(words(T.DICTIONARY, 0x7fffffff)))).toBe('truncated');
    expect(codeOf(() => decodeVariant(words(T.PACKED_BYTE_ARRAY, 0x7fffffff)))).toBe('truncated');
    expect(codeOf(() => decodeVariant(words(T.PACKED_FLOAT32_ARRAY, 0x40000000)))).toBe('truncated');
    expect(codeOf(() => decodeVariant(words(T.STRING, 0xfffffff0)))).toBe('too_large');
  });

  it('nesting and value-count caps', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 80; i++) deep = [deep];
    expect(codeOf(() => decodeVariant(encodeVariant(deep as never)))).toBe('too_deep');
    const many = encodeVariant(Array.from({ length: 50 }, (_, i) => i));
    expect(codeOf(() => decodeVariant(many, { maxValues: 20 }))).toBe('too_many_values');
  });
});
