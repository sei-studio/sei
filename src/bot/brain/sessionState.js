/**
 * Session lifecycle — player identity recognition + per-session counters.
 *
 * Owns:
 *   - cached PlayerData (loaded once at construction; updated on each
 *     player encounter and persisted via savePlayer)
 *   - active player UUID (null when the human player is offline)
 *
 * Recognition rules:
 *   1. Warm path — PLAYER.md exists with player_uuid → recognize by UUID.
 *   2. Fallback — PLAYER.md exists but player_uuid is null → match by
 *      config.player_username, capture UUID.
 *   3. Cold — no PLAYER.md → match by config.player_username, create file.
 *
 * Spawn timing: bot.players populates a few server ticks after `spawn`.
 * onSpawn schedules a deferred check (config.memory.spawn_settle_delay_ms,
 * default 500ms). Belt-and-suspenders: if the player is absent after the
 * delay, attach a one-shot `playerJoined` listener that fires on join.
 *
 * Sessions are bounded by player presence, not bot connection. A process
 * crash mid-session counts as a session boundary in v1.
 */

import { loadPlayer, savePlayer } from './memory/player.js'

export async function createSessionState({ playerMdPath, config, bot, logger = console } = {}) {
  if (!playerMdPath) throw new Error('createSessionState: playerMdPath required')
  if (!config) throw new Error('createSessionState: config required')
  if (!bot) throw new Error('createSessionState: bot required')

  let playerData = await loadPlayer(playerMdPath)
  let activePlayerUuid = null
  let onSpawnLatePlayerListener = null

  const playerUsername = config.player_username
  const settleDelayMs = config.memory?.spawn_settle_delay_ms ?? 500

  function recognize(player) {
    if (playerData.exists && playerData.player_uuid && player.uuid === playerData.player_uuid) {
      return 'warm'
    }
    if (playerData.exists && !playerData.player_uuid && player.username === playerUsername) {
      return 'fallback'
    }
    if (!playerData.exists && player.username === playerUsername) {
      return 'cold'
    }
    return null
  }

  async function fireSessionStart(player, recognition) {
    const now = new Date().toISOString()
    if (recognition === 'cold') {
      playerData = {
        exists: true,
        player_uuid: player.uuid,
        player_username: player.username,
        first_seen: now,
        last_seen: now,
        total_sessions: 1,
        preferred_name: null,
        pronouns: null,
        notes: '',
      }
    } else {
      playerData = {
        ...playerData,
        exists: true,
        player_uuid: playerData.player_uuid ?? player.uuid,
        player_username: player.username,
        first_seen: playerData.first_seen ?? now,
        last_seen: now,
        total_sessions: (playerData.total_sessions ?? 0) + 1,
      }
    }
    await savePlayer(playerMdPath, playerData)
    activePlayerUuid = playerData.player_uuid
    logger.info?.(`[sei/session] start uuid=${activePlayerUuid} username=${player.username} session_count=${playerData.total_sessions} path=${recognition}`)
  }

  async function onPlayerJoined(player) {
    if (!player || !player.uuid) return
    // Idempotency: spawn synthesizes onPlayerJoined for an already-present
    // player, and mineflayer ALSO emits a real playerJoined. Skip duplicates.
    if (player.uuid === activePlayerUuid) return
    const recognition = recognize(player)
    if (!recognition) return
    try { await fireSessionStart(player, recognition) }
    catch (err) { logger.warn?.(`[sei/session] onPlayerJoined save failed: ${err.message}`) }
  }

  async function onPlayerLeft(player) {
    if (!player || !player.uuid) return
    if (player.uuid !== activePlayerUuid) return

    const now = new Date().toISOString()
    playerData = { ...playerData, last_seen: now }
    try { await savePlayer(playerMdPath, playerData) }
    catch (err) { logger.warn?.(`[sei/session] onPlayerLeft save failed: ${err.message}`) }
    logger.info?.(`[sei/session] end uuid=${activePlayerUuid}`)
    activePlayerUuid = null
  }

  function findPlayerInPlayers() {
    if (!bot.players) return null
    if (playerData.player_uuid) {
      const username = bot.uuidToUsername?.[playerData.player_uuid]
      if (username && bot.players[username]) return bot.players[username]
    }
    if (playerUsername && bot.players[playerUsername]) return bot.players[playerUsername]
    return null
  }

  async function checkPlayerPresent() {
    const player = findPlayerInPlayers()
    if (!player) {
      if (!onSpawnLatePlayerListener && typeof bot.once === 'function') {
        onSpawnLatePlayerListener = (p) => {
          onSpawnLatePlayerListener = null
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
      setTimeout(() => { checkPlayerPresent().finally(resolve) }, settleDelayMs)
    })
  }

  // No-op kept for the dispatch path that still calls it.
  async function onLoopTerminal() { /* no-op */ }

  function playerPresent() { return activePlayerUuid != null }
  function playerDataSnapshot() { return { ...playerData } }

  return {
    onPlayerJoined,
    onPlayerLeft,
    onSpawn,
    onLoopTerminal,
    playerPresent,
    playerData: playerDataSnapshot,
    _internal: {
      get playerData() { return playerData },
      get activePlayerUuid() { return activePlayerUuid },
    },
  }
}
