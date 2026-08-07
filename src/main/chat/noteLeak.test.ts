import { describe, it, expect } from 'vitest';
import { isNoteLeak } from './noteLeak';

/**
 * Pinned against the 260807 live leak (Marv, backseat): both leaked lines are
 * here verbatim. The asymmetry between the two tiers is the load-bearing part:
 * "character note" drops always, "remember ..." drops only when a remember()
 * call rode the turn AND the next word is not addressed to the player.
 */
describe('isNoteLeak', () => {
  it('drops the live "character note" leak, tool call or not', () => {
    const leak =
      "character note: sei's curious, wants me to narrate what i'm watching " +
      "instead of asking me. i'll stay in character but actually look at what's happening.";
    expect(isNoteLeak(leak, true)).toBe(true);
    expect(isNoteLeak(leak, false)).toBe(true);
  });

  it('drops the live "remember ..." leak when a remember call rode the turn', () => {
    const leak =
      "remember sei's into watching other people play instead of playing himself. " +
      "he's patient, content to sit with someone else's gameplay.";
    expect(isNoteLeak(leak, true)).toBe(true);
  });

  it('never fires the remember tier without the tool call', () => {
    // A streamed sentence may be emitted before the tool_use arrives, so the
    // caller passes false there and only the note tier applies.
    expect(isNoteLeak("remember sei's into watching other people play", false)).toBe(false);
  });

  it('keeps remember-lines that are speech to the player, even with the call', () => {
    for (const line of [
      'remember when we built that tower?',
      'remember, you gotta water those before night',
      'remember to check the mail thing you flagged',
      'remember that time you fell in the lava',
      "remember you're the one who picked this game",
    ]) {
      expect(isNoteLeak(line, true)).toBe(false);
    }
  });

  it('drops third-person notes about a person while filing a memory', () => {
    expect(isNoteLeak("remember he's patient, content to just watch", true)).toBe(true);
  });

  it('covers the note-opener family and leading quotes/parens', () => {
    expect(isNoteLeak('note to self: ask about the farm later', false)).toBe(true);
    expect(isNoteLeak('(internal note: keep this short)', false)).toBe(true);
    expect(isNoteLeak('mental note, he hates jump scares', false)).toBe(true);
  });

  it('keeps ordinary lines untouched', () => {
    for (const line of [
      "they're just walking around the farm. nothing's happening.",
      'okay that was actually sick',
      'what are you looking at stardew valley for.',
      'noted, no more spoilers from me',
      '', // blank parts are not leaks
    ]) {
      expect(isNoteLeak(line, true)).toBe(false);
    }
  });
});
