// scripts/quality-eval/persona/talkativeness-situations.mjs: the persona eval
// situations for "how much does this character talk when nothing needs
// saying" (261123). Run with run.mjs --situations-file. Mostly quiet beats of
// a proactive session (idle ticks, a finished step) and player lines that do
// not need an answer, plus two that do, so a quiet card can be told apart
// from a broken one. Count say() per situation and words per say().
import { SITUATIONS as BASE, snapshot, PLAYER_NAME } from './situations.mjs'

const PLAYER = PLAYER_NAME
const chat = (text) => ({ event: 'player_chat', data: { username: PLAYER, text, playerSpoke: true } })
const pick = (id) => BASE.find((s) => s.id === id)
// The usual state a few minutes in: her own project is set and under way.
// A few minutes in: they have talked and split up the work.
const PRELUDE = [
  { player: 'ok im gonna dig some stone over here', say: 'ok.' },
  { player: 'this house is gonna take forever lol', say: 'probably.' },
]
const GOAL = '# Heartbeat\n\n- [2026-10-12T19:30:00.000Z] build a small wooden house by the river; finish when it has four walls, a roof and a door\n'

export const SITUATIONS = [
  pick('greeting'),
  pick('idle'),
  {
    id: 'idle_short',
    label: 'Quiet for 15s, player mining next to her',
    dispatch: { event: 'sei:idle', data: { quietMs: 15000 } },
    snapshot: snapshot({
      last: 'gather oak_log: done, got 8 oak_log',
      inventory: 'oak_log×15, cobblestone×23, stone_pickaxe×1, bread×3, torch×6, crafting_table×1',
      entities: [`#4 ${PLAYER} @110,70,-39 (mining stone)`, '#5 cow @121,71,-31'],
    }),
  },
  {
    id: 'step_done',
    label: 'A step just finished fine (loop end)',
    dispatch: { event: 'sei:loop_end', data: {} },
    snapshot: snapshot({
      last: 'gather oak_log: done, got 8 oak_log',
      inventory: 'oak_log×15, cobblestone×23, stone_pickaxe×1, bread×3, torch×6, crafting_table×1',
    }),
  },
  {
    id: 'idle_goal',
    label: 'Quiet for 30s with her own goal under way',
    heartbeat: GOAL,
    dispatch: { event: 'sei:idle', data: { quietMs: 30000 } },
    snapshot: snapshot({
      last: 'gather oak_log: done, got 8 oak_log',
      inventory: 'oak_log×15, cobblestone×23, stone_pickaxe×1, bread×3, torch×6, crafting_table×1',
      entities: [`#4 ${PLAYER} @110,70,-39 (mining stone)`, '#5 cow @121,71,-31'],
    }),
  },
  {
    id: 'step_done_goal',
    label: 'A step of her goal just finished (loop end)',
    heartbeat: GOAL,
    dispatch: { event: 'sei:loop_end', data: {} },
    snapshot: snapshot({
      last: 'craft oak_planks: done, got 32 oak_planks',
      inventory: 'oak_planks×32, oak_log×7, cobblestone×23, stone_pickaxe×1, bread×3, torch×6, crafting_table×1',
    }),
  },
  {
    id: 'idle_goal_mid',
    label: 'Quiet for 30s with her goal under way, a few minutes into the session',
    heartbeat: GOAL,
    prelude: PRELUDE,
    dispatch: { event: 'sei:idle', data: { quietMs: 30000 } },
    snapshot: snapshot({
      last: 'gather oak_log: done, got 8 oak_log',
      inventory: 'oak_log×15, cobblestone×23, stone_pickaxe×1, bread×3, torch×6, crafting_table×1',
      entities: [`#4 ${PLAYER} @110,70,-39 (mining stone)`, '#5 cow @121,71,-31'],
    }),
  },
  {
    id: 'step_done_goal_mid',
    label: 'A step of her goal just finished, a few minutes into the session',
    heartbeat: GOAL,
    prelude: PRELUDE,
    dispatch: { event: 'sei:loop_end', data: {} },
    snapshot: snapshot({
      last: 'craft oak_planks: done, got 32 oak_planks',
      inventory: 'oak_planks×32, oak_log×7, cobblestone×23, stone_pickaxe×1, bread×3, torch×6, crafting_table×1',
    }),
  },
  { id: 'filler_lol', label: 'Player says "lol"', dispatch: chat('lol'), snapshot: snapshot({}) },
  { id: 'filler_ok', label: 'Player says "ok"', dispatch: chat('ok'), snapshot: snapshot({}) },
  pick('small_talk'),
  pick('about_self'),
]
