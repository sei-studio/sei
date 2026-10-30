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
