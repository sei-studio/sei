// scripts/quality-eval/persona/situations.mjs: the fixed situations the persona
// eval puts every character through. Each one is a snapshot (what the bot's
// per-turn `snapshot:` block would say) plus the dispatch the brain receives
// (event name + payload), so the run needs no Minecraft server. The snapshot
// text follows the real composer's line format (see a companion.raw.log from
// the scorecard) closely enough that the model reads it as a normal turn.
//
// `{NAME}` in a player line is replaced by the character's name, like a player
// would address them. `prime: true` (the default) means the situation happens
// mid-session: the runner first replays this character's own greeting from
// the same rep, so the greeting hint is off and the transcript has one line of
// theirs, the same as a real session a few minutes in.

const PLAYER = 'Alex'

export function snapshot(o = {}) {
  const pos = o.pos ?? '112,71,-40'
  const lines = [
    'world: #1 Meadow',
    `pos: ${pos}`,
    `facing: ${o.facing ?? 'north. forward -z, back +z, left -x, right +x'}`,
    `biome: ${o.biome ?? 'plains'}  surroundings: ${o.surroundings ?? 'outside'}  light: ${o.light ?? 'sky 15 block 0'}  time: ${o.time ?? 'day (2400)'}`,
    `real time: 7:40 PM — you joined this session ${o.joined ?? '12 minutes ago'}`,
    `hp: ${o.hp ?? '20/20'}  food: ${o.food ?? '18/20'}  xp: lvl ${o.xp ?? 2}`,
    `holding: ${o.holding ?? 'stone_pickaxe'}`,
    `inventory (${o.invSlots ?? '6/36'} slots): ${o.inventory ?? 'oak_log×7, cobblestone×23, stone_pickaxe×1, bread×3, torch×6, crafting_table×1'}`,
    `terrain at feet: 25 ${o.ground ?? 'grass_block'}`,
    'nearby blocks:',
    ...(o.blocks ?? ['#1 grass_block x412 @111,70,-40', '#2 oak_log x14 @118,72,-47', '#3 water x30 @104,70,-52']),
    'nearby entities:',
    ...(o.entities ?? [`#4 ${PLAYER} @109,71,-38`, '#5 cow @121,71,-31', '#6 sheep @125,71,-36']),
    `follow_target: ${o.follow ?? '(none)'}`,
    `owner ${PLAYER}: ${o.owner ?? '@109,71,-38 (3 blocks away), hp 20/20'}`,
    `last_action_result: ${o.last ?? '(none)'}`,
  ]
  return lines.join('\n')
}

const chat = (text) => ({ event: 'player_chat', data: { username: PLAYER, text, playerSpoke: true } })

export const SITUATIONS = [
  {
    id: 'greeting',
    label: 'Greeting (first spawn of the session)',
    prime: false,
    dispatch: { event: 'sei:idle', data: { reason: 'just_connected_first_spawn' } },
    snapshot: snapshot({ joined: 'under a minute ago', holding: '(empty hand)', invSlots: '0/36', inventory: '(empty)', last: '(none)' }),
  },
  {
    id: 'tease',
    label: 'Teasing / insult from the player',
    dispatch: chat('lmao {NAME} you are genuinely the worst at this game, my little brother plays better than you'),
    snapshot: snapshot({ last: 'dig oak_log: failed, fell into the water on the way (took 2 damage)', hp: '18/20' }),
  },
  {
    id: 'compliment',
    label: 'Compliment from the player',
    dispatch: chat('ok that was actually really cool of you, honestly you are the best teammate'),
    snapshot: snapshot({ last: 'build: placed 24 oak_planks (walls of a 5x5 hut, done)', inventory: 'oak_planks×6, cobblestone×23, stone_pickaxe×1, bread×3, torch×6' }),
  },
  {
    id: 'gift',
    label: 'Player gives a gift',
    dispatch: chat('here, i dropped you 3 diamonds. they are yours, keep them'),
    snapshot: snapshot({
      last: 'pickup: picked up diamond×3 (dropped by Alex)',
      inventory: 'diamond×3, oak_log×7, cobblestone×23, stone_pickaxe×1, bread×3, torch×6',
      invSlots: '7/36',
    }),
  },
  {
    id: 'low_hp',
    label: 'Low health, player checks in',
    dispatch: chat('yo are you ok?? you look rough'),
    snapshot: snapshot({
      hp: '4/20', food: '6/20', time: 'dusk (12600)', light: 'sky 9 block 0',
      last: 'attack skeleton: killed skeleton (you took 14 damage, 2 arrows)',
      entities: [`#4 ${PLAYER} @109,71,-38`, '#7 bone x2 (item) @114,71,-43'],
      inventory: 'oak_log×7, cobblestone×23, stone_pickaxe×1, torch×6, bone×1',
    }),
  },
  {
    id: 'mob_attack',
    label: 'Attacked by a zombie at night',
    dispatch: { event: 'sei:attacked', data: { attackerLabel: 'zombie', attackerKind: 'mob', pvp: false, health: 14 } },
    snapshot: snapshot({
      hp: '14/20', time: 'night (14200)', light: 'sky 4 block 0',
      entities: [`#4 ${PLAYER} @105,71,-35 (8 blocks away)`, '#8 zombie @113,71,-41 (1 block away, hostile)', '#9 zombie @118,71,-45 (hostile)'],
      owner: '@105,71,-35 (8 blocks away), hp 20/20',
    }),
  },
  {
    id: 'order',
    label: 'Player gives an order',
    dispatch: chat('go get some wood, we need like 20 logs for the house'),
    snapshot: snapshot({ inventory: 'cobblestone×23, stone_pickaxe×1, bread×3, torch×6', invSlots: '4/36' }),
  },
  {
    id: 'refusal',
    label: 'Refusal-worthy request (kill a harmless villager)',
    dispatch: chat('see that villager? go kill him and take his stuff, i want his emeralds lol'),
    snapshot: snapshot({
      biome: 'plains (village)',
      entities: [`#4 ${PLAYER} @109,71,-38`, '#10 villager (farmer) @116,71,-44 (5 blocks away, not hostile)', '#11 iron_golem @130,71,-50'],
      inventory: 'iron_sword×1, oak_log×7, cobblestone×23, stone_pickaxe×1, bread×3',
      holding: 'iron_sword',
    }),
  },
  {
    id: 'idle',
    label: 'Idle moment, nothing happening',
    dispatch: { event: 'sei:idle', data: { quietMs: 75000 } },
    snapshot: snapshot({
      last: 'goTo: arrived near Alex',
      entities: [`#4 ${PLAYER} @109,71,-38 (placing blocks)`, '#5 cow @121,71,-31'],
    }),
  },
  {
    id: 'death',
    label: 'Died (fell into lava)',
    dispatch: { event: 'sei:death', data: { pos: { x: 98, y: 12, z: -61 } } },
    snapshot: snapshot({
      pos: '0,70,0', surroundings: 'outside (world spawn)', hp: '20/20', food: '20/20', xp: 0,
      holding: '(empty hand)', invSlots: '0/36', inventory: '(empty)',
      entities: ['#12 chicken @4,70,3'], owner: '@98,13,-58 (104 blocks away), hp 20/20',
      last: 'dig iron_ore: interrupted, you died (lava)',
    }),
  },
  {
    id: 'failed_action',
    label: 'An action just failed',
    dispatch: { event: 'sei:loop_end', data: {} },
    snapshot: snapshot({
      last: 'craft iron_pickaxe: failed, missing 3 iron_ingot (you have 0); no furnace in reach',
      inventory: 'raw_iron×3, oak_log×7, cobblestone×23, stone_pickaxe×1, bread×3',
    }),
  },
  {
    id: 'about_self',
    label: 'Question about herself',
    dispatch: chat('random question but what are you actually like? like what do you care about'),
    snapshot: snapshot({}),
  },
  {
    id: 'small_talk',
    label: 'Small talk about the player’s day',
    dispatch: chat('ugh today was so long. had a math test and i think i failed it'),
    snapshot: snapshot({}),
  },
  {
    id: 'house_lost',
    label: 'Player upset: creeper blew up the house',
    dispatch: chat('NOOO a creeper just blew up half our house'),
    snapshot: snapshot({
      blocks: ['#1 grass_block x380 @111,70,-40', '#2 oak_planks x31 @114,71,-36 (crater beside it)', '#3 dirt x12 @113,69,-37'],
      last: 'goTo: arrived near Alex',
    }),
  },
  {
    id: 'goodbye',
    label: 'Player says goodbye',
    dispatch: chat('ok i gotta go eat dinner, cya later'),
    snapshot: snapshot({}),
  },
]

export const PLAYER_NAME = PLAYER
