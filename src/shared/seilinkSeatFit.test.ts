/**
 * 261121 seat fit (product call 261121: "the couch is way too far, it doesn't
 * look like she's sitting on it"): a head-and-shoulders figure gets her chair
 * redrawn larger around her; the chibi the rooms were painted for keeps it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultRoomState, type RoomPresetManifest } from './seilinkRoom';
import { fitBox, roomDrawPlan, seatFitFor, type SlotLayer } from './seilinkDraw';
import { parseRoomManifest } from './seilinkValidate';
import { facepackFigure } from './facepack';

const raw = (id: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../resources/seilink-packs/${id}/manifest.json`), 'utf8')) as Record<string, unknown>;
const bundled = (id: string): RoomPresetManifest => parseRoomManifest(raw(id))!;
const chairOf = (m: RoomPresetManifest, figure?: 'seated' | 'bust' | null): SlotLayer =>
  roomDrawPlan(m, { ...defaultRoomState(m.id), time: 'night' }, 'night', { figure }).layers.find((l): l is SlotLayer => l.kind === 'slot' && l.slot === 'chair')!;

/** Where her figure's top lands (RoomAvatar: SINK 0.07 below the floor line, height x 1.07). */
const hairTop = (m: RoomPresetManifest): number => m.avatar.y + m.avatar.height * 0.07 - m.avatar.height * 1.07;

describe('seat fit in the bundled packs', () => {
  it('cozy and gamer fit their chair for a bust; forest fits nothing', () => {
    expect(bundled('cozy').avatar.fit?.bust).toEqual({ slots: ['chair'], scale: 1.43, origin: [1300, 940] });
    expect(bundled('gamer').avatar.fit?.bust?.slots).toEqual(['chair']);
    expect(bundled('forest').avatar.fit).toBeUndefined();
  });

  it.each([
    // [pack, top row of the chair art (canvas px)]
    ['cozy', 767],
    ['gamer', 505],
  ])('%s: the chair back rises just above a bust hair top, never moves for the seated chibi', (id, artTop) => {
    const m = bundled(id);
    expect(chairOf(m).box).toBeNull();
    expect(chairOf(m, 'seated').box).toBeNull();
    const bust = chairOf(m, 'bust');
    expect(bust.fitted).toBe(true);
    const fit = m.avatar.fit!.bust!;
    const [, y, w, h] = bust.box!;
    expect(w).toBeCloseTo(m.canvas[0] * fit.scale, 6);
    expect(h).toBeCloseTo(m.canvas[1] * fit.scale, 6);
    const backTop = y + artTop * fit.scale;
    // Painted, the back top sat below her hair (cozy 767 vs 720): a bust looked in front of it.
    expect(backTop).toBeLessThan(hairTop(m));
    expect(hairTop(m) - backTop).toBeLessThan(100);
    // Her slot's x stays where it was: the chair grows around her, not beside her.
    expect(fit.origin[0]).toBe(m.avatar.x);
  });

  it('only the fitted slot moves, and glows behind it are cut by it', () => {
    const m = bundled('cozy');
    const state = { ...defaultRoomState('cozy'), time: 'night' as const };
    const plain = roomDrawPlan(m, state, 'night');
    const bust = roomDrawPlan(m, state, 'night', { figure: 'bust' });
    for (const l of bust.layers) {
      if (l.kind !== 'slot' || l.slot === 'chair') continue;
      const p = plain.layers.find((x) => x.kind === 'slot' && x.slot === l.slot) as SlotLayer;
      expect(l.box).toEqual(p.box);
      expect(l.fitted).toBeUndefined();
    }
    const lamp = bust.glows.find((g) => g.owner.kind === 'slot' && g.owner.slot === 'lamp');
    expect(lamp?.occluders?.map((o) => o.slot)).toEqual(['chair']);
    expect(plain.glows.every((g) => g.occluders === undefined)).toBe(true);
  });

  it("gamer's monitor glow belongs to the chair: it scales with it and is not cut by it", () => {
    const m = bundled('gamer');
    const plan = roomDrawPlan(m, { ...defaultRoomState('gamer'), time: 'night' }, 'night', { figure: 'bust' });
    const monitor = plan.glows.find((g) => g.owner.kind === 'slot' && g.owner.slot === 'chair')!;
    expect(monitor.owner.kind === 'slot' && monitor.owner.fitted).toBe(true);
    expect(monitor.occluders).toBeUndefined();
    const led = plan.glows.find((g) => g.owner.kind === 'slot' && g.owner.slot === 'lamp')!;
    expect(led.occluders?.map((o) => o.slot)).toEqual(['chair']);
  });
});

describe('seat fit validation', () => {
  const withFit = (id: string, fit: unknown): RoomPresetManifest | null => {
    const m = raw(id);
    return parseRoomManifest({ ...m, avatar: { ...(m.avatar as object), fit } });
  };

  it('drops a bad fit, never the pack', () => {
    for (const bad of [
      { bust: { slots: ['chair'], scale: 0, origin: [0, 0] } },
      { bust: { slots: ['chair'], scale: 9, origin: [0, 0] } },
      { bust: { slots: ['chair'], scale: 1.4, origin: [0] } },
      { bust: { slots: ['sofa'], scale: 1.4, origin: [0, 0] } },
      { bust: { slots: 'chair', scale: 1.4, origin: [0, 0] } },
      { chibi: { slots: ['chair'], scale: 1.4, origin: [0, 0] } },
      'big',
    ]) {
      const m = withFit('cozy', bad);
      expect(m).not.toBeNull();
      expect(m!.avatar.fit).toBeUndefined();
    }
  });

  it('refuses a slot whose parts hold items (forest log: items on it would float)', () => {
    expect(withFit('forest', { bust: { slots: ['chair'], scale: 1.4, origin: [1300, 1100] } })!.avatar.fit).toBeUndefined();
    expect(withFit('forest', { bust: { slots: ['chair', 'lamp'], scale: 1.4, origin: [1300, 1100] } })!.avatar.fit?.bust?.slots).toEqual(['lamp']);
  });

  it('seatFitFor and fitBox', () => {
    const m = bundled('cozy');
    expect(seatFitFor(m, null)).toBeNull();
    expect(seatFitFor(m, 'seated')).toBeNull();
    expect(seatFitFor(m, 'bust')?.scale).toBe(1.43);
    expect(fitBox(null, [100, 100], { slots: ['chair'], scale: 2, origin: [50, 100] })).toEqual([-50, -100, 200, 200]);
    expect(fitBox([10, 20, 30, 40], [100, 100], { slots: ['chair'], scale: 1, origin: [5, 5] })).toEqual([10, 20, 30, 40]);
  });
});

describe('facepackFigure', () => {
  it('reads the manifest, else the chibi vector set is seated and the rest are busts', () => {
    expect(facepackFigure({ method: 'vector' })).toBe('seated');
    expect(facepackFigure({ method: 'tha3' })).toBe('bust');
    expect(facepackFigure({ method: 'led' })).toBe('bust');
    expect(facepackFigure({ method: 'vector', figure: 'bust' })).toBe('bust');
    expect(facepackFigure({ method: 'tha3', figure: 'seated' })).toBe('seated');
    expect(facepackFigure(null)).toBe('bust');
  });
});
