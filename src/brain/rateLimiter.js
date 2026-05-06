/**
 * Token bucket. capacity tokens, refill `refillPerMin` per minute.
 * @param {{capacity:number, refillPerMin:number}} opts
 */
export function createTokenBucket({ capacity, refillPerMin }) {
  let tokens = capacity
  const refillIntervalMs = 60_000 / refillPerMin
  let lastRefill = Date.now()
  function refill() {
    const elapsed = Date.now() - lastRefill
    const add = Math.floor(elapsed / refillIntervalMs)
    if (add > 0) {
      tokens = Math.min(capacity, tokens + add)
      lastRefill += add * refillIntervalMs
    }
  }
  return {
    /** @returns {boolean} */
    tryAcquire() { refill(); if (tokens >= 1) { tokens -= 1; return true } return false },
    available() { refill(); return tokens },
    /** Wait up to `timeoutMs` for a token. Resolves true if acquired, false on timeout. */
    async awaitAcquire(timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (this.tryAcquire()) return true
        const wait = Math.min(refillIntervalMs, deadline - Date.now())
        if (wait <= 0) break
        await new Promise(r => setTimeout(r, wait))
      }
      return false
    },
  }
}
