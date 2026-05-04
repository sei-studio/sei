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

// 260502-h6i: diary writes must be gated on observable world-state mutation.
// A loop is "mutating" when its assistant turns invoke any of these actions
// directly (or `goTo` with an `ok` result — failures don't count).
const MUTATING_ACTIONS = new Set([
  'dig','placeBlock','attackEntity','dropItem','depositItem','withdrawItem',
  'consumeItem','activateItem','equip','sleep','openContainer',
])

/**
 * Walk a Loop's canonical messages array (assistant turns + paired
 * user-tool-result turns) and decide whether any mutating action ran.
 * `goTo` is mutating only when the matching tool_result content begins
 * with `goTo:ok` — `goTo:fail` and aborted variants are non-mutating.
 */
function loopHasMutation(loopMessages) {
  if (!Array.isArray(loopMessages)) return false
  // Index tool_results by tool_use_id for O(1) lookup.
  const resultById = new Map()
  for (const msg of loopMessages) {
    if (!msg || msg.role !== 'user' || !Array.isArray(msg.content)) continue
    for (const blk of msg.content) {
      if (blk && blk.type === 'tool_result' && blk.tool_use_id) {
        const c = blk.content
        const text = typeof c === 'string'
          ? c
          : Array.isArray(c) ? c.map(b => b && b.text).filter(Boolean).join(' ') : ''
        resultById.set(blk.tool_use_id, text)
      }
    }
  }
  for (const msg of loopMessages) {
    if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) continue
    for (const blk of msg.content) {
      if (!blk || blk.type !== 'tool_use') continue
      if (MUTATING_ACTIONS.has(blk.name)) return true
      if (blk.name === 'goTo') {
        const r = resultById.get(blk.id) ?? ''
        if (typeof r === 'string' && r.startsWith('goTo:ok')) return true
      }
    }
  }
  return false
}

/**
 * @param {Object} opts
 * @param {string} opts.ownerMdPath
 * @param {Object} opts.diary  — Diary instance from createDiary()
 * @param {Object} [opts.compactor] — Plan 3-03 compactor
 *   ({ summarizeLoopBatch, consolidateOlderHalf }). Optional — when omitted,
 *   onLoopTerminal / onPlayerLeft only update counters (Plan 3-02 behavior).
 * @param {Object} opts.config
 * @param {Object} opts.bot    — mineflayer bot (or stub with players, on/once)
 * @param {{info?:Function,warn?:Function,error?:Function,debug?:Function}} [opts.logger]
 */
export async function createSessionState({ ownerMdPath, diary, compactor: initialCompactor = null, config, bot, logger = console } = {}) {
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
  // Plan 3-03: compactor binding. May be set at construction (tests) or
  // injected later via setCompactor(...) — bot.js needs the orchestrator's
  // cachedSystemBlocks before it can construct the compactor, so the bot.js
  // wiring path uses the setter.
  let compactor = initialCompactor
  // Plan 3-03: accumulate Loop.messages arrays since the last DIARY write.
  // Flushed (and reset) on a successful summarizeLoopBatch.
  let loopBatchMessages = []
  // 260502-h6i: only flush a loop-batch summary when at least one Loop in
  // the batch performed a mutating action. Pure say/setGoals/lookAt loops
  // (e.g. the bot answering "hi") would otherwise cause Haiku to confabulate
  // a diary entry from the seed text.
  let batchHasMutation = false
  // Pitfall 6 / Pitfall 7: single-flight gate for async consolidation —
  // prevents two consolidation passes from racing on DIARY.md.
  let consolidationLock = false

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

    // D-56 session-end flush: fire summarizeLoopBatch for any pending,
    // uncompacted loops BEFORE we tear down the session. 260502-h6i: only
    // when the residual batch contains at least one mutating action — a
    // pure-chat-only session leaves no diary entry behind.
    if (compactor && (loopCount > 0 || cumulativeLoopBytes > 0)) {
      if (!batchHasMutation) {
        logger.info?.('[sei/session] session-end flush skipped — no mutation observed in residual batch')
        loopCount = 0
        cumulativeLoopBytes = 0
        loopBatchMessages = []
        batchHasMutation = false
      } else {
        try {
          const result = await compactor.summarizeLoopBatch({
            loopMessagesBatch: loopBatchMessages.flat(),
            when: new Date(),
          })
          if (result) {
            loopCount = 0
            cumulativeLoopBytes = 0
            loopBatchMessages = []
            batchHasMutation = false
          } else {
            logger.warn?.('[sei/session] session-end flush: summary failed; leaving batch for next session')
          }
        } catch (err) {
          logger.warn?.(`[sei/session] session-end flush failed: ${err.message}`)
        }
      }
    }

    // D-53 session-count consolidation trigger. Async fire-and-forget — we
    // intentionally do NOT await so onPlayerLeft remains non-blocking even
    // when the Anthropic call takes seconds.
    if (
      compactor &&
      sessionsSinceConsolidation >= (config.memory?.sessions_per_consolidation ?? Infinity) &&
      !consolidationLock
    ) {
      consolidationLock = true
      compactor.consolidateOlderHalf({})
        .then(success => { if (success) sessionsSinceConsolidation = 0 })
        .catch(err => logger.warn?.(`[sei/session] consolidation rejected: ${err.message}`))
        .finally(() => { consolidationLock = false })
      // intentionally NOT awaited — fire-and-forget per D-53
    }

    const now = new Date().toISOString()
    ownerData = { ...ownerData, last_seen: now }
    try { await saveOwner(ownerMdPath, ownerData) }
    catch (err) { logger.warn?.(`[sei/session] onPlayerLeft save failed: ${err.message}`) }
    logger.info?.(`[sei/session] end uuid=${activeOwnerUuid}`)
    activeOwnerUuid = null
    loopCount = 0
    cumulativeLoopBytes = 0
    loopBatchMessages = []
    batchHasMutation = false
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

  async function onLoopTerminal({ messagesByteSize, loopMessages, event } = {}) {
    loopCount += 1
    if (Number.isFinite(messagesByteSize)) cumulativeLoopBytes += messagesByteSize
    if (Array.isArray(loopMessages)) loopBatchMessages.push(loopMessages)
    // 260502-h6i: track mutation across the whole batch. A non-mutating loop
    // alone never trips the diary trigger; a single mutating loop in the
    // batch makes the entire pending batch eligible to flush.
    if (loopHasMutation(loopMessages)) batchHasMutation = true
    logger.info?.(`[sei/session] loop terminal loop_count=${loopCount} cumulative_bytes=${cumulativeLoopBytes}`)

    // Diary compaction is gated to idle-driven loops only. Compacting in the
    // middle of a chat exchange (or right after a join greeting) leaks the
    // freshly-summarized memory back into the next reply and biases the LLM
    // away from what the player just said. Counters and batched messages
    // still accumulate above; we just defer the actual write until the bot
    // returns to idle.
    const isIdleEvent = event === 'sei:idle' || event === 'idle'

    if (compactor && isIdleEvent) {
      // D-51: per-loop-batch summary trigger. Fires when EITHER the loop
      // count cap is hit OR the accumulated bytes cap is hit.
      const loopCap  = config.memory?.loop_batch_loop_count_cap  ?? Infinity
      const bytesCap = config.memory?.loop_batch_context_cap_bytes ?? Infinity
      if (loopCount >= loopCap || cumulativeLoopBytes >= bytesCap) {
        if (!batchHasMutation) {
          // 260502-h6i: cadence cap fired but the entire batch was non-
          // mutating chat. Drop the batch and reset counters so non-mutating
          // history doesn't grow unbounded — and skip the diary write so
          // Haiku doesn't confabulate an entry from the seed text.
          logger.info?.('[sei/session] loop-batch cadence hit but no mutation observed — skipping diary write')
          loopCount = 0
          cumulativeLoopBytes = 0
          loopBatchMessages = []
          // batchHasMutation already false; no reset needed.
        } else {
          try {
            const result = await compactor.summarizeLoopBatch({
              loopMessagesBatch: loopBatchMessages.flat(),
              when: new Date(),
            })
            if (result) {
              // Successful DIARY write — reset counters.
              loopCount = 0
              cumulativeLoopBytes = 0
              loopBatchMessages = []
              batchHasMutation = false
            } else {
              // Pitfall: leave the batch intact for retry on next loop-terminal
              // (T-03-17 documented decision — failed summary doesn't lose data).
              logger.warn?.('[sei/session] loop-batch summary failed; leaving batch for retry')
            }
          } catch (err) {
            logger.warn?.(`[sei/session] loop-batch summary threw: ${err.message}`)
          }
        }
      }

      // D-53 size-pressure consolidation trigger (independent of session
      // count). Async fire-and-forget — single-flight via consolidationLock.
      if (!consolidationLock) {
        let diarySize = 0
        try { diarySize = await diary.getFileSizeBytes() } catch {}
        const sizeCap = config.memory?.diary_size_cap_bytes ?? Infinity
        if (diarySize > sizeCap) {
          consolidationLock = true
          compactor.consolidateOlderHalf({})
            .catch(err => logger.warn?.(`[sei/session] consolidation rejected: ${err.message}`))
            .finally(() => { consolidationLock = false })
          // intentionally NOT awaited — fire-and-forget per D-53
        }
      }
    }
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

  function setCompactor(c) { compactor = c }

  return {
    onPlayerJoined,
    onPlayerLeft,
    onSpawn,
    onLoopTerminal,
    ownerPresent,
    currentSessionLoopBatch,
    ownerData: ownerDataSnapshot,
    resetLoopBatchCounters,
    setCompactor,
    _internal: {
      get ownerData() { return ownerData },
      get activeOwnerUuid() { return activeOwnerUuid },
      get loopCount() { return loopCount },
      get cumulativeLoopBytes() { return cumulativeLoopBytes },
      get sessionsSinceConsolidation() { return sessionsSinceConsolidation },
    },
  }
}
