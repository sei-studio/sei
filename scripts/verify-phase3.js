#!/usr/bin/env node
/**
 * Phase 3 aggregate verification harness.
 *
 * Spawns each sub-harness case in a child process and prints a summary
 * table. Exits 0 if all cases pass, 1 otherwise.
 *
 * Mirrors scripts/verify-phase2.js but is structural-only (no --live).
 */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

const LOOP_CASES = [
  'tool-pairing',
  'seed-content',
  'name-field-stripped',
  'mutation-free',
  'interrupt',
  'cap-graceful',
  'combined-path',
  'single-flight',
  'idle-gated',
  'per-loop-byte-warn',
]

const MEMORY_CASES = [
  // Plan 3-02 — atomicWrite + ownerStore + diary
  'atomic-write',
  'fresh-install',
  'owner-roundtrip',
  'owner-tolerates-malformed',
  'owner-seed-block',
  'diary-lazy-create',
  'diary-newest-first',
  'diary-byte-budget',
  'diary-heading-format',
  'diary-replace-older-half',
  // Plan 3-02 — sessionState + bot.js wiring
  'owner-uuid-cold',
  'owner-uuid-warm',
  'username-change-recognition',
  'owner-uuid-fallback',
  'spawn-settle-delay',
  'per-loop-batch-counter',
  // Plan 3-02 — seed-loader in orchestrator
  'seed-content-shape',
  'seed-content-fresh-install',
  'seed-budget-respected',
  'seed-permanent-across-iterations',
  'seed-not-in-system-blocks',
  // Plan 3-03 — compactor unit
  'summarize-prompt-shape',
  'summarize-output-parses',
  'summarize-writes-diary',
  'summarize-rate-limited',
  'consolidate-prompt-shape',
  'consolidate-min-entries',
  'consolidate-split-50pct',
  'compaction-uses-cached-system-blocks',
  'compaction-has-timeout',
  // Plan 3-03 — sessionState integration
  'd51-loop-count-trigger',
  'd51-bytes-trigger',
  'd51-trigger-survives-failure',
  'd53-session-trigger',
  'd53-size-trigger',
  'd53-async-non-blocking',
  'a7-no-idle-write',
  'session-end-flush',
]

const HARNESSES = [
  { script: join(__dirname, 'verify-phase3-loop.js'),   cases: LOOP_CASES },
  { script: join(__dirname, 'verify-phase3-memory.js'), cases: MEMORY_CASES },
]

function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length) }

function runOne(script, name) {
  const t0 = Date.now()
  const res = spawnSync('node', [script, `--case=${name}`], { encoding: 'utf8' })
  const ms = Date.now() - t0
  const ok = res.status === 0
  return { ok, ms, stdout: res.stdout ?? '', stderr: res.stderr ?? '', status: res.status }
}

const results = []
let totalFail = 0

for (const h of HARNESSES) {
  for (const c of h.cases) {
    const r = runOne(h.script, c)
    results.push({ harness: h.script.split('/').pop(), name: c, ...r })
    if (!r.ok) totalFail++
    process.stdout.write(`${r.ok ? 'OK  ' : 'FAIL'} ${pad(c, 40)} ${r.ms}ms\n`)
    if (!r.ok) {
      // Print failure detail immediately for triage
      if (r.stderr) process.stderr.write('  stderr: ' + r.stderr.split('\n').slice(0, 5).join('\n  ') + '\n')
      if (r.stdout) process.stderr.write('  stdout: ' + r.stdout.split('\n').slice(0, 5).join('\n  ') + '\n')
    }
  }
}

console.log('\n────────────────────────────────────────')
console.log(`Phase 3 verification: ${results.length - totalFail}/${results.length} passed`)
if (totalFail > 0) {
  console.log('\nFailed cases:')
  for (const r of results.filter(x => !x.ok)) {
    console.log(`  - [${r.harness}] ${r.name} (exit=${r.status})`)
  }
  process.exit(1)
}
console.log('All cases passed.')
process.exit(0)
