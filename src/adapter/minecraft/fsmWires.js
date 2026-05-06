// src/adapter/minecraft/fsmWires.js
//
// Mineflayer event wires: subscribe to bot events and translate them into
// AdapterHandlers shape (see src/brain/types.js). Brain-side createPriorityQueue
// then routes those handler calls into the prioritized event pipeline.
//
// The synthesized events (sei:chat_received, sei:attacked, sei:joined,
// sei:loop_terminal) are produced by src/adapter/minecraft/behaviors/{chat,
// combat}.js and src/bot.js / src/brain/orchestrator.js respectively. This
// module is a thin translation layer — no business logic.

/**
 * Wire a mineflayer bot's event surface to a brain-shaped AdapterHandlers
 * object. The handlers receive normalized payloads (e.g. `text` instead of
 * `message`, `attackerLabel` collapsed) so brain code stays game-agnostic.
 *
 * @param {object} bot                              Mineflayer bot instance.
 * @param {import('../../brain/types.js').AdapterHandlers} handlers
 * @param {{ config?: object }} [opts]
 * @returns {() => void} A dispose function that removes every listener.
 */
export function wireBotEvents(bot, handlers, _opts = {}) {
  if (!bot) throw new Error('wireBotEvents: bot required')
  if (!handlers) throw new Error('wireBotEvents: handlers required')

  // ── Chat ────────────────────────────────────────────────────────────
  // chat.js (behaviors/chat.js) does the owner/addressed/nearby filtering
  // and emits sei:chat_received. We translate that synthesized event to
  // handlers.onChat with brain-shaped keys.
  const onSeiChat = (payload) => {
    if (!payload) return
    try {
      handlers.onChat?.({
        username: payload.username,
        text: payload.message ?? payload.text ?? '',
        ownerSpoke: !!payload.ownerSpoke,
        addressed: !!payload.addressed,
        nearby: payload.nearby !== false,  // chat.js only emits when at least one of owner/addressed/nearby holds
      })
    } catch (err) {
      // Swallow listener errors so a brain-side throw doesn't crash mineflayer.
      console.error?.(`[sei/wires] onChat handler threw: ${err && err.message}`)
    }
  }
  bot.on('sei:chat_received', onSeiChat)

  // ── Attacked ────────────────────────────────────────────────────────
  // combat.js emits sei:attacked with the attacker payload pre-classified.
  const onSeiAttacked = (payload) => {
    if (!payload) return
    try {
      handlers.onAttacked?.({
        attacker: payload.attacker ?? null,
        attackerLabel: payload.attackerLabel
          ?? payload.attacker?.username
          ?? payload.attacker?.name
          ?? 'unknown',
        attackerKind: payload.attackerKind
          ?? (payload.attacker?.username ? 'player' : 'mob'),
      })
    } catch (err) {
      console.error?.(`[sei/wires] onAttacked handler threw: ${err && err.message}`)
    }
  }
  bot.on('sei:attacked', onSeiAttacked)

  // ── Player join / leave ─────────────────────────────────────────────
  const onPlayerJoined = (player) => {
    if (!player) return
    try { handlers.onPlayerJoined?.({ username: player.username, uuid: player.uuid }) }
    catch (err) { console.error?.(`[sei/wires] onPlayerJoined handler threw: ${err && err.message}`) }
  }
  const onPlayerLeft = (player) => {
    if (!player) return
    try { handlers.onPlayerLeft?.({ username: player.username, uuid: player.uuid }) }
    catch (err) { console.error?.(`[sei/wires] onPlayerLeft handler threw: ${err && err.message}`) }
  }
  bot.on('playerJoined', onPlayerJoined)
  bot.on('playerLeft', onPlayerLeft)

  // ── Spawn ───────────────────────────────────────────────────────────
  // Forward every spawn (initial + respawn). Brain.start uses the first one
  // for session settle; subsequent spawns are no-ops on the brain side
  // unless wired.
  const onSpawn = () => {
    try { handlers.onSpawn?.() }
    catch (err) { console.error?.(`[sei/wires] onSpawn handler threw: ${err && err.message}`) }
  }
  bot.on('spawn', onSpawn)

  // ── Synthetic events forwarded from orchestrator / bot connect ──────
  // sei:joined fires once on connect (initial greeting nudge).
  // sei:loop_terminal fires when the orchestrator finishes a Loop.
  // sei:loop_end is the follow-up tick the brain enqueues at P2.5.
  // These are reflected back on the bot bus by brain logic; the wires
  // listen so adapter consumers (e.g. logging) can observe them, but the
  // primary consumer is the brain itself which already emits them.

  return function dispose() {
    try { bot.off?.('sei:chat_received', onSeiChat) } catch {}
    try { bot.off?.('sei:attacked', onSeiAttacked) } catch {}
    try { bot.off?.('playerJoined', onPlayerJoined) } catch {}
    try { bot.off?.('playerLeft', onPlayerLeft) } catch {}
    try { bot.off?.('spawn', onSpawn) } catch {}
  }
}
