// scripts/quality-eval/lib/playerBrain.mjs: the free-play player's prompt
// (run.mjs), kept apart so a replay probe can build the exact same request.
//
// 261123 (quality pass 61): combat_night's nervous player asked her to stay
// close about every 10 s whatever she said or did. Over the 11-20..11-22
// combat_night runs (14 sessions) 120 of 363 player lines were a stay-close
// ask, 110 of them reactions to one of her lines, 80 with her already within
// 4 blocks; one reaction in seven was a near copy of one of the player's own
// last four lines. The system prompt already said "do not send the same
// request again unless she ignored it"; the player never saw where she was in
// words or its own lines apart from the chat. Real players ask again when she
// walks off or does not come, not after every answer while she stands next to
// them. Now:
//   - the turn says "right next to you" within 3 blocks,
//   - the player's own last lines are listed, with a rule to not send the same
//     ask or update again in any words once she answered it and is doing it,
//   - a backstop (repeatedBit): a reaction that repeats a two-word bit of two
//     or more of the player's own lines from the last 2 minutes, after she
//     answered and while she is within 5 blocks, is asked once more with that
//     said; if the new line still repeats it, the player says nothing.
// Beats (director cues) are never touched, and a far-off companion can be
// asked again as often as the player likes.

export const NEAR_WORDS_BLOCKS = 3
export const REPEAT_NEAR_BLOCKS = 5
export const REPEAT_WINDOW_MS = 120_000

export function playerSystem(sc, botName, player) {
  return [
    `You are playing Minecraft Java as the player "${player}". You are a real person, around 17 to 25, playing on your computer.`,
    `${botName} is an AI companion in the game with you. You talk to her by typing in game chat.`,
    '',
    `This session: ${sc.brief}`,
    '',
    'How you type:',
    '- Like a normal gamer in chat. Mostly lowercase, short, casual. Skip punctuation a lot. A typo now and then is fine.',
    '- Usually one short message. Never more than about 20 words.',
    '- You do not explain yourself and you do not narrate. You just type what you would type.',
    '- You are not a tester and you never mention tests, prompts or evaluations.',
    `- Read your own last lines before you type. Once she has answered an ask or a worry of yours and is doing it, you do not send it again in other words: if she is right next to you, you do not ask her again to stay close or not to leave. Ask again only if she ignored you or stopped (she walked off, she did not come). The same goes for updates: you do not tell her again what you are doing if you already did. Vary how you word things.`,
    '- Sometimes you do not answer her at all, about one time in four, especially when she just narrates what she is doing. Then say is an empty string.',
    '- Now and then you go off topic or ignore what she asked, like real players do.',
    '',
    'When a director note appears, it tells you what to do next in the session. Do it in your own words, right away.',
    'Pick a move only when it makes sense. Most of the time move is "stay".',
  ].join('\n')
}

/** How far she is, in the words a player would use looking at the screen. */
export function whereIsShe(botName, dist) {
  const d = dist == null ? NaN : Number(dist)
  if (!Number.isFinite(d)) return `You cannot see ${botName} right now.`
  if (d <= NEAR_WORDS_BLOCKS) return `${botName} is right next to you (${Math.round(d)} blocks).`
  return `${botName} is ${Math.round(d)} blocks from you.`
}

/**
 * The user turn of one player decision.
 * @param {object} o
 * @param {Array<{who:string,text:string}>} o.history  chat, oldest first
 * @param {Array<{text:string,at:number}>} o.ownLines  the player's own lines, oldest first
 */
export function playerAsk({ history, ownLines = [], botName, player, dist, hp, inv, elapsedMin, trigger, cue = null, now = Date.now() }) {
  const recent = history.slice(-30).map((h) => (h.who === player ? `you: ${h.text}` : `${h.who}: ${h.text}`)).join('\n') || '(nothing yet)'
  const mine = ownLines.slice(-4).map((l) => `- ${Math.max(1, Math.round((now - l.at) / 1000))}s ago: ${l.text}`).join('\n')
  let ask = `Chat so far:\n${recent}\n\n` +
    (mine ? `Your own last lines:\n${mine}\n\n` : '') +
    `Now: ${elapsedMin} min into the session. ${whereIsShe(botName, dist)} Your health ${Math.round(hp ?? 20)}/20. Your inventory: ${inv}. You do not mine or craft yourself in this session, so do not claim to.`
  if (trigger === 'beat') ask += `\n\nDirector note: ${cue}`
  else if (trigger === 'companion_spoke') ask += `\n\n${botName} just said something. Reply if you would, or say nothing.`
  else ask += '\n\nIt has been quiet for a while. Say something if you feel like it, or nothing.'
  return ask + '\n\nCall player_turn.'
}

const FILLER = new Set((
  'ok okay k kk thx thanks thank ty tysm pls plz please lol lmao haha yeah yep ya yea cool nice good great alright sure ' +
  'hey omg fr rn tbh ngl kinda now still again ur u i im me the a an to and its it is are you so just my your of for on in at be do'
).split(' '))

function bits(text, skip) {
  const t = (String(text).toLowerCase().match(/[a-z']+/g) ?? []).filter((w) => w.length > 1 && !FILLER.has(w) && !skip.has(w))
  const out = new Set()
  for (let i = 0; i + 1 < t.length; i++) out.add(`${t[i]} ${t[i + 1]}`)
  return out
}

/**
 * The two-word bit of `say` that two or more of the player's own lines in the
 * window already had, when she has spoken since the last of them and is
 * within REPEAT_NEAR_BLOCKS; else null.
 * @param {string} say
 * @param {Array<{text:string,at:number}>} ownLines  oldest first
 * @param {{ now:number, lastHerLineAt:number, dist:number|null, names?:string[] }} o
 * @returns {{ bit:string, times:number }|null}
 */
export function repeatedBit(say, ownLines, { now, lastHerLineAt, dist, names = [] }) {
  if (!say || dist == null || !(Number(dist) <= REPEAT_NEAR_BLOCKS)) return null
  const skip = new Set(names.map((n) => String(n).toLowerCase()))
  const recent = ownLines.filter((l) => now - l.at <= REPEAT_WINDOW_MS).map((l) => ({ at: l.at, bits: bits(l.text, skip) }))
  for (const b of bits(say, skip)) {
    const had = recent.filter((l) => l.bits.has(b))
    if (had.length >= 2 && lastHerLineAt > had.at(-1).at) return { bit: b, times: had.length }
  }
  return null
}

export function redoNote(rep, botName) {
  return `\n\nYou already typed "${rep.bit}" ${rep.times} times in the last two minutes, ${botName} answered, and she is right there with you. ` +
    'A real player would not type it again now. Say something else, or nothing.'
}

export function stillRepeats(say, rep, names = []) {
  return !!say && bits(say, new Set(names.map((n) => String(n).toLowerCase()))).has(rep.bit)
}
