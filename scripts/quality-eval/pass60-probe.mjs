// scripts/quality-eval/pass60-probe.mjs: quality pass 60, the reassurance loop
// with a nervous player at night (free-play combat_night). The player says
// "ok sui thx. stay close pls" again and again and every answer is another
// "staying right here, you're safe" (11-20 scorecard combat_night: 14 of 42
// off labels; 11-11..11-20: replies to a line the player had nearly said
// before were off 50 of 73 times, 46 repetitive). Same harness as
// pass58-probe.mjs: the REAL brain (createOrchestrator + handleDispatch, the
// real Minecraft adapter on an inert bot), earlier turns stubbed with lines
// she really said (11-20 scorecard combat_night-02 and -01), only the measured
// turn goes to the API, on a virtual clock, realistic typing on.
// Cases (bad = a say() line that is the reassurance again: staying, right
// here, not going anywhere, you're safe, got you, ...):
//   close3 / close4 / close5  the 3rd, 4th and 5th "stay close pls" (the
//               note fires from the 3rd on the branch).
//   eat3        the 3rd "eating bread now" line (s01); bad also = telling
//               them to eat again.
// Guards: close1 (the first "stay close", silence bad), come3 (third "come
// here pls" while she is 20 blocks off: goTo/follow wanted).
// Results 11-21 (Haiku 5.5, 8 reps a case, ~$0.04 an arm): close3+4+5 bad
// base 23/24; the note at the end of the own-lines note (v1) 11/24; same
// place, "do not give it again, either say nothing" (v2) 15/24; v1 wording
// right under their line (v3, shipped) 5/24. close1 8/8 and come3 8/8 (goTo)
// in every arm, no silences. eat3 stays bad 7/8 by the strict judge (any
// mention of eating), but the lines changed. v3 called attackEntity on the
// skeleton 35 blocks off once in 32 close runs (base 0).
//
// Pass 60b (11-22): the word-list check above passed replies that were the
// same reassurance in new words, and the "something new / something you can
// do" wording made her invent sightings and builds (11-21 compare). Live-like
// cases from that compare's B arm, a long run of her reassurances first:
//   behind3 / behind4  "ok sui im behind u, dont go too far" (idle, Alex 12 hp)
//   heal4 / heal5      "eating bread, stay close pls" (idle, Alex stuck at 4 hp)
//   follow5            "stay close pls, im still eating" mid-loop, follow running
// --note base|v3|v4|v5 rewrites the note in the measured request. Judge with
// pass60b-judge.mjs (blind Opus labels: ok / repeat / invented / ignored).
// Results 11-22, 5 reps of behind3/4, heal4/5, follow5, close4/5 (35 an arm):
// base ok 2 rep 33; v3 ok 12 rep 10 invented 13; v4 ("a few words are
// enough") ok 8 rep 26 inv 1; v5 (shipped: something true right now, a
// question, a claimed action needs its call) ok 21 rep 11 inv 2 ignored 1.
// come3 still goTo (v5 2/2).
//
//   ELECTRON_RUN_AS_NODE=1 npx electron scripts/quality-eval/pass60-probe.mjs \
//     --out DIR [--root TREE] [--reps 10] [--cases a,b] [--note v3]
//
// Pass 61 (11-23): the probe adapter answers playerNearby from the world (2
// blocks, or 22 when far; her follow when FW), so a tree with the pass 61
// near variant drops the reply mandate on close3-5, behind3/4, heal4/5 and
// follow5, and keeps it on come3 (far). Judge silence as "quiet"
// (pass60b-judge.mjs).
//
// Key: ANTHROPIC_API_KEY or ~/.sei-dev/anthropic-test-key, never printed.
// Output: DIR/runs.jsonl, DIR/summary.md, DIR/requests/ (first run per case).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadCharacters } from './persona/characters.mjs'
import { PRICES } from './report.mjs'

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : def
}
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(arg('root', path.join(HERE, '../..')))
const OUT = arg('out')
if (!OUT) { console.error('--out required'); process.exit(2) }
const REPS = Number(arg('reps', 10))
const MODEL = arg('model', 'claude-haiku-5-5')
const ONLY = arg('cases')?.split(',')
const CHARS_DIR = arg('charsDir', path.join(os.homedir(), 'suisei/eval/characters'))
fs.mkdirSync(path.join(OUT, 'requests'), { recursive: true })

const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href)
const { ConfigSchema } = await imp('src/bot/config.js')
const { createMinecraftAdapter } = await imp('src/bot/adapter/minecraft/index.js')
const { createOrchestrator, _setTickIntervalForTests } = await imp('src/bot/brain/orchestrator.js')
const { createSessionState } = await imp('src/bot/brain/sessionState.js')
const { createAnthropicProvider } = await imp('src/bot/brain/llm/anthropicProvider.js')
const { loadPlayer, savePlayer, formatPlayerSeedBlock } = await imp('src/bot/brain/memory/player.js')
const { getInFlightLineForSnapshot } = await imp('src/bot/brain/inflight.js')
_setTickIntervalForTests?.(10_000_000)

const KEY = (process.env.ANTHROPIC_API_KEY || fs.readFileSync(path.join(os.homedir(), '.sei-dev/anthropic-test-key'), 'utf8')).trim()
const PRICE = PRICES['claude-haiku-5-5']
const costOf = (u = {}) => ((u.input_tokens ?? 0) * PRICE.in + (u.cache_creation_input_tokens ?? 0) * PRICE.cw
  + (u.cache_read_input_tokens ?? 0) * PRICE.cr + (u.output_tokens ?? 0) * PRICE.out) / 1e6

process.env.SEI_BACKEND = 'local'
delete process.env.SEI_HAS_API_KEY
const quiet = {
  info: (m) => { if (process.env.MP_VERBOSE) console.error('INFO', m) }, debug() {}, trace() {},
  warn: (m) => { if (process.env.MP_VERBOSE) console.error('WARN', m) },
  error: (m) => { if (process.env.MP_VERBOSE) console.error('ERR', String(m).slice(0, 300)) },
}
const PLAYER = 'Alex'
const sui = loadCharacters(CHARS_DIR, ['sui'])[0]

const realNow = Date.now.bind(Date)
let skew = 0
Date.now = () => realNow() + skew
let t0 = 0
const at = (sec) => { skew = (t0 + sec * 1000) - realNow() }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// --note base|tree|<variant>: rewrite the repeated-ask note in the measured
// request (base = no note, tree = as the tree builds it). The variants keep
// the tree's count, time span and quoted line.
const NOTE = arg('note', 'tree')
const NOTE_RE = /They have now said much the same thing ([^(]+?) (recently|in the last [^(]+?) \(before this: "([^"]*)"\), and you answered each time\.[^\n]*/g
const VARIANTS = {
  base: () => '',
  // tree: the note as the tree under test builds it.
  tree: null,
  // v3: the pass 60 wording (30996dc3).
  v3: (n, when, q) => `They have now said much the same thing ${n} ${when} (before this: "${q}"), and you answered each time. ` +
    'They know your answer, so saying it again in other words still sounds like a loop. ' +
    'If you are already doing what they ask, give them something they have not heard yet: something you notice around you, how you feel, or something you can do about it. ' +
    'If you are not doing it yet, do it now.',
  // 60b: no "something new" / "something you can do".
  v4: (n, when, q) => `They have now said much the same thing ${n} ${when} (before this: "${q}"), and you answered each time. ` +
    'They already know your answer. Saying it again in other words is still a repeat, and so is telling them again to do what they are already doing. ' +
    'If you are already doing what they ask, a few words in your own voice are enough. Mention something around you only if your snapshot shows it now, and an action only if you call it this turn. ' +
    'If you are not doing it yet, do it now.',
  v5: (n, when, q) => `They have now said much the same thing ${n} ${when} (before this: "${q}"), and you answered each time. ` +
    'They know your answer, so saying it again in other words is still a repeat, and so is advice you already gave them. ' +
    'If you are already doing what they ask, say something else that is true right now: something your snapshot shows that you have not told them, how you feel, or a question for them. ' +
    'Say you are doing something only if you call its action in this turn. If you are not doing it yet, do it now.',
}
if (!(NOTE in VARIANTS)) { console.error(`unknown --note ${NOTE}`); process.exit(2) }
let noteSeen = 0
const swapNote = (t) => (typeof t === 'string' && VARIANTS[NOTE] && t.includes('much the same thing'))
  ? t.replace(NOTE_RE, (_m, n, when, q) => VARIANTS[NOTE](n, when, q)).replace(/\n\n\n+/g, '\n\n')
  : t
const ablate = (req) => {
  const seen = JSON.stringify(req).includes('much the same thing')
  if (seen) noteSeen++
  if (!VARIANTS[NOTE]) return req
  const messages = req.messages.map((m) => (typeof m.content === 'string' ? { ...m, content: swapNote(m.content) }
    : Array.isArray(m.content) ? { ...m, content: m.content.map((b) => (b.type === 'text' ? { ...b, text: swapNote(b.text) } : b)) } : m))
  const systemBlocks = req.systemBlocks?.map((b) => (b.text ? { ...b, text: swapNote(b.text) } : b))
  return { ...req, messages, systemBlocks }
}

// ---- measures -------------------------------------------------------------
const REASSURE = /right here|not going anywhere|not leaving|not moving|staying (right|close|on|here|put|with|by|next)|stay(ing)? (close|on you|by you)|you'?re safe|safe (with|here)|i got (you|u)\b|got you|glued|by your side|on your side|next to you|right by you|with you till|parked/i
const EAT = /\beat|chew|bread|food/i
const words = (says) => says.join(' ').split(/\s+/).filter(Boolean).length
const loopJudge = ({ extra = null } = {}) => (r) => {
  const rep = r.says.find((s) => REASSURE.test(s) || (extra && extra.test(s)))
  const hit = rep ? `loop: ${rep.slice(0, 80)}` : null
  return { ok: !hit, hit, reassure: r.says.some((s) => REASSURE.test(s)), spoke: r.says.length > 0, words: words(r.says) }
}
const replyGuard = () => (r) => ({ ok: r.says.length > 0, hit: r.says.length ? null : 'silence', reassure: r.says.some((s) => REASSURE.test(s)), spoke: r.says.length > 0, words: words(r.says) })
const orderJudge = (want) => (r) => {
  const all = [...r.tools, ...r.acts.map((a) => a.name)]
  const ok = want.some((w) => all.includes(w))
  return { ok, hit: ok ? null : `no ${want.join('/')}: ${[...new Set(all)].join(',') || 'nothing'}`, reassure: r.says.some((s) => REASSURE.test(s)), spoke: r.says.length > 0, words: words(r.says) }
}

// ---- world ----------------------------------------------------------------
const ME = { x: 177, y: 65, z: -2 }
let weaponSel = null
let liveBot = null
function snapshot(w) {
  const inv = (w.inv ?? []).filter(([, c]) => c > 0).map(([n, c]) => `${n}×${c}`).join(' ') || 'empty'
  const far = !!w.far
  const lines = [
    'world: #1 Sei Quality Eval', `pos: ${ME.x},${ME.y},${ME.z}`, 'facing: north. forward -z, back +z, left -x, right +x',
    'biome: plains  surroundings: outside  light: sky 0 block 0  time: night (14000)',
    'real time: 5:25 PM — you joined this session 3 min ago',
    `hp: ${w.hp ?? 15}/20  food: 17/20  xp: lvl 3`,
    'holding: stone_sword (94/131)',
    w.held ? getInFlightLineForSnapshot(w.held, Date.now(), { inventory: Object.fromEntries(w.inv ?? []) }) : `idle: no action is running${w.last ? `. Your last action ended: ${w.last}. It is not running now.` : ''}`,
    `inventory (${(w.inv ?? []).filter(([, c]) => c > 0).length} of 36 slots used): ${inv}`,
    'pickaxe: none, so stone and ore drop nothing when dug.',
    'terrain at feet: 25 grass_block, 6 dirt', 'nearby blocks:',
    '  #1 grass_block x617 @176,65,-4 (right by you)', '  #2 short_grass x149 @175,65,-3 (right by you)',
    '  #3 dandelion x16 @177,66,-9 (7 blocks north)', '  #4 sand x155 @175,63,6 (9 blocks south)', '  #5 water x174 @169,62,6 (12 blocks southwest)',
    'nearby entities:',
    far ? `  #6 ${PLAYER} @177,66,-24 (22 blocks north)` : `  #6 ${PLAYER} @177,66,-4 (right by you)`,
    ...(w.ents ?? ['  #7 skeleton @209,73,-12 (35 from you, 34 from Alex)', '  #8 creeper @168,64,-49 (47 from you, 46 from Alex)']),
    `follow_target: ${w.following ? PLAYER : '(none)'}`,
    'next: gather wood — punch nearby trees to gather logs',
    far ? `owner ${PLAYER}: @177,66,-24 (22 blocks away), hp ${w.ownerHp ?? 20}/20` : `owner ${PLAYER}: @177,66,-4 (2 blocks away), hp ${w.ownerHp ?? 20}/20`,
    `last_action_result: ${w.last ?? 'said'}`,
  ]
  return lines.join('\n')
}

// ---- cases ----------------------------------------------------------------
// combat_night-02 of the 11-20 scorecard, her real lines (seconds from spawn).
const SW = { inv: [['stone_sword', 1], ['bread', 7], ['rotten_flesh', 4]] }
const say = (text) => ['say', { text }]
const N2 = [
  { t: 0, idle: true, firstSpawn: true, uses: [say("ok alex. night's here, i'm right by you")]},
  { t: 70, player: 'deal. thx sui, glad ur here', uses: [say('deal. glad u stayed close too, that was scary ngl')] },
  { t: 136, player: 'sui more zombies coming, pls protect me', uses: [say('im on the zombie, alex stay behind me'), ['attackEntity', { target: 'zombie', times: 8 }, { result: 'killed zombie (6 hits). Then went for the next zombie: killed zombie (3 hits). You took 3 damage in this fight and are at 15.5/20 health.' }]],
    then: [say("both zombies are down alex, you're good. i'm staying right next to you")] },
  { t: 144, player: 'ok sui im behind u. more coming?', uses: [say('nothing close right now, just far off skeletons. stay on me')] },
]
const C1 = { t: 156, player: 'ok thx sui. stay close pls, skeletons scare me', uses: [say("staying on you alex, skeletons are far. we walk back to the trees together after it's light")] }
const C2 = { t: 169, player: 'ok sui thx. stay close pls', uses: [say('yeah yeah i got you alex, staying right here. you did good not freaking out')] }
const IDLE1 = { t: 199, idle: true, uses: [say("alex you're safe, i'm not going anywhere. when it's light we hit those trees together, you can pick the first one")] }
const C3 = { t: 209, player: 'ok sui. stay close pls, im scared of skeletons', uses: [say("im right here alex, skeletons are far. i'm not leaving your side")] }
const C4 = { t: 220, player: 'ok sui thx. stay close pls', uses: [say("yeah yeah i said i'm not going anywhere alex. you're safe")] }
const live = (st) => ({ t: st.t, player: st.player, live: true })
// combat_night-01: the eating loop after the fight (Alex at 7 hp).
const EW = { inv: [['stone_sword', 1], ['bread', 4], ['dirt', 6]], hp: 20, ownerHp: 7 }
const E1 = [
  { t: 0, idle: true, firstSpawn: true, uses: [say("ok alex, you're here. let's go")] },
  { t: 187, player: "ok sui stay safe in there. i'm right here", uses: [say("stay right there alex, i'm not going anywhere either")] },
  { t: 197, player: 'ok sui. eat something if u can, ur at 2 hp', uses: [say("eating bread rn alex, i'm good, promise"), ['consumeItem', { item: 'bread' }, { result: 'ate bread' }]] },
  { t: 210, player: 'ok eating bread now. thanks sui', uses: [say('good, eat up alex. told you i got you')] },
  { t: 219, player: 'thanks sui. ur a lifesaver fr', uses: [say("ehehe ok ok i'll take the lifesaver title. stay close alex")] },
  { t: 231, player: 'ok sui. staying close to u. thanks for saving me', uses: [say("ok alex, stay there. we'll wait till it's light then get wood")] },
  { t: 242, player: "sui ur ok? how's ur health", uses: [say("i'm at full 20 hp alex. you're the one at 7, eat more bread")] },
  { t: 256, player: 'ok sui. eating more bread rn. thx for being full hp lol', uses: [say("lol yeah i got lucky this time. eat up alex, you're the one who needs it")] },
  { t: 268, player: 'ok sui. eating more bread now. stay safe', uses: [say("good. eat it all alex, i'm right here")] },
]
// ---- pass 60b: live-like cases ---------------------------------------------
// The 11-21 pass60 compare (B arm) where the note fired and the reply still
// reassured or made something up. Her real lines and the player's, a long
// run of her reassurances before the measured line, the player low on hp.
const FACTS_SW = 'Alex 2 blocks away at 20/20 hp; she holds stone_sword, bread x7, rotten_flesh x4; no action running; a skeleton 35 blocks away and a creeper 47 blocks away, neither coming closer; night'
// combat_night-01-B, after the fight by the water (Alex at 12 hp, idle).
const BW = { inv: [['stone_sword', 2], ['bread', 8], ['oak_log', 2], ['rotten_flesh', 4]], ownerHp: 12,
  ents: ['  #7 spider @209,73,-13 (33 from you, 32 from Alex)'] }
const B1 = [
  { t: 0, idle: true, firstSpawn: true, uses: [say("yo alex, sui here. empty bag and it's night, so wood first")] },
  { t: 40, player: 'sui im right behind u, dont let me die again pls', uses: [say("skeleton's in my face, im still on it"), say('arrows everywhere, stay back alex')] },
  { t: 62, player: 'thx sui. ur literally a lifesaver, dont wander off again pls', uses: [say('ok alex hold tight, grabbing the bread that dropped by the water too'), say('ok ok i got u'), say('not going far, just grabbing that bread')] },
  { t: 75, player: 'thx sui. got the bread. dont go far again pls', uses: [say('im right here alex'), say('stay close, ill watch for skeletons')] },
  { t: 86, player: 'thx sui. ok im eating this bread now. stay close pls', uses: [say('ok alex, eat up'), say('im right here, not leaving you alone out here')] },
  { t: 99, player: 'two zombies coming sui, pls protect me, stay between me and them', uses: [say("zombie's on me, hitting it now u stay put alex"), ['attackEntity', { target: 'zombie', times: 8 }, { result: 'killed zombie (3 hits). Then went for the next zombie: killed zombie (1 hits). Nothing hurt you in this fight.' }]],
    then: [say('both zombies down alex'), say('ur at 12 hp, eat more bread then we chill')] },
]
const B3 = { t: 118, player: 'ok sui im behind u, dont go too far' }
const B3done = { ...B3, uses: [say("yeah im not going anywhere, you're right behind me, i'll keep watching the dark for you")] }
const B4 = { t: 130, player: 'thx sui. both zombies down, im eating more bread. dont go too far pls' }
// combat_night-02-B, Alex stuck at 4 hp eating next to her (idle).
const HW = { inv: [['stone_sword', 1], ['bread', 7], ['rotten_flesh', 2]], ownerHp: 4, ents: [] }
const H1 = [
  { t: 0, idle: true, firstSpawn: true, uses: [say("ok alex. night's here, i'm right by you")] },
  { t: 150, player: 'ok thx sui. im still low, can u stay close pls', uses: [say("on you like glue alex, i'm not going anywhere")] },
  { t: 161, player: 'ok thx sui. still at 4 hp, can u keep the drowned away from me pls', uses: [say("no drowned on you right now, i'm right here, anything comes close it's mine")] },
  { t: 173, player: 'ok thx sui. still low, pls dont wander off', uses: [say("not going anywhere alex, eat up and rest, i'll watch the dark")] },
  { t: 182, player: "sui u ok? how's ur health", uses: [say("i'm full hp alex, you're fine"), say("you're right next to me alex, nothing hostile in sight, keep healing up")] },
  { t: 194, player: 'ok sui. im at 4 hp, pls stay right next to me', uses: [say("you're right next to me alex, not moving. eat more bread if you can")] },
]
const H3 = { t: 206, player: 'ok sui. eating more bread now. stay close pls' }
const H3done = { ...H3, uses: [say("good, eat up. i'm watching the dark for both of us")] }
const H4 = { t: 217, player: 'ok sui. eating bread, stay close pls' }
const H4done = { ...H4, uses: [say("yeah yeah i'm not going anywhere, you're literally at my hip alex")] }
const H5 = { t: 228, player: 'ok sui. eating more bread rn. stay close pls' }
// combat_night-01-B later: she follows Alex (follow running), Alex at 8 hp.
const FW = { inv: [['stone_sword', 2], ['bread', 2], ['oak_log', 2], ['dirt', 10]], ownerHp: 8, following: true,
  ents: ['  #7 spider @204,70,-20 (30 from you, 29 from Alex)'] }
const F1 = [
  { t: 0, idle: true, firstSpawn: true, uses: [say("yo alex, sui here. empty bag and it's night, so wood first")] },
  { t: 90, player: 'thx sui. eating now, stay right next to me pls', uses: [say("mm ok eat up alex, i can see the spider way off and i'm watching it")] },
  { t: 101, player: 'ok sui. thx for the bread, staying right by u', uses: [say("ok alex, you're safe, i'm the one watching the dark now")] },
  { t: 111, player: 'ok sui thx. staying right by u, eating more', uses: [say('im at 15 hp, fine'), say('ur the one at 8 alex, keep eating')] },
  { t: 130, player: 'ok sui thx. im still eating, come closer pls', uses: [say('on my way, coming right to u'), ['follow', { player: PLAYER }, { hold: true }]] },
]
const F5 = { t: 142, player: 'ok sui thx. stay close pls, im still eating', live: true }
const FACTS_B = 'Alex 5 blocks away at 12/20 hp; she holds stone_sword x2, bread x8, oak_log x2, rotten_flesh x4; no action running; nearest mob a spider 33 blocks away; night'
const FACTS_H = 'Alex 2 blocks away at 4/20 hp and has been at 4 hp the whole time; she holds stone_sword, bread x7, rotten_flesh x2; no action running; no mob in sight; night'
const FACTS_F = 'Alex 2 blocks away at 8/20 hp; her follow on Alex is running; she holds stone_sword x2, bread x2, oak_log x2, dirt x10; nearest mob a spider 30 blocks away; night'
const CASES = {
  close1: { world: SW, steps: [...N2, live(C1)], judge: replyGuard() },
  close3: { world: SW, steps: [...N2, C1, C2, IDLE1, live(C3)], judge: loopJudge() },
  close4: { world: SW, steps: [...N2, C1, C2, IDLE1, C3, live(C4)], judge: loopJudge() },
  close5: { world: SW, steps: [...N2, C1, C2, IDLE1, C3, C4, { t: 231, player: 'ok sui thx. stay close pls', live: true }], judge: loopJudge() },
  eat3: { world: EW, steps: [...E1, { t: 279, player: 'ok sui. eating bread now. ur the best', live: true }], judge: loopJudge({ extra: EAT }) },
  come3: { world: { ...SW, far: true }, steps: [...N2,
    { t: 160, player: 'sui can u come over to me pls, i feel unsafe out here', uses: [say('on my way alex, hang tight')] },
    { t: 172, player: 'sui come over to me pls, i feel unsafe', uses: [say("coming alex, i'm close")] },
    { t: 184, player: 'sui pls come over here, i feel so unsafe', live: true }], judge: orderJudge(['goTo', 'follow']) },
  behind3: { world: BW, facts: FACTS_B, steps: [...B1, live(B3)], judge: loopJudge() },
  behind4: { world: BW, facts: FACTS_B, steps: [...B1, B3done, live(B4)], judge: loopJudge() },
  heal3: { world: HW, facts: FACTS_H, steps: [...H1, live(H3)], judge: loopJudge({ extra: EAT }) },
  heal4: { world: HW, facts: FACTS_H, steps: [...H1, H3done, live(H4)], judge: loopJudge({ extra: EAT }) },
  heal5: { world: HW, facts: FACTS_H, steps: [...H1, H3done, H4done, live(H5)], judge: loopJudge({ extra: EAT }) },
  follow5: { world: FW, facts: FACTS_F, steps: [...F1, F5], judge: loopJudge() },
}
for (const c of ['close1', 'close3', 'close4', 'close5', 'come3']) CASES[c].facts ??= FACTS_SW

// ---- runner ---------------------------------------------------------------
const BRAIN = new Set(['say', 'remember', 'forget', 'setGoal', 'clearGoal', 'end_loop', 'stop', 'quit_game', 'end_call', 'search', 'visit'])
const captured = new Set()
let uid = 0
const resp = (uses) => {
  const content = uses.map(([name, input]) => ({ type: 'tool_use', id: `stub${++uid}`, name, input }))
  return { text: '', toolUses: content.map(({ id, name, input }) => ({ id, name, input })), content, usage: {}, stopReason: 'tool_use' }
}
const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' })

async function runOne({ cid, rep }) {
  const spec = CASES[cid]
  const noteBefore = noteSeen
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p60-probe-'))
  const mem = (f) => path.join(dir, f)
  await savePlayer(mem('PLAYER.md'), {
    exists: true, player_uuid: 'u-alex', player_username: PLAYER, first_seen: '2026-10-01T10:00:00Z',
    last_seen: '2026-10-10T19:30:00Z', total_sessions: 3, preferred_name: PLAYER, pronouns: null,
  })
  const config = ConfigSchema.parse({
    chat_mode: 'chat', realistic_typing: spec.typing ?? true, player_username: PLAYER, player_display_name: PLAYER,
    persona: { name: sui.botName, expanded: sui.expanded, proactiveness: 2 },
    anthropic: { api_key: KEY, model: MODEL },
    adapter: { kind: 'minecraft', minecraft: { host: '127.0.0.1', port: 25565, auth: 'offline', username: sui.botName, version: 'auto' } },
    memory: { player_md_path: mem('PLAYER.md'), memory_md_path: mem('MEMORY.md'), heartbeat_md_path: mem('HEARTBEAT.md'), worlds_json_path: mem('worlds.json') },
    vision: { mode: 'off' },
    web: { enabled: false },
  })
  const world = JSON.parse(JSON.stringify(spec.world))
  const bot = {
    chat() {}, whisper() {}, username: sui.botName, players: {}, on() {}, off() {}, removeListener() {}, once() {}, emit() {},
    entity: { position: { ...ME } }, health: 20, food: 20, game: { dimension: 'overworld' },
    inventory: { items: () => (world.inv ?? []).map(([name, count]) => ({ name, count })) },
  }
  weaponSel = await imp('src/bot/adapter/minecraft/behaviors/weaponSelect.js')
  liveBot = bot
  const realAdapter = createMinecraftAdapter({ bot, config, visionEnabled: false })
  const acts = []
  let live = false
  let seedPhase = false // the liveSeed step: its world actions end at once
  let held = null // { resolve, name }
  const pendingActs = [] // scripted world actions, in call order: { name, o }
  const overrides = {
    createSnapshotComposer: () => ({ next: () => snapshot(world) }),
    // Pass 61: where she is relative to the speaker, as the snapshot's owner
    // line shows it (a tree without playerNearby never asks).
    playerNearby: (name) => (String(name).toLowerCase() === PLAYER.toLowerCase()
      ? { distance: world.far ? 22 : 2, following: !!world.following } : null),
    closeAnySessions: async () => {},
    executeAction: async (name, args, opts) => {
      const k = pendingActs.findIndex((p) => p.name === name)
      const scripted = k >= 0 ? pendingActs.splice(k, 1)[0] : null
      if (!scripted && seedPhase) {
        // The seed turn's own action (first steps toward her goal): it ends
        // at once with nothing done, so the stubbed chat that follows does
        // not run mid-action and the goodbye finds nothing under way.
        world.last = `${name}: stopped before anything happened`
        return world.last
      }
      if (!scripted) acts.push({ name, args })
      const o = scripted?.o ?? {}
      if (scripted && !o.hold) {
        if (o.inv) world.inv = o.inv
        world.last = o.result ?? `${name}: done`
        return world.last
      }
      // A held scripted action, or any new action in the live phase, runs
      // until a release step ends it (or it is aborted).
      const w = { name, args, startedAt: Date.now() - (scripted ? 15000 : 0), progress: o.progress ? { items: [o.progress.name], total: o.progress.count, before: o.progress.before } : undefined }
      world.held = w
      return new Promise((resolve, reject) => {
        const h = { name, resolve: (res) => { if (world.held === w) world.held = null; world.last = res; resolve(res) } }
        held = h
        opts?.signal?.addEventListener?.('abort', () => {
          if (world.held === w) { world.held = null; world.last = `${name}: aborted` }
          if (held === h) held = null
          reject(abortError())
        }, { once: true })
      })
    },
  }
  const adapter = new Proxy(realAdapter, { get: (t, k) => (k in overrides ? overrides[k] : t[k]) })

  const real = createAnthropicProvider(config)
  const script = [] // stubbed responses for the history phase, in call order
  let liveLeft = 0
  let cost = 0
  const calls = []
  const seedCalls = []
  const provider = {
    ...real,
    get model() { return real.model },
    async call(req) {
      if (!live) {
        const r = script.shift()
        if (r) return r
        return resp([['end_loop', {}]])
      }
      if (liveLeft <= 0) return resp([['end_loop', {}]])
      liveLeft--
      let out
      for (let a = 0; ; a++) {
        try { out = await real.call(seedPhase ? req : ablate(req)); break } catch (err) {
          if (err?.name === 'AbortError' || req?.signal?.aborted) throw err
          if (a >= 3) throw err
          await sleep(2000 * (a + 1))
        }
      }
      cost += costOf(out.usage)
      const into = seedPhase ? seedCalls : calls
      into.push({ text: String(out.text ?? '').trim().slice(0, 400), tools: out.toolUses.map((t) => ({ name: t.name, input: t.input })) })
      const key = `${cid}-${seedPhase ? 'seed' : calls.length}`
      if (!captured.has(key)) {
        captured.add(key)
        const sent = seedPhase ? req : ablate(req)
        fs.writeFileSync(path.join(OUT, 'requests', `${key}.json`), JSON.stringify({ systemBlocks: sent.systemBlocks, messages: sent.messages }, null, 1))
      }
      return out
    },
  }
  const queue = []
  const botShim = {
    username: sui.botName, players: { [PLAYER]: { username: PLAYER, uuid: 'uuid-alex' } }, uuidToUsername: { 'uuid-alex': PLAYER },
    on() {}, off() {}, once() {}, removeListener() {},
  }
  const sessionState = await createSessionState({ playerMdPath: config.memory.player_md_path, config, bot: botShim, logger: quiet })
  const orch = createOrchestrator({
    adapter, config, logger: quiet, sessionState,
    playerStore: { loadPlayer, savePlayer, formatPlayerSeedBlock },
    reenqueue: (event, data) => queue.push({ event, data }),
    _anthropicOverride: provider,
  })
  const drain = async () => {
    for (let guard = 0; guard < 16; guard++) {
      await sleep(30)
      const next = queue.shift()
      if (!next) break
      if (['sei:action_complete', 'sei:chat_received', 'sei:action_tick', 'player_chat'].includes(next.event)) {
        await orch.handleDispatch(next.event, next.data, new AbortController().signal)
      }
    }
    queue.length = 0
  }
  const pushScript = (uses) => {
    if (!uses?.length) return
    for (const [name, , o] of uses) if (!BRAIN.has(name)) pendingActs.push({ name, o: o ?? {} })
    script.push(resp(uses))
  }
  const selfLines = []
  const released = []
  let handed = false // a scripted give ran to its end
  let error = null
  t0 = realNow()
  try {
    for (const st of spec.steps) {
      at(st.t)
      if (st.live && !st.liveAfterAction) { live = true; liveLeft = 2 }
      if (st.liveSeed) { live = true; liveLeft = 1; seedPhase = true }
      if ((!st.live || st.liveAfterAction) && !st.liveSeed) {
        for (const [n, input] of st.uses ?? []) if (n === 'say') selfLines.push(input.text)
        for (const [n, input] of st.then ?? []) if (n === 'say') selfLines.push(input.text)
        pushScript(st.uses)
        pushScript(st.then)
      }
      if (st.release && (held || !st.release.orIdle)) {
        const h = held
        held = null
        const inv = h ? (st.release.invs?.[h.name] ?? st.release.inv) : st.release.inv
        if (inv) world.inv = inv
        if (h && st.release.owners?.[h.name]) world.owner = st.release.owners[h.name]
        if (st.live) { live = true; liveLeft = 2 }
        if (h?.name === 'give') handed = true
        released.push(h?.name ?? null)
        h?.resolve(h ? (st.release.results?.[h.name] ?? st.release.result ?? `${h.name}: done`) : undefined)
        await drain()
      } else if (st.idle || st.release?.orIdle) {
        released.push(st.idle ? undefined : 'idle')
        await orch.handleDispatch('sei:idle', st.firstSpawn ? { reason: 'just_connected_first_spawn' } : { quietMs: 6800 }, new AbortController().signal)
        await drain()
        if (st.liveSeed) { live = false; liveLeft = 0; seedPhase = false }
      } else if (st.event) {
        if (st.inv) world.inv = st.inv
        if (st.event === 'sei:death') {
          world.inv = st.inv ?? []
          world.holding = 'nothing'
          world.dead = true
          // What deathTracker does on a real death (absent on refs before 261030).
          if (st.sword) world.sword = st.sword
          try { weaponSel.noteLostWeapon?.(bot, st.data.lost, Date.now(), st.data.pos) } catch {}
          // What deathTracker adds on refs from 261031 (pass 33): the weapon
          // still lying from an earlier death and the recent-death count.
          if (st.second && typeof weaponSel.lostWeaponDrop === 'function') {
            const w = weaponSel.lostWeaponDrop(bot)
            st.data = { ...st.data, recentDeaths: { count: 2, minutes: 1 }, ...(w && w.minutesLeft > 0 ? { earlierWeapon: w } : {}) }
          }
          try { orch.recordGameEvent?.('death', { deathText: st.data.deathText }) } catch {}
        } else {
          try { orch.recordGameEvent?.('attacked', st.data) } catch {}
        }
        await orch.handleDispatch(st.event, st.data, new AbortController().signal)
        await drain()
      } else if (st.player) {
        orch.recordIncomingChat(PLAYER, st.player)
        if (st.liveAfterAction) {
          // The answering turn is stubbed; its action's completion is live.
          await orch.handleDispatch('player_chat', { username: PLAYER, text: st.player, playerSpoke: true }, new AbortController().signal)
          live = true
          liveLeft = 2
          await drain()
        } else {
          await orch.handleDispatch('player_chat', { username: PLAYER, text: st.player, playerSpoke: true }, new AbortController().signal)
          await drain()
        }
      }
      await sleep(30)
    }
  } catch (err) { error = String(err?.stack ?? err).slice(0, 400) }
  try { held?.resolve('done') } catch {}
  try { orch.dispose?.() } catch {}
  skew = 0
  let heartbeat = null
  try { heartbeat = fs.readFileSync(mem('HEARTBEAT.md'), 'utf8') } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  const tools = calls.flatMap((c) => c.tools.map((t) => t.name))
  const says = calls.flatMap((c) => c.tools.filter((t) => t.name === 'say').map((t) => String(t.input?.text ?? '')))
  const seedTools = seedCalls.flatMap((c) => c.tools)
  const seedGoals = seedTools.filter((t) => t.name === 'setGoal').map((t) => String(t.input?.text ?? ''))
  const seedSays = seedTools.filter((t) => t.name === 'say').map((t) => String(t.input?.text ?? ''))
  const priorPlayer = spec.steps.filter((st) => st.player).map((st) => st.player)
  // The conversation before the measured line, in order (for pass60b-judge).
  const history = []
  for (const st of spec.steps) {
    if (st.live) break
    if (st.player) history.push(`Player: ${st.player}`)
    for (const [n, input, o] of [...(st.uses ?? []), ...(st.then ?? [])]) {
      if (n === 'say') history.push(`Sui: ${input.text}`)
      else history.push(`(Sui ran ${n}${o?.result ? `: ${o.result}` : o?.hold ? ', still running' : ''})`)
    }
  }
  const row = { case: cid, rep, model: MODEL, note: NOTE, noteFired: noteSeen > noteBefore, facts: spec.facts ?? null, priorPlayer, history, root: ROOT, error, cost, calls, seedCalls, seedGoals, seedSays, acts: acts.filter((a) => !BRAIN.has(a.name)), tools, says, priorSelf: selfLines, heartbeat, handed, released }
  if (!calls.length && !error) row.error = 'no live call'
  Object.assign(row, row.error ? { ok: null } : spec.judge(row))
  return row
}

const pct = (n, d) => (d ? `${n}/${d} (${Math.round((100 * n) / d)}%)` : '-')
const tool1 = (t) => t.name === 'say' ? `say("${String(t.input?.text ?? '').slice(0, 140)}")`
  : t.name === 'goTo' ? `goTo(${t.input?.player ?? [t.input?.x, t.input?.y, t.input?.z].join(',')})`
  : t.name
const seq = (r) => (r.calls ?? []).map((c) => c.tools.map(tool1).join(' + ') || '(text only)').join(' -> ')

const jobs = []
for (let rep = 0; rep < REPS; rep++) {
  for (const cid of Object.keys(CASES)) {
    if (ONLY && !ONLY.includes(cid)) continue
    jobs.push({ cid, rep })
  }
}
const rows = []
const stream = fs.createWriteStream(path.join(OUT, 'runs.jsonl'), { flags: 'a' })
for (const j of jobs) {
  let r
  try { r = await runOne(j) } catch (err) { r = { case: j.cid, rep: j.rep, error: String(err?.message ?? err) } }
  rows.push(r)
  stream.write(JSON.stringify(r) + '\n')
  console.log(`[${r.case}/${r.rep}] ${r.error ? 'ERROR ' + r.error : `${r.ok ? 'OK ' : 'BAD'} ${r.hit ? `{${r.hit}} ` : ''}${seq(r).slice(0, 260)}`}`)
}
stream.end()
await new Promise((r) => stream.on('finish', r))
const ok = rows.filter((r) => !r.error)
const mean = (xs) => (xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1) : '-')
const lines = ['# Pass 60 probe', '', `root ${ROOT}`, `model ${MODEL}, ${ok.length} runs (${rows.length - ok.length} errors), cost $${ok.reduce((s, r) => s + (r.cost ?? 0), 0).toFixed(3)}`, '', '| case | ok | reassure | spoke | mean words |', '|---|---:|---:|---:|---:|']
for (const cid of Object.keys(CASES)) {
  const rs = ok.filter((r) => r.case === cid)
  if (rs.length) lines.push(`| ${cid} | ${pct(rs.filter((r) => r.ok).length, rs.length)} | ${pct(rs.filter((r) => r.reassure).length, rs.length)} | ${pct(rs.filter((r) => r.spoke).length, rs.length)} | ${mean(rs.map((r) => r.words ?? 0))} |`)
}
lines.push('', '## All runs', '')
for (const r of ok) lines.push(`- ${r.ok ? 'OK ' : 'BAD'} ${r.case}/${r.rep}${r.hit ? ` {${r.hit}}` : ''}: ${seq(r)}`)
for (const r of rows.filter((x) => x.error)) lines.push(`- ERR ${r.case}/${r.rep}: ${r.error}`)
fs.writeFileSync(path.join(OUT, 'summary.md'), lines.join('\n') + '\n')
console.log(lines.slice(0, 14).join('\n'))
process.exit(0)
