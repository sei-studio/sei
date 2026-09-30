/**
 * Module customization hooks for the game pack loader (260908). Installed by
 * packLoader.js via `module.register()`; runs on Node's loader thread, so it
 * must stay self-contained (no imports from the rest of the bot).
 *
 * The one rule: a BARE specifier that normal resolution reports as not found
 * is retried with `parentURL` set to the pack root, so `import x from 'pkg'`
 * inside app code finds `<packRoot>/node_modules/pkg`. Relative and absolute
 * specifiers, and anything the app tree already satisfies, are untouched.
 */
let packParentURL = null

export async function initialize(data) {
  packParentURL = data && typeof data.parentURL === 'string' ? data.parentURL : null
}

/** Pure: is `specifier` a bare package specifier (not relative, absolute, or a URL)? */
export function isBareSpecifier(specifier) {
  if (typeof specifier !== 'string' || specifier === '') return false
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('\\')) return false
  if (/^[a-zA-Z]:[\\/]/.test(specifier)) return false
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(specifier)) return false // node:, file:, data:, http:
  return true
}

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (err) {
    if (
      !packParentURL ||
      !isBareSpecifier(specifier) ||
      !err ||
      err.code !== 'ERR_MODULE_NOT_FOUND' ||
      context.parentURL === packParentURL
    ) {
      throw err
    }
    return nextResolve(specifier, { ...context, parentURL: packParentURL })
  }
}
