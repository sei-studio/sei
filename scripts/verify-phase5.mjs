#!/usr/bin/env node
// Phase 5 end-to-end verification harness.
//
// Exercises src/bot/brain/log.js (multi-line emit + hash-elision) and the
// src/main/logRouter.ts contract (multi-line state machine + truncation
// recovery) without booting Electron, Minecraft, or hitting Anthropic.
//
// log.js is exercised directly via ESM dynamic import + console.log capture.
// logRouter.ts is exercised via (1) a source-text fingerprint check and
// (2) an in-script JS port of the state machine (`simulateRouter`).

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')

const results = []
function pass(label) { results.push(`OK: ${label}`) }
function fail(label, details) {
  process.stderr.write(`FAIL: ${label}\n${details ?? ''}\n`)
  process.exit(1)
}
function assert(cond, label, details) {
  if (!cond) fail(label, details)
  else pass(label)
}

// ─── Block A — log.js multi-line sentinel shape ─────────────────────────
const logMod = await import('../src/bot/brain/log.js')
const { logChatOut, logHeal, logActionResult, logHaikuQuery } = logMod

const captured = []
const origLog = console.log
console.log = (...args) => { captured.push(args.join(' ')) }
try {
  logChatOut('hello there')
  logHeal({ pos: '1,2,3', vel: '0,0,0', yaw: 0, pitch: 0 })
  logActionResult('dig', { ok: true, block: 'oak_log' })
} finally {
  console.log = origLog
}

assert(
  captured.length === 4,
  'Block A: captured length is 4 (1 dict-init header + 3 event blocks)',
  `actual length=${captured.length}; entries=\n${captured.map((c,i)=>`[${i}] ${c.slice(0,200)}`).join('\n')}`
)

assert(
  /cache-prefix dictionary initialized/.test(captured[0]) && !/begin|end/.test(captured[0]),
  'Block A: first captured line is the cache-prefix dictionary initialized header (single line, no begin/end)',
  `captured[0]=${captured[0]}`
)

const SENTINEL_LINE_RE = /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] \[[^\]]+\] (begin|end)$/m

for (let i = 1; i <= 3; i++) {
  const block = captured[i]
  const beginMatches = block.match(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] \[[^\]]+\] begin$/gm) ?? []
  const endMatches = block.match(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] \[[^\]]+\] end$/gm) ?? []
  assert(
    beginMatches.length === 1 && endMatches.length === 1,
    `Block A: captured[${i}] has exactly 1 begin and 1 end sentinel`,
    `begins=${beginMatches.length} ends=${endMatches.length} block=\n${block}`
  )
  const beginTs = beginMatches[0].slice(0, 14)  // "[HH:MM:SS.mmm]"
  const endTs = endMatches[0].slice(0, 14)
  assert(
    beginTs === endTs,
    `Block A: captured[${i}] begin and end share one timestamp`,
    `beginTs=${beginTs} endTs=${endTs}`
  )
  // The middle of the block must include at least one 2-space continuation line.
  const lines = block.split('\n')
  const middle = lines.slice(1, -1)
  assert(
    middle.some(l => /^  \S/.test(l)),
    `Block A: captured[${i}] has at least one 2-space-indented continuation line`,
    `middle=\n${middle.join('\n')}`
  )
}

// ─── Block B — log.js cache-prefix elision (D-4..D-8) ───────────────────
const systemBlocks = [
  { type: 'text', text: 'SYS-INSTRUCTIONS' },
  { type: 'text', text: 'PERSONA-BODY-XYZ' },
  { type: 'text', text: 'CAPABILITY-BODY-ABC' },
  { type: 'text', text: 'PRIMER' },
  { type: 'text', text: 'TOOLS' },
]
const namedUserBlocksFirst = [
  { role: 'user', content: [
    { type: 'text', name: 'seed_owner', text: 'OWNER-INFO-1' },
    { type: 'text', name: 'seed_diary', text: 'DIARY-BODY-V1' },
    { type: 'text', name: 'event',      text: 'event1' },
    { type: 'text', name: 'snapshot',   text: 'pos=1,64,1 hp=20' },
  ]},
]
const namedUserBlocksSecond = JSON.parse(JSON.stringify(namedUserBlocksFirst))
const namedUserBlocksAfterCompaction = JSON.parse(JSON.stringify(namedUserBlocksFirst))
namedUserBlocksAfterCompaction[0].content.find(b => b.name === 'seed_diary').text = 'DIARY-BODY-V2-AFTER-COMPACTION'

function captureHaiku(namedUserBlocks) {
  const buf = []
  const orig = console.log
  console.log = (...args) => { buf.push(args.join(' ')) }
  try {
    logHaikuQuery({
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ name: 'say' }],
      systemBlocks,
      namedUserBlocks,
    })
  } finally {
    console.log = orig
  }
  // After the first emit of the process, no more headers — captureHaiku always
  // returns the haiku block as the last captured entry.
  return buf[buf.length - 1] ?? ''
}

const HASH_RE = (name) => new RegExp(`<${name} @sha=([0-9a-f]{8})>`)

// Call 1 — first appearance, bodies print in FULL plus a ref line.
const block1 = captureHaiku(namedUserBlocksFirst)
assert(block1.includes('PERSONA-BODY-XYZ'), 'Block B/call1: persona body printed in full', block1)
const personaH1 = block1.match(HASH_RE('persona'))
assert(personaH1, 'Block B/call1: persona @sha hash ref present', block1)

assert(block1.includes('CAPABILITY-BODY-ABC'), 'Block B/call1: capability body printed in full', block1)
const capabilityH1 = block1.match(HASH_RE('capability'))
assert(capabilityH1, 'Block B/call1: capability @sha hash ref present', block1)

assert(block1.includes('DIARY-BODY-V1'), 'Block B/call1: diary body printed in full', block1)
const diaryH1 = block1.match(HASH_RE('diary'))
assert(diaryH1, 'Block B/call1: diary @sha hash ref present', block1)

assert(/event:\s*event1/.test(block1), 'Block B/call1: event: section inlined with literal text', block1)
assert(/snapshot:\s*pos=1,64,1 hp=20/.test(block1), 'Block B/call1: snapshot: section inlined with literal text', block1)

// Call 2 — unchanged blocks. Bodies elided, same hash refs.
const block2 = captureHaiku(namedUserBlocksSecond)
assert(!block2.includes('PERSONA-BODY-XYZ'), 'Block B/call2: persona body elided', block2)
assert(!block2.includes('CAPABILITY-BODY-ABC'), 'Block B/call2: capability body elided', block2)
assert(!block2.includes('DIARY-BODY-V1'), 'Block B/call2: diary body elided', block2)

const personaH2 = block2.match(HASH_RE('persona'))
const capabilityH2 = block2.match(HASH_RE('capability'))
const diaryH2 = block2.match(HASH_RE('diary'))
assert(personaH2 && personaH2[1] === personaH1[1], 'Block B/call2: persona hash ref unchanged', `was=${personaH1[1]} now=${personaH2?.[1]}`)
assert(capabilityH2 && capabilityH2[1] === capabilityH1[1], 'Block B/call2: capability hash ref unchanged', `was=${capabilityH1[1]} now=${capabilityH2?.[1]}`)
assert(diaryH2 && diaryH2[1] === diaryH1[1], 'Block B/call2: diary hash ref unchanged', `was=${diaryH1[1]} now=${diaryH2?.[1]}`)
assert(/event:\s*event1/.test(block2), 'Block B/call2: event: section still inlined', block2)
assert(/snapshot:\s*pos=1,64,1 hp=20/.test(block2), 'Block B/call2: snapshot: section still inlined', block2)

// Call 3 — only diary changed (compaction simulated). Persona/capability stay
// elided; diary prints in FULL with a NEW hash.
const block3 = captureHaiku(namedUserBlocksAfterCompaction)
assert(!block3.includes('PERSONA-BODY-XYZ'), 'Block B/call3: persona still elided after diary-only change', block3)
assert(!block3.includes('CAPABILITY-BODY-ABC'), 'Block B/call3: capability still elided after diary-only change', block3)
assert(block3.includes('DIARY-BODY-V2-AFTER-COMPACTION'), 'Block B/call3: new diary body printed in full', block3)
const personaH3 = block3.match(HASH_RE('persona'))
const capabilityH3 = block3.match(HASH_RE('capability'))
const diaryH3 = block3.match(HASH_RE('diary'))
assert(personaH3 && personaH3[1] === personaH1[1], 'Block B/call3: persona hash ref unchanged from call 1', `was=${personaH1[1]} now=${personaH3?.[1]}`)
assert(capabilityH3 && capabilityH3[1] === capabilityH1[1], 'Block B/call3: capability hash ref unchanged from call 1', `was=${capabilityH1[1]} now=${capabilityH3?.[1]}`)
assert(diaryH3 && diaryH3[1] !== diaryH1[1], 'Block B/call3: diary hash ref DIFFERS from call 1 (new content)', `was=${diaryH1[1]} now=${diaryH3?.[1]}`)

// ─── Block C — logRouter.ts source-text fingerprint ─────────────────────
const routerSrc = await readFile(resolve(REPO_ROOT, 'src/main/logRouter.ts'), 'utf8')
assert(routerSrc.includes('SENTINEL_RE'), 'Block C: logRouter.ts contains SENTINEL_RE', null)
assert(routerSrc.includes("finalizeOpenEvent('truncated')"), 'Block C: logRouter.ts contains finalizeOpenEvent(\'truncated\')', null)
assert(routerSrc.includes("'  [truncated]'"), 'Block C: logRouter.ts contains the \'  [truncated]\' literal', null)
assert(routerSrc.includes('\\s+(begin|end)\\s*$'), 'Block C: logRouter.ts contains the begin|end regex fragment', null)

// ─── Block D — in-script simulation of the multi-line state machine ─────
// JS port of src/main/logRouter.ts's begin/end state machine. The router emits
// one entry per logical event, joining all physical lines (including the
// sentinels themselves) with '\n' into the entry message.
const SENTINEL_RE = /^\[\d{2}:\d{2}:\d{2}\.\d{3}\]\s+(\[[^\]]+\])\s+(begin|end)\s*$/
function simulateRouter(lines) {
  const entries = []
  let openTag = null
  let openLines = []
  function finalize(reason) {
    if (openTag === null) return
    if (reason === 'truncated') openLines.push('  [truncated]')
    entries.push({ tag: openTag, message: openLines.join('\n'), level: 'info' })
    openTag = null
    openLines = []
  }
  for (const raw of lines) {
    const cleaned = raw.replace(/\r?$/, '')
    if (!cleaned) continue
    const m = cleaned.match(SENTINEL_RE)
    if (m) {
      const tag = m[1]
      const suffix = m[2]
      if (suffix === 'begin') {
        if (openTag !== null) finalize('truncated')
        openTag = tag
        openLines = [cleaned]
        continue
      }
      // end
      if (openTag === tag) {
        openLines.push(cleaned)
        finalize('end')
        continue
      }
      // orphan end → single-line entry
      entries.push({ tag, message: cleaned, level: 'info' })
      continue
    }
    if (openTag !== null) {
      openLines.push(cleaned)
      continue
    }
    // single-line passthrough (no open event)
    const tagMatch = cleaned.match(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\]\s+(\[[^\]]+\])/)
    entries.push({ tag: tagMatch ? tagMatch[1] : null, message: cleaned, level: 'info' })
  }
  return entries
}

{
  const lines = [
    '[12:00:00.000] [haiku?] begin',
    '  tools: say, dig',
    '  user: <persona @sha=ab12abcd>',
    '         <capability @sha=cd34cd34>',
    '         snapshot: pos=0,0,0',
    '[12:00:00.000] [haiku?] end',
    '[12:00:01.000] [chat->] begin',
    '  text: hello world',
    '[12:00:01.000] [chat->] end',
  ]
  const entries = simulateRouter(lines)
  assert(entries.length === 2, 'Block D: simulateRouter yields 2 entries from a 2-event stream', `got ${entries.length}`)
  assert(entries[0].tag === '[haiku?]', 'Block D: entry 0 tag is [haiku?]', `got ${entries[0].tag}`)
  const expectedFirst = lines.slice(0, 6).join('\n')
  assert(entries[0].message === expectedFirst, 'Block D: entry 0 message contains all 6 original lines joined by \\n', `got:\n${entries[0].message}`)
  assert(entries[1].tag === '[chat->]', 'Block D: entry 1 tag is [chat->]', `got ${entries[1].tag}`)
  assert(entries[1].message.split('\n').length === 3, 'Block D: entry 1 message has exactly 3 lines', `got ${entries[1].message.split('\n').length}`)
}

// ─── Block E — truncation recovery ──────────────────────────────────────
{
  const truncatedLines = [
    '[12:00:00.000] [haiku?] begin',
    '  tools: say',
    '[12:00:00.500] [chat->] begin', // new begin before first end → truncate
    '  text: hi',
    '[12:00:00.500] [chat->] end',
  ]
  const entries2 = simulateRouter(truncatedLines)
  assert(entries2.length === 2, 'Block E: 2 entries from truncated stream', `got ${entries2.length}`)
  assert(entries2[0].tag === '[haiku?]', 'Block E: entry 0 tag is [haiku?]', `got ${entries2[0].tag}`)
  assert(entries2[0].message.endsWith('\n  [truncated]'), 'Block E: entry 0 message ends with \\n  [truncated]', `got:\n${entries2[0].message}`)
  assert(entries2[1].tag === '[chat->]', 'Block E: entry 1 tag is [chat->]', `got ${entries2[1].tag}`)
  assert(!entries2[1].message.includes('[truncated]'), 'Block E: entry 1 message does NOT contain [truncated]', `got:\n${entries2[1].message}`)
}

// ─── Tail ───────────────────────────────────────────────────────────────
for (const r of results) console.log(r)
console.log(`\nPhase 5 verification: PASS (${results.length} checks)`)
process.exit(0)
