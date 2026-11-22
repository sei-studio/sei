// src/bot/adapter/minecraft/vocabulary.js
//
// 261013: Minecraft's own nouns for the brain's repeat note (adapter member
// gameVocabulary, brain/ownRepeats.js). A phrase she says twice that is mostly
// these words ("heading to the oak trees", "need iron ingots") is the job she
// is on, not a bit, so the note never tells her to drop it. The brain splits
// each name on "_" and matches plurals and stems, so "oak_log" covers "oak"
// and "logs".
//
// Item, block and entity names come from minecraft-data for the connected
// version, or the newest one it knows when the version is not known yet. The
// names are stable across versions, so either is fine for this.

import mcDataLib from 'minecraft-data'

// Name families whose words are not things she gathers or fights: music disc
// titles ("wait", "far"), pottery sherd and banner pattern motifs ("friend",
// "danger", "prize"), trim templates, spawn eggs (the mob is an entity name
// already) and technical blocks and entities.
const SKIP_NAME = /^music_disc_|_pottery_sherd$|_smithing_template$|_banner_pattern$|_spawn_egg$|^(command_block|chain_command_block|repeating_command_block|command_block_minecart|structure_block|structure_void|jigsaw|barrier|light|debug_stick|knowledge_book|test_block|test_instance_block|marker|interaction|text_display|block_display|item_display|area_effect_cloud|player|mannequin)$/

// Plain describing words that some names carry ("dead_bush", "small_dripleaf",
// "happy_ghast"), and "player" (player_head). Kept out so a joke built on
// them still counts as hers.
const MODIFIERS = new Set((
  'happy giant dead small big tall short dry wet warm open closed large medium dark light sweet crying ' +
  'suspicious moving powered potent petrified damaged chipped decorated gilded weighted heavy calibrated ' +
  'reinforced attached potted infested exposed weathered oxidized waxed stripped cracked chiseled polished ' +
  'mossy enchanted written writable filled pointed recovery wandering ominous lingering splash glistering ' +
  'popped packed rooted twisting weeping budding flowering fermented spectral tipped trapped tinted ' +
  'coarse cut smooth carved glazed stained baked cooked raw dried frosted player the of on and'
).split(' '))

// Words for the job that no single item or block name carries.
const GAME_WORDS = [
  'tree', 'trees', 'ore', 'mob', 'mobs', 'monster', 'animal', 'cave', 'tunnel', 'farm', 'crop',
  'house', 'base', 'shelter', 'tool', 'tools', 'weapon', 'armor', 'gear', 'food', 'block', 'blocks', 'item', 'items',
  'inventory', 'stack', 'biome', 'spawn', 'portal',
]

const _byVersion = new Map()

/**
 * The word list for one version: every useful item, block and entity name
 * with its describing words taken out, plus GAME_WORDS. Cached per version.
 * Never throws; an unknown version falls back to the newest known one, and a
 * minecraft-data that will not load gives GAME_WORDS alone.
 *
 * @param {string|null|undefined} version  bot.version
 * @returns {string[]}
 */
export function minecraftVocabulary(version) {
  const key = version || ''
  if (_byVersion.has(key)) return _byVersion.get(key)
  let words = [...GAME_WORDS]
  try {
    let data = version ? mcDataLib(version) : null
    if (!data) {
      const known = mcDataLib.supportedVersions?.pc ?? []
      data = known.length ? mcDataLib(known[known.length - 1]) : null
    }
    if (data) {
      const names = new Set([
        ...(data.itemsArray ?? []).map((i) => i.name),
        ...(data.blocksArray ?? []).map((b) => b.name),
        ...(data.entitiesArray ?? []).map((e) => e.name),
      ])
      const seen = new Set(words)
      for (const n of names) {
        if (typeof n !== 'string' || SKIP_NAME.test(n)) continue
        for (const w of n.split('_')) {
          if (w.length < 3 || MODIFIERS.has(w) || /^\d+$/.test(w) || seen.has(w)) continue
          seen.add(w)
          words.push(w)
        }
      }
    }
  } catch { /* GAME_WORDS alone */ }
  _byVersion.set(key, words)
  return words
}




