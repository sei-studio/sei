/**
 * Call scene registry — which character gets which scene, and the pure
 * geometry the renderer needs to stage one.
 *
 * Today this is one built-in scene (Sui's grass field, reusing the onboarding
 * art) behind a resolver seam. The seam is the whole point: when scenes become
 * user-authored, `resolveCallScene` starts reading `character.metadata`, and
 * nothing in `CallScene.tsx` or `VoiceCallScreen` changes.
 *
 * Scenes are SOLO ONLY. A group call has no single actor to stage, so the
 * backdrop mode falls back to split character art (see CallBackdrop) — the
 * resolver is never consulted with more than one participant.
 */

import type { Character } from '@shared/characterSchema';
import { DEFAULT_CHARACTER_UUIDS } from '@shared/defaultCharacters';
import type { CallScene, SceneActor } from '@shared/callScene';

/**
 * Sui's grass field.
 *
 * The art, layer order and timings are the onboarding scene's
 * (`onboard/OnboardScene.tsx`), deliberately unchanged: same PNGs, same 3:2
 * stage, same 66% sprite width. That width is not a framing preference — it is
 * the size at which the sprite's hand-drawn line weight matches the layer
 * art's, so scaling it for the call would visibly mismatch the pen.
 *
 * What differs from onboarding is only staging: she walks to the CENTRE
 * instead of the right third, because on a call she is what you are looking at
 * rather than a speaker beside a dialogue column.
 *
 * She sits between `back` (sky, ground) and `front` (grass tufts) so the tufts
 * overlap her feet — standing IN the field rather than on top of it.
 */
const SUI_GRASS: CallScene = {
  id: 'sui-grass',
  stageAspect: 3 / 2,
  backdropColor: '#9cc3fc', // layer1's flat sky, for windows taller than 3:2
  back: [
    { paint: { kind: 'images', images: ['./img/onboard/layer1.png'] } },
    { paint: { kind: 'images', images: ['./img/onboard/layer2.png'] } },
  ],
  front: [
    {
      // Sway: the three tuft variations cycled. No crossfade — partial alpha
      // on two tufts mid-swap reads as flicker (260729).
      paint: {
        kind: 'images',
        images: [
          './img/onboard/layer3.png',
          './img/onboard/layer4.png',
          './img/onboard/layer5.png',
        ],
        frameMs: 420,
      },
    },
  ],
  actor: {
    idle: { kind: 'images', images: ['./img/onboard/sui-stand.png'] },
    // Mouth open on the FIRST frame: waiting a full interval before the first
    // flap makes short lines look mimed (260729).
    talk: {
      kind: 'images',
      images: ['./img/onboard/sui-talk.png', './img/onboard/sui-stand.png'],
      frameMs: 130,
    },
    walk: {
      kind: 'images',
      images: ['./img/onboard/sui-stand.png', './img/onboard/sui-stride.png'],
      frameMs: 260,
    },
    aspect: 1241 / 828,
    facing: 'left',
    rest: { centerX: 0.5, bottom: 0.07, width: 0.66 },
    // frontAfter: she comes in past the right-hand tufts, so for the first
    // third of the stage the grass is correctly in front of her; after that she
    // is nearer than it is and steps in front (260731).
    entrance: { from: 'right', durationMs: 2200, bob: 0.02, frontAfter: 1 / 3 },
  },
  footsteps: ['./sfx/footstep-grass-0.ogg', './sfx/footstep-grass-1.ogg'],
};

/** Built-in scenes, keyed by character id. */
const BUILT_IN: Readonly<Record<string, CallScene>> = {
  [DEFAULT_CHARACTER_UUIDS.sui]: SUI_GRASS,
};

/**
 * The scene for a character, or null if they have none.
 *
 * The future user-authored path plugs in here: read `character.metadata`
 * first, fall back to the built-in table.
 */
export function resolveCallScene(character: Character | undefined): CallScene | null {
  if (!character) return null;
  return BUILT_IN[character.id] ?? null;
}

/** True when any scene exists for this character. */
export function hasCallScene(character: Character | undefined): boolean {
  return resolveCallScene(character) !== null;
}

/**
 * How far to park the actor off-stage before the walk-in, as a percentage of
 * the ACTOR's own width (CSS `translateX` percentages are element-relative).
 *
 * Positive = right. The actor's box spans `centerX ± width/2` in stage
 * fractions, so clearing the edge means moving its near edge past 0 or 1, plus
 * a little slack so an overhanging sleeve is never caught on screen.
 */
export function offstageTranslatePct(actor: SceneActor): number {
  const CLEARANCE = 0.03; // stage fractions
  const { centerX, width } = actor.rest;
  const left = centerX - width / 2;
  const right = centerX + width / 2;
  return actor.entrance.from === 'right'
    ? ((1 - left + CLEARANCE) / width) * 100
    : -((right + CLEARANCE) / width) * 100;
}

/**
 * Whether the sprite must be mirrored to face the way it is walking.
 *
 * Entering from the right means walking LEFT. A scene ships one set of frames
 * and this decides whether they need flipping, so art drawn facing either way
 * works without a second export. The flip is CONSTANT for the whole scene —
 * applying it only while walking would pop the sprite around on arrival.
 */
export function actorMirrored(actor: SceneActor): boolean {
  const walkingToward = actor.entrance.from === 'right' ? 'left' : 'right';
  return walkingToward !== actor.facing;
}

/**
 * The entrance walk's easing, as bezier control points.
 *
 * It lives here rather than in the stylesheet because `frontSwitchDelayMs`
 * has to invert it: the switch happens at a POSITION, and only the curve says
 * what time that position falls at. CallScene.tsx sets the CSS
 * transition-timing-function from `entranceEasingCss()` so there is one copy.
 *
 * A walk: gentle start, long even stride, soft stop.
 */
export const ENTRANCE_EASING = { x1: 0.3, y1: 0, x2: 0.35, y2: 1 } as const;

export function entranceEasingCss(): string {
  const { x1, y1, x2, y2 } = ENTRANCE_EASING;
  return `cubic-bezier(${x1}, ${y1}, ${x2}, ${y2})`;
}

function bezier(p1: number, p2: number, s: number): number {
  const m = 1 - s;
  return 3 * m * m * s * p1 + 3 * m * s * s * p2 + s * s * s;
}

/**
 * Invert the easing: given a fraction of the DISTANCE travelled, return the
 * fraction of the DURATION at which it is reached.
 *
 * Bisection on the curve parameter. 40 steps is ~1e-12 on a unit interval, far
 * finer than a frame, and the curve is monotonic in s for these control points
 * so there is exactly one root.
 */
export function easingTimeAtProgress(progress: number): number {
  const p = Math.min(1, Math.max(0, progress));
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i += 1) {
    const mid = (lo + hi) / 2;
    if (bezier(ENTRANCE_EASING.y1, ENTRANCE_EASING.y2, mid) < p) lo = mid;
    else hi = mid;
  }
  return bezier(ENTRANCE_EASING.x1, ENTRANCE_EASING.x2, (lo + hi) / 2);
}

/** Where the actor's box centre sits before the walk starts, in stage fractions. */
export function actorStartCenterX(actor: SceneActor): number {
  return actor.rest.centerX + (offstageTranslatePct(actor) / 100) * actor.rest.width;
}

/**
 * The stage x the actor must pass to be painted in front of the front layers,
 * or null when the scene never moves her forward.
 *
 * `frontAfter` is measured from the edge she walks IN from, so one number reads
 * the same way for a scene entering from either side.
 */
export function frontCrossX(actor: SceneActor): number | null {
  const f = actor.entrance.frontAfter;
  if (typeof f !== 'number' || !Number.isFinite(f)) return null;
  return actor.entrance.from === 'right' ? 1 - f : f;
}

/** Is the actor in front of the foreground at a given stage x? */
export function isPastFront(actor: SceneActor, centerX: number): boolean {
  const cross = frontCrossX(actor);
  if (cross == null) return false;
  return actor.entrance.from === 'right' ? centerX <= cross : centerX >= cross;
}

/** Is the actor in front once she has come to rest? */
export function restIsPastFront(actor: SceneActor): boolean {
  return isPastFront(actor, actor.rest.centerX);
}

/**
 * How long after the walk starts the actor crosses in front of the foreground,
 * in ms, or null when she never does (no `frontAfter`, or the crossing point is
 * behind her rest position).
 *
 * Distance-to-time goes through the easing, so the switch lands where the
 * sprite actually is rather than where a linear walk would have put it.
 */
export function frontSwitchDelayMs(actor: SceneActor): number | null {
  const cross = frontCrossX(actor);
  if (cross == null || !restIsPastFront(actor)) return null;
  const start = actorStartCenterX(actor);
  const span = actor.rest.centerX - start;
  if (span === 0) return 0;
  const progress = (cross - start) / span;
  if (progress <= 0) return 0; // already in front when the walk starts
  return easingTimeAtProgress(progress) * actor.entrance.durationMs;
}

/** The actor's box as CSS percentages of the stage. */
export function actorBoxStyle(actor: SceneActor): {
  left: string;
  bottom: string;
  width: string;
} {
  const { centerX, bottom, width } = actor.rest;
  return {
    left: `${(centerX - width / 2) * 100}%`,
    bottom: `${bottom * 100}%`,
    width: `${width * 100}%`,
  };
}
