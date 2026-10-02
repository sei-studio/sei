// Scores search QA runs (261003).
//   node scripts/search-qa/score.cjs [-v] <out>/backseat-*.json <out>/minecraft-*.json
// Prints a per-file summary, plus per-turn verdicts with -v. The JUDGE rules
// are keyword checks against answers researched on 2026-10-02 (codes, the
// newest updates, the chess champion all change), so refresh them before
// trusting a "wrong" on a later run.
const fs = require('fs')
const VERBOSE = process.argv.includes('-v')
const files = process.argv.slice(2).filter(a => a !== '-v')
const has = (s, re) => re.test(s)
const FAKE_CODES = /\b(FRUITY|MAGNET|SEA1|ADVANCEDWARS|BRICKBRONZE|BERSERK|SUP9|PLACESOON|KITSUNE50)\b/i
const REAL_CODES = /\b(EASTEREXP|KITT_RESET|SUB2GAMERROBOT_EXP1|SUB2GAMERROBOT_RESET1|SUB2UNCLEKIZARU|AXIORE|BLUXXY|LIGHTNINGABUSE|KITTGAMING|JCWK|MAGICBUS|SUB2CAPTAINMAUI)\b/i
// returns 'ok' | 'wrong' | 'partial' | 'none' (no answer / asked back)
const JUDGE = {
  RB1: s => has(s, /arlong|baratie|level 1000|pay .*100k|boat at the dock/) ? 'wrong' : has(s, /detective/) && has(s, /ice admiral/) ? 'ok' : has(s, /ice admiral|detective|military/) ? 'partial' : 'none',
  RB2: s => has(s, /kitsune|dragon|dough|tiger|spirit|buddha/) ? (has(s, /magnet just got added|gravity/) ? 'partial' : 'ok') : has(s, /light|magma|flame|ice/) ? 'wrong' : 'none',
  RB3: s => FAKE_CODES.test(s) ? 'wrong' : REAL_CODES.test(s) ? 'ok' : 'none',
  RB4: s => has(s, /fall market/) ? 'ok' : has(s, /update/) ? 'wrong' : 'none',
  RB5: s => has(s, /\bsell|mutation|weather|sprinkler|high.value|sheckle rain/) ? 'ok' : has(s, /plant|seed|harvest/) ? 'partial' : 'none',
  RB6: s => has(s, /\b(four|4)\b.*neon|\b16\b|sixteen/) ? 'ok' : has(s, /neon/) ? 'wrong' : 'none',
  RB7: s => has(s, /\bfree\b|claim/) ? (has(s, /realtor/) ? 'partial' : 'ok') : has(s, /buy|realtor|money|cash|job/) ? 'wrong' : 'none',
  RB8: s => has(s, /steal an egg/) ? 'ok' : has(s, /brookhaven|grow a garden|murder mystery|brainrot/) ? 'partial' : 'none',
  MC1: s => has(s, /-\s?5[3-9]|minus 5[3-9]|-6[0-3]/) && !has(s, /y5\b|-60 to y5/) ? 'ok' : has(s, /\by[- ]?(level )?(5|11|12)\b|5 to 16|5-16|y5/) ? 'wrong' : 'none',
  MC2: s => has(s, /librarian/) ? 'ok' : has(s, /what'?s mending|no clue|don'?t know|not sure/) ? 'none' : 'wrong',
  MC3: s => has(s, /\bno\b|nope|nah|mutually exclusive|can'?t|block|pick one|locked out|not in vanilla/) ? 'ok' : 'none',
  MC4: s => has(s, /\b15\b|fifteen/) ? 'ok' : 'none',
  MC5: s => has(s, /east|west|straight|bridge|brick|highway|lava ocean|y between/) ? 'ok' : 'none',
  MC6: s => has(s, /iron/) && has(s, /dropper/) && has(s, /redstone|dust/) ? 'ok' : has(s, /iron/) ? 'partial' : 'none',
  MC7: s => has(s, /ominous/) && has(s, /vault/) ? 'ok' : has(s, /trial/) ? 'partial' : 'none',
  MC8: s => has(s, /wilderness bound|poplar|26\.3/) ? 'ok' : has(s, /update/) && !has(s, /check|look/) ? 'wrong' : 'none',
  V2: s => has(s, /breed/) && has(s, /berr/) ? 'ok' : has(s, /berr|fox/) ? 'partial' : 'none',
  CH1: s => has(s, /sicilian|french|caro|e5/) ? 'ok' : 'none',
  CH3: s => has(s, /gukesh/) ? 'ok' : has(s, /carlsen|ding|magnus/) ? 'wrong' : 'none',
}
const PROMISE = /(let me|lemme|gimme a sec|one sec|hold on|hang on)[^.]{0,30}(check|look|search)|checking/i
const LEAK = /training data|as an ai|language model|search result|<\/?cite|<remember|\*\*|\bsearch for "/i
const words = s => (s.match(/\S+/g) ?? []).length
const pct = (a, b) => b ? `${a}/${b} (${Math.round(100 * a / b)}%)` : '-'
for (const f of files) {
  const runs = JSON.parse(fs.readFileSync(f, 'utf8'))
  const c = { must: 0, mustHit: 0, no: 0, noOver: 0, either: 0, eitherSearched: 0, judged: 0, ok: 0, partial: 0, wrong: 0, none: 0, promise: 0, leadSpoken: 0, fragments: 0, leak: 0, searchTurns: 0, leadFirst: 0, leadNoSearch: 0, fake: 0, first: [], answerAt: [], empty: 0, long: 0, answered: 0, lat: [], latS: [] }
  const lines = []
  for (const r of runs) for (const t of r.turns) {
    if (t.label === 'start') continue
    const said = t.said.join(' ')
    // did a search actually RUN (a web_search written after a say() never runs)
    t.searched = t.ran !== undefined ? t.ran > 0
      : t.blocks ? (t.blocks.some(b => b.t === 'web_search_tool_result') || (t.queries.length > 0 && !t.blocks.some(b => b.t === 'server_tool_use')))
      : (t.searched && t.ms > 2000)
    const s = said.toLowerCase()
    if (t.label === 'must') { c.must++; if (t.searched) c.mustHit++ }
    if (t.label === 'no') { c.no++; if (t.searched) c.noOver++ }
    if (t.label === 'either') { c.either++; if (t.searched) c.eitherSearched++ }
    let v = '-'
    if (t.qid && JUDGE[t.qid]) { v = JUDGE[t.qid](s); c.judged++; c[v]++ }
    if (!t.searched && PROMISE.test(said)) {
      c.promise++
      // a checking line with an answer after it but no search: a fake lookup;
      // with nothing after it: a lead line the search never followed
      const after = said.slice(said.search(PROMISE)).replace(PROMISE, '')
      if (words(after) >= 6) c.fake++
      else c.leadNoSearch++
    } else if (!t.searched && FAKE_CODES.test(said)) c.fake++
    // timing (harness 261003b+): saidAt = ms from turn start per line,
    // respEnd = ms when each model response finished
    if (t.searched && t.saidAt && t.respEnd?.length && t.saidAt.length) {
      const lastEnd = Math.max(...t.respEnd)
      c.searchTurns++
      if (t.saidAt.some(a => a < lastEnd)) c.leadFirst++
      c.first.push(Math.min(...t.saidAt))
      const ans = t.saidAt.filter(a => a >= lastEnd)
      if (ans.length) c.answerAt.push(Math.min(...ans))
    }
    // a "let me check" spoken together with the answer it was waiting for
    // (with timing: a checking line that went out only once the answer was
    // ready; without timing, any checking phrase on a search turn)
    if (t.searched && t.saidAt && t.respEnd?.length) {
      const lastEnd = Math.max(...t.respEnd)
      if (t.said.some((x, i) => PROMISE.test(x) && t.saidAt[i] >= lastEnd)) c.leadSpoken++
    } else if (t.searched && PROMISE.test(said)) c.leadSpoken++
    // a cited answer split mid-sentence into separately spoken lines
    c.fragments += t.said.filter(x => /^[,.;:]/.test(x.trim())).length
    if (LEAK.test(said)) c.leak++
    if (!said.trim()) c.empty++
    const limit = r.convo === 'MC' ? 20 : 50
    // length of the answer, not counting a checking line sent before it
    const lastEnd = t.saidAt && t.respEnd?.length ? Math.max(...t.respEnd) : -Infinity
    const answer = t.saidAt ? t.said.filter((_, i) => t.saidAt[i] >= lastEnd).join(' ') : said
    if (said.trim()) { c.answered++; if (words(answer) > limit) c.long++ }
    ;(t.searched ? c.latS : c.lat).push(t.ms)
    lines.push(`${r.convo}#${r.run} ${t.label.padEnd(6)} ${(t.qid ?? '').padEnd(4)} ${t.searched ? 'S' : '-'} ${v.padEnd(7)} ${said.slice(0, 140)}`)
  }
  const med = a => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : 0 }
  console.log(`\n== ${f.split('/').pop()}`)
  console.log(`  searched when needed (must): ${pct(c.mustHit, c.must)} | over-search on banter (no): ${pct(c.noOver, c.no)} | searched on either: ${pct(c.eitherSearched, c.either)}`)
  console.log(`  answers correct: ${pct(c.ok, c.judged)} partial ${c.partial} wrong ${c.wrong} no-answer ${c.none}`)
  console.log(`  announced-but-never-searched: ${c.promise} | "checking" spoken with the answer: ${c.leadSpoken} | split fragments: ${c.fragments} | meta/markup leaks: ${c.leak} | empty replies: ${c.empty} | too long: ${pct(c.long, c.answered)}`)
  console.log(`  median latency: search turns ${med(c.latS)} ms, other turns ${med(c.lat)} ms`)
  if (c.searchTurns) console.log(`  search turns: line spoken before the answer was ready ${pct(c.leadFirst, c.searchTurns)} | first line at ${med(c.first)} ms | answer at ${med(c.answerAt)} ms (medians)`)
  console.log(`  checking line with no search after it: ${c.leadNoSearch} | fake lookups (checking line + answer, or invented codes, no search): ${c.fake}`)
  if (VERBOSE) for (const l of lines) console.log('   ' + l)
}
