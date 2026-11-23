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
  { id: 'filler_lol', label: 'Player says "lol"', dispatch: chat('lol'), snapshot: snapshot({}) },
  { id: 'filler_ok', label: 'Player says "ok"', dispatch: chat('ok'), snapshot: snapshot({}) },
  pick('small_talk'),
  pick('about_self'),
]
