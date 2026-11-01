import { describe, it, expect } from 'vitest'
import { groupTurns, repeatedOwnTerms, ownRepeatsNote, recentOwnTurns, repeatedOwnPhrases, repeatedOpener } from './ownRepeats.js'

// One say() line is recorded as several chat messages within a few ms; turns
// are seconds apart.
function session(turns, start = 1_000_000) {
  const out = []
  turns.forEach((msgs, i) => {
    const at = start + i * 5000
    ;(Array.isArray(msgs) ? msgs : [msgs]).forEach((text, j) => out.push({ at: at + j, text }))
  })
  return out
}

describe('groupTurns', () => {
  it('joins the messages of one say() line and splits separate turns', () => {
    const t = groupTurns(session([['oh!', "you're back nya..."], 'a zombie nya']))
    expect(t.map((x) => x.text)).toEqual(["oh! you're back nya...", 'a zombie nya'])
  })
})

describe('repeatedOwnTerms', () => {
  it('finds a line-ending tic used in most recent turns', () => {
    const lines = session([
      "alex! you're back nya",
      'thank you nya. i just wanted to help',
      "i-i'm okay nya, just took some arrows",
      "a zombie! i'll fight it nya",
    ])
    const hits = repeatedOwnTerms(lines)
    expect(hits[0]).toMatchObject({ term: 'nya', count: 4, of: 4 })
  })

  it('names a pet-name phrase once, not its words separately', () => {
    const lines = session([
      'Really? Thank you, big brother...',
      'Zombie! I got it, big brother, stay back!',
      'Okay big brother! I will get the logs.',
    ])
    expect(repeatedOwnTerms(lines).map((h) => h.term)).toEqual(['big brother'])
  })

  it('leaves out a topic the player is also talking about', () => {
    const lines = session(['ok more wood coming', 'wood is stacking up', 'last of the wood'])
    expect(repeatedOwnTerms(lines, [{ text: 'can you get wood for the house' }])).toEqual([])
    expect(repeatedOwnTerms(lines).map((h) => h.term)).toEqual(['wood'])
  })

  it('never names the player or a teammate, alone or inside a phrase', () => {
    const lines = session([
      'sorry alex nya, lyra has the wood',
      'thank you alex nya. lyra, come help',
      'ok alex nya, lyra is on it',
    ])
    // Given names (player display name, teammate roster).
    expect(repeatedOwnTerms(lines, [], { names: ['Alex', 'Lyra'] }).map((h) => h.term)).toEqual(['nya'])
    // A speaker in the recent chat counts as a name even when not passed in,
    // and a username's parts count ("Alex_2" -> alex).
    expect(repeatedOwnTerms(lines, [{ who: 'Alex_2', text: 'hi' }, { who: 'Lyra', text: 'on my way' }])
      .map((h) => h.term)).toEqual(['nya'])
    // Without names, the player's name is what gets named (the eval failure).
    expect(repeatedOwnTerms(lines).some((h) => h.term.split(' ').includes('alex'))).toBe(true)
  })

  // A real Minecraft snapshot (persona eval, 261012) plus goals: item, block
  // and task words in it are never named; a tic that is not in it still is.
  const SNAPSHOT = [
    'world: #1 Meadow', 'pos: 112,71,-40', 'facing: north. forward -z, back +z, left -x, right +x',
    'biome: plains  surroundings: outside  light: sky 15 block 0  time: day (2400)',
    'hp: 20/20  food: 18/20  xp: lvl 2', 'holding: stone_pickaxe',
    'inventory (6/36 slots): oak_log×7, cobblestone×23, stone_pickaxe×1, bread×3, torch×6, crafting_table×1',
    'nearby blocks:', '#1 grass_block x412 @111,70,-40', '#2 oak_log x14 @118,72-47', '#3 water x30 @104,70,-52',
    'nearby entities:', '#4 Alex @109,71,-38', '#5 cow @121,71,-31', 'owner Alex: @109,71,-38 (3 blocks away)',
  ].join('\n')
  const GOALS = '- [2026-10-12 21:30] gather wood for a house\n- [2026-10-12 21:31] chop the tree by the lake'
  const ctx = { context: [SNAPSHOT, GOALS] }

  it('never names an item, block or task word from the snapshot or goals', () => {
    const lines = session([
      'got the stone, pickaxe next. zero wood though, trees are far',
      'more stone. this pickaxe is slow. still zero wood, trees everywhere',
      'stone pile growing, pickaxe holding up. zero wood, gotta hit the trees',
    ])
    const terms = repeatedOwnTerms(lines, [], ctx).map((h) => h.term)
    for (const t of ['stone', 'pickaxe', 'zero wood', 'trees']) expect(terms).not.toContain(t)
    expect(terms).toEqual([])
    // Without the context these are exactly what gets named.
    expect(repeatedOwnTerms(lines, [], { max: 10 }).map((h) => h.term)).toEqual(expect.arrayContaining(['stone', 'pickaxe', 'zero wood']))
  })

  it('still names a real tic beside a busy snapshot', () => {
    const lyra = session(['got the logs nya', 'here is the stone nya', 'torches are up nya'])
    expect(repeatedOwnTerms(lyra, [], ctx).map((h) => h.term)).toEqual(['nya'])
    const roger = session(['ok big brother!', 'the cow ran, big brother', 'big brother, the water is cold'])
    expect(repeatedOwnTerms(roger, [], ctx).map((h) => h.term)).toEqual(['big brother'])
    const sui = session(['nehehe stone time', 'nehehe got it', 'wood? nehehe later'])
    expect(repeatedOwnTerms(sui, [], ctx).map((h) => h.term)).toEqual(['nehehe'])
  })

  it('matches plurals both ways, against the player too', () => {
    const lines = session(['more logs', 'logs logs', 'stacking logs'])
    expect(repeatedOwnTerms(lines, [{ text: 'grab a log' }])).toEqual([])
    expect(repeatedOwnTerms(lines, [], { context: ['oak_log x3'] })).toEqual([])
    const torches = session(['torches up', 'two torches', 'torches everywhere'])
    expect(repeatedOwnTerms(torches, [], { context: ['torch×6'] })).toEqual([])
  })

  it('needs at least three turns and ignores grammar words', () => {
    expect(repeatedOwnTerms(session(['nya', 'nya']))).toEqual([])
    expect(repeatedOwnTerms(session(['it is you', 'you and it', 'is it you']))).toEqual([])
  })

  it('only looks at the last few turns', () => {
    const lines = session(['the sun is up', 'the sun again', 'the sun, always', 'hi', 'ok going', 'fine'])
    expect(repeatedOwnTerms(lines)).toEqual([])
  })
})

describe('ownRepeatsNote', () => {
  it('quotes the repeated term with its count', () => {
    const note = ownRepeatsNote(session(['the universe is cooling', 'lava. the universe again', 'the universe, of course']))
    expect(note).toContain('"the universe"')
    expect(note).toContain('3 of your last 3')
    expect(note).not.toMatch(/[—–]/)
  })

  it('passes names through', () => {
    const lines = session(['hey alex', 'alex look', 'nice one alex'])
    expect(ownRepeatsNote(lines, [], { names: ['Alex'] })).toBeNull()
  })

  it('is null when nothing repeats', () => {
    expect(ownRepeatsNote(session(['hey', 'zombie!', 'got the logs']))).toBeNull()
    expect(ownRepeatsNote([])).toBeNull()
    expect(ownRepeatsNote(undefined)).toBeNull()
  })
})

// 261013: line-level repeats. session() starts at 1_000_000 with turns 5 s
// apart, so "now" just after the last turn keeps every line fresh.
const nowAfter = (n, start = 1_000_000) => start + n * 5000 + 1000

describe('recentOwnTurns', () => {
  it('returns her last two turns while they are fresh', () => {
    const lines = session(['one', ['two', 'still two'], 'three'])
    expect(recentOwnTurns(lines, { now: nowAfter(3) }).map((t) => t.text)).toEqual(['two still two', 'three'])
    expect(recentOwnTurns(lines, { now: nowAfter(3) + 10 * 60_000 })).toEqual([])
  })
})

describe('repeatedOwnPhrases', () => {
  const opts = (n, extra = {}) => ({ now: nowAfter(n), ...extra })

  it('names a bit she has used twice, once, in its longest form', () => {
    const lines = session([
      "ok stopping, you're the boss of the wood pile now",
      'trees are over there',
      "ok fine, you're the boss of the wood pile",
    ])
    const hits = repeatedOwnPhrases(lines, [], opts(3))
    expect(hits.map((h) => h.phrase)).toEqual(['boss of the wood pile'])
    expect(hits[0].count).toBe(2)
  })

  it('leaves out the task she is on', () => {
    const lines = session(['need stone, pickaxe next', 'mining stone now, need stone', 'pickaxe next, then stone'])
    expect(repeatedOwnPhrases(lines, [], opts(3, { context: ['stone_pickaxe×1, cobblestone×3'] }))).toEqual([])
  })

  it('leaves out names and what the player also said', () => {
    const named = session(['nice one alex smith', 'good job alex smith'])
    expect(repeatedOwnPhrases(named, [], opts(2, { names: ['Alex Smith'] }))).toEqual([])
    const echoed = session(['you owe me a snack', 'fine, you owe me a snack'])
    expect(repeatedOwnPhrases(echoed, [{ who: 'Alex', text: 'i owe you a snack? you owe me a snack' }], opts(2))).toEqual([])
    expect(repeatedOwnPhrases(echoed, [], opts(2)).map((h) => h.phrase)).toEqual(['owe me a snack'])
  })

  it('ignores old turns', () => {
    const lines = session(['you owe me a snack', 'fine, you owe me a snack'])
    expect(repeatedOwnPhrases(lines, [], opts(2, { now: nowAfter(2) + 10 * 60_000 }))).toEqual([])
  })
})

describe('repeatedOpener', () => {
  it('finds an opener she keeps using, never a plain word or a name', () => {
    expect(repeatedOpener(session(['ok stopping', 'ok fine', 'wood next']), { now: nowAfter(3) })).toBe('ok')
    expect(repeatedOpener(session(["i'm here", "i'm going", 'i got it']), { now: nowAfter(3) })).toBeNull()
    expect(repeatedOpener(session(['alex look', 'alex wait']), { now: nowAfter(2), names: ['Alex'] })).toBeNull()
  })
})

describe('ownRepeatsNote, line level', () => {
  it('quotes her last lines, names the bit and the opener, in plain text', () => {
    const lines = session([
      "ok stopping, you're the boss of the wood pile now",
      'ok so trees are over there',
    ])
    const note = ownRepeatsNote(lines, [], { now: nowAfter(2) })
    expect(note).toContain(`"ok stopping, you're the boss of the wood pile now" and then "ok so trees are over there"`)
    expect(note).toContain('keep starting with "ok"')
    expect(note).not.toMatch(/[—–]/)
    const again = session([...["ok stopping, you're the boss of the wood pile now", 'trees are over there'], "fine, you're the boss of the wood pile"])
    expect(ownRepeatsNote(again, [], { now: nowAfter(3) })).toContain('"boss of the wood pile" more than once')
  })

  it('does not name a tic phrase twice', () => {
    const roger = session(['ok big brother!', 'the cow ran, big brother', 'big brother, the water is cold'])
    const note = ownRepeatsNote(roger, [], { now: nowAfter(3) })
    expect(note.match(/"big brother"/g)).toHaveLength(1)
  })

  it('is null when her lines are old and nothing repeats', () => {
    expect(ownRepeatsNote(session(['hey', 'zombie!']), [], { now: nowAfter(2) + 10 * 60_000 })).toBeNull()
  })
})

// 261013 (pass6a review): the note on turns where the player did not speak,
// item words, openers.
describe('ownRepeatsNote, by kind of turn', () => {
  const lines = session([
    "hey alex, want to grab wood with me?",
    "i'll get the oak trees, can you keep an eye on me?",
  ])
  const now = nowAfter(2)
  const QUOTE = `Your last lines to them were "hey alex, want to grab wood with me?" and then "i'll get the oak trees, can you keep an eye on me?". They already heard these.`

  it('keeps the full reply-turn wording, byte for byte', () => {
    const reply = `${QUOTE} Sound like yourself as always, but do not reuse a joke, comeback, greeting, offer or plan from your recent lines in this one; find something new to say, or say less. Do not bring up your plan, a count or an offer again unless they ask about it or it has changed. If they ask how it is going, tell them where things stand, just not in the same words as before. If their line only acknowledges yours, a short reaction is enough.`
    expect(ownRepeatsNote(lines, [], { now, names: ['Alex'] })).toBe(reply)
    expect(ownRepeatsNote(lines, [], { now, names: ['Alex'], mode: 'reply' })).toBe(reply)
  })

  it('on an idle turn with nothing repeated is no note at all', () => {
    expect(ownRepeatsNote(lines, [], { now, names: ['Alex'], mode: 'idle' })).toBeNull()
  })

  it('on an idle turn names only what repeats, with no quote and no ask', () => {
    const bit = session(["ok fine, you're the boss of the wood pile", "sure thing, boss of the wood pile"])
    expect(ownRepeatsNote(bit, [], { now: nowAfter(2), mode: 'idle' }))
      .toBe('You have said "boss of the wood pile" more than once already, so leave it out of this line.')
    const opener = session(['wow the cows are cute', 'i love this hill', 'wow what a view'])
    const note = ownRepeatsNote(opener, [], { now: nowAfter(3), mode: 'idle' })
    expect(note).toBe('Your recent lines keep starting with "wow", so start this one another way.')
    expect(note).not.toMatch(/last line|already heard|say less|offer/)
  })

  it('on a check-in is a short form: the quote and a new line if any', () => {
    const note = ownRepeatsNote(lines, [], { now, names: ['Alex'], mode: 'checkin' })
    expect(note).toBe(`Your last lines to them were "hey alex, want to grab wood with me?" and then "i'll get the oak trees, can you keep an eye on me?". They already heard these, so if you say something this tick, make it new.`)
    expect(note).not.toMatch(/offer|say less|plan/)
  })

  it('still names a repeated bit on idle and check-in turns', () => {
    const bit = session(["ok fine, you're the boss of the wood pile", "sure thing, boss of the wood pile"])
    for (const mode of ['idle', 'checkin']) {
      expect(ownRepeatsNote(bit, [], { now: nowAfter(2), mode })).toContain('"boss of the wood pile" more than once')
    }
  })

  it('has no dashes in any form', () => {
    for (const mode of ['reply', 'idle', 'checkin', 'greeted']) expect(ownRepeatsNote(lines, [], { now, mode }) ?? '').not.toMatch(/[—–]/)
  })

  // 261017 (pass 13): the reply ask no longer invites her to say the plan
  // again in new words (she re-pitched "stone next, you in?" three times).
  it('the reply ask never invites restating the plan or a count', () => {
    const note = ownRepeatsNote(lines, [], { now, names: ['Alex'] })
    expect(note).not.toContain('say it in new words')
    expect(note).toContain('Do not bring up your plan, a count or an offer again unless they ask about it or it has changed.')
  })

  // Review (pass 13): "hows it going" still gets a real status answer.
  it('lets a real status answer through, only not in the same words', () => {
    const note = ownRepeatsNote(lines, [{ who: 'Alex', text: 'hows it going' }], { now, names: ['Alex'] })
    expect(note).toContain('If they ask how it is going, tell them where things stand, just not in the same words as before.')
  })

  it('on a reply turn a named bit is left out unless they ask for it', () => {
    const bit = session(['ok boss of the wood pile, fine', 'you are the boss of the wood pile now'])
    expect(ownRepeatsNote(bit, [], { now: nowAfter(2) })).toContain('"boss of the wood pile" more than once already, so leave it out of this line unless they ask for it.')
  })

  // 261017 (pass 13): the reply to a hello that crossed hers. That turn
  // already says a plain hello needs no say(), so no "find something new to
  // say" here.
  it('on the turn after a crossed hello is the quote and the repeats only', () => {
    const hello = session(["oh hey alex. first time in this world together, i'm sui"])
    expect(ownRepeatsNote(hello, [], { now: nowAfter(1), names: ['Alex'], mode: 'greeted' }))
      .toBe(`Your last line to them was "oh hey alex. first time in this world together, i'm sui". They already heard it.`)
    const bit = session(["ok fine, you're the boss of the wood pile", "sure thing, boss of the wood pile"])
    expect(ownRepeatsNote(bit, [], { now: nowAfter(2), mode: 'greeted' })).toContain('"boss of the wood pile" more than once')
  })
})

describe('repeatedOwnPhrases, item vocabulary', () => {
  // What the Minecraft adapter hands over (gameVocabulary): item, block and
  // mob names. A few real ones are enough for the probes.
  const VOCAB = ['oak_log', 'oak_planks', 'crafting_table', 'iron_ingot', 'raw_iron', 'iron_ore', 'zombie', 'tree']
  const opts = (n, extra = {}) => ({ now: nowAfter(n), vocab: VOCAB, ...extra })

  it('does not name the oak trees she is heading to', () => {
    const lines = session(['heading to the oak trees', 'ok heading to the oak trees now'])
    expect(repeatedOwnPhrases(lines, [], opts(2))).toEqual([])
    // Without the game words "oak" and "trees" read as her own wording.
    expect(repeatedOwnPhrases(lines, [], { now: nowAfter(2) }).map((h) => h.phrase)).toEqual(['heading to the oak trees'])
  })

  it('does not name a crafting table she does not have yet', () => {
    const lines = session(['need a crafting table first', 'still need a crafting table'])
    expect(repeatedOwnPhrases(lines, [], opts(2, { context: ['inventory (1/36 slots): oak_log×3'] }))).toEqual([])
  })

  it('does not name iron ingots when the bag holds raw iron', () => {
    const lines = session(['need iron ingots for the pick', 'smelting, need iron ingots'])
    const context = ['inventory (2/36 slots): raw_iron×3, cobblestone×12']
    expect(repeatedOwnPhrases(lines, [], opts(2, { context }))).toEqual([])
  })

  it('still names a bit that mentions an item', () => {
    const wood = session(["ok fine, you're the boss of the wood pile", 'boss of the wood pile reporting in'])
    expect(repeatedOwnPhrases(wood, [], opts(2, { vocab: [...VOCAB, 'wood'] })).map((h) => h.phrase)).toEqual(['boss of the wood pile'])
    const snack = session(['you owe me a snack', 'fine, you owe me a snack'])
    expect(repeatedOwnPhrases(snack, [], opts(2)).map((h) => h.phrase)).toEqual(['owe me a snack'])
  })
})

// 261017 (pass 13): bits built on a game word or a count. In the pass 12
// compare these were quoted in her last lines turn after turn and never
// named, and the judge marked every reuse repetitive.
describe('repeatedOwnPhrases, bits with game words and counts', () => {
  const VOCAB = ['oak_log', 'oak_planks', 'oak_wood', 'stone', 'stone_pickaxe', 'cobblestone', 'grass_block', 'cave_air', 'block', 'blocks', 'tree', 'zombie']
  const opts = (n, extra = {}) => ({ now: nowAfter(n), vocab: VOCAB, names: ['Alex'], ...extra })

  it('names "nine blocks away" as a comeback (work_session-04, three replies running)', () => {
    const lines = session([
      "lol ur kinda slow, says the guy watching from nine blocks away. i'm getting stone next",
      "favorite mob? creeper obviously, you'd run from it from nine blocks away",
      "ehh you're the one standing nine blocks away holding nothing. carry your own logs",
    ])
    const heard = [{ who: 'Alex', text: 'honestly ur useless' }]
    expect(repeatedOwnPhrases(lines, heard, opts(3)).map((h) => h.phrase)).toEqual(['nine blocks away'])
    // Three turns running is also the tic note's bar, which then names it.
    expect(ownRepeatsNote(lines, heard, opts(3))).toContain('"nine blocks"')
  })

  it('names "still zero wood tho" but never the bare count', () => {
    const night = session([
      "ehehe thanks alex. still zero wood tho so don't get cocky yet",
      'ehehe ok one joke. why did the zombie not eat the sword guy. still zero wood tho alex',
      'nehehe you good? still zero wood tho',
    ])
    expect(repeatedOwnPhrases(night, [], opts(3)).map((h) => h.phrase)).toEqual(['still zero wood tho'])
    const status = session(['zero wood so far', 'still zero wood, trees are far', 'got four logs', 'four logs now'])
    expect(repeatedOwnPhrases(status, [], opts(4))).toEqual([])
  })

  it('names a comeback built on an item ("holding a stone pickaxe plan")', () => {
    const lines = session([
      "ok i'm slow AND i'm holding a stone pickaxe plan. nehehe",
      "rude. i'm useless AND holding a stone pickaxe plan so who's winning now",
    ])
    expect(repeatedOwnPhrases(lines, [], opts(2)).map((h) => h.phrase)).toEqual(['holding a stone pickaxe plan'])
  })

  it('names a made-up debt that mentions a cave', () => {
    const lines = session(["coal's yours. you still owe me a cave tour tho", 'no prob. you owe me a cave tour for the coal tho'])
    expect(repeatedOwnPhrases(lines, [], opts(2)).map((h) => h.phrase)).toEqual(['owe me a cave tour'])
  })

  // Review (pass 13): facts and acks are not bits. Fillers, distance and
  // direction words and follow/stop acks are never her own wording, and a
  // fact said twice (or asked for) is the answer, not a recycled line.
  it('leaves out a distance and a direction', () => {
    const lines = session(['the cave is nine blocks north of here', 'cave? nine blocks north, by the hill', 'yeah the trees are blocks away, east side', 'trees are blocks away east of us'])
    expect(repeatedOwnPhrases(lines, [], opts(4))).toEqual([])
  })

  it('leaves out the follow and stop acks', () => {
    const lines = session(['ok following you now', 'following you now', 'ok stopping now', 'stopping now, holding still'])
    expect(repeatedOwnPhrases(lines, [], opts(4))).toEqual([])
  })

  it('leaves out a count said twice with a filler', () => {
    expect(repeatedOwnPhrases(session(['three logs so far lol', 'three logs so far, more coming']), [], opts(2))).toEqual([])
    expect(repeatedOwnPhrases(session(['no wood yet tho', 'still no wood yet']), [], opts(2))).toEqual([])
  })

  it('never names a fact the player just asked for', () => {
    // Spread over five turns, so the tic note (3 of the last 4) stays out of it.
    const lines = session(['the cave is nine blocks north', 'creeper obviously', 'yep nine blocks north, past the hill', 'lol ok', 'nine blocks north, follow me'])
    const asked = [{ who: 'Alex', text: "where's the cave again" }]
    expect(repeatedOwnPhrases(lines, [], opts(5)).map((h) => h.phrase)).toEqual(['nine blocks north'])
    expect(repeatedOwnPhrases(lines, [], { ...opts(5), asked: true })).toEqual([])
    expect(ownRepeatsNote(lines, asked, opts(5))).not.toContain('more than once')
    // An idle turn has no question to answer, so the fact is still named.
    expect(ownRepeatsNote(lines, asked, { ...opts(5), mode: 'idle' })).toContain('"nine blocks north" more than once')
  })

  it('still names "cave tour" when the player asks about something else', () => {
    const lines = session(["coal's yours. you still owe me a cave tour tho", 'no prob. you owe me a cave tour for the coal tho'])
    const note = ownRepeatsNote(lines, [{ who: 'Alex', text: 'hows it going' }], opts(2))
    expect(note).toContain('"owe me a cave tour" more than once')
  })

  it('still leaves out the job and where she is walking', () => {
    const job = session(['mining stone for the stone pickaxe', 'need stone for the stone pickaxe', 'heading to the oak trees', 'walking to the oak trees', 'coming back with the oak logs', 'ok coming back with the oak logs'])
    expect(repeatedOwnPhrases(job, [], opts(6))).toEqual([])
  })
})

describe('repeatedOpener, context and signatures', () => {
  it('never names an item word from the snapshot, possessive included', () => {
    const lines = session(["table's down, crafting now", "table's ready", "table's placed by the door"])
    expect(repeatedOpener(lines, { now: nowAfter(3) })).toBe("table's")
    expect(repeatedOpener(lines, { now: nowAfter(3), context: ['inventory: crafting_table×1'] })).toBeNull()
    expect(repeatedOpener(lines, { now: nowAfter(3), vocab: ['crafting_table'] })).toBeNull()
  })

  it('never names a name in its possessive form', () => {
    const lines = session(["alex's house is so cute", "alex's base needs a door"])
    expect(repeatedOpener(lines, { now: nowAfter(2), names: ['Alex'] })).toBeNull()
  })

  it('leaves a signature stutter to the tic note until 3 of 4 turns', () => {
    const card = 'Examples:\n"W-wait... wasn\'t that symbol on the door earlier?"'
    const two = session(['w-wait, a zombie!', 'w-wait for me', 'i got the logs'])
    expect(repeatedOpener(two, { now: nowAfter(3), signature: card })).toBeNull()
    // A stutter shape is a signature even when the card does not show it.
    expect(repeatedOpener(two, { now: nowAfter(3) })).toBeNull()
    const three = session(['w-wait, a zombie!', 'w-wait for me', 'w-wait, is that iron?'])
    expect(repeatedOpener(three, { now: nowAfter(3), signature: card })).toBe('w-wait')
    // Not when the tic note already names it.
    expect(repeatedOpener(three, { now: nowAfter(3), signature: card, skipTerms: ['w-wait'] })).toBeNull()
    // A plain opener habit still counts at 2 of 3.
    expect(repeatedOpener(session(['ok stopping', 'ok fine', 'wood next']), { now: nowAfter(3), signature: card })).toBe('ok')
  })

  it('reaches the note through ownRepeatsNote context', () => {
    const lines = session(["table's down", "table's ready"])
    expect(ownRepeatsNote(lines, [], { now: nowAfter(2) })).toContain('keep starting with')
    expect(ownRepeatsNote(lines, [], { now: nowAfter(2), context: ['crafting_table×1'] })).not.toContain('keep starting with')
  })
})
