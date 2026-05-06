// src/adapter/minecraft/primer.js
//
// Adapter-supplied world primer. Brain consumes via adapter.worldPrimer().
// Byte-stable: do NOT modify content without intentional cache-bust
// coordination — every byte change invalidates the cached system prefix.

const MINECRAFT_PRIMER =
  "Quick world primer. Trees and wood vary by biome: oak grows in plains and " +
  "forest, birch in birch_forest, spruce in taiga and snowy taiga, jungle in " +
  "jungle, acacia in savanna, dark_oak in dark_forest, mangrove in mangrove " +
  "swamp, and cherry in cherry_grove. Common hostile mobs to watch for: " +
  "zombies shamble toward you and burn in daylight; skeletons shoot arrows " +
  "from a distance and also burn in sunlight; creepers approach silently and " +
  "explode if you let them get close — back off or attack from range; spiders " +
  "are fast and can climb walls but are passive in daylight; endermen are " +
  "tall, neutral until you look directly at their head, then very dangerous. " +
  "Tool to block matrix: a wooden pickaxe mines stone, cobblestone, and coal " +
  "ore; a stone pickaxe is needed for iron ore and copper ore; an iron " +
  "pickaxe is required for diamond, gold, and redstone ore; a shovel is " +
  "fastest on dirt, sand, gravel, and snow; an axe is fastest on wood and " +
  "planks; a sword is best for combat. Day and night: zombies and skeletons " +
  "burn in direct sunlight, so they're mostly a night problem; sleep in a bed " +
  "at night to skip to morning and reset the spawn point; if you go three " +
  "in-game days without sleeping, phantoms will start spawning at night and " +
  "diving at you from above. Food restores hunger, which slowly drains as you " +
  "act; if hunger gets too low you stop healing and eventually take damage."

export { MINECRAFT_PRIMER }

/**
 * Adapter contract: returns the world-primer string.
 * @returns {string}
 */
export function worldPrimer() { return MINECRAFT_PRIMER }
