/** 261104: DST lives counters for bot_session_ended. */
import { describe, it, expect } from 'vitest';
import { createDstLivesReporter } from './sessionLives';

describe('createDstLivesReporter', () => {
  it('keeps the newest valid report per character and hands it over once', () => {
    const r = createDstLivesReporter();
    r.note('c1', { type: 'dst-lives', respawns: 0, deaths: 1, lastDeathCause: 'darkness' });
    r.note('c1', { type: 'dst-lives', respawns: 1, deaths: 1, lastDeathCause: 'darkness' });
    expect(r.take('c1')).toEqual({ respawns: 1, deaths: 1, last_death_cause: 'darkness' });
    expect(r.take('c1')).toEqual({ respawns: 0, deaths: 0 });
  });

  it('drops anything that is not shape (a player name as the cause, bad numbers)', () => {
    const r = createDstLivesReporter();
    r.note('c1', { type: 'dst-lives', respawns: 1, deaths: 2, lastDeathCause: 'Steve the Player' });
    r.note('c1', { type: 'dst-lives', respawns: -1, deaths: 2 });
    r.note('c1', { type: 'other' });
    expect(r.take('c1')).toEqual({ respawns: 0, deaths: 0 });
    r.note('c2', { type: 'dst-lives', respawns: 0, deaths: 0, lastDeathCause: null });
    expect(r.take('c2')).toEqual({ respawns: 0, deaths: 0 });
  });
});
