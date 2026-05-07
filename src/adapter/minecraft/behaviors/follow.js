import { goTo } from './pathfind.js'
import pkg from 'mineflayer-pathfinder'
const { pathfinder } = pkg

let _followInterval = null
let _paused = false
let _inflightProvider = null

// Active follow target. Either { kind: 'player', username } or
// { kind: 'entity', entityId, label }. null = not following.
let _target = null

/** Pause/resume follow ticks. Hard override — used by combat.js when an
 *  attack starts. The inflight provider is the soft default. */
export function pauseFollow(p) { _paused = !!p }

/** Inject a function that returns truthy iff a movement action is currently
 *  running. The follow tick will yield while this returns truthy. */
export function setInflightProvider(fn) {
  _inflightProvider = (typeof fn === 'function') ? fn : null
}

/**
 * Set the follow target. Accepts:
 *   - { kind: 'player', username }
 *   - { kind: 'entity', entityId, label? }
 *   - null to clear
 */
export function setFollowTarget(t) {
  if (t == null) { _target = null; return }
  if (t.kind === 'player' && typeof t.username === 'string') {
    _target = { kind: 'player', username: t.username }
  } else if (t.kind === 'entity' && Number.isFinite(t.entityId)) {
    _target = { kind: 'entity', entityId: t.entityId, label: t.label || `entity-${t.entityId}` }
  }
}

/** Get a short human label for the current follow target (or null). */
export function getFollowTargetLabel() {
  if (!_target) return null
  return _target.kind === 'player' ? _target.username : _target.label
}

/** Returns the underlying mineflayer entity for the active target, or null. */
function resolveTargetEntity(bot) {
  if (!_target) return null
  if (_target.kind === 'player') {
    const p = bot.players?.[_target.username]
    return p?.entity ?? null
  }
  return bot.entities?.[_target.entityId] ?? null
}

export function startFollow(bot, config) {
  if (!bot.hasPlugin(pathfinder)) bot.loadPlugin(pathfinder)

  // Default target: the configured owner (player). LLM can change this via
  // the follow action; the snapshot exposes follow_target so the model is
  // aware of who/what it's following rather than relying on hardcoded behavior.
  if (!_target) setFollowTarget({ kind: 'player', username: config.owner_username })

  _followInterval = setInterval(async () => {
    if (_paused) return
    if (_inflightProvider && _inflightProvider()) return
    if (bot.pathfinder?.isMoving?.()) return

    const ent = resolveTargetEntity(bot)
    if (!ent) return  // target not in render distance / despawned

    const ownerPos = ent.position
    const botPos = bot.entity.position
    const dist = botPos.distanceTo(ownerPos)

    if (dist > config.follow_range) {
      await goTo(bot, ownerPos.x, ownerPos.y, ownerPos.z, config.follow_range, config.pathfinder_timeout_ms)
    }
  }, 1000)
}

export function stopFollow() {
  clearInterval(_followInterval)
  _followInterval = null
  // Plan 03.1-09 (D-H-16): defense-in-depth — also clear the active target so
  // the snapshot's follow_target field reads `(none)` if anyone calls
  // stopFollow directly (e.g. on disconnect/reconnect, or a future explicit-
  // clear pathway). The unfollow registry action already calls
  // setFollowTarget(null); this guarantees the field is always cleared when
  // the follow loop is torn down.
  _target = null
}
