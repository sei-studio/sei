import { describe, expect, it } from 'vitest';
import { formatPlayDuration, playSummaryText } from './playSummary';

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
