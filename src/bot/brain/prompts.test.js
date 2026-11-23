// src/bot/brain/prompts.test.js
//
// 260618: locks the heartbeat / proactiveness-directive split. The directive is
// STATIC for a session, so it moved OUT of the per-loop heartbeat block (which
// re-bills every loop) and INTO the cached system prefix. These tests assert the
// split holds: the heartbeat carries only goal + frontier, and the directive is
// produced by its own renderer for the cached system.

import { describe, it, expect } from 'vitest'
import {
  renderHeartbeat,
  renderProactivenessDirective,
  PROACTIVENESS_DIRECTIVES,
  NUDGES,
  SPEAK_REMINDER,
  GREETING_HINT,
} from './prompts.js'
// SESSION_END_CLAUSE is not (yet) re-exported through the prompts.js barrel —
// pull it straight from the source of truth.
import { SESSION_END_CLAUSE, MEMORY_GOAL_CUE, PLAYER_TASK_TAG } from './promptLibrary.js'

// 260703: live-session bug — the player said "lets call it here for now" / "cya"
// / "bye" and the bot kept saying goodbye lines without ever calling quit, so it
// stood in the world until the player manually stopped the session. The quit
// tool's own description already covers this, but Haiku follows the per-turn
// addenda more strongly, and those never named quit. SESSION_END_CLAUSE is the
// one shared sentence reused everywhere a player message can land, so this
// locks both the shared const and its presence in NUDGES.playerInterruptHint.
describe('SESSION_END_CLAUSE — session-end vs task-stop disambiguation (260703)', () => {
  it('names quit, the farewell field, and concrete leaving phrases', () => {
    expect(SESSION_END_CLAUSE).toContain('quit_game')
    expect(SESSION_END_CLAUSE).toContain('farewell')
    expect(SESSION_END_CLAUSE).toContain('ENDING THE SESSION')
    expect(SESSION_END_CLAUSE).toMatch(/"bye"/)
    expect(SESSION_END_CLAUSE).toMatch(/"cya"/)
  })
  it('is reused verbatim in NUDGES.playerInterruptHint rather than a divergent copy', () => {
    expect(NUDGES.playerInterruptHint).toContain(SESSION_END_CLAUSE)
  })
  // 260703b: session-end memory nudge — across 8 live sessions MEMORY.md gained
  // 3 entries (2 near-dupes) because nothing ever pointed at remember() when a
  // short session wrapped up. The clause now tells the model that remember, say,
  // and quit all fit in one turn (the orchestrator executes inline metadata in
  // batch order and defers the quit teardown, so the write always lands).
  it('nudges a same-turn remember() alongside quit at session end', () => {
    expect(SESSION_END_CLAUSE).toContain('remember()')
    expect(SESSION_END_CLAUSE).toContain('in the same turn')
    expect(SESSION_END_CLAUSE).toContain('remember, say, and quit_game can all be called together')
  })
})

// 260703b: preference capture. A live player complaint ("u should say hi to me
// next time when u join") — a durable preference — was never written via
// remember(); short sessions are all P1 chat interrupts with no natural slot.
// The player-message nudge now names the exact trigger shapes.
describe('NUDGES.playerInterruptHint — preference capture (260703b)', () => {
  it('tells the model to remember() a stated preference/correction in the same turn', () => {
    const t = NUDGES.playerInterruptHint
    expect(t).toContain('preference, correction, or fact')
    expect(t).toContain('record it with remember() in the same turn')
    expect(t).toContain('that is exactly what memory is for')
    expect(t).toMatch(/"you should…", "i like…", "call me…", "next time…"/)
  })
})

// 260703b: scratchpad contract. On "yo" the model wrote "yo." into its private
// text and called placeBlock with no say() — the player got silence. The
// per-turn reminder now states that text output never reaches the player.
describe('SPEAK_REMINDER — scratchpad contract (260703b)', () => {
  it('says words in the text output never reach the player', () => {
    expect(SPEAK_REMINDER).toContain('say()')
    expect(SPEAK_REMINDER).toContain('words in your text output never reach the player')
  })
})

// 260703b: sticky greeting. The full FIRST CONTACT block rides only the first
// idle tick; when that loop is preempted the greeting was lost forever. The
// short hint rides every composed turn until a say() line reaches chat.
describe('GREETING_HINT — sticky greeting hint (260703b)', () => {
  it('is a short greet-now nudge routed through say()', () => {
    expect(GREETING_HINT).toContain('not greeted the player yet this session')
    expect(GREETING_HINT).toContain("say()")
    // It must stay SHORT — it rides every turn until the first spoken line.
    expect(GREETING_HINT.length).toBeLessThan(200)
  })
})

describe('renderProactivenessDirective — static, cached-system directive', () => {
  it('returns the level directive under a PROACTIVENESS header', () => {
    const out = renderProactivenessDirective(2)
    expect(out).toContain('# PROACTIVENESS')
    expect(out).toContain(PROACTIVENESS_DIRECTIVES[2])
  })
  it('defaults to reactive (1) for an out-of-range / undefined level', () => {
    expect(renderProactivenessDirective(undefined)).toContain(PROACTIVENESS_DIRECTIVES[1])
    expect(renderProactivenessDirective(9)).toContain(PROACTIVENESS_DIRECTIVES[1])
  })
})

// 261013 (pass 6b): player tasks get their own head, ahead of the bot's own goals.
describe('renderHeartbeat — player tasks first', () => {
  it('lists tagged player tasks before the bot own goals', () => {
    const hb = renderHeartbeat(2, `- [t] Get iron tools. Finish when I hold an iron pickaxe\n- [u] ${PLAYER_TASK_TAG} grab coal and come back to Alex`, 'stone tools')
    const tasks = hb.indexOf('Tasks the player asked you to do')
    const own = hb.indexOf('Your own goals')
    expect(tasks).toBeGreaterThan(-1)
    expect(own).toBeGreaterThan(tasks)
    expect(hb.indexOf('grab coal')).toBeLessThan(own)
    expect(hb.indexOf('Get iron tools')).toBeGreaterThan(own)
    expect(hb).not.toContain('Reachable next')
  })

  it('lists a player task from an earlier session last, to ask about, not to start', () => {
    const start = Date.parse('2026-10-13T12:00:00.000Z')
    const own = '- [2026-10-12T09:00:00.000Z] Get iron tools. Finish when I hold an iron pickaxe'
    const old = `- [2026-10-12T10:00:00.000Z] ${PLAYER_TASK_TAG} grab coal and come back to Alex`
    const now = `- [2026-10-13T12:05:00.000Z] ${PLAYER_TASK_TAG} bring Alex 10 logs`
    const hb = renderHeartbeat(2, [own, old, now].join('\n'), 'stone tools', { sessionStartMs: start })
    const cur = hb.indexOf('Tasks the player asked you to do')
    const ownAt = hb.indexOf('Your own goals')
    const earlier = hb.indexOf('Tasks the player gave you in an earlier session')
    expect(cur).toBeGreaterThan(-1)
    expect(ownAt).toBeGreaterThan(cur)
    expect(earlier).toBeGreaterThan(ownAt)
    expect(hb.indexOf('bring Alex 10 logs')).toBeLessThan(ownAt)
    expect(hb.indexOf('grab coal')).toBeGreaterThan(earlier)

    // Only an earlier task and her own goal: her goal is worked as usual.
    const hb2 = renderHeartbeat(2, [own, old].join('\n'), 'stone tools', { sessionStartMs: start })
    expect(hb2).not.toContain('Tasks the player asked you to do')
    expect(hb2.indexOf('Your active goals')).toBeLessThan(hb2.indexOf('earlier session'))

    // Only an earlier task: nothing is being worked, so the agentic menu stays.
    const hb3 = renderHeartbeat(2, old, 'stone tools', { sessionStartMs: start })
    expect(hb3).toContain('No active goals yet')
    expect(hb3).toContain('Reachable next: stone tools')

    // Without a session start every task counts as this session's.
    expect(renderHeartbeat(2, old, '')).toContain('Tasks the player asked you to do')
  })

  it('keeps the plain goals head when there is no player task, and one list when passive', () => {
    expect(renderHeartbeat(2, '- [t] go for diamonds', '')).toContain('Your active goals')
    const passive = renderHeartbeat(0, `- [u] ${PLAYER_TASK_TAG} grab coal`, '')
    expect(passive).toContain('Tasks the player has given you')
    expect(passive).not.toContain('Tasks the player asked you to do')
  })
})

describe('renderHeartbeat — goal + frontier only (no directive)', () => {
  it('does NOT embed the proactiveness directive any more', () => {
    const hb = renderHeartbeat(2, '', 'stone tools · food')
    expect(hb).toContain('# HEARTBEAT')
    // The big static directive must not be re-billed inside the per-loop block.
    expect(hb).not.toContain(PROACTIVENESS_DIRECTIVES[2])
    expect(hb).not.toContain('# PROACTIVENESS')
  })
  it('still carries the committed goal text', () => {
    const hb = renderHeartbeat(1, '- [t] build a dock by the river', '')
    expect(hb).toContain('build a dock by the river')
  })
  it('frames the reachable frontier when agentic with no goal yet', () => {
    const hb = renderHeartbeat(2, '', 'stone tools · iron')
    expect(hb).toContain('stone tools · iron')
  })
  it('hides the frontier once a goal is committed at agentic level', () => {
    const hb = renderHeartbeat(2, '- [t] go for diamonds', 'stone tools · iron')
    expect(hb).not.toContain('stone tools · iron')
    expect(hb).toContain('go for diamonds')
  })
})

// 260708: memory/goal capture cue (Lyra post-mortem). The player set an
// explicit session goal out loud; the bot agreed verbally and recorded
// nothing, so the plan was gone two loops later. The cue is ONE shared const
// (no drift) present in every variant that delivers a player message,
// including BOTH mid-action actionTurn variants — the mid-follow interrupt is
// exactly where "we're building a house, remember that" landed and died.
describe('MEMORY_GOAL_CUE — memory/goal capture (260708)', () => {
  it('cues remember() for keepsakes and setGoal for multi-step objectives, with no trigger-phrase matching', () => {
    expect(MEMORY_GOAL_CUE).toContain('record it with remember() in the same turn')
    expect(MEMORY_GOAL_CUE).toContain('keep something in mind')
    expect(MEMORY_GOAL_CUE).toContain('record it with setGoal (for_player true) in the same turn')
    expect(MEMORY_GOAL_CUE).toContain('Nothing you say out loud is stored anywhere')
  })

  it('is reused verbatim in both playerInterruptHint variants', () => {
    expect(NUDGES.playerInterruptHint).toContain(MEMORY_GOAL_CUE)
    expect(NUDGES.playerInterruptHintGroupVoice).toContain(MEMORY_GOAL_CUE)
  })

  it('rides the not-mid-action player-message variants too (a stated goal often arrives on a fresh loop)', () => {
    const solo = NUDGES.actionTurn({ action: null, stopTool: 'end_loop', playerLine: 'our goal today is a house', who: 'Steve' })
    expect(solo).toContain(MEMORY_GOAL_CUE)
    const group = NUDGES.actionTurn({ action: null, stopTool: 'end_loop', playerLine: 'our goal today is a house', who: 'Steve', voice: true, peers: ['Sui'] })
    expect(group).toContain(MEMORY_GOAL_CUE)
  })

  it('rides both mid-action player-message variants of actionTurn', () => {
    const solo = NUDGES.actionTurn({
      action: 'follow Steve', stopTool: 'unfollow', playerLine: 'we are building a house, ok?', who: 'Steve',
    })
    expect(solo).toContain(MEMORY_GOAL_CUE)
    const group = NUDGES.actionTurn({
      action: 'follow Steve', stopTool: 'unfollow', playerLine: 'we are building a house, ok?', who: 'Steve',
      voice: true, peers: ['Sui'],
    })
    expect(group).toContain(MEMORY_GOAL_CUE)
  })

  it('does not leak into the silent-monitor tick (no player message, no cue)', () => {
    const silent = NUDGES.actionTurn({ action: 'gather oak_log', stopTool: 'end_loop', elapsedSec: 12 })
    expect(silent).not.toContain('setGoal in the same turn')
  })
})

// 261123 (pass 61): a line the player keeps saying while she is already by
// their side (orchestrator repeatedAskFor) takes actionTurn without the
// reply mandate; the default keeps it.
describe('NUDGES.actionTurn replyOptional', () => {
  const MANDATE = /also answer with one short say\(\)|also call say\(\) this turn|That say\(\) is required/
  it('drops the say() mandate mid-action and when idle', () => {
    const running = NUDGES.actionTurn({ action: 'follow Alex', stopTool: 'unfollow', playerLine: 'stay close pls', who: 'player (Alex)', replyOptional: true })
    expect(running).not.toMatch(MANDATE)
    expect(running).toContain('A line you only put in your text is not sent to the player.')
    const idle = NUDGES.actionTurn({ action: null, stopTool: 'stop', playerLine: 'stay close pls', who: 'player (Alex)', replyOptional: true })
    expect(idle).not.toMatch(MANDATE)
    expect(idle).toContain('You are not in the middle of anything.')
  })
  it('keeps it by default', () => {
    expect(NUDGES.actionTurn({ action: 'follow Alex', stopTool: 'unfollow', playerLine: 'stay close pls', who: 'player (Alex)' })).toMatch(MANDATE)
    expect(NUDGES.actionTurn({ action: null, stopTool: 'stop', playerLine: 'stay close pls', who: 'player (Alex)' })).toMatch(MANDATE)
  })
})
