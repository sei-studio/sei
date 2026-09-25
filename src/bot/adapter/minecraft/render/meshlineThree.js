// src/bot/adapter/minecraft/render/meshlineThree.js
//
// 260926: `Cannot find module 'three'` from the game pack (0.6.5-beta.1,
// `game-packs\minecraft\0.6.5-beta.1`), thrown on the first POV render.
//
// prismarine-viewer/viewer/lib/primitives.js requires `three.meshline`, which
// finds THREE like this:
//
//   var root = this                        // CJS: module.exports, never the global
//   var THREE = root.THREE || require('three')
//
// so it always does a bare require('three') from its own location. npm hoists
// three.meshline to the top node_modules, but the only `three` in the pack's
// closure is prismarine-viewer's nested 0.128 copy
// (node_modules/prismarine-viewer/node_modules/three), which a module at the
// top level cannot see. NODE_PATH does not help (it only lists the pack's
// node_modules). In dev it works by accident: the app's own three (0.185, for
// skinview3d) sits at the repo root, so meshline silently binds to a THIRD
// copy of three, not the one the viewer renders with.
//
// Fix: load three.meshline once, before prismarine-viewer/viewer, with its
// require('three') pointed at prismarine-viewer's own three. After that the
// module is in require.cache and primitives.js gets it from there. The
// resolver hook is scoped to that one request from that one file and removed
// straight away.

import Module from 'node:module'
import { dirname, sep } from 'node:path'

/**
 * Load `three.meshline` (as prismarine-viewer resolves it) bound to the viewer's
 * own `three`. Returns the module. Throws only when three.meshline itself is
 * missing; the caller's existing error handling (CANT_SEE) covers that.
 *
 * @param {NodeRequire} pvRequire  a require anchored at prismarine-viewer's package.json
 */
export function loadMeshlineWithViewerThree(pvRequire) {
  const threePath = pvRequire.resolve('three')
  const meshlineEntry = pvRequire.resolve('three.meshline')
  const meshlineDir = dirname(meshlineEntry)
  const origResolve = Module._resolveFilename
  Module._resolveFilename = function (request, parent, ...rest) {
    const from = parent?.filename ?? ''
    if (request === 'three' && (from === meshlineEntry || from.startsWith(meshlineDir + sep))) return threePath
    return origResolve.call(this, request, parent, ...rest)
  }
  try {
    return pvRequire('three.meshline')
  } finally {
    Module._resolveFilename = origResolve
  }
}
