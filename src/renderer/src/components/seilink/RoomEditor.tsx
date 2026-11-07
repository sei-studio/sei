/**
 * SeiLink room editor (261104, milestone 2). Full-window: her room is the
 * hero, drawn full-bleed by RoomCanvas, and the editor floats over it in
 * translucent panels tinted by the ROOM (manifest.overlay for the time of
 * day: light room, light glass), never by the app theme.
 *
 *  - left: a rail of five tiles (her avatar, the room, walls & fabrics,
 *    furniture, items). A tile opens a panel next to it; Room, Walls & fabrics
 *    and Furniture hold one section per part of the room (261105, product feedback: fewer
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
 * Guided setup (261106, first-link v3): while she is still on the plain
 * background (no room yet), or a setup run was left unfinished, the editor
 * opens guided instead of with the rail: one panel per step (room, colours,
 * furniture, little extras; lib/seilink/roomSetup.ts), a step indicator, a
 * title and a line under it, and Back / Skip / Next, Done on the last step.
 * Every step is optional. Next and Skip save the room with the steps done so
 * far (RoomState.setup), so closing part way resumes at the first step not
 * done; Done saves it without, and the next open is the normal editor.
 * Analytics: seilink_setup and seilink_setup_step (shape only).
 *
 * After Done (261107, product call 261107): the "Open on login" step, once,
 * where the login item works and the user has not answered it yet
 * (lib/seilink/loginStep.ts, the `openAtLogin` prop). "Turn on" (the
 * preselected answer) or "Not now"; closing on it registers nothing.
 *
 * Every change is live. Rules (placement, ops, undo) are the pure helpers in
 * shared/seilinkEdit.ts; reads and writes go through a RoomEditorSource
 * (IPC in the app, memory in the dev preview). Save writes through IPC and
 * main sanitizes it; what she sees next turn is what was saved.
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  BLANK_FRAME,
  bareRoomState,
  defaultRoomState,
  PLAIN_PATTERN,
  patternsFor,
  resolvePattern,
  slotLabel,
  resolveRoomTime,
  type RoomComponent,
  type RoomItemPlacement,
  type RoomPolygon,
  type RoomPresetId,
  type RoomPresetManifest,
  type RoomSetupStep,
  type RoomSlotId,
  type RoomState,
  type RoomTime,
  ROOM_PRESET_IDS,
  ROOM_SETUP_STEPS,
} from '@shared/seilinkRoom';
import { frameFor, roomDrawPlan, viewportToCanvas, type ItemLayer, type RoomOverlay, type RoomViewport, type SlotLayer } from '@shared/seilinkDraw';
import { placementOf, placementRegions, snapSpot, spriteFit, type PlacementClass, type RoomSurface } from '@shared/seilinkPlace';
import { sanitizeRoomState } from '@shared/seilinkValidate';
import { toneOnTone, type PatternDef } from '@shared/seilinkPatterns';
import {
  addItem,
  canUndo,
  clampScale,
  commitEdit,
  createHistory,
  currentPattern,
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
  setItemAccent,
  setItemPattern,
  setItemTint,
  setRoomAvatar,
  setRoomTime,
  setSlotAccent,
  setSlotComponent,
  setSlotCycle,
  setSlotPattern,
  setSlotTint,
  slotChoice,
  swatchesFor,
  accentSwatchesFor,
  isPresetColour,
  switchPreset,
  undo,
  type EditHistory,
} from '@shared/seilinkEdit';
import { useT } from '../../lib/i18n';
import { sei } from '../../lib/ipcClient';
import { ROOM_PRESET_LABEL } from '../../lib/seilink/moveIn';
import { SEILINK_SETUP_EVENT, SEILINK_SETUP_STEP_EVENT, type SetupAction, type SetupStepAction } from '@shared/seilinkIntroTelemetry';
import { SETUP_COPY, SETUP_PANEL, markDone, nextStep, opensGuided, prevStep, resumeStep, setupSteps, withoutSetup } from '../../lib/seilink/roomSetup';
import { LOGIN_STEP_DEFAULT, loginStepAfter, offersLoginStep, type OpenAtLoginSource } from '../../lib/seilink/loginStep';
import { useEditorAnalytics, type TogetherAnalytics } from '../../lib/seilink/editorAnalytics';
import { lightSlotsOf, roomShapeOf, type EditorOpenedFrom, type EditorSurface } from '@shared/seilinkTelemetry';
import { RoomCanvas, type RoomAvatarSlot } from './RoomCanvas';
import { componentThumb, roomThumb } from '../../lib/seilink/roomThumbs';
import { patternThumb } from '../../lib/seilink/patternThumbs';
import { RoomPicker } from '../../lib/seilink/roomPick';
import { groupSlots, slotGroup, type SlotGroup } from '../../lib/seilink/roomGroups';
import { drawRoomLayers, loadPlanAssets } from '../../lib/seilink/roomCompose';
import { ctx2d } from '../../lib/seilink/roomImages';
import { RoomAvatar } from './RoomAvatar';
import { PlacementGuide } from './PlacementGuide';
import { ColorPickTelemetryContext, CustomColor, useColorPickTelemetry, type ColorPickTelemetry } from './RoomColorPicker';
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
  SparkleIcon,
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

/** The avatar store and avatar library cap (64 MB). */
const ZIP_MAX_BYTES = 64 * 1024 * 1024;

export interface RoomEditorProps {
  source: RoomEditorSource;
  /** Her character id, for the Live2D avatar view (absent in the browser preview). */
  characterId?: string;
  onClose(): void;
  clock?: () => Date;
  /** Effects frame cap (RoomCanvas fps). */
  fps?: number;
  /** Dev / screenshots: open with a panel or an item selected. */
  initial?: { panel?: PanelRequest | null; selected?: number | null; state?: RoomState; loginStep?: boolean };
  /** Render inline instead of in a portal over the whole window (dev preview). */
  inline?: boolean;
  /** Usage analytics (shape only). Only the companion editor passes it. */
  telemetry?: { openedFrom: EditorOpenedFrom; surface?: EditorSurface };
  /** 261105: a quiet line in the avatar panel ("Preparing {name}'s look..."). */
  avatarNote?: string | null;
  /** 261106: her portrait (portrait_image ref or URL) and name: the Sei avatar is drawn as the room draws her. */
  portrait?: string | null;
  name?: string;
  /** 261105 (T336): decorating together with her (RoomTogether), drawn over the room. */
  together?: (ctx: RoomTogetherCtx) => React.ReactNode;
  /** 261106: false never opens the guided setup (default: guided while she is plain or a run is unfinished; never with `initial.panel`). */
  guided?: boolean;
  /** 261107: the "Open on login" setting, offered once after the guided setup's Done (absent: never offered). */
  openAtLogin?: OpenAtLoginSource | null;
}

/** What the together layer (RoomTogether.tsx) gets from the editor. */
export interface RoomTogetherCtx {
  manifest: RoomPresetManifest;
  state: RoomState;
  history: EditHistory;
  pack: EditorPack;
  time: RoomTime;
  vp: RoomViewport;
  picker: RoomPicker;
  /** Re-render tick for when the picker's maps are ready. */
  pickTick: number;
  /** Commit a room as ONE undo step (her changes, or her idea the player tried). */
  commit(next: RoomState): void;
  /** Undo once, only if the present is still `state`. True when it did. */
  undoIf(state: RoomState): boolean;
  analytics: TogetherAnalytics;
  /** The room canvas's layer box (for the crossfade snapshot). */
  sceneEl(): HTMLElement | null;
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

/** The guided setup's steps this room has something for (lib/seilink/roomSetup.ts). */
export function guideStepsFor(manifest: RoomPresetManifest, state: RoomState): RoomSetupStep[] {
  const slots = editableSlots(manifest, state);
  return setupSteps({
    fabrics: groupSlots(slots, 'fabrics', manifest).length > 0,
    furniture: groupSlots(slots, 'furniture', manifest).length > 0,
    items: manifest.components.some((c) => c.slot === 'item'),
  });
}

/** 261107: the "Open on login" step while it is up. */
interface LoginStepUi {
  /** The answer is with main. */
  busy: boolean;
  /** A line after an answer: the OS did not take it, or macOS waits for approval. */
  note: 'failed' | 'approval' | null;
  /** The run before it was a resumed one (analytics). */
  resumed: boolean;
}

/** One guided setup run. */
interface GuideRun {
  step: RoomSetupStep;
  /** Steps done (completed or skipped), saved with the room. */
  done: RoomSetupStep[];
  completed: number;
  skipped: number;
  /** A run left unfinished before (the room carried `setup`). */
  resumed: boolean;
  /** She was on the plain background when it began. */
  plain: boolean;
  at: number;
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
  // A part drawn only as particles (fireflies) has nothing to trim into a thumbnail.
  const blank = Object.values(component.frames).every((f) => !f || f.src === BLANK_FRAME);
  const url = useAsyncUrl(
    blank ? null : () => componentThumb(pack.manifest, component, { time, tint: t, resolve: pack.resolve, cover }),
    `${pack.id}:${pack.rev}:${component.id}:${t ?? ''}:${time}:${cover ? 1 : 0}`,
  );
  if (blank) return <SparkleIcon size={26} />;
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

function EditorAvatar({
  slot,
  state,
  characterId,
  portrait,
  name,
}: {
  slot: RoomAvatarSlot;
  state: RoomState;
  characterId?: string;
  portrait?: string | null;
  name?: string;
}): React.ReactElement {
  if (state.avatar.kind === 'live2d' && characterId) {
    // Framed exactly as the room shows her (RoomAvatar), held still while editing.
    return <RoomAvatar slot={slot} characterId={characterId} use="imported" busy motion={false} />;
  }
  // 261106: with her portrait known, the Sei avatar is her face set or portrait as on the
  // wallpaper, so the editor on the desktop stage does not swap her for a silhouette.
  if (characterId && portrait) return <RoomAvatar slot={slot} characterId={characterId} name={name} use="sei" portrait={portrait} busy motion={false} />;
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
    // The lip cut is canvas px: it is applied to the ghost's element below (clip-path), not drawn into it.
    const layer = lay && { ...lay, x: 0, y: 0, scale: Math.round(lay.scale * 100) / 100, clip: undefined };
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
  // On a lipped top the sprite is cut at the plank's bottom edge (LipGhost draws the plank over the rest); the wrapper's lift shadow follows the cut sprite.
  const cut = rect && lay?.clip?.length ? ghostClip(lay.clip[0], item.x + rect[0], item.y + rect[1], rect[2], rect[3], vp.scale) : undefined;
  return (
    <div className={styles.ghost} style={style}>
      <canvas ref={ref} className={styles.ghostSprite} style={cut ? { clipPath: cut } : undefined} />
    </div>
  );
}

/**
 * A canvas-px keep polygon (an item's lip cut) as a CSS clip-path on a ghost
 * whose top-left is (x, y) canvas px and size w x h, in CSS px. Points are
 * clamped to just outside the element, which keeps the shape inside it.
 */
function ghostClip(poly: RoomPolygon, x: number, y: number, w: number, h: number, scale: number): string {
  const pad = 4;
  const cx = (v: number): number => Math.max(-pad, Math.min(w * scale + pad, (v - x) * scale));
  const cy = (v: number): number => Math.max(-pad, Math.min(h * scale + pad, (v - y) * scale));
  return `polygon(${poly.map(([px, py]) => `${cx(px).toFixed(1)}px ${cy(py).toFixed(1)}px`).join(', ')})`;
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
  auto,
  cycle,
  label,
  accent,
}: {
  component: RoomComponent;
  value: string | null;
  gesture: string;
  onTint(hex: string, gesture: string | null): void;
  onGestureEnd(): void;
  /** 261105: a first swatch for the automatic colour (the accent's tone-on-tone). */
  auto?: { colour: string; on: boolean; onPick(): void };
  /** 261105: a colour-cycle swatch (a light that runs through the colours). */
  cycle?: { on: boolean; onToggle(on: boolean): void };
  label?: string;
  /** 261105 colour pass: the second pattern colour's row (its own palette). */
  accent?: boolean;
}): React.ReactElement {
  const t = useT();
  const tele = useColorPickTelemetry();
  const swatches = useMemo(() => (accent ? accentSwatchesFor(component) : swatchesFor(component)), [accent, component]);
  const picked = auto?.on || cycle?.on ? null : value;
  // A colour that is not one of the presets (her own, or an older palette's) shows on the custom swatch.
  const custom = picked !== null && !isPresetColour(swatches, picked);
  return (
    <div className={styles.swatches} role="radiogroup" aria-label={label ?? t('Color')}>
      {auto && (
        <button
          type="button"
          role="radio"
          aria-checked={auto.on}
          aria-label={t('Automatic')}
          title={t('Automatic')}
          className={auto.on ? `${styles.swatch} ${styles.swatchAuto} ${styles.swatchOn}` : `${styles.swatch} ${styles.swatchAuto}`}
          style={{ ['--auto' as string]: auto.colour }}
          onClick={() => {
            tele.picked('preset');
            auto.onPick();
          }}
        />
      )}
      {cycle && (
        <button
          type="button"
          role="radio"
          aria-checked={cycle.on}
          aria-label={t('Color cycle')}
          title={t('Color cycle')}
          className={cycle.on ? `${styles.swatch} ${styles.swatchCycle} ${styles.swatchOn}` : `${styles.swatch} ${styles.swatchCycle}`}
          onClick={() => cycle.onToggle(!cycle.on)}
        />
      )}
      {swatches.map((hex) => (
        <button
          key={hex}
          type="button"
          role="radio"
          aria-checked={picked?.toLowerCase() === hex}
          aria-label={hex}
          title={hex}
          className={picked?.toLowerCase() === hex ? `${styles.swatch} ${styles.swatchOn}` : styles.swatch}
          style={{ background: hex }}
          onClick={() => {
            tele.picked('preset');
            onTint(hex, null);
          }}
        />
      ))}
      <CustomColor value={value ?? swatches[0] ?? '#ffffff'} active={custom} gesture={gesture} label={t('Custom color')} onTint={onTint} onGestureEnd={onGestureEnd} />
    </div>
  );
}

// ── Patterns (261105) ───────────────────────────────────────────────────────

function PatternSwatch({ pack, def, base, accent }: { pack: EditorPack; def: PatternDef; base: string; accent: string }): React.ReactElement {
  const b = useDebounced(base, 140);
  const a = useDebounced(accent, 140);
  const url = useAsyncUrl(() => patternThumb(def, b, a, pack.resolve), `${pack.id}:${pack.rev}:${def.id}:${b}:${a}`);
  return url ? <img className={styles.patternImg} src={url} alt="" draggable={false} /> : <span className={styles.thumbWait} />;
}

/** What a tintable part looks like: its colour, and for a part that takes patterns, the pattern and its second colour. */
interface PartLookValue {
  tint: string | null;
  pattern: string;
  /** Her own second colour, or null for the automatic tone-on-tone. */
  accent: string | null;
  cycle: boolean;
}

function PartLook({
  pack,
  component,
  value,
  gesture,
  onTint,
  onPattern,
  onAccent,
  onCycle,
  onGestureEnd,
}: {
  pack: EditorPack;
  component: RoomComponent;
  value: PartLookValue;
  gesture: string;
  onTint(hex: string, gesture: string | null): void;
  onPattern(id: string): void;
  onAccent(hex: string | null, gesture: string | null): void;
  onCycle(on: boolean): void;
  onGestureEnd(): void;
}): React.ReactElement {
  const t = useT();
  const patterns = useMemo(() => patternsFor(pack.manifest, component), [pack.manifest, component]);
  const [which, setWhich] = useState<'base' | 'accent'>('base');
  const base = value.tint ?? component.defaultTint ?? '#ffffff';
  const resolved = resolvePattern(pack.manifest, component, base, value.pattern, value.accent ?? undefined);
  const accent = resolved?.accent ?? value.accent ?? toneOnTone(base);
  const patterned = resolved !== null;
  const editAccent = patterned && which === 'accent';
  return (
    <div className={styles.look}>
      {patterned && (
        <div className={styles.lookTabs} role="tablist" aria-label={t('Colors')}>
          {(
            [
              ['base', t('Main color'), base],
              ['accent', t('Second color'), accent],
            ] as const
          ).map(([id, label, colour]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={(id === 'accent') === editAccent}
              className={(id === 'accent') === editAccent ? `${styles.lookTab} ${styles.lookTabOn}` : styles.lookTab}
              onClick={() => setWhich(id)}
            >
              <span className={styles.lookDot} style={{ background: colour }} />
              {label}
            </button>
          ))}
        </div>
      )}
      {editAccent ? (
        <Swatches
          component={component}
          accent
          value={accent}
          gesture={`${gesture}:accent`}
          label={t('Second color')}
          auto={{ colour: toneOnTone(base), on: value.accent === null, onPick: () => onAccent(null, null) }}
          onTint={(hex, g) => onAccent(hex, g)}
          onGestureEnd={onGestureEnd}
        />
      ) : (
        <Swatches
          component={component}
          value={value.tint}
          gesture={gesture}
          cycle={component.cycle ? { on: value.cycle, onToggle: onCycle } : undefined}
          onTint={onTint}
          onGestureEnd={onGestureEnd}
        />
      )}
      {patterns.length > 0 && (
        <div className={styles.patterns} role="radiogroup" aria-label={t('Pattern')}>
          <button
            type="button"
            role="radio"
            aria-checked={!patterned}
            title={t('Plain')}
            className={!patterned ? `${styles.pattern} ${styles.patternOn}` : styles.pattern}
            onClick={() => {
              setWhich('base');
              onPattern(PLAIN_PATTERN);
            }}
          >
            <span className={styles.patternPlain} style={{ background: base }} />
            <span className={styles.patternName}>{t('Plain')}</span>
          </button>
          {patterns.map((def) => {
            const on = resolved?.def.id === def.id;
            return (
              <button
                key={def.id}
                type="button"
                role="radio"
                aria-checked={on}
                title={t(def.name)}
                className={on ? `${styles.pattern} ${styles.patternOn}` : styles.pattern}
                onClick={() => onPattern(def.id)}
              >
                <PatternSwatch pack={pack} def={def} base={base} accent={accent} />
                <span className={styles.patternName}>{t(def.name)}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── The editor ──────────────────────────────────────────────────────────────

export function RoomEditor(props: RoomEditorProps): React.ReactElement {
  const { source, characterId, onClose, clock, fps = 30, initial, inline, telemetry, together } = props;
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
  // 261106: the guided setup run (null = the normal editor).
  const [guide, setGuide] = useState<GuideRun | null>(null);
  const guideRef = useRef(guide);
  guideRef.current = guide;
  /** A save the guide asked for, run after the render that applied its edit (`setup`: the marker to save, null for none). */
  const [guideSave, setGuideSave] = useState<{ n: number; setup: RoomSetupStep[] | null; close: boolean } | null>(null);
  // 261107: the "Open on login" step after Done (null = not up), and whether it is due (main said so).
  const [loginStep, setLoginStep] = useState<LoginStepUi | null>(null);
  const loginStepRef = useRef(loginStep);
  loginStepRef.current = loginStep;
  const loginDue = useRef(false);
  /** An answer main took (or the approval note is up): closing after it is not `closed`. */
  const loginAnswered = useRef(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef(new RoomPicker());
  const dragRef = useRef<{ index: number; pointerId: number; dx: number; dy: number; sx: number; sy: number; lifted: boolean; surface: number } | null>(null);
  const historyRef = useRef(history);
  historyRef.current = history;
  const packsRef = useRef(packs);
  packsRef.current = packs;
  /** The last pattern she picked this session (analytics, 261105). */
  const lastPattern = useRef<string | null>(null);
  const presetNow = history?.present.preset ?? null;
  const lightSlots = useMemo(() => {
    const m = packs?.find((p) => p.id === presetNow)?.manifest;
    return m ? lightSlotsOf(m) : undefined;
  }, [packs, presetNow]);
  const roomShape = useCallback(() => {
    const st = historyRef.current?.present;
    const m = st ? packsRef.current?.find((p) => p.id === st.preset)?.manifest : undefined;
    return st && m ? roomShapeOf(m, st, lastPattern.current) : undefined;
  }, []);
  // ── the guided setup: its steps for the room now, the step on screen, and the panel that step shows ──
  const guiding = guide !== null;
  const presentNow = history?.present ?? null;
  const guideSteps = useMemo(() => {
    const m = presentNow ? packs?.find((p) => p.id === presentNow.preset)?.manifest : undefined;
    return guiding && presentNow && m ? guideStepsFor(m, presentNow) : [];
  }, [guiding, presentNow, packs]);
  // A step the room no longer has (another pack) gives way to the next one it has.
  const gStep: RoomSetupStep | null = guide
    ? guideSteps.includes(guide.step)
      ? guide.step
      : (guideSteps.find((x) => ROOM_SETUP_STEPS.indexOf(x) > ROOM_SETUP_STEPS.indexOf(guide.step)) ?? guideSteps[guideSteps.length - 1] ?? null)
    : null;
  const shownPanel: Group | null = gStep ? SETUP_PANEL[gStep] : panel;
  const analytics = useEditorAnalytics(telemetry ? { ...telemetry, characterId } : null, {
    history,
    panel: shownPanel,
    saving,
    loadError,
    packsEmpty: packs !== null && packs.length === 0,
    lightSlots,
    shape: roomShape,
  });
  const colorTelemetry = useMemo<ColorPickTelemetry>(() => ({ pickerOpened: analytics.pickerOpened, picked: analytics.colorPicked }), [analytics.pickerOpened, analytics.colorPicked]);

  // ── load ──
  const loadAll = useCallback(async (): Promise<void> => {
    try {
      const [list, saved] = await Promise.all([source.packs(), source.load().catch(() => null)]);
      setPacks(list);
      if (!list.length) return;
      const pack = list.find((p) => p.id === saved?.preset) ?? list[0];
      // The clean point is what is on disk; a room whose pack is missing here starts dirty on the first pack.
      // The setup marker never enters the history (it is added on save while the guide runs).
      const savedClean = saved && saved.preset === pack.id ? withoutSetup(sanitizeRoomState(pack.manifest, saved)) : saved && withoutSetup(saved);
      const start = initial?.state ?? saved;
      const state =
        start && start.preset === pack.id
          ? start === saved
            ? savedClean!
            : withoutSetup(sanitizeRoomState(pack.manifest, start))
          : { ...defaultRoomState(pack.id), time: start?.time ?? 'auto', avatar: start?.avatar ?? { kind: 'sei' as const } };
      setHistory(createHistory(state, savedClean));
      if (props.guided !== false && !initial?.panel && opensGuided(saved) && saved?.preset === pack.id) {
        const done = saved.setup?.done ?? [];
        const plain = state.plain === true;
        setGuide({ step: resumeStep(guideStepsFor(pack.manifest, state), done, plain), done, completed: 0, skipped: 0, resumed: Boolean(saved.setup), plain, at: Date.now() });
      }
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
          const clean = withoutSetup(s);
          setHistory((cur) => (cur && !isDirty(cur) ? createHistory(clean, clean) : cur));
        });
      }),
    [source],
  );

  const state = history?.present ?? null;
  const pack = useMemo(() => (state && packs ? (packs.find((p) => p.id === state.preset) ?? null) : null), [packs, state]);
  const manifest = pack?.manifest ?? null;
  // A slot asked for up front opens its group in this pack once the pack is known (a pack can move a slot).
  const initialPlaced = useRef(false);
  useEffect(() => {
    if (initialPlaced.current || !initialSlot || !manifest) return;
    initialPlaced.current = true;
    setPanel(slotGroup(initialSlot, manifest));
  }, [manifest, initialSlot]);
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
    () => ({ room: groupSlots(slots, 'room', manifest), fabrics: groupSlots(slots, 'fabrics', manifest), furniture: groupSlots(slots, 'furniture', manifest) }),
    [slots, manifest],
  );

  /** Open the group that holds `slot`, with its section in view. */
  const openSlot = (slot: RoomSlotId): void => {
    const group = slotGroup(slot, manifest);
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

  // 261105 (T336): her commits, one undo step each, and their undo.
  const commitHers = useCallback((next: RoomState) => {
    setHistory((h) => (h ? commitEdit(endGesture(h), next, null) : h));
    setSaving((s) => (s === 'saved' || s === 'error' ? 'idle' : s));
  }, []);
  const undoIf = useCallback((st: RoomState): boolean => {
    if (historyRef.current?.present !== st) return false;
    setHistory((h) => (h && h.present === st ? undo(h) : h));
    return true;
  }, []);

  // 261105 (T336): over the fullscreen editor, modals (the usage wall, the call inactivity check) must still show.
  useEffect(() => {
    if (inline) return;
    const root = document.documentElement;
    root.style.setProperty('--sei-modal-lift', '1500');
    return () => {
      root.style.removeProperty('--sei-modal-lift');
    };
  }, [inline]);

  /** Save. While the guide runs the room carries the steps done so far (`setup` overrides: null = no marker). */
  const doSave = useCallback(async (setup?: RoomSetupStep[] | null): Promise<boolean> => {
    const h = historyRef.current;
    if (!h) return false;
    const sent = h.present;
    const done = setup === undefined ? (guideRef.current?.done ?? null) : setup;
    setSaving('saving');
    try {
      const saved = withoutSetup(await source.save(done ? { ...sent, setup: { done } } : sent));
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
    const target = packs?.find((p) => p.id === id);
    if (!target) return;
    setSelected(null);
    // Guided: a room is picked bare (furniture and extras have their own steps), and that ends the plain background.
    if (guideRef.current) edit((s) => (s.preset === id && !s.plain ? s : bareRoomState(target.manifest, s)));
    else edit((s) => switchPreset(s, id));
  };

  // ── the guided setup's analytics (shape only; the companion editor only) and buttons ──
  const trackSetup = useCallback(
    (event: typeof SEILINK_SETUP_EVENT | typeof SEILINK_SETUP_STEP_EVENT, props: Record<string, string | number | boolean | null>): void => {
      if (!telemetry) return;
      try {
        sei.track(event, { character_id: characterId ?? null, ...props });
      } catch {
        /* analytics must never disrupt the editor */
      }
    },
    [telemetry, characterId],
  );
  const runProps = (g: GuideRun, action: SetupAction, step: RoomSetupStep | null): Record<string, string | number | boolean | null> => ({
    action,
    step,
    surface: telemetry?.surface ?? 'app',
    plain: g.plain,
    steps_completed: g.completed,
    steps_skipped: g.skipped,
    steps_total: guideSteps.length,
    ms_open: Date.now() - g.at,
    opened_from: telemetry?.openedFrom ?? null,
  });
  const stepEvent = (step: RoomSetupStep, action: SetupStepAction, extra: Record<string, boolean | number> = {}): void =>
    trackSetup(SEILINK_SETUP_STEP_EVENT, { step, action, resumed: guideRef.current?.resumed === true, index: guideSteps.indexOf(step) + 1, ...extra });

  // Started (or resumed) once per run; each step shown once each time it comes up.
  const runOpened = useRef(false);
  useEffect(() => {
    if (!guide || runOpened.current) return;
    runOpened.current = true;
    trackSetup(SEILINK_SETUP_EVENT, runProps(guide, guide.resumed ? 'resumed' : 'started', gStep));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guide !== null]);
  /** The room when the step came up (`changed` on its completion). */
  const stepFrom = useRef<string | null>(null);
  useEffect(() => {
    if (!gStep) return;
    stepFrom.current = historyRef.current ? JSON.stringify(historyRef.current.present) : null;
    stepEvent(gStep, 'shown');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gStep]);
  // Closed before Done (the close button, Escape, Not now): abandoned, at the step on screen.
  const gStepRef = useRef(gStep);
  gStepRef.current = gStep;
  const runPropsRef = useRef(runProps);
  runPropsRef.current = runProps;
  useEffect(
    () => () => {
      const g = guideRef.current;
      if (g && runOpened.current) trackSetup(SEILINK_SETUP_EVENT, runPropsRef.current(g, 'abandoned', gStepRef.current));
    },
    [trackSetup],
  );

  // The guide's saves run after the render that applied its edit, so they save what is on screen.
  useEffect(() => {
    if (!guideSave) return;
    void doSave(guideSave.setup).then((ok) => {
      if (ok && guideSave.close) onClose();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guideSave]);

  /** Next (Done on the last step) and Skip: mark the step done, save, go on. */
  const guideOn = (how: 'completed' | 'skipped'): void => {
    const g = guideRef.current;
    const h = historyRef.current;
    if (!g || !gStep || !h || !packs) return;
    // Next on the room step while she is still plain takes the room shown picked (bare).
    if (how === 'completed' && gStep === 'room' && h.present.plain) {
      const m = packs.find((p) => p.id === h.present.preset)?.manifest;
      if (m) edit((s) => bareRoomState(m, s));
    }
    const changed = how === 'completed' && stepFrom.current !== JSON.stringify(h.present);
    stepEvent(gStep, how, how === 'completed' ? { changed: changed || (gStep === 'room' && h.present.plain === true) } : {});
    const done = markDone(g.done, gStep);
    const run: GuideRun = { ...g, done, completed: g.completed + (how === 'completed' ? 1 : 0), skipped: g.skipped + (how === 'skipped' ? 1 : 0) };
    const next = nextStep(guideSteps, gStep);
    if (next) {
      setGuide({ ...run, step: next });
      setGuideSave((r) => ({ n: (r?.n ?? 0) + 1, setup: done, close: false }));
      return;
    }
    // Done: the run is over; the room is saved without the marker and the editor closes onto it
    // (261107: or the "Open on login" step comes up first, once).
    trackSetup(SEILINK_SETUP_EVENT, runProps(run, 'finished', gStep));
    setGuide(null);
    setPanel(null);
    const login = loginDue.current;
    setGuideSave((r) => ({ n: (r?.n ?? 0) + 1, setup: null, close: !login }));
    if (login) openLoginStep(run.resumed);
  };
  const guideBack = (): void => {
    const g = guideRef.current;
    const prev = gStep ? prevStep(guideSteps, gStep) : null;
    if (!g || !gStep || !prev) return;
    stepEvent(gStep, 'back');
    setSelected(null);
    setGuide({ ...g, step: prev });
  };

  // ── 261107: the "Open on login" step (lib/seilink/loginStep.ts) ──
  const openAtLogin = props.openAtLogin ?? null;
  const openLoginStep = (resumed: boolean): void => {
    loginDue.current = false;
    setSelected(null);
    setLoginStep({ busy: false, note: null, resumed });
    trackSetup(SEILINK_SETUP_STEP_EVENT, { step: 'login', action: 'shown', resumed });
  };
  // Asked once, when a guided run opens (or for a dev shot that opens on the step).
  const loginAsked = useRef(false);
  useEffect(() => {
    if (!openAtLogin || loginAsked.current || (!guide && !initial?.loginStep)) return;
    loginAsked.current = true;
    void openAtLogin.get().then(
      (s) => {
        loginDue.current = offersLoginStep(s);
        if (initial?.loginStep && loginDue.current) openLoginStep(false);
      },
      () => {},
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openAtLogin, guide !== null]);
  const closeFromLogin = (): void => {
    loginAnswered.current = true;
    setLoginStep(null);
    onClose();
  };
  /** "Turn on" (the preselected answer) or "Not now": main applies it and reads the OS back. */
  const answerLogin = (on: boolean): void => {
    const ls = loginStepRef.current;
    if (!ls || ls.busy) return;
    if (!openAtLogin) return closeFromLogin();
    setLoginStep({ ...ls, busy: true });
    void openAtLogin
      .set(on)
      .catch(() => null)
      .then((s) => {
        trackSetup(SEILINK_SETUP_STEP_EVENT, {
          step: 'login',
          action: on ? 'completed' : 'skipped',
          resumed: ls.resumed,
          enabled: on,
          kept_default: on === LOGIN_STEP_DEFAULT,
          ok: s?.enabled === on,
        });
        const after = loginStepAfter(on, s);
        if (after === 'close') return closeFromLogin();
        if (after === 'approval') loginAnswered.current = true;
        setLoginStep({ ...ls, busy: false, note: after });
      });
  };
  // Closed on the step without an answer (the close button, Escape): nothing was registered.
  useEffect(
    () => () => {
      const ls = loginStepRef.current;
      if (ls && !loginAnswered.current) trackSetup(SEILINK_SETUP_STEP_EVENT, { step: 'login', action: 'closed', resumed: ls.resumed });
    },
    [trackSetup],
  );

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
      // The custom colour popover handles its own keys (Escape closes it, not the panel).
      if (target?.closest?.('[data-color-picker]')) return;
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
        else if (panel && !guideRef.current) setPanel(null);
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
        aria-label={t(slotLabel(manifest, slot))}
        data-slot={slot}
      >
        <h2 className={styles.title}>{t(slotLabel(manifest, slot))}</h2>
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
          <PartLook
            key={comp.id}
            pack={pack}
            component={comp}
            value={{
              tint: slotTint(slot),
              pattern: currentPattern(comp, state.slots[slot]?.pattern),
              accent: state.slots[slot]?.accent ?? null,
              cycle: Boolean(state.slots[slot]?.cycle && comp.cycle),
            }}
            gesture={`tint:${slot}`}
            onTint={(hex, g) => edit((s) => setSlotTint(manifest, s, slot, hex), g)}
            onPattern={(id) => {
              lastPattern.current = id;
              edit((s) => setSlotPattern(manifest, s, slot, id));
            }}
            onAccent={(hex, g) => edit((s) => setSlotAccent(manifest, s, slot, hex), g)}
            onCycle={(on) => edit((s) => setSlotCycle(manifest, s, slot, on))}
            onGestureEnd={endEditGesture}
          />
        )}
      </div>
    );
  };

  // ── panels ──
  const renderPanel = (): React.ReactNode => {
    const panel = shownPanel;
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
                    data-preset={id}
                    aria-pressed={on}
                    disabled={!p}
                    onClick={() => pickPreset(id)}
                  >
                    {p ? (
                      <RoomCard
                        pack={p}
                        // Guided: each room as it would come in (bare); the plain background has nothing to show, so its room is drawn bare too.
                        state={on && !state.plain ? state : guide ? bareRoomState(p.manifest, state) : defaultRoomState(id)}
                        time={time}
                      />
                    ) : (
                      <span className={styles.cardWait} />
                    )}
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

  /** The guided setup (in place of the rail): which step of how many, its title and line, its panel, and Back / Skip / Next. */
  const renderGuide = (step: RoomSetupStep, g: GuideRun): React.ReactElement => {
    const n = guideSteps.indexOf(step) + 1;
    const last = nextStep(guideSteps, step) === null;
    const back = prevStep(guideSteps, step);
    const copy = SETUP_COPY[step];
    // On the room step while she has no room yet there is nothing to skip to: the choice is now or later.
    const later = step === 'room' && state.plain === true;
    return (
      <section className={styles.guide} aria-label={t(copy.title)} data-setup-step={step}>
        <header className={styles.guideHead}>
          <div className={styles.guideCount}>
            <span>{t('Step {n} of {m}', { n, m: guideSteps.length })}</span>
            <span className={styles.guideDots} aria-hidden="true">
              {guideSteps.map((x) => (
                <span key={x} className={x === step ? `${styles.guideDot} ${styles.guideDotOn}` : g.done.includes(x) ? `${styles.guideDot} ${styles.guideDotDone}` : styles.guideDot} />
              ))}
            </span>
          </div>
          <h2 className={styles.guideTitle}>{t(copy.title)}</h2>
          <p className={styles.note}>{t(copy.hint)}</p>
        </header>
        <div className={styles.guideBody}>{renderPanel()}</div>
        <footer className={styles.guideFoot}>
          {back ? (
            <button type="button" className={styles.pill} onClick={guideBack}>
              {t('Back')}
            </button>
          ) : null}
          <span className={styles.guideGap} />
          {later ? (
            <button type="button" className={styles.pill} onClick={requestClose}>
              {t('Not now')}
            </button>
          ) : (
            <button type="button" className={styles.pill} onClick={() => guideOn('skipped')}>
              {t('Skip')}
            </button>
          )}
          <button type="button" className={`${styles.pill} ${styles.pillHot}`} onClick={() => guideOn('completed')}>
            {last ? t('Done') : t('Next')}
          </button>
        </footer>
      </section>
    );
  };

  /** 261107: "Open on login" after Done, in the guide's frame: a title, one line, "Not now" and "Turn on" (preselected). */
  const renderLoginStep = (ls: LoginStepUi): React.ReactElement => (
    <section className={styles.guide} aria-label={t('Open on login')} data-setup-step="login">
      <header className={styles.guideHead}>
        <h2 className={styles.guideTitle}>{t('Open on login')}</h2>
        {props.name ? <p className={styles.note}>{t('{name} comes back after a restart.', { name: props.name })}</p> : null}
        {ls.note ? (
          <p className={styles.loginNote} role="status">
            {ls.note === 'approval' ? t('Allow Sei in System Settings, under General > Login Items.') : t('Could not change this setting. Try again.')}
          </p>
        ) : null}
      </header>
      <footer className={styles.guideFoot}>
        <span className={styles.guideGap} />
        {ls.note === 'approval' ? (
          <button type="button" className={`${styles.pill} ${styles.pillHot}`} onClick={closeFromLogin}>
            {t('Done')}
          </button>
        ) : (
          <>
            <button type="button" className={styles.pill} disabled={ls.busy} onClick={() => answerLogin(false)}>
              {t('Not now')}
            </button>
            <button type="button" className={`${styles.pill} ${styles.pillHot}`} disabled={ls.busy} onClick={() => answerLogin(true)}>
              {t('Turn on')}
            </button>
          </>
        )}
      </footer>
    </section>
  );

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
        avatar={(slot) => <EditorAvatar slot={slot} state={state} characterId={characterId} portrait={props.portrait} name={props.name} />}
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
              <PartLook
                key={`${selected}:${selComp.id}`}
                pack={pack}
                component={selComp}
                value={{ tint: currentTint(selComp, selItem.tint), pattern: currentPattern(selComp, selItem.pattern), accent: selItem.accent ?? null, cycle: false }}
                gesture={`tint:item:${selected}`}
                onTint={(hex, g) => edit((s) => setItemTint(manifest, s, selected, hex), g)}
                onPattern={(id) => {
                  lastPattern.current = id;
                  edit((s) => setItemPattern(manifest, s, selected, id));
                }}
                onAccent={(hex, g) => edit((s) => setItemAccent(manifest, s, selected, hex), g)}
                onCycle={() => {}}
                onGestureEnd={endEditGesture}
              />
            )}
          </div>
        )}

        {/* While an item is dragged the side panel fades away, so the shelves under it show. */}
        <div className={drag ? `${styles.side} ${styles.sideAway}` : styles.side} data-color-host="">
          {loginStep ? (
            renderLoginStep(loginStep)
          ) : gStep && guide ? (
            renderGuide(gStep, guide)
          ) : (
            <>
              <nav className={panel ? `${styles.rail} ${styles.railOpen}` : styles.rail} aria-label={t('Room')}>
                {tile('avatar', t('Avatar'), <PersonIcon size={RAIL_ICON} />)}
                {tile('room', t('Room'), <HouseIcon size={RAIL_ICON} />)}
                {sections.fabrics.length > 0 && tile('fabrics', t(GROUP_LABEL.fabrics), <RollerIcon size={RAIL_ICON} />)}
                {sections.furniture.length > 0 && tile('furniture', t(GROUP_LABEL.furniture), <ChairIcon size={RAIL_ICON} />)}
                {items.length > 0 && tile('items', t('Items'), <BagIcon size={RAIL_ICON} />)}
              </nav>
              {renderPanel()}
            </>
          )}
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

        {together?.({
          manifest,
          state,
          history,
          pack,
          time,
          vp,
          picker: pickerRef.current,
          pickTick,
          commit: commitHers,
          undoIf,
          analytics: analytics.together,
          sceneEl: () => (stageRef.current?.closest('[data-room-editor]')?.querySelector('canvas')?.parentElement as HTMLElement | null) ?? null,
        })}

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
  return wrap(<ColorPickTelemetryContext.Provider value={colorTelemetry}>{body}</ColorPickTelemetryContext.Provider>);
}
