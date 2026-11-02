// Install the system-proxy dispatcher (proxyDispatcher.js) as undici's global
// dispatcher, which Node's built-in fetch reads on every request (261103,
// T303).
//
// No static import of the undici package here, on purpose. Loading undici
// fills the empty global dispatcher slot with undici's own Agent, and the
// slot is shared with Node's built-in fetch, so a static import would move
// every request (DIRECT included) off Node's own Agent the moment this file
// loaded. installSystemProxy first lets the built-in fetch create its Agent
// (a `data:` fetch, no network), then loads undici and keeps that Agent as
// the DIRECT route, so a DIRECT request takes the path it took before.

const GLOBAL_DISPATCHER = Symbol.for('undici.globalDispatcher.1')

/** @type {Promise<import('./proxyDispatcher.js').SystemProxyDispatcher> | null} */
let installing = null

/**
 * Idempotent. Resolves to the installed dispatcher.
 * @param {import('./proxyDispatcher.js').SystemProxyOptions} opts
 * @returns {Promise<import('./proxyDispatcher.js').SystemProxyDispatcher>}
 */
export function installSystemProxy(opts) {
  if (installing) return installing
  const attempt = (async () => {
    const g = /** @type {Record<symbol, unknown>} */ (/** @type {unknown} */ (globalThis))
    if (g[GLOBAL_DISPATCHER] === undefined && typeof globalThis.fetch === 'function') {
      try {
        await (await globalThis.fetch('data:,')).arrayBuffer()
      } catch {
        /* no built-in fetch dispatcher: the undici package's Agent serves DIRECT */
      }
    }
    const builtIn = g[GLOBAL_DISPATCHER]
    const { SystemProxyDispatcher } = await import('./proxyDispatcher.js')
    if (builtIn instanceof SystemProxyDispatcher) return builtIn
    const { setGlobalDispatcher } = await import('undici')
    const d = new SystemProxyDispatcher({
      ...opts,
      // Fall back to whatever undici put in the slot when it loaded.
      direct: opts.direct ?? /** @type {any} */ (builtIn ?? g[GLOBAL_DISPATCHER]),
    })
    setGlobalDispatcher(d)
    return d
  })()
  installing = attempt
  // A failed install may be tried again.
  attempt.catch(() => {
    if (installing === attempt) installing = null
  })
  return attempt
}

/** Test seam: forget the install so a test can install again. */
export function resetInstallForTest() {
  installing = null
}
