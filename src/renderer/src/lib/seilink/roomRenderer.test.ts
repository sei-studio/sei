import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bareRoomState, defaultRoomState, type RoomPresetManifest, type RoomState, type RoomTime } from '@shared/seilinkRoom';
import type { RoomUrlResolver } from '@shared/seilinkPack';

// The renderer's canvas and image layer, faked: every pack file "loads" as a
// tagged bitmap and every drawImage of one is logged by its URL, so a test can
// see which pack's files a picture was drawn from.
const drawn: string[] = [];

vi.mock('./roomImages', () => {
  const ctxOf = (canvas: { width: number; height: number }): unknown =>
    new Proxy(
      {
        canvas,
        drawImage: (img: { url?: string }) => {
          if (img?.url) drawn.push(img.url);
        },
        getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(Math.max(1, w * h) * 4) }),
        createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(Math.max(1, w * h) * 4) }),
      } as Record<string | symbol, unknown>,
      {
        get: (t, k) => (k in t ? t[k] : () => undefined),
        set: (t, k, v) => {
          t[k] = v;
          return true;
        },
      },
    );
  const makeCanvas = (w: number, h: number): unknown => {
    const c: Record<string, unknown> = { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) };
    const ctx = ctxOf(c as { width: number; height: number });
    c.getContext = () => ctx;
    return c;
  };
  const bitmap = (url: string): unknown => ({ url, width: 64, height: 64, close: () => undefined });
  return {
    makeCanvas,
    ctx2d: (c: { getContext: () => unknown }) => c.getContext(),
    loadRoomImage: async (url: string) => bitmap(url),
    loadRoomMask: async (url: string) => bitmap(url),
    loadRoomGlow: async (url: string) => ({ bitmap: bitmap(url), x: 0, y: 0, w: 64, h: 64, fw: 64, fh: 64 }),
    loadRoomGlowGrey: async (url: string) => ({ bitmap: bitmap(url), x: 0, y: 0, w: 64, h: 64, fw: 64, fh: 64 }),
    loadPatternTileGrey: async () => ({ w: 1, h: 1, data: new Uint8Array(4) }),
    maskBounds: () => null,
    clearRoomImageCache: () => undefined,
  };
});

const { makeCanvas } = await import('./roomImages');
const { RoomRenderer } = await import('./roomRenderer');

function pack(id: string): RoomPresetManifest {
  return JSON.parse(readFileSync(path.resolve('resources/seilink-packs', id, 'manifest.json'), 'utf8')) as RoomPresetManifest;
}

const packs = { cozy: pack('cozy'), gamer: pack('gamer'), forest: pack('forest') };
// One resolver per pack, made once (as roomEditorSource does with seilinkResolver).
const resolvers: Record<keyof typeof packs, RoomUrlResolver> = {
  cozy: (rel) => `sei-room://cozy/${rel}`,
  gamer: (rel) => `sei-room://gamer/${rel}`,
  forest: (rel) => `sei-room://forest/${rel}`,
};

function newRenderer(): { renderer: InstanceType<typeof RoomRenderer>; ready: () => Promise<void> } {
  let resolveReady: (() => void) | null = null;
  const canvas = (): HTMLCanvasElement => makeCanvas(10, 10) as HTMLCanvasElement;
  const renderer = new RoomRenderer({ back: canvas(), front: canvas(), glow: canvas() }, { onReady: () => resolveReady?.() }, { fadeMs: 0 });
  return {
    renderer,
    ready: () => new Promise<void>((r) => (resolveReady = r)),
  };
}

/** Show a room and wait for its picture; returns the files it was drawn from. */
async function show(r: ReturnType<typeof newRenderer>, id: keyof typeof packs, state: RoomState): Promise<string[]> {
  const ready = r.ready();
  drawn.length = 0;
  r.renderer.setScene(packs[id], state, resolvers[id]);
  await ready;
  return [...drawn];
}

describe('RoomRenderer: switching packs (beta.4: the cozy room kept the gamer chair)', () => {
  beforeEach(() => {
    vi.stubGlobal('document', { addEventListener: () => undefined, removeEventListener: () => undefined, hidden: false, visibilityState: 'visible' });
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
  });
  afterEach(() => vi.unstubAllGlobals());

  for (const time of ['day', 'dusk', 'night'] as RoomTime[]) {
    it(`guided pick at ${time}: gamer -> cozy -> forest -> cozy draws only cozy's own files`, async () => {
      const r = newRenderer();
      r.renderer.setResolution(0.25);
      r.renderer.setMix({ from: time, to: time, t: 1 });
      const keep = { ...defaultRoomState('cozy'), time };
      const gamer = await show(r, 'gamer', bareRoomState(packs.gamer, keep));
      expect(gamer).toContain(`sei-room://gamer/chair_${time}.webp`);

      for (const via of ['gamer', 'forest'] as const) {
        if (via === 'forest') await show(r, 'forest', bareRoomState(packs.forest, keep));
        const cozy = await show(r, 'cozy', bareRoomState(packs.cozy, keep));
        // The chair is required, so the bare room keeps cozy's default (velvet_armchair).
        expect(cozy).toContain(`sei-room://cozy/chair_${time}.webp`);
        expect(cozy.filter((u) => !u.startsWith('sei-room://cozy/'))).toEqual([]);
      }
      r.renderer.dispose();
    });
  }

  it('the editor switch (full rooms) never draws the previous pack', async () => {
    const r = newRenderer();
    r.renderer.setResolution(0.25);
    r.renderer.setMix({ from: 'night', to: 'night', t: 1 });
    await show(r, 'cozy', { ...defaultRoomState('cozy'), time: 'night' });
    const gamer = await show(r, 'gamer', { ...defaultRoomState('gamer'), time: 'night' });
    expect(gamer).toContain('sei-room://gamer/shell_night.webp');
    expect(gamer.filter((u) => !u.startsWith('sei-room://gamer/'))).toEqual([]);
    const cozy = await show(r, 'cozy', { ...defaultRoomState('cozy'), time: 'night' });
    expect(cozy).toContain('sei-room://cozy/shell_night.webp');
    expect(cozy.filter((u) => !u.startsWith('sei-room://cozy/'))).toEqual([]);
    r.renderer.dispose();
  });
});
