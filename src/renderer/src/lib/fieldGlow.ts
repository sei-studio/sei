/**
 * fieldGlow — where the window's one glow patch sits (quiet register,
 * product call 261110).
 *
 * The app has ONE background, the update window's dotted field
 * (components/FieldBackdrop). Each screen places its single glow patch at an
 * edge, never under body text, and a dark pocket behind its main text block.
 * A screen asks for its placement with `useFieldGlow('<preset>')`; screens
 * that ask for nothing get the quiet default.
 *
 * Geometry is in window fractions (the mockups were drawn at 1440x900), so the
 * patch scales with the window. Patch = the update card's glow (460x224 units)
 * placed at x/y with size w/h; pocket = an ellipse centred at cx/cy.
 */
import { useEffect } from 'react';
import { create } from 'zustand';

export interface FieldPatch {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 0..1, multiplies the whole patch. */
  strength: number;
  /** Mirror the card geometry (the glow's bright end on the left). */
  flip?: boolean;
}

export interface FieldPocket {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  /** Peak darkening, 0..1 (dark themes; light themes lift it a little). */
  a: number;
}

export interface FieldGlowSpec {
  patch: FieldPatch;
  pocket: FieldPocket;
  /** Edge vignette strength (dark themes only). */
  vignette: number;
}

const W = 1440;
const H = 900;
const patch = (x: number, y: number, w: number, h: number, strength: number, flip = false): FieldPatch => ({
  x: x / W,
  y: y / H,
  w: w / W,
  h: h / H,
  strength,
  flip,
});
const pocket = (cx: number, cy: number, rx: number, ry: number, a: number): FieldPocket => ({
  cx: cx / W,
  cy: cy / H,
  rx: rx / W,
  ry: ry / H,
  a,
});

/** The placements from the 261110 mockups. */
export const FIELD_GLOWS = {
  /** Along the bottom, under the Up next line. */
  home: { patch: patch(300, 610, 1300, 400, 0.95), pocket: pocket(560, 812, 560, 120, 0.62), vignette: 0.5 },
  /** Bottom right, behind the companion's ambient portrait. */
  chat: { patch: patch(860, 560, 900, 440, 0.85, true), pocket: pocket(460, 520, 560, 560, 0.72), vignette: 0.45 },
  /** Faint, bottom right, away from the rows. */
  settings: { patch: patch(980, 640, 760, 380, 0.7, true), pocket: pocket(720, 420, 620, 560, 0.6), vignette: 0.45 },
  /** Every screen that has not been given its own placement yet. */
  quiet: { patch: patch(1000, 680, 720, 340, 0.55, true), pocket: pocket(720, 420, 700, 560, 0.55), vignette: 0.45 },
} satisfies Record<string, FieldGlowSpec>;

export type FieldGlowName = keyof typeof FIELD_GLOWS;

interface FieldGlowState {
  glow: FieldGlowName;
  set: (g: FieldGlowName) => void;
}

export const useFieldGlowStore = create<FieldGlowState>((set) => ({
  glow: 'quiet',
  set: (glow) => set({ glow }),
}));

/** Place the field's glow for this screen while it is mounted. */
export function useFieldGlow(name: FieldGlowName): void {
  useEffect(() => {
    useFieldGlowStore.getState().set(name);
    return () => {
      if (useFieldGlowStore.getState().glow === name) useFieldGlowStore.getState().set('quiet');
    };
  }, [name]);
}
