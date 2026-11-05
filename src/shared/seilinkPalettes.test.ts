/**
 * Curated palettes (261105 colour pass, T333): every recolourable part of the
 * bundled packs offers its own palette, the shipped look stays the first
 * swatch, and rooms saved with an older palette's colours draw the same.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultRoomState, describeRoom, ROOM_PRESET_IDS, type RoomPresetManifest, type RoomState } from './seilinkRoom';
import { parseRoomManifest, sanitizeRoomState } from './seilinkValidate';
import { roomDrawPlan, type SlotLayer, type ItemLayer } from './seilinkDraw';
import { accentSwatchesFor, DEFAULT_ACCENT_SWATCHES, DEFAULT_SWATCHES, isPresetColour, PALETTE_SIZE, swatchesFor } from './seilinkEdit';
import { roomShapeOf } from './seilinkTelemetry';

const pack = (id: string): RoomPresetManifest =>
  parseRoomManifest(JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../resources/seilink-packs/${id}/manifest.json`), 'utf8')))!;

/** Default tints as shipped before the colour pass: a room nobody recoloured must not change. */
const SHIPPED_DEFAULTS: Record<string, string> = {
  cozy_room: '#b5c2a0',
  // 261106: the blank first room's walls (decorated together; white is the point).
  blank_room: '#ffffff',
  round_rug: '#eae3d6',
  linen_curtains: '#ece6da',
  wooden_bed: '#f3eee4',
  cushion: '#e3a9a6',
  gamer_room: '#424b63',
  platform_bed: '#6a7698',
  led_strip: '#7fb0ff',
  gaming_chair: '#9cc4ff',
  canvas_tent: '#ede7db',
  log_seat: '#b0473f',
};

describe('bundled pack palettes', () => {
  for (const id of ROOM_PRESET_IDS) {
    const m = pack(id);
    it(`${id}: every tintable part has a curated palette led by its shipped colour`, () => {
      const tintable = m.components.filter((c) => c.tintable);
      expect(tintable.length).toBeGreaterThan(0);
      for (const c of tintable) {
        expect(c.swatches, c.id).toBeDefined();
        expect(c.defaultTint?.toLowerCase(), c.id).toBe(SHIPPED_DEFAULTS[c.id]);
        const row = swatchesFor(c);
        expect(row[0], c.id).toBe(SHIPPED_DEFAULTS[c.id]);
        // Eight cells; a light with a colour cycle gives one to the cycle swatch. Nothing was deduped away.
        expect(row.length, c.id).toBe(c.cycle ? PALETTE_SIZE - 1 : PALETTE_SIZE);
        expect(new Set(row).size).toBe(row.length);
      }
    });
    it(`${id}: patterned parts have their own second-colour palette`, () => {
      for (const c of m.components.filter((x) => x.tintable && (x.patternSurface || x.patterns))) {
        expect(c.accentSwatches, c.id).toBeDefined();
        expect(accentSwatchesFor(c).length, c.id).toBe(PALETTE_SIZE - 1);
      }
    });
  }

  it('parts without a palette get the house sets', () => {
    const c = { id: 'x', slot: 'item' as const, name: 'x', tintable: true, defaultTint: '#123456', frames: { day: { src: 'x.webp', mask: 'xm.webp' } } };
    expect(swatchesFor(c)).toEqual(['#123456', ...DEFAULT_SWATCHES.slice(0, PALETTE_SIZE - 1)]);
    expect(accentSwatchesFor(c)).toEqual([...DEFAULT_ACCENT_SWATCHES]);
    expect(swatchesFor({ ...c, cycle: true })).toHaveLength(PALETTE_SIZE - 1);
  });

  it('keeps accentSwatches through validation, lower-cased, hex only', () => {
    const raw = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../resources/seilink-packs/cozy/manifest.json'), 'utf8'));
    raw.components.find((c: { id: string }) => c.id === 'linen_curtains').accentSwatches = ['#ABCDEF', 'red', '#123456'];
    const m = parseRoomManifest(raw)!;
    expect(m.components.find((c) => c.id === 'linen_curtains')?.accentSwatches).toEqual(['#abcdef', '#123456']);
  });
});

describe('rooms saved with an older palette', () => {
  // Colours from the palettes before the colour pass, now gone from the rows.
  const cases: Array<{ preset: 'cozy' | 'gamer' | 'forest'; slot: 'curtains' | 'lamp' | 'bed'; tint: string }> = [
    { preset: 'cozy', slot: 'curtains', tint: '#c9b6d8' },
    { preset: 'gamer', slot: 'lamp', tint: '#ff4d5e' },
    { preset: 'gamer', slot: 'bed', tint: '#8c6fb8' },
    { preset: 'forest', slot: 'bed', tint: '#34466b' },
  ];
  for (const { preset, slot, tint } of cases) {
    it(`${preset} ${slot} ${tint} draws, reads and names exactly as stored`, () => {
      const m = pack(preset);
      const saved: RoomState = { ...defaultRoomState(preset), time: 'day', slots: { [slot]: { id: m.slots[slot]!.options[0], tint } } };
      const state = sanitizeRoomState(m, JSON.parse(JSON.stringify(saved)));
      expect(state.slots[slot]?.tint).toBe(tint);
      const layer = roomDrawPlan(m, state, 'day', { avatar: false }).layers.find((l): l is SlotLayer => l.kind === 'slot' && l.slot === slot);
      expect(layer?.tint).toBe(tint);
      const comp = m.components.find((c) => c.id === m.slots[slot]!.options[0])!;
      // The editor shows it on the custom swatch, not as a preset.
      expect(isPresetColour(swatchesFor(comp), tint)).toBe(false);
      expect(roomShapeOf(m, state).customColors).toBe(1);
      expect(describeRoom(m, state).things.length).toBeGreaterThan(0);
    });
  }

  it('an item tint from the old house set stays', () => {
    const m = pack('cozy');
    const saved: RoomState = { ...defaultRoomState('cozy'), items: [{ id: 'cushion', x: 1900, y: 1350, tint: '#a9bfd9' }] };
    const state = sanitizeRoomState(m, saved);
    expect(state.items[0]?.tint).toBe('#a9bfd9');
    const layer = roomDrawPlan(m, state, 'day', { avatar: false }).layers.find((l): l is ItemLayer => l.kind === 'item');
    expect(layer?.tint).toBe('#a9bfd9');
  });

  it('an untouched room has no custom colours', () => {
    for (const id of ROOM_PRESET_IDS) expect(roomShapeOf(pack(id), defaultRoomState(id)).customColors).toBe(0);
  });
});
