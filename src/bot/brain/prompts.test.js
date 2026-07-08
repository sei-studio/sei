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
import { SESSION_END_CLAUSE } from './promptLibrary.js'

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
