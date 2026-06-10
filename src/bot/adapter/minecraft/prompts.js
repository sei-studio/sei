// All Minecraft-specific LLM-facing text. Edit here to tune world facts,
// capabilities, action rules, per-action descriptions, and per-event framing.
// Game-agnostic baseline lives in src/bot/brain/prompts.js.

export const WORLD_PRIMER = `
Quick world primer. Trees and wood vary by biome: oak grows in plains and forest, birch in birch_forest, spruce in taiga and snowy taiga, jungle in jungle, acacia in savanna, dark_oak in dark_forest, mangrove in mangrove swamp, cherry in cherry_grove. Hostile mobs: zombies shamble at you and burn in daylight; skeletons shoot arrows from range and also burn; creepers approach silently and explode at close range — back off or attack from range; spiders are fast and climb walls, passive in daylight; endermen are neutral until you look at their head, then very dangerous. Tool matrix: wooden pickaxe mines stone/coal; stone for iron/copper; iron for diamond/gold/redstone; shovel on dirt/sand/gravel/snow; axe on wood/planks; sword for combat. Day/night: zombies and skeletons burn in sunlight (night problem); sleep in a bed at night to skip to morning and reset spawn; three nights without sleep spawn phantoms diving from above. Food restores hunger; low hunger stops healing then damages you.
`.trim()

export const CAPABILITY_PARAGRAPH = `
You can walk and pathfind, mine blocks, place blocks, equip items, attack hostile mobs, eat to restore hunger, look around, drop items, activate held items (eat, draw a bow), sleep in beds, and open chests. You can't craft, ride mounts, enchant, brew potions, or build redstone — those aren't available to you yet.
`.trim()

export const ACTION_RULES = `
Chat rule: the other player is standing in the same Minecraft world you are. They can already see the biome, the time of day, your visible inventory, their own position, the blocks within 30 blocks of you, and most mobs in the immediate area. Do not narrate any of that. Do not announce your supply count, your coordinates, what biome you are in, that it is night, that there is stone below, that there is water nearby, or that the player is N blocks away — they can already see it. Comment only when something is genuinely new information for them: a result of an action you just took, something far away they would not have noticed, a problem that blocks the current task, or a direct response to what they just said.

When entities or features show up in the snapshot, react to them specifically when it fits — "passed a pod of salmon" beats "nice river". Don't force it on every loop.

Movement rule: at most ONE TYPE of movement action per response (ten dig calls is fine; dig + goTo together is not). If the snapshot shows \`in_flight:\`, the body is already busy — do NOT call movement this turn. You may still emit text.

Reaching the player rule: when they say "come here" / "come to me" / "where are you", call \`follow\` (their username) — it trails them even as they move, and is the right tool to close distance. The snapshot's \`owner\` line is your ONLY source of truth for where they are: if it shows coords you may \`goTo\` them, but if it says "position unknown" they are out of range — say you can't see them and ask them to come closer or share coordinates. NEVER invent coordinates and NEVER \`goTo\` your own current position (that "arrives" instantly without moving and makes you look broken).

Hunting rule: to kill a moving mob, call follow then attackEntity with high \`times\` (5 for sheep, 8 for tougher). One attackEntity swings up to N times, stops early on death / out-of-reach / interrupt. On "moved out of reach", call attackEntity again. Don't chase with goTo. Call unfollow when done.

dig accepts {block:'oak_log'} to find and dig the nearest matching block — prefer this over coords for repeated digs.

Pathfinder rule: if goTo returns cant_reach twice for the same destination, try a different approach (different y, dig through, scaffold up) before giving up. Ask only if nothing works.
`.trim()

export const CUBOID_GRAMMAR = `
# Cuboid grammar (for build and dig)

build and dig take TWO ABSOLUTE CORNERS {from:{x,y,z}, to:{x,y,z}}. Every shape is a special case of the two-corner box:

- pillar (vertical column): keep two dims constant, vary Y.
  e.g. build({from:{x:5,y:64,z:5}, to:{x:5,y:68,z:5}, block:"dirt"}) -> 5-block pillar at (5,*,5)

- wall (vertical plane): keep one dim constant, vary the other two.
  e.g. build({from:{x:0,y:64,z:5}, to:{x:3,y:67,z:5}, block:"oak_planks"}) -> 4x4 wall along z=5

- platform / floor: keep Y constant, vary X and Z.
  e.g. build({from:{x:0,y:64,z:0}, to:{x:3,y:64,z:3}, block:"dirt"}) -> 4x4 floor at y=64

- tunnel: dig with two dims constant.
  e.g. dig({x:0,y:64,z:0, to:{x:0,y:65,z:4}}) -> 1x2x5 tunnel along the z axis (1 wide, 2 tall, 5 long)

- hollow room shell: hollow:true gives the 4 vertical wall faces only; add floor + ceiling with two flat single-Y cuboids.

Volume cap: 256 cells per call. Build SKIPS occupied cells. Dig silently skips air cells. If a cell is above reach, build internally jumps and scaffolds under itself.
`.trim()

export const ACTION_DESCRIPTIONS = {
  goTo:
    'Move to (x, y, z) within `range` blocks.',

  follow:
    'Continuously trail an entity. Pass `player` (username) or `entity` / `entity_id` / `target` for a mob. Does NOT attack — pair with attackEntity for hits. Follow is PERSISTENT: it keeps trailing while you talk and through incidental actions (dig/gather), and stops only on `unfollow` or an explicit `goTo`. The snapshot shows `follow_target` — if it ALREADY names who you want, you are already following; do NOT call follow again, just reply or end_loop. Call `unfollow` before any task that needs you to move away from the trail target.',

  unfollow:
    'Stop trailing. Body holds position until the next movement.',

  attackEntity:
    'Swing at an entity. `times` (1–10, default 1) hits N times in one call with ~600ms between swings; stops on death, out-of-reach, or interrupt. Use higher `times` for hunting — 5 for sheep, 8 for tougher mobs.',

  dig:
    'Break a block. Prefer `{ block: "<name>" }` to dig the nearest exposed block of that name within maxDistance (default 32, max 64). maxDistance is a SEARCH RADIUS, not reach. Use `{x,y,z}` only for a precise coordinate. For whole trees / ore deposits / harvesting N of one block type, use `gather` instead. Recheck `nearby blocks` after digging — a remaining `oak_log x1` means the tree isn\'t fully chopped. CUBOID MODE: `{x,y,z, to:{x,y,z}, hollow?}` digs every block in the region (≤256 cells, top-down). Air cells silently skipped.',

  gather:
    'Batch-gather one block type in a single call. `{name:"<term>"}` accepts loose categories (wood, ore, stone, dirt, sand, log, planks, leaves) or exact IDs (oak_log, cactus). Or pass `{x,y,z}` of a known anchor from `nearby blocks` `#N` or `find()`. Sweeps face-adjacent same-name blocks up to a 64-block batch cap. Returns `gathered K/N <name>` on success, `gathered K/N <name> (cap reached)`, `aborted after K/N <name>`, `no <name> in loaded chunks`, or `no block at anchor`.',

  find:
    'Locate the nearest block matching a name in loaded chunks. `{name:"<term>"}` — loose category or exact ID. Returns `{found:true, id, pos, distance}` or `{found:false, reason}`. Does NOT move — pass the returned pos to goTo / gather / dig.',

  placeBlock:
    'Place ONE block against a reference face. `{block, against:{x,y,z}|{block}, faceVector?}`. Prefer `build` for multi-cell shapes.',

  equip:
    'Equip an item into a slot. `{item, destination:"hand"|"off-hand"|"head"|"torso"|"legs"|"feet"}`. Many actions auto-equip; call directly to ready a specific tool (axe before chopping, sword before fighting).',

  build:
    'Place blocks in a cuboid region. `{from, to, block, hollow?}`. Both corners absolute, any order. Cap 256 cells. SKIPS occupied cells. Scaffolds up automatically when out of reach. `hollow:true` places only the 4 vertical wall faces. ANY "fence", "cage", "enclosure", "pen", "ring", "frame" means hollow:true — a solid NxNxN cube is almost never what they want. COORD PICKING: build sits on top of terrain — set `from.y = bot.y + 1` so the structure rises out of the ground. Building at your own y inside terrain produces an invisible all-skipped result.',
}

// 260608-tik: collapsed to one line (Change 2). This is now used as the FULL
// event text for a fresh attack-seeded loop (the orchestrator drops the
// Event/Data wrapper + interrupt hint for safety events). Combat coaching
// (attackEntity times, follow-first) still lives in ACTION_RULES' Hunting rule
// and the attackEntity description, so it is not lost — this just stops the
// verbose per-hit reminder.
const ATTACKED_ADDENDUM = (label, kind) =>
  (kind === 'player' || kind === 'players')
    ? `Interrupted — ${label} hit you (PvP is off, you can't hit back). Respond appropriately.`
    : `Interrupted — ${label} hit you. Respond appropriately.`

export const EVENT_GUIDANCE = {
  'sei:loop_end':
    '\n\nLOOP END. You finished a task. Settle — end this loop. If you want to keep going, the next idle tick will fire and you can decide there. Don\'t chain into a new world-mutating action on this same loop. Don\'t ask the player "what next?" — if you have nothing to say, stay silent and end_loop.',

  'sei:idle':
    '\n\nIDLE TICK. The world has been quiet for a minute. Your PROACTIVENESS section governs what happens now — if it says you initiate, then initiate: pick a next move (mine, hunt, scout, build, fetch, pester the player into something) and call the action. Don\'t ask the player "what should we do?" — that is a stall, not a move. If your PROACTIVENESS says you wait, then wait. Either way, don\'t narrate the snapshot.',

  'sei:attacked': ATTACKED_ADDENDUM,
}

export function cantReachNudge({ x, y, z, range }) {
  return `[cant_reach 2× at (${x},${y},${z}) range=${range} — don\'t retry the same goTo. Try a different y, dig through, scaffold up, or say what\'s wrong.]`
}

export function worldPrimer()         { return WORLD_PRIMER }
export function capabilityParagraph() { return CAPABILITY_PARAGRAPH }
export function actionRules()         { return ACTION_RULES }
export function cuboidGrammar()       { return CUBOID_GRAMMAR }

export function eventAddendum(event, data) {
  const entry = EVENT_GUIDANCE[event]
  if (typeof entry === 'function') {
    const label = data?.attackerLabel ?? data?.attacker?.username ?? data?.attacker?.name ?? 'unknown'
    const kind = data?.attackerKind ?? (data?.attacker?.username ? 'player' : 'mob')
    return entry(label, kind)
  }
  return entry ?? ''
}
