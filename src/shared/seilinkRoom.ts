/**
 * SeiLink room format v1 (261104, Shawn's "SeiLink visuals" doc, msg 1531).
 *
 * A room is a fixed webcam-POV scene: she sits at her desk facing the player,
 * so no desk is drawn. Lower center holds her chair (drawn behind her), a
 * large window sits on the right, and a bed or shelf fills the rest.
 * Everything is modular: each part of the room is a slot that holds one
 * component, components can be swapped, and tintable components can be
 * recoloured. Small things the player places are items.
 *
 * Three presets to start (quality over quantity): cozy, gamer, forest
 * (outdoor campfire, lit at night). Each cycles day, dusk and night.
 *
 * Draw order: slots sorted by z ascending, the avatar at AVATAR_Z, then items
 * by their own z. A component's frame for the current time of day is drawn
 * at (0,0) on the preset canvas (frames are full-canvas, transparent where
 * empty) unless it has a box. A tintable frame's mask (white = recolour) is
 * multiplied with the tint inside the mask, keeping the frame's shading.
 * A frame's glow (an additive light layer: lamp, campfire, monitor) is drawn
 * with 'screen' after everything else.
 *
 * The AI side reads describeRoom(): a short place line for the prompt and a
 * plain list of what is in the room for look().
 *
 * 261104 (host pass) additions, all optional so v1 packs stay valid:
 *  - Items are sprites, not full-canvas frames. A placement's (x, y) is the
 *    BOTTOM CENTRE of the sprite in canvas px; its size is the frame's
 *    natural size (or the component's box w/h) times `scale`; `flip` mirrors
 *    it. Default item z by placement: wall ITEM_Z.wall, surface
 *    ITEM_Z.surface, floor ITEM_Z.floor (all behind her); the component's z or
 *    the placement's own z wins.
 *  - Ties in z draw slots first, then the avatar, then items.
 *  - A frame may carry `effect` for its glow: 'flicker' (campfire) or 'pulse'
 *    (monitor, lamp). The renderer animates only these and the avatar.
 *  - Draw plan, time-of-day crossfade and overlay helpers live in
 *    seilinkDraw.ts; manifest/state validation in seilinkValidate.ts.
 *
 * 261104 (editor pass) additions, also optional:
 *  - A placed item may carry its own `tint` (a tintable item with a mask,
 *    e.g. a floor cushion), drawn the same way as a slot tint.
 *  - A slot component may list `surfaces`: boxes (canvas px) where a
 *    'surface' item's bottom centre may rest, e.g. the top of each shelf
 *    plank. The editor snaps surface items into them; with none, surface
 *    items move freely.
 *  - A tintable component may list `swatches`, the colours the editor offers
 *    first (its defaultTint is always offered too).
 *  - Editor rules (placement areas, scale range, edit ops, undo) live in
 *    seilinkEdit.ts.
 *
 * 261105 (placement pass, Shawn: "the bottom of furniture has to touch"
 * the ground or shelf), all optional; a pack without them places as before:
 *  - `floorAreas` (manifest): polygons of real floor, canvas px, following the
 *    room's perspective. A floor item's bottom centre stands inside one. They
 *    replace the legacy `floor` box.
 *  - `wallAreas` (manifest): polygons of bare wall (no window glass). A wall
 *    item's whole sprite hangs inside them.
 *  - `horizon` (manifest): eye level, canvas y. Floor items further back
 *    (higher on screen) are drawn smaller, by (y - horizon) / (yRef - horizon)
 *    where yRef is the item's own box bottom (its artist spot keeps its drawn
 *    size), else the front of the floor. Without it a typical eye level is
 *    guessed from the floor areas.
 *  - `surfaceLines` (slot components): [x1, y1, x2, y2] lines along a plank,
 *    desk or nightstand top, through the middle of its top face. A surface
 *    item's bottom centre sits ON the line, x free along it.
 *  - `surfaceAreas` (slot components): polygons a surface item may rest
 *    anywhere inside (a bed top). Legacy `surfaces` boxes still work.
 *  - `blocks` (slot components): `{ floor, wall }` polygons the part covers
 *    while it is in the room (a bed's footprint, a lamp's pole). Removing the
 *    part frees them. Surface items whose part is removed fall to the floor.
 *  - Draw order: a floor item's z is ITEM_Z.floor plus a fraction that grows
 *    with its y (nearer = in front of further back); a surface item takes the
 *    z of the part it rests on plus a half. Rules live in seilinkPlace.ts.
 *
 * 261105 (shelf pass, Shawn: "make it forgiving ... on the shelf it's just a
 * line", "make the item go INSIDE the shelf not on top"), also optional:
 *  - `surfaceTops` (slot components): the whole visible top face of a plank,
 *    desk, log or bed, as `{ area, lip?, sink? }`. `area` runs from the back
 *    edge to the front lip (a thin quad for a plank); a surface item's
 *    contact rests anywhere inside it, its sprite kept in from the ends.
 *    `lip` is where the part's own front edge is drawn (a plank's front face
 *    band, from the dark line at the front of the top face down): that much
 *    of the part's frame is drawn again over the items resting on this top,
 *    so the lip overlaps their base and they sit in the shelf, not on it.
 *    `sink` (px at scale 1) is for a soft top (a duvet): an item's base
 *    settles that far in, fading into the top, with a soft contact shadow.
 *    Prefer surfaceTops over surfaceLines / surfaceAreas, which still work.
 *  - Items on one part's tops draw in order of the tops (back to front by
 *    their y): items on a top, then its lip, then the next top's items.
 */

export const SEILINK_ROOM_FORMAT = 'sei-room' as const;
export const SEILINK_ROOM_VERSION = 1 as const;

export type RoomTime = 'day' | 'dusk' | 'night';
export const ROOM_TIMES: readonly RoomTime[] = ['day', 'dusk', 'night'];

export type RoomPresetId = 'cozy' | 'gamer' | 'forest';
export const ROOM_PRESET_IDS: readonly RoomPresetId[] = ['cozy', 'gamer', 'forest'];

/** Slot ids. A preset uses the subset that fits it (forest has no curtains). */
export type RoomSlotId =
  | 'view' // what is outside the window (or the sky, outdoors)
  | 'shell' // walls, floor, window frame (indoor) or ground and trees (forest)
  | 'curtains'
  | 'bed'
  | 'shelf'
  | 'chair' // drawn behind her
  | 'lamp'
  | 'rug'
  | 'campfire';

/** z of the avatar. Slots below it are behind her, above it in front. */
export const AVATAR_Z = 100;

export type RoomBox = [x: number, y: number, w: number, h: number];
export type RoomPoint = [x: number, y: number];
/** A closed polygon, canvas px, at least 3 points. */
export type RoomPolygon = RoomPoint[];
/** A line from (x1, y1) to (x2, y2), canvas px. */
export type RoomSegment = [x1: number, y1: number, x2: number, y2: number];

/** A surface top of a slot component (261105 shelf pass); see the header. */
export interface RoomSurfaceTop {
  /** The whole visible top face, canvas px: back edge to front lip. */
  area: RoomPolygon;
  /** The part's front lip, canvas px: its frame cut to this is drawn over the items on this top. */
  lip?: RoomPolygon;
  /** Soft top: px (sprite scale 1) an item's base settles into it. */
  sink?: number;
}

export interface RoomFrame {
  /** Path relative to the pack root. */
  src: string;
  /** White where a tint applies. Required when the component is tintable. */
  mask?: string;
  /** Additive light layer drawn with 'screen' on top of the scene. */
  glow?: string;
  /** How the glow moves (261104). Absent: a still glow. */
  effect?: RoomGlowEffect;
}

export type RoomGlowEffect = 'flicker' | 'pulse';

/** Default item z by placement (261104). All behind her (AVATAR_Z = 100). */
export const ITEM_Z: Readonly<Record<'wall' | 'surface' | 'floor', number>> = { wall: 15, surface: 60, floor: 70 };

export interface RoomComponent {
  id: string;
  slot: RoomSlotId | 'item';
  /** Short plain name the AI sees in look(), e.g. "purple curtains" is built from tintName + name. */
  name: string;
  tintable?: boolean;
  /** Hex, used when the room state has no tint for it. */
  defaultTint?: string;
  /** Frames per time of day. A missing time falls back to day. */
  frames: Partial<Record<RoomTime, RoomFrame>> & { day: RoomFrame };
  /** Items only: where it may sit. */
  placement?: 'floor' | 'wall' | 'surface';
  /**
   * Items only (261105): depth of the soft contact shadow at the bottom of the
   * sprite, sprite px at scale 1. A floor item keeps this much floor behind
   * its anchor, so it never stands half up the back wall.
   */
  foot?: number;
  /** Only for full-canvas slot art that is smaller than the canvas. */
  box?: RoomBox;
  z?: number;
  /** Slot components: where surface items may rest (bottom-centre boxes, canvas px). Legacy; prefer surfaceLines. */
  surfaces?: RoomBox[];
  /** Slot components: plank / desk tops a surface item's bottom sits on (261105). */
  surfaceLines?: RoomSegment[];
  /** Slot components: areas a surface item may rest anywhere inside, e.g. a bed top (261105). */
  surfaceAreas?: RoomPolygon[];
  /** Slot components: whole top faces with their lip and give (261105 shelf pass). Preferred. */
  surfaceTops?: RoomSurfaceTop[];
  /** Slot components: floor and wall this part covers while it is in the room (261105). */
  blocks?: { floor?: RoomPolygon[]; wall?: RoomPolygon[] };
  /** Tintable components: colours the editor offers first. */
  swatches?: string[];
}

export interface RoomSlotDef {
  z: number;
  /** Component ids that fit this slot. The first is the default. */
  options: string[];
  /** Slot can be left empty (e.g. no rug). */
  optional?: boolean;
}

export interface RoomPresetManifest {
  format: typeof SEILINK_ROOM_FORMAT;
  version: typeof SEILINK_ROOM_VERSION;
  id: RoomPresetId;
  /** Plain place name for the prompt: "your bedroom", "your gaming room", "a campfire in the forest". */
  place: string;
  canvas: [w: number, h: number];
  /** Where she sits: bottom center of her body in canvas px, and her height in canvas px. */
  avatar: { x: number; y: number; height: number };
  /** Floor area items may be placed on (canvas px), for the editor. Legacy; floorAreas wins. */
  floor?: RoomBox;
  /** Real floor, as polygons following the perspective (261105). */
  floorAreas?: RoomPolygon[];
  /** Bare wall where wall items hang (261105). */
  wallAreas?: RoomPolygon[];
  /** Eye level, canvas y, for the depth scale of floor items (261105). */
  horizon?: number;
  slots: Partial<Record<RoomSlotId, RoomSlotDef>>;
  components: RoomComponent[];
  /** Hex colours per time of day for the editor overlay tint (light room, light overlay). */
  overlay?: Partial<Record<RoomTime, string>>;
}

export interface RoomItemPlacement {
  id: string;
  /** Bottom centre of the sprite, canvas px. */
  x: number;
  y: number;
  scale?: number;
  flip?: boolean;
  /** Overrides the component/placement default z (editor "bring forward"). */
  z?: number;
  /** Hex tint for a tintable item (else its defaultTint). */
  tint?: string;
}

/** What a companion's room looks like. Lives on the device, a few KB. */
export interface RoomState {
  version: typeof SEILINK_ROOM_VERSION;
  preset: RoomPresetId;
  /** auto follows the computer's clock. */
  time: RoomTime | 'auto';
  /** Per slot: chosen component (null = empty optional slot) and tint. */
  slots: Partial<Record<RoomSlotId, { id: string | null; tint?: string }>>;
  items: RoomItemPlacement[];
  avatar: { kind: 'sei' } | { kind: 'live2d'; modelPath: string };
}

export function defaultRoomState(preset: RoomPresetId = 'cozy'): RoomState {
  return { version: SEILINK_ROOM_VERSION, preset, time: 'auto', slots: {}, items: [], avatar: { kind: 'sei' } };
}

/** Clock time to room time: dawn and dusk both use the dusk art. */
export function roomTimeAt(date: Date): RoomTime {
  const h = date.getHours() + date.getMinutes() / 60;
  if (h >= 7 && h < 17) return 'day';
  if ((h >= 5 && h < 7) || (h >= 17 && h < 19.5)) return 'dusk';
  return 'night';
}

export function resolveRoomTime(state: Pick<RoomState, 'time'>, now: Date = new Date()): RoomTime {
  return state.time === 'auto' ? roomTimeAt(now) : state.time;
}

/** The component in each slot after defaults (null = empty). */
export function resolveSlots(manifest: RoomPresetManifest, state: RoomState): Array<{ slot: RoomSlotId; component: RoomComponent; tint?: string }> {
  const byId = new Map(manifest.components.map((c) => [c.id, c]));
  const out: Array<{ slot: RoomSlotId; component: RoomComponent; tint?: string }> = [];
  for (const [slot, def] of Object.entries(manifest.slots) as Array<[RoomSlotId, RoomSlotDef]>) {
    const chosen = state.slots[slot];
    const id = chosen && chosen.id !== undefined ? chosen.id : def.options[0];
    if (id === null) continue;
    const component = byId.get(id) ?? byId.get(def.options[0]);
    if (!component) continue;
    out.push({ slot, component, tint: chosen?.tint ?? component.defaultTint });
  }
  return out.sort((a, b) => manifest.slots[a.slot]!.z - manifest.slots[b.slot]!.z);
}

/** Basic colour words for tints, so look() can say "purple curtains". */
export function tintName(hex: string | undefined): string | null {
  if (!hex || !/^#?[0-9a-f]{6}$/i.test(hex)) return null;
  const n = parseInt(hex.replace('#', ''), 16);
  const r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (d < 0.08) return l > 0.85 ? 'white' : l < 0.18 ? 'black' : 'gray';
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  if (l < 0.3 && (h < 45 || h >= 345)) return 'brown';
  if (h < 15 || h >= 345) return l > 0.7 ? 'pink' : 'red';
  if (h < 45) return l < 0.45 ? 'brown' : 'orange';
  if (h < 70) return 'yellow';
  if (h < 160) return 'green';
  if (h < 200) return 'teal';
  if (h < 255) return 'blue';
  if (h < 290) return 'purple';
  return 'pink';
}

/** What the AI knows about her room: a place line and a plain item list. */
export function describeRoom(manifest: RoomPresetManifest, state: RoomState, now: Date = new Date()): { place: string; time: RoomTime; things: string[] } {
  const time = resolveRoomTime(state, now);
  const things: string[] = [];
  for (const { component, tint } of resolveSlots(manifest, state)) {
    if (component.slot === 'shell' || component.slot === 'view') continue;
    const colour = component.tintable ? tintName(tint) : null;
    things.push(colour ? `${colour} ${component.name}` : component.name);
  }
  const byId = new Map(manifest.components.map((c) => [c.id, c]));
  for (const it of state.items) {
    const c = byId.get(it.id);
    if (!c) continue;
    const colour = c.tintable ? tintName(it.tint ?? c.defaultTint) : null;
    things.push(colour ? `${colour} ${c.name}` : c.name);
  }
  return { place: manifest.place, time, things };
}
