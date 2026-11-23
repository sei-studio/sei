/**
 * Electron IPC error unwrapping (261119).
 *
 * A main-side throw reaches the renderer through `ipcRenderer.invoke` as
 * "Error invoking remote method 'chars:add-to-library': Error: You can only
 * have 4 companions. Remove one to make room." and screens that showed
 * `err.message` printed that wrapper to users. The preload bridge strips it
 * on every invoke (src/preload/index.ts `invoke`), and the renderer's
 * `userFacingError` (lib/errors.ts) strips it again for errors that never
 * crossed the bridge (tests, mocks, nested rethrows).
 *
 * Pure and dependency-free: the preload imports it and compiles to .cjs.
 */

const IPC_WRAPPER = /^Error invoking remote method '[^']*':\s*/;

/** A leading class-name prefix: "Error: ", "KnowledgeExtractError: ", ... */
const CLASS_PREFIX = /^((?:[A-Za-z_$][\w$]*)?Error):\s*/;

/**
 * JavaScript's own error classes. Their prefix is kept: "TypeError: x is not
 * a function" is a bug, never copy, and `userFacingError` needs the prefix to
 * recognise it and show the generic line instead.
 */
const BUILTIN_JS_ERRORS = new Set([
  'TypeError',
  'ReferenceError',
  'SyntaxError',
  'RangeError',
  'EvalError',
  'URIError',
  'AggregateError',
  'InternalError',
]);

/**
 * The message text of any rejection value. Error and `{ message }` give their
 * message, a string is itself, null/undefined and plain objects give ''
 * (never "[object Object]").
 */
export function errorMessageOf(err: unknown): string {
  if (err == null) return '';
  if (typeof err === 'string') return err;
  if (typeof err === 'object' && 'message' in err) {
    const m = (err as { message: unknown }).message;
    return typeof m === 'string' ? m : m == null ? '' : String(m);
  }
  if (typeof err === 'object') return '';
  return String(err);
}

/**
 * Remove every Electron IPC wrapper and every leading non-builtin error class
 * prefix, however deeply nested ("Error invoking remote method 'a': Error:
 * Error invoking remote method 'b': Error: msg" -> "msg").
 */
export function stripIpcWrapper(message: string): string {
  let s = message.trim();
  // Bounded: each pass removes at least one prefix or stops.
  for (let i = 0; i < 16; i++) {
    const before = s;
    s = s.replace(IPC_WRAPPER, '');
    const m = CLASS_PREFIX.exec(s);
    if (m && !BUILTIN_JS_ERRORS.has(m[1])) s = s.slice(m[0].length);
    s = s.trimStart();
    if (s === before) break;
  }
  return s.trim();
}

/**
 * The preload's rejection mapper: the same Error with its message unwrapped
 * (so `instanceof Error` and the stack survive), or a new Error for a
 * non-Error rejection.
 */
export function unwrapIpcRejection(err: unknown): Error {
  const clean = stripIpcWrapper(errorMessageOf(err));
  if (err instanceof Error) {
    try {
      err.message = clean;
      return err;
    } catch {
      /* frozen error object: fall through to a fresh one */
    }
  }
  return new Error(clean);
}
