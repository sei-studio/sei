/**
 * Chat behavior: responds when owner chats or when bot name is mentioned.
 * In Phase 1, response is a scripted acknowledgement.
 * Phase 2 will replace the response body with LLM-generated text.
 */
import { logChatIn } from '../log.js'

export function startChat(bot, config) {
  bot.on('chat', (username, message) => {
    // Ignore own messages
    if (username === bot.username) return
    logChatIn(username, message)

    const ownerSpoke = username === config.owner_username
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
