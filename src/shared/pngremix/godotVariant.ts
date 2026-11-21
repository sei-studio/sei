/**
 * A safe reader for Godot 4's binary Variant encoding (261122, PNGTuber Remix
 * spike, docs/agents/pngremix-format.md).
 *
 * `FileAccess.store_var(value, true)` writes a u32 byte length and then one
 * Variant: a u32 header (type in the low 8 bits, flags in bits 16 to 19) and
 * its payload, little endian, every field padded to 4 bytes. A `.pngRemix`
 * file is exactly that, holding one Dictionary.
 *
 * This reader never builds anything but plain data. Godot itself, loading
 * with objects allowed, instantiates every encoded Object by class name and
 * loads a `script` property from its path, which is how a hostile save file
 * runs code. Here:
 *  - an Object is walked only to find where it ends. Its class must be on
 *    `allowObjectClass` (PNGTuber Remix stores InputEvent hotkeys and a
 *    CircleShape2D), its properties are read and thrown away, and any
 *    `script` property that is not null rejects the whole file;
 *  - a typed Array or Dictionary whose element type is a script rejects it;
 *  - Callable and Signal reject it (never in a save);
 *  - every count is checked against the bytes left before a loop starts,
 *    depth and the number of values are capped, and nothing is ever read
 *    past the end of the buffer.
 * Math types we do not use (transforms, bases, packed float arrays) come back
 * as an opaque marker without allocating their contents.
 */

export class GodotVariantError extends Error {
  constructor(
    readonly code: GodotVariantErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GodotVariantError';
  }
}

export type GodotVariantErrorCode =
  'truncated' | 'bad_type' | 'too_deep' | 'too_many_values' | 'too_large' | 'object_class' | 'script' | 'unsupported';

export interface GVec2 {
  t: 'v2';
  x: number;
  y: number;
}
export interface GColor {
  t: 'color';
  r: number;
  g: number;
  b: number;
  a: number;
}
/** An Object we walked past. Only the class name is kept. */
export interface GObjectRef {
  t: 'object';
  cls: string;
}
/** A value of a type we never read (a transform, a packed float array, a NodePath...). */
export interface GOpaque {
  t: 'opaque';
  type: number;
}
export type GDict = Map<string, GValue>;
export type GValue = null | boolean | number | string | GVec2 | GColor | GObjectRef | GOpaque | Uint8Array | GValue[] | GDict;

export interface DecodeOptions {
  /** Deepest nesting allowed (containers and object properties). */
  maxDepth?: number;
  /** Most values decoded in total (every key, element and property counts). */
  maxValues?: number;
  /** Longest string, in bytes. */
  maxStringBytes?: number;
  /** Object classes we may walk past. Anything else rejects the input. */
  allowObjectClass?: (cls: string) => boolean;
}

export const T = {
  NIL: 0,
  BOOL: 1,
  INT: 2,
  FLOAT: 3,
  STRING: 4,
  VECTOR2: 5,
  VECTOR2I: 6,
  RECT2: 7,
  RECT2I: 8,
  VECTOR3: 9,
  VECTOR3I: 10,
  TRANSFORM2D: 11,
  VECTOR4: 12,
  VECTOR4I: 13,
  PLANE: 14,
  QUATERNION: 15,
  AABB: 16,
  BASIS: 17,
  TRANSFORM3D: 18,
  PROJECTION: 19,
  COLOR: 20,
  STRING_NAME: 21,
  NODE_PATH: 22,
  RID: 23,
  OBJECT: 24,
  CALLABLE: 25,
  SIGNAL: 26,
  DICTIONARY: 27,
  ARRAY: 28,
  PACKED_BYTE_ARRAY: 29,
  PACKED_INT32_ARRAY: 30,
  PACKED_INT64_ARRAY: 31,
  PACKED_FLOAT32_ARRAY: 32,
  PACKED_FLOAT64_ARRAY: 33,
  PACKED_STRING_ARRAY: 34,
  PACKED_VECTOR2_ARRAY: 35,
  PACKED_VECTOR3_ARRAY: 36,
  PACKED_COLOR_ARRAY: 37,
  PACKED_VECTOR4_ARRAY: 38,
} as const;
const VARIANT_MAX = 39;

const FLAG_64 = 1 << 16;
/** Typed Array element kind (bits 16-17); a typed Dictionary's key (16-17) and value (18-19). */
const KIND_NONE = 0;
const KIND_BUILTIN = 1;
const KIND_CLASS_NAME = 2;
const KIND_SCRIPT = 3;

/** Float components per math type (each 4 bytes, or 8 with FLAG_64). */
const REAL_COUNT: Partial<Record<number, number>> = {
  [T.VECTOR2]: 2,
  [T.RECT2]: 4,
  [T.VECTOR3]: 3,
  [T.TRANSFORM2D]: 6,
  [T.VECTOR4]: 4,
  [T.PLANE]: 4,
  [T.QUATERNION]: 4,
  [T.AABB]: 6,
  [T.BASIS]: 9,
  [T.TRANSFORM3D]: 12,
  [T.PROJECTION]: 16,
};
/** i32 components per integer math type. */
const INT_COUNT: Partial<Record<number, number>> = {
  [T.VECTOR2I]: 2,
  [T.RECT2I]: 4,
  [T.VECTOR3I]: 3,
  [T.VECTOR4I]: 4,
};

/** InputEvent hotkeys and the throwable's collision shape: what PNGTuber Remix saves. */
export function defaultAllowObjectClass(cls: string): boolean {
  return /^InputEvent[A-Za-z]*$/.test(cls) || /^[A-Za-z]*Shape2D$/.test(cls);
}

class Reader {
  pos = 0;
  values = 0;
  private readonly view: DataView;
  private readonly utf8 = new TextDecoder('utf-8');
  constructor(
    readonly buf: Uint8Array,
    private readonly end: number,
    private readonly opts: Required<DecodeOptions>,
  ) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  need(n: number): void {
    if (n < 0 || this.pos + n > this.end) throw new GodotVariantError('truncated', 'unexpected end of data');
  }
  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  i32(): number {
    this.need(4);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }
  i64(): number {
    this.need(8);
    const v = this.view.getBigInt64(this.pos, true);
    this.pos += 8;
    return Number(v);
  }
  f32(): number {
    this.need(4);
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }
  f64(): number {
    this.need(8);
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }
  skip(n: number): void {
    this.need(n);
    this.pos += n;
  }
  /** A count that must leave at least `minEach` bytes per element. */
  count(minEach: number): number {
    const n = this.u32() & 0x7fffffff;
    if (minEach > 0 && n * minEach > this.end - this.pos) throw new GodotVariantError('truncated', 'count runs past the end');
    return n;
  }
  string(): string {
    const len = this.u32();
    if (len > this.opts.maxStringBytes) throw new GodotVariantError('too_large', 'string too long');
    const pad = (4 - (len % 4)) % 4;
    this.need(len + pad);
    const s = this.utf8.decode(this.buf.subarray(this.pos, this.pos + len));
    this.pos += len + pad;
    return s;
  }
  tick(): void {
    if (++this.values > this.opts.maxValues) throw new GodotVariantError('too_many_values', 'too many values');
  }

  /** A typed container's element type. A script type rejects the input. */
  containerType(kind: number): void {
    if (kind === KIND_NONE) return;
    if (kind === KIND_BUILTIN) {
      const bt = this.u32();
      if (bt >= VARIANT_MAX) throw new GodotVariantError('bad_type', 'bad container element type');
      return;
    }
    if (kind === KIND_CLASS_NAME) {
      this.string();
      return;
    }
    if (kind === KIND_SCRIPT) throw new GodotVariantError('script', 'container typed by a script');
  }

  variant(depth: number): GValue {
    if (depth > this.opts.maxDepth) throw new GodotVariantError('too_deep', 'nested too deep');
    this.tick();
    const header = this.u32();
    const type = header & 0xff;
    const wide = (header & FLAG_64) !== 0;
    switch (type) {
      case T.NIL:
        return null;
      case T.BOOL:
        return this.u32() !== 0;
      case T.INT:
        return wide ? this.i64() : this.i32();
      case T.FLOAT:
        return wide ? this.f64() : this.f32();
      case T.STRING:
      case T.STRING_NAME:
        return this.string();
      case T.VECTOR2: {
        const x = wide ? this.f64() : this.f32();
        const y = wide ? this.f64() : this.f32();
        return { t: 'v2', x, y };
      }
      case T.COLOR:
        return {
          t: 'color',
          r: this.f32(),
          g: this.f32(),
          b: this.f32(),
          a: this.f32(),
        };
      case T.NODE_PATH: {
        const first = this.u32();
        if ((first & 0x80000000) === 0) throw new GodotVariantError('unsupported', 'old NodePath format');
        const names = first & 0x7fffffff;
        let subnames = this.u32();
        const flags = this.u32();
        if (flags & 2) subnames++;
        const total = names + subnames;
        if (total * 4 > this.end - this.pos) throw new GodotVariantError('truncated', 'count runs past the end');
        for (let i = 0; i < total; i++) this.string();
        return { t: 'opaque', type };
      }
      case T.RID:
        this.skip(8);
        return { t: 'opaque', type };
      case T.OBJECT:
        return this.object(header, depth);
      case T.CALLABLE:
      case T.SIGNAL:
        throw new GodotVariantError('unsupported', 'callable or signal');
      case T.DICTIONARY: {
        this.containerType((header >>> 16) & 3);
        this.containerType((header >>> 18) & 3);
        const n = this.count(8);
        const out: GDict = new Map();
        for (let i = 0; i < n; i++) {
          const k = this.variant(depth + 1);
          const v = this.variant(depth + 1);
          if (typeof k === 'string') out.set(k, v);
          else if (typeof k === 'number' && Number.isFinite(k)) out.set(String(k), v);
          // Any other key type is never one we read: dropped.
        }
        return out;
      }
      case T.ARRAY: {
        this.containerType((header >>> 16) & 3);
        const n = this.count(4);
        const out: GValue[] = [];
        for (let i = 0; i < n; i++) out.push(this.variant(depth + 1));
        return out;
      }
      case T.PACKED_BYTE_ARRAY: {
        const n = this.count(1);
        const pad = (4 - (n % 4)) % 4;
        this.need(n + pad);
        const bytes = this.buf.subarray(this.pos, this.pos + n);
        this.pos += n + pad;
        return bytes;
      }
      case T.PACKED_INT32_ARRAY:
      case T.PACKED_FLOAT32_ARRAY:
        this.skip(this.count(4) * 4);
        return { t: 'opaque', type };
      case T.PACKED_INT64_ARRAY:
      case T.PACKED_FLOAT64_ARRAY:
        this.skip(this.count(8) * 8);
        return { t: 'opaque', type };
      case T.PACKED_STRING_ARRAY: {
        const n = this.count(4);
        for (let i = 0; i < n; i++) this.string();
        return { t: 'opaque', type };
      }
      case T.PACKED_VECTOR2_ARRAY:
        this.skip(this.count(8) * (wide ? 16 : 8));
        return { t: 'opaque', type };
      case T.PACKED_VECTOR3_ARRAY:
        this.skip(this.count(12) * (wide ? 24 : 12));
        return { t: 'opaque', type };
      case T.PACKED_COLOR_ARRAY:
        this.skip(this.count(16) * 16);
        return { t: 'opaque', type };
      case T.PACKED_VECTOR4_ARRAY:
        this.skip(this.count(16) * (wide ? 32 : 16));
        return { t: 'opaque', type };
      default: {
        const reals = REAL_COUNT[type];
        if (reals !== undefined) {
          this.skip(reals * (wide ? 8 : 4));
          return { t: 'opaque', type };
        }
        const ints = INT_COUNT[type];
        if (ints !== undefined) {
          this.skip(ints * 4);
          return { t: 'opaque', type };
        }
        throw new GodotVariantError('bad_type', `unknown variant type ${type}`);
      }
    }
  }

  /** Walk past one Object: never built, only checked and skipped. */
  object(header: number, depth: number): GValue {
    if (header & FLAG_64) {
      // Encoded as an instance id only.
      this.skip(8);
      return { t: 'opaque', type: T.OBJECT };
    }
    const cls = this.string();
    if (cls === '') return null;
    if (!this.opts.allowObjectClass(cls)) throw new GodotVariantError('object_class', 'object of a class we do not read');
    const n = this.count(8);
    for (let i = 0; i < n; i++) {
      const name = this.string();
      const value = this.variant(depth + 1);
      if (name === 'script' && value !== null) throw new GodotVariantError('script', 'object carries a script');
    }
    return { t: 'object', cls };
  }
}

/**
 * Decode one Variant from `buf` (no length prefix). Throws GodotVariantError
 * on anything malformed or unsafe. Byte arrays in the result are views into
 * `buf`: copy them before `buf` goes away.
 */
export function decodeVariant(buf: Uint8Array, opts: DecodeOptions = {}): { value: GValue; used: number } {
  const r = new Reader(buf, buf.byteLength, {
    maxDepth: opts.maxDepth ?? 64,
    maxValues: opts.maxValues ?? 2_000_000,
    maxStringBytes: opts.maxStringBytes ?? 1 << 20,
    allowObjectClass: opts.allowObjectClass ?? defaultAllowObjectClass,
  });
  const value = r.variant(0);
  return { value, used: r.pos };
}

/**
 * Decode what `FileAccess.store_var` wrote: a u32 length, then exactly that
 * many bytes of one Variant.
 */
export function decodeStoredVar(buf: Uint8Array, opts: DecodeOptions = {}): GValue {
  if (buf.byteLength < 8) throw new GodotVariantError('truncated', 'file too short');
  const len = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0, true);
  if (len + 4 > buf.byteLength) throw new GodotVariantError('truncated', 'stored length runs past the end');
  const { value, used } = decodeVariant(buf.subarray(4, 4 + len), opts);
  if (used !== len) throw new GodotVariantError('bad_type', 'stored length does not match the value');
  return value;
}

// ── Small typed accessors for the model reader ──────────────────────────────

export function isDict(v: GValue | undefined): v is GDict {
  return v instanceof Map;
}
export function num(v: GValue | undefined, dflt: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return dflt;
}
export function bool(v: GValue | undefined, dflt: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  return dflt;
}
export function str(v: GValue | undefined, dflt: string): string {
  return typeof v === 'string' ? v : dflt;
}
export function vec2(v: GValue | undefined, dflt: [number, number]): [number, number] {
  if (
    v &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    !(v instanceof Map) &&
    !(v instanceof Uint8Array) &&
    v.t === 'v2' &&
    Number.isFinite(v.x) &&
    Number.isFinite(v.y)
  )
    return [v.x, v.y];
  return dflt;
}
export function color(v: GValue | undefined, dflt: [number, number, number, number]): [number, number, number, number] {
  if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Map) && !(v instanceof Uint8Array) && v.t === 'color') {
    const c = [v.r, v.g, v.b, v.a];
    if (c.every(Number.isFinite)) return c as [number, number, number, number];
  }
  return dflt;
}
