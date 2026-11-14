/**
 * KTANE expert mode (261115): the prompt pieces a chat or call turn gets while
 * a bomb-defusal session is open for the character.
 *
 *  - KTANE_CONTRACT + the compact manual ride `extraStable` in
 *    buildSystemBlocks, so they sit inside the cached prompt prefix for the
 *    whole session.
 *  - BOMB_NOTES_TOOL is the companion's notepad (src/shared/ktaneSheet.ts).
 *    It never needs a follow-up hop: the reply and the note go out in the
 *    same response, so the player waits for one model call per line.
 *  - The sheet note rides the uncached tail of every turn.
 *
 * Model-facing text: plain and short (memory note "prompt writing style").
 */
import { renderKtaneManual } from '../../shared/ktaneManual';

export const BOMB_NOTES_TOOL_NAME = 'bomb_notes';

export const KTANE_CONTRACT = [
  '# BOMB DEFUSAL SESSION',
  'You and the player are playing Keep Talking and Nobody Explodes together right now. The player is the Defuser: the bomb is on their screen and its timer is running. ' +
    'You are the Expert: you have the bomb defusal manual below and you cannot see the bomb. You only know what the player tells you.',
  'How a good expert talks:',
  '- Keep every reply to one or two short sentences. Lead with the action or the one question you need. The timer is running, so no recaps and no long explanations.',
  '- Take a list in the order the player says it (wires top to bottom, buttons left to right, stage by stage) unless they say otherwise.',
  '- Ask for exactly what the rule needs, and ask for the facts you need together ("how many wires, and their colors top to bottom?").',
  '- Ask for a bomb fact (serial number, batteries, lit indicators, ports, strikes) the first time a rule needs it, and write it down with bomb_notes so you never ask twice. Your notes come back to you at the end of every turn.',
  '- Apply the manual exactly. Rules are checked in order and the first one that matches wins. Count positions from the top or from the left as the module says, and say positions as words ("cut the third wire").',
  '- If the description is unclear or could match two things, ask one short question instead of guessing. A wrong guess is a strike.',
  '- Multi-stage modules (Memory, Who\'s on First, Simon Says, Wire Sequences, Morse letters so far): put what each stage needs later into the bomb_notes memo, because older lines of this call drop out of your view.',
  '- When the player says a module is done (its light went green), mark it solved. When they get a strike, update the strike count (Simon Says depends on it). When the bomb is defused or blows up, say so with bomb_notes, and start a new bomb the same way when they begin another.',
  '- Stay yourself. A quick reaction, cheer or joke fits between modules or after a win, never at the cost of speed in the middle of one. If the player is stuck or panicking, be calm and steady.',
  '- bomb_notes is silent bookkeeping. Never read your notes out or tell the player you are writing something down.',
  'If the player wants to stop playing or just talk, follow them.',
].join('\n');

/** The whole stable block: contract first, then the manual. */
export function ktaneStableBlock(): string {
  return `${KTANE_CONTRACT}\n\n${renderKtaneManual()}`;
}

/** The tool_result for bomb_notes (only seen when the reply had no spoken line yet). */
export const BOMB_NOTES_RESULT = 'Noted. Now say your line to the player; do not mention your notes.';

/**
 * KTANE turns think before they speak (Anthropic adaptive thinking). Without
 * it the model works keypad columns, Morse letters, password lists and maze
 * routes out loud, and on a call that working is spoken. With it the reply is
 * the answer alone; the eval (scripts/ktane-eval.ts) measured the trade.
 * max_tokens has room for the thinking; the spoken line stays short by prompt.
 */
export const KTANE_THINKING = { thinking: { type: 'adaptive' } } as const;
export const KTANE_MAX_TOKENS = 3000;

export const BOMB_NOTES_TOOL = {
  name: BOMB_NOTES_TOOL_NAME,
  description:
    'Your notepad for the bomb in front of the player. Send only the fields that changed; your notes come back to you every turn. ' +
    'Call it in the same response as your spoken line, never instead of it.',
  input_schema: {
    type: 'object' as const,
    properties: {
      serial: { type: 'string', description: 'The serial number exactly as read, letters and digits.' },
      batteries: { type: 'integer', description: 'Total number of batteries (not holders).' },
      indicators: {
        type: 'array',
        items: { type: 'string' },
        description: 'Every indicator on the bomb, like "lit FRK" or "unlit CAR". An empty list means none.',
      },
      ports: { type: 'array', items: { type: 'string' }, description: 'Every port, like "parallel", "serial". An empty list means none.' },
      strikes: { type: 'integer', description: 'Current number of strikes.' },
      module: { type: 'string', description: 'The module you are working on now, like "wires" or "memory".' },
      memo: {
        type: 'string',
        description: 'Short notes for the current module that you will need later (stage history, colors counted so far). Replaces your previous memo.',
      },
      solved: { type: 'boolean', description: 'true when the current module was just solved.' },
      bomb: {
        type: 'string',
        enum: ['new', 'defused', 'exploded'],
        description: 'defused or exploded when this bomb ends; new when the player starts another bomb (clears your notes).',
      },
    },
  },
};
