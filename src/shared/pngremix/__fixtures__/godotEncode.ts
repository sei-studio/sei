/**
 * Test-only Godot 4 Variant encoder (the `store_var` layout godotVariant.ts
 * reads), used to build synthetic `.pngRemix` files. Real sample models are
 * never checked in (their licenses bar redistribution), so every fixture is
 * made here.
 *
 * Value mapping: null, boolean, integer number (INT), non-integer number or
 * `f(x)` (64-bit FLOAT), string, Uint8Array (PACKED_BYTE_ARRAY), array
 * (ARRAY), plain object or Map (DICTIONARY), plus the tagged helpers below.
 */
import { T } from '../godotVariant';

export type Enc =
  | null
  | boolean
  | number
  | string
  | Uint8Array
  | Enc[]
  | Map<string, Enc>
  | { [k: string]: Enc }
  | Tagged;

type Tagged =
  | { $tag: 'float'; v: number }
  | { $tag: 'v2'; x: number; y: number }
  | { $tag: 'color'; r: number; g: number; b: number; a: number }
  | { $tag: 'object'; cls: string; props: Array<[string, Enc]> }
  | { $tag: 'raw'; bytes: Uint8Array };

export const f = (v: number): Enc => ({ $tag: 'float', v });
export const v2 = (x: number, y: number): Enc => ({ $tag: 'v2', x, y });
export const col = (r: number, g: number, b: number, a = 1): Enc => ({ $tag: 'color', r, g, b, a });
export const obj = (cls: string, props: Array<[string, Enc]>): Enc => ({ $tag: 'object', cls, props });
/** Bytes written as-is where a Variant goes (header included). */
export const raw = (bytes: Uint8Array): Enc => ({ $tag: 'raw', bytes });

class W {
  parts: number[] = [];
  u32(v: number): void {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v >>> 0, true);
    this.parts.push(...b);
  }
  bytes(b: Uint8Array): void {
    for (const x of b) this.parts.push(x);
  }
  pad(n: number): void {
    for (let i = 0; i < (4 - (n % 4)) % 4; i++) this.parts.push(0);
  }
  str(s: string): void {
    const b = new TextEncoder().encode(s);
    this.u32(b.length);
    this.bytes(b);
    this.pad(b.length);
  }
  f32(v: number): void {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, v, true);
    this.bytes(b);
  }
  f64(v: number): void {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, v, true);
    this.bytes(b);
  }
}

function isTagged(v: object): v is Tagged {
  return '$tag' in v;
}

function write(w: W, v: Enc): void {
  if (v === null) return w.u32(T.NIL);
  if (typeof v === 'boolean') {
    w.u32(T.BOOL);
    return w.u32(v ? 1 : 0);
  }
  if (typeof v === 'number') {
    if (Number.isInteger(v) && Math.abs(v) < 2 ** 31) {
      w.u32(T.INT);
      return w.u32(v | 0);
    }
    w.u32(T.FLOAT | (1 << 16));
    return w.f64(v);
  }
  if (typeof v === 'string') {
    w.u32(T.STRING);
    return w.str(v);
  }
  if (v instanceof Uint8Array) {
    w.u32(T.PACKED_BYTE_ARRAY);
    w.u32(v.length);
    w.bytes(v);
    return w.pad(v.length);
  }
  if (Array.isArray(v)) {
    w.u32(T.ARRAY);
    w.u32(v.length);
    for (const x of v) write(w, x);
    return;
  }
  if (!(v instanceof Map) && isTagged(v)) {
    switch (v.$tag) {
      case 'float':
        w.u32(T.FLOAT | (1 << 16));
        return w.f64(v.v);
      case 'v2':
        w.u32(T.VECTOR2);
        w.f32(v.x);
        return w.f32(v.y);
      case 'color':
        w.u32(T.COLOR);
        for (const c of [v.r, v.g, v.b, v.a]) w.f32(c);
        return;
      case 'object':
        w.u32(T.OBJECT);
        w.str(v.cls);
        w.u32(v.props.length);
        for (const [k, x] of v.props) {
          w.str(k);
          write(w, x);
        }
        return;
      case 'raw':
        return w.bytes(v.bytes);
    }
  }
  const entries = v instanceof Map ? [...v.entries()] : Object.entries(v);
  w.u32(T.DICTIONARY);
  w.u32(entries.length);
  for (const [k, x] of entries) {
    w.u32(T.STRING);
    w.str(k);
    write(w, x);
  }
}

/** One Variant, no length prefix. */
export function encodeVariant(v: Enc): Uint8Array {
  const w = new W();
  write(w, v);
  return Uint8Array.from(w.parts);
}

/** What `FileAccess.store_var` writes: u32 length, then the Variant. */
export function encodeStoredVar(v: Enc): Uint8Array {
  const body = encodeVariant(v);
  const out = new Uint8Array(body.length + 4);
  new DataView(out.buffer).setUint32(0, body.length, true);
  out.set(body, 4);
  return out;
}

/** u32 words, little-endian, as bytes (for hand-made malformed input). */
export function words(...ws: number[]): Uint8Array {
  const out = new Uint8Array(ws.length * 4);
  const dv = new DataView(out.buffer);
  ws.forEach((x, i) => dv.setUint32(i * 4, x >>> 0, true));
  return out;
}

/**
 * A PNG header the readers accept (signature, IHDR w x h, optional acTL,
 * IEND; CRCs are zero), tagged with `n` after IEND so images differ.
 */
export function fakePng(w: number, h: number, o: { actl?: boolean } = {}, ...n: number[]): Uint8Array {
  const chunk = (type: string, data: number[]): number[] => {
    const len = [(data.length >>> 24) & 255, (data.length >>> 16) & 255, (data.length >>> 8) & 255, data.length & 255];
    return [...len, ...[...type].map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0];
  };
  const be = (x: number): number[] => [(x >>> 24) & 255, (x >>> 16) & 255, (x >>> 8) & 255, x & 255];
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk('IHDR', [...be(w), ...be(h), 8, 6, 0, 0, 0]),
    ...(o.actl ? chunk('acTL', [0, 0, 0, 2, 0, 0, 0, 0]) : []),
    ...chunk('IEND', []),
    ...n,
  ]);
}

// ── Synthetic Remix saves ───────────────────────────────────────────────────

export interface FakeSprite {
  id: number;
  parent?: number;
  name?: string;
  type?: string;
  /** v14: image id; older: PNG bytes (or base64 string for legacy). */
  image?: number | Uint8Array | string;
  states: Array<Record<string, Enc>>;
  extra?: Record<string, Enc>;
}

/** A 1.4.x save: images in image_manager_data, sprites by image_id. */
export function fakeV14(o: {
  images: Array<{ id: number; png: Uint8Array }>;
  sprites: FakeSprite[];
  states?: Array<Record<string, Enc>>;
  names?: string[];
  settings?: Record<string, Enc>;
}): Uint8Array {
  return encodeStoredVar({
    version: '1.4.3',
    settings_dict: { states: o.states ?? [{}], should_delta: true, ...(o.settings ?? {}) },
    input_array: (o.names ?? []).map((n) => ({ state_name: n })),
    image_manager_data: o.images.map((im) => ({ id: im.id, runtime_texture: im.png })),
    sprites_array: o.sprites.map((s) => ({
      sprite_id: s.id,
      parent_id: s.parent ?? 0,
      sprite_name: s.name ?? `s${s.id}`,
      sprite_type: s.type ?? 'Sprite2D',
      image_id: typeof s.image === 'number' ? s.image : 0,
      states: s.states,
      ...(s.extra ?? {}),
    })),
  });
}

/** A 1.3.x save (img bytes per sprite, `version` set) or, with legacy, the unversioned base64 kind. */
export function fakeOld(o: {
  legacy?: boolean;
  sprites: FakeSprite[];
  states?: Array<Record<string, Enc>>;
  names?: string[];
  settings?: Record<string, Enc>;
}): Uint8Array {
  return encodeStoredVar({
    ...(o.legacy ? {} : { version: '1.3.6' }),
    settings_dict: { states: o.states ?? [{}], ...(o.settings ?? {}) },
    input_array: (o.names ?? []).map((n) => ({ state_name: n })),
    sprites_array: o.sprites.map((s) => ({
      sprite_id: s.id,
      parent_id: s.parent ?? 0,
      sprite_name: s.name ?? `s${s.id}`,
      sprite_type: s.type ?? 'Sprite2D',
      img: typeof s.image === 'number' || s.image === undefined ? null : s.image,
      states: s.states,
      ...(s.extra ?? {}),
    })),
  });
}
