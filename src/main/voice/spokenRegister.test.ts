import { describe, it, expect } from 'vitest';
import { toSpokenRegister, toSpokenUtterance } from './spokenRegister';

describe('toSpokenRegister', () => {
  it('expands chat shorthand into speakable words', () => {
    expect(toSpokenRegister('you got a world open rn or')).toBe('you got a world open right now or');
    expect(toSpokenRegister('you just told me your name like five seconds ago lmao')).toBe(
      'you just told me your name like five seconds ago haha',
    );
    expect(toSpokenRegister("idk tbh, brb")).toBe("I don't know to be honest, be right back");
  });

  it('is case-insensitive and word-bounded', () => {
    expect(toSpokenRegister('LMAO ok')).toBe('haha ok');
    // "rn" inside words must not expand (burn, corner).
    expect(toSpokenRegister('watch me burn this corner')).toBe('watch me burn this corner');
    // "lol" inside a word must not expand.
    expect(toSpokenRegister('lollipop time')).toBe('lollipop time');
  });

  it('tidies whitespace after dropped tokens', () => {
    expect(toSpokenRegister('smh ok fine')).toBe('ok fine');
    expect(toSpokenRegister('ok smh, fine')).toBe('ok, fine');
  });

  it('leaves normal prose untouched', () => {
    const line = "yo what's good, want me to grab some iron?";
    expect(toSpokenRegister(line)).toBe(line);
  });
});

/**
 * 260729: the other half of the synthesis boundary. The texting register the
 * companion writes in ("no period at the end of a sentence", plus the trailing
 * period splitReply used to strip) is prosody to ElevenLabs, not formality: a
 * clip whose text ends on a letter is read with CONTINUATION contour, so a
 * finished statement landed with no terminal pitch fall and a lowercase opening
 * gave the first word nothing marking it as the start of an utterance.
 */
describe('toSpokenUtterance', () => {
  it('restores the terminal full stop and the sentence capital', () => {
    expect(toSpokenUtterance('i grabbed the iron already', 'en')).toBe('I grabbed the iron already.');
  });

  it('leaves punctuation the writer chose alone', () => {
    expect(toSpokenUtterance('You nearby?', 'en')).toBe('You nearby?');
    expect(toSpokenUtterance('WATCH THIS!', 'en')).toBe('WATCH THIS!');
    // An ellipsis is a trail-off, already terminal.
    expect(toSpokenUtterance('hm...', 'en')).toBe('Hm...');
    // A terminal mark inside closing quotes still counts as terminal.
    expect(toSpokenUtterance('she said "no way!"', 'en')).toBe('She said "no way!"');
  });

  it('does NOT append a stop after a deliberate hand-off', () => {
    // A trailing comma / colon / dash is the writer pausing mid-thought; a full
    // stop after one reads as a stumble.
    expect(toSpokenUtterance('wait,', 'en')).toBe('Wait,');
    expect(toSpokenUtterance('two things:', 'en')).toBe('Two things:');
  });

  it('capitalizes a second sentence inside the same clip', () => {
    // The blocking reply path can bubble two sentences into one clip.
    expect(toSpokenUtterance('ok. that worked', 'en')).toBe('Ok. That worked.');
  });

  it('looks past leading punctuation for the letter to capitalize', () => {
    expect(toSpokenUtterance('"fine," she said', 'en')).toBe('"Fine," she said.');
    // Inside an asterisk action too: it is still the clip's first letter, and
    // flash reads the whole thing aloud either way.
    expect(toSpokenUtterance('*laughs* yeah', 'en')).toBe('*Laughs* yeah.');
  });

  it('writes the ideographic full stop for zh/ja and a period for ko', () => {
    expect(toSpokenUtterance('我们去挖矿吧', 'zh')).toBe('我们去挖矿吧。');
    expect(toSpokenUtterance('鉄はもう集めたよ', 'ja')).toBe('鉄はもう集めたよ。');
    expect(toSpokenUtterance('철은 벌써 모았어', 'ko')).toBe('철은 벌써 모았어.');
    // Already terminated: no second mark.
    expect(toSpokenUtterance('今天想干嘛？', 'zh')).toBe('今天想干嘛？');
  });

  it('is a no-op on empty text', () => {
    expect(toSpokenUtterance('   ', 'en')).toBe('');
  });
});
