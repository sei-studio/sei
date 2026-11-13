import { describe, expect, it } from 'vitest';
import { buildPlayRow, formatPlayDuration, PLAY_FALLBACK_LINES, PLAY_RECAP_MAX_CHARS, playStory, playStoryText, playSummaryText } from './playSummary';

describe('formatPlayDuration', () => {
  it('collapses anything under a minute', () => {
    expect(formatPlayDuration(0)).toBe('a few seconds');
    expect(formatPlayDuration(59_999)).toBe('a few seconds');
  });

  it('counts whole minutes up to an hour', () => {
    expect(formatPlayDuration(60_000)).toBe('1 minute');
    expect(formatPlayDuration(300_000)).toBe('5 minutes');
    expect(formatPlayDuration(3_599_999)).toBe('60 minutes');
  });

  it('counts whole hours past that', () => {
    expect(formatPlayDuration(3_600_000)).toBe('1 hour');
    expect(formatPlayDuration(7_200_000)).toBe('2 hours');
  });
});

describe('playSummaryText', () => {
  // 260728 — one sentence for every game surface. Each used to compose its own
  // and report its own results; a scoreline read back days later is the least
  // interesting thing about having played, and four registers for one event
  // made the transcript read like four different games.
  it('is the same sentence whatever the game', () => {
    expect(playSummaryText('Marv', 'Draw!', 420_000)).toBe(
      'You and Marv played Draw! for 7 minutes.',
    );
    expect(playSummaryText('Marv', 'Chess', 420_000)).toBe(
      'You and Marv played Chess for 7 minutes.',
    );
    expect(playSummaryText('Marv', 'Minecraft', 420_000)).toBe(
      'You and Marv played Minecraft for 7 minutes.',
    );
    expect(playSummaryText('Marv', 'Backseat', 420_000)).toBe(
      'You and Marv played Backseat for 7 minutes.',
    );
  });

  it('carries no result, score or detail', () => {
    // Chess rather than Draw! as the sample: "Draw!" is a game NAME here, so a
    // draw/won/lost pattern would match the title and prove nothing.
    const text = playSummaryText('Marv', 'Chess', 420_000);
    expect(text).not.toMatch(/won|lost|drew|ended in|\d+\s*-\s*\d+|move/i);
  });

  it('has no em dash, like all user-facing copy', () => {
    expect(playSummaryText('Marv', 'Chess', 60_000)).not.toContain('—');
  });
});

// 261113 (v0.7 consistency D1): what happened in a game session, on its row.
describe('play story', () => {
  const lines = Array.from({ length: 12 }, (_, i) => ({ who: (i % 2 ? 'you' : 'player') as 'you' | 'player', text: ` line  ${i} ` }));

  it('keeps the recap when there is one, trimmed and capped', () => {
    expect(playStory('  we built a  cabin ', lines)).toEqual({ recap: 'we built a cabin' });
    expect(playStory('x'.repeat(2000), null).recap).toHaveLength(PLAY_RECAP_MAX_CHARS);
  });

  it('falls back to the last digest lines, then to nothing', () => {
    const r = playStory(null, lines);
    expect(r.recap).toBeUndefined();
    expect(r.lines).toHaveLength(PLAY_FALLBACK_LINES);
    expect(r.lines?.[0]).toEqual({ who: 'player', text: 'line 4' });
    expect(playStory('   ', [{ who: 'player', text: '  ' }])).toEqual({});
    expect(playStory(undefined, undefined)).toEqual({});
  });

  it('reads a recap, else the lines on one line, else nothing', () => {
    expect(playStoryText({ recap: 'we tamed Turnip' })).toBe('Your own recap of it afterwards: we tamed Turnip');
    const t = playStoryText({ lines: [{ who: 'player', text: 'bye' }, { who: 'you', text: 'see ya' }, { who: 'other', text: 'hi' }] });
    expect(t).toBe('The last things said in the game: Player: "bye" / You: "see ya" / Another companion: "hi"');
    expect(t).not.toContain('\n');
    expect(playStoryText({})).toBe('');
    expect(playStoryText(undefined)).toBe('');
  });

  it('builds the play row with the sentence and the story', () => {
    const row = buildPlayRow({ name: 'Sui', gameName: 'Minecraft', game: 'minecraft', durationMs: 1_800_000, recap: 'we fished' });
    expect(row).toEqual({
      role: 'system',
      text: 'You and Sui played Minecraft for 30 minutes.',
      event: { kind: 'play', game: 'minecraft', durationMs: 1_800_000, recap: 'we fished' },
    });
    expect(buildPlayRow({ name: 'Sui', gameName: 'Chess', game: 'chess', durationMs: 60_000 }).event).toEqual({ kind: 'play', game: 'chess', durationMs: 60_000 });
  });
});
