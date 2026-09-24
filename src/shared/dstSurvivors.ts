/**
 * Don't Starve Together survivor roster (game-adapters M2, 260908).
 *
 * The companion's DST body is a vanilla survivor prefab the CHARACTER picks on
 * first launch (plan section 8, decision 3): a one-off LLM call reads the
 * persona plus this brief and returns a prefab id, persisted sparse per
 * character in UserConfig.dst_survivor. The chosen survivor's row is also
 * appended to the adapter's world primer so the brain plays to its perks.
 *
 * Numbers come from dontstarve.wiki.gg (one page per survivor), re-verified
 * 260908 for the rows the roster brief had marked (verify): Wolfgang's hunger
 * is 300 and Mightiness is a separate 0-100 meter since the 2021 refresh
 * (raised by lifting and work, decaying over time, faster when hungry), WX-78
 * is 100/100/100 before circuits, Wickerbottom's health is 125.
 *
 * The per-survivor MECHANICS flags are mirrored in
 * native/dst-mod/sei/scripts/sei/survivors.lua (the safety layer) and
 * src/bot/adapter/dontstarve/survivors.js (the perception flags + primer);
 * dstSurvivors.test.ts pins the three prefab lists together. Pure: no Node,
 * no Electron.
 */

/** Diet the body's eat reflex must respect. */
export type DstDiet = 'any' | 'meat' | 'veg';

export interface DstSurvivor {
  prefab: string;
  name: string;
  /** Base stats; a range where the survivor's form changes it. */
  health: string;
  hunger: string;
  sanity: string;
  perks: string;
  downsides: string;
  /* ── Mechanics the body has to manage (data for the mod + the primer) ── */
  diet: DstDiet;
  /** Eats spoiled/stale food with no penalty (WX-78; Webber for monster meat). */
  eatsSpoiled: boolean;
  /** Fire does not hurt this survivor (Willow): no fire panic in the BT. */
  fireImmune: boolean;
  /** Wetness itself deals damage (WX-78): shelter from rain outranks work. */
  wetnessDamage: boolean;
  /** Very low health pool (Maxwell): flee earlier, avoid direct fights. */
  frail: boolean;
  /** Only crock pot dishes satisfy hunger properly (Warly). */
  needsCrockpot: boolean;
  /** Souls are food (Wortox): eat a soul when hungry before raw food. */
  souls: boolean;
  /** Cutting plants costs sanity (Wormwood): prefer picking over chopping. */
  plantFriend: boolean;
  /** Cannot sleep in tents or bedrolls (Wickerbottom). */
  noSleep: boolean;
}

export const DST_SURVIVORS: readonly DstSurvivor[] = Object.freeze([
  {
    prefab: 'wilson', name: 'Wilson', health: '150', hunger: '150', sanity: '200',
    perks: 'Grows a beard (winter insulation, beard hair for meat effigies). The only survivor with no drawbacks.',
    downsides: 'None. Safest generalist.',
    diet: 'any', eatsSpoiled: false, fireImmune: false, wetnessDamage: false, frail: false, needsCrockpot: false, souls: false, plantFriend: false, noSleep: false,
  },
  {
    prefab: 'willow', name: 'Willow', health: '150', hunger: '150', sanity: '120',
    perks: 'Immune to fire damage; starts with a lighter and Bernie the bear; gains sanity near fire.',
    downsides: 'Sanity drains and restores faster (1.1x); suffers more from cold. Keep a fire lit at night.',
    diet: 'any', eatsSpoiled: false, fireImmune: true, wetnessDamage: false, frail: false, needsCrockpot: false, souls: false, plantFriend: false, noSleep: false,
  },
  {
    prefab: 'wolfgang', name: 'Wolfgang', health: '150 to 300', hunger: '300', sanity: '200',
    perks: 'Mightiness meter (0 to 100): at 75 or more he is Mighty, deals 2x damage, works faster and can carry heavy things without slowing; large hunger pool.',
    downsides: 'Mightiness decays over time (faster when hungry) and is raised by lifting dumbbells, rowing, and mining, chopping or digging work; below 25 he is Wimpy (0.75x damage and work). Afraid of the dark and of monsters (1.1x sanity drain).',
    diet: 'any', eatsSpoiled: false, fireImmune: false, wetnessDamage: false, frail: false, needsCrockpot: false, souls: false, plantFriend: false, noSleep: false,
  },
  {
    prefab: 'wendy', name: 'Wendy', health: '150', hunger: '150', sanity: '200',
    perks: 'Abigail, her ghost sister, fights beside her (summon with the flower); sanity drains slower in the dark (0.75x).',
    downsides: 'Hits for 0.75x damage; relies on Abigail for fights.',
    diet: 'any', eatsSpoiled: false, fireImmune: false, wetnessDamage: false, frail: false, needsCrockpot: false, souls: false, plantFriend: false, noSleep: false,
  },
  {
    prefab: 'wx78', name: 'WX-78', health: '100', hunger: '100', sanity: '100',
    perks: 'Eats spoiled food without penalty; installs circuits (scanned from creatures) that raise stats and add abilities; healed by lightning strikes.',
    downsides: 'Takes damage from wetness and rain; attracts lightning. Low base stats until circuits are installed. Stay dry, carry an umbrella.',
    diet: 'any', eatsSpoiled: true, fireImmune: false, wetnessDamage: true, frail: false, needsCrockpot: false, souls: false, plantFriend: false, noSleep: false,
  },
  {
    prefab: 'wickerbottom', name: 'Wickerbottom', health: '125', hunger: '150', sanity: '250',
    perks: 'Crafts books with strong effects (grow plants, call lightning, sleep enemies); starts at a higher science tier.',
    downsides: 'Cannot sleep (no tents or bedrolls); loses sanity from stale or spoiled food.',
    diet: 'any', eatsSpoiled: false, fireImmune: false, wetnessDamage: false, frail: false, needsCrockpot: false, souls: false, plantFriend: false, noSleep: true,
  },
  {
    prefab: 'waxwell', name: 'Maxwell', health: '75', hunger: '150', sanity: '200',
    perks: 'Sanity regenerates constantly; splits his mind into shadow puppets that work and fight; starts with a dark sword, night armor and nightmare fuel.',
    downsides: 'Very frail at 75 health. Avoid direct fights; let puppets and armor do the work.',
    diet: 'any', eatsSpoiled: false, fireImmune: false, wetnessDamage: false, frail: true, needsCrockpot: false, souls: false, plantFriend: false, noSleep: false,
  },
  {
    prefab: 'wigfrid', name: 'Wigfrid', health: '200', hunger: '120', sanity: '120',
    perks: 'Deals 1.25x damage, takes 0.75x; regains health and sanity on hits; starts with a battle helm and spear; battle songs.',
    downsides: 'Only eats meat. Hunt and cook meat only; small hunger and sanity pools.',
    diet: 'meat', eatsSpoiled: false, fireImmune: false, wetnessDamage: false, frail: false, needsCrockpot: false, souls: false, plantFriend: false, noSleep: false,
  },
  {
    prefab: 'webber', name: 'Webber', health: '175', hunger: '175', sanity: '100',
    perks: 'Spiders are neutral and can be befriended with food; can craft spider dens; eats monster meat safely; grows a beard.',
    downsides: 'Low sanity; pigs and most humanoid NPCs are hostile because he is a monster.',
    diet: 'any', eatsSpoiled: false, fireImmune: false, wetnessDamage: false, frail: false, needsCrockpot: false, souls: false, plantFriend: false, noSleep: false,
  },
  {
    prefab: 'winona', name: 'Winona', health: '150', hunger: '150', sanity: '200',
    perks: 'Crafts faster and cheaper; builds catapults, spotlights and generators; starts with trusty tape; one free hit from the darkness.',
    downsides: 'Crafting bursts cost hunger. No other penalty.',
    diet: 'any', eatsSpoiled: false, fireImmune: false, wetnessDamage: false, frail: false, needsCrockpot: false, souls: false, plantFriend: false, noSleep: false,
  },
  {
    prefab: 'wortox', name: 'Wortox', health: '200', hunger: '175', sanity: '150',
    perks: 'Collects souls from kills, eats them for hunger, hops (teleports) by spending souls, heals allies by releasing souls; takes half damage from sanity-based effects.',
    downsides: 'Normal food only restores half hunger; too many souls held drains sanity. Kill small creatures to keep souls. DLC.',
    diet: 'any', eatsSpoiled: false, fireImmune: false, wetnessDamage: false, frail: false, needsCrockpot: false, souls: true, plantFriend: false, noSleep: false,
  },
  {
    prefab: 'wormwood', name: 'Wormwood', health: '150', hunger: '150', sanity: '200',
    perks: 'Plants seeds anywhere without farm plots; blooms in spring (faster movement); plant creatures are neutral; crafts living logs and bramble armor from his own body.',
    downsides: 'Food restores hunger but not health; loses sanity when plants nearby are cut or burned (including his own chopping); heals only from salves, poultices and the like. DLC.',
    diet: 'any', eatsSpoiled: false, fireImmune: false, wetnessDamage: false, frail: false, needsCrockpot: false, souls: false, plantFriend: true, noSleep: false,
  },
  {
    prefab: 'warly', name: 'Warly', health: '150', hunger: '250', sanity: '200',
    perks: 'Portable crock pot and exclusive powerful dishes; spices add buffs.',
    downsides: 'Hunger drains 1.33x; only crock pot food satisfies him and repeating the same dish gives less each time. Cook constantly and vary meals.',
    diet: 'any', eatsSpoiled: false, fireImmune: false, wetnessDamage: false, frail: false, needsCrockpot: true, souls: false, plantFriend: false, noSleep: false,
  },
  {
    prefab: 'wurt', name: 'Wurt', health: '150', hunger: '200', sanity: '150',
    perks: 'At home in the swamp (no penalty in marsh, faster on marsh turf); befriends and builds merm houses.',
    downsides: 'Vegetarian: cannot eat meat; merm loyalty needs fish and vegetables. DLC.',
    diet: 'veg', eatsSpoiled: false, fireImmune: false, wetnessDamage: false, frail: false, needsCrockpot: false, souls: false, plantFriend: false, noSleep: false,
  },
  {
    prefab: 'walter', name: 'Walter', health: '130', hunger: '110', sanity: '200',
    perks: 'Slingshot with many ammo types; Woby the dog carries items and grows into a mount; no sanity drain from darkness or monsters; sanity from trees; campfire stories.',
    downsides: 'Loses sanity while injured; takes extra damage from bees; small hunger pool.',
    diet: 'any', eatsSpoiled: false, fireImmune: false, wetnessDamage: false, frail: false, needsCrockpot: false, souls: false, plantFriend: false, noSleep: false,
  },
]);

export const DST_SURVIVOR_PREFABS: readonly string[] = Object.freeze(DST_SURVIVORS.map((s) => s.prefab));

/** Wilson is the fallback when the pick fails or the stored value is stale. */
export const DST_DEFAULT_SURVIVOR = 'wilson';

export function isDstSurvivorPrefab(v: unknown): v is string {
  return typeof v === 'string' && DST_SURVIVOR_PREFABS.includes(v);
}

export function dstSurvivor(prefab: string | null | undefined): DstSurvivor {
  return DST_SURVIVORS.find((s) => s.prefab === prefab) ?? DST_SURVIVORS[0];
}

/** The whole roster as prompt text, one line per survivor. */
export function renderDstRosterBrief(): string {
  return DST_SURVIVORS.map(
    (s) =>
      `- ${s.prefab} (${s.name}) health ${s.health}, hunger ${s.hunger}, sanity ${s.sanity}. Perks: ${s.perks} Downsides: ${s.downsides}`,
  ).join('\n');
}

/** One survivor's brief, the paragraph appended to the adapter's world primer. */
export function renderDstSurvivorBrief(prefab: string): string {
  const s = dstSurvivor(prefab);
  const manage: string[] = [];
  if (s.diet === 'meat') manage.push('you can ONLY eat meat, so vegetables and fruit are useless to you');
  if (s.diet === 'veg') manage.push('you CANNOT eat meat, so hunt only to defend yourself and live on vegetables, fruit and fish dishes');
  if (s.eatsSpoiled) manage.push('spoiled food is fine for you');
  if (s.fireImmune) manage.push('fire cannot hurt you, so a burning forest is an opportunity, not a danger');
  if (s.wetnessDamage) manage.push('getting wet HURTS you: stand under a tree or by a fire when it rains, and carry an umbrella when you can');
  if (s.frail) manage.push('you have very little health, so never trade hits; let armor and helpers fight and keep your distance');
  if (s.needsCrockpot) manage.push('raw and campfire food barely feeds you; cook crock pot dishes and vary them');
  if (s.souls) manage.push('souls from kills are your best food, and holding too many drains sanity');
  if (s.plantFriend) manage.push('chopping or burning plants near you costs sanity, so gather twigs and grass by picking and let others do the chopping; food does not heal you, only salves do');
  if (s.noSleep) manage.push('you cannot sleep in tents or bedrolls');
  const tail = manage.length ? ` What that means for you: ${manage.join('; ')}.` : '';
  return `You are playing as ${s.name} (health ${s.health}, hunger ${s.hunger}, sanity ${s.sanity}). Perks: ${s.perks} Downsides: ${s.downsides}${tail}`;
}
