/**
 * 261012: words and short phrases the companion keeps putting in its OWN
 * recent lines, so the next turn can be told about them.
 *
 * Why this exists: a persona whose sample lines carry a verbal tic (a sound at
 * the end of a line, a pet name for the player, a favorite topic) gets that tic
 * in nearly every line. Measured in the persona eval (Haiku 5.5): Lyra's card
 * has "nya" in three example lines and she said it in 40 of 40 lines, Roger
 * said "big brother" in 38 of 44. Over a session that reads as a parody.
 * General guidance in the prompt ("use it now and then") did not move it, and
 * neither did "your last line already used your catchphrase" at the tail. What
 * did move it was naming the actual word: 100% -> 39% on Lyra. So this module
 * finds the word from her own lines, the same move as backseat's
 * recentOpeners: data about what she said, never a fixed list of phrases.
 *
 * Nothing here touches what the model says. It only feeds a note into the
 * next turn's prompt; the model still decides.
 */

// A turn is the say() line of one model call. emitChatMessages splits it into
// several chat messages and records each with Date.now() in the same
// synchronous pass, so entries of one turn sit within a few ms of each other,
// while two turns are at least one model call (seconds) apart.
const TURN_GAP_MS = 250

// Function words, fillers and count words that every voice repeats. Kept to
// grammar on purpose: "lol" or "ok" opening every line is a habit worth naming too.
const STOP = new Set((
  'a an the and or but so to of in on at for with by from up down out off over into onto about as than then ' +
  'is are was were be been being am do does did done have has had having will would can could should shall may might must ' +
  "i i'm im i'll i've i'd me my mine you you're youre you'll you've your yours we we're us our it it's its " +
  "they they're them their he him his she her this that these those there here what who how why when where which " +
  "not no yes just too very really all some any more most much one two " +
  // Counts are information ("zero wood"), never a habit to drop.
  "zero none three four five six seven eight nine ten twenty few lot lots many enough another half " +
  "let let's get got go going gonna if like oh um uh"
).split(/\s+/))

function tokensOf(text) {
  return String(text ?? '').toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9'\s-]+/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^['-]+|['-]+$/g, ''))
    .filter(Boolean)
}

const isContent = (w) => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w)

/** Single content words plus two-word phrases with at least one content word. */
function termsOf(text) {
  const t = tokensOf(text)
  const out = new Set()
  t.forEach((w, i) => {
    if (isContent(w)) out.add(w)
    const n = t[i + 1]
    if (n && (isContent(w) || isContent(n)) && w.length > 1 && n.length > 1) out.add(`${w} ${n}`)
  })
  return out
}

// A word and its singular forms, so a plural matches ("logs" -> log,
// "torches" -> torch, "berries" -> berry) and its stem ("mining" -> mine).
// Over-stripping is harmless here: both sides go through the same keys, and
// a false match only drops a note.
// A possessive counts as its owner ("alex's" -> alex, "table's" -> table).
function wordKeys(w) {
  if (/.'s$/.test(w)) return [w, ...wordKeys(w.slice(0, -2))]
  const out = [w]
  for (const [re, rep] of [[/ies$/, 'y'], [/es$/, ''], [/s$/, ''], [/ing$/, ''], [/ing$/, 'e']]) {
    if (re.test(w) && !/ss$/.test(w)) { const k = w.replace(re, rep); if (k.length >= 3) out.push(k) }
  }
  return out
}
// Every spelling of a term with its words' keys, so "more logs" meets "more log".
const termKeys = (term) => term.split(' ').reduce(
  (acc, w) => acc.flatMap((a) => wordKeys(w).map((k) => (a ? `${a} ${k}` : k))), [''])

// 261013: the game's own nouns (items, blocks, mobs), from the adapter
// (gameVocabulary). Names like "oak_log" or "iron_ingot" count word by word,
// with plurals and stems, so "oak trees" or "iron ingots" read as the job
// even when none of it is in her inventory. Built once per list.
const _vocabCache = new WeakMap()
function vocabKeys(vocab) {
  if (!vocab || typeof vocab !== 'object') return null
  let keys = _vocabCache.get(vocab)
  if (keys) return keys
  keys = new Set()
  for (const n of vocab) for (const w of tokensOf(n)) if (w.length > 1) for (const k of wordKeys(w)) keys.add(k)
  _vocabCache.set(vocab, keys)
  return keys
}

// Words of the card's voice (its example lines and description). An opener
// from here is a signature, which the tic note owns (3 of 4 turns).
let _sigCache = { text: null, words: new Set() }
function signatureWords(text) {
  const t = typeof text === 'string' ? text : ''
  if (_sigCache.text !== t) _sigCache = { text: t, words: new Set(tokensOf(t)) }
  return _sigCache.words
}

/** Group self lines ({at, text}, oldest first) into turns. */
export function groupTurns(selfLines, gapMs = TURN_GAP_MS) {
  const turns = []
  let last = null
  for (const l of selfLines ?? []) {
    if (!l?.text) continue
    if (last && Number.isFinite(l.at) && Number.isFinite(last.at) && l.at - last.at <= gapMs) {
      turns[turns.length - 1].text += ` ${l.text}`
    } else {
      turns.push({ at: l.at, text: String(l.text) })
    }
    last = l
  }
  return turns
}

/**
 * Terms the companion used in at least `minTurns` of its last `window` turns.
 * Terms the player also used in their recent lines are left out: a shared
 * topic ("the villager", "wood") is the conversation, not a habit.
 *
 * People's names are left out too, along with any phrase that contains one:
 * the player's name (nobody types their own name, so it was the most named
 * term in the persona eval) and teammates' names, which is how a line in a
 * multi-companion session says who it is for. `names` takes the known ones;
 * every speaker in playerLines (`who`) is added automatically.
 *
 * So is any term with a word from `context` (the snapshot, the goals): an
 * item, block or task word. In the 261012 MC compare "stone", "pickaxe" and
 * "trees" were named more often than her actual tic, and a status line
 * without the item name loses what the player needs. Plurals match
 * ("logs" meets oak_log, "torches" meets torch), and `_` is a space.
 *
 * @param {Array<{at:number,text:string}>} selfLines   oldest first
 * @param {Array<{text:string,who?:string}>} [playerLines]  oldest first
 * @param {{names?: Array<string|null|undefined>, context?: Array<string|null|undefined>}} [opts]
 * @returns {Array<{term:string, count:number, of:number}>} at most `max`, most repeated first
 */
export function repeatedOwnTerms(selfLines, playerLines = [], { window = 4, minTurns = 3, max = 2, playerWindow = 8, names = [], context = [] } = {}) {
  const turns = groupTurns(selfLines).slice(-window)
  if (turns.length < minTurns) return []
  const heard = new Set()
  for (const l of (playerLines ?? []).slice(-playerWindow)) for (const t of termsOf(l?.text)) for (const k of termKeys(t)) heard.add(k)
  const known = new Set()
  for (const n of [...(names ?? []), ...(playerLines ?? []).map((l) => l?.who), ...(context ?? [])]) {
    for (const w of tokensOf(n)) if (w.length > 1) for (const k of wordKeys(w)) known.add(k)
  }
  const isNamed = (term) => term.split(' ').filter(isContent).some((w) => wordKeys(w).some((k) => known.has(k)))
  const counts = new Map()
  for (const turn of turns) for (const t of termsOf(turn.text)) counts.set(t, (counts.get(t) ?? 0) + 1)
  const hits = [...counts]
    .filter(([t, c]) => c >= minTurns && !termKeys(t).some((k) => heard.has(k)) && !isNamed(t))
    .map(([term, count]) => ({ term, count, of: turns.length }))
    // Most repeated first; among ties the phrase before the words inside it.
    .sort((a, b) => b.count - a.count || b.term.split(' ').length - a.term.split(' ').length)
  const out = []
  for (const h of hits) {
    // One term per habit: "big brother" covers "brother" when they tie, and
    // "nya" covers "alex nya" when the word alone is the more repeated one.
    const within = (a, b) => ` ${b} `.includes(` ${a} `)
    if (out.some((o) => o.count >= h.count && (within(h.term, o.term) || within(o.term, h.term)))) continue
    out.push(h)
    if (out.length >= max) break
  }
  return out
}

/** The tic half of the note (repeatedOwnTerms hits), or null when nothing repeats. */
function ticNote(hits) {
  if (!hits.length) return null
  const quoted = hits.map((h) => `"${h.term}"`).join(' and ')
  const n = hits[0].of
  return `Your own recent lines keep using ${quoted} (in ${hits[0].count} of your last ${n}). ` +
    'A signature word or catchphrase wears thin when it is in every line, so leave it out of this one unless the moment really calls for it. ' +
    'You still sound like yourself without it.'
}

// ---------------------------------------------------------------------------
// 261013: whole lines and bits, not only single words.
//
// In the scripted-conversation eval (261012 scorecard and the pass-5 and
// persona-tics compares) "repetitive" was the largest share of off lines, and
// almost none of it was a one-word tic. It was:
//   - the last line again: a comeback, callback or offer from her previous
//     turn reused word for word in the next one ("you owe me a snack" in two
//     replies running, "i got an iron sword and zero wood" twice in a row);
//   - a bit she keeps coming back to across a few turns ("you're the boss of
//     the wood pile" three times in 45 s, "you owe me a cobble trip" three
//     times, "stay close, we grab wood next" four times).
// Every one of those lines was in her prompt, in the conversation block,
// marked as hers, under a header and a reply tail that both say not to repeat
// them. The rule alone did not hold, the same way "use your catchphrase now
// and then" did not hold for tics; what moved tics was naming the word. So
// this names the lines: her last turn or two, quoted, and any phrase two of
// her recent turns share. Data about what she said, never a fixed list, and
// nothing she says is ever edited.

// Her last turns are quoted only while they are fresh. An hour-old line is
// not the thing she is about to repeat.
const LAST_LINES_TURNS = 2
// 261021 (pass 21): a reply turn quotes her last four. With two, the comeback
// she reused was one turn too old to be in the quote: "nehehe rude." to
// "lmao thats so bad", two plain lines, then "rude. i'm a rock with a sword"
// to "ur dumb as a rock" (t160 night_social). Probe case rude, 8 runs each
// (pass21-probe, 10-21): 1 of 8 replies free of it on dev with two quoted,
// 7 of 8 with four. A second four-turn run with an extra note on top got 5 of
// 8. Idle seeds still get no quote (pass 6a), and the other turn kinds keep
// two.
const REPLY_LINES_TURNS = 4
const LAST_LINES_WITHIN_MS = 120_000
// A shared phrase is looked for in this many recent turns, inside this time.
const PHRASE_TURNS = 8
const PHRASE_WITHIN_MS = 300_000
const MAX_PHRASES = 2
const MAX_QUOTE_CHARS = 160
// Words that only carry the job or its timing. A phrase whose own wording is
// just these ("need stone", "pickaxe next", "mining stone now") is the task
// she is on, which a status line has to name, not a bit.
// 261017 (pass 13): plus the walking words ("heading to the oak trees",
// "coming back with the logs"), which the looser test below would otherwise
// call hers.
const TASK_GLUE = new Set((
  'next now need needs want wanna first again still more soon later ready ' +
  'make made get grab dig mine craft find build gather punch chop collect place put use try start pick ' +
  'head walk coming back'
).split(' '))
// 261017 (pass 13): count words. STOP keeps them from ever being a tic on
// their own, but inside a phrase they are part of the bit: "nine blocks
// away" three replies running, "still zero wood tho" four times in a scripted
// night (pass 12 compare). They count as words of the phrase, never as her
// own wording, so "zero wood" or "four logs" alone (the status) is not named.
const COUNT_WORDS = new Set('zero two three four five six seven eight nine ten twenty'.split(' '))
// 261017 (pass 13 review): words that are never her own wording either:
// fillers, where something is, and the follow and stop acks. With one own
// word enough, "nine blocks north" (to "where's the cave again"), "three logs
// so far", "no wood yet" and "following you now" all passed on a "far", "yet"
// or "following", and those are facts and answers, not bits.
const PLAIN_WORDS = new Set((
  'tho though lol lmao yet so far ok okay kinda yeah yep nah fine actually ' +
  'block blocks away north south east west left right behind ahead close near nearby over there ' +
  'follow following followed stop stopping stopped hold holding still stay staying put wait waiting here'
).split(' '))
// A phrase made only of job words, counts and the words above is a fact. It
// counts as a bit only with a count in it, said in this many turns, and not
// when the player's line is a question: "still zero wood tho" four times in
// one night, "nine blocks away" three replies running.
const FACT_BIT_TURNS = 3
// The player's line asks something ("where's the cave again", "hows it
// going", "u got wood?"). Chat questions often have no question mark.
const QUESTION_RE = /\?\s*$|^(where|what|how|why|when|which|who|whats|wheres|hows|is|are|do|does|did|can|could|got|u got|you got|any)\b/i
const isQuestion = (text) => QUESTION_RE.test(String(text ?? '').trim().replace(/[‘’]/g, "'").replace(/'/g, ''))

const clip = (s, n = MAX_QUOTE_CHARS) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 3).trimEnd()}...` : t
}

/**
 * Her last `turns` turns, oldest first, when they were said in the last
 * `withinMs`. A turn is one say() line (groupTurns).
 *
 * @param {Array<{at:number,text:string}>} selfLines  oldest first
 * @returns {Array<{at:number,text:string}>}
 */
export function recentOwnTurns(selfLines, { now = Date.now(), turns = LAST_LINES_TURNS, withinMs = LAST_LINES_WITHIN_MS } = {}) {
  return groupTurns(selfLines).filter((t) => !Number.isFinite(t.at) || now - t.at <= withinMs).slice(-turns)
}

/**
 * Phrases (two words or more) found in at least `minTurns` of her last
 * `window` turns. Kept only when the phrase has two content words (a count
 * word counts) and at least one of them is her own wording: not a name, not a
 * count, and not an item, block, mob or task word (from `context`, the game's
 * `vocab`, or the task verbs). Two of her lines about "the stone pickaxe" or
 * "the oak trees" share the job, not a bit; "boss of the wood pile" in two
 * lines is a bit, and so is "nine blocks away" or "holding a stone pickaxe
 * plan". Phrases the player also used recently are left out, as in
 * repeatedOwnTerms. Only the longest form of a phrase is returned.
 *
 * 261017 (pass 13): one word of her own is enough. The rule used to be "most
 * of the words are hers", which let every bit built on a game word through:
 * in the pass 12 compare "nine blocks away" (3 uses), "still zero wood tho"
 * (4), "holding a stone pickaxe plan" (2) and "you owe me a cave tour" (2)
 * were all quoted in her last lines and none was named, and "repetitive" was
 * half of the off lines.
 *
 * @param {Array<{at:number,text:string}>} selfLines   oldest first
 * @param {Array<{text:string,who?:string}>} [playerLines]
 * @returns {Array<{phrase:string, count:number}>} at most `max`, most repeated first
 */
export function repeatedOwnPhrases(selfLines, playerLines = [], {
  now = Date.now(), window = PHRASE_TURNS, withinMs = PHRASE_WITHIN_MS, minTurns = 2, max = MAX_PHRASES,
  playerWindow = 8, names = [], context = [], vocab = null, asked = false,
} = {}) {
  const turns = groupTurns(selfLines)
    .filter((t) => !Number.isFinite(t.at) || now - t.at <= withinMs)
    .slice(-window)
  if (turns.length < minTurns) return []
  const known = new Set()
  for (const n of [...(names ?? []), ...(playerLines ?? []).map((l) => l?.who), ...(context ?? [])]) {
    for (const w of tokensOf(n)) if (w.length > 1) for (const k of wordKeys(w)) known.add(k)
  }
  const nameKeys = new Set()
  for (const n of [...(names ?? []), ...(playerLines ?? []).map((l) => l?.who)]) {
    for (const w of tokensOf(n)) if (w.length > 1) for (const k of wordKeys(w)) nameKeys.add(k)
  }
  const game = vocabKeys(vocab)
  const isKnown = (w) => wordKeys(w).some((k) => known.has(k) || TASK_GLUE.has(k) || game?.has(k))
  const isName = (w) => wordKeys(w).some((k) => nameKeys.has(k))
  const heard = (playerLines ?? []).slice(-playerWindow).map((l) => ` ${tokensOf(l?.text).join(' ')} `)

  // Every phrase of 2..10 words in each turn, counted once per turn.
  const counts = new Map()
  for (const turn of turns) {
    const t = tokensOf(turn.text)
    const seen = new Set()
    for (let i = 0; i < t.length; i++) {
      for (let n = 2; n <= 10 && i + n <= t.length; n++) seen.add(t.slice(i, i + n).join(' '))
    }
    for (const p of seen) counts.set(p, (counts.get(p) ?? 0) + 1)
  }
  const isWord = (w) => isContent(w) || COUNT_WORDS.has(w)
  const ok = (p, c) => {
    const words = p.split(' ')
    if (words.some(isName)) return false
    const content = words.filter(isWord)
    if (content.length < 2) return false
    // It starts and ends on a content word, so "of the wood" never stands
    // in for "boss of the wood pile".
    if (!isWord(words[0]) || !isWord(words[words.length - 1])) return false
    if (heard.some((h) => h.includes(` ${p} `))) return false
    // Some of it has to be her own wording: "heading to the oak trees",
    // "need iron ingots" or "zero wood" is the job or the count, "boss of
    // the wood pile" and "owe me a cave tour" are bits.
    if (content.some((w) => !COUNT_WORDS.has(w) && !PLAIN_WORDS.has(w) && !isKnown(w))) return true
    // A fact ("nine blocks away", "still zero wood tho") only as a count
    // she keeps repeating unasked (FACT_BIT_TURNS).
    return !asked && c >= Math.max(minTurns, FACT_BIT_TURNS) && content.some((w) => COUNT_WORDS.has(w))
  }
  const hits = [...counts]
    .filter(([p, c]) => c >= minTurns && ok(p, c))
    .map(([phrase, count]) => ({ phrase, count }))
    .sort((a, b) => b.count - a.count || b.phrase.split(' ').length - a.phrase.split(' ').length)
  const out = []
  for (const h of hits) {
    // One phrase per bit: "boss of the wood pile" covers "wood pile" and
    // "ok fine you're the boss of the wood" (two content words in common).
    const shared = (a, b) => { const bw = new Set(b.split(' ').filter(isWord)); return a.split(' ').filter((w) => isWord(w) && bw.has(w)).length }
    if (out.some((o) => shared(h.phrase, o.phrase) >= 2)) continue
    out.push(h)
    if (out.length >= max) break
  }
  return out
}

// First words that say nothing about the line ("i got", "the zombie").
const PLAIN_OPENERS = new Set("i i'm im i'll i've the a an you you're we it it's that this my".split(' '))

/**
 * The first word her recent turns keep opening with ("ok ok stopping", "ok
 * fine", "ok alex"), when at least `min` of her last `turns` turns start with
 * it. Never an opener habit: plain function words, names, and item, block or
 * task words (`context`, `vocab`), possessives included ("table's" is the
 * table). A word from her card's own voice (`signature`, e.g. Roger's
 * "w-wait") or a stutter is a signature, which the tic note owns: it counts
 * only at the tic note's bar of `sigMin` of her last `sigTurns` turns, and
 * not at all when the tic note already names it (`skipTerms`).
 *
 * @returns {string|null}
 */
export function repeatedOpener(selfLines, {
  now = Date.now(), turns = 3, min = 2, sigTurns = 4, sigMin = 3, withinMs = LAST_LINES_WITHIN_MS,
  names = [], context = [], vocab = null, signature = '', skipTerms = [],
} = {}) {
  const fresh = groupTurns(selfLines).filter((t) => !Number.isFinite(t.at) || now - t.at <= withinMs)
  const known = new Set()
  for (const n of [...(names ?? []), ...(context ?? [])]) {
    for (const w of tokensOf(n)) if (w.length > 1) for (const k of wordKeys(w)) known.add(k)
  }
  const game = vocabKeys(vocab)
  const sig = signatureWords(signature)
  const skip = new Set(skipTerms ?? [])
  const isSignature = (w) => sig.has(w) || /^([a-z])-\1/.test(w)
  const firstWord = (t) => {
    const w = tokensOf(t.text)[0]
    if (!w) return null
    const bare = w.replace(/'s$/, '')
    if (PLAIN_OPENERS.has(w) || PLAIN_OPENERS.has(bare) || skip.has(w)) return null
    if (wordKeys(w).some((k) => known.has(k) || game?.has(k) || TASK_GLUE.has(k))) return null
    return w
  }
  const count = (list) => {
    const c = new Map()
    for (const t of list) { const w = firstWord(t); if (w) c.set(w, (c.get(w) ?? 0) + 1) }
    return c
  }
  const plain = [...count(fresh.slice(-turns))].filter(([w, n]) => !isSignature(w) && n >= min)
  const sigs = [...count(fresh.slice(-sigTurns))].filter(([w, n]) => isSignature(w) && n >= sigMin)
  const top = [...plain, ...sigs].sort((a, b) => b[1] - a[1])[0]
  return top ? top[0] : null
}

// What the note asks for, by the kind of turn it rides on:
//   reply   the player just spoke. The full ask, which is what moved the
//           repetitive share in the MC compare (17 -> 11% off).
//   idle    a turn of her own with no line to answer (idle tick, an event).
//           No quote and no ask, only the phrases and opener she keeps
//           reusing, when there are any. The full note made her start the
//           next job without a word (pass6a persona review: Sui spoke on 1 of
//           6 idle ticks, 5 of 6 before). A lighter ask that still quoted her
//           lines did the same (19 of 30 idle ticks silent against 10 of 30),
//           so on these turns the quote is what tips her into silence.
//   checkin a check-in while her action runs, every few seconds. Silence is
//           already the default there; a short form keeps a line she does
//           say new without the full note each tick.
//   greeted (261017, pass 13) the player's first line crossed her
//           first-contact hello (orchestrator greetCrossed). That turn is
//           already told her hello answers theirs and that a plain hello
//           needs no say(); the reply ask ("find something new to say")
//           pulled the other way, and a second hello ("yo alex", "hey alex.
//           you're back") went out in 1 to 2 of 18 scripted sessions per run.
//           Only the quote and the repeats, no ask.
//   result  (261020, pass 20) the turn after one of her actions finished,
//           while a line of hers is still fresh. These turns carried no
//           quote at all, and the line she had just said went out again: a
//           second hello after a dig came back out of range, "you're
//           welcome" twice around one hand-over. The same short form as a
//           check-in.
const REUSE_ASK = 'Sound like yourself as always, but do not reuse a joke, comeback, greeting, offer or plan from your recent lines in this one; find something new to say, or say less.'

/** The line half of the note: her last lines, quoted, and what they share. */
// 261017 (pass 13): the end of the reply ask. It used to be "If something
// has to come up again, like a count or the plan, say it in new words", and
// she took that as leave to pitch the plan again in new words: "you wanna
// mine some stone with me next?", then "you ready to mine some stone with me
// or nah" to "hows it going", then "ok so stone next, you in?" to "cool", all
// with the earlier lines quoted right above (pass 11 compare, errands-06).
// Re-pitching the plan or a status after "thanks", "cool" or "ok" was the
// biggest kind of repetitive label left on dev.
// Review: a question like "hows it going" still gets a real answer about
// where things stand, only not her last line again.
const REPITCH_ASK = 'Do not bring up your plan, a count or an offer again unless they ask about it or it has changed. If they ask how it is going, tell them where things stand, just not in the same words as before. If their line only acknowledges yours, a short reaction is enough.'

function linesNote(selfLines, playerLines, opts = {}) {
  const mode = ['idle', 'checkin', 'greeted', 'result'].includes(opts.mode) ? opts.mode : 'reply'
  const last = recentOwnTurns(selfLines, { now: opts.now, turns: mode === 'reply' ? REPLY_LINES_TURNS : LAST_LINES_TURNS })
  if (!last.length) return null
  // A word the tic note already names is not named twice ("big brother").
  const skip = (opts.skipTerms ?? []).map((t) => ` ${t} `)
  // A fact she repeats is fine when the player just asked about it.
  const lastHeard = (playerLines ?? []).filter((l) => l && l.companion !== true).at(-1)
  const asked = (mode === 'reply' || mode === 'greeted') && isQuestion(lastHeard?.text)
  const phrases = repeatedOwnPhrases(selfLines, playerLines, { ...opts, asked })
    .filter((p) => !skip.some((t) => ` ${p.phrase} `.includes(t)))
  const names = [...(opts.names ?? []), ...(playerLines ?? []).map((l) => l?.who)]
  const quoted = last.map((t) => `"${clip(t.text)}"`).join(' and then ')
  const lead = last.length === 1 ? `Your last line to them was ${quoted}.` : `Your last lines to them were ${quoted}.`
  const bits = phrases.length
    ? ` You have said ${phrases.map((p) => `"${p.phrase}"`).join(' and ')} more than once already, so leave ${phrases.length === 1 ? 'it' : 'them'} out of this line${mode === 'reply' || mode === 'greeted' ? ' unless they ask for it' : ''}.`
    : ''
  if (mode === 'checkin' || mode === 'result') {
    return `${lead} They already heard ${last.length === 1 ? 'it' : 'these'}, so if you say something ${mode === 'checkin' ? 'this tick' : 'now'}, make it new.${bits}`
  }
  if (mode === 'greeted') return `${lead} They already heard ${last.length === 1 ? 'it' : 'these'}.${bits}`
  const opener = repeatedOpener(selfLines, {
    now: opts.now, names, context: opts.context, vocab: opts.vocab, signature: opts.signature, skipTerms: opts.skipTerms,
  })
  const open = opener ? ` Your recent lines keep starting with "${opener}", so start this one another way.` : ''
  if (mode === 'idle') return (bits + open).trim() || null
  return `${lead} They already heard ${last.length === 1 ? 'it' : 'these'}. ` +
    REUSE_ASK +
    bits + open +
    ` ${REPITCH_ASK}`
}

/**
 * The prompt note for the next turn, or null when she has said nothing
 * recently and nothing repeats. `opts.mode` is the kind of turn: 'reply'
 * (default, the player just spoke), 'idle', 'checkin', 'greeted' or 'result' (see the note above
 * REUSE_ASK).
 */
export function ownRepeatsNote(selfLines, playerLines = [], opts = {}) {
  const { names, context } = opts
  const tics = repeatedOwnTerms(selfLines, playerLines, { names, context })
  const lines = linesNote(selfLines, playerLines, { ...opts, skipTerms: tics.map((h) => h.term) })
  const parts = [lines, ticNote(tics)].filter(Boolean)
  return parts.length ? parts.join(' ') : null
}
