/**
 * Scripted KTANE expert cases (261115) for scripts/ktane-eval.ts.
 *
 * Each case is what a Defuser says on a call (STT-like wording), plus what the
 * expert already wrote down (the bomb sheet). The answer key is computed with
 * the eval-only solver wherever possible, so a typo in a case cannot silently
 * produce a wrong key.
 *
 * expect:
 *   answer  every fact is there: the reply must give the right action.
 *   ask     a needed fact is missing: the reply must ask for it and must not
 *           commit to an action that depends on it.
 *   notes   the line is bomb facts: check the bomb_notes() call fields.
 *   maze    moves are extracted from the reply and replayed on the real maze.
 */
import { emptySheet, type KtaneSheet } from '../../src/shared/ktaneSheet';
import * as S from './solver';
import { KEYPAD_SYMBOLS } from '../../src/shared/ktaneManual';

export type Expect = 'answer' | 'ask' | 'notes' | 'maze';

export interface KCase {
  id: string;
  module: string;
  expect: Expect;
  sheet?: Partial<KtaneSheet>;
  /** Earlier call lines, oldest first (role, text). */
  history?: [('user' | 'assistant'), string][];
  user: string;
  /** What a correct reply does (shown to the judge). */
  key: string;
  /** notes: fields the bomb_notes call must carry (compared loosely). */
  notes?: Record<string, unknown>;
  /** maze: the maze facts for the move replay. */
  maze?: { circle: [number, number]; from: [number, number]; to: [number, number] };
}

/** A multi-turn chain: run live, the model's own replies and notes carry over. */
export interface KChain {
  id: string;
  module: string;
  sheet?: Partial<KtaneSheet>;
  turns: { user: string; key: string; expect: 'answer' | 'ask' }[];
}

const sheet = (p: Partial<KtaneSheet>): Partial<KtaneSheet> => ({ ...emptySheet(), ...p });
const ord = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'];
const sym = (ids: string[]) => ids.map((i) => KEYPAD_SYMBOLS[i].name).join(', then ');

const ODD = 'AB3CD7';
const EVEN = 'XK4QF2';

export const CASES: KCase[] = [
  // ── Wires ──
  { id: 'W1', module: 'wires', expect: 'answer', user: 'ok wires module. three wires, blue, blue, white',
    key: `Cut the ${ord[S.wires(['blue', 'blue', 'white'], 0) - 1]} wire.` },
  { id: 'W2', module: 'wires', expect: 'answer', sheet: sheet({ serial: ODD }), user: 'next one is wires. four of them: red, blue, red, yellow',
    key: `Cut the ${ord[S.wires(['red', 'blue', 'red', 'yellow'], 7) - 1]} wire (the last red one).` },
  { id: 'W3', module: 'wires', expect: 'ask', user: 'wires. four wires, red blue red yellow',
    key: 'The rule depends on whether the serial number\'s last digit is odd: ask for the serial number (or its last digit) before naming a wire.' },
  { id: 'W4', module: 'wires', expect: 'answer', sheet: sheet({ serial: EVEN }), user: 'five wires. black, red, yellow, yellow, white',
    key: `Cut the ${ord[S.wires(['black', 'red', 'yellow', 'yellow', 'white'], 2) - 1]} wire.` },
  { id: 'W5', module: 'wires', expect: 'answer', sheet: sheet({ serial: 'G7HJ81' }), user: 'six wires top to bottom red white yellow blue white black',
    key: `Cut the ${ord[S.wires(['red', 'white', 'yellow', 'blue', 'white', 'black'], 1) - 1]} wire.` },
  { id: 'W6', module: 'wires', expect: 'answer', user: 'three wires: red, blue, white',
    key: `Cut the ${ord[S.wires(['red', 'blue', 'white'], 0) - 1]} wire (the last one).` },
  { id: 'W7', module: 'wires', expect: 'answer', sheet: sheet({ serial: 'AL5GF3' }), user: 'six wires. blue blue red black white black',
    key: `Cut the ${ord[S.wires(['blue', 'blue', 'red', 'black', 'white', 'black'], 3) - 1]} wire.` },

  // ── The Button ──
  { id: 'B1', module: 'button', expect: 'answer', user: 'theres a big blue button that says abort',
    key: `${S.button({ color: 'blue', label: 'abort', batteries: 0, lit: [] }) === 'hold' ? 'Hold the button down' : 'Tap it'} and say what color the strip is (asking for the strip color is expected).` },
  { id: 'B2', module: 'button', expect: 'answer', sheet: sheet({ batteries: 3 }), user: 'button module. red button, says detonate',
    key: `${S.button({ color: 'red', label: 'detonate', batteries: 3, lit: [] }) === 'tap' ? 'Press and immediately release it (tap)' : 'Hold it'}.` },
  { id: 'B3', module: 'button', expect: 'ask', user: 'red button, it says detonate',
    key: 'Whether to tap depends on the battery count: ask how many batteries before deciding.' },
  { id: 'B4', module: 'button', expect: 'answer', sheet: sheet({ batteries: 1, indicators: [{ label: 'CAR', lit: true }] }), user: 'white button that says press',
    key: `${S.button({ color: 'white', label: 'press', batteries: 1, lit: ['CAR'] }) === 'hold' ? 'Hold the button' : 'Tap it'} (asking for the strip color is expected).` },
  { id: 'B5', module: 'button', expect: 'answer', sheet: sheet({ batteries: 1, indicators: [] }), user: 'red button. says hold',
    key: `${S.button({ color: 'red', label: 'hold', batteries: 1, lit: [] }) === 'tap' ? 'Press and immediately release it (tap)' : 'Hold it'}.` },
  { id: 'B6', module: 'button', expect: 'answer', sheet: sheet({ module: 'button', batteries: 1, indicators: [] }),
    history: [['user', 'yellow button says abort'], ['assistant', 'hold it down. what color is the strip?']],
    user: 'ok holding, the strip is yellow', key: `Release when the timer has a ${S.releaseDigit('yellow')} in any position.` },
  { id: 'B7', module: 'button', expect: 'answer', sheet: sheet({ batteries: 2, indicators: [] }), user: 'yellow button that says detonate',
    key: `${S.button({ color: 'yellow', label: 'detonate', batteries: 2, lit: [] }) === 'tap' ? 'Press and immediately release it (tap)' : 'Hold it'}.` },

  // ── Keypads ──
  { id: 'K1', module: 'keypad', expect: 'answer', user: 'keypad. theres a copyright sign, a backwards R that looks like a melted 3, an empty outline star, and a little pumpkin thing',
    key: `Press in this order: ${sym(S.keypad(['copyright', 'meltedthree', 'hollowstar', 'pumpkin']))}.` },
  { id: 'K2', module: 'keypad', expect: 'answer', user: 'symbols are a smiley face, a pitchfork, a filled in black star, and a paragraph sign',
    key: `Press in this order: ${sym(S.keypad(['smiley', 'pitchfork', 'filledstar', 'paragraph']))}.` },
  { id: 'K3', module: 'keypad', expect: 'answer', user: 'keypad: omega, an a e stuck together, a six, and something like railroad tracks',
    key: `Press in this order: ${sym(S.keypad(['omega', 'ae', 'six', 'tracks']))}.` },
  { id: 'K4', module: 'keypad', expect: 'answer', user: 'ok keypad, a balloon looking thing, a squiggly lightning N, an A with a tail, and a backwards C with a dot in it',
    key: `Press in this order: ${sym(S.keypad(['balloon', 'lightning', 'at', 'leftc']))}.` },

  // ── Simon Says ──
  { id: 'S1', module: 'simon', expect: 'answer', sheet: sheet({ serial: ODD, strikes: 0 }), user: 'simon says. it flashed red',
    key: `Press ${S.simon(['red'], true, 0).join(', ')}.` },
  { id: 'S2', module: 'simon', expect: 'answer', sheet: sheet({ serial: EVEN, strikes: 1 }), user: 'simon is flashing blue, then green, then yellow',
    key: `Press ${S.simon(['blue', 'green', 'yellow'], false, 1).join(', then ')}.` },
  { id: 'S3', module: 'simon', expect: 'ask', user: 'simon says, flashing blue',
    key: 'Blue maps to red with a vowel in the serial and to yellow without one: ask for the serial number (strike count may also be asked).' },

  // ── Who's on First ──
  { id: 'F1', module: 'whos_on_first', expect: 'answer', user: "who's on first. display says FIRST, F I R S T. buttons: top left READY, top right OKAY, middle left NOTHING, middle right LEFT, bottom left PRESS, bottom right YES",
    key: `Press ${S.whosOnFirst('FIRST', ['READY', 'OKAY', 'NOTHING', 'LEFT', 'PRESS', 'YES'])}.` },
  { id: 'F2', module: 'whos_on_first', expect: 'answer', user: "whos on first, display is U R, just the two letters. buttons top left Y O U apostrophe R E, top right U, middle left DONE, middle right NEXT, bottom left SURE, bottom right LIKE",
    key: `Press ${S.whosOnFirst('UR', ["YOU'RE", 'U', 'DONE', 'NEXT', 'SURE', 'LIKE'])} (top left).` },
  { id: 'F3', module: 'whos_on_first', expect: 'answer', user: "who's on first, the display is completely empty, nothing on it. buttons: WAIT, UHHH, BLANK, WHAT, RIGHT, MIDDLE, reading left to right top to bottom",
    key: `Press ${S.whosOnFirst('', ['WAIT', 'UHHH', 'BLANK', 'WHAT', 'RIGHT', 'MIDDLE'])} (top left).` },
  { id: 'F4', module: 'whos_on_first', expect: 'ask', user: "who's on first. the display says red. buttons are READY, FIRST, NO, BLANK, NOTHING, YES",
    key: 'RED, READ, REED, LED and similar words sound alike and map to different buttons: ask the player to spell the display word before naming a button.' },

  // ── Morse ──
  { id: 'M1', module: 'morse', expect: 'answer', user: `morse code. the light goes ${S.morseOf('shell').replace(/\./g, 'dot ').replace(/-/g, 'dash ').replace(/  /g, ', ')}`,
    key: `The word is shell: set ${S.morseFreq('shell')} MHz and press TX.` },
  { id: 'M2', module: 'morse', expect: 'answer', user: 'morse. long short short short, then short long short, then short short, then long short long short',
    key: `B R I C narrows it to brick: set ${S.morseFreq('brick')} MHz and press TX.` },

  // ── Complicated wires ──
  { id: 'C1', module: 'complicated_wires', expect: 'answer', sheet: sheet({ serial: EVEN, batteries: 1, ports: ['serial'] }),
    user: 'complicated wires, four wires. first is white, no light, no star. second is red with a star, light off. third is blue, light on, no star. fourth is red and blue striped, light on, no star',
    key: (() => {
      const e = { serialEven: true, parallel: false, batteries: 1 };
      const ws = [{ red: false, blue: false, star: false, led: false }, { red: true, blue: false, star: true, led: false }, { red: false, blue: true, star: false, led: true }, { red: true, blue: true, star: false, led: true }];
      const cut = ws.map((w, i) => (S.complicated(w, e) ? ord[i] : null)).filter(Boolean);
      return `Cut the ${cut.join(', ')} wires; leave the others.`;
    })() },
  { id: 'C2', module: 'complicated_wires', expect: 'ask', sheet: sheet({ serial: EVEN }), user: 'complicated wires, just one wire. its red, LED is lit, no star',
    key: 'Red + LED means cut only with two or more batteries: ask how many batteries.' },
  { id: 'C3', module: 'complicated_wires', expect: 'answer', sheet: sheet({ serial: ODD, batteries: 0, ports: ['parallel', 'serial'] }),
    user: 'complicated wires. two wires. first one is blue with a star and the light is on. second one is plain white with only the light on',
    key: (() => {
      const e = { serialEven: false, parallel: true, batteries: 0 };
      const a = S.complicated({ red: false, blue: true, star: true, led: true }, e);
      const b = S.complicated({ red: false, blue: false, star: false, led: true }, e);
      return `${a ? 'Cut' : 'Do not cut'} the first wire; ${b ? 'cut' : 'do not cut'} the second.`;
    })() },

  // ── Wire sequences ──
  { id: 'Q1', module: 'wire_sequence', expect: 'answer', user: 'wire sequences. first panel: one goes red to C, two goes blue to A, three goes black to B',
    key: (() => {
      const r = S.wireSequence([[{ from: 1, color: 'red', to: 'C' }, { from: 2, color: 'blue', to: 'A' }, { from: 3, color: 'black', to: 'B' }]])[0];
      return `Cut wire(s) ${r.map((c, i) => (c ? i + 1 : null)).filter(Boolean).join(' and ')}; leave the rest.`;
    })() },
  { id: 'Q2', module: 'wire_sequence', expect: 'answer', sheet: sheet({ module: 'wire_sequence', memo: 'so far: 1 red, 1 blue, 1 black' }),
    history: [['user', 'wire sequences. first panel: one red to C, two blue to A, three black to B'], ['assistant', 'cut one and three, leave two. then go to the next panel.']],
    user: 'done. next panel: one is red to A, two is red to B, three is blue to C',
    key: (() => {
      const r = S.wireSequence([
        [{ from: 1, color: 'red', to: 'C' }, { from: 2, color: 'blue', to: 'A' }, { from: 3, color: 'black', to: 'B' }],
        [{ from: 1, color: 'red', to: 'A' }, { from: 2, color: 'red', to: 'B' }, { from: 3, color: 'blue', to: 'C' }],
      ])[1];
      return `Cut wire(s) ${r.map((c, i) => (c ? i + 1 : null)).filter(Boolean).join(' and ')}; leave the rest.`;
    })() },

  // ── Mazes ──
  { id: 'Z1', module: 'maze', expect: 'maze', user: 'maze. circles are at column 1 row 2 and column 6 row 3. the white light is at column 1 row 6 and the red triangle is at column 6 row 1',
    maze: { circle: [1, 2], from: [1, 6], to: [6, 1] }, key: 'Give legal moves toward the triangle.' },
  { id: 'Z2', module: 'maze', expect: 'maze', user: 'maze, circles at 1,1 and 1,4. light is at 6,6, triangle at 4,3. column first',
    maze: { circle: [1, 1], from: [6, 6], to: [4, 3] }, key: 'Give legal moves toward the triangle.' },
  { id: 'Z3', module: 'maze', expect: 'maze', user: 'maze. green circles at column 2 row 4 and column 5 row 2. I am at column 3 row 1, the triangle is at column 3 row 6',
    maze: { circle: [2, 4], from: [3, 1], to: [3, 6] }, key: 'Give legal moves toward the triangle.' },

  // ── Passwords ──
  { id: 'P1', module: 'password', expect: 'ask', user: 'password module. first letter can be s, w, p, g, k, n. second letter p, e, t, m, z, a',
    key: `Several words still fit (${S.password([['s', 'w', 'p', 'g', 'k', 'n'], ['p', 'e', 't', 'm', 'z', 'a']]).join(', ')}): ask for the third slot letters (or name candidates and ask).` },
  { id: 'P2', module: 'password', expect: 'answer', sheet: sheet({ module: 'password' }),
    history: [['user', 'password. first slot: s w p g k n. second slot: p e t m z a'], ['assistant', 'few options left. what can the third letter be?']],
    user: 'third slot: i, x, o, c, y, r',
    key: `The word is ${S.password([['s', 'w', 'p', 'g', 'k', 'n'], ['p', 'e', 't', 'm', 'z', 'a'], ['i', 'x', 'o', 'c', 'y', 'r']]).join('/')}: set it and submit.` },

  // ── Needy ──
  { id: 'N1', module: 'venting_gas', expect: 'answer', user: 'a needy one popped up, the screen says vent gas question mark, Y slash N', key: 'Press Y.' },
  { id: 'N2', module: 'knob', expect: 'answer', user: 'knob module. top row of lights: off off on off on on. bottom row: on on on on off on',
    key: 'Turn the knob to the UP position (relative to the UP label).' },

  // ── Bomb facts (bomb_notes) ──
  { id: 'E1', module: 'edgework', expect: 'notes', user: 'ok before we start. serial is A L 5 G F 3. two batteries. theres a lit F R K and an unlit B O B. and a parallel port',
    key: 'Short acknowledgement; bomb_notes with serial AL5GF3, batteries 2, indicators lit FRK + unlit BOB, ports parallel.',
    notes: { serial: 'AL5GF3', batteries: 2, indicators: ['lit FRK', 'unlit BOB'], ports: ['parallel'] } },
  { id: 'E2', module: 'edgework', expect: 'notes', sheet: sheet({ serial: ODD, strikes: 0, module: 'simon' }), user: 'ugh, we got a strike',
    key: 'Brief reaction; bomb_notes strikes 1 (and remind that Simon mapping changes is fine).', notes: { strikes: 1 } },

  // ── Moments (261115): a module line with feeling in it, where a character
  // has room to react in its own way. Scored on the action like any case;
  // the character-voice judge reads these most closely.
  { id: 'V1', module: 'button', expect: 'answer', user: 'oh no oh no, like thirty seconds left and theres a button. its blue and it says abort',
    key: `${S.button({ color: 'blue', label: 'abort', batteries: 0, lit: [] }) === 'hold' ? 'Hold the button down' : 'Tap it'} (asking for the strip color is expected).` },
  { id: 'V2', module: 'simon', expect: 'answer', sheet: sheet({ serial: ODD, strikes: 0, module: 'simon' }),
    user: 'it buzzed, we got a strike. sorry, my fault. now it flashed red',
    key: `The strike makes it 1 strike now (serial has a vowel): press ${S.simon(['red'], true, 1).join(', ')}.` },
  { id: 'V3', module: 'reaction', expect: 'answer', sheet: sheet({ serial: ODD, batteries: 2, module: 'wires' }),
    user: 'the light went green and the timer stopped, it says defused!! we did it',
    key: 'The bomb is defused. Any reaction to the win passes; no instruction is needed. FAIL only if it gives a bomb instruction as if the bomb were still live.' },
  { id: 'V4', module: 'wires', expect: 'answer', sheet: sheet({ serial: ODD }),
    user: 'uh ok wires, i think theres four? red, blue, wait no. ok. four wires: red, red, blue, yellow. sorry',
    key: `Cut the ${ord[S.wires(['red', 'red', 'blue', 'yellow'], 7) - 1]} wire (the last red one).` },
];

/** The subset the character-voice comparison runs (--subset voice). */
export const VOICE_SUBSET = ['W1', 'W3', 'B6', 'K1', 'F1', 'M2', 'C1', 'Z1', 'P1', 'V1', 'V2', 'V3', 'V4'];

export const CHAINS: KChain[] = [
  (() => {
    const stages = [
      { display: 3, labels: [2, 4, 3, 1] },
      { display: 4, labels: [1, 3, 2, 4] },
      { display: 1, labels: [3, 2, 4, 1] },
      { display: 2, labels: [4, 1, 3, 2] },
      { display: 3, labels: [2, 3, 4, 1] },
    ];
    const ans = S.memory(stages);
    return {
      id: 'MEM', module: 'memory',
      turns: stages.map((s, i) => ({
        user: `${i === 0 ? 'memory module. ' : `ok pressed it. stage ${i + 1}. `}display shows ${s.display}, buttons ${s.labels.join(' ')}`,
        key: `Stage ${i + 1}: press the button labeled ${ans[i].label} (position ${ans[i].pos}).`,
        expect: 'answer' as const,
      })),
    };
  })(),
  {
    // Edgework first, then enough chatter that it scrolls out of the 10-row
    // call window, then a rule that needs it: the notes must carry it.
    id: 'BOMB', module: 'mixed',
    turns: [
      { user: 'alright new bomb. serial number is K 9 E X 4 1. there are three batteries and a lit F R K.', key: 'Short acknowledgement, ready for the first module.', expect: 'answer' },
      { user: 'first module is wires. three wires, white, white, red', key: `Cut the ${ord[S.wires(['white', 'white', 'red'], 1) - 1]} wire.`, expect: 'answer' },
      { user: 'nice that worked', key: 'Short acknowledgement or ask for the next module.', expect: 'answer' },
      { user: 'next is a keypad: a six, a euro looking E with dots, an omega, and a pitchfork', key: `Press in this order: ${sym(S.keypad(['six', 'euro', 'omega', 'pitchfork']))}.`, expect: 'answer' },
      { user: 'done, light is green', key: 'Short acknowledgement or ask for the next module.', expect: 'answer' },
      { user: 'now a simon says, it flashed blue', key: `Press ${S.simon(['blue'], true, 0)[0]} (serial K9EX41 has a vowel, 0 strikes).`, expect: 'answer' },
      { user: 'now it flashed blue then yellow', key: `Press ${S.simon(['blue', 'yellow'], true, 0).join(', then ')}.`, expect: 'answer' },
      { user: 'nice, simon is solved', key: 'Short acknowledgement or ask for the next module.', expect: 'answer' },
      { user: 'there is a button, it is white and says detonate', key: `${S.button({ color: 'white', label: 'detonate', batteries: 3, lit: ['FRK'] }) === 'tap' ? 'Press and immediately release it (tap): 3 batteries + Detonate' : 'Hold it'}.`, expect: 'answer' },
      { user: 'ok done. last one, four wires: red, red, blue, blue', key: `Cut the ${ord[S.wires(['red', 'red', 'blue', 'blue'], 1) - 1]} wire (serial ends in 1, odd).`, expect: 'answer' },
    ],
  },
];
