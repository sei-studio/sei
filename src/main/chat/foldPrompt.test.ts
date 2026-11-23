/**
 * foldPrompt.ts (260810) — the pure fold-prompt module.
 *
 * Pins the <summary> tag backstop (a stray preamble must never be stored as
 * summary text; missing tags degrade to the old whole-text behavior) and the
 * transcript formatting the fold and the offline eval share.
 */
import { describe, it, expect } from 'vitest';
import {
  buildFoldCalendar,
  buildFoldSystem,
  buildFoldTranscript,
  buildFoldUserText,
  extractRememberTag,
  extractSummaryTag,
  isNothingFact,
} from './foldPrompt';

describe('extractSummaryTag', () => {
  it('strips a preamble outside the tags (the measured Sonnet failure)', () => {
    const raw =
      'This batch is mostly screen narration, so I kept the durable facts.\n\n' +
      '<summary>Ouen is my player. He went to LA (11 Jul).</summary>';
    expect(extractSummaryTag(raw)).toBe('Ouen is my player. He went to LA (11 Jul).');
  });

  it('strips trailing commentary after the closing tag', () => {
    const raw = '<summary>The summary.</summary>\n\nI left the rest out because it was noise.';
    expect(extractSummaryTag(raw)).toBe('The summary.');
  });

  it('falls back to the whole trimmed text when tags are missing (old behavior)', () => {
    expect(extractSummaryTag('  Just the summary text.  ')).toBe('Just the summary text.');
  });

  it('keeps multi-paragraph content inside the tags intact', () => {
    const inner = 'Para one.\n\nPara two with detail.';
    expect(extractSummaryTag(`<summary>\n${inner}\n</summary>`)).toBe(inner);
  });

  it('an empty tag body extracts to empty (treated upstream as a failed fold)', () => {
    expect(extractSummaryTag('<summary>   </summary>')).toBe('');
  });
});

describe('buildFoldSystem', () => {
  it('carries the tag contract and the low-signal instruction, without quoting noise lines', () => {
    const sys = buildFoldSystem();
    expect(sys).toContain('<summary>');
    expect(sys).toContain('low-signal');
    // The noise is described in prose by shape; no BAD/GOOD example dialogue
    // (quoting a phrase inside a ban feeds it — measured on this project).
    expect(sys).not.toMatch(/BAD:|GOOD:/);
  });

  it('appends the persona block only when a persona is given', () => {
    expect(buildFoldSystem()).not.toContain('persona');
    expect(buildFoldSystem('  the persona text  ')).toContain('the persona text');
  });
});

describe('buildFoldTranscript', () => {
  it('renders roles and weekday stamps', () => {
    const out = buildFoldTranscript([
      { role: 'user', text: 'hi', ts: new Date(2026, 6, 3, 10, 34).getTime() },
      { role: 'companion', text: 'hey' },
    ]);
    const lines = out.split('\n');
    expect(lines[0]).toBe('Player (Fri 3 Jul 10:34): hi');
    expect(lines[1]).toBe('You: hey');
  });

  it("labels another companion's heard line with that companion's name (group calls)", () => {
    const out = buildFoldTranscript([
      { role: 'user', text: '(Marv, on the call): i hate spiders', ts: new Date(2026, 9, 16, 18, 20).getTime() },
      { role: 'user', text: 'same honestly' },
    ]);
    expect(out.split('\n')).toEqual(['Marv (Fri 16 Oct 18:20): i hate spiders', 'Player: same honestly']);
  });
});

describe('buildFoldCalendar / buildFoldUserText', () => {
  it('lists the days from the batch through two weeks after it, with weekdays', () => {
    const cal = buildFoldCalendar([
      { role: 'user', text: 'a', ts: new Date(2026, 9, 24, 16, 45).getTime() },
      { role: 'user', text: 'b', ts: new Date(2026, 9, 24, 17, 5).getTime() },
    ]);
    expect(cal.startsWith('Calendar for working out dates: Sat 24 Oct, Sun 25 Oct,')).toBe(true);
    expect(cal).toContain('Thu 29 Oct');
    expect(cal).toContain('Sat 31 Oct, Sun 1 Nov');
    expect(cal.endsWith('Sat 7 Nov.')).toBe(true);
  });

  it('starts at most a week before the last message on a long batch', () => {
    const cal = buildFoldCalendar([
      { role: 'user', text: 'a', ts: new Date(2026, 8, 1, 9, 0).getTime() },
      { role: 'user', text: 'b', ts: new Date(2026, 9, 24, 9, 0).getTime() },
    ]);
    expect(cal.startsWith('Calendar for working out dates: Sat 17 Oct,')).toBe(true);
  });

  it('is empty without stamps, and the user text then matches the old shape', () => {
    expect(buildFoldCalendar([{ role: 'user', text: 'a' }])).toBe('');
    expect(buildFoldUserText('', [{ role: 'user', text: 'a' }])).toBe('Existing summary:\n(none yet)\n\nNew messages:\nPlayer: a');
  });
});

// 261123 (review): a <remember> block that only says "nothing" saves nothing.
describe('nothing-lines in the fold facts', () => {
  it('drops None, (none), "Nothing new to add." and too-short lines', () => {
    expect(extractRememberTag('<summary>s</summary><remember>None</remember>')).toEqual([]);
    expect(extractRememberTag('<remember>\n(none)\n</remember>')).toEqual([]);
    expect(extractRememberTag('<remember>\n- Nothing new to add.\n- No new facts this time.\n- n/a\n- ok\n</remember>')).toEqual([]);
    expect(extractRememberTag('<remember>没有</remember>')).toEqual([]);
  });

  it('keeps real facts, including one that starts with "nothing" or "no"', () => {
    expect(
      extractRememberTag(
        '<remember>\n- None\n- Alex has a dog named Pepper\n- Nothing scares Alex more than spiders\n- No sushi for Alex anymore, ramen now\n</remember>',
      ),
    ).toEqual(['Alex has a dog named Pepper', 'Nothing scares Alex more than spiders', 'No sushi for Alex anymore, ramen now']);
  });

  it('isNothingFact on its own', () => {
    for (const l of ['None', 'none.', '**Nothing**', 'nothing new', 'Nothing worth saving from this session.', 'N/A', 'no', 'Jo']) {
      expect(isNothingFact(l)).toBe(true);
    }
    for (const l of ['Alex works at the city library now', 'No longer at the bakery: Alex works at the library']) {
      expect(isNothingFact(l)).toBe(false);
    }
  });
});
