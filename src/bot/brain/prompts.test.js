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
    expect(SESSION_END_CLAUSE).toContain('quit')
    expect(SESSION_END_CLAUSE).toContain('farewell')
    expect(SESSION_END_CLAUSE).toContain('ENDING THE SESSION')
    expect(SESSION_END_CLAUSE).toMatch(/"bye"/)
    expect(SESSION_END_CLAUSE).toMatch(/"cya"/)
  })
  it('is reused verbatim in NUDGES.playerInterruptHint rather than a divergent copy', () => {
    expect(NUDGES.playerInterruptHint).toContain(SESSION_END_CLAUSE)
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
