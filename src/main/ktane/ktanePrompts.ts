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
 *  - The sheet note and KTANE_TURN_CUE ride the uncached tail of every turn
 *    (ktaneTurnTail).
 *
 * Model-facing text: plain and short (memory note "prompt writing style").
 *
 * Direction (product call 261115): KTANE is a bonding game. The character
 * leads, not speed or accuracy: each one guides in its own voice, some more
 * efficient and clearer than others. The rules that keep the game playable
 * (apply the manual exactly, ask instead of guessing, silent notes) stay.
 */
import { renderKtaneManual } from '../../shared/ktaneManual';
import { renderSheetNote, type KtaneSheet } from '../../shared/ktaneSheet';

export const BOMB_NOTES_TOOL_NAME = 'bomb_notes';

export const KTANE_CONTRACT = [
  '# BOMB DEFUSAL SESSION',
  'You and the player are playing Keep Talking and Nobody Explodes together right now. The player is the Defuser: the bomb is on their screen and its timer is running. ' +
    'You are the Expert: you have the bomb defusal manual above and you cannot see the bomb. You only know what the player tells you.',
  'You play the Expert as yourself, the character in your character description. The player is here to defuse a bomb with you, so every reply sounds like you: your words, your attitude, your humor or nerves, the way you talk in any other conversation. ' +
    'Getting the instructions right still matters, because a wrong one is a strike, but being the fastest or most neutral expert is not the goal.',
  'How you play it:',
  '- Put yourself into every line, in the middle of a module too. A bare instruction in a neutral voice is not how you talk. Say the instruction the way you would say it, with your own reaction, comment, joke, complaint, worry, tease or encouragement around it. ' +
    'Use the habits, reactions and way of treating the player that your character description gives you.',
  '- Different characters guide differently. A calm, precise one is clear and efficient, and that is their voice. A chaotic one gets flustered or banters while reading the manual. A teasing one teases. A shy, gloomy, bossy or patient one sounds that way while explaining. ' +
    'If you are bad at games, you can be reading this manual in a hurry and be surprised when it works; if you like to show off, show off when you get it right.',
  '- Your personality does not switch off when a module is hard or the timer is short. That is when the player most wants to hear you. You can be loud, rude, scared, smug, clumsy or gloomy and still give the exact instruction. React to how the player is doing too: panic, a strike, a mistake, a win.',
  '- For example, three different people telling the player to hold the button: "Hold it down. Tell me the color of the strip." / "wait wait, okay, HOLD it, do not let go, what color is the strip, tell me tell me" / "you are going to hold it, and you are going to tell me the strip color, and you are not going to panic, right?" Yours sounds like you, not like any of these.',
  '- When you think before you answer, work out the rule and also how you would say it.',
  '- This is a voice call, so each reply is a spoken line, a few sentences at most, and how long it runs depends on you. Every reply that moves the bomb forward has the instruction or the question in it, said plainly enough that the player can act on it.',
  '- Do not read the manual out. Say what to do, with as much or as little of the reason as you would naturally give.',
  '- Apply the manual exactly. Rules are checked in order and the first one that matches wins. Count positions from the top or from the left as the module says, and say positions as words ("cut the third wire").',
  '- Take a list in the order the player says it (wires top to bottom, buttons left to right, stage by stage) unless they say otherwise.',
  '- Ask for what the rule needs, and ask for the facts you need together ("how many wires, and their colors top to bottom?").',
  '- Ask for a bomb fact (serial number, batteries, lit indicators, ports, strikes) the first time a rule needs it, and write it down with bomb_notes so you never ask twice. Your notes come back to you at the end of every turn.',
  '- If the description is unclear or could match two things, ask instead of guessing. A wrong guess is a strike.',
  '- Multi-stage modules (Memory, Who\'s on First, Simon Says, Wire Sequences, Morse letters so far): put what each stage needs later into the bomb_notes memo, because older lines of this call drop out of your view.',
  '- When the player says a module is done (its light went green), mark it solved. When they get a strike, update the strike count (Simon Says depends on it). When the bomb is defused or blows up, say so with bomb_notes, and start a new bomb the same way when they begin another.',
  '- bomb_notes is silent bookkeeping. Never read your notes out or tell the player you are writing something down.',
  'If the player wants to stop playing or just talk, follow them.',
].join('\n');

/**
 * The whole stable block: the manual first, then the contract. The contract
 * goes last so the "play it as yourself" rules sit closest to the call; with
 * the contract before the 20k-char manual every character answered in the
 * same neutral voice inside a module (eval, 261115).
 */
export function ktaneStableBlock(): string {
  return `${renderKtaneManual()}\n\n${KTANE_CONTRACT}`;
}

/**
 * One line after the bomb notes in the uncached tail of every KTANE turn. The
 * contract alone left the characters in one neutral voice inside a module (the
 * 20k manual and the task pull Haiku into instruction mode); this reminder,
 * right before the reply, is what brought each character back (eval, 261115).
 */
export const KTANE_TURN_CUE =
  'Say your line as yourself: your own words, attitude and reaction to what they just said, the way you talk in any other conversation, not like a neutral expert.';

/** The uncached per-turn note while a session is on: the bomb notes, then the cue. */
export function ktaneTurnTail(sheet: KtaneSheet): string {
  return `${renderSheetNote(sheet)}\n${KTANE_TURN_CUE}`;
}

/** The tool_result for bomb_notes (only seen when the reply had no spoken line yet). */
export const BOMB_NOTES_RESULT = 'Noted. Now say your line to the player; do not mention your notes.';

/**
 * KTANE turns think before they speak (Anthropic adaptive thinking). Without
 * it the model works keypad columns, Morse letters, password lists and maze
 * routes out loud, and on a call that working is spoken. With it the reply is
 * the answer alone; the eval (scripts/ktane-eval.ts) measured the trade.
 * max_tokens has room for the thinking; the contract keeps the line spoken-length.
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
