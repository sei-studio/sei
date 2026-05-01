/**
 * Session lifecycle state (Phase 3 D-56 / D-57 / D-58).
 *
 * Owns:
 *   - cached OwnerData (loaded once at construction; updated on each
 *     owner-encounter and persisted via saveOwner)
 *   - active owner UUID (null when owner is offline)
 *   - per-loop-batch counters (loopCount, cumulativeLoopBytes) reserved for
 *     Plan 3-03 to consume
 *   - sessionsSinceConsolidation counter (Plan 3-03 trigger)
 *
 * Recognition rules (D-48):
 *   1. Warm path — OWNER.md exists with owner_uuid → recognize by UUID
 *      (username changes don't break recognition).
 *   2. Fallback — OWNER.md exists but owner_uuid is null (hand-edited file)
 *      → match by config.owner_username, capture UUID.
 *   3. Cold — no OWNER.md → match by config.owner_username, create file
 *      with first_seen=now, total_sessions=1.
 *
 * Spawn timing (D-57 / Pitfall 2): bot.players populates a few server ticks
 * after `spawn` — onSpawn schedules a deferred check (config.memory.
 * spawn_settle_delay_ms, default 500ms). Belt-and-suspenders: if owner is
 * absent after the delay, attach a one-shot `playerJoined` listener that
 * fires session-start when the owner does appear.
 *
 * D-58: bot.on('end') does NOT call this module. Sessions are bounded by
 * owner presence, not bot connection. A process crash mid-owner-session
 * counts as a session boundary in v1 (deferred to V2 — see CONTEXT line 196).
 */

import { loadOwner, saveOwner } from '../memory/owner.js'

/**
 * @param {Object} opts
 * @param {string} opts.ownerMdPath
 * @param {Object} opts.diary  — Diary instance from createDiary()
 * @param {Object} opts.config
 * @param {Object} opts.bot    — mineflayer bot (or stub with players, on/once)
 * @param {{info?:Function,warn?:Function,error?:Function,debug?:Function}} [opts.logger]
 */
export async function createSessionState({ ownerMdPath, diary, config, bot, logger = console } = {}) {
  if (!ownerMdPath) throw new Error('createSessionState: ownerMdPath required')
  if (!diary) throw new Error('createSessionState: diary required')
  if (!config) throw new Error('createSessionState: config required')
  if (!bot) throw new Error('createSessionState: bot required')

  let ownerData = await loadOwner(ownerMdPath)
  let activeOwnerUuid = null
  let loopCount = 0
  let cumulativeLoopBytes = 0
  let sessionsSinceConsolidation = 0
  let onSpawnLatePlayerListener = null

  const ownerUsername = config.owner_username
  const settleDelayMs = config.memory?.spawn_settle_delay_ms ?? 500

  function recognize(player) {
    // Returns 'warm' | 'fallback' | 'cold' | null
    if (ownerData.exists && ownerData.owner_uuid && player.uuid === ownerData.owner_uuid) {
      return 'warm'
    }
    if (ownerData.exists && !ownerData.owner_uuid && player.username === ownerUsername) {
      return 'fallback'
    }
    if (!ownerData.exists && player.username === ownerUsername) {
      return 'cold'
    }
    return null
  }

  async function fireSessionStart(player, recognition) {
    const now = new Date().toISOString()
    if (recognition === 'cold') {
      ownerData = {
        exists: true,
        owner_uuid: player.uuid,
        owner_username: player.username,
        first_seen: now,
        last_seen: now,
        total_sessions: 1,
        preferred_name: null,
        pronouns: null,
        notes: '',
      }
    } else {
      // warm or fallback
      ownerData = {
        ...ownerData,
        exists: true,
        owner_uuid: ownerData.owner_uuid ?? player.uuid,
        owner_username: player.username,
        first_seen: ownerData.first_seen ?? now,
        last_seen: now,
        total_sessions: (ownerData.total_sessions ?? 0) + 1,
      }
    }
    await saveOwner(ownerMdPath, ownerData)
    activeOwnerUuid = ownerData.owner_uuid
    loopCount = 0
    cumulativeLoopBytes = 0
    sessionsSinceConsolidation += 1
    logger.info?.(`[sei/session] start uuid=${activeOwnerUuid} username=${player.username} session_count=${ownerData.total_sessions} path=${recognition}`)
  }

  async function onPlayerJoined(player) {
    if (!player || !player.uuid) return
    const recognition = recognize(player)
    if (!recognition) return
    try {
      await fireSessionStart(player, recognition)
    } catch (err) {
      logger.warn?.(`[sei/session] onPlayerJoined save failed: ${err.message}`)
    }
  }

  async function onPlayerLeft(player) {
    if (!player || !player.uuid) return
    if (player.uuid !== activeOwnerUuid) return
    const now = new Date().toISOString()
    ownerData = { ...ownerData, last_seen: now }
    try { await saveOwner(ownerMdPath, ownerData) }
    catch (err) { logger.warn?.(`[sei/session] onPlayerLeft save failed: ${err.message}`) }
    logger.info?.(`[sei/session] end uuid=${activeOwnerUuid}`)
    activeOwnerUuid = null
    loopCount = 0
    cumulativeLoopBytes = 0
    // Plan 3-03 will hook here for the final flush of any uncompacted entries.
  }

  function findOwnerInPlayers() {
    if (!bot.players) return null
    if (ownerData.owner_uuid) {
      const username = bot.uuidToUsername?.[ownerData.owner_uuid]
      if (username && bot.players[username]) return bot.players[username]
    }
    if (ownerUsername && bot.players[ownerUsername]) return bot.players[ownerUsername]
    return null
  }

  async function checkOwnerPresent() {
    const player = findOwnerInPlayers()
    if (!player) {
      // Belt-and-suspenders: attach a one-shot playerJoined listener so we
      // don't miss the owner connecting shortly after Sei spawned (Pitfall 2).
      if (!onSpawnLatePlayerListener && typeof bot.once === 'function') {
        onSpawnLatePlayerListener = (p) => {
          onSpawnLatePlayerListener = null
          // Defer to onPlayerJoined which handles recognition.
          onPlayerJoined(p).catch(err => logger.warn?.(`[sei/session] late playerJoined failed: ${err.message}`))
        }
        bot.once('playerJoined', onSpawnLatePlayerListener)
      }
      return
    }
    await onPlayerJoined({ uuid: player.uuid, username: player.username })
  }

  async function onSpawn() {
    return new Promise((resolve) => {
      setTimeout(() => {
        checkOwnerPresent().finally(resolve)
      }, settleDelayMs)
    })
  }

  async function onLoopTerminal({ messagesByteSize } = {}) {
    loopCount += 1
    if (Number.isFinite(messagesByteSize)) cumulativeLoopBytes += messagesByteSize
    logger.info?.(`[sei/session] loop terminal loop_count=${loopCount} cumulative_bytes=${cumulativeLoopBytes}`)
    // Plan 3-03 will subscribe here for the per-loop-batch summary trigger.
    // Plan 3-02 maintains counters only — no disk writes from this hook.
  }

  function ownerPresent() { return activeOwnerUuid != null }

  function currentSessionLoopBatch() {
    return {
      loopCount,
      cumulativeBytes: cumulativeLoopBytes,
      sessionsSinceConsolidation,
    }
  }

  function ownerDataSnapshot() {
    return { ...ownerData }
  }

  /**
   * Reset the per-loop-batch counters. Reserved for Plan 3-03 to call after
   * a successful per-loop-batch DIARY write. Plan 3-02 itself never invokes
   * this — it's the seam.
   */
  function resetLoopBatchCounters() {
    loopCount = 0
    cumulativeLoopBytes = 0
  }

  return {
    onPlayerJoined,
    onPlayerLeft,
    onSpawn,
    onLoopTerminal,
    ownerPresent,
    currentSessionLoopBatch,
    ownerData: ownerDataSnapshot,
    resetLoopBatchCounters,
    _internal: {
      get ownerData() { return ownerData },
      get activeOwnerUuid() { return activeOwnerUuid },
      get loopCount() { return loopCount },
      get cumulativeLoopBytes() { return cumulativeLoopBytes },
      get sessionsSinceConsolidation() { return sessionsSinceConsolidation },
    },
  }
}
