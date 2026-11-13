/**
 * playRecap (261113, v0.7 consistency D1): the play row's bounded wait for the
 * session-end recap, and the shape-only analytics of the written row.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { awaitRecap, playRecapProps } from './playRecap';
import type { SessionEndResult } from './playerEndNextStep';

afterEach(() => vi.useRealTimers());

function switches() {
  const fns = new Set<() => void>();
  return {
    onSwitch: (fn: () => void) => {
      fns.add(fn);
      return () => fns.delete(fn);
    },
    fire: () => [...fns].forEach((f) => f()),
    size: () => fns.size,
  };
}

describe('awaitRecap', () => {
  it('resolves with the recap and the outcome', async () => {
    const s = switches();
    const r = await awaitRecap(Promise.resolve<SessionEndResult>({ outcome: 'saved', recap: 'we fished' }), { onSwitch: s.onSwitch, switchPending: () => false });
    expect(r).toEqual({ recap: 'we fished', outcome: 'saved', facts: null });
    expect(s.size()).toBe(0);
  });

  it('stops waiting after waitMs', async () => {
    vi.useFakeTimers();
    const s = switches();
    const p = awaitRecap(new Promise<SessionEndResult>(() => {}), { waitMs: 1000, onSwitch: s.onSwitch, switchPending: () => false });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toEqual({ recap: null, outcome: 'waited_out' });
    expect(s.size()).toBe(0);
  });

  it('stops waiting when an account switch begins, or is already running', async () => {
    const s = switches();
    const p = awaitRecap(new Promise<SessionEndResult>(() => {}), { onSwitch: s.onSwitch, switchPending: () => false });
    s.fire();
    expect(await p).toEqual({ recap: null, outcome: 'scope_switch' });
    const q = await awaitRecap(Promise.resolve<SessionEndResult>({ outcome: 'saved', recap: 'x' }), { onSwitch: s.onSwitch, switchPending: () => true });
    expect(q).toEqual({ recap: null, outcome: 'scope_switch' });
  });

  it('never rejects', async () => {
    const s = switches();
    expect(await awaitRecap(Promise.reject(new Error('x')), { onSwitch: s.onSwitch, switchPending: () => false })).toEqual({ recap: null, outcome: 'error' });
  });
});

describe('playRecapProps', () => {
  it('reports the shape of the row, never its text', () => {
    const recap = 'we tamed a wolf named Turnip';
    const p = playRecapProps({ characterId: 'c', game: 'minecraft', event: { recap }, checkOutcome: 'saved' });
    expect(p).toEqual({ character_id: 'c', game: 'minecraft', saved: true, source: 'recap', recap_chars: recap.length, recap_words: 6, lines: 0, check_outcome: 'saved', facts_returned: 0, facts_saved: 0, fact_dupes: 0 });
    expect(playRecapProps({ characterId: 'c', game: 'minecraft', event: { recap }, checkOutcome: 'saved', facts: { returned: 3, saved: 2, dupes: 1 } })).toMatchObject({ facts_returned: 3, facts_saved: 2, fact_dupes: 1 });
    expect(Object.values(p)).not.toContain(recap);
    expect(playRecapProps({ characterId: 'c', game: 'minecraft', event: { lines: [1, 2] }, checkOutcome: 'waited_out' })).toMatchObject({ saved: false, source: 'lines', lines: 2 });
    expect(playRecapProps({ characterId: 'c', game: 'minecraft', event: {}, checkOutcome: 'not_run' })).toMatchObject({ source: 'none', recap_words: 0 });
  });
});
