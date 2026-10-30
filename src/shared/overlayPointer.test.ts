import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  overlayChromeVisible,
  pointerOverRect,
  samplePointer,
  shouldPushPointer,
  type OverlayPointerSample,
} from './overlayPointer';

const here = dirname(fileURLToPath(import.meta.url));

// Default overlay window: 76px tile + paddings at the bottom-right of a screen.
const WIN = { x: 674, y: 486, width: 104, height: 92 };

describe('samplePointer', () => {
  it('maps a screen point inside the window to window-local coordinates', () => {
    expect(samplePointer({ x: 726, y: 532 }, WIN)).toEqual({ inside: true, x: 52, y: 46 });
  });

  it('treats the top-left edge as inside and the far edges as outside', () => {
    expect(samplePointer({ x: 674, y: 486 }, WIN).inside).toBe(true);
    expect(samplePointer({ x: 674 + 104, y: 500 }, WIN).inside).toBe(false);
    expect(samplePointer({ x: 700, y: 486 + 92 }, WIN).inside).toBe(false);
  });

  it('is outside to the left/above', () => {
    expect(samplePointer({ x: 10, y: 10 }, WIN).inside).toBe(false);
    expect(samplePointer({ x: 673, y: 500 }, WIN).inside).toBe(false);
  });
});

describe('shouldPushPointer', () => {
  const inside: OverlayPointerSample = { inside: true, x: 5, y: 5 };
  const outside: OverlayPointerSample = { inside: false, x: -500, y: -400 };

  it('pushes every sample while inside', () => {
    expect(shouldPushPointer(null, inside)).toBe(true);
    expect(shouldPushPointer(inside, inside)).toBe(true);
    expect(shouldPushPointer(outside, inside)).toBe(true);
  });

  it('pushes only the first sample after leaving (and the very first one)', () => {
    expect(shouldPushPointer(inside, outside)).toBe(true);
    expect(shouldPushPointer(null, outside)).toBe(true);
    expect(shouldPushPointer(outside, outside)).toBe(false);
  });
});

describe('pointerOverRect', () => {
  const col = { left: 76, top: 0, right: 108, bottom: 58 };

  it('hits the button column only while the polled pointer is inside it', () => {
    expect(pointerOverRect({ inside: true, x: 90, y: 40 }, col)).toBe(true);
    expect(pointerOverRect({ inside: true, x: 40, y: 40 }, col)).toBe(false);
    expect(pointerOverRect({ inside: false, x: 90, y: 40 }, col)).toBe(false);
  });

  it('never hits with no sample or no column', () => {
    expect(pointerOverRect(null, col)).toBe(false);
    expect(pointerOverRect({ inside: true, x: 90, y: 40 }, null)).toBe(false);
  });
});

describe('overlayChromeVisible (the pencil)', () => {
  // 261028 report: on a Live2D avatar the pencil never appeared. Hover came
  // ONLY from DOM pointer events, which exist in view mode only when the OS
  // forwards mouse moves into the click-through window.
  it('shows the pencil from the polled pointer alone, with no DOM hover', () => {
    expect(
      overlayChromeVisible({
        domHovered: false,
        polled: { inside: true, x: 52, y: 46 },
        editing: false,
      }),
    ).toBe(true);
  });

  it('still shows on DOM hover alone (platforms where forwarding works)', () => {
    expect(overlayChromeVisible({ domHovered: true, polled: null, editing: false })).toBe(true);
  });

  it('always shows in edit mode, so the tick to leave it is never lost', () => {
    expect(
      overlayChromeVisible({
        domHovered: false,
        polled: { inside: false, x: -1, y: -1 },
        editing: true,
      }),
    ).toBe(true);
  });

  it('hides when the pointer is away and nothing else holds it', () => {
    expect(
      overlayChromeVisible({
        domHovered: false,
        polled: { inside: false, x: -300, y: 20 },
        editing: false,
      }),
    ).toBe(false);
    expect(overlayChromeVisible({ domHovered: false, polled: null, editing: false })).toBe(false);
  });
});

// Source contract: the overlay must not gate its chrome on the avatar kind,
// and main must poll the cursor for every tile kind, not only Live2D.
describe('overlay wiring (source contract)', () => {
  const overlayTsx = readFileSync(resolve(here, '../renderer/src/CallOverlay.tsx'), 'utf-8');
  const mainTs = readFileSync(resolve(here, '../main/callOverlay.ts'), 'utf-8');

  it('CallOverlay renders the chrome from overlayChromeVisible', () => {
    expect(overlayTsx).toMatch(/overlayChromeVisible\(/);
    expect(overlayTsx).toMatch(/onAvatarOverlayPointer/);
    expect(overlayTsx).not.toMatch(/\{\(hovered \|\| editing\) && \(/);
  });

  it('main polls the pointer whenever the overlay window is up', () => {
    expect(mainTs).toMatch(/overlayPointerState/);
    expect(mainTs).toMatch(/samplePointer\(/);
  });
});
