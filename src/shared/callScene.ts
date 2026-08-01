/**
 * Call scenes — the data model for a character's custom voice-call backdrop.
 *
 * A call scene replaces the default call view (profile-picture tiles on the
 * app background) with a painted stage the character physically walks into.
 * Sui's grass field is the first one, reusing the onboarding art; the point of
 * this module is that she is DATA, not a special case, so the eventual
 * "customize your companion's call scene" feature only has to produce one of
 * these descriptors instead of a second renderer.
 *
 * ── The four pieces the model needs ─────────────────────────────────────────
 * A scene is a BACKDROP plus an ACTOR, and the actor needs three appearances:
 * standing, talking, and walking. Everything else (where she stops, which edge
 * she comes from, how long the walk takes) is a number in the descriptor.
 *
 * The backdrop is split into `back` and `front` layer lists with the actor
 * sandwiched between them. That split is not decoration: Sui stands ON the
 * ground art but BEHIND the grass tufts, which is what makes her read as
 * standing in the field rather than pasted on top of it. Any scene with
 * foreground detail (tufts, railings, a desk edge) needs the same seam.
 *
 * ── Paints ──────────────────────────────────────────────────────────────────
 * Every visual slot — a backdrop layer, a character pose — is a `ScenePaint`,
 * which is either a list of still images cycled on a timer or a video. One
 * union means "scene image/video" and "talking animation image/video" are the
 * same thing to the renderer, so a future scene can ship an mp4 loop for its
 * water while another ships three PNGs, and neither needs new code.
 *
 * ── Coordinates ─────────────────────────────────────────────────────────────
 * All positions are FRACTIONS OF THE STAGE (0..1), never pixels. The stage is
 * a fixed-aspect box that covers the window, so one scale factor applies to
 * the backdrop and the sprite together. Mixing units there is what makes
 * hand-drawn art visibly mismatch its own character's pen weight when the
 * window aspect drifts (the SCALE LOCK note in OnboardScene.tsx).
 *
 * NOTE ON VALIDATION: these are plain TS types because every scene in the app
 * today is a built-in literal in `lib/callScenes.ts` — nothing untrusted
 * produces one. When scenes become user data crossing the IPC bridge, this
 * file is where the Zod schema goes, alongside the types.
 */

/**
 * One visual slot: still art, a cycled frame loop, or a video.
 *
 * `images` with a single entry is a still. With several it is an ambient loop
 * (Sui's grass sway, a mouth flap) advanced every `frameMs`. Frames are
 * cross-toggled by opacity rather than swapped in `src`, so a loop never
 * flickers on decode — which means all frames of every paint in a scene are
 * mounted at once. Keep frame counts small.
 */
export type ScenePaint =
  | { kind: 'images'; images: string[]; frameMs?: number }
  | { kind: 'video'; src: string };

/** A backdrop layer. Layers fill the stage exactly; they are never cropped. */
export interface SceneLayer {
  paint: ScenePaint;
}

/**
 * The character on the stage.
 *
 * `idle` is the only required pose. A scene with no `talk` simply does not
 * flap (the character stands and speaks), and one with no `walk` fades in at
 * its rest position instead of striding on. Degrading rather than erroring
 * matters because the eventual customization UI will let people supply one
 * image and nothing else.
 */
export interface SceneActor {
  idle: ScenePaint;
  talk?: ScenePaint;
  walk?: ScenePaint;

  /** Sprite aspect ratio, width / height. Fixes the box before art decodes. */
  aspect: number;

  /**
   * Which way the art is drawn facing. The entrance mirrors the sprite
   * (CSS scaleX) when the walk direction disagrees with this, so a scene only
   * ever ships one set of frames.
   */
  facing: 'left' | 'right';

  /** Where the character comes to rest, as fractions of the stage. */
  rest: {
    /** Horizontal centre. 0.5 is dead centre. */
    centerX: number;
    /** Distance from the stage bottom to the sprite box's bottom edge. */
    bottom: number;
    /** Sprite box width. */
    width: number;
  };

  /** The walk-in. */
  entrance: {
    /** Edge she starts off-stage from. */
    from: 'left' | 'right';
    /** Slide duration. The walk loop and bob run for exactly this long. */
    durationMs: number;
    /**
     * Vertical bob amplitude as a fraction of sprite height, snapped in step
     * with the walk frames. 0 disables it. A drawn bounce, not a tween.
     */
    bob?: number;
    /**
     * How far into the stage the actor walks before she is painted in FRONT of
     * the `front` layers instead of behind them, as a fraction of the stage
     * measured from the entry edge (260731).
     *
     * The seam exists because "behind the foreground" is only true out where
     * the foreground is between you and her. Once she has walked past it she is
     * standing nearer than it is, and keeping her behind it reads as her being
     * stuck in the far distance. Omit it and she stays behind the front layers
     * for the whole scene, which is the original behaviour.
     *
     * Measured against the sprite BOX's centre — the only position the renderer
     * knows, since art alpha bounds are not inspected.
     */
    frontAfter?: number;
  };
}

/** A complete call scene. */
export interface CallScene {
  /** Stable id — what the saved view preference and any future sync key on. */
  id: string;
  /** Stage aspect ratio, width / height. The art's own aspect. */
  stageAspect: number;
  /** Flat colour behind everything, covering letterboxing on extreme windows. */
  backdropColor: string;
  /** Painted behind the character, back to front. */
  back: SceneLayer[];
  /** Painted in front of the character, back to front. */
  front: SceneLayer[];
  actor: SceneActor;
  /**
   * Footstep samples, played on the walk frame swap so they cannot drift from
   * the legs. Alternated in order so consecutive steps differ.
   */
  footsteps?: string[];
}
