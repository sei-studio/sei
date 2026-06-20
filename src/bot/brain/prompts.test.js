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
} from './prompts.js'

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
