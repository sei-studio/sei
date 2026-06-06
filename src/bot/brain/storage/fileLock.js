/**
 * Per-file in-process async mutex.
 *
 * Serializes read-modify-write sequences across ANY caller in the same Node
 * process so concurrent savePlayer / appendMemory on the SAME file path do
 * not lose updates.
 *
 * Cross-process correctness is NOT a goal — Sei runs as a single process
 * (utilityProcess in Electron). If a future feature spawns a sibling process
 * that also writes PLAYER.md/MEMORY.md, replace this with a proper-lockfile
 * dependency; until then the in-memory map is sufficient.
 *
 * Bounded memory: callers in this codebase target a handful of distinct
 * file paths (PLAYER.md, MEMORY.md). The internal Map only grows by distinct
 * filePath, so we do not aggressively GC tail entries — leaks are bounded
 * by the number of distinct paths the process ever locks.
 */

/** @type {Map<string, Promise<unknown>>} */
const tails = new Map()

/**
 * Run `fn` while holding an exclusive lock on `filePath`. Returns whatever
 * `fn` returns (or its resolved value). Errors propagate; the lock is
 * always released (the next chained caller runs regardless of whether the
 * previous caller resolved or rejected).
 *
 * @template T
 * @param {string} filePath
 * @param {() => Promise<T> | T} fn
 * @returns {Promise<T>}
 */
export async function withFileLock(filePath, fn) {
  const prev = tails.get(filePath) ?? Promise.resolve()
  // Always chain after prev — we want the next caller to run no matter what;
  // a previous error is the previous caller's concern.
  const run = prev.catch(() => {}).then(() => fn())
  // Update tail to a settled-state mirror of run so the next chained caller
  // does not need to defensively .catch() it themselves.
  tails.set(filePath, run.then(() => undefined, () => undefined))
  return run
}
