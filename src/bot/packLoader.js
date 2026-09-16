/**
 * Game pack loader (260908, game-adapters M0b).
 *
 * A game adapter's heavy dependencies (Minecraft: mineflayer, minecraft-data,
 * prismarine-viewer, gl, node-canvas-webgl, ...) are NOT bundled in the app.
 * They arrive as a downloaded "game pack" (src/main/games/packs.ts): a
 * directory holding `node_modules/` + `pack.json`, whose path main ships in
 * the init payload as `packRoot`. The adapter's own source stays in the app
 * (`src/bot/adapter/<game>/**`) and keeps its bare imports
 * (`import mineflayer from 'mineflayer'`), so SOMETHING has to make those
 * specifiers resolve from a directory that is not an ancestor of the file
 * doing the importing. That is this module, in two halves:
 *
 *   ESM  — `module.register()` installs packLoaderHooks.js, whose `resolve`
 *          hook tries the normal resolution first and, only when a BARE
 *          specifier is not found, retries with `parentURL` pointed at the
 *          pack root. "Normal first, pack second" so anything the app itself
 *          bundles (zod, @anthropic-ai/sdk, ...) always wins.
 *   CJS  — `module.register()` hooks do not run for synchronous `require()`
 *          (povRenderer.js builds one with createRequire and pulls
 *          `prismarine-viewer/viewer` and `node-canvas-webgl/lib` through
 *          it). The CJS loader does honor NODE_PATH as its last-resort search
 *          list, so `<packRoot>/node_modules` is appended there and
 *          `Module._initPaths()` re-reads it. Packages INSIDE the pack need
 *          neither: their own requires walk up their own directory tree.
 *
 * WHERE THE CALL MUST SIT. The composer in src/bot/index.js must await this
 * BEFORE it dynamic-imports the game runtime, and the runtime must be a
 * dynamic import (a static `import ... from './adapter/minecraft/index.js'`
 * is hoisted and evaluated before any line of index.js runs, hook or no
 * hook). Exactly:
 *
 *     const { preparePackLoader } = await import('./packLoader.js')   // or a static import of THIS file, which has no game deps
 *     await preparePackLoader(init.packRoot)
 *     const { createMinecraftAdapter } = await import('./adapter/minecraft/index.js')   // only now
 *
 * where `init` is the init message received over the MessagePort. A null or
 * missing `packRoot`, or one equal to the bot's own app root (dev: the repo,
 * where `npm ci` hoists the workspace's packages into node_modules anyway),
 * is a no-op and resolution behaves exactly as it did before game packs.
 *
 * No game dependency is imported here, so this file is safe to load before
 * the pack exists.
 */
import Module, { register } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** The bot's own app root: `<root>/src/bot/packLoader.js` -> `<root>`. In a
 * packaged app that is `app.asar.unpacked`; in dev it is the repo. */
export const OWN_APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Pure: decide what preparePackLoader will do for a pack root. Exported for
 * tests. `active: false` means "nothing to register".
 */
export function packLoaderPlan(packRoot, ownRoot = OWN_APP_ROOT) {
  if (typeof packRoot !== 'string' || packRoot.trim() === '') return { active: false }
  const root = path.resolve(packRoot)
  if (root === path.resolve(ownRoot)) return { active: false }
  return {
    active: true,
    root,
    nodeModulesDir: path.join(root, 'node_modules'),
    // Trailing separator: the ESM resolver treats the URL as a DIRECTORY and
    // starts its node_modules walk inside it, not beside it.
    parentURL: pathToFileURL(root + path.sep).href,
  }
}

let registeredFor = null

/**
 * Make bare specifiers that the app tree cannot satisfy resolve from
 * `<packRoot>/node_modules`, for both ESM imports and CJS requires. Resolves
 * true when a hook was installed, false when nothing was needed. Idempotent
 * for the same root.
 */
export async function preparePackLoader(packRoot, { ownRoot } = {}) {
  const plan = packLoaderPlan(packRoot, ownRoot ?? OWN_APP_ROOT)
  if (!plan.active) return false
  if (registeredFor === plan.root) return true

  // CJS half: NODE_PATH is consulted after every node_modules ancestor, so the
  // app's own copies still win. _initPaths re-reads the env into
  // Module.globalPaths (it only runs at startup otherwise).
  const prev = process.env.NODE_PATH
  const entries = (prev ? prev.split(path.delimiter) : []).filter(Boolean)
  if (!entries.includes(plan.nodeModulesDir)) entries.push(plan.nodeModulesDir)
  process.env.NODE_PATH = entries.join(path.delimiter)
  if (typeof Module._initPaths === 'function') Module._initPaths()

  // ESM half: the resolve hook, running on Node's loader thread.
  register('./packLoaderHooks.js', import.meta.url, { data: { parentURL: plan.parentURL } })
  registeredFor = plan.root
  return true
}
