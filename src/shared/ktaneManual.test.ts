/**
 * KTANE compact manual (261115): the data the expert companion answers from.
 * A typo here is a wrong instruction on a live bomb, so the tables are checked
 * for shape and against facts of the published manual, and the rendered
 * manual is held to a size budget (it rides every turn's cached prompt).
 */
import { describe, expect, it } from 'vitest';
import {
  KEYPAD_COLUMNS,
  KEYPAD_SYMBOLS,
  MAZES,
  MORSE,
  MORSE_WORDS,
  PASSWORD_WORDS,
  WOF_STEP1,
  WOF_STEP2,
  parseMaze,
  renderKtaneManual,
} from './ktaneManual';

const OPPOSITE: Record<string, [string, number, number]> = { U: ['D', 0, -1], D: ['U', 0, 1], L: ['R', -1, 0], R: ['L', 1, 0] };

describe('mazes', () => {
  // The two circle squares of each maze in the published manual, (column,row).
  const CIRCLES: [number, number][][] = [
    [[1, 2], [6, 3]],
    [[5, 2], [2, 4]],
    [[4, 4], [6, 4]],
    [[1, 1], [1, 4]],
    [[5, 3], [4, 6]],
    [[5, 1], [3, 5]],
    [[2, 1], [2, 6]],
    [[4, 1], [3, 4]],
    [[3, 2], [1, 5]],
  ];

  it('has nine mazes with the manual circles', () => {
    expect(MAZES).toHaveLength(9);
    MAZES.forEach((art, i) => {
      const got = parseMaze(art).circles.map(([c, r]) => `${c},${r}`).sort();
      expect(got, `maze ${i + 1}`).toEqual(CIRCLES[i].map(([c, r]) => `${c},${r}`).sort());
    });
  });

  it('every open move is open from both sides and every square is reachable', () => {
    MAZES.forEach((art, i) => {
      const { exits } = parseMaze(art);
      expect(Object.keys(exits), `maze ${i + 1}`).toHaveLength(36);
      for (const [key, dirs] of Object.entries(exits)) {
        const [c, r] = key.split(',').map(Number);
        for (const d of dirs) {
          const [back, dc, dr] = OPPOSITE[d];
          expect(exits[`${c + dc},${r + dr}`], `maze ${i + 1} ${key} ${d}`).toContain(back);
        }
      }
      const seen = new Set(['1,1']);
      const queue = ['1,1'];
      while (queue.length) {
        const key = queue.shift()!;
        const [c, r] = key.split(',').map(Number);
        for (const d of exits[key]) {
          const [, dc, dr] = OPPOSITE[d];
          const next = `${c + dc},${r + dr}`;
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
      expect(seen.size, `maze ${i + 1} connected`).toBe(36);
    });
  });
});

describe('keypad', () => {
  it('six columns of seven distinct known symbols, every symbol used', () => {
    expect(KEYPAD_COLUMNS).toHaveLength(6);
    const used = new Set<string>();
    for (const col of KEYPAD_COLUMNS) {
      expect(col).toHaveLength(7);
      expect(new Set(col).size).toBe(7);
      for (const id of col) {
        expect(KEYPAD_SYMBOLS[id], id).toBeDefined();
        used.add(id);
      }
    }
    expect([...used].sort()).toEqual(Object.keys(KEYPAD_SYMBOLS).sort());
    expect(used.size).toBe(27);
  });
});

describe("who's on first", () => {
  it('step 1 covers the 28 display words', () => {
    expect(Object.keys(WOF_STEP1)).toHaveLength(28);
    const positions = new Set(['top left', 'top right', 'middle left', 'middle right', 'bottom left', 'bottom right']);
    for (const pos of Object.values(WOF_STEP1)) expect(positions.has(pos), pos).toBe(true);
  });

  it('step 2 lists are permutations of their 14-word group', () => {
    const labels = Object.keys(WOF_STEP2);
    expect(labels).toHaveLength(28);
    for (const [label, list] of Object.entries(WOF_STEP2)) {
      expect(list, label).toHaveLength(14);
      expect(new Set(list).size, label).toBe(14);
      expect(list, label).toContain(label);
      // Every word in the list is a label with its own list in the same group.
      const group = new Set(WOF_STEP2[list[0]]);
      for (const w of list) expect(group.has(w), `${label}: ${w}`).toBe(true);
    }
  });
});

describe('morse and passwords', () => {
  it('sixteen words with rising frequencies 3.505 to 3.600', () => {
    expect(MORSE_WORDS).toHaveLength(16);
    const freqs = MORSE_WORDS.map(([, f]) => Number(f));
    expect(freqs[0]).toBe(3.505);
    expect(freqs.at(-1)).toBe(3.6);
    for (let i = 1; i < freqs.length; i++) expect(freqs[i]).toBeGreaterThan(freqs[i - 1]);
    for (const [w] of MORSE_WORDS) for (const ch of w.toUpperCase()) expect(MORSE[ch], ch).toBeDefined();
  });

  it('35 distinct five-letter passwords', () => {
    expect(PASSWORD_WORDS).toHaveLength(35);
    expect(new Set(PASSWORD_WORDS).size).toBe(35);
    for (const w of PASSWORD_WORDS) expect(w).toMatch(/^[a-z]{5}$/);
  });
});

describe('renderKtaneManual', () => {
  it('covers every vanilla module within the prompt budget', () => {
    const m = renderKtaneManual();
    for (const head of ['## Wires', '## The Button', '## Keypads', '## Simon Says', "## Who's on First", '## Memory', '## Morse Code', '## Complicated Wires', '## Wire Sequences', '## Mazes', '## Passwords', '## Needy modules', '## The bomb casing']) {
      expect(m, head).toContain(head);
    }
    expect(m.length).toBeLessThan(24_000);
    expect(m).not.toContain('—');
  });
});
