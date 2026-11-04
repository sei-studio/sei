/** look()'s shelf-lip cut and soft-top sink (261105 shelf pass). */
import { describe, expect, it } from 'vitest';
import type { ItemLayer } from '../../shared/seilinkDraw';
import type { RoomComponent } from '../../shared/seilinkRoom';
import { cutToPolygons, sinkItem } from './roomRender';

const solid = (w: number, h: number): Buffer => Buffer.alloc(w * h * 4, 255);

describe('cutToPolygons', () => {
  it('keeps only the pixels inside the lip, cropped to it', () => {
    const data = solid(100, 100);
    const lip = [[10, 40], [60, 40], [60, 50], [10, 50]] as [number, number][];
    const cut = cutToPolygons(data, { left: 0, top: 0, width: 100, height: 100 }, [lip], 1)!;
    expect(cut).toMatchObject({ left: 10, top: 40, width: 50, height: 10 });
    expect(cut.data.every((v) => v === 255)).toBe(true);
    // A slanted lip: the triangle half only.
    const tri = cutToPolygons(data, { left: 0, top: 0, width: 100, height: 100 }, [[[0, 0], [20, 0], [0, 20]]], 1)!;
    let opaque = 0;
    for (let i = 3; i < tri.data.length; i += 4) if (tri.data[i]) opaque++;
    expect(opaque).toBeGreaterThan(180);
    expect(opaque).toBeLessThan(220);
    // At half scale, in output px.
    expect(cutToPolygons(data, { left: 0, top: 0, width: 100, height: 100 }, [lip], 0.5)).toMatchObject({ left: 5, top: 20, width: 25, height: 5 });
    // Off the part: nothing.
    expect(cutToPolygons(data, { left: 0, top: 0, width: 100, height: 100 }, [[[200, 200], [300, 200], [300, 300]]], 1)).toBeNull();
  });
});

describe('sinkItem', () => {
  const item = (sink: ItemLayer['sink']): ItemLayer => ({
    kind: 'item',
    z: 50.5,
    index: 0,
    component: { id: 'books', slot: 'item', name: 'books', frames: {} } as unknown as RoomComponent,
    frame: { src: 'bk.webp' },
    x: 50,
    y: 100,
    scale: 1,
    flip: false,
    size: [40, 40],
    tint: null,
    sink,
  });

  it('moves the sprite down by the sink, fades its base out and puts a shadow at the contact', () => {
    const data = solid(40, 40);
    const r = sinkItem(item({ depth: 8, foot: 10 }), data, { left: 30, top: 60, width: 40, height: 40 }, 1)!;
    expect(r.place).toMatchObject({ left: 30, top: 68 });
    const alpha = (v: number) => data[(v * 40 + 20) * 4 + 3];
    // Contact at 90 (anchor 100 minus foot): kept well above, faded around it, gone below.
    expect(alpha(5)).toBe(255);
    expect(alpha(90 - 68 - 4)).toBe(255);
    expect(alpha(90 - 68)).toBeGreaterThan(0);
    expect(alpha(90 - 68)).toBeLessThan(255);
    expect(alpha(39)).toBe(0);
    // The shadow straddles the contact line, about as wide as the base.
    const sh = r.shadow;
    expect(sh.top).toBeLessThan(90);
    expect(sh.top + sh.height).toBeGreaterThan(90);
    expect(sh.width).toBeGreaterThan(40);
    expect(sh.width).toBeLessThan(56);
    expect(sh.data[((sh.height >> 1) * sh.width + (sh.width >> 1)) * 4 + 3]).toBeGreaterThan(60);
  });

  it('leaves an item on a hard top alone', () => {
    const data = solid(40, 40);
    expect(sinkItem(item(null), data, { left: 30, top: 60, width: 40, height: 40 }, 1)).toBeNull();
    expect(data.every((v) => v === 255)).toBe(true);
  });
});
