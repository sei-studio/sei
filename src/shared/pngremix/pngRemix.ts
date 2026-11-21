/**
 * PNGTuber Remix model reader (261122 spike, docs/agents/pngremix-format.md).
 *
 * Turns a `.pngRemix` save file into Sei's own plain JSON spec plus a list
 * of PNG images. Only plain values and PNG bytes are read: the file is
 * decoded by godotVariant.ts, which never builds an object or loads a script.
 * What a model needs to look right in the room survives (the layer tree with
 * its per-state transforms, blink and talk switches, the wobble and bounce
 * settings, state names); everything else (hotkeys, mouse and controller
 * follow, meshes, shaders, lights, effects) is dropped here.
 *
 * Three save generations are understood:
 *  - 1.4.x ("v14"): images live once in `image_manager_data`, layers refer to
 *    them by id;
 *  - 1.3.x / early 1.4 ("v13"): each layer carries its own PNG bytes and a
 *    `global_position` per state;
 *  - unversioned PNGTuber Plus era ("legacy"): the same, with base64 images
 *    and the bounce settings at the top of settings_dict.
 *
 * Pure TypeScript with no Node or DOM imports beyond atob, so the main
 * process (import) and the renderer's dev harness share it.
 */
import { bool, color, decodeStoredVar, GodotVariantError, isDict, num, str, vec2, type GDict, type GValue } from './godotVariant';

// ── Limits ──────────────────────────────────────────────────────────────────

/** Biggest file we read (the avatar zip cap). */
export const PNGREMIX_MAX_BYTES = 64 * 1024 * 1024;
export const PNGREMIX_MAX_LAYERS = 512;
export const PNGREMIX_MAX_STATES = 64;
export const PNGREMIX_MAX_IMAGES = 512;
/** Longest image side (the avatar texture cap, avatarImage.ts MAX_TEXTURE_SIDE). */
export const PNGREMIX_MAX_IMAGE_SIDE = 8192;
/** Pixels over all images, so a model cannot ask the renderer for gigabytes. */
export const PNGREMIX_MAX_TOTAL_PIXELS = 96 * 1024 * 1024;

// ── Output spec ─────────────────────────────────────────────────────────────

export const PNGREMIX_SPEC_FORMAT = 'sei-pngremix';
export const PNGREMIX_SPEC_VERSION = 1;
/** The spec's file name inside the avatar store. */
export const PNGREMIX_ENTRY = 'pngremix.json';

export type PngRemixGeneration = 'v14' | 'v13' | 'legacy';

/** Per-layer motion (Remix movements.gd). Angles in degrees, as saved. */
export interface PngRemixMotion {
  xAmp: number;
  xFrq: number;
  yAmp: number;
  yFrq: number;
  /** Rotation sway: sin(tick * rotFrq) * rotDeg, clamped to [rMin, rMax]. */
  rotFrq: number;
  rotDeg: number;
  rMin: number;
  rMax: number;
  /** Lag behind the parent: 0 = rigid, N = chase 1/N of the gap a frame. */
  drag: number;
  /** Squash and stretch from movement. */
  stretch: number;
  /** Rotation from movement. */
  rdrag: number;
  /** Continuous spin, radians per frame (0 = none). */
  spin: number;
}

/** Container bounce for one mouth phase of a state (SpritesContainer.gd). */
export interface PngRemixBounce {
  /** Continuous animation. */
  anim: 'idle' | 'bouncy' | 'wobble' | 'squish' | 'float' | 'onebounce';
  /** One-shot on entering the phase: 0 none, 1 bouncy, 3 one bounce, 4 wobble, 5 squish. */
  onEnter: number;
  gravity: number;
  energy: number;
  xFrq: number;
  xAmp: number;
  yFrq: number;
  yAmp: number;
}

export interface PngRemixState {
  name: string;
  closed: PngRemixBounce;
  open: PngRemixBounce;
  /** Squash the whole model on each blink (amount, or 0 for off). */
  blinkSquish: number;
}

/** A Remix wiggly appendage (a textured, curling strip). */
export interface PngRemixAppendage {
  segments: number;
  segLen: number;
  width: number;
  /** Curl per segment, radians. */
  curve: number;
  /** Rest direction, degrees. */
  angle: number;
  /** Auto wag: curve = clamp(sin(tick * freq) * speed, min, max) (min/max in degrees). */
  wag: { freq: number; speed: number; min: number; max: number } | null;
  /** Line2D texture mode: 0 none, 1 tile, 2 stretch. */
  tile: number;
  flipH: boolean;
  flipV: boolean;
}

export interface PngRemixLayerState {
  visible: boolean;
  pos: [number, number];
  offset: [number, number];
  /** Radians. */
  rot: number;
  scale: [number, number];
  /** Relative z (adds to the parent's). */
  z: number;
  /** Modulate: multiplies this layer and everything under it. */
  colored: [number, number, number, number];
  /** Self modulate: this layer's own image only. */
  tint: [number, number, number, number];
  /** 0 off, 1 clip children and hide this image, 2 clip children and draw it. */
  clip: 0 | 1 | 2;
  flipH: boolean;
  flipV: boolean;
  /** 0 always, 1 only while the eyes are open, 2 only while blinking. */
  blink: 0 | 1 | 2;
  /** 0 always, 1 only while the mouth is open, 2 only while it is closed. */
  talk: 0 | 1 | 2;
  ignoreBounce: boolean;
  /** Movement feeds into the children's drag (Remix "physics"). */
  physics: boolean;
  /** Sprite sheet frames [h, v] and the frame shown. */
  frames: [number, number];
  frame: number;
  motion: PngRemixMotion;
  /** Motion while the mouth is open, when the layer does not share it. */
  motionOpen: PngRemixMotion | null;
  appendage: PngRemixAppendage | null;
}

export interface PngRemixLayer {
  name: string;
  /** Index into layers, -1 for a root. Parents always come before children. */
  parent: number;
  /** Index into images, -1 for a folder (no picture). */
  image: number;
  kind: 'sprite' | 'appendage';
  /** An asset toggled off when the model was saved. */
  startHidden: boolean;
  /** Remix rest mode 4: no motion at all. */
  still: boolean;
  /** One per model state (always `states.length` long). */
  states: PngRemixLayerState[];
}

export interface PngRemixImage {
  path: string;
  w: number;
  h: number;
}

export interface PngRemixSpec {
  format: typeof PNGREMIX_SPEC_FORMAT;
  version: typeof PNGREMIX_SPEC_VERSION;
  source: { generation: PngRemixGeneration; version: string | null };
  images: PngRemixImage[];
  states: PngRemixState[];
  /** Blink check period (s) and 1-in-N chance per check (Remix settings). */
  blink: { speed: number; chance: number };
  /** Remix "tick" units per second: 1 when motion is in seconds, 60 when per frame. */
  tickRate: number;
  layers: PngRemixLayer[];
}

export interface PngRemixParsed {
  spec: PngRemixSpec;
  /** PNG bytes, index-aligned with spec.images (copies, safe to keep). */
  images: Uint8Array[];
  /** Layers whose picture was not a usable PNG and now draw nothing. */
  skippedImages: number;
}

/** Closed failure set (analytics `reason`). */
export type PngRemixErrorCode = 'too_big' | 'not_pngremix' | 'unsafe' | 'malformed' | 'too_many' | 'no_layers' | 'image_too_large';

export class PngRemixError extends Error {
  constructor(
    readonly code: PngRemixErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PngRemixError';
  }
}

// ── Sniffing ────────────────────────────────────────────────────────────────

/**
 * Cheap check that bytes look like a Godot stored Dictionary (u32 length that
 * fits, then the DICTIONARY type tag). A zip starts "PK", so the two never
 * collide.
 */
export function looksLikePngRemix(b: Uint8Array): boolean {
  if (b.byteLength < 12) return false;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const len = dv.getUint32(0, true);
  const header = dv.getUint32(4, true);
  return len + 4 <= b.byteLength && len >= 8 && (header & 0xff) === 27;
}

// ── PNG checks ──────────────────────────────────────────────────────────────

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Width and height of a static PNG, or null when it is not one (or is an APNG). */
export function pngSize(b: Uint8Array): { w: number; h: number } | null {
  if (b.byteLength < 33) return null;
  for (let i = 0; i < 8; i++) if (b[i] !== PNG_SIG[i]) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (dv.getUint32(12) !== 0x49484452) return null; // IHDR
  const w = dv.getUint32(16);
  const h = dv.getUint32(20);
  if (w === 0 || h === 0) return null;
  // Walk the chunks: an APNG (acTL/fcTL/fdAT) is refused like the avatar store does.
  let o = 8;
  while (o + 8 <= b.byteLength) {
    const len = dv.getUint32(o);
    const type = dv.getUint32(o + 4);
    if (type === 0x6163544c || type === 0x6663544c || type === 0x66644154) return null;
    if (type === 0x49454e44) break; // IEND
    o += 12 + len;
  }
  return { w, h };
}

function base64Bytes(s: string): Uint8Array | null {
  if (s.length === 0 || s.length > PNGREMIX_MAX_BYTES * 2) return null;
  const clean = s.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) return null;
  try {
    const bin = atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

// ── Defaults (Remix SpriteObjectClass.DEFAULT_DATA, the keys we read) ────────

function motionFrom(st: GDict, prefix: '' | 'mo_'): PngRemixMotion {
  const k = (name: string): GValue | undefined => st.get(prefix + name);
  const rdrag = num(k('rdragStr'), 0);
  // Remix updated_follow_check: a save with no rot_degree sways by rdragStr.
  const rotDegRaw = k('rot_degree');
  const rotDeg = typeof rotDegRaw === 'number' ? rotDegRaw : prefix === '' ? rdrag : 0;
  return {
    xAmp: num(k('xAmp'), 0),
    xFrq: num(k('xFrq'), 0),
    yAmp: num(k('yAmp'), 0),
    yFrq: num(k('yFrq'), 0),
    rotFrq: num(k('rot_frq'), 0),
    rotDeg,
    rMin: num(k('rLimitMin'), -180),
    rMax: num(k('rLimitMax'), 180),
    drag: Math.max(0, num(k('dragSpeed'), 0)),
    stretch: num(k('stretchAmount'), 0),
    rdrag,
    spin: bool(k('should_rotate'), false) ? num(k('should_rot_speed'), 0.01) : 0,
  };
}

const ANIMS: Record<string, PngRemixBounce['anim']> = {
  Idle: 'idle',
  Bouncy: 'bouncy',
  Wobble: 'wobble',
  Squish: 'squish',
  Float: 'float',
  'One Bounce': 'onebounce',
};

function bounceFrom(anim: GValue | undefined, onEnter: GValue | undefined, params: GDict | null, legacy: GDict): PngRemixBounce {
  const p = (key: string, legacyKey: string, dflt: number): number =>
    params ? num(params.get(key), dflt) : num(legacy.get(legacyKey), dflt);
  return {
    anim: ANIMS[str(anim, 'Idle')] ?? 'idle',
    onEnter: Math.trunc(num(onEnter, 0)),
    gravity: p('bounce_gravity', 'bounceGravity', 575),
    energy: p('bounce_energy', 'bounceSlider', 250),
    xFrq: p('xFrq', 'xFrq', 0.3),
    xAmp: p('xAmp', 'xAmp', 5),
    yFrq: p('yFrq', 'yFrq', 0.4),
    yAmp: p('yAmp', 'yAmp', 5),
  };
}

// ── 2D affine helpers (for the old global_position layout) ──────────────────

type Mat = [number, number, number, number, number, number];
const IDENT: Mat = [1, 0, 0, 1, 0, 0];
function mul(p: Mat, q: Mat): Mat {
  return [
    p[0] * q[0] + p[2] * q[1],
    p[1] * q[0] + p[3] * q[1],
    p[0] * q[2] + p[2] * q[3],
    p[1] * q[2] + p[3] * q[3],
    p[0] * q[4] + p[2] * q[5] + p[4],
    p[1] * q[4] + p[3] * q[5] + p[5],
  ];
}
function trs(x: number, y: number, r: number, sx: number, sy: number): Mat {
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c * sx, s * sx, -s * sy, c * sy, x, y];
}
function invApply(m: Mat, x: number, y: number): [number, number] | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-9) return null;
  const dx = x - m[4];
  const dy = y - m[5];
  return [(m[3] * dx - m[2] * dy) / det, (-m[1] * dx + m[0] * dy) / det];
}

/** The old app's canvas centre: legacy global positions are around it. */
const LEGACY_ORIGIN: [number, number] = [640, 360];

const finite = (n: number, lim = 1e6): number => (Number.isFinite(n) ? Math.max(-lim, Math.min(lim, n)) : 0);
const clampPair = (p: [number, number], lim = 1e6): [number, number] => [finite(p[0], lim), finite(p[1], lim)];
const unit = (c: [number, number, number, number]): [number, number, number, number] =>
  c.map((v) => Math.max(0, Math.min(1, v))) as [number, number, number, number];

// ── Main entry ──────────────────────────────────────────────────────────────

/**
 * Parse a `.pngRemix` file. Throws PngRemixError (closed `code`) on anything
 * unusable; never returns a model with no drawable layer.
 */
export function parsePngRemix(bytes: Uint8Array): PngRemixParsed {
  if (bytes.byteLength > PNGREMIX_MAX_BYTES) throw new PngRemixError('too_big', 'file is too large');
  if (!looksLikePngRemix(bytes)) throw new PngRemixError('not_pngremix', 'not a PNGTuber Remix file');

  let root: GValue;
  try {
    root = decodeStoredVar(bytes);
  } catch (err) {
    if (err instanceof GodotVariantError) {
      const unsafe = err.code === 'script' || err.code === 'object_class' || err.code === 'unsupported';
      throw new PngRemixError(unsafe ? 'unsafe' : err.code === 'too_many_values' ? 'too_many' : 'malformed', err.message);
    }
    throw err;
  }
  if (!isDict(root)) throw new PngRemixError('not_pngremix', 'top level is not a dictionary');
  const spritesRaw = root.get('sprites_array');
  if (!Array.isArray(spritesRaw)) throw new PngRemixError('not_pngremix', 'no sprites_array');
  if (spritesRaw.length > PNGREMIX_MAX_LAYERS) throw new PngRemixError('too_many', 'too many layers');
  const settings = isDict(root.get('settings_dict')) ? (root.get('settings_dict') as GDict) : new Map<string, GValue>();
  const imageManager = root.get('image_manager_data');
  const generation: PngRemixGeneration = Array.isArray(imageManager) ? 'v14' : root.has('version') ? 'v13' : 'legacy';
  const versionRaw = root.get('version');
  const version = typeof versionRaw === 'string' ? versionRaw.slice(0, 16) : null;

  // ── States (settings_dict.states + input_array names) ─────────────────────
  const settingsStates = Array.isArray(settings.get('states')) ? (settings.get('states') as GValue[]) : [];
  const stateCount = Math.max(1, Math.min(settingsStates.length, PNGREMIX_MAX_STATES));
  if (settingsStates.length > PNGREMIX_MAX_STATES) throw new PngRemixError('too_many', 'too many states');
  const inputs = Array.isArray(root.get('input_array')) ? (root.get('input_array') as GValue[]) : [];
  const states: PngRemixState[] = [];
  for (let i = 0; i < stateCount; i++) {
    const s = settingsStates[i];
    const d = isDict(s) ? s : new Map<string, GValue>();
    const input = inputs[i];
    let name = isDict(input) ? str(input.get('state_name'), '').trim().slice(0, 60) : '';
    if (!name || /^\d+$/.test(name)) name = `State ${i + 1}`;
    const mc = isDict(d.get('state_param_mc')) ? (d.get('state_param_mc') as GDict) : null;
    const mo = isDict(d.get('state_param_mo')) ? (d.get('state_param_mo') as GDict) : null;
    states.push({
      name,
      closed: bounceFrom(d.get('current_mc_anim'), d.get('mouth_closed'), mc, settings),
      open: bounceFrom(d.get('current_mo_anim'), d.get('mouth_open'), mo, settings),
      blinkSquish: bool(d.get('should_squish'), false) ? num(d.get('squish_amount'), 1) : 0,
    });
  }
  // Duplicate names would make an emotion pick the wrong one.
  const seenNames = new Map<string, number>();
  for (const s of states) {
    const n = seenNames.get(s.name) ?? 0;
    seenNames.set(s.name, n + 1);
    if (n > 0) s.name = `${s.name} (${n + 1})`;
  }

  // ── Images ────────────────────────────────────────────────────────────────
  const images: Uint8Array[] = [];
  const imageMeta: PngRemixImage[] = [];
  let totalPixels = 0;
  let skippedImages = 0;
  /** Add a PNG, or return -1 (and count it skipped) when it is not usable. */
  const addImage = (raw: GValue | undefined): number => {
    let b: Uint8Array | null = null;
    if (raw instanceof Uint8Array) b = raw;
    else if (typeof raw === 'string') b = base64Bytes(raw);
    if (!b || b.byteLength === 0) return -1;
    const size = pngSize(b);
    if (!size) {
      skippedImages++;
      return -1;
    }
    if (size.w > PNGREMIX_MAX_IMAGE_SIDE || size.h > PNGREMIX_MAX_IMAGE_SIDE) {
      throw new PngRemixError('image_too_large', `an image is ${size.w}x${size.h}`);
    }
    totalPixels += size.w * size.h;
    if (totalPixels > PNGREMIX_MAX_TOTAL_PIXELS) throw new PngRemixError('image_too_large', 'images are too large in total');
    if (images.length >= PNGREMIX_MAX_IMAGES) throw new PngRemixError('too_many', 'too many images');
    images.push(b.slice()); // copy out of the file buffer
    imageMeta.push({
      path: `img/${images.length - 1}.png`,
      w: size.w,
      h: size.h,
    });
    return images.length - 1;
  };
  /** v14: image_manager_data entries by id, decoded on first use (unused images are left out). */
  const managedEntry = new Map<number, GDict>();
  const managed = new Map<number, number>();
  if (Array.isArray(imageManager)) {
    if (imageManager.length > PNGREMIX_MAX_IMAGES) throw new PngRemixError('too_many', 'too many images');
    for (const entry of imageManager) {
      if (!isDict(entry)) continue;
      const id = entry.get('id');
      if (typeof id === 'number' && !managedEntry.has(id)) managedEntry.set(id, entry);
    }
  }
  const managedImage = (id: number): number => {
    const known = managed.get(id);
    if (known !== undefined) return known;
    const idx = addImage(managedEntry.get(id)?.get('runtime_texture'));
    managed.set(id, idx);
    return idx;
  };

  // ── Layers ────────────────────────────────────────────────────────────────
  interface Pending {
    raw: GDict;
    id: number | null;
    parentId: number | null;
    kind: 'sprite' | 'appendage';
  }
  const pending: Pending[] = [];
  for (const s of spritesRaw) {
    if (!isDict(s)) continue;
    const type = str(s.get('sprite_type'), 'Sprite2D');
    if (type === 'Comment') continue; // an editor note, never drawn
    const id = s.get('sprite_id');
    const parentId = s.get('parent_id');
    pending.push({
      raw: s,
      id: typeof id === 'number' ? id : null,
      parentId: typeof parentId === 'number' && parentId !== 0 ? parentId : null,
      kind: type === 'WiggleApp' ? 'appendage' : 'sprite',
    });
  }
  // Parents before children (depth-first in file order); a missing parent or
  // a cycle makes the layer a root.
  const byId = new Map<number, number>();
  pending.forEach((p, i) => {
    if (p.id !== null && !byId.has(p.id)) byId.set(p.id, i);
  });
  const children = new Map<number, number[]>();
  const roots: number[] = [];
  pending.forEach((p, i) => {
    const parent = p.parentId !== null ? byId.get(p.parentId) : undefined;
    if (parent === undefined || parent === i) roots.push(i);
    else {
      const list = children.get(parent) ?? [];
      list.push(i);
      children.set(parent, list);
    }
  });
  const order: number[] = [];
  const placed = new Set<number>();
  const visit = (i: number, depth: number): void => {
    if (placed.has(i) || depth > 256) return;
    placed.add(i);
    order.push(i);
    for (const c of children.get(i) ?? []) visit(c, depth + 1);
  };
  for (const r of roots) visit(r, 0);
  // Anything left sits in a parent cycle: break it at the first member.
  for (let i = 0; i < pending.length; i++) if (!placed.has(i)) visit(i, 0);
  const newIndex = new Map<number, number>();
  order.forEach((old, idx) => newIndex.set(old, idx));
  const parentOf = (old: number): number => {
    const p = pending[old]!.parentId;
    if (p === null) return -1;
    const pOld = byId.get(p);
    if (pOld === undefined || pOld === old) return -1;
    const pNew = newIndex.get(pOld)!;
    // A parent placed after its child means the link was a broken cycle.
    return pNew < newIndex.get(old)! ? pNew : -1;
  };

  const layers: PngRemixLayer[] = [];
  /** Old saves: each state's global_position, to rebuild positions. */
  const globals: Array<Array<[number, number] | null>> = [];
  for (const old of order) {
    const p = pending[old]!;
    const s = p.raw;
    const rawStates = Array.isArray(s.get('states')) ? (s.get('states') as GValue[]) : [];
    // Remix drops empty state dicts and pads the end with defaults.
    const filled = rawStates.filter((x): x is GDict => isDict(x) && x.size > 0);
    const folder = filled.length > 0 && bool(filled[0]!.get('folder'), false);
    let image = -1;
    if (!folder) {
      if (generation === 'v14') {
        const id = s.get('image_id');
        if (typeof id === 'number' && id !== 0) image = managedImage(id);
      } else {
        image = addImage(s.get('img'));
      }
    }
    const isAsset = bool(s.get('is_asset'), false);
    const layerStates: PngRemixLayerState[] = [];
    const layerGlobals: Array<[number, number] | null> = [];
    for (let k = 0; k < stateCount; k++) {
      const st = filled[k] ?? new Map<string, GValue>();
      layerStates.push(layerState(st, p.kind));
      const gl = st.get('global_position');
      layerGlobals.push(gl !== undefined && vec2(gl, [NaN, NaN]).every(Number.isFinite) ? vec2(gl, [0, 0]) : null);
    }
    layers.push({
      name: str(s.get('sprite_name'), 'Layer').slice(0, 80),
      parent: parentOf(old),
      image,
      kind: p.kind,
      startHidden: isAsset && !bool(s.get('was_active_before'), true),
      still: num(s.get('rest_mode'), 1) === 4,
      states: layerStates,
    });
    globals.push(layerGlobals);
  }

  // Old saves place each layer by its saved global position (what the old app
  // drew); rebuild the parent-relative position from it, state by state.
  if (globals.some((g) => g.some((v) => v !== null))) {
    for (let k = 0; k < stateCount; k++) {
      const rootM: Mat[] = [];
      layers.forEach((l, i) => {
        const st = l.states[k]!;
        const gl = globals[i]![k];
        let attach: Mat = IDENT;
        if (l.parent >= 0) {
          const ps = layers[l.parent]!.states[k]!;
          attach = mul(rootM[l.parent]!, trs(ps.offset[0], ps.offset[1], 0, ps.flipH ? -1 : 1, ps.flipV ? -1 : 1));
        }
        if (gl) {
          // Every saved global position (root or child) is in the old canvas frame.
          const g: [number, number] = [gl[0] - LEGACY_ORIGIN[0], gl[1] - LEGACY_ORIGIN[1]];
          const local = l.parent >= 0 ? invApply(attach, g[0], g[1]) : g;
          if (local) st.pos = clampPair(local);
        }
        rootM[i] = mul(attach, trs(st.pos[0], st.pos[1], st.rot, st.scale[0], st.scale[1]));
      });
    }
  }

  const drawable = layers.some((l) => l.image >= 0);
  if (!drawable) throw new PngRemixError('no_layers', 'no layer has a usable picture');

  const blinkSpeed = Math.max(0.05, Math.min(30, num(settings.get('blink_speed'), 1)));
  const blinkChance = Math.max(1, Math.min(1000, Math.trunc(num(settings.get('blink_chance'), 10))));
  const delta = settings.get('should_delta');
  const spec: PngRemixSpec = {
    format: PNGREMIX_SPEC_FORMAT,
    version: PNGREMIX_SPEC_VERSION,
    source: { generation, version },
    images: imageMeta,
    states,
    blink: { speed: blinkSpeed, chance: blinkChance },
    // A save without should_delta predates it: motion ticked once a frame.
    tickRate: delta === true ? 1 : 60,
    layers,
  };
  return { spec, images, skippedImages };
}

function layerState(st: GDict, kind: 'sprite' | 'appendage'): PngRemixLayerState {
  const blinkOn = bool(st.get('should_blink'), false);
  const talkOn = bool(st.get('should_talk'), false);
  const clipRaw = Math.trunc(num(st.get('clip'), 0));
  const shared = bool(st.get('shared_movement'), true);
  const hframes = Math.max(1, Math.min(64, Math.trunc(num(st.get('hframes'), 1))));
  const vframes = Math.max(1, Math.min(64, Math.trunc(num(st.get('vframes'), 1))));
  const out: PngRemixLayerState = {
    visible: bool(st.get('visible'), true),
    pos: clampPair(vec2(st.get('position'), [0, 0])),
    offset: clampPair(vec2(st.get('offset'), [0, 0])),
    rot: finite(num(st.get('rotation'), 0), 1e3),
    scale: clampPair(vec2(st.get('scale'), [1, 1]), 1e3),
    z: Math.trunc(finite(num(st.get('z_index'), 0), 4096)),
    colored: unit(color(st.get('colored'), [1, 1, 1, 1])),
    tint: unit(color(st.get('tint'), [1, 1, 1, 1])),
    clip: clipRaw === 1 || clipRaw === 2 ? clipRaw : 0,
    flipH: bool(st.get('flip_sprite_h'), false),
    flipV: bool(st.get('flip_sprite_v'), false),
    blink: blinkOn ? (bool(st.get('open_eyes'), true) ? 1 : 2) : 0,
    talk: talkOn ? (bool(st.get('open_mouth'), false) ? 1 : 2) : 0,
    ignoreBounce: bool(st.get('ignore_bounce'), false),
    physics: bool(st.get('physics'), true),
    frames: [hframes, vframes],
    frame: Math.max(0, Math.min(hframes * vframes - 1, Math.trunc(num(st.get('frame'), 0)))),
    motion: motionFrom(st, ''),
    motionOpen: shared ? null : motionFrom(st, 'mo_'),
    appendage: null,
  };
  if (kind === 'appendage') {
    const wag = bool(st.get('auto_wag'), false);
    out.appendage = {
      segments: Math.max(1, Math.min(32, Math.trunc(num(st.get('wiggle_segm'), 5)))),
      segLen: Math.max(0, Math.min(4096, num(st.get('segm_length'), 30))),
      width: Math.max(0, Math.min(4096, num(st.get('width'), 80))),
      curve: finite(num(st.get('wiggle_curve'), 0), 10),
      angle: finite(num(st.get('appendage_angle'), 0), 3600),
      wag: wag
        ? {
            freq: finite(num(st.get('wag_freq'), 0.02), 1e3),
            speed: finite(num(st.get('wag_speed'), 0.5), 1e3),
            min: finite(num(st.get('wag_mini'), -180), 3600),
            max: finite(num(st.get('wag_max'), 180), 3600),
          }
        : null,
      tile: Math.trunc(num(st.get('tile'), 2)),
      flipH: bool(st.get('flip_h'), false),
      flipV: bool(st.get('flip_v'), false),
    };
  }
  return out;
}

// ── Spec validation (what the renderer trusts) ───────────────────────────────

/**
 * Check a stored spec's shape before the renderer draws it (the file on disk
 * is ours, but a broken or hand-edited one must fail cleanly, not throw deep
 * inside a frame). Returns the spec or throws.
 */
export function validatePngRemixSpec(raw: unknown): PngRemixSpec {
  const fail = (why: string): never => {
    throw new Error(`pngremix.json: ${why}`);
  };
  if (!raw || typeof raw !== 'object') fail('not an object');
  const s = raw as PngRemixSpec;
  if (s.format !== PNGREMIX_SPEC_FORMAT || s.version !== PNGREMIX_SPEC_VERSION) fail('unknown format');
  if (!Array.isArray(s.images) || !Array.isArray(s.layers) || !Array.isArray(s.states)) fail('missing lists');
  if (s.states.length === 0 || s.states.length > PNGREMIX_MAX_STATES) fail('bad state count');
  if (s.layers.length > PNGREMIX_MAX_LAYERS || s.images.length > PNGREMIX_MAX_IMAGES) fail('too many entries');
  for (const im of s.images) {
    if (!im || typeof im.path !== 'string' || !/^img\/\d+\.png$/.test(im.path)) fail('bad image path');
  }
  s.layers.forEach((l, i) => {
    if (!l || typeof l !== 'object') fail('bad layer');
    if (!Number.isInteger(l.parent) || l.parent >= i || l.parent < -1) fail('bad parent');
    if (!Number.isInteger(l.image) || l.image < -1 || l.image >= s.images.length) fail('bad image ref');
    if (!Array.isArray(l.states) || l.states.length !== s.states.length) fail('bad layer states');
  });
  if (typeof s.tickRate !== 'number' || !(s.tickRate > 0)) fail('bad tick rate');
  return s;
}
