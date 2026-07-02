// Pure read/edit core for the dev-viewer LIBRARY tab.
//
// Reads the editable fields of src/bot/brain/promptLibrary.js from an already
// imported module object, and rewrites individual string/array/object-property
// literals in the file's SOURCE TEXT while leaving functions, comments and
// structure untouched. No filesystem or network here — dev-viewer.mjs owns I/O
// and validation; this module is just the (testable) parser + serializer.

// Ordered section/field layout. Object exports auto-expand to their
// string-valued props (in declaration order) so keys can't be mistyped here.
export const LIBRARY_LAYOUT = [
  { section: 'Universal', items: [['UNIVERSAL_BASELINE', 'Universal baseline']] },
  { section: 'Chat surface', items: [['CHAT_BASELINE', 'Chat baseline']] },
  { section: 'Minecraft surface', items: [
    ['MINECRAFT_BASELINE', 'Minecraft baseline'],
    ['WORLD_PRIMER', 'World primer'],
    ['CAPABILITY_PARAGRAPH', 'Capability paragraph'],
    ['SEEING_SENTENCE_VISION', 'Seeing sentence (vision)'],
    ['SEEING_SENTENCE_NOVISION', 'Seeing sentence (no vision)'],
    ['ACTION_RULES', 'Action rules'],
    ['SEEING_RULE_VISION', 'Seeing rule (vision)'],
    ['SEEING_RULE_NOVISION', 'Seeing rule (no vision)'],
    ['PATHFINDER_RULE_VISION', 'Pathfinder rule (vision)'],
    ['PATHFINDER_RULE_NOVISION', 'Pathfinder rule (no vision)'],
    ['CUBOID_GRAMMAR', 'Cuboid grammar'],
    ['EXPLORE_DESCRIPTION_NOVISION', 'explore() description (no vision)'],
    ['ACTION_DESCRIPTIONS', 'Action description'],
    ['EVENT_GUIDANCE', 'Event guidance'],
  ] },
  { section: 'Personality & tools', items: [
    ['SPEAK_REMINDER', 'Speak reminder'],
    ['PERSONALITY_TOOL_DESCRIPTIONS', 'Tool description'],
    ['PROACTIVENESS_DIRECTIVES', 'Proactiveness directive'],
  ] },
  { section: 'Memory', items: [['COMPACTION_SYSTEM', 'Memory compaction instruction']] },
  { section: 'Persona expansion', items: [
    ['EXPANSION_SYSTEM', 'Expansion instruction'],
  ] },
  { section: 'Seed & nudges', items: [
    ['SEED_HEADERS', 'Seed header'],
    ['NUDGES', 'Nudge'],
  ] },
]
// Exports stored as `[ ... ].join('\n')` — edited as the joined string.
export const ARRAY_FIELDS = new Set(['COMPACTION_SYSTEM', 'EXPANSION_SYSTEM'])
// Object-prop ids pack the export + key around a NUL, which never appears in
// source, so the client can treat the id as opaque and the server splits it back.
export const ID_SEP = '\u0000'

// Build the field descriptors (id, section, label, kind, value) from the live
// module. `export`/`key` are recovered from the id on save, so the client only
// round-trips id+value.
export function buildLibraryFields (mod) {
  const fields = []
  for (const { section, items } of LIBRARY_LAYOUT) {
    for (const [name, label] of items) {
      const val = mod[name]
      if (ARRAY_FIELDS.has(name)) {
        fields.push({ id: name, section, label, kind: 'array', value: typeof val === 'string' ? val : '' })
      } else if (typeof val === 'string') {
        fields.push({ id: name, section, label, kind: 'string', value: val })
      } else if (val && typeof val === 'object') {
        for (const [k, v] of Object.entries(val)) {
          if (typeof v !== 'string') continue // skip function-valued props
          fields.push({ id: name + ID_SEP + k, section, label: label + ' · ' + k, kind: 'objprop', value: v })
        }
      }
    }
  }
  return fields
}

// ── tiny JS-literal scanner (enough for promptLibrary's shapes) ──────────────

// src[i] opens a string ('/"/`). Returns the index just past the close.
export function scanString (src, i) {
  const q = src[i]
  i++
  while (i < src.length) {
    const c = src[i]
    if (c === '\\') { i += 2; continue }
    if (q === '`' && c === '$' && src[i + 1] === '{') { i = scanBracket(src, i + 1); continue }
    if (c === q) return i + 1
    i++
  }
  throw new Error('unterminated string literal')
}
// A `//` or `/*` comment at src[i] in CODE context → index just past it, else
// i unchanged. (Never called from inside a string, where `//` is literal text.)
function skipComment (src, i) {
  if (src[i] === '/' && src[i + 1] === '/') {
    const nl = src.indexOf('\n', i)
    return nl === -1 ? src.length : nl
  }
  if (src[i] === '/' && src[i + 1] === '*') {
    const e = src.indexOf('*/', i)
    return e === -1 ? src.length : e + 2
  }
  return i
}
// src[i] opens a bracket ([ { or the `{` of a `${`). Returns index past the close.
export function scanBracket (src, i) {
  let depth = 0
  while (i < src.length) {
    const c = src[i]
    const sk = skipComment(src, i)
    if (sk !== i) { i = sk; continue }
    if (c === '"' || c === "'" || c === '`') { i = scanString(src, i); continue }
    if (c === '(' || c === '[' || c === '{') { depth++; i++; continue }
    if (c === ')' || c === ']' || c === '}') { depth--; i++; if (depth === 0) return i; continue }
    i++
  }
  throw new Error('unterminated bracket')
}
// From a value start, find where the value ends: a literal (scanned exactly) or
// any expression (function, etc.) up to the next top-level `,` or `}`. Comments
// in a function-valued prop are skipped so a `'`/`"` inside one (it's, "…") is
// never mistaken for a string delimiter.
export function scanValue (src, i) {
  while (i < src.length && /\s/.test(src[i])) i++
  const c = src[i]
  if (c === '"' || c === "'" || c === '`') return scanString(src, i)
  if (c === '[' || c === '{') return scanBracket(src, i)
  let depth = 0
  while (i < src.length) {
    const ch = src[i]
    const sk = skipComment(src, i)
    if (sk !== i) { i = sk; continue }
    if (ch === '"' || ch === "'" || ch === '`') { i = scanString(src, i); continue }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; i++; continue }
    if (ch === ')' || ch === ']' || ch === '}') { if (depth === 0) return i; depth--; i++; continue }
    if (ch === ',' && depth === 0) return i
    i++
  }
  return i
}
export function skipWsComments (src, i) {
  for (;;) {
    if (/\s/.test(src[i])) { i++; continue }
    if (src[i] === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i === -1) return src.length; continue }
    if (src[i] === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i); i = e === -1 ? src.length : e + 2; continue }
    return i
  }
}
// Index of the first value char after `export const NAME =`.
export function exportValueStart (src, name) {
  const re = new RegExp('export const ' + name + '\\s*=\\s*')
  const m = re.exec(src)
  if (!m) throw new Error('export not found: ' + name)
  return m.index + m[0].length
}
// Map of prop key -> {start,end} (the value literal span) for the object whose
// `{` is at objBrace. Handles quoted/bare/numeric keys, comments, and
// function-valued props (skipped over via scanValue).
export function objectPropRanges (src, objBrace) {
  const end = scanBracket(src, objBrace) - 1 // index of closing `}`
  const props = {}
  let i = objBrace + 1
  while (i < end) {
    i = skipWsComments(src, i)
    if (i >= end) break
    let key
    const c = src[i]
    if (c === '"' || c === "'" || c === '`') {
      const close = scanString(src, i)
      key = src.slice(i + 1, close - 1)
      i = close
    } else {
      const m = /^[\w$]+/.exec(src.slice(i))
      if (!m) break
      key = m[0]
      i += key.length
    }
    i = skipWsComments(src, i)
    if (src[i] !== ':') break
    i++
    i = skipWsComments(src, i)
    const vStart = i
    const vEnd = scanValue(src, i)
    props[key] = { start: vStart, end: vEnd }
    i = skipWsComments(src, vEnd)
    if (src[i] === ',') i++
  }
  return props
}

// Serialize a string as a template literal (safe for any content incl. newlines).
export function toTemplateLiteral (s) {
  return '`' + String(s).replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${') + '`'
}
// Serialize a joined string back into a `[ "line", ... ]` array literal (the
// trailing `.join('\n')` in source is left untouched).
export function toArrayLiteral (joined) {
  const lines = String(joined).split('\n').map((l) => '  ' + JSON.stringify(l))
  return '[\n' + lines.join(',\n') + ',\n]'
}

// Compute the (start,end,replacement) edit for one field id + new value.
export function fieldEdit (src, id, value) {
  const sep = id.indexOf(ID_SEP)
  if (sep === -1) {
    const name = id
    const start = exportValueStart(src, name)
    if (ARRAY_FIELDS.has(name)) {
      const end = scanBracket(src, start) // start is at `[`
      return { start, end, text: toArrayLiteral(value) }
    }
    const end = scanString(src, start)
    return { start, end, text: toTemplateLiteral(value) }
  }
  const name = id.slice(0, sep)
  const key = id.slice(sep + 1)
  const objBrace = exportValueStart(src, name) // at `{`
  const ranges = objectPropRanges(src, objBrace)
  const r = ranges[key]
  if (!r) throw new Error('prop not found: ' + name + '.' + key)
  return { start: r.start, end: r.end, text: toTemplateLiteral(value) }
}

// Apply many edits to the source text (descending by start so indices hold).
export function applyEdits (src, edits) {
  const computed = edits.map(({ id, value }) => fieldEdit(src, id, value))
  computed.sort((a, b) => b.start - a.start)
  let out = src
  for (const e of computed) out = out.slice(0, e.start) + e.text + out.slice(e.end)
  return out
}
