/**
 * SeiLink room editor (261104, milestone 2). Full-window: her room is the
 * hero, drawn full-bleed by RoomCanvas, and the editor floats over it in
 * translucent panels tinted by the ROOM (manifest.overlay for the time of
 * day: light room, light glass), never by the app theme.
 *
 *  - left: a rail of five tiles (her avatar, the room, walls & fabrics,
 *    furniture, items). A tile opens a panel next to it; Room, Walls & fabrics
 *    and Furniture hold one section per part of the room (261105, Shawn: fewer
 *    rail buttons, surfaces apart from standalone pieces), where she swaps the
 *    part and recolours it. Avatar uploads a Live2D model, Items adds items;
 *  - top: time of day (auto follows the clock, or a fixed day/dusk/night to
 *    preview), undo, save, close;
 *  - in the room: click a part to open its options, click an item to select
 *    it, drag it (it stays on the floor, wall or shelf it belongs to), and
 *    flip, resize, recolour or remove it from the toolbar above it. A drag
 *    snaps the item's bottom onto real floor, a shelf top or bare wall
 *    (shared/seilinkPlace.ts) and shows those places faintly
 *    (PlacementGuide) until it is dropped.
 *
 * Every change is live. Rules (placement, ops, undo) are the pure helpers in
 * shared/seilinkEdit.ts; reads and writes go through a RoomEditorSource
 * (IPC in the app, memory in the dev preview). Save writes through IPC and
 * main sanitizes it; what she sees next turn is what was saved.
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  defaultRoomState,
  resolveRoomTime,
  type RoomComponent,
  type RoomItemPlacement,
  type RoomPresetId,
  type RoomPresetManifest,
  type RoomSlotId,
  type RoomState,
  type RoomTime,
  ROOM_PRESET_IDS,
} from '@shared/seilinkRoom';
import { frameFor, roomDrawPlan, viewportToCanvas, type ItemLayer, type RoomOverlay, type RoomViewport, type SlotLayer } from '@shared/seilinkDraw';
import { placementOf, placementRegions, snapSpot, spriteFit, type PlacementClass, type RoomSurface } from '@shared/seilinkPlace';
import { sanitizeRoomState } from '@shared/seilinkValidate';
import {
  addItem,
  canUndo,
  clampScale,
  commitEdit,
  createHistory,
  currentTint,
  endGesture,
  flipItem,
  isDirty,
  itemScaleRange,
  ITEM_SCALE_STEP,
  markSaved,
  moveItem,
  removeItem,
  scaleItem,
  setItemTint,
  setRoomAvatar,
  setRoomTime,
  setSlotComponent,
  setSlotTint,
  slotChoice,
  swatchesFor,
  switchPreset,
  undo,
  type EditHistory,
} from '@shared/seilinkEdit';
import { useT } from '../../lib/i18n';
import { ROOM_PRESET_LABEL } from '../../lib/seilink/moveIn';
import { useEditorAnalytics } from '../../lib/seilink/editorAnalytics';
import type { EditorOpenedFrom } from '@shared/seilinkTelemetry';
import { RoomCanvas, type RoomAvatarSlot } from './RoomCanvas';
import { componentThumb, roomThumb } from '../../lib/seilink/roomThumbs';
import { RoomPicker } from '../../lib/seilink/roomPick';
import { groupSlots, slotGroup, type SlotGroup } from '../../lib/seilink/roomGroups';
import { drawRoomLayers, loadPlanAssets } from '../../lib/seilink/roomCompose';
import { ctx2d } from '../../lib/seilink/roomImages';
import { RoomAvatar } from './RoomAvatar';
import { PlacementGuide } from './PlacementGuide';
import type { EditorAvatarModel, EditorPack, RoomEditorSource } from './roomEditorSource';
import {
  AutoIcon,
  BagIcon,
  ChairIcon,
  CheckIcon,
  CloseIcon,
  DayIcon,
  DuskIcon,
  FlipIcon,
  HouseIcon,
  MinusIcon,
  NightIcon,
  NoneIcon,
  PersonIcon,
  PlusIcon,
  RollerIcon,
  TrashIcon,
  UndoIcon,
  UploadIcon,
} from './roomEditorIcons';
import styles from './RoomEditor.module.css';

/** The rail's panels (261105). Room, Walls & fabrics and Furniture hold several slots as sections. */
type Group = 'avatar' | SlotGroup | 'items';
const GROUPS: readonly Group[] = ['avatar', 'room', 'fabrics', 'furniture', 'items'];
/**
 * What `initial.panel` may name: a group, or a slot (old links, screenshot
 * scripts), which opens the slot's group with its section in view.
 */
export type PanelRequest = Group | RoomSlotId;

/** Labels for slot tiles (keys are the English strings; see i18n). */
const SLOT_LABEL: Record<RoomSlotId, string> = {
  view: 'View',
  shell: 'Walls',
  curtains: 'Curtains',
  bed: 'Bed',
  shelf: 'Shelves',
  chair: 'Chair',
  lamp: 'Lamp',
  rug: 'Rug',
  campfire: 'Campfire',
};

const GROUP_LABEL = { fabrics: 'Walls & fabrics', furniture: 'Furniture' } as const;

/** Item library groups, by placement class (keys are the English strings). */
const ITEM_GROUPS: ReadonlyArray<{ cls: PlacementClass; label: string }> = [
  { cls: 'floor', label: 'Floor' },
  { cls: 'surface', label: 'Shelves' },
  { cls: 'wall', label: 'Walls' },
];

const RAIL_ICON = 22;

const TIMES: ReadonlyArray<{ id: RoomState['time']; label: string; Icon: (p: { size?: number }) => React.ReactElement }> = [
  { id: 'auto', label: 'Auto', Icon: AutoIcon },
  { id: 'day', label: 'Daytime', Icon: DayIcon },
  { id: 'dusk', label: 'Dusk', Icon: DuskIcon },
  { id: 'night', label: 'Night', Icon: NightIcon },
];

/** Slots whose tile shows the scene itself (cropped), not a trimmed object. */
const SCENE_SLOTS: ReadonlySet<RoomSlotId> = new Set(['view', 'shell']);

const ZIP_MAX_BYTES = 128 * 1024 * 1024;

export interface RoomEditorProps {
  source: RoomEditorSource;
  /** Her character id, for the Live2D avatar view (absent in the browser preview). */
  characterId?: string;
  onClose(): void;
  clock?: () => Date;
  /** Effects frame cap (RoomCanvas fps). */
  fps?: number;
  /** Dev / screenshots: open with a panel or an item selected. */
  initial?: { panel?: PanelRequest | null; selected?: number | null; state?: RoomState };
  /** Render inline instead of in a portal over the whole window (dev preview). */
  inline?: boolean;
  /** Usage analytics (shape only). Only the companion editor passes it. */
  telemetry?: { openedFrom: EditorOpenedFrom };
  /** 261105: a quiet line in the avatar panel ("Preparing {name}'s look..."). */
  avatarNote?: string | null;
}

/** Slots the editor offers anything for, in draw order. */
export function editableSlots(manifest: RoomPresetManifest, state: RoomState): RoomSlotId[] {
  const byId = new Map(manifest.components.map((c) => [c.id, c]));
  return (Object.entries(manifest.slots) as Array<[RoomSlotId, NonNullable<RoomPresetManifest['slots'][RoomSlotId]>]>)
    .sort((a, b) => a[1].z - b[1].z)
    .filter(([slot, def]) => {
      const id = slotChoice(manifest, state, slot);
      return def.options.length > 1 || def.optional === true || Boolean(id && byId.get(id)?.tintable);
    })
    .map(([slot]) => slot);
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** An async image URL (thumbnails); null while it loads or when it fails. */
function useAsyncUrl(make: (() => Promise<string>) | null, key: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!make) {
      setUrl(null);
      return;
    }
    let dead = false;
    make().then(
      (u) => !dead && setUrl(u),
      () => !dead && setUrl(null),
    );
    return () => {
      dead = true;
    };
    // `key` stands for everything `make` closes over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return url;
}

function hexTriple(hex: string): string {
  const n = parseInt(hex.replace('#', ''), 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

// ── Thumbnails ──────────────────────────────────────────────────────────────

function PartThumb({ pack, component, tint, time, cover }: { pack: EditorPack; component: RoomComponent; tint: string | null; time: RoomTime; cover?: boolean }): React.ReactElement {
  const t = useDebounced(tint, 140);
  const url = useAsyncUrl(
    () => componentThumb(pack.manifest, component, { time, tint: t, resolve: pack.resolve, cover }),
    `${pack.id}:${pack.rev}:${component.id}:${t ?? ''}:${time}:${cover ? 1 : 0}`,
  );
  return url ? <img className={cover ? styles.thumbCover : styles.thumb} src={url} alt="" draggable={false} /> : <span className={styles.thumbWait} />;
}

function RoomCard({ pack, state, time }: { pack: EditorPack; state: RoomState; time: RoomTime }): React.ReactElement {
  const key = JSON.stringify({ ...state, time: null });
  const debounced = useDebounced(key, 300);
  const url = useAsyncUrl(() => roomThumb(pack.manifest, JSON.parse(debounced) as RoomState, { time, resolve: pack.resolve, width: 320, rev: pack.rev }), `${pack.id}:${pack.rev}:${debounced}:${time}`);
  return url ? <img className={styles.cardImg} src={url} alt="" draggable={false} /> : <span className={styles.cardWait} />;
}

// ── Avatar ──────────────────────────────────────────────────────────────────

/** Her figure when she uses the Sei avatar here: frosted glass in her shape, so the room reads through. */
function GlassFigure({ height }: { height: number }): React.ReactElement {
  return <div className={styles.figure} style={{ width: height * 0.6, height }} aria-hidden="true" />;
}

function EditorAvatar({ slot, state, characterId }: { slot: RoomAvatarSlot; state: RoomState; characterId?: string }): React.ReactElement {
  if (state.avatar.kind === 'live2d' && characterId) {
    // Framed exactly as the room shows her (RoomAvatar), held still while editing.
    return <RoomAvatar slot={slot} characterId={characterId} use="imported" busy motion={false} />;
  }
  return <GlassFigure height={slot.height} />;
}

// ── Item drag ghost ─────────────────────────────────────────────────────────

/** The item being dragged, drawn above the room at the pointer (it rejoins its layer on drop). */
function ItemGhost({
  pack,
  item,
  slots,
  time,
  vp,
}: {
  pack: EditorPack;
  item: RoomItemPlacement;
  /** The room's parts now (an item sinks into the bed only while the bed is there). */
  slots: RoomState['slots'];
  time: RoomTime;
  vp: RoomViewport;
}): React.ReactElement | null {
  const ref = useRef<HTMLCanvasElement>(null);
  const [rect, setRect] = useState<[number, number, number, number] | null>(null);
  const { manifest, resolve } = pack;
  // The sprite is drawn once per look (scale with depth, rounded, sunk into a soft top); moving only moves the canvas.
  const plan = useMemo(
    () => roomDrawPlan(manifest, { ...defaultRoomState(manifest.id), slots, items: [item] }, time, { avatar: false }),
    [manifest, slots, item, time],
  );
  const lay = plan.layers.find((l): l is ItemLayer => l.kind === 'item');
  const sunk = lay?.sink ? `${lay.sink.depth.toFixed(1)}/${lay.sink.foot.toFixed(1)}` : '';
  const key = `${item.id}:${lay ? lay.scale.toFixed(2) : 1}:${item.flip ? 1 : 0}:${item.tint ?? ''}:${time}:${vp.scale}:${sunk}`;
  useEffect(() => {
    let dead = false;
    const layer = lay && { ...lay, x: 0, y: 0, scale: Math.round(lay.scale * 100) / 100 };
    if (!layer) return;
    void loadPlanAssets({ ...plan, layers: [layer], glows: [] }, resolve).then(({ assets }) => {
      const img = assets.images.get(layer.frame.src);
      const c = ref.current;
      if (dead || !img || !c) return;
      const [w0, h0] = layer.size ?? [img.width, img.height];
      const w = w0 * layer.scale;
      const h = h0 * layer.scale;
      const dpr = window.devicePixelRatio || 1;
      const s = vp.scale * dpr;
      c.width = Math.max(1, Math.round(w * s));
      c.height = Math.max(1, Math.round(h * s));
      const ctx = ctx2d(c);
      ctx.setTransform(s, 0, 0, s, (w / 2) * s, h * s);
      drawRoomLayers(ctx, [layer], manifest.canvas, assets, s);
      setRect([-w / 2, -h, w, h]);
    });
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, manifest, resolve]);
  const style: React.CSSProperties = rect
    ? {
        left: vp.left + (item.x + rect[0]) * vp.scale,
        top: vp.top + (item.y + rect[1]) * vp.scale,
        width: rect[2] * vp.scale,
        height: rect[3] * vp.scale,
      }
    : { visibility: 'hidden' };
  return <canvas ref={ref} className={styles.ghost} style={style} />;
}

/**
 * The lip of the top a dragged item is over (261105 shelf pass), drawn over
 * its ghost, so a drag shows the item tucked behind the plank's front edge
 * exactly as it will sit once dropped. Drawn once per top, a small canvas.
 */
function LipGhost({ pack, state, time, vp, top }: { pack: EditorPack; state: RoomState; time: RoomTime; vp: RoomViewport; top: RoomSurface | undefined }): React.ReactElement | null {
  const ref = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState<[number, number, number, number] | null>(null);
  const { manifest, resolve } = pack;
  const lip = top?.kind === 'area' ? top.lip : null;
  const part = useMemo(() => {
    if (!lip || !top) return null;
    const plan = roomDrawPlan(manifest, { ...state, items: [] }, time, { avatar: false });
    const l = plan.layers.find((x): x is SlotLayer => x.kind === 'slot' && x.slot === top.slot);
    return l ? { ...l, clip: [lip] } : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifest, lip, top?.slot, time, state.slots]);
  useEffect(() => {
    let dead = false;
    setBox(null);
    if (!part || !lip) return;
    void loadPlanAssets({ canvas: manifest.canvas, time, layers: [part], glows: [] }, resolve).then(({ assets }) => {
      const c = ref.current;
      if (dead || !c) return;
      const xs = lip.map((p) => p[0]);
      const ys = lip.map((p) => p[1]);
      const b: [number, number, number, number] = [Math.min(...xs) - 1, Math.min(...ys) - 1, Math.max(...xs) - Math.min(...xs) + 2, Math.max(...ys) - Math.min(...ys) + 2];
      const s = vp.scale * (window.devicePixelRatio || 1);
      c.width = Math.max(1, Math.ceil(b[2] * s));
      c.height = Math.max(1, Math.ceil(b[3] * s));
      const ctx = ctx2d(c);
      ctx.setTransform(s, 0, 0, s, -b[0] * s, -b[1] * s);
      drawRoomLayers(ctx, [part], manifest.canvas, assets, s);
      setBox(b);
    });
    return () => {
      dead = true;
    };
  }, [part, lip, manifest, resolve, time, vp.scale]);
  if (!lip) return null;
  const style: React.CSSProperties = box
    ? { left: vp.left + box[0] * vp.scale, top: vp.top + box[1] * vp.scale, width: box[2] * vp.scale, height: box[3] * vp.scale }
    : { visibility: 'hidden' };
  return <canvas ref={ref} className={styles.lipGhost} style={style} data-lip-ghost="" />;
}

// ── Swatches ────────────────────────────────────────────────────────────────

function Swatches({
  component,
  value,
  gesture,
  onTint,
  onGestureEnd,
}: {
  component: RoomComponent;
  value: string | null;
  gesture: string;
  onTint(hex: string, gesture: string | null): void;
  onGestureEnd(): void;
}): React.ReactElement {
  const t = useT();
  const swatches = swatchesFor(component);
  const custom = value && !swatches.includes(value.toLowerCase()) ? value : null;
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const end = (): void => onGestureEnd();
    el.addEventListener('change', end);
    return () => el.removeEventListener('change', end);
  }, [onGestureEnd]);
  return (
    <div className={styles.swatches} role="radiogroup" aria-label={t('Color')}>
      {swatches.map((hex) => (
        <button
          key={hex}
          type="button"
          role="radio"
          aria-checked={value?.toLowerCase() === hex}
          aria-label={hex}
          className={value?.toLowerCase() === hex ? `${styles.swatch} ${styles.swatchOn}` : styles.swatch}
          style={{ background: hex }}
          onClick={() => onTint(hex, null)}
        />
      ))}
      <label
        className={custom ? `${styles.swatch} ${styles.swatchCustom} ${styles.swatchOn}` : `${styles.swatch} ${styles.swatchCustom}`}
        title={t('Custom color')}
        style={custom ? { background: custom } : undefined}
      >
        <input
          ref={inputRef}
          type="color"
          aria-label={t('Custom color')}
          value={value ?? '#ffffff'}
          onChange={(e) => onTint(e.target.value, gesture)}
          onBlur={onGestureEnd}
        />
      </label>
    </div>
  );
}

// ── The editor ──────────────────────────────────────────────────────────────

export function RoomEditor(props: RoomEditorProps): React.ReactElement {
  const { source, characterId, onClose, clock, fps = 30, initial, inline, telemetry } = props;
  const t = useT();
  const [packs, setPacks] = useState<EditorPack[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [history, setHistory] = useState<EditHistory | null>(null);
  const initialSlot = initial?.panel && !GROUPS.includes(initial.panel as Group) ? (initial.panel as RoomSlotId) : null;
  const [panel, setPanel] = useState<Group | null>(initialSlot ? slotGroup(initialSlot) : ((initial?.panel as Group | undefined) ?? null));
  // The section a canvas click (or `initial.panel` naming a slot) asked for: scrolled into view and flashed once per `n`.
  const [focus, setFocus] = useState<{ slot: RoomSlotId; n: number; smooth: boolean } | null>(initialSlot ? { slot: initialSlot, n: 1, smooth: false } : null);
  const panelRef = useRef<HTMLElement>(null);
  const sectionEls = useRef(new Map<RoomSlotId, HTMLElement>());
  const [selected, setSelected] = useState<number | null>(initial?.selected ?? null);
  const [overlay, setOverlay] = useState<RoomOverlay | null>(null);
  const [vp, setVp] = useState<RoomViewport>({ scale: 0, left: 0, top: 0, width: 0, height: 0 });
  const [drag, setDrag] = useState<{ index: number; x: number; y: number; surface: number } | null>(null);
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [confirmClose, setConfirmClose] = useState(false);
  const [model, setModel] = useState<EditorAvatarModel | null>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [pickTick, setPickTick] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef(new RoomPicker());
  const dragRef = useRef<{ index: number; pointerId: number; dx: number; dy: number; sx: number; sy: number; lifted: boolean; surface: number } | null>(null);
  const historyRef = useRef(history);
  historyRef.current = history;
  const analytics = useEditorAnalytics(telemetry ? { ...telemetry, characterId } : null, {
    history,
    panel,
    saving,
    loadError,
    packsEmpty: packs !== null && packs.length === 0,
  });

  // ── load ──
  const loadAll = useCallback(async (): Promise<void> => {
    try {
      const [list, saved] = await Promise.all([source.packs(), source.load().catch(() => null)]);
      setPacks(list);
      if (!list.length) return;
      const pack = list.find((p) => p.id === saved?.preset) ?? list[0];
      // The clean point is what is on disk; a room whose pack is missing here starts dirty on the first pack.
      const savedClean = saved && saved.preset === pack.id ? sanitizeRoomState(pack.manifest, saved) : saved;
      const start = initial?.state ?? saved;
      const state =
        start && start.preset === pack.id
          ? start === saved
            ? savedClean!
            : sanitizeRoomState(pack.manifest, start)
          : { ...defaultRoomState(pack.id), time: start?.time ?? 'auto', avatar: start?.avatar ?? { kind: 'sei' as const } };
      setHistory(createHistory(state, savedClean));
    } catch {
      setLoadError(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  useEffect(() => {
    void loadAll();
    void source.avatar?.get().then(setModel, () => setModel(null));
  }, [source, loadAll]);

  // Someone else saved her room: follow it unless there are unsaved edits here.
  useEffect(
    () =>
      source.onChanged?.(() => {
        const h = historyRef.current;
        if (!h || isDirty(h)) return;
        void source.load().then((s) => {
          if (!s) return;
          setHistory((cur) => (cur && !isDirty(cur) ? createHistory(s, s) : cur));
        });
      }),
    [source],
  );

  const state = history?.present ?? null;
  const pack = useMemo(() => (state && packs ? (packs.find((p) => p.id === state.preset) ?? null) : null), [packs, state]);
  const manifest = pack?.manifest ?? null;
  const now = (clock ?? (() => new Date()))();
  const time: RoomTime = state ? resolveRoomTime(state, now) : 'day';

  const edit = useCallback((fn: (s: RoomState) => RoomState, gesture: string | null = null) => {
    setHistory((h) => (h ? commitEdit(h, fn(h.present), gesture) : h));
    setSaving((s) => (s === 'saved' || s === 'error' ? 'idle' : s));
  }, []);
  const endEditGesture = useCallback(() => setHistory((h) => (h ? endGesture(h) : h)), []);

  // Where things can stand in this room (floor, shelf tops, wall), for drags and the guide.
  const regions = useMemo(() => (manifest && state ? placementRegions(manifest, state) : null), [manifest, state]);
  /** The sprite size of an item with no box, once its image is loaded (null before: anchor-only checks). */
  const naturalOf = (c: RoomComponent): [number, number] | null =>
    c.box || !pack ? null : pickerRef.current.natural(pack.resolve(frameFor(c, time).src));

  // What the canvas draws: the dragged item is lifted out (drawn as a ghost) so a drag never rebuilds the room.
  const renderState = useMemo(() => {
    if (!state) return null;
    if (!drag) return state;
    return { ...state, items: state.items.filter((_, i) => i !== drag.index) };
  }, [state, drag]);

  const slots = useMemo(() => (manifest && state ? editableSlots(manifest, state) : []), [manifest, state]);
  const slotSet = useMemo(() => new Set(slots), [slots]);
  const sections = useMemo(
    () => ({ room: groupSlots(slots, 'room'), fabrics: groupSlots(slots, 'fabrics'), furniture: groupSlots(slots, 'furniture') }),
    [slots],
  );

  /** Open the group that holds `slot`, with its section in view. */
  const openSlot = (slot: RoomSlotId): void => {
    const group = slotGroup(slot);
    setFocus((f) => ({ slot, n: (f?.n ?? 0) + 1, smooth: panel === group }));
    setPanel(group);
  };

  // Bring the asked-for section into view and flash it. Runs again once the
  // editor has loaded (the sections do not exist before that).
  const ready = Boolean(manifest);
  useLayoutEffect(() => {
    if (!focus || !ready) return;
    const el = sectionEls.current.get(focus.slot);
    const box = panelRef.current;
    if (!el || !box) return;
    const pad = parseFloat(getComputedStyle(box).paddingTop) || 0;
    box.scrollTo({ top: Math.max(0, el.offsetTop - pad), behavior: focus.smooth ? 'smooth' : 'auto' });
    el.classList.remove(styles.flash);
    void el.offsetWidth; // restart the animation
    el.classList.add(styles.flash);
  }, [focus, ready]);

  // Keep hit-test maps ready for what is on screen.
  useEffect(() => {
    if (!manifest || !state || !pack) return;
    let dead = false;
    void pickerRef.current.prepare(manifest, state, time, pack.resolve).then(() => !dead && setPickTick((n) => n + 1));
    return () => {
      dead = true;
    };
  }, [manifest, state, time, pack]);

  // A selection that no longer exists (undo, remove) clears itself.
  useEffect(() => {
    if (selected !== null && state && selected >= state.items.length) setSelected(null);
  }, [selected, state]);
  useEffect(() => setPaletteOpen(false), [selected]);

  // ── actions ──
  const doUndo = useCallback(() => setHistory((h) => (h ? undo(h) : h)), []);

  const doSave = useCallback(async (): Promise<boolean> => {
    const h = historyRef.current;
    if (!h) return false;
    const sent = h.present;
    setSaving('saving');
    try {
      const saved = await source.save(sent);
      setHistory((cur) => (cur ? markSaved(cur, saved, sent) : cur));
      setSaving('saved');
      return true;
    } catch (err) {
      console.warn('[seilink editor] save failed', err);
      setSaving('error');
      return false;
    }
  }, [source]);

  useEffect(() => {
    if (saving !== 'saved') return;
    const id = setTimeout(() => setSaving('idle'), 1800);
    return () => clearTimeout(id);
  }, [saving]);

  const dirty = history ? isDirty(history) : false;
  const requestClose = useCallback(() => {
    if (historyRef.current && isDirty(historyRef.current)) setConfirmClose(true);
    else onClose();
  }, [onClose]);

  const pickPreset = (id: RoomPresetId): void => {
    if (!packs?.some((p) => p.id === id)) return;
    setSelected(null);
    edit((s) => switchPreset(s, id));
  };

  const addItemById = (id: string): void => {
    if (!manifest) return;
    const h = historyRef.current;
    if (!h) return;
    const { state: next, index } = addItem(manifest, h.present, id);
    if (index < 0) return;
    edit(() => next);
    setSelected(index);
  };

  const onPickZip = async (file: File): Promise<void> => {
    if (!source.avatar) return;
    setAvatarError(null);
    analytics.avatarUpload('start');
    if (!/\.zip$/i.test(file.name)) {
      analytics.avatarUpload('fail', 'not_zip');
      setAvatarError(t('That file is not a .zip archive.'));
      return;
    }
    if (file.size > ZIP_MAX_BYTES) {
      analytics.avatarUpload('fail', 'too_big');
      setAvatarError(t('That archive is too large.'));
      return;
    }
    setAvatarBusy(true);
    try {
      const m = await source.avatar.importZip(await file.arrayBuffer());
      setModel(m);
      edit((s) => setRoomAvatar(s, { kind: 'live2d', modelPath: m.entry }));
      analytics.avatarUpload('ok');
    } catch (err) {
      analytics.avatarUpload('fail', 'import_failed');
      console.warn('[seilink editor] avatar import failed', err);
      setAvatarError(t('Could not read that model. It needs a .model3.json with its .moc3 and textures, or a rig.json with its layer images.'));
    } finally {
      setAvatarBusy(false);
    }
  };

  // ── pointer: select, open, drag ──
  const pointerCanvas = (e: React.PointerEvent): [number, number] => {
    const r = stageRef.current!.getBoundingClientRect();
    return viewportToCanvas(vp, e.clientX - r.left, e.clientY - r.top);
  };

  const onStageDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || !manifest || !state || !pack) return;
    const [cx, cy] = pointerCanvas(e);
    const hit = pickerRef.current.pick(manifest, state, time, pack.resolve, cx, cy, slotSet);
    if (hit?.kind === 'item') {
      const it = state.items[hit.index];
      setSelected(hit.index);
      setPanel('items');
      dragRef.current = { index: hit.index, pointerId: e.pointerId, dx: cx - it.x, dy: cy - it.y, sx: e.clientX, sy: e.clientY, lifted: false, surface: -1 };
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    if (selected !== null) {
      // First click away only lets go of the item.
      setSelected(null);
      return;
    }
    if (hit?.kind === 'slot') openSlot(hit.slot);
    else if (hit?.kind === 'avatar') setPanel('avatar');
    else setPanel(null);
  };

  const onStageMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId || !manifest || !state || !regions) return;
    if (!d.lifted && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 4) return;
    d.lifted = true;
    const it = state.items[d.index];
    const c = it && manifest.components.find((x) => x.id === it.id);
    if (!c) return;
    const [cx, cy] = pointerCanvas(e);
    const snap = snapSpot(regions, c, cx - d.dx, cy - d.dy, { fit: spriteFit(regions, c, it.scale ?? 1, naturalOf(c)), prefer: d.surface });
    d.surface = snap.surface;
    const { x, y, surface } = snap;
    setDrag((prev) => (prev && prev.index === d.index && prev.x === x && prev.y === y ? prev : { index: d.index, x, y, surface }));
  };

  const onStageUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    dragRef.current = null;
    const pos = drag;
    setDrag(null);
    if (d.lifted && pos && manifest) {
      const c = manifest.components.find((x) => x.id === state?.items[d.index]?.id);
      edit((s) => moveItem(manifest, s, d.index, pos.x, pos.y, { natural: c ? naturalOf(c) : null, prefer: pos.surface }));
    }
  };

  // ── keyboard ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        doUndo();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void doSave();
        return;
      }
      if (e.key === 'Escape') {
        if (confirmClose) setConfirmClose(false);
        else if (selected !== null) setSelected(null);
        else if (panel) setPanel(null);
        else requestClose();
        return;
      }
      if (selected === null || !manifest) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        edit((s) => removeItem(s, selected));
        setSelected(null);
        return;
      }
      const step = e.shiftKey ? 24 : 6;
      const dir: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      const mv = dir[e.key];
      if (mv) {
        e.preventDefault();
        edit((s) => {
          const it = s.items[selected];
          const c = it && manifest.components.find((x) => x.id === it.id);
          return it ? moveItem(manifest, s, selected, it.x + mv[0], it.y + mv[1], { natural: c ? naturalOf(c) : null }) : s;
        }, `nudge:${selected}`);
      }
    };
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.key.startsWith('Arrow')) endEditGesture();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [confirmClose, selected, panel, manifest, doUndo, doSave, requestClose, edit, endEditGesture]);

  // ── overlay tint (the room's, not the theme's) ──
  const ov = overlay ?? { color: manifest?.overlay?.[time] ?? '#efe6da', light: true, ink: '#1d1b22' };
  const rootStyle = { '--ov': hexTriple(ov.color), '--ink': hexTriple(ov.ink) } as React.CSSProperties;
  const tone = ov.light ? styles.light : styles.dark;

  const wrap = (node: React.ReactElement): React.ReactElement => (inline ? node : createPortal(node, document.body));

  if (loadError || (packs && packs.length === 0)) {
    return wrap(
      <div className={`${styles.root} ${styles.dark} ${inline ? styles.inline : ''}`} style={{ '--ov': '28 32 51', '--ink': '244 241 238' } as React.CSSProperties}>
        <div className={styles.empty}>
          <p>{t('No room art yet.')}</p>
          <button type="button" className={styles.pill} onClick={onClose}>
            {t('Close')}
          </button>
        </div>
      </div>,
    );
  }
  if (!packs || !history || !state || !pack || !manifest || !renderState) {
    return wrap(<div className={`${styles.root} ${styles.dark} ${inline ? styles.inline : ''}`} aria-busy="true" />);
  }

  const byId = new Map(manifest.components.map((c) => [c.id, c]));
  const items = manifest.components.filter((c) => c.slot === 'item');
  const dragComp = drag && state.items[drag.index] ? byId.get(state.items[drag.index].id) : undefined;
  // The library groups items by where they go (floor, shelves, wall) when there is more than one kind.
  const itemGroups = ITEM_GROUPS.map((g) => ({ ...g, items: items.filter((c) => placementOf(c) === g.cls) })).filter((g) => g.items.length);
  const selItem = selected !== null ? state.items[selected] : undefined;
  const selComp = selItem ? byId.get(selItem.id) : undefined;
  const selNatural = selComp ? naturalOf(selComp) : null;
  const selRange = selected !== null && selItem ? itemScaleRange(manifest, state, selected, selNatural) : null;
  void pickTick; // re-render when hit maps (and so item rects) are ready
  const selRect =
    selected !== null && !drag ? pickerRef.current.itemRect(manifest, state, time, pack.resolve, selected) : null;
  const cssRect = selRect
    ? { left: vp.left + selRect[0] * vp.scale, top: vp.top + selRect[1] * vp.scale, width: selRect[2] * vp.scale, height: selRect[3] * vp.scale }
    : null;

  const tile = (key: Group, label: string, content: React.ReactNode): React.ReactElement => (
    <button
      key={key}
      type="button"
      className={panel === key ? `${styles.tile} ${styles.tileOn}` : styles.tile}
      aria-pressed={panel === key}
      aria-label={label}
      title={label}
      onClick={() => {
        setPanel(panel === key ? null : key);
        setFocus(null);
        if (key !== 'items') setSelected(null);
      }}
    >
      {content}
    </button>
  );

  const slotTint = (slot: RoomSlotId): string | null => {
    const id = slotChoice(manifest, state, slot);
    return currentTint(id ? byId.get(id) : undefined, state.slots[slot]?.tint);
  };

  /** One slot as a section of its group: its label, the parts to pick, and colours when the part takes them. */
  const slotSection = (slot: RoomSlotId): React.ReactNode => {
    const def = manifest.slots[slot];
    if (!def) return null;
    const current = slotChoice(manifest, state, slot);
    const comp = current ? byId.get(current) : undefined;
    return (
      <div
        key={slot}
        ref={(el) => {
          if (el) sectionEls.current.set(slot, el);
          else sectionEls.current.delete(slot);
        }}
        className={styles.section}
        role="group"
        aria-label={t(SLOT_LABEL[slot])}
        data-slot={slot}
      >
        <h2 className={styles.title}>{t(SLOT_LABEL[slot])}</h2>
        {(def.options.length > 1 || def.optional) && (
          <div className={styles.grid}>
            {def.options.map((id) => {
              const c = byId.get(id);
              if (!c) return null;
              const on = current === id;
              return (
                <button
                  key={id}
                  type="button"
                  className={on ? `${styles.option} ${styles.optionOn}` : styles.option}
                  aria-pressed={on}
                  title={c.name}
                  aria-label={c.name}
                  onClick={() => edit((s) => setSlotComponent(manifest, s, slot, id))}
                >
                  <PartThumb pack={pack} component={c} tint={on ? slotTint(slot) : (c.defaultTint ?? null)} time="day" cover={SCENE_SLOTS.has(slot)} />
                </button>
              );
            })}
            {def.optional && (
              <button
                type="button"
                className={current === null ? `${styles.option} ${styles.optionOn}` : styles.option}
                aria-pressed={current === null}
                title={t('None')}
                aria-label={t('None')}
                onClick={() => edit((s) => setSlotComponent(manifest, s, slot, null))}
              >
                <NoneIcon size={22} />
              </button>
            )}
          </div>
        )}
        {comp?.tintable && (
          <Swatches
            component={comp}
            value={slotTint(slot)}
            gesture={`tint:${slot}`}
            onTint={(hex, g) => edit((s) => setSlotTint(manifest, s, slot, hex), g)}
            onGestureEnd={endEditGesture}
          />
        )}
      </div>
    );
  };

  // ── panels ──
  const renderPanel = (): React.ReactNode => {
    if (!panel) return null;
    if (panel === 'avatar') {
      return (
        <section key="avatar" className={styles.panel} aria-label={t('Avatar')}>
          <h2 className={styles.title}>{t('Avatar')}</h2>
          <div className={styles.grid}>
            <button
              type="button"
              className={state.avatar.kind === 'sei' ? `${styles.option} ${styles.optionOn}` : styles.option}
              aria-pressed={state.avatar.kind === 'sei'}
              title={t('Sei avatar')}
              aria-label={t('Sei avatar')}
              onClick={() => edit((s) => setRoomAvatar(s, { kind: 'sei' }))}
            >
              <span className={styles.figureIcon} />
            </button>
            {model && (
              <button
                type="button"
                className={state.avatar.kind === 'live2d' ? `${styles.option} ${styles.optionOn}` : styles.option}
                aria-pressed={state.avatar.kind === 'live2d'}
                title={model.name}
                aria-label={model.name}
                onClick={() => edit((s) => setRoomAvatar(s, { kind: 'live2d', modelPath: model.entry }))}
              >
                <span className={styles.optionWord}>Live2D</span>
              </button>
            )}
            {source.avatar && (
              <button
                type="button"
                className={styles.option}
                title={t('Upload Live2D')}
                aria-label={t('Upload Live2D')}
                disabled={avatarBusy}
                onClick={() => fileRef.current?.click()}
              >
                {avatarBusy ? <span className={styles.spinner} /> : <UploadIcon size={22} />}
              </button>
            )}
          </div>
          {avatarError && <p className={styles.note}>{avatarError}</p>}
          {!avatarError && props.avatarNote && (
            <p className={styles.note} role="status">
              {props.avatarNote}
            </p>
          )}
          <input
            ref={fileRef}
            type="file"
            accept=".zip"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void onPickZip(f);
            }}
          />
        </section>
      );
    }
    if (panel === 'room') {
      return (
        <section key="room" ref={panelRef} className={`${styles.panel} ${styles.groupPanel}`} aria-label={t('Room')}>
          <div className={styles.section} role="group" aria-label={t('Room type')} data-section="room-type">
            <h2 className={styles.title}>{t('Room type')}</h2>
            <div className={styles.cards}>
              {ROOM_PRESET_IDS.map((id) => {
                const p = packs.find((x) => x.id === id);
                const on = state.preset === id;
                return (
                  <button
                    key={id}
                    type="button"
                    className={on ? `${styles.card} ${styles.cardOn}` : styles.card}
                    aria-pressed={on}
                    disabled={!p}
                    onClick={() => pickPreset(id)}
                  >
                    {p ? <RoomCard pack={p} state={on ? state : defaultRoomState(id)} time={time} /> : <span className={styles.cardWait} />}
                    {on && (
                      <span className={styles.cardCheck}>
                        <CheckIcon size={14} />
                      </span>
                    )}
                    <span className={styles.cardLabel}>
                      {t(ROOM_PRESET_LABEL[id])}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          {sections.room.map(slotSection)}
        </section>
      );
    }
    if (panel === 'fabrics' || panel === 'furniture') {
      return (
        <section key={panel} ref={panelRef} className={`${styles.panel} ${styles.groupPanel}`} aria-label={t(GROUP_LABEL[panel])}>
          {sections[panel].map(slotSection)}
        </section>
      );
    }
    if (panel === 'items') {
      return (
        <section key="items" className={styles.panel} aria-label={t('Items')}>
          <h2 className={styles.title}>{t('Items')}</h2>
          {itemGroups.map((g) => (
            <div key={g.cls} className={styles.itemGroup} role="group" aria-label={itemGroups.length > 1 ? t(g.label) : undefined}>
              {itemGroups.length > 1 && <h3 className={styles.itemGroupTitle}>{t(g.label)}</h3>}
              <div className={styles.grid}>
                {g.items.map((c) => (
                  <button key={c.id} type="button" className={styles.option} title={c.name} aria-label={c.name} onClick={() => addItemById(c.id)}>
                    <PartThumb pack={pack} component={c} tint={c.tintable ? (c.defaultTint ?? null) : null} time="day" />
                    <span className={styles.addBadge}>
                      <PlusIcon size={12} />
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </section>
      );
    }
    return null;
  };

  const savedLabel = saving === 'saving' ? t('Saving…') : dirty ? t('Save') : t('Saved');

  const body = (
    <div className={`${styles.root} ${tone} ${inline ? styles.inline : ''}`} style={rootStyle} data-room-editor="1">
      <RoomCanvas
        manifest={manifest}
        state={renderState}
        resolveUrl={pack.resolve}
        fit="cover"
        fps={fps}
        clock={clock}
        onOverlay={setOverlay}
        onLayout={setVp}
        avatar={(slot) => <EditorAvatar slot={slot} state={state} characterId={characterId} />}
      >
        <div
          ref={stageRef}
          className={drag ? `${styles.stage} ${styles.dragging}` : styles.stage}
          onPointerDown={onStageDown}
          onPointerMove={onStageMove}
          onPointerUp={onStageUp}
          onPointerCancel={onStageUp}
        >
          {cssRect && <div className={styles.selection} style={cssRect} />}
          {drag && regions && dragComp && (
            <PlacementGuide regions={regions} cls={placementOf(dragComp)} surface={drag.surface} vp={vp} canvas={manifest.canvas} />
          )}
          {drag && state.items[drag.index] && (
            <ItemGhost pack={pack} item={{ ...state.items[drag.index], x: drag.x, y: drag.y }} slots={state.slots} time={time} vp={vp} />
          )}
          {drag && regions && dragComp && placementOf(dragComp) === 'surface' && (
            <LipGhost pack={pack} state={state} time={time} vp={vp} top={regions.surfaces[drag.surface]} />
          )}
        </div>
        {/* The editor covers the app window, title strip included: keep the
            frameless window movable from the top edge (as MacosWindow does). */}
        {!inline && <div className={styles.dragStrip} aria-hidden="true" />}

        {cssRect && selItem && selComp && selected !== null && (
          <div
            className={styles.toolbar}
            style={{
              left: Math.max(16, Math.min(cssRect.left + cssRect.width / 2, (stageRef.current?.clientWidth ?? 9999) - 16)),
              top: cssRect.top > 96 ? cssRect.top - 14 : cssRect.top + cssRect.height + 14,
              transform: cssRect.top > 96 ? 'translate(-50%, -100%)' : 'translate(-50%, 0)',
            }}
            role="toolbar"
            aria-label={selComp.name}
          >
            <div className={styles.toolRow}>
              <button type="button" className={styles.tool} title={t('Flip')} aria-label={t('Flip')} onClick={() => edit((s) => flipItem(s, selected))}>
                <FlipIcon />
              </button>
              <button
                type="button"
                className={styles.tool}
                title={t('Smaller')}
                aria-label={t('Smaller')}
                disabled={!selRange || clampScale(selItem.scale ?? 1, selRange) <= selRange[0]}
                onClick={() => edit((s) => scaleItem(s, selected, (selItem.scale ?? 1) - ITEM_SCALE_STEP, manifest, selNatural))}
              >
                <MinusIcon />
              </button>
              <button
                type="button"
                className={styles.tool}
                title={t('Larger')}
                aria-label={t('Larger')}
                disabled={!selRange || clampScale(selItem.scale ?? 1, selRange) >= selRange[1]}
                onClick={() => edit((s) => scaleItem(s, selected, (selItem.scale ?? 1) + ITEM_SCALE_STEP, manifest, selNatural))}
              >
                <PlusIcon />
              </button>
              {selComp.tintable && (
                <button
                  type="button"
                  className={paletteOpen ? `${styles.tool} ${styles.toolOn}` : styles.tool}
                  title={t('Color')}
                  aria-label={t('Color')}
                  aria-expanded={paletteOpen}
                  onClick={() => setPaletteOpen((o) => !o)}
                >
                  <span className={styles.toolDot} style={{ background: currentTint(selComp, selItem.tint) ?? '#fff' }} />
                </button>
              )}
              <button
                type="button"
                className={`${styles.tool} ${styles.toolDanger}`}
                title={t('Remove')}
                aria-label={t('Remove')}
                onClick={() => {
                  edit((s) => removeItem(s, selected));
                  setSelected(null);
                }}
              >
                <TrashIcon />
              </button>
            </div>
            {paletteOpen && selComp.tintable && (
              <Swatches
                component={selComp}
                value={currentTint(selComp, selItem.tint)}
                gesture={`tint:item:${selected}`}
                onTint={(hex, g) => edit((s) => setItemTint(manifest, s, selected, hex), g)}
                onGestureEnd={endEditGesture}
              />
            )}
          </div>
        )}

        {/* While an item is dragged the side panel fades away, so the shelves under it show. */}
        <div className={drag ? `${styles.side} ${styles.sideAway}` : styles.side}>
          <nav className={panel ? `${styles.rail} ${styles.railOpen}` : styles.rail} aria-label={t('Room')}>
            {tile('avatar', t('Avatar'), <PersonIcon size={RAIL_ICON} />)}
            {tile('room', t('Room'), <HouseIcon size={RAIL_ICON} />)}
            {sections.fabrics.length > 0 && tile('fabrics', t(GROUP_LABEL.fabrics), <RollerIcon size={RAIL_ICON} />)}
            {sections.furniture.length > 0 && tile('furniture', t(GROUP_LABEL.furniture), <ChairIcon size={RAIL_ICON} />)}
            {items.length > 0 && tile('items', t('Items'), <BagIcon size={RAIL_ICON} />)}
          </nav>
          {renderPanel()}
        </div>

        <div className={styles.top}>
          <div className={styles.times} role="radiogroup" aria-label={t('Time of day')}>
            {TIMES.map(({ id, label, Icon }) => {
              const on = state.time === id;
              return (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  className={on ? `${styles.time} ${styles.timeOn}` : styles.time}
                  title={t(label)}
                  aria-label={t(label)}
                  onClick={() => edit((s) => setRoomTime(s, id))}
                >
                  <Icon size={17} />
                  {on && <span className={styles.timeLabel}>{t(label)}</span>}
                </button>
              );
            })}
          </div>

          <div className={styles.actions}>
            <button type="button" className={styles.iconBtn} title={t('Undo')} aria-label={t('Undo')} disabled={!canUndo(history)} onClick={doUndo}>
              <UndoIcon />
            </button>
            <button
              type="button"
              className={dirty ? `${styles.pill} ${styles.pillHot}` : styles.pill}
              disabled={!dirty || saving === 'saving'}
              onClick={() => void doSave()}
            >
              {!dirty && saving !== 'saving' && <CheckIcon size={16} />}
              {savedLabel}
            </button>
            <button type="button" className={styles.iconBtn} title={t('Close')} aria-label={t('Close')} onClick={requestClose}>
              <CloseIcon />
            </button>
          </div>
        </div>

        {saving === 'error' && (
          <p className={styles.toast} role="alert">
            {t('Could not save the room.')}
          </p>
        )}

        {confirmClose && (
          <div className={styles.scrim} onPointerDown={(e) => e.target === e.currentTarget && setConfirmClose(false)}>
            <div className={styles.confirm} role="dialog" aria-modal="true" aria-label={t('Leave without saving?')}>
              <p>{t('Leave without saving?')}</p>
              <div className={styles.confirmRow}>
                <button type="button" className={styles.pill} onClick={onClose}>
                  {t('Discard')}
                </button>
                <button
                  type="button"
                  className={`${styles.pill} ${styles.pillHot}`}
                  onClick={() => {
                    void doSave().then((ok) => ok && onClose());
                  }}
                >
                  {t('Save')}
                </button>
              </div>
            </div>
          </div>
        )}
      </RoomCanvas>
    </div>
  );
  return wrap(body);
}
