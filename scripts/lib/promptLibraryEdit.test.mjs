// Round-trip tests for the dev-viewer LIBRARY editor against the REAL
// promptLibrary.js. The strongest guarantee: re-writing every editable field
// with its own current value must produce a file that evaluates to the exact
// same values — proving the scanner locates each literal correctly (including
// object props sandwiched between function-valued props, numeric/quoted keys,
// and the `[...].join` array fields) and the serializer preserves content.

import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  buildLibraryFields,
  applyEdits,
  fieldEdit,
  ID_SEP,
} from './promptLibraryEdit.mjs'

const LIB_URL = new URL('../../src/bot/brain/promptLibrary.js', import.meta.url)
const LIB_PATH = fileURLToPath(LIB_URL)

async function importSource (src) {
  // Evaluate edited source without touching disk. promptLibrary imports nothing,
  // so a data: URL module loads fine.
  return import('data:text/javascript,' + encodeURIComponent(src))
}

const mod = await import(LIB_URL.href)
const src = await readFile(LIB_PATH, 'utf8')
const fields = buildLibraryFields(mod)

describe('buildLibraryFields', () => {
  it('surfaces the three surface baselines and the expander instruction', () => {
    const ids = fields.map((f) => f.id)
    expect(ids).toContain('UNIVERSAL_BASELINE')
    expect(ids).toContain('CHAT_BASELINE')
    expect(ids).toContain('MINECRAFT_BASELINE')
    expect(ids).toContain('EXPANSION_SYSTEM')
  })

  it('expands object exports into per-prop fields', () => {
    expect(fields.find((f) => f.id === 'ACTION_DESCRIPTIONS' + ID_SEP + 'dig')).toBeTruthy()
    expect(fields.find((f) => f.id === 'PERSONALITY_TOOL_DESCRIPTIONS' + ID_SEP + 'say')).toBeTruthy()
    // numeric-keyed object
    expect(fields.find((f) => f.id === 'PROACTIVENESS_DIRECTIVES' + ID_SEP + '2')).toBeTruthy()
  })

  it('skips function-valued props (only string entries are editable)', () => {
    const nudgeIds = fields.filter((f) => f.id.startsWith('NUDGES' + ID_SEP)).map((f) => f.id)
    expect(nudgeIds).toContain('NUDGES' + ID_SEP + 'silence')
    expect(nudgeIds).toContain('NUDGES' + ID_SEP + 'capClose')
    expect(nudgeIds).not.toContain('NUDGES' + ID_SEP + 'actionTurn') // function
    const evIds = fields.filter((f) => f.id.startsWith('EVENT_GUIDANCE' + ID_SEP)).map((f) => f.id)
    expect(evIds).toContain('EVENT_GUIDANCE' + ID_SEP + 'sei:loop_end')
    expect(evIds).not.toContain('EVENT_GUIDANCE' + ID_SEP + 'sei:idle') // function
  })

  it('values match the live module exactly', () => {
    for (const f of fields) {
      if (f.id.includes(ID_SEP)) {
        const [name, key] = f.id.split(ID_SEP)
        expect(f.value).toBe(mod[name][key])
      } else {
        expect(f.value).toBe(mod[f.id])
      }
    }
  })
})

describe('idempotent round-trip', () => {
  it('rewriting every field with its current value yields an identical-valued module', async () => {
    const edits = fields.map((f) => ({ id: f.id, value: f.value }))
    const next = applyEdits(src, edits)
    const reMod = await importSource(next)
    for (const f of fields) {
      if (f.id.includes(ID_SEP)) {
        const [name, key] = f.id.split(ID_SEP)
        expect(reMod[name][key]).toBe(f.value)
      } else {
        expect(reMod[f.id]).toBe(f.value)
      }
    }
    // Functions and non-edited structure survive.
    expect(typeof reMod.NUDGES.actionTurn).toBe('function')
    expect(typeof reMod.EVENT_GUIDANCE['sei:idle']).toBe('function')
    expect(typeof reMod.renderHeartbeat).toBe('function')
    // BASELINE_INSTRUCTIONS still composes universal + minecraft.
    expect(reMod.BASELINE_INSTRUCTIONS).toBe(mod.BASELINE_INSTRUCTIONS)
  })
})

describe('editing fields', () => {
  it('writes new values, incl. tricky chars (backtick, ${}, newlines), without corrupting neighbors', async () => {
    const tricky = 'edited line one\nwith a `backtick` and ${notInterpolated} and a \\backslash'
    const edits = [
      { id: 'UNIVERSAL_BASELINE', value: tricky },
      { id: 'ACTION_DESCRIPTIONS' + ID_SEP + 'dig', value: 'dig something `now`' },
      { id: 'PROACTIVENESS_DIRECTIVES' + ID_SEP + '0', value: 'passive: do nothing ${ever}' },
      { id: 'EXPANSION_SYSTEM', value: 'line A\n\nline C' }, // array field, incl. blank line
      { id: 'EVENT_GUIDANCE' + ID_SEP + 'sei:loop_end', value: 'LOOP END rewritten' },
    ]
    const next = applyEdits(src, edits)
    const reMod = await importSource(next)
    expect(reMod.UNIVERSAL_BASELINE).toBe(tricky)
    expect(reMod.ACTION_DESCRIPTIONS.dig).toBe('dig something `now`')
    expect(reMod.PROACTIVENESS_DIRECTIVES[0]).toBe('passive: do nothing ${ever}')
    expect(reMod.EXPANSION_SYSTEM).toBe('line A\n\nline C')
    expect(reMod.EVENT_GUIDANCE['sei:loop_end']).toBe('LOOP END rewritten')
    // Untouched neighbors and functions intact.
    expect(reMod.ACTION_DESCRIPTIONS.gather).toBe(mod.ACTION_DESCRIPTIONS.gather)
    expect(reMod.PROACTIVENESS_DIRECTIVES[2]).toBe(mod.PROACTIVENESS_DIRECTIVES[2])
    expect(typeof reMod.EVENT_GUIDANCE['sei:idle']).toBe('function')
    // The edited UNIVERSAL_BASELINE flows into the composed baseline.
    expect(reMod.BASELINE_INSTRUCTIONS.startsWith(tricky)).toBe(true)
  })

  it('a no-op edit set leaves the source byte-identical for unchanged fields', () => {
    const one = fieldEdit(src, 'CHAT_BASELINE', mod.CHAT_BASELINE)
    const rebuilt = src.slice(0, one.start) + one.text + src.slice(one.end)
    // Re-importing proves value identity even if quoting style changed.
    return importSource(rebuilt).then((m) => expect(m.CHAT_BASELINE).toBe(mod.CHAT_BASELINE))
  })

  it('throws a clear error for an unknown field id', () => {
    expect(() => fieldEdit(src, 'NOT_A_FIELD', 'x')).toThrow(/export not found/)
    expect(() => fieldEdit(src, 'NUDGES' + ID_SEP + 'nope', 'x')).toThrow(/prop not found/)
  })
})
