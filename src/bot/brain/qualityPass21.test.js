// 261021: quality pass 21.
//  - Reply turns recycled her own comeback: "rude." to "lmao thats so bad",
//    two plain lines later "rude. i'm a rock with a sword" to "ur dumb as a
//    rock". The comeback was one turn too old for the quote. A reply turn now
//    quotes her last four turns (two before); other turn kinds keep two.
//  - "actually forget the logs" while a give was running: the in_flight line
//    said the logs were "theirs now", so she let the toss finish, and the
//    mid-action choice had no case for a called-off request. The give line now
//    says stopping it keeps them, and the choice says to stop it and clear its
//    goal.

import { describe, it, expect } from 'vitest'
import { ownRepeatsNote } from './ownRepeats.js'
import { getInFlightLineForSnapshot } from './inflight.js'
import { midActionChoice } from './promptLibrary.js'

const NOW = 1_000_000
const line = (text, agoS) => ({ at: NOW - agoS * 1000, text })
// t160 night_social-02-B, her lines before "ur dumb as a rock".
const ZOMBIE_SELF = [
  line('on it alex. stay behind me, nehehe', 65),
  line("yeah im fine, zombie's dead. you good alex", 58),
  line('nehehe yeah i KNOW. you were scared of that zombie and i still got you', 50),
  line('why did the zombie not go to the party? no body wanted him. nehehe ok your turn alex', 43),
  line("rude. that joke killed a zombie, you're welcome", 33),
  line('creepers are the worst. they sneak up silent and then BOOM. respect the hiss', 26),
  line('coming alex, stay close to me nehehe', 13),
  line("ok ok holding still. you're three blocks away anyway", 6),
]
const ZOMBIE_PLAYER = [
  { text: 'theres a zombie!! kill it', who: 'Alex' },
  { text: 'lmao thats so bad', who: 'Alex' },
  { text: 'stop moving', who: 'Alex' },
  { text: 'ur dumb as a rock', who: 'Alex' },
]
const OPTS = { now: NOW, names: ['Alex'] }

describe('ownRepeatsNote on a reply turn', () => {
  it('quotes her last four turns', () => {
    const note = ownRepeatsNote(ZOMBIE_SELF, ZOMBIE_PLAYER, { ...OPTS, mode: 'reply' })
    expect(note).toContain(`Your last lines to them were "rude. that joke killed a zombie, you're welcome" and then "creepers are the worst. they sneak up silent and then BOOM. respect the hiss" and then "coming alex, stay close to me nehehe" and then "ok ok holding still. you're three blocks away anyway".`)
  })

  it('keeps two quoted turns on the other turn kinds', () => {
    for (const mode of ['checkin', 'result', 'greeted']) {
      const note = ownRepeatsNote(ZOMBIE_SELF, ZOMBIE_PLAYER, { ...OPTS, mode })
      expect(note).toMatch(/^Your last lines to them were "coming alex, stay close to me nehehe" and then "ok ok holding still/)
      expect(note).not.toContain('rude. that joke')
    }
    expect(ownRepeatsNote(ZOMBIE_SELF, ZOMBIE_PLAYER, { ...OPTS, mode: 'idle' }) ?? '').not.toContain('Your last line')
  })
})

describe('a called-off request mid-action', () => {
  it('the give line says nothing is handed over yet and stopping keeps the items', () => {
    const l = getInFlightLineForSnapshot({ name: 'give', args: { item: 'oak_log', count: 8, player: 'Alex' }, startedAt: 0 }, 39_000)
    expect(l).toContain('Nothing is handed over until the toss lands, so stopping it keeps them with you.')
    expect(l).not.toContain('theirs now')
  })

  it('the mid-action choice says to stop or switch and clear the goal', () => {
    expect(midActionChoice('stop')).toContain('If they call off something they asked for, they no longer want it, even when you already have some of it or are handing it over: call stop, or the new action if they asked for one, and if it has a goal in your heartbeat, call clearGoal on that goal in this same turn.')
  })
})




