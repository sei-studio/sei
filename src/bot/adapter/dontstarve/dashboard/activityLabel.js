// src/bot/adapter/dontstarve/dashboard/activityLabel.js — current tool call
// -> the lowercase activity line for the DST dashboard status strip (the
// renderer sentence-cases it). Vocabulary mirrors registry.js; unknown tools
// fall back to the humanized name. User copy: no em dashes.

function term(args, keys) {
  if (!args || typeof args !== 'object') return null
  for (const k of keys) {
    const v = args[k]
    if (typeof v === 'string' && v.trim()) return v.trim().toLowerCase().replace(/_/g, ' ')
  }
  return null
}

function humanize(name) {
  const words = String(name).replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().trim()
  return `${words || 'busy'}...`
}

/**
 * @param {string|null|undefined} name
 * @param {Record<string, unknown>|undefined} [args]
 */
export function activityLabel(name, args) {
  if (!name) return 'idling'
  switch (name) {
    case 'thinking': return 'thinking'
    case 'follow': return 'following you...'
    case 'unfollow': return 'stopping'
    case 'come': return 'coming to you...'
    case 'goTo': return 'walking...'
    case 'gather': {
      const t = term(args, ['item'])
      const n = typeof args?.count === 'number' ? ` x${Math.round(args.count)}` : ''
      return t ? `gathering ${t}${n}...` : 'gathering...'
    }
    case 'chop': return 'chopping a tree...'
    case 'mine': return 'mining...'
    case 'pick': { const t = term(args, ['target']); return t && !t.startsWith('#') ? `picking ${t}...` : 'picking...' }
    case 'pickup': return 'picking something up...'
    case 'craft': { const t = term(args, ['recipe']); return t ? `crafting ${t}...` : 'crafting...' }
    case 'build': { const t = term(args, ['recipe']); return t ? `building ${t}...` : 'building...' }
    case 'eat': { const t = term(args, ['item']); return t ? `eating ${t}...` : 'eating...' }
    case 'equip': { const t = term(args, ['item']); return t ? `equipping ${t}...` : 'equipping...' }
    case 'attack': return 'fighting...'
    case 'flee': return 'running away...'
    case 'lightFire': return 'tending the fire...'
    case 'cook': { const t = term(args, ['item']); return t ? `cooking ${t}...` : 'cooking...' }
    case 'store': return 'storing items...'
    case 'take': return 'taking items from a chest...'
    case 'sleep': return 'sleeping...'
    case 'drop': { const t = term(args, ['item']); return t ? `dropping ${t}...` : 'dropping...' }
    case 'give': { const t = term(args, ['item']); return t ? `giving ${t}...` : 'giving...' }
    default: return humanize(name)
  }
}
