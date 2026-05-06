/**
 * Phase 3 D-59: chain tracker retired in favor of per-Loop iteration_cap
 * (config.memory.iteration_cap, default 20). The orchestrator now owns a
 * `Loop` (src/llm/loop.js) whose own iterationCount + abortController
 * subsumes the chain-id / hop-counter / TTL-sweep responsibilities this
 * module used to provide.
 *
 * This file is kept as a no-op shim during 3-01 to avoid breaking imports
 * (orchestrator constructs a chain tracker today; full deletion is a
 * follow-up cleanup once no consumers reference `createChainTracker`).
 *
 * Each method returns a safe default so existing call sites do not crash:
 *   begin(seedEvent)    -> returns 0 (no real id; orchestrator no longer
 *                          uses it for anything meaningful)
 *   continue(chainId)   -> returns null (treat every dispatch as fresh)
 *   increment(chainId)  -> returns { hops: 0, capped: false, missing: false }
 *   end(chainId)        -> no-op
 *   size()              -> 0
 *
 * The 60s TTL sweep is removed entirely (Q4): under Loop ownership a chain
 * is bounded by the Loop's lifetime, which is bounded by iterationCap +
 * abortController, so there is nothing to sweep.
 */

export function createChainTracker(_opts = {}) {
  return {
    begin: () => 0,
    continue: () => null,
    increment: () => ({ hops: 0, capped: false, missing: false }),
    end: () => undefined,
    size: () => 0,
    _internal: { chains: new Map() },
  }
}
