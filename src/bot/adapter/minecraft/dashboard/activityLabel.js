// src/bot/adapter/minecraft/dashboard/activityLabel.js — current tool call →
// natural-language activity line for the Minecraft dashboard (260721).
//
// Vocabulary mirrors the registered world actions in
// src/bot/adapter/minecraft/registry.js. The style is deliberately lowercase
// with a trailing "..." ("mining stone...", "following you...") — this string
// is user copy, so no em dashes. Unknown tools fall back to the humanized
// tool name so a new registry action never breaks the dashboard.

/** "oak_log" / "minecraft:oak_log" → "oak log". Null for non-strings. */
function term(args, keys) {
  if (!args || typeof args !== 'object') return null
  for (const k of keys) {
    const v = args[k]
    if (typeof v === 'string' && v.trim()) {
      return v.trim().toLowerCase().replace(/^minecraft:/, '').replace(/_/g, ' ')
    }
  }
  return null
}

/** Naive plural for a block/item term: "oak log" → "oak logs". */
function plural(t) {
  return /s$/.test(t) ? t : `${t}s`
}

/** Finite-number arg, rounded, or null. */
function num(args, key) {
  const v = args && typeof args === 'object' ? args[key] : undefined
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null
}

/** "someToolName" → "some tool name...". */
function humanize(name) {
  const words = String(name)
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim()
  return `${words || 'busy'}...`
}

/**
 * Natural-language activity line for the currently-dispatching tool call.
 * `name` null (loop drained to idle) → "idling".
 * `name` 'thinking' (a player message is being processed) → "thinking".
 * @param {string|null|undefined} name
 * @param {Record<string, unknown>|undefined} [args]
 * @returns {string}
 */
export function activityLabel(name, args) {
  if (!name) return 'idling'
  switch (name) {
    // 260725: synthetic verb the orchestrator emits when a player-message
    // turn starts, before any world tool runs (status window "thinking").
    case 'thinking':
      return 'thinking'
    case 'follow':
      return 'following you...'
    case 'unfollow':
      return 'standing by...'
    case 'goTo': {
      const x = num(args, 'x')
      const z = num(args, 'z')
      return x != null && z != null ? `walking to ${x}, ${z}...` : 'walking somewhere...'
    }
    case 'explore':
      return 'exploring...'
    case 'dig': {
      const block = term(args, ['block', 'target', 'name'])
      return block ? `mining ${block}...` : 'mining...'
    }
    case 'gather': {
      const thing = term(args, ['name', 'block', 'item'])
      return thing ? `gathering ${plural(thing)}...` : 'gathering...'
    }
    case 'find': {
      const thing = term(args, ['name', 'target', 'block', 'item'])
      return thing ? `looking for ${thing}...` : 'looking around...'
    }
    case 'look':
      return 'looking around...'
    case 'build':
      return 'building...'
    case 'shelter':
      return 'building a shelter...'
    case 'placeBlock': {
      const block = term(args, ['block'])
      return block ? `placing ${block}...` : 'placing blocks...'
    }
    case 'equip': {
      const item = term(args, ['item', 'name'])
      return item ? `equipping ${item}...` : 'gearing up...'
    }
    case 'consumeItem': {
      const item = term(args, ['item', 'name'])
      return item ? `eating ${item}...` : 'having a snack...'
    }
    case 'sleep':
      return 'sleeping...'
    case 'attackEntity': {
      const target = term(args, ['entity', 'target', 'name'])
      return target ? `fighting ${target}...` : 'fighting...'
    }
    case 'craft': {
      const item = term(args, ['item', 'recipe', 'name'])
      return item ? `crafting ${item}...` : 'crafting...'
    }
    case 'openFurnace':
    case 'smeltInput':
    case 'addFuel':
    case 'takeSmelted':
      return 'smelting...'
    case 'openContainer':
    case 'depositItem':
    case 'withdrawItem':
      return 'checking a chest...'
    case 'dropItem':
      return 'dropping items...'
    case 'readSign':
      return 'reading a sign...'
    case 'activateItem':
    case 'activateBlock':
      return 'fiddling with something...'
    default:
      return humanize(name)
  }
}
