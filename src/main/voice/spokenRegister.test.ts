import { describe, it, expect } from 'vitest';
import { toSpokenRegister } from './spokenRegister';

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
