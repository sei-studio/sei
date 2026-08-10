/**
 * foldPrompt.ts (260810) — the pure fold-prompt module.
 *
 * Pins the <summary> tag backstop (a stray preamble must never be stored as
 * summary text; missing tags degrade to the old whole-text behavior) and the
 * transcript formatting the fold and the offline eval share.
 */
import { describe, it, expect } from 'vitest';
import { buildFoldSystem, buildFoldTranscript, extractSummaryTag } from './foldPrompt';

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
  it('renders roles and stamps the way the fold always has', () => {
    const out = buildFoldTranscript([
      { role: 'user', text: 'hi', ts: Date.UTC(2026, 6, 3, 10, 34) },
      { role: 'companion', text: 'hey' },
    ]);
    const lines = out.split('\n');
    expect(lines[0]).toMatch(/^Player \(3 Jul \d{2}:\d{2}\): hi$/);
    expect(lines[1]).toBe('You: hey');
  });
});
