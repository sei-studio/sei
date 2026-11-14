// src/bot/adapter/sts2/fixtures/scenario.js: a tiny synthetic Slay the Spire
// 2 run for the headless harness and tests. NOT the real game: just enough of
// its decision points (lobby, map, a co-op fight with intents, card reward,
// rest site, event, an elite, the end of the run) to drive the adapter, the
// runtime and a real brain the way the mod would, with the RULES enforced
// here like the game enforces them (energy, targets, whose turn it is).
//
// Action names and argument names mirror VedalAI/neuro-sts2 (play_card
// card_index/enemy_index/ally_index, use_potion, end_turn, select_map_node
// coordIndex, select_card card_index, skip, select_event_option option_index,
// proceed, select_character character_index, embark).

const CARDS = {
  Strike: { cost: 1, type: 'attack', target: 'enemy', dmg: 6, desc: 'Deal 6 damage.' },
  Defend: { cost: 1, type: 'skill', target: 'self', block: 5, desc: 'Gain 5 Block.' },
  Bash: { cost: 2, type: 'attack', target: 'enemy', dmg: 8, vuln: 2, desc: 'Deal 8 damage. Apply 2 Vulnerable.' },
  'Pommel Strike': { cost: 1, type: 'attack', target: 'enemy', dmg: 9, desc: 'Deal 9 damage. Draw 1 card.' },
  'Shrug It Off': { cost: 1, type: 'skill', target: 'self', block: 8, desc: 'Gain 8 Block. Draw 1 card.' },
  Cleave: { cost: 1, type: 'attack', target: 'all', dmg: 8, desc: 'Deal 8 damage to ALL enemies.' },
  'Iron Wave': { cost: 1, type: 'attack', target: 'enemy', dmg: 5, block: 5, desc: 'Gain 5 Block. Deal 5 damage.' },
}

const ENEMIES = {
  'Jaw Worm': { hp: 40, intents: [{ kind: 'attack', dmg: 11 }, { kind: 'attack', dmg: 7, block: 5 }, { kind: 'buff' }] },
  Louse: { hp: 12, intents: [{ kind: 'attack', dmg: 6 }, { kind: 'buff' }] },
  'Gremlin Nob': { hp: 60, intents: [{ kind: 'buff' }, { kind: 'attack', dmg: 14 }, { kind: 'attack', dmg: 8 }] },
}

/** A seeded RNG so a run replays the same. */
function rng(seed) {
  let x = seed >>> 0 || 1
  return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return ((x >>> 0) % 1_000_000) / 1_000_000 }
}

/**
 * @param {{ seed?: number, coop?: boolean, playerName?: string, structured?: boolean }} [opts]
 */
export function createScenario({ seed = 7, coop = true, playerName = 'Tester', structured = true } = {}) {
  const rand = rng(seed)
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] } return a }
  const run = { act: 1, floor: 0, ascension: 0 }
  const me = { character: null, hp: 80, max_hp: 80, block: 0, gold: 99, energy: 3, max_energy: 3, potions: [{ name: 'Block Potion', block: 12 }], relics: ['Burning Blood'], ended_turn: false, vuln: 0 }
  const deck = ['Strike', 'Strike', 'Strike', 'Strike', 'Strike', 'Defend', 'Defend', 'Defend', 'Defend', 'Bash']
  const player = coop ? { name: playerName, character: 'The Silent', hp: 70, max_hp: 70, block: 0, ended_turn: false } : null
  let phase = 'lobby'
  let enemies = []
  let hand = []
  let draw = []
  let discard = []
  let options = []
  let round = 0
  let mapStep = 0
  const log = []
  const events = []
  const MAP = [
    [{ type: 'Monster', fight: ['Jaw Worm'] }, { type: 'Monster', fight: ['Louse', 'Louse'] }],
    [{ type: 'Rest Site' }, { type: 'Unknown' }],
    [{ type: 'Elite', fight: ['Gremlin Nob'] }],
  ]

  const say = (kind, detail) => events.push({ kind, ...(detail ? { detail } : {}) })

  function drawCards(n) {
    for (let i = 0; i < n; i++) {
      if (!draw.length) { draw = shuffle(discard); discard = [] }
      if (!draw.length) break
      hand.push(draw.pop())
    }
  }

  function startFight(names) {
    phase = 'combat'
    round = 0
    enemies = names.map((n) => ({ name: n, hp: ENEMIES[n].hp, max_hp: ENEMIES[n].hp, block: 0, step: 0, str: 0, vuln: 0 }))
    draw = shuffle([...deck])
    discard = []
    hand = []
    const elite = names.some((n) => n === 'Gremlin Nob')
    say(elite ? 'elite_start' : 'combat_start', names.join(', '))
    newRound()
  }

  function intentOf(e) {
    const it = ENEMIES[e.name].intents[e.step % ENEMIES[e.name].intents.length]
    if (it.kind === 'attack') return `Attack ${it.dmg + e.str}${it.block ? ` and Block ${it.block}` : ''}`
    return 'Buff'
  }

  function newRound() {
    round += 1
    me.energy = me.max_energy
    me.block = 0
    me.ended_turn = false
    if (player) { player.block = 0; player.ended_turn = false }
    discard.push(...hand)
    hand = []
    drawCards(5)
  }

  function damageEnemy(e, n) {
    let dmg = e.vuln > 0 ? Math.floor(n * 1.5) : n
    const absorbed = Math.min(e.block, dmg)
    e.block -= absorbed
    dmg -= absorbed
    e.hp = Math.max(0, e.hp - dmg)
  }

  function hit(target, n) {
    const absorbed = Math.min(target.block, n)
    target.block -= absorbed
    target.hp = Math.max(0, target.hp - (n - absorbed))
  }

  function enemyTurn() {
    let k = 0
    for (const e of enemies.filter((x) => x.hp > 0)) {
      const it = ENEMIES[e.name].intents[e.step % ENEMIES[e.name].intents.length]
      if (it.kind === 'attack') {
        // Enemies alternate between the two players.
        const victim = player && player.hp > 0 && (k + round) % 2 === 1 ? player : me
        hit(victim, it.dmg + e.str)
        if (it.block) e.block += it.block
      } else e.str += 2
      if (e.vuln > 0) e.vuln -= 1
      e.step += 1
      k += 1
    }
    if (player && player.hp > 0 && player.hp < player.max_hp * 0.3) say('player_low', `${player.hp} hp`)
    if (me.hp <= 0) { phase = 'lost'; say('run_lost', 'your character fell'); return }
    newRound()
  }

  function maybeEndRound() {
    if (!me.ended_turn) return
    if (player && player.hp > 0 && !player.ended_turn) return
    enemyTurn()
  }

  /** The simulated human: plays a little and ends their turn. */
  function playerActs() {
    if (!player || phase !== 'combat' || player.ended_turn) return
    const target = enemies.find((e) => e.hp > 0)
    if (target) damageEnemy(target, 7)
    player.block += 4
    player.ended_turn = true
    log.push('player ended turn')
    checkFightOver()
    if (phase === 'combat') maybeEndRound()
  }

  function checkFightOver() {
    if (phase === 'combat' && enemies.every((e) => e.hp <= 0)) {
      say('combat_won', enemies.map((e) => e.name).join(', '))
      me.gold += 15
      discard.push(...hand)
      hand = []
      if (run.floor >= MAP.length) { phase = 'won'; say('run_won', `floor ${run.floor}`); return }
      phase = 'card_reward'
      const pool = Object.keys(CARDS).filter((c) => !['Strike', 'Defend', 'Bash'].includes(c))
      options = shuffle([...pool]).slice(0, 3)
    }
  }

  // ── decision points ────────────────────────────────────────────────
  const I = { type: 'integer' }
  const obj = (props, required = []) => ({ type: 'object', properties: props, ...(required.length ? { required } : {}) })

  function decision() {
    switch (phase) {
      case 'lobby':
        return {
          query: me.character ? 'Pick your character or embark.' : 'Pick a character for this run.',
          actions: [
            { name: 'select_character', description: 'Select a character', schema: obj({ character_index: I }, ['character_index']) },
            ...(me.character ? [{ name: 'embark', description: 'Start the run with the selected character' }] : []),
          ],
          options: ['The Ironclad', 'The Silent', 'The Defect', 'The Necrobinder', 'The Regent'].map((label) => ({ label })),
        }
      case 'map':
        return {
          query: 'Choose the next map node.',
          actions: [{ name: 'select_map_node', description: 'Select a point to travel to', schema: obj({ coordIndex: I }) }],
          options: MAP[mapStep].map((n) => ({ label: n.type })),
        }
      case 'combat':
        if (me.ended_turn) return null
        return {
          query: `Combat turn ${round}. Play cards or end your turn.`,
          actions: [
            ...(hand.some((c) => CARDS[c].cost <= me.energy) ? [{ name: 'play_card', description: 'Play a card, optionally supply enemy_index or ally_index to specify a target', schema: obj({ card_index: I, enemy_index: I, ally_index: I }, ['card_index']) }] : []),
            ...(me.potions.length ? [{ name: 'use_potion', description: 'Use a potion', schema: obj({ potion_index: I, enemy_index: I, ally_index: I }, ['potion_index']) }] : []),
            { name: 'end_turn', description: 'Ends your current turn' },
          ],
          options: [],
        }
      case 'card_reward':
        return {
          query: 'Pick a card to add to your deck, or skip.',
          actions: [
            { name: 'select_card', description: 'Select an available card', schema: obj({ card_index: I }, ['card_index']) },
            { name: 'skip', description: 'Skip this selection. No card will be added to your deck.' },
          ],
          options: options.map((c) => ({ label: c, desc: `${CARDS[c].cost} energy, ${CARDS[c].desc}` })),
        }
      case 'rest':
        return {
          query: 'Rest site: rest to heal or smith to upgrade a card.',
          actions: [{ name: 'select_event_option', description: 'Choose a rest site option', schema: obj({ option_index: I }, ['option_index']) }],
          options: [{ label: 'Rest', desc: 'Heal 30% of your max HP.' }, { label: 'Smith', desc: 'Upgrade a card.' }],
        }
      case 'event':
        return {
          query: 'An event. Choose an option.',
          actions: [{ name: 'select_event_option', description: 'Select an option in the event', schema: obj({ option_index: I }, ['option_index']) }],
          options: [{ label: 'Take the gold', desc: 'Gain 50 gold. Lose 6 HP.' }, { label: 'Leave', desc: 'Nothing happens.' }],
        }
      default:
        return null
    }
  }

  function seiState() {
    const d = decision()
    return {
      v: 1,
      screen: phase === 'card_reward' ? 'card_reward' : phase,
      run: { ...run },
      me: { ...me, character: me.character ?? 'not picked', potions: me.potions.map((p) => ({ name: p.name })), deck: deck.length, powers: me.vuln ? [{ name: 'Vulnerable', amount: me.vuln }] : [] },
      allies: player ? [{ ...player, is_player: true, powers: [] }] : [],
      enemies: phase === 'combat' ? enemies.map((e) => ({ name: e.name, hp: e.hp, max_hp: e.max_hp, block: e.block, intent: e.hp > 0 ? intentOf(e) : 'dead', powers: [...(e.str ? [{ name: 'Strength', amount: e.str }] : []), ...(e.vuln ? [{ name: 'Vulnerable', amount: e.vuln }] : [])] })) : [],
      hand: phase === 'combat' ? hand.map((c) => ({ name: c, cost: CARDS[c].cost, type: CARDS[c].type, target: CARDS[c].target, desc: CARDS[c].desc, playable: CARDS[c].cost <= me.energy && !me.ended_turn })) : [],
      piles: phase === 'combat' ? { draw: draw.length, discard: discard.length, exhaust: 0 } : null,
      options: d?.options ?? [],
    }
  }

  /** The upstream mod's markdown state for the same moment (structured off). */
  function stateText() {
    const s = seiState()
    const lines = [`# ${s.screen}`, `HP ${me.hp}/${me.max_hp} Gold ${me.gold}`]
    if (phase === 'combat') {
      lines.push(`Energy ${me.energy}`, '## Hand')
      hand.forEach((c, i) => lines.push(`- [${i}] ${c} (${CARDS[c].cost}): ${CARDS[c].desc}`))
      lines.push('## Enemies')
      s.enemies.forEach((e, i) => lines.push(`- [${i}] ${e.name} ${e.hp}/${e.max_hp} intent: ${e.intent}`))
    }
    s.options.forEach((o, i) => lines.push(`- '${i}': ${o.label}`))
    return lines.join('\n')
  }

  function nextNode(idx) {
    const node = MAP[mapStep][idx]
    run.floor += 1
    mapStep += 1
    if (node.fight) startFight(node.fight)
    else if (node.type === 'Rest Site') phase = 'rest'
    else phase = 'event'
  }

  const ok = (message = '') => ({ success: true, message })
  const bad = (message) => ({ success: false, message })

  /** Apply one action; returns the action/result the mod would send. */
  function apply(name, data = {}) {
    const d = decision()
    if (!d || !d.actions.some((a) => a.name === name)) return bad(`${name} is not a valid action right now`)
    const int = (k) => (Number.isInteger(data[k]) ? data[k] : null)
    switch (name) {
      case 'select_character': {
        const i = int('character_index')
        if (i == null || i < 0 || i >= d.options.length) return bad('Invalid character_index')
        me.character = d.options[i].label
        return ok(`Selected ${me.character}`)
      }
      case 'embark':
        phase = 'map'
        run.floor = 0
        return ok('Run started')
      case 'select_map_node': {
        const i = int('coordIndex') ?? 0
        if (i < 0 || i >= MAP[mapStep].length) return bad('Invalid coordIndex')
        nextNode(i)
        return ok('Travelling')
      }
      case 'play_card': {
        const i = int('card_index')
        if (i == null || i < 0 || i >= hand.length) return bad('Invalid card_index')
        const name2 = hand[i]
        const c = CARDS[name2]
        if (c.cost > me.energy) return bad(`Not enough energy to play ${name2}`)
        let target = null
        if (c.target === 'enemy') {
          const ei = int('enemy_index') ?? enemies.findIndex((e) => e.hp > 0)
          target = enemies[ei]
          if (!target || target.hp <= 0) return bad('Invalid enemy_index')
        }
        me.energy -= c.cost
        hand.splice(i, 1)
        discard.push(name2)
        if (c.target === 'all') for (const e of enemies) if (e.hp > 0) damageEnemy(e, c.dmg)
        if (target) damageEnemy(target, c.dmg)
        if (c.vuln && target) target.vuln += c.vuln
        if (c.block) me.block += c.block
        if (/Draw 1/.test(c.desc)) drawCards(1)
        log.push(`played ${name2}`)
        checkFightOver()
        return ok(`Played ${name2}`)
      }
      case 'use_potion': {
        const i = int('potion_index')
        if (i == null || i < 0 || i >= me.potions.length) return bad('Invalid potion_index')
        const p = me.potions.splice(i, 1)[0]
        const ally = int('ally_index')
        const who = ally != null && player && ally === 0 ? player : me
        who.block += p.block
        return ok(`Used ${p.name}`)
      }
      case 'end_turn':
        me.ended_turn = true
        log.push('companion ended turn')
        maybeEndRound()
        return ok('Turn ended')
      case 'select_card': {
        const i = int('card_index')
        if (i == null || i < 0 || i >= options.length) return bad('Invalid card_index')
        deck.push(options[i])
        phase = 'map'
        return ok(`Added ${options[i]} to your deck`)
      }
      case 'skip':
        phase = 'map'
        return ok('Skipped the card reward')
      case 'select_event_option': {
        const i = int('option_index')
        if (i == null || i < 0 || i >= d.options.length) return bad('Invalid option_index')
        if (phase === 'rest') {
          if (i === 0) me.hp = Math.min(me.max_hp, me.hp + Math.round(me.max_hp * 0.3))
        } else if (i === 0) { me.gold += 50; me.hp -= 6 }
        phase = 'map'
        return ok(`Chose ${d.options[i].label}`)
      }
      default:
        return bad('unknown action')
    }
  }

  return {
    get phase() { return phase },
    get me() { return me },
    get player() { return player },
    get enemies() { return enemies },
    get hand() { return hand },
    get deck() { return deck },
    get round() { return round },
    get run() { return run },
    log,
    decision,
    seiState,
    stateText,
    apply,
    playerActs,
    /** Drain the sei/event queue. */
    takeEvents() { return events.splice(0, events.length) },
    structured,
  }
}
