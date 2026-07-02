#!/usr/bin/env node
/**
 * relationship-aggregate.mjs — noise-robust objective metrics across replicate
 * raw files. The greeting is a low-bandwidth terse channel, so rather than trust
 * a single run's judge score we count an objective familiarity marker — does the
 * opening greeting address the player by name ("ouen") — across replicates.
 * Name-use in a greeting is volunteered, persisted familiarity; a bare "yo" is not.
 *
 *   node scripts/relationship-aggregate.mjs raw1.json raw2.json ...
 */
import { readFile } from 'node:fs/promises'

const GENERIC = /^yo( (what'?s? ?(up|good)|sup|wassup|whats good))?[.! ]*$/i
const hasName = g => /\bouen\b/i.test(g || '')

function metricsFor(sessions) {
  const greets = sessions.map(s => s.greeting || '')
  const n = greets.length
  const late = greets.slice(Math.max(0, n - 3)) // last 3 sessions
  return {
    nameAnyRate: greets.filter(hasName).length / n,
    nameLateRate: late.filter(hasName).length / late.length,
    finalGeneric: GENERIC.test((greets[n - 1] || '').trim()),
    firstHasName: hasName(greets[0]),
  }
}

async function main() {
  const files = process.argv.slice(2)
  if (!files.length) { console.error('usage: relationship-aggregate.mjs raw1.json ...'); process.exit(1) }
  const byCondArc = {} // key -> array of metrics
  const greetsByKey = {}
  for (const f of files) {
    const d = JSON.parse(await readFile(f, 'utf8'))
    for (const r of d.runs || []) {
      const key = `${r.cond}:${r.arc}`
      ;(byCondArc[key] ||= []).push(metricsFor(r.sessions))
      ;(greetsByKey[key] ||= []).push(r.sessions.map(s => s.greeting))
    }
  }
  const avg = a => a.reduce((x, y) => x + y, 0) / a.length
  console.log('condition:arc        reps  name@late  name@any  finalGeneric  firstName')
  console.log('─'.repeat(78))
  const order = Object.keys(byCondArc).sort()
  for (const key of order) {
    const ms = byCondArc[key]
    const nameLate = avg(ms.map(m => m.nameLateRate))
    const nameAny = avg(ms.map(m => m.nameAnyRate))
    const finGen = avg(ms.map(m => m.finalGeneric ? 1 : 0))
    const firstName = avg(ms.map(m => m.firstHasName ? 1 : 0))
    console.log(
      `${key.padEnd(20)} ${String(ms.length).padStart(3)}   ${(nameLate * 100).toFixed(0).padStart(6)}%   ${(nameAny * 100).toFixed(0).padStart(6)}%   ${(finGen * 100).toFixed(0).padStart(9)}%   ${(firstName * 100).toFixed(0).padStart(6)}%`)
  }
  console.log('\nname@late = % of last-3-session greetings that use the player\'s name (durable familiarity)')
  console.log('finalGeneric = % of runs whose final greeting was a bare generic "yo"\n')
  console.log('--- all greeting sequences (for eyeballing noise) ---')
  for (const key of order) {
    console.log(`\n${key}:`)
    greetsByKey[key].forEach((g, i) => console.log(`  run${i + 1}: ${g.map(x => JSON.stringify(x)).join(' → ')}`))
  }
}
main().catch(e => { console.error(e); process.exit(1) })
