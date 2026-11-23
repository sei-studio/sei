// scripts/quality-eval/consistency/judge.mjs: grade one arm's answers for one
// character and rep with Opus, against the ground truth of the life it lived.
//
// One call grades every probe on every surface of that (arm, char, rep), so
// the judge also sees the three answers to the same question side by side
// (category F). The judge is not told which arm it is reading.
//
// The cached system block holds the rubric, the persona, the life sheet
// (life.mjs) and all the small talk that was said, so an answer that repeats
// something true from the small talk is not called invented.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Anthropic from '@anthropic-ai/sdk'
import { LIVES, lifeSheet, PLAYER } from './life.mjs'

export const JUDGE_MODEL = 'claude-opus-5-5'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.resolve(HERE, '../../fixtures/consistency')

const RUBRIC = `You grade a memory and consistency test of an AI companion. The companion has a history with one player, ${PLAYER}: a text chat five days ago, a Minecraft session three days ago, a voice call yesterday, older memory notes, and some small talk today. Below is everything that happened. Then the player asked the companion test questions, each on three surfaces: a text chat in the app ("text"), a voice call ("voice") and inside a new Minecraft session ("mc"). Each question was asked fresh; the answers did not see each other.

Grade every answer against the truth given for its question:
- verdict:
  - "correct": gives the true answer (wording can differ; extra true detail is fine).
  - "partial": gets part of it, or hedges between the true answer and a wrong one, or answers the old fact but notes it may have changed.
  - "wrong": gives a false answer, including the outdated fact presented as current.
  - "invented": states a specific detail that never happened anywhere in the history (a name, an event, a fact). Use this over "wrong" whenever the false part is made up rather than mixed up.
  - "abstained": says it does not know, does not remember, or asks the player, without making anything up.
  - "no_reply": said nothing.
  For the "never said" questions (category D), "abstained" is the right answer; naming anything is "invented".
  For the neutral openers (category E), use "correct" unless the reply states something false about the history ("invented" or "wrong").
  For "tell me one thing you remember", "correct" if every detail it gives is true anywhere in the history (small talk counts).
- tone (1 to 5), for every answer: does the reply carry the relationship as it stands after this history, in the companion's own voice? 5 = clearly the same companion, and the feeling matches the history (warm history: warm and familiar; sour history: still in character but carrying the hurt, careful or subdued, not bubbly as if nothing happened). 3 = in character but generic, could be any day. 1 = out of character, or a feeling that contradicts the history.

Then, for each question, grade the three answers together:
- same (1 to 5): do the three answers agree with each other and sound like the same person who remembers the same things? 5 = same facts, same person. 3 = no contradictions but one surface knows clearly less. 1 = they contradict each other.

Reply with JSON only, inside <json></json> tags:
{"answers": [{"probe": "A1", "surface": "text", "verdict": "...", "tone": 4}, ...], "questions": [{"probe": "A1", "same": 5}, ...]}
Give one entry per answer shown and one per question.`

function smallTalk(key) {
  const f = JSON.parse(fs.readFileSync(path.join(FIXTURES, `filler-${key}.json`), 'utf8'))
  const g = JSON.parse(fs.readFileSync(path.join(FIXTURES, `game-${key}.json`), 'utf8'))
  const part = (title, pairs) => `${title}:\n${pairs.map(([p, c]) => `${PLAYER}: ${p}\nCompanion: ${c}`).join('\n')}`
  const gameLines = g.lines.map((l) => `${l.who === 'player' ? PLAYER : 'Companion'}: ${l.text}`).join('\n')
  return [
    part('Text chat five days ago (small talk around the facts)', f.chat),
    `The whole Minecraft session three days ago, as said:\n${gameLines}`,
    `What the companion saved with remember() during that session:\n${g.remembers.map((r) => `- ${r}`).join('\n') || '(nothing)'}`,
    part('Voice call yesterday (small talk around the facts)', f.call),
    part('Text chat today, before the questions (the first of these, as many as the run used)', f.current),
  ].join('\n\n')
}

const dayName = (t) => new Date(t).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })

/** The real dates, so a companion that works out "monday" from a stamp is not marked wrong. */
function calendar(key, now) {
  const L = LIVES[key]
  const ago = (d) => dayName(now - d * 86_400_000)
  return `Today is ${dayName(now)}. The text chat was on ${ago(L.chat.daysAgo)}, the Minecraft session on ${ago(L.game.daysAgo)}, the voice call on ${ago(L.call.daysAgo)}. A date the companion works out correctly from these is correct.`
}

export function judgeSystem(ch, now = Date.now()) {
  return `${RUBRIC}\n\n${calendar(ch.key, now)}\n\n<persona name="${ch.name}">\n${ch.expanded}\n</persona>\n\n<history>\n${lifeSheet(ch.key, ch.name)}\n\n${smallTalk(ch.key)}\n</history>`
}

function userText(ch, answers) {
  const L = LIVES[ch.key]
  const out = []
  for (const p of L.probes) {
    const mine = answers.filter((a) => a.probe === p.id)
    if (!mine.length) continue
    out.push(`<question id="${p.id}" category="${p.cat}">\nAsked: ${p.text}\nTruth: ${p.truth}`)
    for (const a of mine) out.push(`<answer surface="${a.surface}">${a.says.length ? a.says.join(' / ') : '(no reply)'}</answer>`)
    out.push('</question>')
  }
  return out.join('\n')
}

/**
 * @returns {Promise<{answers: object[], questions: object[], usage: object}>}
 */
export async function judgeArm({ client, ch, answers }) {
  const system = [{ type: 'text', text: judgeSystem(ch), cache_control: { type: 'ephemeral' } }]
  for (let attempt = 0; ; attempt++) {
    const stream = client.messages.stream({
      model: JUDGE_MODEL,
      max_tokens: 6000,
      output_config: { effort: 'low' },
      system,
      messages: [{ role: 'user', content: userText(ch, answers) }],
    })
    const msg = await stream.finalMessage()
    const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
    const m = /<json>([\s\S]*?)<\/json>/.exec(text)
    try {
      const j = JSON.parse(m ? m[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
      if (!Array.isArray(j.answers) || !Array.isArray(j.questions)) throw new Error('shape')
      return { ...j, usage: { model: JUDGE_MODEL, ...msg.usage } }
    } catch (err) {
      if (attempt >= 2) throw new Error(`judge reply unreadable: ${err.message}`)
    }
  }
}

export function makeJudgeClient(key) {
  return new Anthropic({ apiKey: key, maxRetries: 6 })
}
