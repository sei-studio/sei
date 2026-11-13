#!/usr/bin/env node
// scripts/quality-eval/consistency/gen-filler.mjs: write the small-talk filler
// for the consistency eval's scripted lives, once, with Opus. The output is a
// committed fixture (scripts/fixtures/consistency/filler-<char>.json), so every
// run and both arms of a comparison replay the same words.
//
//   node scripts/quality-eval/consistency/gen-filler.mjs [--chars sui,roger]
//        [--chars-dir ~/suisei/eval/characters] [--force]
//
// Filler must never touch a probed topic (life.mjs): no pets, family, jobs,
// school, food, colours, birthdays, cars, and none of the game events, or a
// probe could be answered (or contradicted) by small talk.
// Key: ANTHROPIC_API_KEY, else ~/.sei-dev/anthropic-test-key. Never printed.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Anthropic from '@anthropic-ai/sdk'
import { loadCharacters } from '../persona/characters.mjs'
import { PLAYER } from './life.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const FIXTURE_DIR = path.resolve(HERE, '../../fixtures/consistency')
const argv = process.argv.slice(2)
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d }
const CHARS = opt('chars', 'sui,roger').split(',')
const CHARS_DIR = opt('chars-dir', path.join(os.homedir(), 'suisei/eval/characters'))

const SHAPE = {
  chat: { n: 30, how: 'a relaxed evening text chat in the app (typed, casual, lowercase is fine), mixing everyday life with talk about the Minecraft world they share (a log cabin by a river, or a wheat farm next to a house)' },
  call: { n: 20, how: 'a voice call (spoken lines, full sentences, no emoji or chat shorthand), easygoing talk about the evening, weather, a show, plans to play sometime' },
  current: { n: 40, how: 'another casual text chat on a new day (typed), drifting through light topics' },
  ingame: { n: 30, how: 'in-game chatter while playing Minecraft together: short lines about gathering wood or stone, a sunset, a funny jump, where to go, nothing dramatic' },
}
const BANNED = 'pets or animals of any kind, siblings or any family member, roommates, jobs or work, school, studying or courses, food or drinks, favourite colours, birthdays or presents, cars, music bands, climbing or sports, creepers, zombies, wolves, cats, dogs, diamonds, the cabin roof, fences, villages'

function key() {
  return (process.env.ANTHROPIC_API_KEY ?? fs.readFileSync(path.join(os.homedir(), '.sei-dev/anthropic-test-key'), 'utf8')).trim()
}

async function main() {
  const client = new Anthropic({ apiKey: key(), maxRetries: 4 })
  fs.mkdirSync(FIXTURE_DIR, { recursive: true })
  const chars = loadCharacters(CHARS_DIR, CHARS)
  const usage = { input_tokens: 0, output_tokens: 0 }
  for (const ch of chars) {
    const out = path.join(FIXTURE_DIR, `filler-${ch.key}.json`)
    if (fs.existsSync(out) && !argv.includes('--force')) { console.log(`exists: ${out}`); continue }
    const result = {}
    for (const [kind, s] of Object.entries(SHAPE)) {
      const system =
        `You write small-talk dialogue for testing an AI companion app. The companion is ${ch.name}; the player is ${PLAYER}. ` +
        `Write ${ch.name}'s lines in the voice of this persona, and ${PLAYER}'s lines as a normal young adult player.\n\n<persona>\n${ch.expanded}\n</persona>`
      const user =
        `Write exactly ${s.n} exchanges of ${s.how}. Each exchange is one line from ${PLAYER} and one reply from ${ch.name}, each under 25 words. ` +
        `Never mention any of these, not even in passing: ${BANNED}. Do not state any personal fact about ${PLAYER} at all (where they live, what they do, what they like); keep it to the moment. ` +
        'Do not use em dashes. Output only JSON inside <json></json> tags: an array of [player_line, companion_line] pairs.'
      const stream = client.messages.stream({ model: 'claude-opus-5-5', max_tokens: 8000, output_config: { effort: 'low' }, system, messages: [{ role: 'user', content: user }] })
      const msg = await stream.finalMessage()
      usage.input_tokens += msg.usage.input_tokens
      usage.output_tokens += msg.usage.output_tokens
      const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
      const m = /<json>([\s\S]*?)<\/json>/.exec(text)
      const pairs = JSON.parse(m ? m[1] : text.slice(text.indexOf('['), text.lastIndexOf(']') + 1))
      if (!Array.isArray(pairs) || pairs.length < s.n) throw new Error(`${ch.key}/${kind}: got ${pairs?.length} pairs`)
      result[kind] = pairs.slice(0, s.n).map(([p, c]) => [String(p), String(c)])
      console.log(`${ch.key}/${kind}: ${result[kind].length} exchanges`)
    }
    fs.writeFileSync(out, JSON.stringify(result, null, 1) + '\n')
  }
  console.log(`opus usage in ${usage.input_tokens} out ${usage.output_tokens}`)
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1) })
