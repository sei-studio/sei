/** look()'s shelf-lip cut and soft-top sink (261105 shelf pass). */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ItemLayer } from '../../shared/seilinkDraw';
import { LIP_TUCK } from '../../shared/seilinkPlace';
import { defaultRoomState, type RoomComponent, type RoomPresetManifest } from '../../shared/seilinkRoom';
import { cutToPolygons, keepInside, renderRoomImage, sinkItem } from './roomRender';

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

describe('keepInside', () => {
  it('clears the pixels outside the polygons, in output px', () => {
    // At 2 output px per canvas px, a keep polygon down to canvas y 2.5 keeps output rows 0..4.
    const data = solid(10, 10);
    keepInside(data, { left: 0, top: 0, width: 10, height: 10 }, [[[0, 0], [20, 0], [20, 2.5], [0, 2.5]]], 2);
    const alpha = (u: number, v: number) => data[(v * 10 + u) * 4 + 3];
    expect(alpha(5, 4)).toBe(255);
    expect(alpha(5, 5)).toBe(0);
    expect(alpha(5, 9)).toBe(0);
    // Colour is left alone; only alpha goes.
    expect(data[(9 * 10 + 5) * 4]).toBe(255);
  });
});

describe('look() over a shelf', () => {
  it('draws the lip over an item at the front of its top, and nothing of the item under the plank', async () => {
    const req = createRequire(import.meta.url);
    const sharp = req(req.resolve('sharp', { paths: [path.dirname(req.resolve('img2skin/package.json'))] })) as (
      input?: unknown,
      opts?: Record<string, unknown>,
    ) => {
      png(): { toBuffer(): Promise<Buffer> };
      raw(): { toBuffer(o: { resolveWithObject: true }): Promise<{ data: Buffer; info: { width: number; height: number; channels: number } }> };
    };
    const dir = await mkdtemp(path.join(tmpdir(), 'sei-lip-'));
    try {
      const W = 200;
      const H = 100;
      // White walls; a shelf whose plank has a grey top face (y 40..50) and a red front face (50..60).
      const raw = (fill: (x: number, y: number) => [number, number, number, number] | null, w = W, h = H): Buffer => {
        const b = Buffer.alloc(w * h * 4);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const c = fill(x, y);
          if (c) b.set(c, (y * w + x) * 4);
        }
        return b;
      };
      const png = (b: Buffer, w = W, h = H) => sharp(b, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
      await writeFile(path.join(dir, 'shell.png'), await png(raw(() => [255, 255, 255, 255])));
      await writeFile(
        path.join(dir, 'shelf.png'),
        await png(raw((x, y) => (x < 20 || x >= 180 || y < 40 || y >= 60 ? null : y < 50 ? [128, 128, 128, 255] : [255, 0, 0, 255]))),
      );
      // A blue box, 40 x 40, its contact 10 px above its bottom (a long soft shadow).
      await writeFile(path.join(dir, 'box.png'), await png(raw(() => [0, 0, 255, 255], 40, 40), 40, 40));
      const manifest: RoomPresetManifest = {
        format: 'sei-room',
        version: 1,
        id: 'cozy',
        place: 'a test room',
        canvas: [W, H],
        avatar: { x: 100, y: 100, height: 50 },
        wallAreas: [[[0, 0], [W, 0], [W, 30], [0, 30]]],
        slots: { shell: { z: 10, options: ['shell'] }, shelf: { z: 40, options: ['shelf'] } },
        components: [
          { id: 'shell', slot: 'shell', name: 'walls', frames: { day: { src: 'shell.png' } } },
          {
            id: 'shelf',
            slot: 'shelf',
            name: 'shelf',
            frames: { day: { src: 'shelf.png' } },
            surfaceTops: [{ area: [[20, 40], [180, 40], [180, 52], [20, 52]], lip: [[19, 50], [181, 50], [181, 60], [19, 60]] }],
          },
          { id: 'box', slot: 'item', name: 'box', placement: 'surface', foot: 10, box: [0, 0, 40, 40], frames: { day: { src: 'box.png' } } },
        ],
      };
      // At the very front of the top: contact LIP_TUCK into the lip, the sprite's bottom 7 px under the plank.
      const y = 52 + LIP_TUCK + 10;
      const state = { ...defaultRoomState('cozy'), time: 'day' as const, items: [{ id: 'box', x: 100, y }] };
      const img = await renderRoomImage({ manifest, state, packDir: dir }, { width: W, quality: 100 });
      const { data, info } = await sharp(img.data).raw().toBuffer({ resolveWithObject: true });
      const px = (x: number, py: number) => {
        const i = (py * info.width + x) * info.channels;
        return [data[i], data[i + 1], data[i + 2]];
      };
      // The box above the plank's front edge.
      expect(px(100, 30)[2]).toBeGreaterThan(200);
      expect(px(100, 30)[0]).toBeLessThan(60);
      // The front face is red all along under the box: the lip is drawn over it.
      for (const fy of [51, 55, 58]) {
        const [r, g, b] = px(100, fy);
        expect(r, `y ${fy}`).toBeGreaterThan(200);
        expect(Math.max(g, b), `y ${fy}`).toBeLessThan(60);
      }
      // Under the plank: the wall, not the box (y - 1 is its last row).
      for (const fy of [61, 64, y - 1]) {
        const [r, g, b] = px(100, fy);
        expect(Math.min(r, g, b), `y ${fy}`).toBeGreaterThan(200);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
