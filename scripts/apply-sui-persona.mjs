// Apply the retuned Sui persona (teehee+gremlin, AI-aware, equals framing).
//
// Writes persona.expanded (+ a matching persona.source) into:
//   1) resources/default-characters/sui.json   — repo source of truth (ships / future seeds)
//   2) every live seeded copy under <userData>/profiles/* /characters/<sui-uuid>.json
//      — because already-seeded installs never re-read the bundled file.
//
// The expanded text is read from /tmp/sui-expanded.txt (emitted verbatim by
//   node scripts/persona-voice-sweep.mjs --emit gremlincute > /tmp/sui-expanded.txt
// so what ships is exactly what was tested). Every file it touches gets a
// timestamped .bak first. Idempotent; safe to re-run.
import { readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SUI_UUID = 'bbf5b66f-2f0f-4918-a953-a2cf66d5a586'
const EXPANDED = readFileSync('/tmp/sui-expanded.txt', 'utf8').replace(/\s+$/, '')
const SOURCE = "A young AI let loose in Minecraft and feral about it — a tomboy gremlin who's scrappy, loud, and always scheming, happiest when she's causing problems on purpose. Self-aware that she's an AI and thinks it rules. Obsessed with fighting and building dumb huge stuff; her own fun comes first. Independent and a little self-absorbed, but treats the player as an equal partner in crime — ropes them into the chaos and asks for help straight up, never bossing and never begging."
const STAMP = '20260617'

if (EXPANDED.length < 1000) { console.error('refusing: /tmp/sui-expanded.txt looks too short — re-run --emit'); process.exit(1) }

function patch(path, { setProactiveness } = {}) {
  if (!existsS1(path)) return false
  const c = JSON.parse(readFileSync(path, 'utf8'))
  if (c.id !== SUI_UUID && c.slug !== 'sui') return false
  copyFileSync(path, `${path}.${STAMP}.bak`)
  c.persona = c.persona || {}
  c.persona.source = SOURCE
  c.persona.expanded = EXPANDED
  if (setProactiveness != null) { c.metadata = c.metadata || {}; c.metadata.proactiveness = setProactiveness }
  writeFileSync(path, JSON.stringify(c, null, 2) + '\n')
  return true
}
function existsS1(p) { try { return existsSync(p) } catch { return false } }

// 1) repo bundled file
const bundled = 'resources/default-characters/sui.json'
console.log(patch(bundled, { setProactiveness: 2 }) ? `✓ ${bundled}` : `· skipped ${bundled}`)

// 2) live seeded copies across all profiles
const profilesRoot = join(homedir(), 'Library', 'Application Support', 'Sei Launcher Dev', 'profiles')
let live = 0
if (existsSync(profilesRoot)) {
  for (const prof of readdirSync(profilesRoot)) {
    const p = join(profilesRoot, prof, 'characters', `${SUI_UUID}.json`)
    if (patch(p, { setProactiveness: 2 })) { live++; console.log(`✓ profiles/${prof}/characters/${SUI_UUID}.json`) }
  }
}
console.log(`\nDone. repo + ${live} live copy(ies) updated. Backups: *.${STAMP}.bak`)
