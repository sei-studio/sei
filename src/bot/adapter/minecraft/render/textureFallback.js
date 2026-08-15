// src/bot/adapter/minecraft/render/textureFallback.js
//
// A missing texture must never kill the bot (260806).
//
// prismarine-viewer's `loadTexture` (viewer/lib/utils.js) is:
//
//     loadImage(path.resolve(__dirname, '../../public/' + texture)).then(image => {
//       textureCache[texture] = new THREE.CanvasTexture(image)
//       cb(textureCache[texture])
//     })
//
// There is NO `.catch`, and node-canvas's loadImage wires `image.onerror = reject`
// before setting src, so a texture that is not on disk yields a REJECTED promise
// with no handler. That rejection is asynchronous, so it escapes every try/catch
// on the render path and lands on the process-level `unhandledRejection` hook in
// src/bot/index.js, which emits BOT_CRASH and calls process.exit(1). One absent
// PNG kills the whole companion, mid-session, with the world still open.
//
// This is not hypothetical and it is not an edge case in packaged builds:
// viewer/lib/entities.js line 12 constructs every entity as
//
//     new Entity('1.16.4', entity.name, scene)
//
// with the version HARDCODED — entity textures always resolve under
// `public/textures/1.16.4/`, whatever version the world runs. The packaging
// prune in electron-builder.yml excluded that whole tree, so in a shipped build
// the FIRST entity to enter the bot's POV render killed the process. (The
// exclusion is fixed alongside this, but that fix restores quality; THIS file is
// what makes the failure survivable.)
//
// Why a placeholder rather than skipping the entity: povRenderer's
// `modelRenderable()` already skips entities with no model or a broken skeleton,
// and skipping is the right answer THERE because those cannot be drawn at all.
// A missing texture is different — the geometry is fine, only the paint is gone,
// and the entity in question is very often the PLAYER (`textures/entity/steve`).
// Skipping it would make the human the bot is playing with invisible in its own
// vision, which is a worse failure than an untextured figure and a much quieter
// one.
//
// The placeholder is a flat neutral grey, deliberately NOT magenta: the viewer's
// own debug fallback is magenta and povRenderer already documents that magenta
// debug boxes pollute the LLM's view with "strange pink blocks". Grey reads as
// "something is there" without inventing a coloured object that isn't.
//
// INSTALL ORDER IS LOAD-BEARING. Both consumers destructure at module load:
//
//     viewer/lib/worldrenderer.js:  const { loadTexture } = require('./utils')
//     viewer/lib/entity/Entity.js:  const { loadTexture } = globalThis.isElectron
//                                     ? require('../utils.electron.js')
//                                     : require('../utils')
//
// so replacing the export AFTER those modules load changes nothing — they are
// holding the original function reference. `installTextureFallback` must run
// before the first `require('prismarine-viewer/viewer')`. povRenderer.js calls
// it at the top of the module for exactly that reason; do not move it below the
// Viewer import. Both utils variants are patched because `globalThis.isElectron`
// is not set today but is not ours to guarantee.

import { statSync } from 'node:fs'
import path from 'node:path'

/** Placeholder fill. Neutral grey, fully opaque. See the note above on magenta. */
export const PLACEHOLDER_RGB = '#8a8a8a'
export const PLACEHOLDER_SIZE = 64

/**
 * Raw RGBA bytes for the placeholder, as a THREE.DataTexture wants them.
 *
 * Deliberately NOT node-canvas: `canvas` and `node-canvas-webgl` are native
 * modules built against the Electron ABI, and the whole point of this file is to
 * be the thing that still works when the render stack is degraded. A DataTexture
 * is pure JS and cannot fail to construct.
 */
export function placeholderPixels (size = PLACEHOLDER_SIZE, rgb = PLACEHOLDER_RGB) {
  const [, r, g, b] = /^#(..)(..)(..)$/.exec(rgb).map((h, i) => (i === 0 ? h : parseInt(h, 16)))
  const data = new Uint8Array(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = r
    data[i * 4 + 1] = g
    data[i * 4 + 2] = b
    data[i * 4 + 3] = 255
  }
  return data
}

/**
 * Is this texture actually loadable from disk? A zero-byte or non-file entry is
 * treated as missing: those are the shapes a truncated or half-copied install
 * takes, and node-canvas rejects on them in exactly the same unhandled way as an
 * absent file.
 *
 * @param {string} file absolute path
 * @returns {boolean}
 */
export function texturePresent (file) {
  try {
    const st = statSync(file)
    return st.isFile() && st.size > 0
  } catch {
    return false
  }
}

/**
 * Build a drop-in replacement for prismarine-viewer's `loadTexture(texture, cb)`.
 *
 * Pure in its dependencies so the unit test can drive it without prismarine-viewer,
 * node-canvas or a GL context.
 *
 * Contract notes, both inherited from the function being replaced:
 *   - `cb` is called with a THREE texture, and callers mutate it in place
 *     (Entity.js sets magFilter/minFilter/wrapS/wrapT/flipY on what it receives).
 *     The placeholder is therefore created ONCE and shared, which is safe only
 *     because every caller applies the same nearest-neighbour settings. If that
 *     ever stops being true, mint one placeholder per texture key instead.
 *   - results are cached per texture key, including failures, so a texture that
 *     is missing costs one statSync for the whole process rather than one per
 *     entity spawn.
 *
 * @param {object} deps
 * @param {string} deps.publicDir           prismarine-viewer's `public/` directory
 * @param {(file: string) => Promise<any>} deps.loadImage    node-canvas loadImage
 * @param {(image: any) => any} deps.makeTexture             image -> THREE texture
 * @param {() => any} deps.makePlaceholder                   () -> THREE texture
 * @param {(msg: string) => void} [deps.warn]                one line per missing texture
 * @param {(file: string) => boolean} [deps.present]         injectable for tests
 * @returns {(texture: string, cb: (tex: any) => void) => void}
 */
export function createSafeLoadTexture (deps) {
  const {
    publicDir,
    loadImage,
    makeTexture,
    makePlaceholder,
    warn = () => {},
    present = texturePresent,
  } = deps

  const cache = new Map()
  let placeholder = null
  const getPlaceholder = () => {
    if (!placeholder) placeholder = makePlaceholder()
    return placeholder
  }

  return function safeLoadTexture (texture, cb) {
    if (cache.has(texture)) {
      cb(cache.get(texture))
      return
    }

    const file = path.resolve(publicDir, texture)

    // Check first, so the common failure never creates a promise at all. A
    // rejected promise we then .catch() would be fine too, but not creating one
    // means there is no window in which an unhandledRejection can be observed
    // by a hook installed elsewhere.
    //
    // `!loadImage` is the degraded-native-module case (see installTextureFallback):
    // no decoder means nothing is loadable regardless of what is on disk.
    if (!loadImage || !present(file)) {
      warn(`[sei/vision] missing texture "${texture}" — drawing a placeholder`)
      const tex = getPlaceholder()
      cache.set(texture, tex)
      cb(tex)
      return
    }

    // Present on disk but still able to fail: a corrupt or truncated PNG
    // rejects inside the decoder rather than at open(). Same fallback.
    Promise.resolve()
      .then(() => loadImage(file))
      .then((image) => {
        const tex = makeTexture(image)
        cache.set(texture, tex)
        cb(tex)
      })
      .catch((err) => {
        warn(`[sei/vision] texture "${texture}" failed to decode (${err && err.message}) — drawing a placeholder`)
        const tex = getPlaceholder()
        cache.set(texture, tex)
        cb(tex)
      })
  }
}

/**
 * Patch prismarine-viewer's texture loader in place.
 *
 * Idempotent: a second call is a no-op, so an accidental double-install (or a
 * future second entry point into the render stack) cannot stack two layers of
 * caching.
 *
 * @param {NodeRequire} pvRequire  require anchored INSIDE prismarine-viewer's own
 *                                 tree (see povRenderer's note on why THREE must
 *                                 come from there and not the hoisted copy)
 * @param {object} [opts]
 * @param {(msg: string) => void} [opts.warn]
 * @returns {boolean} true if a patch was applied, false if already installed
 */
export function installTextureFallback (pvRequire, opts = {}) {
  const warn = opts.warn ?? ((m) => console.log(m))

  const pvRoot = path.dirname(pvRequire.resolve('prismarine-viewer/package.json'))
  const publicDir = path.join(pvRoot, 'public')

  // three is pure JS and resolves from prismarine-viewer's own tree (povRenderer
  // documents why the hoisted copy must not be used here).
  const THREE = pvRequire('three')

  // node-canvas-webgl dlopens `gl`, a native module built for the Electron ABI.
  // viewer/lib/utils.js wraps this very require in its own `safeRequire` and
  // degrades to an empty object, so this file must be at least as tolerant: an
  // install that THREW here would turn a graceful CANT_SEE into a hard failure to
  // import povRenderer at all. When the loader is unavailable every texture takes
  // the placeholder path, which is the correct degrade — nothing can be decoded.
  let loadImage = null
  try {
    ({ loadImage } = pvRequire('node-canvas-webgl/lib'))
  } catch (err) {
    warn(`[sei/vision] image loader unavailable (${err && err.message}) — all textures will be placeholders`)
  }
  if (typeof loadImage !== 'function') loadImage = null

  const makeTexture = (image) => new THREE.CanvasTexture(image)
  const makePlaceholder = () => {
    const tex = new THREE.DataTexture(
      placeholderPixels(),
      PLACEHOLDER_SIZE,
      PLACEHOLDER_SIZE,
      THREE.RGBAFormat,
    )
    tex.needsUpdate = true
    return tex
  }

  const safe = createSafeLoadTexture({
    publicDir,
    loadImage,
    makeTexture,
    makePlaceholder,
    warn,
    // No decoder means nothing on disk is loadable, whatever statSync says.
    present: loadImage ? undefined : () => false,
  })
  safe._seiTextureFallback = true

  let patched = false
  // utils.electron.js is the `globalThis.isElectron` branch of Entity.js. It uses
  // THREE.TextureLoader rather than node-canvas and so does not produce the same
  // unhandled rejection, but it also silently yields a blank texture; routing it
  // through the same path keeps one behaviour instead of two.
  for (const mod of ['./viewer/lib/utils', './viewer/lib/utils.electron.js']) {
    let utils
    try {
      utils = pvRequire(mod)
    } catch {
      continue // variant not present in this prismarine-viewer version
    }
    if (!utils || typeof utils.loadTexture !== 'function') continue
    if (utils.loadTexture._seiTextureFallback) continue
    utils.loadTexture = safe
    patched = true
  }
  return patched
}
