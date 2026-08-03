/**
 * The word gate that decides a barge-in (260804).
 *
 * This is the whole difference between the old barge-in and the new one. The
 * old one asked "was that loud enough for long enough", which cannot tell a
 * cough from a word, so it had to be set stiff and interrupting took shouting.
 * The new one ducks on almost anything and then asks THIS: was it speech?
 *
 * Everything below runs on roughly 400 ms of audio, which is where every STT
 * engine is at its most inventive, so the bar is deliberately higher than the
 * junk filter applied to finished utterances. A false positive here cuts off a
 * line that was doing nothing wrong.
 */

import { describe, it, expect } from 'vitest';
import { hasSpokenWord } from './dictation';

describe('hasSpokenWord', () => {
  it('accepts the short words people actually interrupt with', () => {
    // These are the whole point: one syllable, fired at the companion
    // mid-sentence, and every one of them has to land.
    for (const w of ['wait', 'no', 'stop', 'hey', 'what', 'ok', 'huh']) {
      expect(hasSpokenWord(w), w).toBe(true);
    }
  });

  it('accepts anything of two words or more', () => {
    expect(hasSpokenWord('hold on')).toBe(true);
    expect(hasSpokenWord('I was going to')).toBe(true);
  });

  it('rejects an empty or punctuation-only pass', () => {
    // Whisper on a fragment of silence returns these constantly.
    for (const t of ['', '   ', '.', '...', '-', '!?']) {
      expect(hasSpokenWord(t), JSON.stringify(t)).toBe(false);
    }
  });

  it('rejects the bracketed markers engines emit for non-speech', () => {
    expect(hasSpokenWord('[BLANK_AUDIO]')).toBe(false);
    expect(hasSpokenWord('[silence]')).toBe(false);
    expect(hasSpokenWord('(music)')).toBe(false);
  });

  it('rejects a repeated letter, which is breath rather than a word', () => {
    expect(hasSpokenWord('hhhhh')).toBe(false);
    expect(hasSpokenWord('mmmm')).toBe(false);
    expect(hasSpokenWord('AAAA')).toBe(false);
  });

  it('rejects the bare filler words a noise fragment decodes to', () => {
    // "you" is Whisper's single most common output for a fragment of noise, and
    // it is a real word, so it cannot be caught by any general rule — it is
    // named. Alone it is almost never a real interruption; in a phrase it is.
    expect(hasSpokenWord('you')).toBe(false);
    expect(hasSpokenWord('the')).toBe(false);
    expect(hasSpokenWord('you there')).toBe(true);
  });

  it('accepts non-Latin speech, which the whole feature depends on', () => {
    // The energy path never cared about language and neither can this: a
    // Chinese or Japanese interruption must cut her off exactly the same way.
    expect(hasSpokenWord('等等')).toBe(true);
    expect(hasSpokenWord('ちょっと')).toBe(true);
  });

  it('ignores surrounding punctuation and case', () => {
    expect(hasSpokenWord('  Wait! ')).toBe(true);
    expect(hasSpokenWord('"no."')).toBe(true);
  });
});
