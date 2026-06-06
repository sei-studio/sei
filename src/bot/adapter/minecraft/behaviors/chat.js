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

export function startChat(bot, config, orchestrator = null) {
  bot.on('chat', (username, message) => {
    if (username === bot.username) return
    logChatIn(username, message)

    // v1.0 is single-human LAN. We no longer gate "is this the owner?" on a
    // username match — the GUI "Name" need not equal the in-game name, and
    // mc_username is no longer collected. Any non-bot chatter (the early
    // return above already excludes the bot itself) is treated as the player.
    const playerSpoke = true
    // Substitute the in-game username with the preferred display name before
    // anything the LLM reads (chat events, convo memory), so the bot addresses
    // the player by the GUI-set name rather than their raw gamertag.
    const displayName = config.player_display_name || username

    try { orchestrator?.recordIncomingChat?.(displayName, message) } catch {}

    // Stop-verb fast path: cancel the body immediately so dig/pathfind/etc.
    // release before the LLM turn fires. Falls through to normal dispatch
    // so the LLM still sees the chat and can respond in-character.
    if (playerSpoke && orchestrator) {
      const trimmed = String(message).trim().toLowerCase()
      if (STOP_VERBS.has(trimmed)) {
        forceCancelBody(bot)
        try { orchestrator.currentLoop?.abortController?.abort() } catch {}
        // Fall through to dispatch — LLM acknowledges in its own voice.
      }
    }

    const addressed = message.toLowerCase().includes(bot.username.toLowerCase())

    // Check proximity (within 20 blocks)
    const speaker = bot.players[username]
    const botPos = bot.entity?.position
    let nearby = false
    if (speaker?.entity && botPos) {
      nearby = speaker.entity.position.distanceTo(botPos) <= 20
    }

    if (playerSpoke || addressed || nearby) {
      const payload = { username: displayName, message, addressed, playerSpoke }
      if (bot._seiDebouncer) {
        bot._seiDebouncer.debounce(`chat:${displayName}`, payload, (p) => bot.emit('sei:chat_received', p))
      } else {
        bot.emit('sei:chat_received', payload)
      }
    }
  })
}
