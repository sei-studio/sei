// src/bot/adapter/minecraft/behaviors/pause.js — the body freeze behind the
// in-app play/pause button (260725).
//
// Pausing the BRAIN (orchestrator.setGamePaused + the FSM queue hold) stops
// LLM turns and aborts the in-flight action, but the adapter runs several
// autonomous loops that never touch the brain at all: follow's 1s trailing
// tick, the reflex evasion loop, combat retaliation, the survival swim-up /
// retreat, cosmetic gaze, and the auto-eat plugin. Left alone they keep the
// body walking, dodging, swinging and eating while the UI says "Paused".
//
// This module is the single freeze switch. It flips `bot._seiPaused` (every
// one of those loops early-returns on it) and, on engage, puts the body at
// rest: pathfinder goal dropped, all control states released, digging and
// item use stopped, auto-eat disabled. The result is a player standing AFK at
// their keyboard: still loaded in the world, still takes damage, does nothing.
//
// The desired state is module-scoped (not just a flag on the bot instance) so
// a reconnect — which builds a FRESH mineflayer bot while the brain stays
// paused — can re-apply it from connect.js's spawn wiring (applyWorldPause).
//
// Unpausing does NOT re-issue anything: the loops simply resume (follow still
// holds its target, so trailing picks back up) and the orchestrator's resume
// idle tick tells the model what it was mid-way through.

let _paused = false

/** True while the player has the game paused. */
export function isWorldPaused() {
  return _paused
}

/**
 * Freeze (or release) the body. Idempotent per state.
 * @param {object} bot   mineflayer Bot
 * @param {boolean} paused
 */
export function setWorldPaused(bot, paused) {
  const next = paused === true
  _paused = next
  if (!bot) return
  bot._seiPaused = next
  if (!next) {
    // Release: re-arm the plugin loops we switched off. The behavior ticks
    // resume on their own next fire.
    try { bot.autoEat?.enableAuto?.() } catch (_) {}
    return
  }
  // Engage: come to a full stop. Every call is guarded — a half-connected bot
  // (no pathfinder yet, socket already gone) must never throw out of a pause.
  try { bot.pathfinder?.setGoal(null) } catch (_) {}
  try { bot.pathfinder?.stop() } catch (_) {}
  try { bot.clearControlStates?.() } catch (_) {}
  try { bot.stopDigging?.() } catch (_) {}
  try { bot.deactivateItem?.() } catch (_) {}
  try { bot.autoEat?.disableAuto?.() } catch (_) {}
  // Drop the goal-ownership mutexes the reflex/survival loops may be holding,
  // so nothing restores a saved goal behind the freeze. Their own paused
  // branches do the same on their next tick; this makes the freeze immediate.
  bot._seiReflexActive = false
  bot._seiSavedGoal = null
  bot._seiSurvivalActive = false
  bot._seiSurvivalSavedGoal = null
  bot._seiCriticalRetreat = false
  bot._seiOffensiveTarget = null
}

/**
 * Re-apply the current pause state to a (possibly new) bot instance. Called
 * from connect.js on every spawn so a reconnect while paused comes back frozen
 * instead of quietly resuming autonomous movement.
 */
export function applyWorldPause(bot) {
  if (!bot) return
  setWorldPaused(bot, _paused)
}
