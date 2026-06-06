/**
 * Per-key trailing-edge coalescer. Last payload wins; one fire per key per quiet window.
 * Use for chat / streamy ingress where it's fine to wait for the burst to settle.
 */
export function createDebouncer(windowMs) {
  /** @type {Map<string,{timer:any,payload:any,fire:Function}>} */
  const pending = new Map()
  return {
    /** Coalesce events with the same `key`; `fire(payload)` is called once after windowMs of quiet. */
    debounce(key, payload, fire) {
      const existing = pending.get(key)
      if (existing) { clearTimeout(existing.timer); existing.payload = payload; existing.fire = fire }
      const entry = existing ?? { payload, fire, timer: null }
      entry.timer = setTimeout(() => { pending.delete(key); entry.fire(entry.payload) }, windowMs)
      pending.set(key, entry)
    },
    /** Cancel all pending. */
    flushCancel() { for (const e of pending.values()) clearTimeout(e.timer); pending.clear() },
  }
}

/**
 * Per-key leading-edge throttle. The first call for a key fires immediately;
 * subsequent calls within `windowMs` are dropped. After the window expires,
 * the next call fires immediately again.
 *
 * Use for interruptive events (combat hits) where the bot must react NOW —
 * not after a quiet window — but rapid repeats should not retrigger the LLM.
 */
export function createThrottle(windowMs) {
  /** @type {Map<string,any>} timer per key while in cooldown */
  const cooldowns = new Map()
  return {
    /** Fire immediately on first call per key; suppress within window. Returns true iff fired. */
    throttle(key, payload, fire) {
      if (cooldowns.has(key)) return false
      const timer = setTimeout(() => { cooldowns.delete(key) }, windowMs)
      cooldowns.set(key, timer)
      try { fire(payload) } catch (err) {
        clearTimeout(timer); cooldowns.delete(key); throw err
      }
      return true
    },
    /** Cancel all cooldowns (does not refire). */
    flushCancel() { for (const t of cooldowns.values()) clearTimeout(t); cooldowns.clear() },
  }
}
