/**
 * SeiLink renderer analytics (261105), shape only. The room editor funnel and
 * the move-in sheet are measured in the renderer; their props are built here
 * from closed enums and counts, and main's analytics:track handler rebuilds
 * them with the same functions (sanitizeSeilinkTrack), so nothing but enums,
 * counts, durations and the character id can leave the machine.
 *
 *  - seilink_editor_session: ONE event per editor session (open to close),
 *    with counts per panel and per edit type, undos, saves, avatar uploads
 *    and how it ended. A drag is one edit (the history's gesture), never one
 *    event per frame.
 *  - seilink_editor_error {kind}: the editor could not load, save or import.
 *  - seilink_movein_sheet {action: shown|confirmed|dismissed|failed, ...}.
 *
 * Classification is a diff of two room states (classifyEdit), so the editor
 * needs no per-control tracking. Event table: docs/agents/seilink-analytics.md.
 */
import { ROOM_PRESET_IDS, resolvePattern, resolveSlots, type RoomComponent, type RoomPresetManifest, type RoomSlotId, type RoomState } from './seilinkRoom';
import { isPresetColour, swatchesFor } from './seilinkEdit';
import { CODE_PATTERNS } from './seilinkPatterns';
import { ENTRY_SOURCES } from './seilinkIntroTelemetry';

export const SEILINK_EDITOR_SESSION_EVENT = 'seilink_editor_session';
export const SEILINK_EDITOR_ERROR_EVENT = 'seilink_editor_error';
export const SEILINK_MOVEIN_SHEET_EVENT = 'seilink_movein_sheet';

/** 261105 (T337): 'button' = the chat top bar's SeiLink button, 'tour' = the guide's SeiLink tour. */
export const EDITOR_OPENED_FROM = ['gear', 'dock', 'move_in', 'button', 'tour', 'other'] as const;
export type EditorOpenedFrom = (typeof EDITOR_OPENED_FROM)[number];

/** The rail's panels (renderer lib/seilink/roomGroups.ts plus avatar and items). */
export const EDITOR_PANELS = ['avatar', 'room', 'fabrics', 'furniture', 'items'] as const;
export type EditorPanel = (typeof EDITOR_PANELS)[number];

/** How a colour was chosen in the editor (261105 colour pass): a preset swatch, the custom picker, its recent row. */
export const COLOR_PICK_KINDS = ['preset', 'custom', 'recent'] as const;
export type ColorPickKind = (typeof COLOR_PICK_KINDS)[number];

export const EDIT_TYPES = [
  'swap_component',
  'view_change',
  'recolour',
  'remove_slot',
  'add_item',
  'move_item',
  'scale_item',
  'flip_item',
  'recolour_item',
  'layer_item',
  'delete_item',
  'preset_change',
  'time_of_day',
  'avatar_change',
  // 261105 room catalog:
  'pattern_change',
  'accent_change',
  'light_colour',
  'light_cycle',
] as const;
export type EditType = (typeof EDIT_TYPES)[number];

export const EDITOR_ERRORS = ['load_failed', 'no_packs', 'save_failed', 'avatar_import_failed'] as const;
export type EditorError = (typeof EDITOR_ERRORS)[number];

export const AVATAR_UPLOAD_FAILS = ['not_zip', 'too_big', 'import_failed'] as const;
export type AvatarUploadFail = (typeof AVATAR_UPLOAD_FAILS)[number];

export const EDITOR_OUTCOMES = ['saved', 'no_changes', 'discarded'] as const;
export type EditorOutcome = (typeof EDITOR_OUTCOMES)[number];

export const MOVEIN_ACTIONS = ['shown', 'confirmed', 'dismissed', 'failed'] as const;
export type MoveInAction = (typeof MOVEIN_ACTIONS)[number];
export const MOVEIN_REASONS = ['first_room', 'swap', 'retry'] as const;
export const MOVEIN_FAILS = ['start_failed', 'save_failed', 'unsupported', 'error'] as const;
export type MoveInReason = (typeof MOVEIN_REASONS)[number];
export type MoveInFail = (typeof MOVEIN_FAILS)[number];

const PRESETS = ROOM_PRESET_IDS;

/** Pattern ids the analytics may name: the code patterns, the planned painted tiles, plain. Anything else is 'other'. */
export const KNOWN_PATTERNS: readonly string[] = ['plain', ...CODE_PATTERNS.map((p) => p.id), 'ditsy', 'leaves', 'clouds', 'sakura', 'other'];

/** Slots holding a part lit in its own colour (a glowTint frame, or a cycling part): their recolour is light_colour. */
export function lightSlotsOf(manifest: RoomPresetManifest): Set<RoomSlotId> {
  const out = new Set<RoomSlotId>();
  for (const c of manifest.components) {
    if (c.slot === 'item') continue;
    if (c.cycle || Object.values(c.frames).some((f) => f?.glowTint)) out.add(c.slot as RoomSlotId);
  }
  return out;
}

/** The counts of roomShapeAtClose for a state (pure; the editor passes its last picked pattern). */
export function roomShapeOf(manifest: RoomPresetManifest, state: RoomState, lastPattern: string | null = null): RoomShapeAtClose {
  let patterned = 0;
  let accents = 0;
  let cycling = 0;
  let particles = 0;
  let customColors = 0;
  const custom = (c: RoomComponent, tint: string | undefined, cycle?: boolean): boolean => Boolean(c.tintable && tint && !cycle && !isPresetColour(swatchesFor(c), tint));
  for (const r of resolveSlots(manifest, state)) {
    if (custom(r.component, r.tint, r.cycle)) customColors++;
    if (r.pattern) {
      patterned++;
      if (state.slots[r.slot]?.accent) accents++;
    }
    if (r.cycle) cycling++;
    if (Object.values(r.component.frames).some((f) => f?.particles?.length)) particles++;
  }
  const byId = new Map(manifest.components.map((c) => [c.id, c]));
  for (const it of state.items) {
    const c = byId.get(it.id);
    if (!c) continue;
    if (custom(c, it.tint ?? c.defaultTint)) customColors++;
    if (resolvePattern(manifest, c, it.tint ?? c.defaultTint, it.pattern, it.accent)) {
      patterned++;
      if (it.accent) accents++;
    }
    if (Object.values(c.frames).some((f) => f?.particles?.length)) particles++;
  }
  return { patterned, accents, cycling, particles, lastPattern, customColors };
}

/** What the room looks like at close (counts the editor works out with the manifest). */
export interface RoomShapeAtClose {
  /** Parts (slots and items) showing a pattern. */
  patterned: number;
  /** Of those, with a second colour picked (not the tone-on-tone default). */
  accents: number;
  /** Lights cycling through the colours. */
  cycling: number;
  /** Parts showing particles at some time of day (fireflies, embers, weather). */
  particles: number;
  /** The last pattern picked in the session, if any. */
  lastPattern?: string | null;
  /** 261105 colour pass: tinted parts (slots and items) whose main colour is not one of their presets. */
  customColors?: number;
}
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Classifying an edit ─────────────────────────────────────────────────────

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * What changed from `prev` to `next` (one history step). Empty when nothing
 * did. `lightSlots` (261105): slots whose part is a light lit in its colour,
 * where a recolour counts as light_colour.
 */
export function classifyEdit(prev: RoomState, next: RoomState, lightSlots?: ReadonlySet<RoomSlotId>): EditType[] {
  const out = new Set<EditType>();
  if (prev.preset !== next.preset) return ['preset_change'];
  if (prev.time !== next.time) out.add('time_of_day');
  if (!same(prev.avatar, next.avatar)) out.add('avatar_change');
  const slots = new Set([...Object.keys(prev.slots), ...Object.keys(next.slots)]) as Set<RoomSlotId>;
  for (const slot of slots) {
    const a = prev.slots[slot];
    const b = next.slots[slot];
    if ((a ? a.id : undefined) !== (b ? b.id : undefined)) {
      if (b && b.id === null) out.add('remove_slot');
      // A first tint on a slot still on its default writes {id: default, tint}: a recolour, not a swap.
      else if (!a && (b?.tint || b?.pattern || b?.accent || b?.cycle)) {
        if (b.tint) out.add(lightSlots?.has(slot) ? 'light_colour' : 'recolour');
        if (b.pattern) out.add('pattern_change');
        if (b.accent) out.add('accent_change');
        if (b.cycle) out.add('light_cycle');
      } else out.add(slot === 'view' ? 'view_change' : 'swap_component');
    } else {
      if ((a?.tint ?? null) !== (b?.tint ?? null)) out.add(lightSlots?.has(slot) ? 'light_colour' : 'recolour');
      if ((a?.pattern ?? null) !== (b?.pattern ?? null)) out.add('pattern_change');
      if ((a?.accent ?? null) !== (b?.accent ?? null)) out.add('accent_change');
      if ((a?.cycle ?? false) !== (b?.cycle ?? false)) out.add('light_cycle');
    }
  }
  if (next.items.length > prev.items.length) out.add('add_item');
  else if (next.items.length < prev.items.length) out.add('delete_item');
  else {
    for (let i = 0; i < next.items.length; i++) {
      const a = prev.items[i];
      const b = next.items[i];
      if (a.id !== b.id) {
        out.add('layer_item');
        continue;
      }
      if (a.x !== b.x || a.y !== b.y) out.add('move_item');
      if ((a.scale ?? 1) !== (b.scale ?? 1)) out.add('scale_item');
      if ((a.flip ?? false) !== (b.flip ?? false)) out.add('flip_item');
      if ((a.tint ?? null) !== (b.tint ?? null)) out.add('recolour_item');
      if ((a.pattern ?? null) !== (b.pattern ?? null)) out.add('pattern_change');
      if ((a.accent ?? null) !== (b.accent ?? null)) out.add('accent_change');
      if ((a.z ?? null) !== (b.z ?? null)) out.add('layer_item');
    }
  }
  return [...out];
}

// ── The editor session ──────────────────────────────────────────────────────

/** The parts of the editor's history the tracker reads (seilinkEdit EditHistory). */
export interface HistoryView {
  past: readonly RoomState[];
  present: RoomState;
}

/**
 * One editor session. Feed it every history the editor holds (`history`), the
 * panel it shows, saves and avatar uploads; `finish()` gives the event props.
 * A history step whose newest past entry is the previous present is an edit; a
 * step back to the previous past entry is an undo; anything else (a reload
 * after another window saved) is no edit. A gesture continuing (the same
 * history entry updated by a drag) is not counted again.
 */
export class EditorSessionTracker {
  private prev: HistoryView | null = null;
  private startPreset: string | null = null;
  private panels = new Map<EditorPanel, number>();
  private firstPanel: EditorPanel | null = null;
  private edits = new Map<EditType, number>();
  private editCount = 0;
  private undos = 0;
  private saves = 0;
  private saveFails = 0;
  private avatar = { start: 0, ok: 0, fail: 0 };
  private avatarFails = new Map<AvatarUploadFail, number>();
  private errors = new Set<EditorError>();
  private lastPanel: EditorPanel | null = null;
  private done = false;
  private lights: ReadonlySet<RoomSlotId> | undefined;
  private picks: Record<ColorPickKind, number> = { preset: 0, custom: 0, recent: 0 };
  private pickerOpens = 0;

  constructor(
    private readonly openedFrom: EditorOpenedFrom,
    private readonly openedAt: number,
  ) {}

  /** 261105: the slots holding a light lit in its colour (their recolour is light_colour). */
  setLightSlots(slots: ReadonlySet<RoomSlotId>): void {
    this.lights = slots;
  }

  /** Any interaction at all (StrictMode's throwaway mount has none). */
  get touched(): boolean {
    return this.editCount + this.undos + this.saves + this.saveFails + this.avatar.start + this.panels.size + this.pickerOpens > 0;
  }

  history(h: HistoryView | null): void {
    if (!h) return;
    const p = this.prev;
    this.prev = h;
    if (!p) {
      this.startPreset = h.present.preset;
      return;
    }
    if (h.present === p.present) return;
    if (h.past.length === p.past.length - 1 && h.present === p.past[p.past.length - 1]) {
      this.undos++;
      return;
    }
    if (h.past.length > 0 && h.past[h.past.length - 1] === p.present && h.past !== p.past) {
      const types = classifyEdit(p.present, h.present, this.lights);
      if (!types.length) return;
      this.editCount++;
      for (const t of types) this.edits.set(t, (this.edits.get(t) ?? 0) + 1);
    }
  }

  panel(p: EditorPanel | null): void {
    if (p === this.lastPanel) return;
    this.lastPanel = p;
    if (!p) return;
    this.firstPanel ??= p;
    this.panels.set(p, (this.panels.get(p) ?? 0) + 1);
  }

  /** 261105 colour pass: the custom colour popover opened. */
  pickerOpened(): void {
    this.pickerOpens++;
  }

  /** 261105 colour pass: one colour pick (a preset swatch, one custom pick = one drag or one typed hex, a recent colour). */
  colorPicked(kind: ColorPickKind): void {
    if (kind in this.picks) this.picks[kind]++;
  }

  saved(ok: boolean): void {
    if (ok) this.saves++;
    else this.saveFails++;
  }

  avatarUpload(stage: 'start' | 'ok' | 'fail', reason?: AvatarUploadFail): void {
    this.avatar[stage]++;
    if (stage === 'fail' && reason) this.avatarFails.set(reason, (this.avatarFails.get(reason) ?? 0) + 1);
  }

  /** True the first time this kind happens in the session (send seilink_editor_error then). */
  error(kind: EditorError): boolean {
    if (this.errors.has(kind)) return false;
    this.errors.add(kind);
    return true;
  }

  /** The session event's props; null after the first call. `dirty` = unsaved edits at close. */
  finish(now: number, dirty: boolean, characterId: string | null, shape?: RoomShapeAtClose): Record<string, string | number | boolean | null> | null {
    if (this.done) return null;
    this.done = true;
    const out: Record<string, string | number | boolean | null> = {
      character_id: characterId,
      opened_from: this.openedFrom,
      duration_ms: Math.max(0, now - this.openedAt),
      preset: this.startPreset,
      preset_end: this.prev?.present.preset ?? null,
      first_panel: this.firstPanel,
      panels_opened: [...this.panels.values()].reduce((a, b) => a + b, 0),
      edits: this.editCount,
      undos: this.undos,
      saves: this.saves,
      save_failures: this.saveFails,
      avatar_upload_start: this.avatar.start,
      avatar_upload_ok: this.avatar.ok,
      avatar_upload_fail: this.avatar.fail,
      dirty_at_close: dirty,
      outcome: dirty ? 'discarded' : this.saves > 0 ? 'saved' : 'no_changes',
      errors: this.errors.size,
      preset_color_picks: this.picks.preset,
      custom_color_picks: this.picks.custom,
      recent_color_picks: this.picks.recent,
      picker_opens: this.pickerOpens,
    };
    for (const [p, n] of this.panels) out[`panel_${p}`] = n;
    for (const [t, n] of this.edits) out[`edit_${t}`] = n;
    for (const [r, n] of this.avatarFails) out[`avatar_fail_${r}`] = n;
    if (shape) {
      out.patterned_at_close = shape.patterned;
      out.accents_at_close = shape.accents;
      out.cycling_lights_at_close = shape.cycling;
      out.particle_parts_at_close = shape.particles;
      out.particles_on = shape.particles > 0;
      if (shape.customColors !== undefined) out.custom_colors_at_close = shape.customColors;
      if (shape.lastPattern) out.last_pattern = KNOWN_PATTERNS.includes(shape.lastPattern) ? shape.lastPattern : 'other';
    }
    return out;
  }
}

// ── Sanitizers (renderer builds, main rebuilds) ─────────────────────────────

type Scalar = string | number | boolean | null;

function count(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.round(n), 1_000_000) : undefined;
}

function oneOf<T extends string>(list: readonly T[], v: unknown): T | null {
  return typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : null;
}

function charId(v: unknown): string | null {
  return typeof v === 'string' && ID_RE.test(v) ? v : null;
}

const SESSION_COUNTS = [
  'duration_ms',
  'panels_opened',
  'edits',
  'undos',
  'saves',
  'save_failures',
  'avatar_upload_start',
  'avatar_upload_ok',
  'avatar_upload_fail',
  'errors',
  'patterned_at_close',
  'accents_at_close',
  'cycling_lights_at_close',
  'particle_parts_at_close',
  'preset_color_picks',
  'custom_color_picks',
  'recent_color_picks',
  'picker_opens',
  'custom_colors_at_close',
  ...EDITOR_PANELS.map((p) => `panel_${p}`),
  ...EDIT_TYPES.map((t) => `edit_${t}`),
  ...AVATAR_UPLOAD_FAILS.map((r) => `avatar_fail_${r}`),
];

function editorSessionProps(p: Record<string, unknown>): Record<string, Scalar> {
  const out: Record<string, Scalar> = {
    character_id: charId(p.character_id),
    opened_from: oneOf(EDITOR_OPENED_FROM, p.opened_from) ?? 'other',
    preset: oneOf(PRESETS, p.preset),
    preset_end: oneOf(PRESETS, p.preset_end),
    first_panel: oneOf(EDITOR_PANELS, p.first_panel),
    dirty_at_close: p.dirty_at_close === true,
    outcome: oneOf(EDITOR_OUTCOMES, p.outcome) ?? 'no_changes',
  };
  if (typeof p.particles_on === 'boolean') out.particles_on = p.particles_on;
  const last = oneOf(KNOWN_PATTERNS, p.last_pattern);
  if (last) out.last_pattern = last;
  for (const k of SESSION_COUNTS) {
    const n = count(p[k]);
    if (n !== undefined) out[k] = n;
  }
  return out;
}

function moveInProps(p: Record<string, unknown>): Record<string, Scalar> {
  const out: Record<string, Scalar> = {
    character_id: charId(p.character_id),
    action: oneOf(MOVEIN_ACTIONS, p.action) ?? 'shown',
    reason: oneOf(MOVEIN_REASONS, p.reason),
    preset: oneOf(PRESETS, p.preset),
    pick_room: p.pick_room === true,
    swap: p.swap === true,
    preset_changed: p.preset_changed === true,
  };
  const packs = count(p.packs_available);
  if (packs !== undefined) out.packs_available = packs;
  const ms = count(p.ms_open);
  if (ms !== undefined) out.ms_open = ms;
  const fail = oneOf(MOVEIN_FAILS, p.error_class);
  if (fail) out.error_class = fail;
  // 261105 (T337): how the person got here (the SeiLink button, the gear menu, the tour, the dock).
  const entry = oneOf(ENTRY_SOURCES, p.entry);
  if (entry) out.entry = entry;
  return out;
}

/** The events this module owns. */
export function isSeilinkRendererEvent(event: string): boolean {
  return event === SEILINK_EDITOR_SESSION_EVENT || event === SEILINK_EDITOR_ERROR_EVENT || event === SEILINK_MOVEIN_SHEET_EVENT;
}

/** Rebuild a renderer-sent SeiLink event's props from the closed shapes (main's track handler). */
export function sanitizeSeilinkTrack(event: string, raw: Record<string, unknown> | undefined): Record<string, Scalar> {
  const p = raw ?? {};
  if (event === SEILINK_EDITOR_SESSION_EVENT) return editorSessionProps(p);
  if (event === SEILINK_MOVEIN_SHEET_EVENT) return moveInProps(p);
  if (event === SEILINK_EDITOR_ERROR_EVENT) {
    return {
      character_id: charId(p.character_id),
      kind: oneOf(EDITOR_ERRORS, p.kind) ?? 'load_failed',
      opened_from: oneOf(EDITOR_OPENED_FROM, p.opened_from) ?? 'other',
    };
  }
  return {};
}
