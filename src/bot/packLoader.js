// src/bot/packLoader.js — game-pack module resolution (STUB, game-adapters M0).
//
// Game adapters are downloaded on first use rather than bundled (plan
// .planning/game-adapters-260908.md section 2.5): each game's runtime
// dependencies (mineflayer and friends for Minecraft, the SMAPI/DST assets for
// the others) live in a versioned pack under `<userData>/game-packs/<game>/`,
// and the init payload carries that directory as `packRoot`.
//
// The game-pack branch REPLACES the body of preparePackLoader with a
// `module.register()` resolve hook (node:module) that rewrites BARE specifiers
// so `import mineflayer from 'mineflayer'` inside the in-app adapter code
// resolves from `<packRoot>/node_modules/`, while CJS requires inside the pack
// keep resolving within the pack as normal. In dev (unpackaged) `packRoot` is
// the repo root and the hook is a no-op. No import under src/bot/adapter/**
// changes.
//
// The composer (src/bot/index.js) awaits this BEFORE it dynamic-imports
// `./adapter/<kind>/runtime.js`, so the hook is in place before the first
// adapter module is resolved. Until the real hook lands this is a deliberate
// no-op: every adapter dependency resolves from the app's own node_modules
// exactly as before.

/**
 * @param {string|null} packRoot Absolute path to the downloaded game pack for
 *   this session's game, or null when main shipped none (older main, dev).
 * @returns {Promise<void>}
 */
export async function preparePackLoader(packRoot) {
  // Intentionally empty. See the module comment: the game-pack branch
  // registers the resolve hook here. Referencing the argument keeps the
  // signature honest for callers and linters.
  void packRoot
}
