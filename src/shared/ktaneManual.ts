/**
 * KTANE expert manual (261115): the compact, model-facing rules the companion
 * reads when it plays the EXPERT in Keep Talking and Nobody Explodes.
 *
 * Source. The rules are those of the free "Bomb Defusal Manual" (Version 1,
 * verification code 241) that Steel Crate Games publishes at
 * https://www.bombmanual.com. This file does not copy the manual: no flavour
 * text, no layout, no images, no logos. It restates the game's rules in our
 * own compact words and data shapes (mazes as exit lists, keypad symbols as
 * names plus the words players use for them), for the model only. The player
 * never sees this text in the app; the panel credits and links the official
 * manual instead.
 *
 * Genuine skill. Nothing here solves a module. The companion reads these rules
 * and applies them to what the player describes, the way a human expert reads
 * the paper manual (minigames rule, 261026). The answer-key solver used by the
 * eval lives in scripts/ktane/solver.ts and is never imported by the app.
 *
 * Size. About 6k tokens, rendered once and cached in the system prompt
 * (extraStable), so a long bomb re-reads it from the prompt cache.
 */

/** Wire module columns are read top to bottom. */
export const WIRE_RULES = `## Wires (3 to 6 plain wires, cut exactly one)
Count wires top to bottom; the first wire is the top one. Apply the FIRST rule that matches.
3 wires:
 1. No red wires: cut the 2nd wire.
 2. Last wire is white: cut the last wire.
 3. More than one blue wire: cut the last blue wire.
 4. Otherwise cut the last wire.
4 wires:
 1. More than one red wire AND serial last digit odd: cut the last red wire.
 2. Last wire is yellow AND no red wires: cut the 1st wire.
 3. Exactly one blue wire: cut the 1st wire.
 4. More than one yellow wire: cut the last wire.
 5. Otherwise cut the 2nd wire.
5 wires:
 1. Last wire is black AND serial last digit odd: cut the 4th wire.
 2. Exactly one red wire AND more than one yellow wire: cut the 1st wire.
 3. No black wires: cut the 2nd wire.
 4. Otherwise cut the 1st wire.
6 wires:
 1. No yellow wires AND serial last digit odd: cut the 3rd wire.
 2. Exactly one yellow wire AND more than one white wire: cut the 4th wire.
 3. No red wires: cut the last wire.
 4. Otherwise cut the 4th wire.`;

export const BUTTON_RULES = `## The Button (one big button with a color and a word)
Apply the FIRST rule that matches. "Tap" = press and release immediately.
 1. Blue button that says "Abort": HOLD.
 2. More than 1 battery AND the button says "Detonate": TAP.
 3. White button AND a LIT indicator CAR: HOLD.
 4. More than 2 batteries AND a LIT indicator FRK: TAP.
 5. Yellow button: HOLD.
 6. Red button that says "Hold": TAP.
 7. Otherwise: HOLD.
When holding, a colored strip lights on the right side. Release when the countdown timer shows this digit in ANY position:
 blue strip: 4. white strip: 1. yellow strip: 5. any other color: 1.`;

/**
 * Keypad symbols: id, a short name, and the words players use for it. Order
 * of the six columns is the manual's; each column lists symbol ids top to
 * bottom.
 */
export const KEYPAD_SYMBOLS: Record<string, { name: string; looks: string }> = {
  balloon: { name: 'balloon (Ϙ)', looks: 'balloon, lollipop, tennis racket, Q with a line down, circle on a stick' },
  at: { name: 'AT (Ѧ)', looks: 'A with a tail, AT, tent, triangle with legs, A with a loop' },
  lambda: { name: 'lambda (ƛ)', looks: 'upside down y, lambda with a bar through it, h with a slash' },
  lightning: { name: 'lightning (Ϟ)', looks: 'squiggly N, lightning bolt, zigzag, N with curls, backwards s' },
  squid: { name: 'squid (Ѭ)', looks: 'squid, spider, jellyfish, alien, kitty, knife, robot with legs' },
  hookn: { name: 'hook H (ϗ)', looks: 'H with a hook or curl, curly H, cursive N with a tail, hk' },
  leftc: { name: 'backwards C with dot (Ͽ)', looks: 'backwards C with a dot inside, reversed C dot, left C' },
  euro: { name: 'E with dots (Ӭ)', looks: 'backwards E with two dots on top, euro sign, E umlaut' },
  cursive: { name: 'curly Q (Ҩ)', looks: 'cursive q, swirl, curly 9, ribbon, loop with a tail, ampersand-like' },
  hollowstar: { name: 'hollow star (☆)', looks: 'white star, outline star, empty star' },
  questionmark: { name: 'upside down question mark (¿)', looks: 'upside down question mark, flipped question mark' },
  copyright: { name: 'copyright (©)', looks: 'copyright sign, C in a circle' },
  pumpkin: { name: 'pumpkin (Ѽ)', looks: 'pumpkin, butt, W with a dot or ticks, omega with ticks, bowling pins' },
  doublek: { name: 'double K (Җ)', looks: 'double K, K mirrored, Ж with a tail, bug, butterfly, >|< ' },
  meltedthree: { name: 'melted 3 (Ԇ)', looks: 'melted 3, 3 with a tail, backwards R, 3 with a hook at the bottom' },
  six: { name: 'six (б)', looks: 'six, 6, b with a hat, delta' },
  paragraph: { name: 'paragraph (¶)', looks: 'paragraph mark, pilcrow, backwards P, P with two lines' },
  bt: { name: 'bT (Ѣ)', looks: 'b with a T, bT, T and b joined, b with a cross on top' },
  smiley: { name: 'smiley face (ټ)', looks: 'smiley face, face with a tongue, dotted smile, bowl with dots' },
  pitchfork: { name: 'pitchfork (Ψ)', looks: 'pitchfork, trident, psi, candelabra, fork' },
  rightc: { name: 'C with dot (Ͼ)', looks: 'C with a dot inside, normal C dot, right C' },
  dragon: { name: 'dragon (Ѯ)', looks: 'dragon, snake, 3 with a squiggle on top, xi, worm, cursive E with a tail' },
  filledstar: { name: 'filled star (★)', looks: 'black star, solid star, filled star' },
  tracks: { name: 'tracks (҂)', looks: 'railroad tracks, crossed lines, hashtag-like, plus with ticks' },
  ae: { name: 'AE (æ)', looks: 'ae, AE joined letters, a and e stuck together' },
  nhat: { name: 'N with hat (Ҋ)', looks: 'backwards N with a hat or tail, И with a squiggle on top' },
  omega: { name: 'omega (Ω)', looks: 'omega, horseshoe, headphones, upside down U with feet' },
};

export const KEYPAD_COLUMNS: readonly (readonly string[])[] = [
  ['balloon', 'at', 'lambda', 'lightning', 'squid', 'hookn', 'leftc'],
  ['euro', 'balloon', 'leftc', 'cursive', 'hollowstar', 'hookn', 'questionmark'],
  ['copyright', 'pumpkin', 'cursive', 'doublek', 'meltedthree', 'lambda', 'hollowstar'],
  ['six', 'paragraph', 'bt', 'squid', 'doublek', 'questionmark', 'smiley'],
  ['pitchfork', 'smiley', 'bt', 'rightc', 'paragraph', 'dragon', 'filledstar'],
  ['six', 'euro', 'tracks', 'ae', 'pitchfork', 'nhat', 'omega'],
];

function renderKeypad(): string {
  const names = Object.entries(KEYPAD_SYMBOLS)
    .map(([, s]) => `${s.name}: ${s.looks}`)
    .join('\n');
  const cols = KEYPAD_COLUMNS.map(
    (c, i) => `Column ${i + 1}: ${c.map((id) => KEYPAD_SYMBOLS[id].name).join(', ')}`,
  ).join('\n');
  return (
    `## Keypads (four buttons, each with a symbol)\n` +
    `Exactly one column below holds all four of the keypad's symbols. Press the four buttons in the order their symbols appear in that column, top to bottom. ` +
    `Players describe symbols in their own words; match them with the descriptions, and ask when two could fit.\n` +
    `Symbols and what people call them:\n${names}\n` +
    `Columns (top to bottom):\n${cols}`
  );
}

export const SIMON_RULES = `## Simon Says (four colored buttons: red, blue, green, yellow)
One button flashes, then the sequence grows by one each time it is entered right. For EACH flashed color, press the mapped color below, in the same order. The mapping depends on whether the serial number contains a vowel (A, E, I, O, U) and on the CURRENT strike count, so remap the whole sequence after a strike.
Serial HAS a vowel:
 0 strikes: red->blue, blue->red, green->yellow, yellow->green
 1 strike: red->yellow, blue->green, green->blue, yellow->red
 2 strikes: red->green, blue->red, green->yellow, yellow->blue
Serial has NO vowel:
 0 strikes: red->blue, blue->yellow, green->green, yellow->red
 1 strike: red->red, blue->blue, green->yellow, yellow->green
 2 strikes: red->yellow, blue->green, green->blue, yellow->red`;

/** Who's on First step 1: display word -> which button's label to read. */
export const WOF_STEP1: Record<string, string> = {
  YES: 'middle left', FIRST: 'top right', DISPLAY: 'bottom right', OKAY: 'top right', SAYS: 'bottom right',
  NOTHING: 'middle left', '(empty display)': 'bottom left', BLANK: 'middle right', NO: 'bottom right',
  LED: 'middle left', LEAD: 'bottom right', READ: 'middle right', RED: 'middle right', REED: 'bottom left',
  LEED: 'bottom left', 'HOLD ON': 'bottom right', YOU: 'middle right', 'YOU ARE': 'bottom right',
  YOUR: 'middle right', "YOU'RE": 'middle right', UR: 'top left', THERE: 'bottom right', "THEY'RE": 'bottom left',
  THEIR: 'middle right', 'THEY ARE': 'middle left', SEE: 'bottom right', C: 'top right', CEE: 'bottom right',
};

/** Who's on First step 2: button label -> priority list (press the first one present). */
export const WOF_STEP2: Record<string, readonly string[]> = {
  READY: ['YES', 'OKAY', 'WHAT', 'MIDDLE', 'LEFT', 'PRESS', 'RIGHT', 'BLANK', 'READY', 'NO', 'FIRST', 'UHHH', 'NOTHING', 'WAIT'],
  FIRST: ['LEFT', 'OKAY', 'YES', 'MIDDLE', 'NO', 'RIGHT', 'NOTHING', 'UHHH', 'WAIT', 'READY', 'BLANK', 'WHAT', 'PRESS', 'FIRST'],
  NO: ['BLANK', 'UHHH', 'WAIT', 'FIRST', 'WHAT', 'READY', 'RIGHT', 'YES', 'NOTHING', 'LEFT', 'PRESS', 'OKAY', 'NO', 'MIDDLE'],
  BLANK: ['WAIT', 'RIGHT', 'OKAY', 'MIDDLE', 'BLANK', 'PRESS', 'READY', 'NOTHING', 'NO', 'WHAT', 'LEFT', 'UHHH', 'YES', 'FIRST'],
  NOTHING: ['UHHH', 'RIGHT', 'OKAY', 'MIDDLE', 'YES', 'BLANK', 'NO', 'PRESS', 'LEFT', 'WHAT', 'WAIT', 'FIRST', 'NOTHING', 'READY'],
  YES: ['OKAY', 'RIGHT', 'UHHH', 'MIDDLE', 'FIRST', 'WHAT', 'PRESS', 'READY', 'NOTHING', 'YES', 'LEFT', 'BLANK', 'NO', 'WAIT'],
  WHAT: ['UHHH', 'WHAT', 'LEFT', 'NOTHING', 'READY', 'BLANK', 'MIDDLE', 'NO', 'OKAY', 'FIRST', 'WAIT', 'YES', 'PRESS', 'RIGHT'],
  UHHH: ['READY', 'NOTHING', 'LEFT', 'WHAT', 'OKAY', 'YES', 'RIGHT', 'NO', 'PRESS', 'BLANK', 'UHHH', 'MIDDLE', 'WAIT', 'FIRST'],
  LEFT: ['RIGHT', 'LEFT', 'FIRST', 'NO', 'MIDDLE', 'YES', 'BLANK', 'WHAT', 'UHHH', 'WAIT', 'PRESS', 'READY', 'OKAY', 'NOTHING'],
  RIGHT: ['YES', 'NOTHING', 'READY', 'PRESS', 'NO', 'WAIT', 'WHAT', 'RIGHT', 'MIDDLE', 'LEFT', 'UHHH', 'BLANK', 'OKAY', 'FIRST'],
  MIDDLE: ['BLANK', 'READY', 'OKAY', 'WHAT', 'NOTHING', 'PRESS', 'NO', 'WAIT', 'LEFT', 'MIDDLE', 'RIGHT', 'FIRST', 'UHHH', 'YES'],
  OKAY: ['MIDDLE', 'NO', 'FIRST', 'YES', 'UHHH', 'NOTHING', 'WAIT', 'OKAY', 'LEFT', 'READY', 'BLANK', 'PRESS', 'WHAT', 'RIGHT'],
  WAIT: ['UHHH', 'NO', 'BLANK', 'OKAY', 'YES', 'LEFT', 'FIRST', 'PRESS', 'WHAT', 'WAIT', 'NOTHING', 'READY', 'RIGHT', 'MIDDLE'],
  PRESS: ['RIGHT', 'MIDDLE', 'YES', 'READY', 'PRESS', 'OKAY', 'NOTHING', 'UHHH', 'BLANK', 'LEFT', 'FIRST', 'WHAT', 'NO', 'WAIT'],
  YOU: ['SURE', 'YOU ARE', 'YOUR', "YOU'RE", 'NEXT', 'UH HUH', 'UR', 'HOLD', 'WHAT?', 'YOU', 'UH UH', 'LIKE', 'DONE', 'U'],
  'YOU ARE': ['YOUR', 'NEXT', 'LIKE', 'UH HUH', 'WHAT?', 'DONE', 'UH UH', 'HOLD', 'YOU', 'U', "YOU'RE", 'SURE', 'UR', 'YOU ARE'],
  YOUR: ['UH UH', 'YOU ARE', 'UH HUH', 'YOUR', 'NEXT', 'UR', 'SURE', 'U', "YOU'RE", 'YOU', 'WHAT?', 'HOLD', 'LIKE', 'DONE'],
  "YOU'RE": ['YOU', "YOU'RE", 'UR', 'NEXT', 'UH UH', 'YOU ARE', 'U', 'YOUR', 'WHAT?', 'UH HUH', 'SURE', 'DONE', 'LIKE', 'HOLD'],
  UR: ['DONE', 'U', 'UR', 'UH HUH', 'WHAT?', 'SURE', 'YOUR', 'HOLD', "YOU'RE", 'LIKE', 'NEXT', 'UH UH', 'YOU ARE', 'YOU'],
  U: ['UH HUH', 'SURE', 'NEXT', 'WHAT?', "YOU'RE", 'UR', 'UH UH', 'DONE', 'U', 'YOU', 'LIKE', 'HOLD', 'YOU ARE', 'YOUR'],
  'UH HUH': ['UH HUH', 'YOUR', 'YOU ARE', 'YOU', 'DONE', 'HOLD', 'UH UH', 'NEXT', 'SURE', 'LIKE', "YOU'RE", 'UR', 'U', 'WHAT?'],
  'UH UH': ['UR', 'U', 'YOU ARE', "YOU'RE", 'NEXT', 'UH UH', 'DONE', 'YOU', 'UH HUH', 'LIKE', 'YOUR', 'SURE', 'HOLD', 'WHAT?'],
  'WHAT?': ['YOU', 'HOLD', "YOU'RE", 'YOUR', 'U', 'DONE', 'UH UH', 'LIKE', 'YOU ARE', 'UH HUH', 'UR', 'NEXT', 'WHAT?', 'SURE'],
  DONE: ['SURE', 'UH HUH', 'NEXT', 'WHAT?', 'YOUR', 'UR', "YOU'RE", 'HOLD', 'LIKE', 'YOU', 'U', 'YOU ARE', 'UH UH', 'DONE'],
  NEXT: ['WHAT?', 'UH HUH', 'UH UH', 'YOUR', 'HOLD', 'SURE', 'NEXT', 'LIKE', 'DONE', 'YOU ARE', 'UR', "YOU'RE", 'U', 'YOU'],
  HOLD: ['YOU ARE', 'U', 'DONE', 'UH UH', 'YOU', 'UR', 'SURE', 'WHAT?', "YOU'RE", 'NEXT', 'HOLD', 'UH HUH', 'YOUR', 'LIKE'],
  SURE: ['YOU ARE', 'DONE', 'LIKE', "YOU'RE", 'YOU', 'HOLD', 'UH HUH', 'UR', 'SURE', 'U', 'WHAT?', 'NEXT', 'YOUR', 'UH UH'],
  LIKE: ["YOU'RE", 'NEXT', 'U', 'UR', 'HOLD', 'DONE', 'UH UH', 'WHAT?', 'UH HUH', 'YOU', 'LIKE', 'SURE', 'YOU ARE', 'YOUR'],
};

function renderWhosOnFirst(): string {
  const s1 = Object.entries(WOF_STEP1)
    .map(([w, pos]) => `${w}=${pos}`)
    .join('; ');
  const s2 = Object.entries(WOF_STEP2)
    .map(([w, list]) => `${w}: ${list.join(', ')}`)
    .join('\n');
  return (
    `## Who's on First (a display word plus six labeled buttons in 3 rows of 2; three stages)\n` +
    `Spelling matters: ask the player to spell the display when it sounds like another word (RED/READ/REED/LEED/LED/LEAD, YOU/U/UR/YOUR/YOU'RE, THERE/THEIR/THEY'RE, C/CEE/SEE). ` +
    `Step 1: the DISPLAY word tells you which button's label to ask for (positions: top/middle/bottom row, left/right). ` +
    `"(empty display)" means the display shows nothing; "BLANK" means it literally says BLANK.\n${s1}\n` +
    `Step 2: find that button LABEL below and go through its list in order; press the first word in the list that is one of the six buttons. ` +
    `The word itself can be the answer (it is in its own list). Repeat with the new display each stage.\n${s2}`
  );
}

export const MEMORY_RULES = `## Memory (a big display number 1-4, four numbered buttons; five stages)
Positions are counted left to right. A wrong press resets to stage 1. Keep the POSITION and the LABEL pressed at every stage, you need them later.
Stage 1: display 1: 2nd position. 2: 2nd position. 3: 3rd position. 4: 4th position.
Stage 2: display 1: the button labeled "4". 2: same position as stage 1. 3: 1st position. 4: same position as stage 1.
Stage 3: display 1: same label as stage 2. 2: same label as stage 1. 3: 3rd position. 4: the button labeled "4".
Stage 4: display 1: same position as stage 1. 2: 1st position. 3: same position as stage 2. 4: same position as stage 2.
Stage 5: display 1: same label as stage 1. 2: same label as stage 2. 3: same label as stage 4. 4: same label as stage 3.`;

/** International Morse code. */
export const MORSE: Record<string, string> = {
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..', J: '.---',
  K: '-.-', L: '.-..', M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-',
  U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..',
};

export const MORSE_WORDS: readonly (readonly [string, string])[] = [
  ['shell', '3.505'], ['halls', '3.515'], ['slick', '3.522'], ['trick', '3.532'],
  ['boxes', '3.535'], ['leaks', '3.542'], ['strobe', '3.545'], ['bistro', '3.552'],
  ['flick', '3.555'], ['bombs', '3.565'], ['break', '3.572'], ['brick', '3.575'],
  ['steak', '3.582'], ['sting', '3.592'], ['vector', '3.595'], ['beats', '3.600'],
];

function renderMorse(): string {
  const code = Object.entries(MORSE)
    .map(([l, c]) => `${l} ${c}`)
    .join(', ');
  const words = MORSE_WORDS.map(([w, f]) => `${w} ${f}`).join(', ');
  return (
    `## Morse Code (a flashing light, a frequency dial, a TX button)\n` +
    `Short flash = dot (.), long flash = dash (-). A long gap separates letters; a very long gap means the word starts over, so the player may begin mid-word. ` +
    `Decode letters until only one word below fits, then have them set that frequency (MHz) and press TX.\n` +
    `Letters: ${code}\nWord -> frequency: ${words}`
  );
}

/** Complicated wires: (red, blue, star, led) -> instruction letter. */
export const COMPLICATED_WIRES = `## Complicated Wires (up to 6 vertical wires, each with an LED above and maybe a star below)
For EACH wire, note four facts: has red coloring, has blue coloring (a wire can be striped with both; white counts as neither), star symbol below it, LED above it lit. Then look up the instruction:
 none of the four: CUT
 red only: S | blue only: S | star only: CUT | LED only: DON'T
 red+blue: S | red+star: CUT | red+LED: B | blue+star: DON'T | blue+LED: P | star+LED: B
 red+blue+star: P | red+blue+LED: S | red+star+LED: B | blue+star+LED: P
 red+blue+star+LED: DON'T
S = cut if the serial's last digit is even. P = cut if the bomb has a parallel port. B = cut if the bomb has two or more batteries.`;

export const WIRE_SEQUENCE_RULES = `## Wire Sequences (several panels of up to 3 wires; each wire runs from a number 1-3 on the left to a letter A, B or C on the right)
Count colors across ALL panels of this module (the 1st red wire you ever see, the 2nd red, ...). For each wire, find its color's occurrence number and cut it only if its letter is listed. Finish a panel before pressing down for the next.
Red: 1st C; 2nd B; 3rd A; 4th A or C; 5th B; 6th A or C; 7th A, B or C; 8th A or B; 9th B.
Blue: 1st B; 2nd A or C; 3rd B; 4th A; 5th B; 6th B or C; 7th C; 8th A or C; 9th A.
Black: 1st A, B or C; 2nd A or C; 3rd B; 4th A or C; 5th B; 6th B or C; 7th A or B; 8th C; 9th C.`;

/**
 * The nine mazes, drawn on a 6x6 grid (columns 1-6 left to right, rows 1-6
 * top to bottom). '|' and '-' are walls; 'O' marks a circle. Parsed by
 * `parseMaze` for the exit lists the prompt carries (and the eval's solver).
 */
export const MAZES: readonly string[] = [
  `+-+-+-+-+-+-+
|. . .|. . .|
+ +-+ + +-+-+
|O|. .|. . .|
+ + +-+-+-+ +
|.|. .|. . O|
+ +-+ + +-+ +
|.|. . .|. .|
+ +-+-+-+-+ +
|. . .|. .|.|
+ +-+ + +-+ +
|. .|. .|. .|
+-+-+-+-+-+-+`,
  `+-+-+-+-+-+-+
|. . .|. . .|
+-+ +-+ + +-+
|. .|. .|O .|
+ +-+ +-+-+ +
|.|. .|. . .|
+ + +-+ +-+ +
|. O|. .|.|.|
+ +-+ +-+ + +
|.|.|.|. .|.|
+ + + + +-+ +
|.|. .|. . .|
+-+-+-+-+-+-+`,
  `+-+-+-+-+-+-+
|. . .|.|. .|
+ +-+ + + + +
|.|.|.|. .|.|
+-+ + +-+-+ +
|. .|.|. .|.|
+ + + + + + +
|.|.|.|O|.|O|
+ + + + + + +
|.|. .|.|.|.|
+ +-+-+ + + +
|. . . .|. .|
+-+-+-+-+-+-+`,
  `+-+-+-+-+-+-+
|O .|. . . .|
+ + +-+-+-+ +
|.|.|. . . .|
+ + + +-+-+ +
|.|. .|. .|.|
+ +-+-+ +-+ +
|O|. . . . .|
+ +-+-+-+-+ +
|. . . . .|.|
+ +-+-+-+ + +
|. . .|. .|.|
+-+-+-+-+-+-+`,
  `+-+-+-+-+-+-+
|. . . . . .|
+-+-+-+-+ + +
|. . . . .|.|
+ +-+-+ +-+-+
|. .|. .|O .|
+ + +-+-+ + +
|.|. . .|.|.|
+ +-+-+ +-+ +
|.|. . . .|.|
+ + +-+-+-+ +
|.|. . O . .|
+-+-+-+-+-+-+`,
  `+-+-+-+-+-+-+
|.|. .|. O .|
+ + + +-+ + +
|.|.|.|. .|.|
+ + + + +-+ +
|. .|.|.|. .|
+ +-+-+ + +-+
|. .|. .|.|.|
+-+ + + + + +
|. .|O|.|. .|
+ +-+-+ +-+ +
|. . . .|. .|
+-+-+-+-+-+-+`,
  `+-+-+-+-+-+-+
|. O . .|. .|
+ +-+-+ + + +
|.|. .|. .|.|
+ + +-+-+-+ +
|. .|. .|. .|
+-+-+ +-+ +-+
|. .|. . .|.|
+ + + +-+-+ +
|.|.|. . .|.|
+ +-+-+-+ + +
|. O . . . .|
+-+-+-+-+-+-+`,
  `+-+-+-+-+-+-+
|.|. . O|. .|
+ + +-+ + + +
|. . .|. .|.|
+ +-+-+-+-+ +
|.|. . . .|.|
+ + +-+-+ + +
|.|. O|. . .|
+ +-+ +-+-+-+
|.|.|. . . .|
+ + +-+-+-+-+
|. . . . . .|
+-+-+-+-+-+-+`,
  `+-+-+-+-+-+-+
|.|. . . . .|
+ + +-+-+ + +
|.|.|O .|.|.|
+ + + +-+ + +
|. . .|. .|.|
+ +-+-+ +-+ +
|.|.|. .|. .|
+ + + +-+-+ +
|O|.|.|. .|.|
+ + + + + +-+
|. .|. .|. .|
+-+-+-+-+-+-+`,
];

export interface ParsedMaze {
  /** Circle cells, [col, row], 1-based. */
  circles: [number, number][];
  /** Open directions per cell, keyed "col,row" (1-based): subset of 'UDLR'. */
  exits: Record<string, string>;
}

/** Parse one MAZES drawing into circles + open exits. */
export function parseMaze(art: string): ParsedMaze {
  const lines = art.split('\n');
  const circles: [number, number][] = [];
  const exits: Record<string, string> = {};
  for (let r = 0; r < 6; r++) {
    const top = lines[2 * r];
    const mid = lines[2 * r + 1];
    const bottom = lines[2 * r + 2];
    for (let c = 0; c < 6; c++) {
      const x = 2 * c + 1;
      let e = '';
      if (r > 0 && top[x] === ' ') e += 'U';
      if (r < 5 && bottom[x] === ' ') e += 'D';
      if (c > 0 && mid[x - 1] === ' ') e += 'L';
      if (c < 5 && mid[x + 1] === ' ') e += 'R';
      exits[`${c + 1},${r + 1}`] = e;
      if (mid[x] === 'O') circles.push([c + 1, r + 1]);
    }
  }
  return { circles, exits };
}

function renderMazes(): string {
  const dir: Record<string, string> = { U: 'up', D: 'down', L: 'left', R: 'right' };
  const mazes = MAZES.map((art, i) => {
    const m = parseMaze(art);
    const circles = m.circles.map(([c, r]) => `(${c},${r})`).join(' and ');
    const rows: string[] = [];
    for (let r = 1; r <= 6; r++) {
      const cells: string[] = [];
      for (let c = 1; c <= 6; c++) {
        cells.push(`(${c},${r}) ${m.exits[`${c},${r}`].split('').map((d) => dir[d]).join(' ')}`);
      }
      rows.push(cells.join('; '));
    }
    return `Maze ${i + 1}, circles at ${circles}. Open moves from each square:\n${rows.join('\n')}`;
  });
  return (
    `## Mazes (6x6 grid of squares, two green circles, a white light, a red triangle)\n` +
    `Squares are (column,row): column 1-6 from the left, row 1-6 from the top. Ask where the two circles are, where the white light is and where the red triangle is, as (column,row). ` +
    `The circles pick the maze. Then guide the light to the triangle one move at a time, only through open moves (walls are invisible to the player and a blocked move is a strike). ` +
    `Work the route out silently in your bomb_notes memo first: walk it square by square through the open moves, like "(1,6) up (1,5) up (1,4) right (2,4)", and back up out of dead ends. Then say only the first two or three moves ("up, up, right") and ask where the light is.\n` +
    mazes.join('\n')
  );
}

export const PASSWORD_WORDS: readonly string[] = [
  'about', 'after', 'again', 'below', 'could', 'every', 'first', 'found', 'great', 'house',
  'large', 'learn', 'never', 'other', 'place', 'plant', 'point', 'right', 'small', 'sound',
  'spell', 'still', 'study', 'their', 'there', 'these', 'thing', 'think', 'three', 'water',
  'where', 'which', 'world', 'would', 'write',
];

function renderPasswords(): string {
  return (
    `## Passwords (five letter slots, each cycles through about six letters, a submit button)\n` +
    `Exactly one word below can be made from the letters on offer. Ask for the letters a slot can show (usually slot 1 first, then 2), narrow the list, then have them set the word and submit.\n` +
    PASSWORD_WORDS.join(', ')
  );
}

export const NEEDY_RULES = `## Needy modules (a small two-digit timer on top; they cannot be solved, only kept from running out, or they cause a strike)
Venting Gas: a screen asks a question. "VENT GAS?" press Y. "DETONATE?" press N.
Capacitor Discharge: hold the lever down to drain it before the bar fills.
Knobs: twelve LEDs in two rows of six. Turn the knob (positions relative to the "UP" label, which may be rotated) to match. 1 = lit, 0 = off, top row / bottom row:
 UP: 001011/111101 or 101010/011011
 DOWN: 011001/111101 or 101010/010001
 LEFT: 000010/100111 or 000010/000110
 RIGHT: 101111/111010 or 101100/111010`;

export const EDGEWORK = `## The bomb casing (edgework)
Serial number: a sticker on a side. Batteries: count batteries, not holders (an AA holder has two, a D holder has one). Indicators: three-letter labels with a light that is lit or unlit (SND CLR CAR IND FRQ SIG NSA MSA TRN BOB FRK). Ports: DVI-D, Parallel, PS/2, RJ-45, Serial, Stereo RCA. Strikes show above the timer; with a strike counter the bomb explodes on the third strike, without one on the first. The timer runs faster after a strike.`;

/** The whole compact manual, rendered once (cached in the system prompt). */
export function renderKtaneManual(): string {
  return [
    '# BOMB DEFUSAL MANUAL (Keep Talking and Nobody Explodes, vanilla modules)',
    'Every bomb has up to 11 modules, solved in any order; a module is done when its light turns green. All modules solved = bomb defused.',
    EDGEWORK,
    WIRE_RULES,
    BUTTON_RULES,
    renderKeypad(),
    SIMON_RULES,
    renderWhosOnFirst(),
    MEMORY_RULES,
    renderMorse(),
    COMPLICATED_WIRES,
    WIRE_SEQUENCE_RULES,
    renderMazes(),
    renderPasswords(),
    NEEDY_RULES,
  ].join('\n\n');
}

/** Module ids the bomb sheet tracks (vanilla). */
export const KTANE_MODULES = [
  'wires',
  'button',
  'keypad',
  'simon',
  'whos_on_first',
  'memory',
  'morse',
  'complicated_wires',
  'wire_sequence',
  'maze',
  'password',
  'venting_gas',
  'capacitor',
  'knob',
] as const;
export type KtaneModule = (typeof KTANE_MODULES)[number];
