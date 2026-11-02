// One-off: latency/cost of OpenAI chooser candidates on a 5-option reflex question.
import { makeDecider, spent } from './deciders.mjs'
const q = { state: 'Health 8/20. Food 18/20. Holding stone_sword. Hostiles: zombie 2.1 blocks ahead, zombie 6.0 blocks left. Inventory: bread x3.', instructions: 'Which reflex action should the player take right now to survive?', options: { attack: 'attack the nearest zombie with the sword', flee: 'sprint away from the zombies', eat: 'eat bread', back: 'step back from the nearest zombie while facing it', none: 'do nothing' } }
for (const spec of process.argv.slice(2)) {
  const d = makeDecider(spec); const out = []
  for (let i = 0; i < 4; i++) { try { const r = await d.choose(q); out.push(`${r.choice}/${Math.round(r.ms)}ms/r${r.usage?.reasoning ?? 0}`) } catch (e) { out.push('ERR ' + e.message.slice(0, 120)); break } }
  console.log(spec.padEnd(28), out.join('  '))
}
console.log('openai spent', spent('openai').toFixed(5), 'anthropic spent', spent('anthropic').toFixed(5))
