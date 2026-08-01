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
import {
  CANVAS_H,
  CANVAS_W,
  TURN_MS,
  type DrawChatMessage,
  type DrawGalleryEntry,
  type DrawRole,
} from '../../shared/drawIpc';

/** Strokes the character may spend on one picture before we cut it off. */
export const MAX_AI_STROKES = 16;
/**
 * Tool-use hops per drawing turn, so a stuck model cannot spin. A hop yields
 * roughly two to four strokes, so this has to be generous enough for a whole
 * picture plus a couple of replies.
 */
export const MAX_DRAW_HOPS = 10;

/**
 * The clock, stated as elapsed AND remaining (260729, from the web version).
 * "About 170 seconds left" reads as "no hurry" at the start of a turn; pairing
 * it with how much has passed keeps the number meaning something.
 */
export function turnClockLine(secondsLeft: number): string {
  const turnSeconds = Math.round(TURN_MS / 1000);
  const elapsed = Math.max(0, Math.min(turnSeconds, turnSeconds - secondsLeft));
  return `About ${elapsed} seconds of the turn's ${turnSeconds} have passed; about ${secondsLeft} seconds left.`;
}

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
 * Wipe the page and start again (260728).
 *
 * Added alongside the self-look below, and only useful because of it: without
 * eyes the character has no way to know the picture is not working, and with
 * eyes and no eraser the only thing it can do about it is pile more strokes on
 * top. The player's own stroke eraser is per-stroke; this is deliberately all
 * or nothing, because a model that cannot see cannot pick a stroke to remove.
 */
export const CLEAR_TOOL: Anthropic.Tool = {
  name: 'clear',
  description:
    'Wipe the canvas completely and start the drawing again from nothing. Everything you have drawn this turn disappears from the player\'s screen. Use it when the picture is not working and you want a different approach, not to tidy up. ' +
    'Redrawing the object ALWAYS starts with clear: never draw a second version of it on top of or beside the old one, that only stacks two unreadable pictures. ' +
    'A clear is a promise to redraw: the player is left staring at a blank page, so you MUST draw the new version immediately, in this same turn, starting with your very next pen calls.',
  input_schema: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description: 'Why, in a few words. Never shown to the player.',
      },
    },
    required: ['reason'],
  },
};

/**
 * What the character is told when it is shown its OWN canvas mid-turn.
 *
 * The drawing turn used to be blind: the guesser got a real snapshot every
 * few seconds, the drawer got the sentence "3/16 strokes used". So it could not
 * tell that its picture was two overlapping blobs in the top-left tenth of the
 * page, and it stopped after three strokes because it believed it was done.
 */
export function selfLookNote(word: string, playerName: string): string {
  return (
    `The image attached is YOUR canvas, exactly as ${playerName} is seeing it right now. ` +
    `This is what you have drawn so far for the word "${word}". ` +
    'If they are not guessing it, consider adding detail, or clearing the page and drawing something else. ' +
    'Never draw a second copy of the object over or next to the first: a redraw starts with clear. ' +
    'Judge it as a stranger would: is it big enough, is it in the middle of the page, would anyone name it in a few seconds?'
  );
}

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
    // 260729, live capture (web): the character told the player a wrong guess
    // was correct ("yes! that's it!") and then invented a round change,
    // because nothing told it the engine adjudicates. This paragraph is that
    // fact.
    'THE GAME ITSELF IS THE REFEREE. It checks every chat line against the secret word the instant it is sent, ' +
      'ends the turn by itself when the word is said, keeps the score, and posts lines marked [game] to announce ' +
      'all of it. You never do any of that: never declare a guess correct, never award or claim a point, never ' +
      'announce that a turn or round has started or ended, and never write a line that begins with [game], that ' +
      'prefix belongs to the game and the game drops any line of yours that fakes it. ' +
      'While a turn is still running, no guess so far has been right, or the turn would already be over.',
    'Every plain-text line you write is sent to the game chat, exactly as written, and the other player sees it. ' +
      'Keep lines short, one or two at a time, the way someone actually talks while doodling.',
    // Both of these are stated here as well as in the surface baseline because
    // this is the block that sits closest to the turn, and both failed live
    // (260728): the character called the player by name in the third person,
    // and emphasised its own guesses ("is it a **hearing aid**?").
    `You are talking TO ${playerName}, so say "you". Never write their name as the subject of a sentence, ` +
      'and never talk about them in the third person: no "they", no "them". ' +
      'The rules name them only so they can say who is doing what.',
    // 260728, live capture: mid-drawing lines like "they're getting close to
    // something here" landed in chat. There is no scratchpad on this surface,
    // and the model has to be told so or it invents one.
    `You have NO private channel in this game. There is no way to think out loud, mutter to yourself, or ` +
      `take notes without ${playerName} reading every word the moment you type it. ` +
      'If a line is not something you would say to their face, do not write it.',
    'Write plain lines with no formatting at all: no asterisks, no bold, no italics, no backticks, no lists. ' +
      'Every character you type appears literally in a handwritten chat bubble, so a pair of asterisks is just two asterisks.',
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

/**
 * Render the running chat log for a prompt block.
 *
 * System lines are rendered from `modelText` when the message carries one.
 * That field exists precisely for this call site: the player-facing wording of
 * a system line is written in the second person and sometimes names the word
 * currently being drawn, and replaying it verbatim both handed the guesser the
 * answer and made the character think it was the one drawing. See the
 * DrawChatMessage docs in src/shared/drawIpc.ts.
 */
function renderChat(chat: DrawChatMessage[], aiName: string, playerName: string): string {
  if (chat.length === 0) return '(nothing said yet)';
  return chat
    .map((m) => {
      if (m.system) return `[game] ${m.modelText ?? m.text}`;
      return `${m.from === 'ai' ? aiName : playerName}: ${m.text}`;
    })
    .join('\n');
}

/**
 * Who drew what, and who got it, for every turn already played (260728).
 *
 * The chat log alone was not enough to keep this straight: the character
 * claimed a word IT had drawn had been drawn by the player. Chat is a stream of
 * guesses with the attribution only ever implied, so this states the record
 * outright. Cheap (one line per turn) and it is the fact the character is most
 * likely to get wrong.
 */
export function roundsRecap(opts: {
  gallery: DrawGalleryEntry[];
  playerName: string;
}): string {
  const { gallery, playerName } = opts;
  if (gallery.length === 0) return '(this is the first turn of the game)';
  return gallery
    .map((g) => {
      const who = g.drawer === 'ai' ? 'YOU drew' : `${playerName} drew`;
      const got =
        g.drawer === 'ai'
          ? g.guessed
            ? `${playerName} got it.`
            : `${playerName} never got it.`
          : g.guessed
            ? 'You got it.'
            : 'You never got it.';
      return `- Round ${g.round}: ${who} "${g.word}". ${got}`;
    })
    .join('\n');
}

/**
 * The reference half of every turn block: what has been played, and what has
 * been said, oldest first.
 *
 * It goes ABOVE the instructions, and that ordering is the fix for a real bug
 * (260728). These sections used to be appended to the END of each block, and
 * they are the largest thing in it, so the last text the model read before
 * answering was chat from the PREVIOUS turn. Live capture: the character
 * guessed the player's drawing correctly, and its turn-end line was "hehe ok
 * you're reading these too fast, that's not fair" — the drawer's frame,
 * continued straight out of the previous turn's banter, which was sitting at
 * the bottom of the prompt. The turn block said YOU GOT IT two thousand tokens
 * earlier. Recency won.
 *
 * So: reference material first, instructions last, and every block closes on a
 * one-line statement of the role. Also note the two chat sections are now in
 * chronological order (previous turns, then this turn); they used to be the
 * other way around, which put the oldest lines last.
 */
function contextSections(opts: {
  gallery: DrawGalleryEntry[];
  playerName: string;
  aiName: string;
  turnChat: DrawChatMessage[];
  priorChat: DrawChatMessage[];
}): string[] {
  const { gallery, playerName, aiName, turnChat, priorChat } = opts;
  return [
    '## Turns already played',
    roundsRecap({ gallery, playerName }),
    '',
    '## Chat from earlier turns',
    renderChat(priorChat, aiName, playerName),
    '',
    '## Everything said this turn',
    renderChat(turnChat, aiName, playerName),
    '',
  ];
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
  /** Player lines since the last look that have not been answered yet. */
  said: string[];
  /** The canvas is byte-identical to the last one looked at. */
  unchanged: boolean;
  /** Strokes on the canvas; 0 means the page is still blank. */
  strokeCount: number;
  /** Turns already played, for the attribution recap. */
  gallery: DrawGalleryEntry[];
}): string {
  const {
    round,
    rounds,
    aiName,
    playerName,
    turnChat,
    priorChat,
    secondsLeft,
    said,
    unchanged,
    strokeCount,
    gallery,
  } = opts;
  const myGuesses = turnChat.filter((m) => m.from === 'ai').map((m) => m.text);

  const head = [
    ...contextSections({ gallery, playerName, aiName, turnChat, priorChat }),
    '# YOUR TURN TO GUESS',
    `Round ${round} of ${rounds}. ${playerName} is drawing; you are guessing. ${turnClockLine(secondsLeft)}`,
    'You have NO word this turn and you are NOT drawing. You cannot see the answer: work it out from the picture.',
    '',
  ];

  if (said.length > 0) {
    head.push(
      `${playerName} just said: ${said.map((t) => `"${t}"`).join(' ')}`,
      'Answer them first, in your own voice. Then guess if you have one.',
      '',
    );
  }

  if (strokeCount === 0) {
    head.push(
      'Their canvas is still BLANK. There is nothing to guess at yet, so do not guess: ' +
        'say something about the fact that they have not started.',
      '',
    );
  } else if (unchanged) {
    head.push(
      'The canvas has NOT changed since your last look, so they have paused rather than drawn. ' +
        'Do not repeat your last guess back at them. Say something new: pick a different reading of ' +
        'the same shapes, push them to add something, or just talk to them.',
      '',
    );
  }

  return [
    ...head,
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
    `Right now: you are GUESSING. ${playerName} drew that picture, you have never seen the word, ` +
      'and your job is to name it. Say it straight to them: "you", never their name or "they", and no formatting.',
  ].join('\n');
}

/**
 * Second (or third) attempt at the same word, after a wipe (260729). The
 * drawing thread is RESET after any clear that was not followed by a redraw in
 * the same response, and the fresh opening block carries this instead of a
 * corrective note buried in a long thread. `priorIntents` are the model's own
 * stroke descriptions from the wiped attempt, so "draw it differently" has
 * something concrete to differ from.
 */
export interface DrawRestart {
  /** True when the GAME wiped the canvas (too many wrong guesses), false when the model called `clear` itself. */
  auto: boolean;
  /** Wrong guesses that triggered an auto wipe. */
  wrongGuesses?: number;
  priorIntents: string[];
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
  /** Turns already played, for the attribution recap. */
  gallery: DrawGalleryEntry[];
  restart?: DrawRestart;
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
    gallery,
    restart,
  } = opts;

  const lines = [
    ...contextSections({ gallery, playerName, aiName, turnChat, priorChat }),
    '# YOUR TURN TO DRAW',
    `Round ${round} of ${rounds}. You are drawing; ${playerName} is guessing. ${turnClockLine(secondsLeft)}`,
    "You just happen to be the world's smartest and greatest AI artist.",
    'Do NOT guess this turn and do not ask what it is. You already know: you are the one drawing it.',
    '',
    `Your word is: ${word.toUpperCase()}`,
    '',
    `NEVER send that word, or any part of it, in chat. Not to help, not as a joke, not when they beg. ` +
      'The game DELETES any line of yours that contains it, so saying it costs you the line and tells them nothing. ' +
      'If they ask for a hint, give one IN CHARACTER: describe around it, ' +
      'say where you would find one, say what it rhymes with, complain that your drawing is obviously fine. Never spell it out.',
    '',
    `The game checks ${playerName}'s guesses, not you: a right guess ends the turn on the spot, with a [game] line. ` +
      'So while this turn is running, every guess so far is WRONG, even one that feels close enough to count. ' +
      'Never tell them a guess is right. Warmer, colder, teasing: yours. The win itself: the game announces it.',
    '',
    ...(restart
      ? [
          '## STARTING OVER',
          restart.auto
            ? `You already drew this word once this turn and it did not land: ${playerName} guessed wrong ` +
              `${restart.wrongGuesses ?? 'several'} times, so the game wiped the canvas for you.`
            : 'You wiped your own canvas: your first attempt at this word was not working.',
          ...(restart.priorIntents.length > 0
            ? [
                `The wiped attempt was, stroke by stroke: ${restart.priorIntents.join(', ')}. ` +
                  'Do NOT redraw that same picture.',
              ]
            : []),
          `The page is BLANK right now and ${playerName} is watching it. Start drawing again with pen calls ` +
            'IMMEDIATELY, and draw it DIFFERENTLY this time: a new angle, bigger, simpler, or leading with the ' +
            'one detail that gives it away. You may say one short line about starting over, but the pen calls come first.',
          '',
        ]
      : []),
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
    // 260728: this used to read "16 at most, and fewer is usually better",
    // which is a ceiling and a nudge downward, and the character took it — a
    // live turn ended after three strokes with two minutes left, having drawn
    // two overlapping blobs. It cannot see the page, so it cannot tell that is
    // not enough. A floor is the useful number here.
    `- At least 6 strokes, up to ${MAX_AI_STROKES}. Do not stop before the picture has its outline AND its main internal structure.`,
    '- Fill the canvas. Draw it big and roughly centred rather than small in a corner.',
    '- Outline first, then the main internal structure, then details.',
    '- No letters, numbers, arrows or written labels of any kind. That is cheating and the player will see it.',
    `- You can wipe the page with \`clear\` and start the drawing again. Use it when what you have is not working, not to tidy up. ` +
      'If you clear, draw the new picture straight away, in this same turn: never leave the page blank.',
    '- ADD to the picture or REPLACE the picture, never both: a redraw starts with `clear`. ' +
      'Drawing a second version of the object on top of or beside the first stacks two unreadable pictures on one page.',
    '',
    'You can talk while you draw, and it is good if you do. Short lines between strokes, reacting to their guesses.',
  ];

  if (strokesUsed > 0) {
    lines.push(
      '',
      `You have already drawn ${strokesUsed} stroke${strokesUsed === 1 ? '' : 's'} of this picture. ` +
        'Continue it — do not start over. Stop calling `pen` when the drawing is done.',
    );
  }

  lines.push(
    '',
    `Right now: you are DRAWING ${word.toUpperCase()} and ${playerName} is guessing it. ` +
      'Call `pen`. Do not guess, and do not ask what it is. ' +
      'Anything you say is said straight to them: "you", never their name or "they", and no formatting.',
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
  /** Turns already played, THIS one included, for the attribution recap. */
  gallery: DrawGalleryEntry[];
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
    gallery,
  } = opts;

  const lines = [
    ...contextSections({ gallery, playerName, aiName, turnChat, priorChat }),
    '# TURN OVER',
    `Round ${round} of ${rounds}.`,
    '',
  ];

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
    // The line that closes the block, because it is the fact the character got
    // wrong when the chat log closed it instead.
    drawer === 'ai'
      ? `Right now: the turn just ended. YOU were the one drawing, ${playerName} was guessing.`
      : `Right now: the turn just ended. ${playerName} was the one drawing, YOU were guessing.`,
  );

  return lines.join('\n');
}

/**
 * Turn-end line the game posts itself, so both sides see the same summary.
 *
 * Two wordings: the player reads the guesser by name, the character reads
 * itself as "you". Naming the character in the third person inside its own
 * prompt is exactly the kind of line it then misattributes later.
 */
export function turnEndLine(opts: {
  guessed: boolean;
  word: string;
  /** Who was doing the guessing this turn. */
  guesser: DrawRole;
  aiName: string;
  playerName: string;
  /** 260730: player-facing wording follows the game language; modelText stays English. */
  language?: 'en' | 'zh' | null;
}): { text: string; modelText: string } {
  const { guessed, word, guesser, aiName, playerName } = opts;
  const zh = opts.language === 'zh';
  if (!guessed) {
    const line = `Time. It was "${word}".`;
    return { text: zh ? `时间到。答案是「${word}」。` : line, modelText: line };
  }
  return {
    text: zh
      ? `${guesser === 'ai' ? aiName : playerName}猜对了。答案是「${word}」。`
      : `${guesser === 'ai' ? aiName : playerName} got it. It was "${word}".`,
    modelText: `${guesser === 'ai' ? 'You' : playerName} got it. It was "${word}".`,
  };
}
