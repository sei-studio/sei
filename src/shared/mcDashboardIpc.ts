/**
 * Minecraft dashboard: shared renderer <-> main contract (260721).
 *
 * While a character is summoned into a LAN world, its bot process emits a
 * compact telemetry snapshot (~every 2s while the renderer is watching, plus
 * immediately when the current action changes): position + facing +
 * dimension, vitals, inventory, a natural-language activity line ("mining
 * stone..."), and a small top-down minimap sample around the bot.
 *
 * Flow: bot (src/bot/adapter/minecraft/dashboard/) -> {type:'dashboard'}
 * port message -> botSupervisor -> src/main/mcDashboard/mcDashboardService
 * -> mcdash:snapshot push -> useMcDashboardStore -> McDashboardPanel.
 *
 * The renderer reports visibility over mcdash:set-watching so the bot only
 * samples the minimap while someone is actually looking (the tile/panel
 * auto-opens with the summon and closes when the bot leaves, so in practice
 * this tracks the ChatScreen lifecycle).
 */

/** One inventory stack. Slots use the mineflayer player-window numbering:
 * 5-8 armor (head..feet), 9-35 main grid, 36-44 hotbar, 45 off-hand. */
export interface McDashItem {
  /** Block/item id without the namespace ("cobblestone"). Doubles as the
   * texture key for the skin server's /mcassets item-texture route. */
  name: string;
  count: number;
  slot: number;
}

/** Minimap grid edge length (cells). Odd so the bot sits on the center cell. */
export const MC_DASH_MAP_SIZE = 33;

/**
 * The minimap sample: size*size cells, row-major, north (-z) first row,
 * west (-x) first column, bot at the center cell. Each cell is one byte:
 * low nibble = palette index (MC_DASH_PALETTE), high nibble = the top
 * block's height relative to the bot's feet, clamped to -8..+7 and stored
 * offset by +8. `cells` is the base64 encoding of those bytes.
 */
export interface McDashMap {
  size: number;
  cells: string;
}

export interface McDashboardSnapshot {
  characterId: string;
  ts: number;
  /** 'overworld' | 'the_nether' | 'the_end' (raw dimension name, unprefixed). */
  dimension: string;
  pos: { x: number; y: number; z: number };
  /** Facing, radians, mineflayer convention (view dir x=-sin, z=-cos). */
  yaw: number;
  /** 0-20 half-heart units. */
  health: number;
  /** 0-20 half-drumstick units. */
  food: number;
  /** Currently held item name, or null for an empty hand. */
  held: string | null;
  items: McDashItem[];
  /** Natural-language activity line, lowercase ("mining stone...", "idle"). */
  activity: string;
  /** Raw tool name behind `activity` (null = idle). */
  actionName: string | null;
  /** Present only when the bot sampled the map this tick (watching + spawned). */
  map: McDashMap | null;
}

/** Push payload for mcdash:snapshot (already stamped with characterId). */
export type McDashboardSnapshotPush = McDashboardSnapshot;

/**
 * Palette categories for minimap cells. MUST stay in sync with the bot-side
 * classifier in src/bot/adapter/minecraft/dashboard/mapSample.js (the bot is
 * plain ESM JS and cannot import this file).
 */
export const MC_DASH_PALETTE = {
  VOID: 0,
  GRASS: 1,
  DIRT: 2,
  STONE: 3,
  SAND: 4,
  WATER: 5,
  LAVA: 6,
  WOOD: 7,
  LEAVES: 8,
  PLANT: 9,
  SNOW: 10,
  NETHER: 11,
  END: 12,
  ORE: 13,
  BUILT: 14,
  MISC: 15,
} as const;

/** Base render color per palette index (hex, before height shading). */
export const MC_DASH_PALETTE_COLORS: readonly string[] = [
  '#14141c', // VOID
  '#5d9640', // GRASS
  '#8a6244', // DIRT
  '#7d7d7d', // STONE
  '#dbd3a0', // SAND
  '#3f5edb', // WATER
  '#d45a12', // LAVA
  '#7a5b2e', // WOOD
  '#3c6c26', // LEAVES
  '#6fae4a', // PLANT
  '#e8f0f0', // SNOW
  '#6e3533', // NETHER
  '#dede9e', // END
  '#9b8f6e', // ORE
  '#a08f9b', // BUILT
  '#8f8577', // MISC
];

/** Palette index from one packed cell byte. */
export function mcDashCellPalette(byte: number): number {
  return byte & 0x0f;
}

/** Height of the cell's top block relative to the bot's feet (-8..+7). */
export function mcDashCellHeight(byte: number): number {
  return ((byte >> 4) & 0x0f) - 8;
}

/** Decode a base64 cell string back to packed bytes. Renderer + main safe. */
export function decodeMcDashCells(cells: string): Uint8Array {
  if (typeof atob === 'function') {
    const bin = atob(cells);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // Node (main process / vitest) fallback.
  return new Uint8Array(Buffer.from(cells, 'base64'));
}

/**
 * window.sei surface (implemented in src/preload/index.ts):
 *
 *   mcDashboardGet(characterId: string): Promise<McDashboardSnapshot | null>
 *     Latest snapshot, or null when the character has no live session.
 *   mcDashboardSetWatching(characterId: string, watching: boolean): Promise<void>
 *     Renderer visibility hint: the bot samples the minimap (and emits
 *     snapshots at all) only while true. Safe to call for idle characters.
 *   onMcDashboardSnapshot(cb: (s: McDashboardSnapshotPush) => void): () => void
 */
