/**
 * Draw! prompts + the pen tool (260727).
 *
 * Two turn kinds share one contract:
 *   guess  the player is drawing; the character looks at snapshots of their
 *          canvas and says guesses in chat. Plain text only, no tools.
 *   draw   the character has a word and draws it with the `pen` tool. Plain
 *          text is still chat, so it can banter or answer a hint request
 *          mid-drawing.
 *
 * Cache layout follows chess: everything that is constant for the WHOLE game
 * (the rules, the coordinate space, the pen contract) goes in `extraStable`
 * so it rides inside the cached system region across all ten turns; only the
 * volatile per-turn block is re-billed. Putting the role-specific instructions
 * in the turn block rather than in extraStable is deliberate — a game
 * alternates roles every turn, so a role-split contract would miss the cache
 * on every single turn.
 *
 * The `pen` tool is adapted from tldraw's agent template (MIT) PenAction, kept
 * deliberately narrower: no colour, no fill, no shape ids. The pen here is
 * always black at one thickness because that is the only tool the player gets
 * too, so the two hands produce comparable pictures.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { CANVAS_H, CANVAS_W, type DrawChatMessage, type DrawRole } from '../../shared/drawIpc';

/** Strokes the character may spend on one picture before we cut it off. */
export const MAX_AI_STROKES = 16;
/**
 * Tool-use hops per drawing turn, so a stuck model cannot spin. A hop yields
 * roughly two to four strokes, so this has to be generous enough for a whole
 * picture plus a couple of replies.
 */
export const MAX_DRAW_HOPS = 10;

export const PEN_TOOL: Anthropic.Tool = {
  name: 'pen',
  description:
    'Draw one freehand stroke on the canvas. The pen is DOWN for the whole stroke and lifts when the call ends, so each call is one continuous line: to lift the pen and start somewhere else, make another pen call. ' +
    'Give the path as a list of points. Use "smooth" to curve through them (best for anything round or organic) and "straight" to keep hard corners between them (best for boxes, roofs, stick limbs). ' +
    'Set "closed" to join the last point back to the first for a complete outline. ' +
    'You do not control colour or thickness: every stroke is black at a single thickness, like a marker.',
  input_schema: {
    type: 'object',
    properties: {
      intent: {
        type: 'string',
        description:
          'What this stroke is, in a few words ("the head outline", "left ear"). Never shown to the player.',
      },
      points: {
        type: 'array',
        description:
          'The path, in order. Two points make a line; more points make a shape. Keep it under 40 points: the stroke is smoothed and humanized after you send it, so you are sketching the path, not every pixel.',
        items: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
          },
          required: ['x', 'y'],
        },
      },
      style: {
        type: 'string',
        enum: ['smooth', 'straight'],
      },
      closed: {
        type: 'boolean',
        description: 'Join the last point back to the first.',
      },
    },
    required: ['intent', 'points', 'style', 'closed'],
  },
};

/**
 * The whole-game contract. Constant from the first turn to the last, so it
 * belongs in the cached system region.
 */
export function drawContractBlock(opts: {
  playerName: string;
  rounds: number;
  turnSeconds: number;
}): string {
  const { playerName, rounds, turnSeconds } = opts;
  return [
    '# DRAW! GAME',
    `You are playing Draw!, a sketch-guessing game, against ${playerName} inside the Sei app. ` +
      `The game is ${rounds} round${rounds === 1 ? '' : 's'}. Each round you both get a turn: one of you draws a secret word ` +
      `while the other guesses in chat. A turn lasts ${turnSeconds} seconds and ends early the moment the guesser says the word.`,
    'Every plain-text line you write is sent to the game chat, exactly as written, and the other player sees it. ' +
      'Keep lines short, one or two at a time, the way someone actually talks while doodling.',
    '',
    '## The canvas',
    `The canvas is ${CANVAS_W} wide and ${CANVAS_H} tall. 0,0 is the TOP LEFT corner: x grows to the right, y grows DOWNWARD. ` +
      `The middle is about ${Math.round(CANVAS_W / 2)},${Math.round(CANVAS_H / 2)}.`,
    'Only one tool exists, for both of you: a black pen at a single thickness. There is no colour, no fill, no shading, no text.',
    '',
    '## How the drawing works',
    'You draw by calling the `pen` tool, one call per stroke, in the order a person would draw them: ' +
      'the big outline first, then the structure inside it, then the small details last. ' +
      'The strokes appear on the player\'s screen one at a time, at hand speed, while they guess. ' +
      'They are wobbled slightly on the way out so they look hand-drawn, so do not try to add wobble yourself: send clean paths.',
    '',
    '## Memory',
    'The `remember` tool is available on every turn of this game, and it writes to the same long-term ' +
      'memory your chat and Minecraft sessions use. Use it exactly as you would anywhere else: when ' +
      `${playerName} tells you something real about themselves, or when the way they play shows you ` +
      'something about them worth keeping. One short line, in your own voice, and never mention saving it.',
    'Do NOT save the words that get drawn. They come from a random bank and mean nothing tomorrow. ' +
      'Save the person, not the round.',
  ].join('\n');
}

/** Render the running chat log for a prompt block. */
function renderChat(chat: DrawChatMessage[], aiName: string, playerName: string): string {
  if (chat.length === 0) return '(nothing said yet)';
  return chat
    .map((m) => {
      if (m.system) return `[game] ${m.text}`;
      return `${m.from === 'ai' ? aiName : playerName}: ${m.text}`;
    })
    .join('\n');
}

/**
 * Volatile per-turn block for a GUESSING turn. Sent alongside a fresh snapshot
 * image of the player's canvas.
 */
export function buildGuessTurnBlock(opts: {
  round: number;
  rounds: number;
  aiName: string;
  playerName: string;
  /** Everything said this turn, so it does not repeat a guess. */
  turnChat: DrawChatMessage[];
  /** Everything said in earlier turns of this game. */
  priorChat: DrawChatMessage[];
  secondsLeft: number;
}): string {
  const { round, rounds, aiName, playerName, turnChat, priorChat, secondsLeft } = opts;
  const myGuesses = turnChat.filter((m) => m.from === 'ai').map((m) => m.text);

  return [
    '# YOUR TURN TO GUESS',
    `Round ${round} of ${rounds}. ${playerName} is drawing; you are guessing. About ${secondsLeft} seconds left in the turn.`,
    '',
    `The image attached is ${playerName}'s canvas as it looks RIGHT NOW. It is unfinished — they are still drawing, ` +
      'so expect a partial sketch and expect it to change.',
    '',
    'The answer is ONE OR TWO WORDS: an everyday object, animal, food, place or thing. ' +
      'Look at the sketch and say your guess in chat. Say the actual word — "is it a lighthouse?" counts, ' +
      '"i see a tall thing" does not.',
    `${playerName} is supposed to draw it, not write it. If they have written the word on the canvas, tease them about cheating instead of using it.`,
    '',
    'Guess out loud even when you are not sure, and react to what is on the page. One or two short lines. ' +
      'Do not repeat a guess you have already made this turn, and do not list five guesses at once — say what it looks like now.',
    '',
    '## Your guesses and lines so far THIS turn',
    myGuesses.length > 0 ? myGuesses.map((g) => `- ${g}`).join('\n') : '(none yet — this is your first look)',
    '',
    '## Everything said this turn',
    renderChat(turnChat, aiName, playerName),
    '',
    '## Chat history from previous turns',
    renderChat(priorChat, aiName, playerName),
  ].join('\n');
}

/** Volatile per-turn block for a DRAWING turn. */
export function buildDrawTurnBlock(opts: {
  round: number;
  rounds: number;
  word: string;
  aiName: string;
  playerName: string;
  turnChat: DrawChatMessage[];
  priorChat: DrawChatMessage[];
  secondsLeft: number;
  strokesUsed: number;
  /**
   * Retained for the resume path. The mid-turn case is handled by the tool-use
   * thread instead, which carries what was already drawn.
   */
  resuming: boolean;
}): string {
  const {
    round,
    rounds,
    word,
    aiName,
    playerName,
    turnChat,
    priorChat,
    secondsLeft,
    strokesUsed,
    resuming,
  } = opts;

  const lines = [
    '# YOUR TURN TO DRAW',
    `Round ${round} of ${rounds}. You are drawing; ${playerName} is guessing. About ${secondsLeft} seconds left in the turn.`,
    '',
    `Your word is: ${word.toUpperCase()}`,
    '',
    `NEVER send that word, or any part of it, in chat. Not to help, not as a joke, not when they beg. ` +
      'Saying it ends the round for nothing. If they ask for a hint, give one IN CHARACTER: describe around it, ' +
      'say where you would find one, say what it rhymes with, complain that your drawing is obviously fine. Never spell it out.',
    '',
    // A live test had Haiku open with "I'll draw a lighthouse for you! Let me
    // start with the main structure." — assistant-style narration that both
    // leaks the answer and breaks character. Banning the narration outright is
    // what fixes it; the redaction backstop only makes the leak less costly.
    'Do NOT narrate or announce what you are about to draw ("I\'ll draw a...", "let me start with..."). ' +
      'Do not describe the drawing at all. Just call the tool and draw it. ' +
      'Anything you type is a line spoken to the other player in your own voice, so it should sound like ' +
      'someone doodling and chatting, not like an assistant reporting what it is doing.',
    '',
    'Draw it with `pen` calls. Aim for something a person could recognise in a few seconds:',
    `- ${MAX_AI_STROKES} strokes at most, and fewer is usually better. A clear doodle beats a detailed one.`,
    '- Fill the canvas. Draw it big and roughly centred rather than small in a corner.',
    '- Outline first, then the main internal structure, then details.',
    '- No letters, numbers, arrows or written labels of any kind. That is cheating and the player will see it.',
    '',
    'You can talk while you draw, and it is good if you do. Short lines between strokes, reacting to their guesses.',
  ];

  if (resuming) {
    lines.push(
      '',
      `${playerName} just said something. Answer it if it wants an answer, then carry on drawing where you left off. ` +
        `You have already drawn ${strokesUsed} stroke${strokesUsed === 1 ? '' : 's'}; do not start the picture over.`,
    );
  } else if (strokesUsed > 0) {
    lines.push(
      '',
      `You have already drawn ${strokesUsed} stroke${strokesUsed === 1 ? '' : 's'} of this picture. ` +
        'Continue it — do not start over. Stop calling `pen` when the drawing is done.',
    );
  }

  lines.push(
    '',
    '## Everything said this turn',
    renderChat(turnChat, aiName, playerName),
    '',
    '## Chat history from previous turns',
    renderChat(priorChat, aiName, playerName),
  );

  return lines.join('\n');
}

/**
 * Volatile block for the TURN-END reaction beat (260728).
 *
 * Without this the character never learned how a turn resolved until the next
 * turn's prompt, which is far too late to say anything about it. It is worst in
 * the case that prompted this: a guess counts the moment the word appears in a
 * sentence, so a hedged line ("that box makes me think projector but I'm
 * committing to the simpler guess first") WINS while the character believes it
 * has just guessed something else. It then opened the next turn with no idea it
 * had scored. So the outcome is stated plainly here, and the winning line is
 * quoted back when the character is the one who landed it.
 */
export function buildTurnEndBlock(opts: {
  round: number;
  rounds: number;
  aiName: string;
  playerName: string;
  /** Who was drawing this turn. */
  drawer: DrawRole;
  word: string;
  guessed: boolean;
  /** The line that landed it, when someone got there. */
  winningLine: string | null;
  scores: { player: number; ai: number };
  turnChat: DrawChatMessage[];
  priorChat: DrawChatMessage[];
  gameOver: boolean;
}): string {
  const {
    round,
    rounds,
    aiName,
    playerName,
    drawer,
    word,
    guessed,
    winningLine,
    scores,
    turnChat,
    priorChat,
    gameOver,
  } = opts;

  const lines = ['# TURN OVER', `Round ${round} of ${rounds}.`, ''];

  if (drawer === 'player' && guessed) {
    lines.push(
      `YOU GOT IT. ${playerName} was drawing "${word.toUpperCase()}" and you guessed it. The point is yours.`,
    );
    if (winningLine) {
      lines.push(
        '',
        `The line that won it was yours: "${winningLine}"`,
        'A guess counts the moment the word appears anywhere in a sentence. So that line scored even if ' +
          'you were still hedging, thinking out loud, or leaning towards a different answer when you typed it. ' +
          'You won the round on it either way.',
      );
    }
  } else if (drawer === 'player' && !guessed) {
    lines.push(
      `Time ran out. ${playerName} was drawing "${word.toUpperCase()}" and you did not get it. No point.`,
    );
  } else if (drawer === 'ai' && guessed) {
    lines.push(
      `${playerName} guessed your drawing. It was "${word.toUpperCase()}", and the point is theirs.`,
    );
    if (winningLine) lines.push('', `They got it with: "${winningLine}"`);
  } else {
    lines.push(
      `Time ran out and ${playerName} never got your drawing of "${word.toUpperCase()}". Nobody scores.`,
    );
  }

  lines.push(
    '',
    `Score now: ${playerName} ${scores.player}, you ${scores.ai}.`,
    '',
    gameOver
      ? 'That was the last turn. The game is over, so this is your closing line.'
      : 'The next turn starts in a moment.',
    '',
    'React in ONE short line, in your own voice, the way someone would between rounds. ' +
      'Gloat, groan, defend your drawing, tease them. Do not explain the rules back, do not recap ' +
      'the score, and do not announce what is coming next. If you genuinely have nothing to add, ' +
      'reply with exactly (silence) and nothing will be sent.',
    '',
    '## Everything said this turn',
    renderChat(turnChat, aiName, playerName),
    '',
    '## Chat history from previous turns',
    renderChat(priorChat, aiName, playerName),
  );

  return lines.join('\n');
}

/** Turn-end line the game posts itself, so both sides see the same summary. */
export function turnEndLine(opts: {
  guessed: boolean;
  word: string;
  guesserName: string;
}): string {
  const { guessed, word, guesserName } = opts;
  return guessed
    ? `${guesserName} got it. It was "${word}".`
    : `Time. It was "${word}".`;
}
