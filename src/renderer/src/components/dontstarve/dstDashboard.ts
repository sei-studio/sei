/**
 * Pure helpers behind the Don't Starve Together dashboard (260909). No
 * React, no stores, so the tests can pin the game facts the panel paints:
 * the clock's segment split per season, the temperature bands, the item
 * display names.
 */

export type DstPhase = 'day' | 'dusk' | 'night';
export type DstSeason = 'autumn' | 'winter' | 'spring' | 'summer';

/**
 * The in-game clock is a ring of 16 segments and the split between day,
 * dusk and night is a per-season constant (default world settings). The
 * mod does not report the segment the hand is on, only the phase, so the
 * panel lights the whole phase.
 */
export const DST_CLOCK_SEGMENTS = 16;
export const DST_PHASE_SPLIT: Record<DstSeason, Record<DstPhase, number>> = {
  autumn: { day: 8, dusk: 4, night: 4 },
  winter: { day: 5, dusk: 5, night: 6 },
  spring: { day: 5, dusk: 8, night: 3 },
  summer: { day: 11, dusk: 2, night: 3 },
};

export function normalizeSeason(season: string | null | undefined): DstSeason {
  const s = String(season ?? '').toLowerCase();
  return s === 'winter' || s === 'spring' || s === 'summer' ? s : 'autumn';
}

export function normalizePhase(phase: string | null | undefined): DstPhase {
  const p = String(phase ?? '').toLowerCase();
  return p === 'dusk' || p === 'night' ? p : 'day';
}

/** One entry per clock segment, in clock order (day first, then dusk, then night). */
export function clockSegments(season: string | null | undefined): DstPhase[] {
  const split = DST_PHASE_SPLIT[normalizeSeason(season)];
  const out: DstPhase[] = [];
  for (const phase of ['day', 'dusk', 'night'] as const) {
    for (let i = 0; i < split[phase]; i++) out.push(phase);
  }
  return out;
}

export type DstTempBand = 'freezing' | 'cold' | 'fine' | 'hot' | 'overheating';

/**
 * Body temperature bands. The game freezes a survivor below 0 and overheats
 * them above 70; the two inner bands are the warning the game gives with
 * the frost / heat vignette before damage starts.
 */
export function tempBand(temp: number): DstTempBand {
  if (!Number.isFinite(temp)) return 'fine';
  if (temp <= 0) return 'freezing';
  if (temp < 10) return 'cold';
  if (temp >= 70) return 'overheating';
  if (temp > 60) return 'hot';
  return 'fine';
}

/** Percent of a meter, clamped and rounded, 0 when the max is unknown. */
export function meterPct(value: number, max: number): number {
  if (!(max > 0) || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round((value / max) * 100)));
}

/**
 * Prefab -> in-game display name for what a companion actually carries in
 * its first days. Everything else falls back to the prefab with its
 * underscores opened up, which is close enough to read ("spider gland").
 */
const ITEM_NAMES: Record<string, string> = {
  twigs: 'Twigs',
  cutgrass: 'Cut Grass',
  log: 'Log',
  rocks: 'Rocks',
  flint: 'Flint',
  goldnugget: 'Gold Nugget',
  nitre: 'Nitre',
  charcoal: 'Charcoal',
  berries: 'Berries',
  berries_cooked: 'Roasted Berries',
  carrot: 'Carrot',
  carrot_cooked: 'Roasted Carrot',
  seeds: 'Seeds',
  seeds_cooked: 'Toasted Seeds',
  petals: 'Petals',
  smallmeat: 'Morsel',
  cookedsmallmeat: 'Cooked Morsel',
  meat: 'Meat',
  cookedmeat: 'Cooked Meat',
  monstermeat: 'Monster Meat',
  cookedmonstermeat: 'Cooked Monster Meat',
  drumstick: 'Drumstick',
  fish: 'Fish',
  honey: 'Honey',
  redcap: 'Red Cap',
  greencap: 'Green Cap',
  bluecap: 'Blue Cap',
  silk: 'Silk',
  spidergland: 'Spider Gland',
  pigskin: 'Pig Skin',
  beefalowool: 'Beefalo Wool',
  rope: 'Rope',
  boards: 'Boards',
  cutstone: 'Cut Stone',
  papyrus: 'Papyrus',
  axe: 'Axe',
  pickaxe: 'Pickaxe',
  shovel: 'Shovel',
  hammer: 'Hammer',
  razor: 'Razor',
  torch: 'Torch',
  spear: 'Spear',
  hambat: 'Ham Bat',
  trap: 'Trap',
  birdtrap: 'Bird Trap',
  fishingrod: 'Fishing Rod',
  umbrella: 'Umbrella',
  backpack: 'Backpack',
  strawhat: 'Straw Hat',
  footballhat: 'Football Helmet',
  armorwood: 'Log Suit',
  armorgrass: 'Grass Suit',
  bedroll_straw: 'Straw Roll',
  bedroll_furry: 'Fur Roll',
  campfire: 'Campfire',
  firepit: 'Fire Pit',
  researchlab: 'Science Machine',
  treasurechest: 'Chest',
  tent: 'Tent',
  butterflywings: 'Butterfly Wings',
  butterfly: 'Butterfly',
  cave_banana: 'Cave Banana',
  lightbulb: 'Light Bulb',
  poop: 'Manure',
  ash: 'Ashes',
  ice: 'Ice',
  bandage: 'Honey Poultice',
  healingsalve: 'Healing Salve',
  books: 'Book',
  book_birds: 'Birds of the World',
  book_horticulture: 'Applied Horticulture',
  book_sleep: 'Sleepytime Stories',
  book_brimstone: 'The End is Nigh',
  book_tentacles: 'On Tentacles',
  cane: 'Walking Cane',
  compass: 'Compass',
  featherhat: 'Feather Hat',
  feather_crow: 'Jet Feather',
  feather_robin: 'Crimson Feather',
  houndstooth: "Hound's Tooth",
  boneshard: 'Bone Shards',
  marble: 'Marble',
  gears: 'Gears',
  redgem: 'Red Gem',
  bluegem: 'Blue Gem',
  purplegem: 'Purple Gem',
  livinglog: 'Living Log',
  pinecone: 'Pine Cone',
  acorn: 'Birchnut',
  dug_grass: 'Grass Tuft',
  dug_sapling: 'Sapling',
  dug_berrybush: 'Berry Bush',
};

export function dstItemLabel(prefab: string): string {
  const key = String(prefab ?? '').toLowerCase();
  if (ITEM_NAMES[key]) return ITEM_NAMES[key];
  return key.replace(/_/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** The base inventory is 15 slots; a backpack adds a row, so the bar grows in rows of 15. */
export const DST_BASE_SLOTS = 15;

export function slotCount(itemCount: number): number {
  if (itemCount <= DST_BASE_SLOTS) return DST_BASE_SLOTS;
  return Math.ceil(itemCount / DST_BASE_SLOTS) * DST_BASE_SLOTS;
}
