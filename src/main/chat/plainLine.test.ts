import { describe, expect, it } from 'vitest';
import { plainLine } from './plainLine';

describe('plainLine', () => {
  // The live capture that prompted it.
  it('drops bold around a guess', () => {
    expect(plainLine('looking at that little circle... is it a **hearing aid**?')).toBe(
      'looking at that little circle... is it a hearing aid?',
    );
  });

  it('drops italics and stage directions', () => {
    expect(plainLine('*squints* is that a boat')).toBe('squints is that a boat');
    expect(plainLine('that is _definitely_ a horse')).toBe('that is definitely a horse');
  });

  it('drops code ticks and headers and bullets', () => {
    expect(plainLine('`pirate`?')).toBe('pirate?');
    expect(plainLine('## my guess')).toBe('my guess');
    expect(plainLine('- a kettle')).toBe('a kettle');
  });

  it('leaves ordinary punctuation, brackets and dashes alone', () => {
    expect(plainLine('(silence)')).toBe('(silence)');
    expect(plainLine('wait - is that a hat?')).toBe('wait - is that a hat?');
    expect(plainLine('hmm... no idea')).toBe('hmm... no idea');
  });

  it('leaves an underscore inside a word alone', () => {
    expect(plainLine('my file is draw_service')).toBe('my file is draw_service');
  });
});
