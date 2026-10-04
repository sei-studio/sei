/**
 * LineTyper (261004): a companion line is never cut off. Driven with fake
 * timers (Date included), no DOM needed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HOLD_MS, LineTyper, TYPE_MS, typingMs, type TyperFrame } from './lineTyper';

function rig(reduced = false) {
  const frames: TyperFrame[] = [];
  const typed: Array<{ line: string; at: number }> = [];
  const ty = new LineTyper({
    reduced,
    onFrame: (f) => frames.push(f),
    onTyped: (line) => typed.push({ line, at: Date.now() }),
  });
  const shown = (): TyperFrame => frames[frames.length - 1];
  return { ty, frames, typed, shown };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

describe('LineTyper', () => {
  it('types a line out in typingMs, an emoji counting as one step', () => {
    const { ty, typed, shown } = rig();
    const line = 'Ooh, 🏡! Go.';
    ty.say(line);
    vi.advanceTimersByTime(typingMs(line) - TYPE_MS);
    expect(shown().n).toBeLessThan(Array.from(line).length);
    expect(typed).toEqual([]);
    vi.advanceTimersByTime(TYPE_MS);
    expect(shown()).toEqual({ line, n: Array.from(line).length });
    expect(typed).toEqual([{ line, at: typingMs(line) }]);
  });

  it('never replaces a line that is still typing; the newest waiting line wins', () => {
    const { ty, frames, typed, shown } = rig();
    ty.say('Hmm, let me look...');
    vi.advanceTimersByTime(100);
    ty.say('Any of these?');
    ty.say("Can't find that one.");
    // Still the first line, still typing.
    expect(shown().line).toBe('Hmm, let me look...');
    vi.advanceTimersByTime(typingMs('Hmm, let me look...') - 100);
    expect(typed.map((t) => t.line)).toEqual(['Hmm, let me look...']);
    // Held whole for HOLD_MS, then the newest line; the superseded one never shows.
    vi.advanceTimersByTime(HOLD_MS - 1);
    expect(shown().line).toBe('Hmm, let me look...');
    vi.advanceTimersByTime(1);
    expect(shown()).toEqual({ line: "Can't find that one.", n: 0 });
    expect(frames.some((f) => f.line === 'Any of these?')).toBe(false);
    // Every line that left the screen had fully typed first.
    for (let i = 1; i < frames.length; i++) {
      if (frames[i].line !== frames[i - 1].line) {
        expect(frames[i - 1].n).toBe(Array.from(frames[i - 1].line).length);
      }
    }
  });

  it('a line said after the last one finished starts after the hold', () => {
    const { ty, shown } = rig();
    ty.say('Hi!');
    vi.advanceTimersByTime(typingMs('Hi!') + 1000);
    ty.say('Bye!');
    expect(shown().line).toBe('Bye!');
  });

  it('reduced motion: each line is whole at once and reports typed', () => {
    const { ty, typed, shown } = rig(true);
    ty.say('What are we playing?');
    expect(shown()).toEqual({ line: 'What are we playing?', n: 20 });
    expect(typed.map((t) => t.line)).toEqual(['What are we playing?']);
  });

  it('dispose stops everything', () => {
    const { ty, typed } = rig();
    ty.say('A long enough line');
    ty.dispose();
    vi.advanceTimersByTime(5000);
    expect(typed).toEqual([]);
  });
});
