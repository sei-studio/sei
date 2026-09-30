// src/bot/adapter/dontstarve/observers/habits.js: what the body did on its
// own lately (260926).
//
// Mod 0.3.0's reflexes (light, fuel, gear, heal, eat, defend) report every
// act as a `survival` event. Most of them should NOT wake the brain: a torch
// lit at nightfall is not news. They are kept here instead and shown in the
// snapshot as one `your_habits` line, so the model knows why its hands hold
// a spear or why the grass count dropped, and can mention it when it matters.

const WINDOW_MS = 90_000
const MAX_ENTRIES = 8

/** One plain phrase per survival event, or null for events not worth a line. */
export function habitPhrase(ev) {
  const what = String(ev?.what ?? '')
  const item = ev?.item ? String(ev.item) : null
  switch (what) {
    case 'light':
      switch (ev?.did) {
        case 'equipped': return `held your ${item ?? 'light'} for light`
        case 'crafted': return 'crafted a torch for light'
        case 'prepared': return 'made a torch for tonight'
        case 'built': return `built a ${item ?? 'campfire'} for light`
        case 'stowed': return `put your ${item ?? 'torch'} away`
        default: return null
      }
    case 'fuel': return `fed the ${ev?.fire ?? 'fire'} with ${item ?? 'fuel'}`
    case 'equip': {
      const items = Array.isArray(ev?.items) ? ev.items.filter((x) => typeof x === 'string') : []
      return items.length ? `equipped ${items.join(', ')} for the fight` : null
    }
    case 'heal': return `used ${item ?? 'something'} to heal`
    case 'ate': return `ate ${item ?? 'something'}`
    case 'defend': return `went after the ${ev?.threat ?? 'creature'} attacking ${ev?.player || 'the player'}`
    case 'retreat': return `backed away from ${ev?.threat ?? 'danger'} (health low)`
    default: return null
  }
}

/**
 * @param {import('node:events').EventEmitter} events  the link's event bus
 * @param {{ now?: () => number, windowMs?: number }} [opts]
 */
export function createHabitLog(events, { now = Date.now, windowMs = WINDOW_MS } = {}) {
  /** @type {Array<{at: number, text: string}>} */
  const entries = []
  const onSurvival = (ev) => {
    const text = habitPhrase(ev)
    if (!text) return
    entries.push({ at: now(), text })
    while (entries.length > MAX_ENTRIES) entries.shift()
  }
  events?.on?.('survival', onSurvival)
  return {
    /** Phrases from the last window, oldest first, repeats folded ("x2"). */
    recent() {
      const cutoff = now() - windowMs
      const counts = new Map()
      for (const e of entries) {
        if (e.at < cutoff) continue
        counts.set(e.text, (counts.get(e.text) ?? 0) + 1)
      }
      return [...counts.entries()].map(([t, n]) => (n > 1 ? `${t} (x${n})` : t))
    },
    clear() { entries.length = 0 },
    dispose() { events?.off?.('survival', onSurvival) },
  }
}
