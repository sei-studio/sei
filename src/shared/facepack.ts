/**
 * sei-facepack v1 (261028, desktop companion pilot): the baked 2D face set a
 * FacepackView plays. Produced offline per character by the face-set bake
 * (~/suisei/work/face-sets, tools/compose.py is the reference compositor).
 *
 * Compose rule (also in every manifest's `compose` string): per frame draw
 * expressions[e].poses[p].base at (0,0); if blinking and expression.blink,
 * the eyes[half|closed] patch at eyes.box[0..1]; if viseme != rest, the
 * mouth[viseme] patch at mouth.box[0..1]; then each name in
 * expression.overlays from overlays[name][p] (or [c]) at its box. All layers
 * source-over. Missing pose falls back to c, missing viseme to rest.
 */

import { FACE_ALL_EXPRESSIONS, normalizePalette, type FacePalette } from '../bot/brain/faceExpressions.js';

export type FacepackBox = [number, number, number, number];
export type FacepackEyeState = 'open' | 'half' | 'closed';
export type FacepackViseme = 'rest' | 'aa' | 'ii' | 'uu' | 'ee' | 'oo';

export interface FacepackPose {
  base: string;
  /** Absent when the expression has blink:false. */
  eyes?: { box: FacepackBox; half?: string; closed?: string };
  mouth?: { box: FacepackBox } & Partial<Record<Exclude<FacepackViseme, 'rest'>, string>>;
  /**
   * 261120: gaze frames (anima packs baked from 261120). The open eyes
   * re-rendered by the model looking `x[xi]` to the viewer's right and
   * `y[yi]` down (both ascending, in the model's iris-rotation units, 0 = the
   * expression's own look), cropped to `box`: `frames[yi][xi]`, null where
   * the frame is the base itself. Drawn over the base before the eye and
   * mouth patches; a player shows the one nearest its gaze point. Packs
   * without it (and players that predate it) show the base's eyes.
   */
  iris?: FacepackIris;
  /**
   * 261120 (product call 261120, "why can't we just slide it across?"): the
   * iris as its own layer, slid continuously. Drawn over the base: `empty`
   * (the eyes with the iris taken out) at `box`, then for each of `eyes` the
   * part of `sprite` inside its `rect` moved by its offset at her look
   * (`d[yi][xi]` = [dx, dy] pack px at x[xi], y[yi], bilinear between,
   * clamped to the grid; null = no move), kept to the opening: the sprite's
   * alpha times `clip`'s. `half` is the half lid's own empty eye and
   * opening, drawn the same way over `eyes.half`. Players that predate it
   * ignore it; a pack with it has no `iris`.
   */
  iris_layer?: FacepackIrisLayer;
}

export interface FacepackIrisLayerEye {
  /** This eye's part of the sprite (pack px, inside the layer's box). */
  rect: FacepackBox;
  d: Array<Array<[number, number] | null>>;
}

export interface FacepackIrisLayer {
  box: FacepackBox;
  x: number[];
  y: number[];
  /** All three are `box`-sized: the iris (RGBA), the eyes without it (opaque), the opening (alpha). */
  sprite: string;
  empty: string;
  clip: string;
  eyes: FacepackIrisLayerEye[];
  /** Fit quality at bake time (share of the model's renders explained), informational. */
  fit?: number;
  half?: { empty: string; clip: string };
}

export interface FacepackIris {
  box: FacepackBox;
  x: number[];
  y: number[];
  frames: Array<Array<string | null>>;
  /**
   * The half-shut eyes looking `x[xi]` across (level), same crop: drawn at
   * `box` over `eyes.half` so a blink keeps her look. Null at the base's look
   * (and wherever absent, the plain half patch shows).
   */
  half?: Array<string | null>;
}

export interface FacepackExpression {
  /** false: eyes already closed in this expression; never blink. */
  blink?: boolean;
  overlays?: string[];
  poses: Record<string, FacepackPose>;
}

export interface FacepackManifest {
  format: 'sei-facepack';
  version: 1;
  character: string;
  method?: string;
  canvas: [number, number];
  anchor?: { pin: [number, number]; face: [number, number] };
  poses: Record<string, string>;
  default_pose?: string;
  default_expression?: string;
  expressions: Record<string, FacepackExpression>;
  /**
   * 261028: the expressions this character is offered, in prompt order (the
   * FACE block lists only these). Written by the bake: the names it drew.
   * Absent: every key of `expressions`.
   */
  palette?: string[];
  /**
   * 261028: this pack's own tag aliases, word -> palette name (an LED face
   * with no laugh maps laugh and excited onto smirk). Checked before the
   * shared vocabulary; see resolveExpression in bot/brain/faceExpressions.js.
   */
  aliases?: Record<string, string>;
  overlays?: Record<string, Record<string, { src: string; box: FacepackBox }>>;
  bytes?: number;
  attribution?: string[];
  compose?: string;
}

/**
 * The palette a pack offers (261028): its declared `palette`, or every
 * expression it can draw in vocabulary order, limited to names it really
 * has, plus its own aliases. Same for every pack; nothing keys on the
 * character.
 */
export function packPalette(m: FacepackManifest): FacePalette | null {
  const drawable = Object.keys(m.expressions ?? {});
  const order = FACE_ALL_EXPRESSIONS.map((e) => e.name);
  const rank = (n: string): number => {
    const i = order.indexOf(n);
    return i < 0 ? order.length : i;
  };
  const list = Array.isArray(m.palette) ? m.palette : [...drawable].sort((a, b) => rank(a) - rank(b));
  return normalizePalette(list, m.aliases, drawable);
}

/** One pack the dev pack dir offers (facepack:list). */
export interface FacepackInfo {
  /** Directory name under SEI_FACEPACK_DIR (sui, lyra, marv). */
  id: string;
  character: string;
  bytes: number;
  attribution: string[];
}

/** facepack:info. `enabled` is the dev flag: unpackaged AND SEI_FACEPACK_DIR set. */
export interface FacepackDevInfo {
  enabled: boolean;
  packs: FacepackInfo[];
  /** Optional https base (SEI_FACEPACK_URL, dev only) for the URL loader hook. */
  baseUrl: string | null;
}

/**
 * A face cue for one character (push facepack:cue). `at: 'start'` applies
 * when the line `text` becomes audible (or on arrival when no call is live);
 * `at: 'end'` applies when that line finishes. `text: null` (a say() call's
 * `expression`, or a tag-only reply) applies to the character's next line.
 */
export interface FaceCue {
  characterId: string;
  expression: string;
  at: 'start' | 'end';
  text: string | null;
  messageId?: string;
}

/** A pack file path is plain relative posix: no traversal, no absolute, image or json only. */
export function isSafePackPath(rel: string): boolean {
  if (typeof rel !== 'string' || !rel || rel.length > 300) return false;
  if (rel.startsWith('/') || rel.includes('\\') || rel.includes('\0')) return false;
  if (rel.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) return false;
  return /\.(webp|png|json)$/i.test(rel);
}




