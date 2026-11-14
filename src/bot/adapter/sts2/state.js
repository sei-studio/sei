// src/bot/adapter/sts2/state.js: the run as the brain reads it, and the
// name-to-index resolution for card plays.
//
// Two sources. The Sei mod fork attaches a compact structured state (SeiState,
// native/sts2-mod/PROTOCOL.md) to every force and pushes it on change; this
// file words it in a few hundred tokens. The unmodified upstream mod sends
// only its own markdown `state` text with each force, which is used clipped.
//
// Names over indexes. Neuro actions address cards by their index in the hand,
// which shifts after every play, so a model that plans three plays in one
// response by index gets the second and third wrong. `act` therefore also
// takes the card's NAME (and the target's name); resolveArgs maps it to the
// index the game expects at the moment each play is sent.

export const arr = (v) => (Array.isArray(v) ? v : [])
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d)
const str = (v, max = 200) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')
/** Upstream text is markdown with BBCode remnants; keep the snapshot plain and bounded. */
export const UPSTREAM_STATE_MAX = 3_000

const fold = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9+]+/g, ' ').trim()

function powers(list, max = 6) {
  const p = arr(list).slice(0, max).map((x) => (typeof x === 'string' ? x : `${str(x?.name, 40)}${x?.amount != null ? ` ${num(x.amount)}` : ''}`)).filter(Boolean)
  return p.length ? ` [${p.join(', ')}]` : ''
}

function body(b) {
  const block = num(b?.block) > 0 ? `, block ${num(b.block)}` : ''
  return `${num(b?.hp)}/${num(b?.max_hp)} hp${block}`
}

/** The card line: "[2] Bash (2, attack, enemy): Deal 8 damage. Apply 2 Vulnerable." */
function cardLine(c, i) {
  const cost = c?.cost == null ? '' : String(c.cost)
  const bits = [cost, str(c?.type, 12), c?.target && c.target !== 'none' ? str(c.target, 12) : ''].filter(Boolean).join(', ')
  const desc = str(c?.desc, 160)
  const unplayable = c?.playable === false ? ' (cannot play now)' : ''
  return `  [${i}] ${str(c?.name, 40)}${bits ? ` (${bits})` : ''}${desc ? `: ${desc}` : ''}${unplayable}`
}

/**
 * Pure: SeiState -> snapshot lines. `me` is the companion; allies include the player.
 * @param {object|null} s
 */
export function renderSeiState(s) {
  if (!s || typeof s !== 'object') return []
  const lines = []
  const run = s.run ?? {}
  const where = [run.act != null ? `act ${num(run.act)}` : '', run.floor != null ? `floor ${num(run.floor)}` : '', run.ascension ? `ascension ${num(run.ascension)}` : ''].filter(Boolean).join(', ')
  lines.push(`screen: ${str(s.screen, 24) || 'unknown'}${where ? ` (${where})` : ''}`)
  const me = s.me
  if (me) {
    const energy = me.energy != null ? `, energy ${num(me.energy)}/${num(me.max_energy, 3)}` : ''
    const ended = me.ended_turn ? ', turn ENDED (waiting for others)' : ''
    lines.push(`you: ${str(me.character, 24) || 'your character'}, ${body(me)}, gold ${num(me.gold)}${energy}${ended}${powers(me.powers)}`)
    // Empty slots keep their place so [i] stays the game's potion_index.
    const pots = arr(me.potions).map((p, i) => (p?.empty ? '' : `[${i}] ${str(p?.name ?? p, 40)}`)).filter(Boolean)
    if (pots.length) lines.push(`your potions: ${pots.join(', ')}`)
    const relics = arr(me.relics).map((r) => str(r?.name ?? r, 40)).filter(Boolean)
    if (relics.length) lines.push(`your relics: ${relics.slice(0, 14).join(', ')}${relics.length > 14 ? `, +${relics.length - 14} more` : ''}`)
    if (me.deck != null) lines.push(`your deck: ${num(me.deck)} cards`)
  }
  for (const a of arr(s.allies).slice(0, 3)) {
    const who = a?.is_player ? 'the player' : 'teammate'
    const ended = a?.ended_turn ? ', turn ended' : ''
    lines.push(`${who} ${str(a?.name, 32)} (${str(a?.character, 24) || '?'}): ${body(a)}${ended}${powers(a?.powers)}`)
  }
  const enemies = arr(s.enemies)
  if (enemies.length) {
    lines.push('enemies:')
    enemies.slice(0, 8).forEach((e, i) => {
      const intent = str(e?.intent, 160)
      lines.push(`  [${i}] ${str(e?.name, 40)}: ${body(e)}${intent ? `, intends ${intent}` : ''}${powers(e?.powers)}`)
    })
  }
  const hand = arr(s.hand)
  if (hand.length) {
    lines.push('your hand:')
    hand.slice(0, 12).forEach((c, i) => lines.push(cardLine(c, i)))
  }
  if (s.piles) lines.push(`piles: draw ${num(s.piles.draw)}, discard ${num(s.piles.discard)}, exhaust ${num(s.piles.exhaust)}`)
  const opts = arr(s.options)
  if (opts.length) {
    lines.push('choices:')
    opts.slice(0, 12).forEach((o, i) => {
      const desc = str(o?.desc, 160)
      lines.push(`  [${i}] ${str(o?.label ?? o, 80)}${desc ? `: ${desc}` : ''}`)
    })
  }
  const note = str(s.note, 400)
  if (note) lines.push(note)
  return lines
}

/** Upstream markdown state, clipped and de-BBCoded. */
export function clipUpstreamState(text, max = UPSTREAM_STATE_MAX) {
  if (typeof text !== 'string' || !text.trim()) return ''
  const plain = text.replace(/\[\/?[a-z_]+(=[^\]]*)?\]/gi, '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim()
  return plain.length > max ? `${plain.slice(0, max)}\n(state clipped)` : plain
}

/** "play_card(card_index*, enemy_index, ally_index)" from a registered action. */
export function actionSignature(a) {
  const props = a?.schema?.properties && typeof a.schema.properties === 'object' ? Object.keys(a.schema.properties) : []
  const req = new Set(arr(a?.schema?.required))
  return `${a.name}(${props.map((p) => `${p}${req.has(p) ? '*' : ''}`).join(', ')})`
}

/**
 * Find a card in the hand by name: exact name first, then a prefix/contains
 * match; a playable copy wins over an unplayable one. "Strike+" matches an
 * upgraded Strike. Returns the index or a reason.
 */
export function findCard(hand, name) {
  const want = fold(name)
  if (!want) return { error: 'no card name given' }
  const list = arr(hand).map((c, i) => ({ i, n: fold(c?.name), playable: c?.playable !== false }))
  const pick = (pred) => {
    const hits = list.filter(pred)
    return hits.find((h) => h.playable) ?? hits[0] ?? null
  }
  const hit = pick((c) => c.n === want) ?? pick((c) => c.n.replace(/\+$/, '') === want.replace(/\+$/, '')) ?? pick((c) => c.n.startsWith(want) || c.n.includes(want))
  if (!hit) return { error: `there is no ${name} in your hand` }
  return { index: hit.i }
}

/** An enemy by name, "Louse 2" for the second of a kind, or a bare index. */
export function findEnemy(enemies, target) {
  const list = arr(enemies)
  if (typeof target === 'number' && Number.isInteger(target)) return target >= 0 && target < list.length ? { index: target } : { error: `there is no enemy [${target}]` }
  const raw = fold(target)
  if (!raw) return { error: 'no target given' }
  if (/^\d+$/.test(raw)) return findEnemy(list, Number(raw))
  const m = /^(.*?)\s+(\d+)$/.exec(raw)
  const base = m ? m[1] : raw
  const nth = m ? Number(m[2]) : 1
  const alive = list.map((e, i) => ({ i, n: fold(e?.name), hp: num(e?.hp, 1) })).filter((e) => e.hp > 0)
  const same = alive.filter((e) => e.n === base)
  const hits = same.length ? same : alive.filter((e) => e.n.startsWith(base) || e.n.includes(base))
  const hit = hits[nth - 1] ?? (m ? null : hits[0])
  return hit ? { index: hit.i } : { error: `there is no enemy called ${target}` }
}

/** An ally (or the player) by name. */
export function findAlly(allies, target) {
  const want = fold(target)
  const list = arr(allies)
  const i = list.findIndex((a) => fold(a?.name) === want || (want === 'player' && a?.is_player) || fold(a?.name).startsWith(want))
  return i >= 0 ? { index: i } : { error: `there is no teammate called ${target}` }
}

/**
 * Map the convenience args `card`, `target`, `potion` onto the action's own
 * index args using the latest SeiState. Plain index args pass through.
 * @returns {{ data: object } | { error: string }}
 */
export function resolveArgs(action, args, seiState) {
  const props = action?.schema?.properties ?? {}
  const data = {}
  const src = args && typeof args === 'object' ? args : {}
  for (const [k, v] of Object.entries(src)) {
    if (k === 'card' || k === 'target' || k === 'potion') continue
    data[k] = v
  }
  if (src.card != null && 'card_index' in props && data.card_index == null) {
    if (typeof src.card === 'number') data.card_index = src.card
    else {
      if (!seiState?.hand) return { error: 'name the card by its [index] from the hand list' }
      const r = findCard(seiState.hand, src.card)
      if (r.error) return { error: `${r.error}. Your hand: ${arr(seiState.hand).map((c) => str(c?.name, 40)).join(', ') || 'empty'}` }
      data.card_index = r.index
    }
  }
  if (src.potion != null && 'potion_index' in props && data.potion_index == null) {
    if (typeof src.potion === 'number') data.potion_index = src.potion
    else {
      const pots = arr(seiState?.me?.potions)
      const i = pots.findIndex((p) => !p?.empty && (fold(p?.name ?? p) === fold(src.potion) || fold(p?.name ?? p).startsWith(fold(src.potion))))
      if (i < 0) return { error: `you have no potion called ${src.potion}` }
      data.potion_index = i
    }
  }
  if (src.target != null && data.enemy_index == null && data.ally_index == null) {
    const t = src.target
    const allyHit = 'ally_index' in props && typeof t === 'string' && arr(seiState?.allies).length ? findAlly(seiState.allies, t) : { error: 'no' }
    if (!allyHit.error) data.ally_index = allyHit.index
    else if ('enemy_index' in props) {
      if (typeof t === 'number') data.enemy_index = t
      else {
        if (!seiState?.enemies) return { error: 'name the target by its [index] from the enemies list' }
        const r = findEnemy(seiState.enemies, t)
        if (r.error) return { error: r.error }
        data.enemy_index = r.index
      }
    }
  }
  // Integers the model wrote as strings ("2").
  for (const [k, v] of Object.entries(data)) {
    const type = props[k]?.type
    if (type === 'integer' && typeof v === 'string' && /^-?\d+$/.test(v.trim())) data[k] = Number(v.trim())
  }
  const missing = arr(action?.schema?.required).filter((k) => data[k] == null)
  if (missing.length) return { error: `${action.name} needs ${missing.join(', ')}` }
  return { data }
}
