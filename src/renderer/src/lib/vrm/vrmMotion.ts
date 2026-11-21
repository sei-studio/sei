/**
 * Pure pieces of the VRM view (261122, experimental): camera framing, the
 * mouth's viseme mix, and the analytics buckets. No three.js here, so they
 * are unit tested without WebGL.
 */
import type { AvatarCamera } from '@shared/ipc';

/** The model's rest-pose bounds in world units (y up, the model faces +z). */
export interface ModelBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  /**
   * Her body's horizontal center (the hips), when known. A prop on one side (a
   * backpack arm, a tail, a weapon) widens the box, and centering on the box
   * would push her off the middle of her slot.
   */
  centerX?: number;
}

export interface CameraFrame {
  /** Where the camera sits (x, y) and how far in front of the model (z distance). */
  x: number;
  y: number;
  distance: number;
  /** World height the view shows at the model's plane. */
  viewHeight: number;
}

/**
 * Frame the model the way Live2DView frames a Cubism model, so `AvatarCamera`
 * means the same for both: contain-fit the whole model in the view, then
 * `zoom` multiplies that fit and `x` / `y` pan in view fractions (y down).
 * RoomAvatar's bust camera (zoom 1.35, y 0.175) puts the top of her head at
 * the top edge and shows her upper three quarters.
 */
export function frameModel(b: ModelBounds, aspect: number, cam: AvatarCamera | null | undefined, fovDeg: number): CameraFrame {
  const w = Math.max(1e-3, b.maxX - b.minX);
  const h = Math.max(1e-3, b.maxY - b.minY);
  const a = aspect > 0 ? aspect : 1;
  const zoom = cam?.zoom && cam.zoom > 0 ? cam.zoom : 1;
  // Contain: the view height that fits both her height and her width.
  const viewHeight = Math.max(h, w / a) / zoom;
  const cx = b.centerX ?? (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  // A pan of +y moves the model DOWN the view, i.e. the camera up.
  const y = cy + (cam?.y ?? 0) * viewHeight;
  const x = cx - (cam?.x ?? 0) * viewHeight * a;
  const distance = viewHeight / 2 / Math.tan(((fovDeg * Math.PI) / 180) / 2);
  return { x, y, distance, viewHeight };
}

export const VISEMES = ['aa', 'ih', 'ou', 'ee', 'oh'] as const;
export type Viseme = (typeof VISEMES)[number];

/** How often each vowel leads a syllable (roughly English / Japanese vowel shares). */
const VOWEL_WEIGHTS: Record<Viseme, number> = { aa: 0.34, oh: 0.18, ee: 0.16, ih: 0.16, ou: 0.16 };
/** Share of the mouth that always goes to 'aa', so the jaw opens on every model. */
const AA_FLOOR = 0.3;
/** A syllable starts when the level rises past ON after dipping under OFF. */
const SYLLABLE_ON = 0.28;
const SYLLABLE_OFF = 0.16;
/** Per-frame blend toward the new vowel's shape (about 60 ms at 30 fps). */
const SHAPE_BLEND = 0.55;

/**
 * Turns the 0..1 mouth level (the RMS envelope) into viseme weights. The
 * level has no phonemes, so each syllable (a rise in the level) picks a vowel
 * shape at random, weighted, and the level scales it. Visemes the model lacks
 * fold into 'aa'.
 */
export class VisemeMixer {
  private shape: Record<Viseme, number> = { aa: 1, ih: 0, ou: 0, ee: 0, oh: 0 };
  private target: Viseme = 'aa';
  private armed = true;
  private readonly has: ReadonlySet<Viseme>;

  constructor(
    available: Iterable<string>,
    private readonly rng: () => number = Math.random,
  ) {
    const set = new Set<string>(available);
    this.has = new Set(VISEMES.filter((v) => set.has(v)));
  }

  /** Weights for this frame. `mouth` is the smoothed level, 0..1. */
  weights(mouth: number): Record<Viseme, number> {
    if (mouth < SYLLABLE_OFF) this.armed = true;
    else if (this.armed && mouth > SYLLABLE_ON) {
      this.armed = false;
      this.target = this.pick();
    }
    for (const v of VISEMES) this.shape[v] += ((v === this.target ? 1 : 0) - this.shape[v]) * SHAPE_BLEND;
    const out: Record<Viseme, number> = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
    for (const v of VISEMES) {
      const share = (v === 'aa' ? AA_FLOOR : 0) + (1 - AA_FLOOR) * this.shape[v];
      if (v === 'aa' || this.has.has(v)) out[v] += mouth * share;
      else out.aa += mouth * share;
    }
    for (const v of VISEMES) out[v] = Math.min(1, out[v]);
    return out;
  }

  private pick(): Viseme {
    let u = this.rng();
    for (const v of VISEMES) {
      u -= VOWEL_WEIGHTS[v];
      if (u <= 0) return v;
    }
    return 'aa';
  }
}

/** Frame rate bucket for analytics (the cap is 30). */
export function fpsBucket(fps: number): string {
  return fps < 10 ? '<10' : fps < 20 ? '10-20' : fps < 27 ? '20-27' : '27+';
}

/** Load time bucket for analytics. */
export function loadMsBucket(ms: number): string {
  return ms < 1000 ? '<1s' : ms < 3000 ? '1-3s' : ms < 8000 ? '3-8s' : '8s+';
}
