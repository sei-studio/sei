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
import { logChatIn } from '../../../brain/log.js'

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

    // 260514-ngj: pre-LLM body cancel now fires ONLY on STOP_VERBS. The
    // generalized "any owner chat aborts the body" path was over-aggressive
    // and broke the R1 case (text-only mid-loop should keep the in-flight
    // running). Non-stop owner messages fall through to the normal dispatch
    // below; the orchestrator decides whether to abort the body based on
    // what the LLM responds with (R1 keeps it, R2/R3/R4 abort it).
    if (ownerSpoke && orchestrator) {
      const trimmed = String(message).trim().toLowerCase()
      if (STOP_VERBS.has(trimmed)) {
        // Stop-verb fast path — hard-cancel the body, clear owner_goals,
        // confirm with a single chat line. NO LLM round-trip.
        forceCancelBody(bot)
        try { orchestrator.currentLoop?.abortController?.abort() } catch {}
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
      // the orchestrator's interrupt path folds in a PLAYER INTERRUPT user
      // turn so the LLM sees the message without pre-aborting the body.
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
