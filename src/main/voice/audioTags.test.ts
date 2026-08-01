import { describe, it, expect } from 'vitest';
import { stripAudioTags, audioTagDirective, AUDIO_TAGS, SUPPORTS_AUDIO_TAGS } from './audioTags';

describe('stripAudioTags', () => {
  it('removes a tag and the gap it leaves', () => {
    expect(stripAudioTags('[laughs] that is actually pretty good')).toBe('that is actually pretty good');
    expect(stripAudioTags('that is actually pretty good [laughs]')).toBe('that is actually pretty good');
    expect(stripAudioTags('wait [sighs] no, hang on')).toBe('wait no, hang on');
  });

  it('does not leave a space before punctuation', () => {
    expect(stripAudioTags('oh really [gasps]?')).toBe('oh really?');
  });

  it('removes invented tags too, which is the whole point', () => {
    // A model handed a list still invents entries, and an invented tag is read
    // aloud by every model. Shape, not membership, is what qualifies.
    expect(stripAudioTags('[leans in] so what is the move')).toBe('so what is the move');
    expect(stripAudioTags('[flibberflop] hey', true)).toBe('hey');
  });

  it('keeps known tags only when the model can perform them', () => {
    expect(stripAudioTags('[laughs] hey', true)).toBe('[laughs] hey');
    expect(stripAudioTags('[laughs] hey', false)).toBe('hey');
  });

  it('leaves bracketed prose alone', () => {
    // Four words, digits, or real punctuation mean the model bracketed
    // CONTENT; deleting that would lose what it said.
    expect(stripAudioTags('the answer is [three of the four]')).toBe('the answer is [three of the four]');
    expect(stripAudioTags('press [F3] for coords')).toBe('press [F3] for coords');
    expect(stripAudioTags('[wait, what?] is what I said')).toBe('[wait, what?] is what I said');
  });

  it('collapses to empty when the line was only a tag', () => {
    // splitReply drops the empty part; a reply that was nothing else falls back
    // to its own placeholder rather than emitting a blank bubble.
    expect(stripAudioTags('[laughs]')).toBe('');
  });

  it('handles a null-ish line without throwing', () => {
    expect(stripAudioTags(undefined as unknown as string)).toBe('');
  });

  it('leaves the silence sentinel for the detector that owns it', () => {
    // These are tag-shaped, so stripping emptied them — which did not silence
    // the turn, it produced a "…" bubble, because the filler drop downstream
    // then had nothing to match on.
    expect(stripAudioTags('[silence]')).toBe('[silence]');
    expect(stripAudioTags('[says nothing]')).toBe('[says nothing]');
    expect(stripAudioTags('[staying quiet, it landed]')).toBe('[staying quiet, it landed]');
  });
});

describe('audioTagDirective', () => {
  it('says nothing while the shipped model cannot perform tags', () => {
    // Measured: eleven_flash_v2_5 reads `[laughs]` aloud as a word. Offering
    // the vocabulary would put that in the character's mouth. See audioTags.ts.
    expect(SUPPORTS_AUDIO_TAGS).toBe(false);
    expect(audioTagDirective()).toBe('');
  });

  it('keeps the vocabulary closed and bracket-shaped', () => {
    // The strip qualifies tags by SHAPE (1-3 plain words), so a vocabulary
    // entry that could not survive its own regex would be stripped when kept.
    for (const tag of AUDIO_TAGS) {
      expect(tag).toMatch(/^[a-z]+( [a-z]+){0,2}$/);
      expect(stripAudioTags(`[${tag}] hi`, true)).toBe(`[${tag}] hi`);
    }
  });
});
