import { describe, expect, it } from 'vitest';
import { commitEdit, createHistory, endGesture, markSaved, undo } from './seilinkEdit';
import { defaultRoomState, type RoomState } from './seilinkRoom';
import { EditorSessionTracker, classifyEdit, isSeilinkRendererEvent, sanitizeSeilinkTrack } from './seilinkTelemetry';

const base: RoomState = { ...defaultRoomState('cozy'), items: [{ id: 'plant', x: 10, y: 20 }] };
const CHAR = '3f2c9a1e-8b7d-4c6e-9f0a-1b2c3d4e5f60';

describe('classifyEdit', () => {
  it('names each kind of edit', () => {
    expect(classifyEdit(base, { ...base, slots: { bed: { id: 'bed_b' } } })).toEqual(['swap_component']);
    expect(classifyEdit(base, { ...base, slots: { view: { id: 'city' } } })).toEqual(['view_change']);
    expect(classifyEdit(base, { ...base, slots: { rug: { id: null } } })).toEqual(['remove_slot']);
    expect(classifyEdit(base, { ...base, slots: { bed: { id: 'bed_a', tint: '#ff0000' } } })).toEqual(['recolour']);
    const tinted = { ...base, slots: { bed: { id: 'bed_a', tint: '#ff0000' } } };
    expect(classifyEdit(tinted, { ...base, slots: { bed: { id: 'bed_a', tint: '#00ff00' } } })).toEqual(['recolour']);
    expect(classifyEdit(base, { ...base, items: [...base.items, { id: 'lamp', x: 1, y: 1 }] })).toEqual(['add_item']);
    expect(classifyEdit(base, { ...base, items: [] })).toEqual(['delete_item']);
    expect(classifyEdit(base, { ...base, items: [{ id: 'plant', x: 30, y: 20 }] })).toEqual(['move_item']);
    expect(classifyEdit(base, { ...base, items: [{ id: 'plant', x: 10, y: 20, scale: 1.2 }] })).toEqual(['scale_item']);
    expect(classifyEdit(base, { ...base, items: [{ id: 'plant', x: 10, y: 20, flip: true }] })).toEqual(['flip_item']);
    expect(classifyEdit(base, { ...base, items: [{ id: 'plant', x: 10, y: 20, tint: '#123456' }] })).toEqual(['recolour_item']);
    expect(classifyEdit(base, { ...base, items: [{ id: 'plant', x: 10, y: 20, z: 80 }] })).toEqual(['layer_item']);
    expect(classifyEdit(base, { ...base, time: 'night' })).toEqual(['time_of_day']);
    expect(classifyEdit(base, { ...base, avatar: { kind: 'live2d', modelPath: 'x/y.model3.json' } })).toEqual(['avatar_change']);
    expect(classifyEdit(base, { ...defaultRoomState('gamer') })).toEqual(['preset_change']);
    expect(classifyEdit(base, { ...base })).toEqual([]);
  });

  it('names pattern, accent and light colour edits (261105)', () => {
    expect(classifyEdit(base, { ...base, slots: { bed: { id: 'bed_a', pattern: 'gingham' } } })).toEqual(['pattern_change']);
    const pat = { ...base, slots: { bed: { id: 'bed_a', pattern: 'gingham' } } };
    expect(classifyEdit(pat, { ...base, slots: { bed: { id: 'bed_a', pattern: 'gingham', accent: '#112233' } } })).toEqual(['accent_change']);
    expect(classifyEdit(pat, { ...base, slots: { bed: { id: 'bed_a', pattern: 'plaid' } } })).toEqual(['pattern_change']);
    const lights = new Set(['lights'] as const);
    const lit = { ...base, slots: { lights: { id: 'fairy' } } };
    expect(classifyEdit(lit, { ...base, slots: { lights: { id: 'fairy', tint: '#ff0000' } } }, lights)).toEqual(['light_colour']);
    expect(classifyEdit(lit, { ...base, slots: { lights: { id: 'fairy', cycle: true } } }, lights)).toEqual(['light_cycle']);
    expect(classifyEdit(lit, { ...base, slots: { lights: { id: 'fairy', tint: '#ff0000' } } })).toEqual(['recolour']);
    const item = { ...base, items: [{ id: 'plant', x: 10, y: 20 }] };
    expect(classifyEdit(item, { ...base, items: [{ id: 'plant', x: 10, y: 20, pattern: 'polka', accent: '#000000' }] })).toEqual(['pattern_change', 'accent_change']);
  });
});

describe('EditorSessionTracker', () => {
  it('counts edits once per history entry, a drag as one move, and undos', () => {
    const tr = new EditorSessionTracker('gear', 1000);
    let h = createHistory(base);
    tr.history(h);
    // A drag: one gesture, many frames.
    for (let x = 11; x < 40; x++) {
      h = commitEdit(h, { ...h.present, items: [{ id: 'plant', x, y: 20 }] }, 'drag');
      tr.history(h);
    }
    h = endGesture(h);
    tr.history(h);
    h = commitEdit(h, { ...h.present, time: 'night' });
    tr.history(h);
    h = commitEdit(h, { ...h.present, slots: { bed: { id: 'bed_b' } } });
    tr.history(h);
    h = undo(h);
    tr.history(h);
    h = undo(h);
    tr.history(h);
    tr.panel('furniture');
    tr.panel('furniture');
    tr.panel('items');
    tr.panel(null);
    tr.panel('furniture');
    const p = tr.finish(61_000, true, CHAR)!;
    expect(p).toMatchObject({
      opened_from: 'gear',
      duration_ms: 60_000,
      edits: 3,
      edit_move_item: 1,
      edit_time_of_day: 1,
      edit_swap_component: 1,
      undos: 2,
      first_panel: 'furniture',
      panels_opened: 3,
      panel_furniture: 2,
      panel_items: 1,
      outcome: 'discarded',
      dirty_at_close: true,
      preset: 'cozy',
    });
    expect(tr.finish(70_000, false, CHAR)).toBeNull();
  });

  it('reports saved, no_changes and failed saves', () => {
    const tr = new EditorSessionTracker('dock', 0);
    let h = createHistory(base);
    tr.history(h);
    h = commitEdit(h, { ...h.present, items: [] });
    tr.history(h);
    tr.saved(false);
    tr.saved(true);
    h = markSaved(h, { ...h.present });
    tr.history(h);
    expect(tr.finish(5000, false, null)).toMatchObject({ outcome: 'saved', saves: 1, save_failures: 1, edits: 1, edit_delete_item: 1 });

    const idle = new EditorSessionTracker('move_in', 0);
    idle.history(createHistory(base));
    expect(idle.touched).toBe(false);
    expect(idle.finish(100, false, null)).toMatchObject({ outcome: 'no_changes', edits: 0 });
  });

  it('ignores a reload from another window, counts avatar uploads and dedupes errors', () => {
    const tr = new EditorSessionTracker('gear', 0);
    tr.history(createHistory(base));
    tr.history(createHistory({ ...base, time: 'dusk' }));
    tr.avatarUpload('start');
    tr.avatarUpload('fail', 'too_big');
    tr.avatarUpload('start');
    tr.avatarUpload('ok');
    expect(tr.error('save_failed')).toBe(true);
    expect(tr.error('save_failed')).toBe(false);
    const p = tr.finish(10, false, null)!;
    expect(p).toMatchObject({ edits: 0, avatar_upload_start: 2, avatar_upload_ok: 1, avatar_upload_fail: 1, avatar_fail_too_big: 1, errors: 1 });
    expect(tr.touched).toBe(true);
  });
});

describe('room shape at close (261105)', () => {
  it('adds closed-shape counts and names only known patterns', () => {
    const t = new EditorSessionTracker('gear', 0);
    let h = createHistory(base);
    t.history(h);
    h = commitEdit(h, { ...base, slots: { bed: { id: 'bed_a', pattern: 'gingham' } } });
    t.history(h);
    const out = t.finish(5000, true, CHAR, { patterned: 2, accents: 1, cycling: 1, particles: 0, lastPattern: 'gingham' })!;
    expect(out.edit_pattern_change).toBe(1);
    expect(out.patterned_at_close).toBe(2);
    expect(out.particles_on).toBe(false);
    expect(out.last_pattern).toBe('gingham');
    const t2 = new EditorSessionTracker('gear', 0);
    expect(t2.finish(10, false, CHAR, { patterned: 0, accents: 0, cycling: 0, particles: 3, lastPattern: 'my_secret_upload' })!.last_pattern).toBe('other');
    const clean = sanitizeSeilinkTrack('seilink_editor_session', { ...out, last_pattern: 'evil', particles_on: 'yes' });
    expect(clean?.last_pattern).toBeUndefined();
    expect(clean?.particles_on).toBeUndefined();
    expect(sanitizeSeilinkTrack('seilink_editor_session', out)?.patterned_at_close).toBe(2);
  });
});

describe('sanitizeSeilinkTrack', () => {
  it('keeps only the closed shapes', () => {
    expect(isSeilinkRendererEvent('seilink_editor_session')).toBe(true);
    expect(isSeilinkRendererEvent('seilink_shown')).toBe(false);
    const out = sanitizeSeilinkTrack('seilink_editor_session', {
      character_id: CHAR,
      opened_from: '/Users/me',
      preset: 'cozy',
      edits: 4.4,
      edit_move_item: 3,
      edit_hack: 9,
      undos: -2,
      outcome: 'saved',
      note: 'hello',
    });
    expect(out).toEqual({
      character_id: CHAR,
      opened_from: 'other',
      preset: 'cozy',
      preset_end: null,
      first_panel: null,
      dirty_at_close: false,
      outcome: 'saved',
      edits: 4,
      edit_move_item: 3,
    });
    expect(sanitizeSeilinkTrack('seilink_editor_error', { kind: 'save_failed', message: 'EACCES /x', character_id: 'nope' })).toEqual({
      character_id: null,
      kind: 'save_failed',
      opened_from: 'other',
    });
    expect(
      sanitizeSeilinkTrack('seilink_movein_sheet', { action: 'failed', reason: 'swap', preset: 'forest', swap: true, error_class: 'start_failed', ms_open: 1234, name: 'Sui' }),
    ).toEqual({
      character_id: null,
      action: 'failed',
      reason: 'swap',
      preset: 'forest',
      pick_room: false,
      swap: true,
      preset_changed: false,
      ms_open: 1234,
      error_class: 'start_failed',
    });
    expect(sanitizeSeilinkTrack('other', { a: 1 })).toEqual({});
  });
});
