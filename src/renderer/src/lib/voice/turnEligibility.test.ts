import { describe, expect, it } from 'vitest';
import { directorMayDrive, idleNudgeEligible, reactorPool } from './turnEligibility';

const summons = { mc: { kind: 'online' }, joining: { kind: 'connecting' }, idle: { kind: 'idle' } };

describe('voice director turn eligibility (261023)', () => {
  it('never drives the companion watching the screen, or one in a game', () => {
    expect(directorMayDrive('sui', summons, 'sui')).toBe(false);
    expect(directorMayDrive('mc', summons, null)).toBe(false);
    expect(directorMayDrive('joining', summons, null)).toBe(false);
    expect(directorMayDrive('idle', summons, null)).toBe(true);
    expect(directorMayDrive('lyra', summons, 'sui')).toBe(true);
  });

  it('the idle starter skips the sharer, so a solo share gets no screenless nudge', () => {
    expect(idleNudgeEligible(['sui'], summons, 'sui')).toEqual([]);
    expect(idleNudgeEligible(['sui', 'lyra', 'mc'], summons, 'sui')).toEqual(['lyra']);
    expect(idleNudgeEligible(['sui', 'lyra'], summons, null)).toEqual(['sui', 'lyra']);
  });

  it('the reactor pool keeps the speaker but never hands the sharer a reaction turn', () => {
    expect(reactorPool(['sui', 'lyra'], 'lyra', summons, 'sui')).toEqual(['lyra']);
    expect(reactorPool(['sui', 'lyra', 'mina'], 'sui', summons, 'sui')).toEqual(['sui', 'lyra', 'mina']);
    expect(reactorPool(['sui', 'lyra', 'mc'], 'lyra', summons, null)).toEqual(['sui', 'lyra']);
  });
});




