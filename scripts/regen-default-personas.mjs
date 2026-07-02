// One-off: re-run persona expansion on the three bundled default characters
// using the SAME prompt + model + user-message builder as the real GUI
// (src/main/characterStore.ts -> expandPersona). BYOK path, dev test key.
//
// Stages results to /tmp first; only writes back into the resources JSON when
// all three succeed and validate (expandPersona throws on missing sections).
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expandPersona, EXPANSION_MODEL } from '../src/main/personaExpansion.ts'

const apiKey = readFileSync(join(homedir(), '.sei-dev', 'anthropic-test-key'), 'utf8').trim()
const SLUGS = ['sui', 'clawd', 'lyra']
const dir = 'resources/default-characters'

console.log(`model: ${EXPANSION_MODEL}\n`)

const staged = []
for (const slug of SLUGS) {
  const path = join(dir, `${slug}.json`)
  const char = JSON.parse(readFileSync(path, 'utf8'))
  const name = char.name
  const source = char.persona?.source ?? ''
  const priorExpanded = char.persona?.expanded || undefined
  const raw = char.metadata?.proactiveness
  const proactiveness = Number.isInteger(raw) ? Math.min(Math.max(0, raw), 2) : 1

  process.stdout.write(`[${slug}] ${name} (proactiveness=${proactiveness}, prior=${priorExpanded?.length ?? 0}b) … `)
  let lastSection = ''
  const { expanded } = await expandPersona({
    name,
    source,
    proactiveness,
    priorExpanded,
    apiKey,
    onProgress: (p) => {
      if (p.section !== lastSection) { lastSection = p.section; process.stdout.write(`${p.section} `) }
    },
  })
  console.log(`\n   -> ${expanded.length}b`)
  const tmp = join('/tmp', `persona-${slug}.md`)
  writeFileSync(tmp, expanded)
  staged.push({ slug, path, char, expanded, tmp })
}

console.log('\nAll three expanded + validated. Writing back into resources JSON…')
for (const s of staged) {
  s.char.persona.expanded = s.expanded
  writeFileSync(s.path, JSON.stringify(s.char, null, 2) + '\n')
  console.log(`  wrote ${s.path}`)
}
console.log(`\nPreviews staged at /tmp/persona-{${SLUGS.join(',')}}.md`)
