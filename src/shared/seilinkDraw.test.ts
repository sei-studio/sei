import { describe, expect, it } from 'vitest';
import { defaultRoomState, describeRoom, type RoomPresetManifest } from './seilinkRoom';
import { glowAlpha, itemRect, planFiles, roomDrawPlan, roomOverlay, roomTimeMix, roomTimeMixAt, roomViewport, splitAtAvatar, viewportToCanvas } from './seilinkDraw';
import { isSafeRoomPackPath, parseRoomManifest, sanitizeRoomState } from './seilinkValidate';

const manifest: RoomPresetManifest = {
  format: 'sei-room',
  version: 1,
  id: 'cozy',
  place: 'your bedroom',
  canvas: [1920, 1080],
  avatar: { x: 960, y: 1080, height: 820 },
  slots: {
    view: { z: 0, options: ['view-city'] },
    shell: { z: 10, options: ['shell-cozy'] },
    curtains: { z: 20, options: ['curtains-plain'] },
    lamp: { z: 50, options: ['lamp-green'], optional: true },
    chair: { z: 90, options: ['chair-office'] },
    rug: { z: 110, options: ['rug-round'], optional: true },
  },
  components: [
    { id: 'view-city', slot: 'view', name: 'city view', frames: { day: { src: 'view/day.webp' }, night: { src: 'view/night.webp' } } },
    { id: 'shell-cozy', slot: 'shell', name: 'room', frames: { day: { src: 'shell/day.webp' } } },
    { id: 'curtains-plain', slot: 'curtains', name: 'curtains', tintable: true, defaultTint: '#7b4fc9', frames: { day: { src: 'c.webp', mask: 'cm.webp' } } },
    { id: 'lamp-green', slot: 'lamp', name: 'green lamp', frames: { day: { src: 'l.webp' }, night: { src: 'ln.webp', glow: 'lg.webp', effect: 'pulse' } } },
    { id: 'chair-office', slot: 'chair', name: 'desk chair', frames: { day: { src: 'ch.webp' } } },
    { id: 'rug-round', slot: 'rug', name: 'round rug', frames: { day: { src: 'r.webp' } } },
    { id: 'plant', slot: 'item', name: 'monstera', placement: 'floor', frames: { day: { src: 'p.webp' } } },
    { id: 'poster', slot: 'item', name: 'poster', placement: 'wall', box: [0, 0, 200, 300], frames: { day: { src: 'po.webp' } } },
  ],
  overlay: { day: '#f1e8dc', night: '#141826' },
};

describe('roomDrawPlan', () => {
  it('orders slots, the avatar and items by z with slot < avatar < item on ties', () => {
    const s = defaultRoomState('cozy');
    s.items.push({ id: 'plant', x: 300, y: 1000 }, { id: 'poster', x: 500, y: 400 }, { id: 'plant', x: 700, y: 1000, z: 100 });
    const plan = roomDrawPlan(manifest, s, 'day');
    const names = plan.layers.map((l) => (l.kind === 'slot' ? l.slot : l.kind === 'item' ? `item${l.index}` : 'avatar'));
    expect(names).toEqual(['view', 'shell', 'item1', 'curtains', 'lamp', 'item0', 'chair', 'avatar', 'item2', 'rug']);
    const { back, front } = splitAtAvatar(plan);
    expect(back).toHaveLength(7);
    expect(front.map((l) => l.kind)).toEqual(['item', 'slot']);
  });

  it('falls back to day frames, tints only masked tintables, lists glows with effects', () => {
    const s = defaultRoomState('cozy');
    const night = roomDrawPlan(manifest, s, 'night');
    const view = night.layers.find((l) => l.kind === 'slot' && l.slot === 'view');
    expect(view && view.kind === 'slot' && view.frame.src).toBe('view/night.webp');
    const shell = night.layers.find((l) => l.kind === 'slot' && l.slot === 'shell');
    expect(shell && shell.kind === 'slot' && shell.frame.src).toBe('shell/day.webp');
    const curtains = night.layers.find((l) => l.kind === 'slot' && l.slot === 'curtains');
    expect(curtains && curtains.kind === 'slot' && curtains.tint).toBe('#7b4fc9');
    expect(night.glows).toEqual([expect.objectContaining({ src: 'lg.webp', effect: 'pulse', z: 50 })]);
    expect(roomDrawPlan(manifest, s, 'day').glows).toEqual([]);
    expect(planFiles(night)).toContain('cm.webp');
  });

  it('can leave her out (look() renders the room without her)', () => {
    const plan = roomDrawPlan(manifest, defaultRoomState('cozy'), 'day', { avatar: false });
    expect(plan.layers.some((l) => l.kind === 'avatar')).toBe(false);
  });

  it('anchors item sprites at their bottom centre', () => {
    const s = defaultRoomState('cozy');
    s.items.push({ id: 'plant', x: 300, y: 1000, scale: 2 }, { id: 'poster', x: 500, y: 400 });
    const plan = roomDrawPlan(manifest, s, 'day');
    const item = (i: number) => plan.layers.find((l) => l.kind === 'item' && l.index === i) as Parameters<typeof itemRect>[0];
    expect(itemRect(item(1), [10, 10])).toEqual([400, 100, 200, 300]);
    expect(itemRect(item(0), [100, 150])).toEqual([200, 700, 200, 300]);
  });
});

describe('room time crossfade', () => {
  it('fades for 30 minutes after each boundary, then holds', () => {
    expect(roomTimeMixAt(new Date(2026, 10, 4, 12, 0))).toEqual({ from: 'day', to: 'day', t: 1 });
    const m = roomTimeMixAt(new Date(2026, 10, 4, 17, 15));
    expect(m.from).toBe('day');
    expect(m.to).toBe('dusk');
    expect(m.t).toBeCloseTo(0.5, 5);
    expect(roomTimeMixAt(new Date(2026, 10, 4, 19, 30)).from).toBe('dusk');
    expect(roomTimeMixAt(new Date(2026, 10, 4, 5, 6)).from).toBe('night');
    expect(roomTimeMixAt(new Date(2026, 10, 4, 7, 29)).to).toBe('day');
    expect(roomTimeMixAt(new Date(2026, 10, 4, 7, 31)).t).toBe(1);
  });

  it('a fixed room time never fades with the clock', () => {
    expect(roomTimeMix({ time: 'night' }, new Date(2026, 10, 4, 17, 10))).toEqual({ from: 'night', to: 'night', t: 1 });
  });
});

describe('roomOverlay', () => {
  it('uses the manifest colour per time, light room gets a light overlay', () => {
    expect(roomOverlay(manifest, { from: 'day', to: 'day', t: 1 })).toEqual({ color: '#f1e8dc', light: true, ink: '#1d1b22' });
    expect(roomOverlay(manifest, { from: 'night', to: 'night', t: 1 }).light).toBe(false);
    const mid = roomOverlay(manifest, { from: 'day', to: 'night', t: 0.5 });
    expect(mid.color).not.toBe('#f1e8dc');
    expect(roomOverlay({}, { from: 'dusk', to: 'dusk', t: 1 }, { dusk: '#ffffff' }).light).toBe(true);
  });
});

describe('seilink validation', () => {
  it('accepts only plain relative image paths', () => {
    expect(isSafeRoomPackPath('shell/day.webp')).toBe(true);
    for (const bad of ['../x.webp', '/abs.webp', 'a\\b.webp', 'a//b.webp', 'x.json', 'C:/x.webp', './x.webp', '']) {
      expect(isSafeRoomPackPath(bad)).toBe(false);
    }
  });

  it('parses a good manifest and rejects traversal or a tintable without a mask', () => {
    const json = JSON.parse(JSON.stringify(manifest));
    const m = parseRoomManifest(json);
    expect(m?.components).toHaveLength(manifest.components.length);
    expect(describeRoom(m!, defaultRoomState('cozy')).things).toContain('purple curtains');
    const bad = JSON.parse(JSON.stringify(manifest));
    bad.components[0].frames.day.src = '../../etc/passwd.webp';
    expect(parseRoomManifest(bad)).toBeNull();
    const noMask = JSON.parse(JSON.stringify(manifest));
    delete noMask.components[2].frames.day.mask;
    expect(parseRoomManifest(noMask)).toBeNull();
    const badOption = JSON.parse(JSON.stringify(manifest));
    badOption.slots.view.options = ['nope'];
    expect(parseRoomManifest(badOption)).toBeNull();
    const wrongSlot = JSON.parse(JSON.stringify(manifest));
    wrongSlot.slots.view.options = ['shell-cozy'];
    expect(parseRoomManifest(wrongSlot)).toBeNull();
    expect(parseRoomManifest({ ...json, format: 'other' })).toBeNull();
  });

  it('sanitizes a stored state against the manifest', () => {
    const s = sanitizeRoomState(manifest, {
      version: 1,
      preset: 'cozy',
      time: 'night',
      slots: {
        curtains: { id: 'curtains-plain', tint: '#2F6FD6' },
        chair: { id: null },
        lamp: { id: null },
        view: { id: 'shell-cozy' },
        bogus: { id: 'x' },
      },
      items: [{ id: 'plant', x: 1, y: 2, scale: 99 }, { id: 'view-city', x: 1, y: 1 }, { id: 'poster', x: 'a', y: 1 }],
      avatar: { kind: 'live2d', modelPath: 'abc' },
    });
    expect(s.time).toBe('night');
    expect(s.slots).toEqual({ curtains: { id: 'curtains-plain', tint: '#2f6fd6' }, lamp: { id: null } });
    expect(s.items).toEqual([{ id: 'plant', x: 1, y: 2 }]);
    expect(s.avatar).toEqual({ kind: 'live2d', modelPath: 'abc' });
    expect(sanitizeRoomState(manifest, { preset: 'gamer' })).toEqual(defaultRoomState('cozy'));
    expect(sanitizeRoomState(manifest, 'junk')).toEqual(defaultRoomState('cozy'));
  });
});

describe('roomViewport', () => {
  it('covers (crops) or contains (letterboxes) and maps points back to canvas px', () => {
    const cover = roomViewport([1920, 1080], 1000, 1000, 'cover');
    expect(cover.scale).toBeCloseTo(1000 / 1080, 6);
    expect(cover.top).toBe(0);
    expect(cover.left).toBeLessThan(0);
    const contain = roomViewport([1920, 1080], 1000, 1000, 'contain');
    expect(contain.width).toBeCloseTo(1000, 6);
    expect(contain.top).toBeGreaterThan(0);
    const [x, y] = viewportToCanvas(contain, contain.left + 500, contain.top + contain.height);
    expect(x).toBeCloseTo(960, 6);
    expect(y).toBeCloseTo(1080, 6);
    expect(roomViewport([1920, 1080], 0, 10).scale).toBe(0);
  });
});

describe('glowAlpha', () => {
  it('stays inside a gentle band for every effect', () => {
    for (const e of ['pulse', 'flicker', null] as const) {
      for (let ms = 0; ms < 20000; ms += 137) {
        const a = glowAlpha(e, ms, 1);
        expect(a).toBeGreaterThanOrEqual(0.6);
        expect(a).toBeLessThanOrEqual(1);
      }
    }
  });
});
