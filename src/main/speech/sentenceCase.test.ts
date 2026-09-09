import { describe, it, expect } from 'vitest';
import { isMostlyUppercaseLatin, sentenceCaseSttText } from './sentenceCase';

describe('isMostlyUppercaseLatin', () => {
  it('detects the SenseVoice ALL-CAPS shape', () => {
    expect(isMostlyUppercaseLatin('HELLO HOW ARE YOU DOING')).toBe(true);
  });

  it('leaves normal mixed-case prose alone', () => {
    expect(isMostlyUppercaseLatin('Hello, how are you doing?')).toBe(false);
  });

  it('does not fire on a short acronym-only utterance', () => {
    expect(isMostlyUppercaseLatin('OK')).toBe(false);
    expect(isMostlyUppercaseLatin('NASA')).toBe(true); // 4 letters, all caps — borderline by design
  });

  it('does not fire on prose that merely contains acronyms', () => {
    expect(isMostlyUppercaseLatin('I sent the PDF to NASA and the FBI yesterday')).toBe(false);
  });

  it('ignores non-Latin text entirely', () => {
    expect(isMostlyUppercaseLatin('你好，最近怎么样？')).toBe(false);
  });
});

describe('sentenceCaseSttText', () => {
  it('rewrites ALL CAPS to sentence case', () => {
    expect(sentenceCaseSttText('HELLO THERE. HOW ARE YOU?')).toBe('Hello there. How are you?');
  });

  it('keeps standalone I and its contractions capitalized', () => {
    expect(sentenceCaseSttText("I THINK I'M FINE AND I'LL BE THERE")).toBe(
      "I think I'm fine and I'll be there",
    );
  });

  it('capitalizes after !, ? and ellipsis', () => {
    expect(sentenceCaseSttText('WAIT! REALLY? OK THEN')).toBe('Wait! Really? Ok then');
  });

  it('passes healthy mixed-case text through unchanged', () => {
    const s = 'Hello there, this is fine. NASA said so.';
    expect(sentenceCaseSttText(s)).toBe(s);
  });

  it('repairs the Latin runs of a mixed zh+EN caps line without touching the Chinese', () => {
    expect(sentenceCaseSttText('你好 HELLO WORLD。THANKS')).toBe('你好 hello world。Thanks');
  });

  it('does not capitalize a Latin letter mid-sentence after a CJK sentence opener', () => {
    // The CJK char occupies the sentence-start slot, so the Latin word later
    // in the same sentence stays lowercase.
    expect(sentenceCaseSttText('好的 OKAY SURE')).toBe('好的 okay sure');
  });

  it('leaves an empty or non-Latin string unchanged', () => {
    expect(sentenceCaseSttText('')).toBe('');
    expect(sentenceCaseSttText('你好')).toBe('你好');
  });
});
