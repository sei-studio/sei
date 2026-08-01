// 260730 — the unprompted-chatter floor.
//
// Live voice-call log, one minute of it: "just let me know when you're sorted"
// / "cool, i'm just chilling here. take your time" / "all good on your end
// now?" / "cool, i'm here whenever you are". Four idle ticks, four ways of
// saying the same thing, none of them answered, all of them spoken out loud
// while the player was busy in another window. The seed already carries a
// `your_recent_messages` block that asks the model not to do this; Haiku does
// not honour it, so the rule is enforced mechanically here, the same way
// postProcessSay enforces the other say() rules.
//
// The predicate is pure, so this pins the exact conditions rather than a
// scripted session: WHICH turns are gated, and what counts as the player
// having answered.

import { describe, it, expect } from 'vitest'
import { shouldSuppressIdleSay, IDLE_SAY_GAP_MS } from './orchestrator.js'

const NOW = 1_800_000_000_000
const said = (secondsAgo, text = 'all good on your end now?') => ({ at: NOW - secondsAgo * 1000, text })

describe('shouldSuppressIdleSay', () => {
  it('gags an idle tick that speaks again inside the gap with no answer', () => {
    expect(shouldSuppressIdleSay({
      triggerEvent: 'sei:idle',
      lastSelf: said(10),
      lastPlayer: null,
      now: NOW,
    })).toBe(true)
  })

  it('lets it speak once the gap has passed — an unanswered line gets to stand, not to be forever', () => {
    expect(shouldSuppressIdleSay({
      triggerEvent: 'sei:idle',
      lastSelf: said(IDLE_SAY_GAP_MS / 1000 + 1),
      lastPlayer: null,
      now: NOW,
    })).toBe(false)
  })

  it('the player answering re-opens the floor immediately', () => {
    expect(shouldSuppressIdleSay({
      triggerEvent: 'sei:idle',
      lastSelf: said(10),
      lastPlayer: { at: NOW - 2000, text: 'almost done' },
      now: NOW,
    })).toBe(false)
  })

  it('a player line from BEFORE the bot spoke is not an answer', () => {
    // The bot's line was the reply TO this one. Treating any player line in the
    // buffer as an answer would defeat the gate the moment a session had one.
    expect(shouldSuppressIdleSay({
      triggerEvent: 'sei:idle',
      lastSelf: said(10),
      lastPlayer: { at: NOW - 30_000, text: 'gimme a sec' },
      now: NOW,
    })).toBe(true)
  })

  it('loop_end settle ticks are gated the same way', () => {
    expect(shouldSuppressIdleSay({
      triggerEvent: 'sei:loop_end',
      lastSelf: said(3),
      lastPlayer: null,
      now: NOW,
    })).toBe(true)
  })

  // The whole point of the gate is that it costs a REPLY nothing. A player
  // message folded into a running idle loop arrives as the iteration trigger,
  // which is what _emitSayLine passes — so answering is never gagged, however
  // recently the bot spoke.
  for (const trigger of ['sei:chat_received', 'sei:attacked', 'sei:death', 'sei:action_complete', 'sei:action_tick']) {
    it(`${trigger} may always speak`, () => {
      expect(shouldSuppressIdleSay({
        triggerEvent: trigger,
        lastSelf: said(1),
        lastPlayer: null,
        now: NOW,
      })).toBe(false)
    })
  }

  it('the first line of a session is never gagged (nothing said yet)', () => {
    expect(shouldSuppressIdleSay({
      triggerEvent: 'sei:idle',
      lastSelf: null,
      lastPlayer: null,
      now: NOW,
    })).toBe(false)
  })
})
