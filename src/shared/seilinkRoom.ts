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
 *
 * 261105 (room catalog engine, Shawn msgs 1590 + 1627), all optional, so
 * every pack and saved room from before reads and draws exactly as it did:
 *  - Patterns (seilinkPatterns.ts): a tintable component offers patterns
 *    through `patternSurface` (every pattern made for that kind of surface)
 *    or an explicit `patterns` list. `patternQuads` are its flat planes in
 *    FRAME px (the frame image's own pixels: canvas px for a full-canvas
 *    slot, sprite px for an item); without them the pattern lies flat over
 *    the frame. The state's slot (or item) entry gains `pattern` ('plain'
 *    for an explicit plain over a `defaultPattern`) and `accent` (the second
 *    colour; absent = tone-on-tone of the tint). Painted tiles are listed in
 *    the manifest's `patternTiles`, their files under the shared folder.
 *  - Shared files: a path starting `_shared/` is read from the shared pack
 *    folder next to the packs (resources/seilink-packs/_shared), so packs
 *    share window views and pattern tiles. A component with `fit: 'cover'`
 *    scales its frame to cover its box keeping its aspect, cropped around
 *    `focus` ([0..1, 0..1], default the centre), so one view fits windows of
 *    any shape.
 *  - Light colour: a frame's `glowTint` lights its glow in the part's tint
 *    (the glow's brightness times the colour). `cycle` on a component offers
 *    a colour-cycle choice (state `cycle: true`): the light runs through the
 *    hues on its own.
 *  - Particles: a frame's `particles` are procedural weather and ambience
 *    (rain, snow, petals, fireflies, embers, dust; seilinkParticles.ts). On
 *    a view they fall outside, behind the room's glass; elsewhere they are
 *    drawn over the scene in their `area`. Particle-only parts (fireflies)
 *    use the shared blank frame.
 *  - Slots `lights` (string lights, fireflies) and `tree` (forest), and a
 *    per-pack editor `label` on each slot def (English, translated in the
 *    i18n dictionaries): forest calls its bed slot "Tent".
 */
import { CODE_PATTERNS, PATTERN_ID_RE, codePattern, toneOnTone, type PatternDef, type PatternQuad, type PatternSurface } from './seilinkPatterns';
import type { RoomParticles } from './seilinkParticles';

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
  | 'campfire'
  | 'lights' // string lights, fairy lights, fireflies (261105)
  | 'tree'; // forest: the tree at the side of the clearing (261105)

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
  /** 261105: the glow is lit in the part's tint (its brightness times the colour), so a light can be any colour. */
  glowTint?: boolean;
  /** 261105: procedural weather and ambience this frame shows (see the header). */
  particles?: RoomParticles[];
  /**
   * 261105, indoor shell: white where the window glass is. Rain streaks run
   * down it and view particles stay behind it. Absent: the glass is worked
   * out from the view box minus what the room draws over it.
   */
  glass?: string;
  /** 261105: pattern planes for this time's frame when they differ from the component's. */
  patternQuads?: PatternQuad[];
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
  /** 261105: scale the frame to cover `box` keeping its aspect (shared views), cropped around `focus`. */
  fit?: 'cover';
  /** 261105: [0..1, 0..1] point of the frame kept in view by fit 'cover' (default the centre). */
  focus?: [number, number];
  /** 261105 patterns: the kind of surface (offers every pattern made for it). */
  patternSurface?: PatternSurface;
  /** 261105 patterns: the pattern ids offered, over patternSurface's list. */
  patterns?: string[];
  /** 261105 patterns: the tinted area's flat planes, frame px (see seilinkPatterns.ts). */
  patternQuads?: PatternQuad[];
  /** 261105 patterns: pattern size on this part (1 = the pattern's own period). */
  patternScale?: number;
  /** 261105 patterns: the pattern when the state names none. */
  defaultPattern?: string;
  /** 261105 patterns: the second colour when the state names none (else tone-on-tone of the tint). */
  defaultAccent?: string;
  /** 261105 light colour: offer a colour-cycle choice. */
  cycle?: boolean;
}

/** A painted pattern tile a pack offers (261105). The file is greyscale-ish: light = base, dark = accent. */
export interface RoomPatternTile {
  id: string;
  name: string;
  adjective: string;
  /** Pack-relative file, usually under `_shared/patterns/`. Seamless. */
  tile: string;
  /** Surface px one tile covers. */
  period: [number, number];
  surfaces: PatternSurface[];
}

/** A slot or item's pattern and colours, resolved (see resolvePattern). */
export interface RoomPatternChoice {
  def: PatternDef;
  /** Hex. */
  accent: string;
  /** Surface px per tile on this part. */
  period: [number, number];
}

/** Room editor panels that list slots (the rail's Room, Walls & fabrics and Furniture tiles). */
export type RoomEditorGroup = 'room' | 'fabrics' | 'furniture';
export const ROOM_EDITOR_GROUPS: readonly RoomEditorGroup[] = ['room', 'fabrics', 'furniture'];

export interface RoomSlotDef {
  z: number;
  /** Component ids that fit this slot. The first is the default. */
  options: string[];
  /** Slot can be left empty (e.g. no rug). */
  optional?: boolean;
  /**
   * The editor panel that lists this slot in this pack, over the default for
   * the slot id (roomGroups.ts). For a pack that reuses a slot for something
   * else: forest's tent (bed slot) and log blanket (chair slot) are fabrics
   * she only recolours, not furniture.
   */
  group?: RoomEditorGroup;
  /** 261105: the editor's name for this slot in this pack (English; i18n translates it). Forest: bed = "Tent". */
  label?: string;
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
  /** 261105: painted pattern tiles offered next to the code patterns. */
  patternTiles?: RoomPatternTile[];
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
  /** 261105: pattern id ('plain' = none over a default pattern). */
  pattern?: string;
  /** 261105: second pattern colour, hex. */
  accent?: string;
}

/** What the state says about one slot. Every field but id is optional (rooms saved before 261105 have id + tint only). */
export interface RoomSlotChoice {
  id: string | null;
  tint?: string;
  /** 261105: pattern id ('plain' = none over a default pattern). */
  pattern?: string;
  /** 261105: second pattern colour, hex. */
  accent?: string;
  /** 261105: a light running through the colours (the component offers `cycle`). */
  cycle?: boolean;
}

/** What a companion's room looks like. Lives on the device, a few KB. */
export interface RoomState {
  version: typeof SEILINK_ROOM_VERSION;
  preset: RoomPresetId;
  /** auto follows the computer's clock. */
  time: RoomTime | 'auto';
  /** Per slot: chosen component (null = empty optional slot), tint, pattern. */
  slots: Partial<Record<RoomSlotId, RoomSlotChoice>>;
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

export interface ResolvedSlot {
  slot: RoomSlotId;
  component: RoomComponent;
  tint?: string;
  /** The pattern on it, or absent when plain. */
  pattern?: RoomPatternChoice;
  /** The light is cycling through the colours. */
  cycle?: boolean;
}

/** The component in each slot after defaults (null = empty). */
export function resolveSlots(manifest: RoomPresetManifest, state: RoomState): ResolvedSlot[] {
  const byId = new Map(manifest.components.map((c) => [c.id, c]));
  const out: ResolvedSlot[] = [];
  for (const [slot, def] of Object.entries(manifest.slots) as Array<[RoomSlotId, RoomSlotDef]>) {
    const chosen = state.slots[slot];
    const id = chosen && chosen.id !== undefined ? chosen.id : def.options[0];
    if (id === null) continue;
    const component = byId.get(id) ?? byId.get(def.options[0]);
    if (!component) continue;
    const tint = chosen?.tint ?? component.defaultTint;
    const r: ResolvedSlot = { slot, component, tint };
    const pattern = resolvePattern(manifest, component, tint, chosen?.pattern, chosen?.accent);
    if (pattern) r.pattern = pattern;
    if (chosen?.cycle && component.cycle && component.tintable) r.cycle = true;
    out.push(r);
  }
  return out.sort((a, b) => manifest.slots[a.slot]!.z - manifest.slots[b.slot]!.z);
}

// ── Patterns (261105) ───────────────────────────────────────────────────────

export const PLAIN_PATTERN = 'plain';

/** The shared blank frame a particle-only part (fireflies) uses. */
export const BLANK_FRAME = '_shared/blank.webp';

function tileDef(t: RoomPatternTile): PatternDef {
  return { id: t.id, name: t.name, adjective: t.adjective, period: t.period, surfaces: t.surfaces, made: 'tile', tile: t.tile };
}

/** Every pattern this pack knows: the code patterns plus its painted tiles (a tile never shadows a code id). */
export function packPatterns(manifest: Pick<RoomPresetManifest, 'patternTiles'>): PatternDef[] {
  const out: PatternDef[] = [...CODE_PATTERNS];
  for (const t of manifest.patternTiles ?? []) if (!codePattern(t.id)) out.push(tileDef(t));
  return out;
}

/** A pattern by id in this pack (code or tile), or undefined. */
export function findPattern(manifest: Pick<RoomPresetManifest, 'patternTiles'>, id: string): PatternDef | undefined {
  const c = codePattern(id);
  if (c) return c;
  const t = manifest.patternTiles?.find((p) => p.id === id);
  return t ? tileDef(t) : undefined;
}

/** The patterns a component offers, in order (empty when it takes none). */
export function patternsFor(manifest: Pick<RoomPresetManifest, 'patternTiles'>, component: RoomComponent): PatternDef[] {
  if (!component.tintable) return [];
  if (component.patterns) return component.patterns.map((id) => findPattern(manifest, id)).filter((p): p is PatternDef => Boolean(p));
  const surface = component.patternSurface;
  if (!surface) return [];
  return packPatterns(manifest).filter((p) => p.surfaces.includes(surface));
}

/**
 * The pattern a part shows: the state's choice over the component's default,
 * only when the component offers it. null = plain.
 */
export function resolvePattern(
  manifest: Pick<RoomPresetManifest, 'patternTiles'>,
  component: RoomComponent,
  tint: string | undefined,
  pattern: string | undefined,
  accent: string | undefined,
): RoomPatternChoice | null {
  const id = pattern ?? component.defaultPattern;
  if (!id || id === PLAIN_PATTERN || !PATTERN_ID_RE.test(id)) return null;
  const offered = patternsFor(manifest, component);
  const def = offered.find((p) => p.id === id);
  if (!def) return null;
  const k = component.patternScale && component.patternScale > 0 ? component.patternScale : 1;
  const base = tint ?? component.defaultTint ?? '#ffffff';
  return { def, accent: accent ?? component.defaultAccent ?? toneOnTone(base), period: [def.period[0] * k, def.period[1] * k] };
}

// ── Editor labels (261105) ──────────────────────────────────────────────────

/** The editor's default name per slot id (English keys of the i18n dictionaries). */
export const DEFAULT_SLOT_LABEL: Readonly<Record<RoomSlotId, string>> = {
  view: 'View',
  shell: 'Walls',
  curtains: 'Curtains',
  bed: 'Bed',
  shelf: 'Shelves',
  chair: 'Chair',
  lamp: 'Lamp',
  rug: 'Rug',
  campfire: 'Campfire',
  lights: 'Lights',
  tree: 'Tree',
};

/** The editor's name for a slot in this pack (English; pass through t()). */
export function slotLabel(manifest: Pick<RoomPresetManifest, 'slots'>, slot: RoomSlotId): string {
  return manifest.slots[slot]?.label ?? DEFAULT_SLOT_LABEL[slot];
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

/** How look()'s list names a frame's particles (embers go with the campfire, dust without saying). */
const PARTICLE_WORDS: Readonly<Record<string, string | null>> = {
  rain: 'rain falling outside',
  snow: 'snow falling outside',
  petals: 'petals drifting past',
  fireflies: 'fireflies',
  embers: null,
  dust: null,
};

/** What the AI knows about her room: a place line and a plain item list. */
export function describeRoom(manifest: RoomPresetManifest, state: RoomState, now: Date = new Date()): { place: string; time: RoomTime; things: string[] } {
  const time = resolveRoomTime(state, now);
  const things: string[] = [];
  const say = (component: RoomComponent, tint: string | undefined, pattern: RoomPatternChoice | null | undefined, cycle?: boolean): string => {
    if (cycle) return `colour-changing ${component.name}`;
    const colour = component.tintable ? tintName(tint) : null;
    const words = [colour, pattern?.def.adjective].filter(Boolean);
    return words.length ? `${words.join(' ')} ${component.name}` : component.name;
  };
  const weather = new Set<string>();
  for (const { component, tint, pattern, cycle } of resolveSlots(manifest, state)) {
    const frame = component.frames[time] ?? component.frames.day;
    for (const p of frame.particles ?? []) {
      const phrase = PARTICLE_WORDS[p.kind];
      if (phrase) weather.add(phrase);
    }
    // A particle-only part (fireflies) is there only when its particles are.
    if (component.slot === 'view' || frame.src === BLANK_FRAME) continue;
    // The walls are named only when patterned ("striped walls"); plain walls go without saying.
    if (component.slot === 'shell') {
      if (pattern) things.push(`${say(component, tint, pattern)}`);
      continue;
    }
    things.push(say(component, tint, pattern, cycle));
  }
  const byId = new Map(manifest.components.map((c) => [c.id, c]));
  for (const it of state.items) {
    const c = byId.get(it.id);
    if (!c) continue;
    const tint = it.tint ?? c.defaultTint;
    things.push(say(c, tint, resolvePattern(manifest, c, tint, it.pattern, it.accent)));
  }
  things.push(...weather);
  return { place: manifest.place, time, things };
}
