// src/bot/adapter/minecraft/observers/liveInventory.js
//
// 261012 (quality pass 5): what is in her bag RIGHT NOW, and a way to wait
// until the server has stopped changing it.
//
// Two lags, both measured in the quality eval:
//  - While a window is open (a furnace session stays open across smeltInput,
//    addFuel and takeSmelted), mineflayer updates the player's slots in the
//    WINDOW. bot.inventory is only copied from it when the window closes, so
//    the snapshot said raw_iron x3 and no ingots right after "took 3
//    iron_ingot". liveInventoryItems reads the window's inventory section
//    when one is open.
//  - On 1.17+ window clicks are not confirmed. bot.craft resolves on the
//    client's own prediction, and the server's correction (it can undo the
//    craft and hand the materials back) lands 50-500 ms later. The eval had
//    "crafted 1 crafting_table" followed 1.3 s later by placeBlock "no
//    crafting_table in inventory". waitInventoryQuiet waits for the slot
//    updates to stop before an action reads the result.

/** The player's main inventory + hotbar items, from the open window if any. */
export function liveInventoryItems(bot) {
  const w = bot?.currentWindow
  if (w && w !== bot?.inventory && typeof w.items === 'function') {
    try {
      const items = w.items()
      if (Array.isArray(items)) return items
    } catch { /* fall through */ }
  }
  try {
    return typeof bot?.inventory?.items === 'function' ? bot.inventory.items() : []
  } catch {
    return []
  }
}

/** Total count of an item, by name or numeric id. */
export function liveCount(bot, item) {
  let n = 0
  for (const it of liveInventoryItems(bot)) {
    if (!it) continue
    if (typeof item === 'number' ? it.type === item : it.name === item) n += it.count ?? 0
  }
  return n
}

/** True when the bot has a live inventory that emits slot updates. */
export function hasLiveInventory(bot) {
  return typeof bot?.inventory?.on === 'function' && typeof bot?.inventory?.removeListener === 'function'
}

/**
 * Resolve once no inventory slot has changed for `quietMs` (and at least
 * `minMs` has passed), or after `maxMs`, or on abort. Returns 'quiet',
 * 'max', 'aborted', or 'n/a' when the bot has no live inventory (test fakes).
 */
export function waitInventoryQuiet(bot, { quietMs = 250, minMs = 0, maxMs = 1500, signal } = {}) {
  if (!hasLiveInventory(bot)) return Promise.resolve('n/a')
  if (signal?.aborted) return Promise.resolve('aborted')
  return new Promise((resolve) => {
    const start = Date.now()
    const sources = [bot.inventory]
    const w = bot.currentWindow
    if (w && w !== bot.inventory && typeof w.on === 'function') sources.push(w)
    let quietTimer = null
    let done = false
    const finish = (v) => {
      if (done) return
      done = true
      clearTimeout(quietTimer)
      clearTimeout(maxTimer)
      for (const s of sources) { try { s.removeListener('updateSlot', onSlot) } catch {} }
      signal?.removeEventListener?.('abort', onAbort)
      resolve(v)
    }
    const arm = () => {
      clearTimeout(quietTimer)
      const wait = Math.max(quietMs, minMs - (Date.now() - start))
      quietTimer = setTimeout(() => finish('quiet'), wait)
    }
    const onSlot = () => arm()
    const onAbort = () => finish('aborted')
    const maxTimer = setTimeout(() => finish('max'), Math.max(maxMs, minMs))
    for (const s of sources) { try { s.on('updateSlot', onSlot) } catch {} }
    signal?.addEventListener?.('abort', onAbort, { once: true })
    arm()
  })
}




