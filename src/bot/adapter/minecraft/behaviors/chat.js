/**
 * Chat behavior: emits sei:chat_received when the player chats, addresses
 * the bot, or speaks nearby. Responses are LLM-generated.
 *
 * Stop-verb fast path: when the player says stop/halt/cancel/nevermind, we
 * hard-cancel the body BEFORE dispatch — the body stops immediately rather
 * than waiting for the next LLM turn to abort it. The chat message still
 * flows through normal dispatch so the LLM acknowledges in-character;
 * no hardcoded confirmation string.
 */
import { logChatIn } from '../../../brain/log.js'

const STOP_VERBS = new Set(['stop', 'halt', 'cancel', 'nevermind', 'never mind'])

function forceCancelBody(bot) {
  try { bot.stopDigging?.() } catch {}
  try { bot.pathfinder?.stop?.() } catch {}
  try { bot.clearControlStates?.() } catch {}
}

// 260618: whole-word, case-insensitive name match. Minecraft names are
// [A-Za-z0-9_], so we require the name not be glued to other name characters —
// "sui" matches "sui go" and "hey sui!" but NOT "suit" or "result". Used to tell
// whether a message is aimed at this bot or at one of its sibling companions.
function mentionsName(message, name) {
  if (!name) return false
  const esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  try { return new RegExp(`(^|[^a-z0-9_])${esc}([^a-z0-9_]|$)`, 'i').test(String(message)) }
  catch { return String(message).toLowerCase().includes(String(name).toLowerCase()) }
}

export function startChat(bot, config, orchestrator = null) {
  // Mineflayer's high-level `chat` event is fired by a DEPRECATED catch-all
  // pattern (LEGACY_VANILLA_CHAT_REGEX) that runs against EVERY `messagestr` —
  // including systemChat lines (Minecraft command feedback like "Set own game
  // mode to Creative Mode" after the player runs /gamemode). Those loosely match
  // the pattern and arrive here looking exactly like a player chat, so the model
  // was told "the player just spoke to you, respond to THIS" and treated game
  // output as an instruction. Capture the position of the message that is about
  // to be parsed so the `chat` handler can tell real player speech ('chat') from
  // system/command output ('system' | 'game_info'). prependListener so this runs
  // BEFORE mineflayer's pattern matcher (also a `messagestr` listener) emits `chat`.
  let _lastMsgPosition = 'chat'
  const onMessageStr = (_text, position) => { _lastMsgPosition = position || 'chat' }
  if (typeof bot.prependListener === 'function') bot.prependListener('messagestr', onMessageStr)
  else bot.on('messagestr', onMessageStr)

  bot.on('chat', (username, message) => {
    if (username === bot.username) return

    // System / command-feedback messages are NOT the player speaking to the bot.
    // The most common case is the player running a Minecraft command (/gamemode,
    // /time, /give, /tp ...): the server echoes a feedback line that we relabel
    // as the player running a command and surface as recorded-but-non-interrupting
    // context, so the model knows it happened without mistaking it for an
    // instruction directed at it.
    if (_lastMsgPosition && _lastMsgPosition !== 'chat') {
      const who = config.player_display_name || (username && username !== bot.username ? username : null) || 'the player'
      const labeled = `ran a command (in-game, not a message or instruction to you): ${String(message).trim()}`
      logChatIn(who, labeled)
      const payload = { username: who, message: labeled, addressed: false, playerSpoke: false, suppressInterrupt: true }
      if (bot._seiDebouncer) {
        bot._seiDebouncer.debounce(`cmd:${who}`, payload, (p) => bot.emit('sei:chat_received', p))
      } else {
        bot.emit('sei:chat_received', payload)
      }
      return
    }

    logChatIn(username, message)

    // v1.0 is single-human LAN, but more than one AI companion can share the
    // world. The roster of OTHER companion usernames is pushed from main (see
    // bot/index.js setCompanions) onto the parsed config, which is stable across
    // reconnects and readable here even though this path has no orchestrator.
    const roster = Array.isArray(config?._seiCompanions) ? config._seiCompanions : []
    const fromCompanion = roster.some(c => c && c.toLowerCase() === String(username).toLowerCase())

    const playerSpoke = !fromCompanion
    // Substitute the in-game username with the preferred display name before
    // anything the LLM reads — but ONLY for the human. A sibling AI companion
    // keeps its own in-game name, otherwise the bot would think its teammate's
    // chatter came from the player.
    const displayName = fromCompanion ? username : (config.player_display_name || username)

    try { orchestrator?.recordIncomingChat?.(displayName, message) } catch {}

    const addressed = mentionsName(message, bot.username)
    const addressedToSibling = roster.some(c => mentionsName(message, c))
    // M1: this bot is NOT the intended recipient when the message names ONLY a
    // sibling (let that companion field it) or a fellow bot is just chattering
    // (don't wake on teammate small-talk → no bot-to-bot ping-pong loop).
    // EXCEPTION (260619): a companion that addresses THIS bot BY NAME ("marv,
    // mine that stone") is a DIRECTED request and DOES wake us. The player can
    // delegate task-giving to a teammate ("sui, give marv tasks. marv, listen to
    // sui"), and a sibling's by-name command is exactly that — blanket-suppressing
    // it left the directed bot idle while its teammate kept asking (the Marv
    // multi-agent deadlock). Only UN-addressed companion chatter stays
    // record-but-no-wake, which still blocks the ping-pong loop (an acknowledgement
    // that doesn't name anyone never wakes the other bot).
    // So suppress reduces to: a line that does NOT name this bot AND is either a
    // teammate talking or a message aimed at a sibling. Either way the line is
    // still recorded to chat history (brain.onChat records before it checks this
    // flag), so a suppressed line still surfaces on the next wake — it just
    // doesn't interrupt.
    const suppressInterrupt = !addressed && (fromCompanion || addressedToSibling)

    // Stop-verb fast path: cancel the body immediately so dig/pathfind/etc.
    // release before the LLM turn fires. Falls through to normal dispatch
    // so the LLM still sees the chat and can respond in-character. Skipped for a
    // sibling bot's chatter (a teammate saying "stop" must not halt this bot).
    if (playerSpoke && orchestrator) {
      const trimmed = String(message).trim().toLowerCase()
      if (STOP_VERBS.has(trimmed)) {
        forceCancelBody(bot)
        try { orchestrator.currentLoop?.abortController?.abort() } catch {}
        // Fall through to dispatch — LLM acknowledges in its own voice.
      }
    }

    // Check proximity (within 20 blocks)
    const speaker = bot.players[username]
    const botPos = bot.entity?.position
    let nearby = false
    if (speaker?.entity && botPos) {
      nearby = speaker.entity.position.distanceTo(botPos) <= 20
    }

    // Emit (so the line reaches the brain to be recorded) whenever someone is
    // talking or nearby. `suppressInterrupt` then tells the brain to record but
    // not wake. We always emit for a sibling so its chatter still lands in
    // history even when it doesn't interrupt.
    if (playerSpoke || addressed || nearby || fromCompanion) {
      const payload = { username: displayName, message, addressed, playerSpoke, suppressInterrupt }
      if (bot._seiDebouncer) {
        bot._seiDebouncer.debounce(`chat:${displayName}`, payload, (p) => bot.emit('sei:chat_received', p))
      } else {
        bot.emit('sei:chat_received', payload)
      }
    }
  })
}
