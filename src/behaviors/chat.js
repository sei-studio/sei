/**
 * Chat behavior: responds when owner chats or when bot name is mentioned.
 * In Phase 1, response is a scripted acknowledgement.
 * Phase 2 will replace the response body with LLM-generated text.
 *
 * 260502-h6i: when the owner says one of a tight set of stop verbs, short-
 * circuit BEFORE the orchestrator. We don't want to pay a Haiku round-trip
 * just to learn "stop"; we also don't want Haiku to interpret it as
 * conversation. The fast path: abort the active Loop, clear owner_goals,
 * say "stopping.", and skip dispatch.
 */
import { logChatIn } from '../log.js'

const STOP_VERBS = new Set(['stop', 'halt', 'cancel', 'nevermind', 'never mind'])

/**
 * Hard-cancel anything the body is currently doing. Fires synchronously when
 * the owner speaks so dig swings, pathfinder traversal, and mineflayer's
 * control states all release before the LLM gets the new turn. Without this
 * the abort signal eventually reaches the action handler but the in-flight
 * mineflayer call (e.g. bot.dig) keeps swinging until natural completion.
 */
function forceCancelBody(bot) {
  try { bot.stopDigging?.() } catch {}
  try { bot.pathfinder?.stop?.() } catch {}
  try { bot.clearControlStates?.() } catch {}
}

export function startChat(bot, config, orchestrator = null) {
  bot.on('chat', (username, message) => {
    // Ignore own messages
    if (username === bot.username) return
    logChatIn(username, message)
    // Record every visible chat line in the ring buffer so the next Loop's
    // seed turn carries recent context — short owner replies like "yes" /
    // "do it" need this to be unambiguous.
    try { orchestrator?.recordIncomingChat?.(username, message) } catch {}

    const ownerSpoke = username === config.owner_username

    // Generalized owner-interrupt: any owner message pauses the body and
    // aborts the active Loop. The LLM then decides — based on the message
    // content — whether to resume the prior task, switch to a new one, or
    // just answer. The PLAYER INTERRUPT user turn (orchestrator repair path)
    // already preserves the prior tool-use history so resume is a real
    // option, not a guess.
    if (ownerSpoke && orchestrator) {
      forceCancelBody(bot)
      try { orchestrator.currentLoop?.abortController?.abort() } catch {}

      const trimmed = String(message).trim().toLowerCase()
      if (STOP_VERBS.has(trimmed)) {
        // Stop-verb fast path stays — clear owner_goals and confirm with a
        // single chat line, NO LLM round-trip. Body already cancelled above.
        try {
          const owner = orchestrator.goals?.snapshot?.()?.owner_goals ?? []
          for (const g of owner) {
            try { orchestrator.goals.remove?.('owner', g) } catch {}
          }
        } catch {}
        try { bot.chat('stopping.') } catch {}
        return
      }
      // Non-stop owner messages fall through to the normal dispatch below;
      // the orchestrator's interrupt path picks up pendingInterrupt and
      // appends a PLAYER INTERRUPT user turn so the LLM sees the message.
    }

    const addressed = message.toLowerCase().includes(bot.username.toLowerCase())

    // Check proximity (within 20 blocks)
    const speaker = bot.players[username]
    const botPos = bot.entity?.position
    let nearby = false
    if (speaker?.entity && botPos) {
      nearby = speaker.entity.position.distanceTo(botPos) <= 20
    }

    if (ownerSpoke || addressed || nearby) {
      const payload = { username, message, addressed, ownerSpoke }
      if (bot._seiDebouncer) {
        bot._seiDebouncer.debounce(`chat:${username}`, payload, (p) => bot.emit('sei:chat_received', p))
      } else {
        bot.emit('sei:chat_received', payload)
      }
    }
  })
}
