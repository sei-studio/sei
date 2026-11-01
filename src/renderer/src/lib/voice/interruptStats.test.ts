import { describe, expect, it } from 'vitest';
import { createInterruptStats } from './interruptStats';
import { callInterruptProps, zeroInterruptCounts } from '@shared/callInterrupts';

describe('interruptStats', () => {
  it('reports each companion the counts since it joined', () => {
    const s = createInterruptStats();
    s.join('a');
    s.note('ducks');
    s.note('echo_rejected');
    s.join('b');
    s.note('ducks');
    s.note('cuts');
    s.note('manual');
    s.note('no_voice');
    expect(s.take('a')).toEqual({ ducks: 2, cuts: 1, echo_rejected: 1, manual: 1, no_voice: 1, no_word: 0 });
    expect(s.take('b')).toEqual({ ducks: 1, cuts: 1, echo_rejected: 0, manual: 1, no_voice: 1, no_word: 0 });
  });

  it('take forgets the baseline, and a companion that never joined counts from reset', () => {
    const s = createInterruptStats();
    s.note('manual');
    s.join('a');
    s.note('manual');
    expect(s.take('a').manual).toBe(1);
    expect(s.take('a').manual).toBe(2);
    expect(s.take('never').manual).toBe(2);
  });

  it('reset starts a fresh call', () => {
    const s = createInterruptStats();
    s.join('a');
    s.note('cuts');
    s.reset();
    s.join('a');
    expect(s.take('a')).toEqual(zeroInterruptCounts());
  });

  it('maps to prefixed event props', () => {
    expect(callInterruptProps({ ducks: 3, cuts: 1, echo_rejected: 2, manual: 4, no_voice: 5, no_word: 6 })).toEqual({
      interrupt_ducks: 3,
      interrupt_cuts: 1,
      interrupt_echo_rejected: 2,
      interrupt_manual: 4,
      interrupt_no_voice: 5,
      interrupt_no_word: 6,
    });
  });
});
