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
//
// 260731 — the floor is now OFF by default (IDLE_SAY_GAP_MS === 0), because
// timestamps alone cannot tell a reworded repeat from a new thought and it was
// killing invitations to play together. The mechanics below are still pinned
// against an EXPLICIT gap so restoring it is a one-constant change; the last
// two cases pin the disabled default itself.

import { describe, it, expect } from 'vitest'
import { shouldSuppressIdleSay, IDLE_SAY_GAP_MS } from './orchestrator.js'

const NOW = 1_800_000_000_000
const GAP = 45_000
const said = (secondsAgo, text = 'all good on your end now?') => ({ at: NOW - secondsAgo * 1000, text })

describe('shouldSuppressIdleSay', () => {
  it('gags an idle tick that speaks again inside the gap with no answer', () => {
    expect(shouldSuppressIdleSay({
      triggerEvent: 'sei:idle',
      lastSelf: said(10),
      lastPlayer: null,
      now: NOW,
      gapMs: GAP,
    })).toBe(true)
  })

  it('lets it speak once the gap has passed — an unanswered line gets to stand, not to be forever', () => {
    expect(shouldSuppressIdleSay({
      triggerEvent: 'sei:idle',
      lastSelf: said(GAP / 1000 + 1),
      lastPlayer: null,
      now: NOW,
      gapMs: GAP,
    })).toBe(false)
  })

  it('the player answering re-opens the floor immediately', () => {
    expect(shouldSuppressIdleSay({
      triggerEvent: 'sei:idle',
      lastSelf: said(10),
      lastPlayer: { at: NOW - 2000, text: 'almost done' },
      now: NOW,
      gapMs: GAP,
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
      gapMs: GAP,
    })).toBe(true)
  })

  it('loop_end settle ticks are gated the same way', () => {
    expect(shouldSuppressIdleSay({
      triggerEvent: 'sei:loop_end',
      lastSelf: said(3),
      lastPlayer: null,
      now: NOW,
      gapMs: GAP,
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
        gapMs: GAP,
      })).toBe(false)
    })
  }

  it('the first line of a session is never gagged (nothing said yet)', () => {
    expect(shouldSuppressIdleSay({
      triggerEvent: 'sei:idle',
      lastSelf: null,
      lastPlayer: null,
      now: NOW,
      gapMs: GAP,
    })).toBe(false)
  })

  // 260731: the shipped configuration. Restoring the floor means giving
  // IDLE_SAY_GAP_MS a non-zero value again, and nothing else.
  it('is DISABLED in the shipped configuration', () => {
    expect(IDLE_SAY_GAP_MS).toBe(0)
  })

  it('a zero gap never gags anything, including the case it was written for', () => {
    expect(shouldSuppressIdleSay({
      triggerEvent: 'sei:idle',
      lastSelf: said(4, 'that means everything to me, actually'),
      lastPlayer: null,
      now: NOW,
    })).toBe(false)
  })
})
