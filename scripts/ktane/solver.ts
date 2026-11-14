/**
 * KTANE answer-key solver (261115). EVAL ONLY: scripts/ktane-eval.ts uses it
 * to compute the correct action for each scripted case, and the unit test
 * uses it to check the compact manual against known solutions. The app never
 * imports this file: in the app the companion applies the manual itself.
 */
import {
  KEYPAD_COLUMNS,
  MAZES,
  MORSE,
  MORSE_WORDS,
  PASSWORD_WORDS,
  WOF_STEP1,
  WOF_STEP2,
  parseMaze,
} from '../../src/shared/ktaneManual';

export type Color = 'red' | 'blue' | 'yellow' | 'white' | 'black';

/** 1-based wire to cut. */
export function wires(colors: Color[], serialLastDigit: number): number {
  const n = colors.length;
  const count = (c: Color) => colors.filter((x) => x === c).length;
  const last = colors[n - 1];
  const lastOf = (c: Color) => colors.lastIndexOf(c) + 1;
  const odd = serialLastDigit % 2 === 1;
  if (n === 3) {
    if (count('red') === 0) return 2;
    if (last === 'white') return 3;
    if (count('blue') > 1) return lastOf('blue');
    return 3;
  }
  if (n === 4) {
    if (count('red') > 1 && odd) return lastOf('red');
    if (last === 'yellow' && count('red') === 0) return 1;
    if (count('blue') === 1) return 1;
    if (count('yellow') > 1) return 4;
    return 2;
  }
  if (n === 5) {
    if (last === 'black' && odd) return 4;
    if (count('red') === 1 && count('yellow') > 1) return 1;
    if (count('black') === 0) return 2;
    return 1;
  }
  if (count('yellow') === 0 && odd) return 3;
  if (count('yellow') === 1 && count('white') > 1) return 4;
  if (count('red') === 0) return 6;
  return 4;
}

export function button(p: { color: string; label: string; batteries: number; lit: string[] }): 'tap' | 'hold' {
  const { color, label, batteries, lit } = p;
  if (color === 'blue' && label === 'abort') return 'hold';
  if (batteries > 1 && label === 'detonate') return 'tap';
  if (color === 'white' && lit.includes('CAR')) return 'hold';
  if (batteries > 2 && lit.includes('FRK')) return 'tap';
  if (color === 'yellow') return 'hold';
  if (color === 'red' && label === 'hold') return 'tap';
  return 'hold';
}

export function releaseDigit(strip: string): number {
  return strip === 'blue' ? 4 : strip === 'yellow' ? 5 : 1;
}

/** Keypad press order (symbol ids). */
export function keypad(symbols: string[]): string[] {
  const col = KEYPAD_COLUMNS.find((c) => symbols.every((s) => c.includes(s)));
  if (!col) throw new Error(`no keypad column for ${symbols.join(',')}`);
  return col.filter((s) => symbols.includes(s));
}

const SIMON: Record<string, Record<number, Record<string, string>>> = {
  vowel: {
    0: { red: 'blue', blue: 'red', green: 'yellow', yellow: 'green' },
    1: { red: 'yellow', blue: 'green', green: 'blue', yellow: 'red' },
    2: { red: 'green', blue: 'red', green: 'yellow', yellow: 'blue' },
  },
  none: {
    0: { red: 'blue', blue: 'yellow', green: 'green', yellow: 'red' },
    1: { red: 'red', blue: 'blue', green: 'yellow', yellow: 'green' },
    2: { red: 'yellow', blue: 'green', green: 'blue', yellow: 'red' },
  },
};
export function simon(flashes: string[], vowel: boolean, strikes: number): string[] {
  const t = SIMON[vowel ? 'vowel' : 'none'][Math.min(strikes, 2)];
  return flashes.map((f) => t[f]);
}

/** Who's on First: buttons in order TL, TR, ML, MR, BL, BR. Returns the label to press. */
export function whosOnFirst(display: string, buttons: string[]): string {
  const pos = WOF_STEP1[display === '' ? '(empty display)' : display];
  const idx = ['top left', 'top right', 'middle left', 'middle right', 'bottom left', 'bottom right'].indexOf(pos);
  const label = buttons[idx];
  const list = WOF_STEP2[label];
  const hit = list.find((w) => buttons.includes(w));
  if (!hit) throw new Error('wof: no hit');
  return hit;
}

/** Memory: each stage {display, labels[4]}; returns [{pos (1-based), label}] per stage. */
export function memory(stages: { display: number; labels: number[] }[]): { pos: number; label: number }[] {
  const out: { pos: number; label: number }[] = [];
  const byPos = (s: { labels: number[] }, pos: number) => ({ pos, label: s.labels[pos - 1] });
  const byLabel = (s: { labels: number[] }, label: number) => ({ pos: s.labels.indexOf(label) + 1, label });
  stages.forEach((s, i) => {
    const d = s.display;
    let p: { pos: number; label: number };
    if (i === 0) p = byPos(s, d === 1 || d === 2 ? 2 : d);
    else if (i === 1) p = d === 1 ? byLabel(s, 4) : d === 3 ? byPos(s, 1) : byPos(s, out[0].pos);
    else if (i === 2) p = d === 1 ? byLabel(s, out[1].label) : d === 2 ? byLabel(s, out[0].label) : d === 3 ? byPos(s, 3) : byLabel(s, 4);
    else if (i === 3) p = d === 1 ? byPos(s, out[0].pos) : d === 2 ? byPos(s, 1) : byPos(s, out[1].pos);
    else p = byLabel(s, out[[0, 1, 3, 2][d - 1]].label);
    out.push(p);
  });
  return out;
}

export function morseOf(word: string): string {
  return word
    .toUpperCase()
    .split('')
    .map((l) => MORSE[l])
    .join(' ');
}
export function morseFreq(word: string): string {
  const hit = MORSE_WORDS.find(([w]) => w === word);
  if (!hit) throw new Error(`morse ${word}`);
  return hit[1];
}

export function complicated(w: { red: boolean; blue: boolean; star: boolean; led: boolean }, e: { serialEven: boolean; parallel: boolean; batteries: number }): boolean {
  const key = `${w.red ? 'R' : ''}${w.blue ? 'B' : ''}${w.star ? 'S' : ''}${w.led ? 'L' : ''}`;
  const table: Record<string, string> = {
    '': 'C', R: 'S', B: 'S', S: 'C', L: 'D', RB: 'S', RS: 'C', RL: 'B', BS: 'D', BL: 'P', SL: 'B',
    RBS: 'P', RBL: 'S', RSL: 'B', BSL: 'P', RBSL: 'D',
  };
  const letter = table[key];
  if (letter === 'C') return true;
  if (letter === 'D') return false;
  if (letter === 'S') return e.serialEven;
  if (letter === 'P') return e.parallel;
  return e.batteries >= 2;
}

const SEQ: Record<string, string[]> = {
  red: ['C', 'B', 'A', 'AC', 'B', 'AC', 'ABC', 'AB', 'B'],
  blue: ['B', 'AC', 'B', 'A', 'B', 'BC', 'C', 'AC', 'A'],
  black: ['ABC', 'AC', 'B', 'AC', 'B', 'BC', 'AB', 'C', 'C'],
};
/** Wire sequence: panels of {from, color, to}; returns cut flags per panel. */
export function wireSequence(panels: { from: number; color: 'red' | 'blue' | 'black'; to: 'A' | 'B' | 'C' }[][]): boolean[][] {
  const seen: Record<string, number> = { red: 0, blue: 0, black: 0 };
  return panels.map((p) =>
    p
      .slice()
      .sort((a, b) => a.from - b.from)
      .map((w) => SEQ[w.color][seen[w.color]++].includes(w.to)),
  );
}

/** Shortest route (U/D/L/R) in the maze with this circle, or null. */
export function maze(circle: [number, number], from: [number, number], to: [number, number]): string[] | null {
  const idx = MAZES.findIndex((art) => parseMaze(art).circles.some(([c, r]) => c === circle[0] && r === circle[1]));
  if (idx < 0) return null;
  const { exits } = parseMaze(MAZES[idx]);
  const key = (p: [number, number]) => `${p[0]},${p[1]}`;
  const step: Record<string, [number, number]> = { U: [0, -1], D: [0, 1], L: [-1, 0], R: [1, 0] };
  const prev = new Map<string, [string, string] | null>([[key(from), null]]);
  const q: [number, number][] = [from];
  while (q.length) {
    const cur = q.shift()!;
    if (key(cur) === key(to)) break;
    for (const d of exits[key(cur)]) {
      const nxt: [number, number] = [cur[0] + step[d][0], cur[1] + step[d][1]];
      if (prev.has(key(nxt))) continue;
      prev.set(key(nxt), [key(cur), d]);
      q.push(nxt);
    }
  }
  if (!prev.has(key(to))) return null;
  const path: string[] = [];
  let k = key(to);
  while (prev.get(k)) {
    const [p, d] = prev.get(k)!;
    path.unshift(d);
    k = p;
  }
  return path;
}

export function mazeIndexFor(circle: [number, number]): number {
  return MAZES.findIndex((art) => parseMaze(art).circles.some(([c, r]) => c === circle[0] && r === circle[1])) + 1;
}

/** Passwords: letters available per slot (1-5); returns the matching words. */
export function password(slots: string[][]): string[] {
  return PASSWORD_WORDS.filter((w) => slots.every((letters, i) => !letters.length || letters.includes(w[i])));
}
