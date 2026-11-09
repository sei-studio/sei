import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PlacementRegions } from '@shared/seilinkPlace';
import { PlacementGuide } from './PlacementGuide';
import styles from './RoomEditor.module.css';

const regions = (over: Partial<PlacementRegions> = {}): PlacementRegions => ({
  canvas: [1000, 600],
  labelled: true,
  perspective: true,
  floor: [
    [
      [0, 400],
      [1000, 400],
      [1000, 600],
      [0, 600],
    ],
  ],
  floorBlocks: [
    [
      [100, 420],
      [300, 420],
      [300, 560],
      [100, 560],
    ],
  ],
  wall: [],
  wallBlocks: [],
  surfaces: [],
  floorTop: 400,
  floorFront: 600,
  horizon: 400,
  ...over,
});
const vp = { scale: 1, left: 0, top: 0, width: 1000, height: 600 };

describe('PlacementGuide (261110: outlines, no blur over the room)', () => {
  it('uses its own class, not the glass panels\' `.guide` (that put a backdrop blur over the whole room)', () => {
    const html = renderToStaticMarkup(<PlacementGuide regions={regions()} cls="floor" surface={-1} vp={vp} canvas={[1000, 600]} />);
    expect(html).toContain('data-guide-mode="outline"');
    if (styles.placeGuide && styles.guide) expect(styles.placeGuide).not.toBe(styles.guide);
    if (styles.guide) expect(html).not.toContain(`class="${styles.guide}"`);
  });
  it('outlines the free floor and the parts cut out of it', () => {
    const html = renderToStaticMarkup(<PlacementGuide regions={regions()} cls="floor" surface={-1} vp={vp} canvas={[1000, 600]} />);
    expect(html).toContain('data-guide-outline="area"');
    expect(html).toContain('data-guide-outline="blocks"');
    expect(html).toMatch(/stroke="rgb\(255 255 255/);
  });
  it('outlines each top for a shelf item, the one under it brighter', () => {
    const face: [number, number][] = [
      [10, 10],
      [90, 10],
      [90, 30],
      [10, 30],
    ];
    const surface = { kind: 'area', face } as unknown as PlacementRegions['surfaces'][number];
    const html = renderToStaticMarkup(
      <PlacementGuide regions={regions({ surfaces: [surface, surface] })} cls="surface" surface={1} vp={vp} canvas={[1000, 600]} />,
    );
    expect(html.match(/data-guide-band="on"/g)).toHaveLength(1);
    expect(html).not.toContain('data-guide-outline="area"');
  });
});
