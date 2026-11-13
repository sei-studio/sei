import { describe, it, expect } from 'vitest'
import { normalizeNextStep, nextStepMemoryLine, parsePlanLine, parsePlanGameField, PLAN_GAMES, NEXT_STEP_MAX_CHARS } from './nextStep.js'
import { GAME_CATALOG } from '../../shared/games'
import { NEXT_TIME_GREETING } from './prompts.js'

describe('normalizeNextStep', () => {
  it('returns null when the model left the field out', () => {
    expect(normalizeNextStep(undefined)).toBeNull()
    expect(normalizeNextStep(null)).toBeNull()
    expect(normalizeNextStep(42)).toBeNull()
    expect(normalizeNextStep('')).toBeNull()
    expect(normalizeNextStep(' \n\t ')).toBeNull()
  })

  it('collapses whitespace into one line', () => {
    expect(normalizeNextStep('  finish the\n\n cabin   roof ')).toBe('finish the cabin roof')
  })

  it('caps a runaway field at a word boundary', () => {
    const long = 'build '.repeat(100)
    const out = normalizeNextStep(long)
    expect(out.length).toBeLessThanOrEqual(NEXT_STEP_MAX_CHARS)
    expect(out.endsWith('build')).toBe(true)
  })
})

describe('nextStepMemoryLine', () => {
  it('uses the prefix the greeting prompt points at', () => {
    const line = nextStepMemoryLine('finish the roof')
    expect(line).toBe('Plan for next time: finish the roof')
    expect(NEXT_TIME_GREETING).toContain('"Plan for next time"')
  })
})

// 261014: the player-facing line for the Home strip, and the greeting cues.
import { normalizePlayerLine, playerLineProblem, acceptPlayerLine, PLAYER_LINE_HARD_MAX_CHARS } from './nextStep.js'
import { nextTimeGreeting, callGreetingNote, FIRST_CONTACT } from './prompts.js'

describe('normalizePlayerLine', () => {
  it('returns null for a missing or empty line', () => {
    expect(normalizePlayerLine(undefined)).toBeNull()
    expect(normalizePlayerLine(42)).toBeNull()
    expect(normalizePlayerLine('  ')).toBeNull()
    expect(normalizePlayerLine('"tomorrow"')).toBeNull()
  })

  it('cleans quotes, a trailing period, and capitalizes', () => {
    expect(normalizePlayerLine('"tell Sui how the Arrival rewatch went."')).toBe('Tell Sui how the Arrival rewatch went')
  })

  it('drops relative days that go stale', () => {
    expect(normalizePlayerLine('raid the east village for beds tomorrow')).toBe('Raid the east village for beds')
    expect(normalizePlayerLine('Tomorrow, get more wood and finish the roof')).toBe('Get more wood and finish the roof')
    expect(normalizePlayerLine('Get wood by the river tonight and finish the roof')).toBe('Get wood by the river and finish the roof')
    expect(normalizePlayerLine('Plant the second wheat row later today')).toBe('Plant the second wheat row')
    expect(normalizePlayerLine('Mine 2 more diamonds next time')).toBe('Mine 2 more diamonds')
  })

  it('keeps a comma list whole and cuts a long line at a clause break', () => {
    expect(normalizePlayerLine('Gather blaze powder, pufferfish and a brewing stand, then return to the ocean monument for sponges'))
      .toBe('Gather blaze powder, pufferfish and a brewing stand')
    expect(normalizePlayerLine('Gather blaze powder and pufferfish for water breathing potions'))
      .toBe('Gather blaze powder and pufferfish for water breathing potions')
  })

  it('hard-caps a runaway line at a word with an ellipsis', () => {
    const out = normalizePlayerLine('Mine diamonds with Marv at the deep strip mine under the old stone tower by the birch forest past the lava lake')
    expect(out.length).toBeLessThanOrEqual(PLAYER_LINE_HARD_MAX_CHARS)
    expect(out.endsWith('…')).toBe(true)
    expect(out).not.toMatch(/\s(?:the|and)…$/)
  })

  it('leaves a possessive relative day alone (review 261014)', () => {
    expect(normalizePlayerLine("Watch tonight's stream with Sui")).toBe("Watch tonight's stream with Sui")
    expect(normalizePlayerLine("Finish the Tonight's the Night quest")).toBe("Finish the Tonight's the Night quest")
    expect(normalizePlayerLine('Watch tonight’s stream')).toBe('Watch tonight’s stream')
  })

  it('cuts at an early clause break too', () => {
    expect(normalizePlayerLine('Mine iron, then build a furnace and smelt it all down for armor and tools'))
      .toBe('Mine iron')
  })

  it('does not change its own output (main runs it up to 3 times)', () => {
    const samples = [
      "Watch tonight's stream",
      "Tonight's the Night quest",
      'Tomorrow, get more wood and finish the roof',
      'Next time, later plant the wheat',
      'do it later tomorrow',
      '"raid the east village for beds tomorrow."',
      'Mine iron, then build a furnace and smelt it all down for armor and tools',
      'Mine diamonds with Marv at the deep strip mine under the old stone tower by the birch forest past the lava lake',
      'Gather blaze powder, pufferfish and a brewing stand, then return to the ocean monument for sponges',
      'x'.repeat(120),
      '  ,  tell Lyra how the move went ; and then more  ',
    ]
    for (const raw of samples) {
      const once = normalizePlayerLine(raw)
      expect(normalizePlayerLine(once)).toBe(once)
      expect(normalizePlayerLine(normalizePlayerLine(once))).toBe(once)
    }
  })
})

describe('playerLineProblem / acceptPlayerLine (review 261014)', () => {
  const names = { character: 'Lyra', players: ['Alex', 'alex_mc'] }

  it('accepts lines written to the player', () => {
    for (const line of [
      'Tell Lyra how the move went and how Pixel did',
      'Mine iron with Lyra to make an iron pickaxe',
      'Ask Lyra about her new cat tree',
      'Check in with Lyra about the farm',
      'Get more birch wood from the river grove',
      'Mine 2 more diamonds at y -54',
    ]) expect(playerLineProblem(line, names)).toBeNull()
  })

  it('rejects a note to self', () => {
    expect(playerLineProblem('Ask how the move on Saturday went', names)).toBe('self_note')
    expect(playerLineProblem('Remember to bring up the vet visit', names)).toBe('self_note')
    expect(playerLineProblem('Find out how the interview went', names)).toBe('self_note')
    expect(playerLineProblem('See how Pixel did in the carrier', names)).toBe('self_note')
    // Aimed at someone else than this companion.
    expect(playerLineProblem('Check in with Roger about Pepper', names)).toBe('self_note')
  })

  it('rejects the player named in the third person', () => {
    expect(playerLineProblem('Get iron with Alex for the pickaxe', names)).toBe('names_player')
    expect(playerLineProblem("Ask about Alex's move", names)).toBe('names_player')
    expect(playerLineProblem('Raid the village with alex_mc', names)).toBe('names_player')
    expect(playerLineProblem('Tell the player about the base', names)).toBe('names_player')
    // A name inside another word is not the name.
    expect(playerLineProblem('Find Alexandrite for the crown', names)).toBeNull()
  })

  it('a username equal to the companion name is not the player', () => {
    expect(playerLineProblem('Build the dock with Sui', { character: 'Sui', players: ['sui'] })).toBeNull()
  })

  it('rejects first person', () => {
    expect(playerLineProblem('Help me finish the roof', names)).toBe('first_person')
    expect(playerLineProblem('Finish our house', names)).toBe('first_person')
    expect(playerLineProblem('Mine 2 more diamonds', names)).toBeNull()
  })

  it('works without names', () => {
    expect(playerLineProblem('Ask how the move went')).toBe('self_note')
    expect(playerLineProblem('Finish the cabin roof')).toBeNull()
  })

  it('acceptPlayerLine normalizes, then drops a line that fails', () => {
    expect(acceptPlayerLine('"tell Lyra how the move went tomorrow."', names)).toBe('Tell Lyra how the move went')
    expect(acceptPlayerLine('ask Alex how the move went', names)).toBeNull()
    expect(acceptPlayerLine(undefined, names)).toBeNull()
  })
})

describe('greeting cues (261014)', () => {
  it('names an open plan and asks for it', () => {
    const cue = nextTimeGreeting('finish the "cabin" roof')
    expect(cue).toContain(`"finish the 'cabin' roof"`)
    expect(cue).toMatch(/main thing your greeting is about/)
    expect(cue).not.toMatch(/[—–]/)
  })

  it('null = none open (no cue); undefined = the soft hint', () => {
    expect(nextTimeGreeting(null)).toBe('')
    expect(nextTimeGreeting(undefined)).toBe(NEXT_TIME_GREETING)
  })

  it('FIRST_CONTACT with a plan drops the escape hatch; with null drops the hint', () => {
    const withPlan = FIRST_CONTACT({ gameName: 'Minecraft', known: true, plan: 'finish the roof' })
    expect(withPlan).toContain('"finish the roof"')
    expect(withPlan).not.toContain('This is only a hint')
    const none = FIRST_CONTACT({ gameName: 'Minecraft', known: true, plan: null })
    expect(none).not.toContain('Plan for next time')
    expect(none).toContain('This is only a hint')
    expect(FIRST_CONTACT({ gameName: 'Minecraft', known: true })).toContain(NEXT_TIME_GREETING)
    expect(FIRST_CONTACT({ gameName: 'Minecraft', known: false, plan: null })).toContain('first time you two have played')
  })

  it('call greeting note: plan cue, never silence, group joiners get none', () => {
    const solo = callGreetingNote({ plan: 'ask how the move went' })
    expect(solo).toContain('"ask how the move went"')
    expect(solo).toContain('never (silence)')
    expect(solo).not.toContain('or just say hi')
    // The cue must not say "the last thing ... said": the call primer's
    // (silence) rule keys on that phrase.
    expect(solo).not.toMatch(/last thing/)
    const none = callGreetingNote({ plan: null })
    expect(none).toContain('or just say hi')
    expect(none).not.toContain('Plan for next time')
    const group = callGreetingNote({ peers: ['Marv'], plan: 'ask how the move went' })
    expect(group).toContain('ongoing group voice call')
    expect(group).not.toContain('move')
  })
})

describe('plan lines name their game (261020)', () => {
  it('writes the game into the line, or the plain line without one', () => {
    expect(nextStepMemoryLine('get copper', 'Minecraft')).toBe('Plan for next time in Minecraft: get copper')
    expect(nextStepMemoryLine('build a crock pot', "Don't Starve Together")).toBe("Plan for next time in Don't Starve Together: build a crock pot")
    expect(nextStepMemoryLine('ask how the interview went')).toBe('Plan for next time: ask how the interview went')
    expect(nextStepMemoryLine('x', '  ')).toBe('Plan for next time: x')
    // A colon in a name cannot break the prefix.
    expect(nextStepMemoryLine('x', 'Game: Deluxe')).toBe('Plan for next time in Game Deluxe: x')
  })

  it('parses both shapes back', () => {
    expect(parsePlanLine('Plan for next time in Stardew Valley: plant parsnips')).toEqual({ step: 'plant parsnips', gameName: 'Stardew Valley' })
    expect(parsePlanLine('plan for next time: find diamonds')).toEqual({ step: 'find diamonds', gameName: null })
    expect(parsePlanLine(nextStepMemoryLine('a: b', 'Minecraft'))).toEqual({ step: 'a: b', gameName: 'Minecraft' })
    expect(parsePlanLine('Plan for next time:')).toBeNull()
    expect(parsePlanLine('ouen likes copper')).toBeNull()
  })

  it('the greeting hint still names the labeled lines', () => {
    expect(nextStepMemoryLine('x', 'Minecraft').startsWith('Plan for next time')).toBe(true)
    expect(NEXT_TIME_GREETING).toContain('"Plan for next time"')
  })
})

// 261020 (review): goodbye tools name the game their plan is for.
describe('next_time_game field (261020 review)', () => {
  it('reads a game id, a display name, a unique part of one, or none', () => {
    expect(parsePlanGameField('Minecraft')).toBe('minecraft')
    expect(parsePlanGameField('stardew valley')).toBe('stardew')
    expect(parsePlanGameField('Stardew')).toBe('stardew')
    expect(parsePlanGameField("Don't Starve Together")).toBe('dontstarve')
    expect(parsePlanGameField('dontstarve')).toBe('dontstarve')
    expect(parsePlanGameField(' none. ')).toBe('none')
  })

  it('anything else is left out: unknown games, two games, non-strings', () => {
    expect(parsePlanGameField('Hollow Knight')).toBeNull()
    expect(parsePlanGameField('Minecraft or Stardew Valley')).toBeNull()
    expect(parsePlanGameField('game')).toBeNull()
    expect(parsePlanGameField('')).toBeNull()
    expect(parsePlanGameField(undefined)).toBeNull()
    expect(parsePlanGameField(3)).toBeNull()
  })

  // Delta review 261020: loose answers.
  it('a short answer that starts with none is none', () => {
    expect(parsePlanGameField('None of them')).toBe('none')
    expect(parsePlanGameField('none (just talk)')).toBe('none')
    expect(parsePlanGameField('No game')).toBe('none')
    expect(parsePlanGameField('nothing in a game, it is about her exam')).toBeNull()
  })

  it('reads the short names DST and MC', () => {
    expect(parsePlanGameField('DST')).toBe('dontstarve')
    expect(parsePlanGameField('mc')).toBe('minecraft')
    expect(parsePlanGameField("Don't Starve")).toBe('dontstarve')
    expect(parsePlanGameField('Minecraft (the lighthouse build)')).toBe('minecraft')
  })

  it('matches whole words, so a part of a name or another game names none', () => {
    expect(parsePlanGameField('craft')).toBeNull()
    expect(parsePlanGameField('Minecraft Dungeons')).toBeNull()
    expect(parsePlanGameField('valley')).toBeNull()
    expect(parsePlanGameField('starve')).toBeNull()
    expect(parsePlanGameField('Minecraft or Stardew Valley')).toBeNull()
  })

  it('PLAN_GAMES matches the bot games in the shared catalog', () => {
    for (const [id, name] of Object.entries(PLAN_GAMES)) {
      expect(GAME_CATALOG.find((g) => g.id === id)?.name).toBe(name)
    }
  })

  it('a plan not tied to this game is raised as talk, not as a task here', () => {
    const cue = nextTimeGreeting('ask how the interview went', { notForGame: 'Stardew Valley' })
    expect(cue).toContain('not saved as something to do in Stardew Valley')
    expect(cue).toContain('not as a task to start here')
    expect(nextTimeGreeting('finish the roof')).not.toContain('not saved as something to do')
    const fc = FIRST_CONTACT({ gameName: 'Stardew Valley', known: true, plan: 'ask how the interview went', planNotForGame: true })
    expect(fc).toContain('not saved as something to do in Stardew Valley')
    expect(FIRST_CONTACT({ gameName: 'Stardew Valley', known: true, plan: 'plant parsnips' })).not.toContain('not saved as something to do')
  })
})
