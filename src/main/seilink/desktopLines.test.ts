import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ powerMonitor: { getSystemIdleTime: () => 0 } }));

import {
  AWAY_AFTER_S,
  IDLE_MAX_GAP_MS,
  IDLE_MIN_GAP_MS,
  IDLE_PER_HOUR,
  LinePacer,
  POKE_MIN_GAP_MS,
  POKE_PER_HOUR,
  IdleWindowStats,
  POKE_REPEAT_QUIET_MS,
  budgetAllows,
  budgetRefusal,
  idleBlock,
  lineBudgetFor,
  pokeEventAllowed,
} from './desktopLines';

const free = { covered: false, paused: false, deafened: false, idleSeconds: 5, busy: false, occupied: false };

describe('seilink desktop lines (M4)', () => {
  it('free cloud accounts never get idle lines; pokes stay inside the plan limit', () => {
    expect(lineBudgetFor('local', null)).toBe('own');
    expect(lineBudgetFor('cloud-proxy', { plan: 'free', over_limit: false })).toBe('free');
    expect(lineBudgetFor('cloud-proxy', { plan: 'quest', over_limit: false })).toBe('paid');
    expect(lineBudgetFor('cloud-proxy', { plan: 'quest', over_limit: true })).toBe('none');
    expect(lineBudgetFor('cloud-proxy', null)).toBe('none');
    expect(budgetAllows('idle', 'free')).toBe(false);
    expect(budgetAllows('idle', 'none')).toBe(false);
    expect(budgetAllows('idle', 'paid')).toBe(true);
    expect(budgetAllows('idle', 'own')).toBe(true);
    expect(budgetAllows('poke', 'free')).toBe(true);
    expect(budgetAllows('poke', 'none')).toBe(false);
  });

  it('never idles while covered, paused, deafened, away, busy or in a game', () => {
    expect(idleBlock(free)).toBeNull();
    expect(idleBlock({ ...free, covered: true })).toBe('covered');
    expect(idleBlock({ ...free, paused: true })).toBe('paused');
    expect(idleBlock({ ...free, deafened: true })).toBe('deafened');
    expect(idleBlock({ ...free, idleSeconds: AWAY_AFTER_S })).toBe('away');
    expect(idleBlock({ ...free, busy: true })).toBe('busy');
    expect(idleBlock({ ...free, occupied: true })).toBe('occupied');
  });

  it('waits a full random gap after she moves in, and between tries', () => {
    const p = new LinePacer(() => 0.5);
    const t0 = 1_000_000;
    expect(p.idleDue(t0)).toBe(false);
    p.follow('sui', t0);
    const gap = IDLE_MIN_GAP_MS + Math.floor(0.5 * (IDLE_MAX_GAP_MS - IDLE_MIN_GAP_MS));
    expect(p.idleDue(t0 + gap - 1)).toBe(false);
    expect(p.idleDue(t0 + gap)).toBe(true);
    p.noteIdle(t0 + gap, false);
    expect(p.idleDue(t0 + gap + 60_000)).toBe(false);
    // Another companion moves in: a fresh full gap.
    p.follow('lyra', t0 + 2 * gap);
    expect(p.idleDue(t0 + 2 * gap + 1)).toBe(false);
  });

  it('keeps the hourly limits and her gap across a host restart and a swap', () => {
    const p = new LinePacer(() => 0);
    let t = 0;
    p.follow('sui', t);
    for (let i = 0; i < POKE_PER_HOUR; i++) {
      expect(p.canPoke(t)).toBe(true);
      p.notePoke(t);
      t += POKE_MIN_GAP_MS;
    }
    expect(p.canPoke(t)).toBe(false);
    // The host restarts: she is off the desktop for a moment, then back.
    p.follow(null, t);
    expect(p.idleDue(t)).toBe(false);
    p.follow('sui', t + 1000);
    expect(p.canPoke(t + 1000)).toBe(false);
    // Her gap did not start over.
    expect(p.idleDue(IDLE_MIN_GAP_MS)).toBe(true);
    p.noteIdle(IDLE_MIN_GAP_MS, true);
    p.noteIdle(2 * IDLE_MIN_GAP_MS, true);
    expect(p.idleDue(3 * IDLE_MIN_GAP_MS - 1)).toBe(false);
    // Moving someone else in gives her a fresh gap, not a fresh hour.
    p.follow('lyra', 2 * IDLE_MIN_GAP_MS);
    expect(p.canPoke(2 * IDLE_MIN_GAP_MS)).toBe(false);
    expect(p.idleDue(3 * IDLE_MIN_GAP_MS - 1)).toBe(false);
    // An hour after the first pokes, they are allowed again.
    expect(p.canPoke(60 * 60_000 + POKE_PER_HOUR * POKE_MIN_GAP_MS)).toBe(true);
  });

  it('caps idle lines per hour even with a short gap', () => {
    const p = new LinePacer(() => 0);
    let t = 0;
    p.follow('sui', t);
    let spoken = 0;
    for (let i = 0; i < 10; i++) {
      t += IDLE_MIN_GAP_MS;
      if (p.idleDue(t)) {
        p.noteIdle(t, true);
        spoken++;
      }
      if (t >= 60 * 60_000) break;
    }
    expect(spoken).toBeLessThanOrEqual(IDLE_PER_HOUR);
  });

  it('caps pokes: a short gap between them and a per-hour limit', () => {
    const p = new LinePacer();
    p.follow('sui', 0);
    let t = 0;
    expect(p.canPoke(t)).toBe(true);
    p.notePoke(t);
    expect(p.canPoke(t + POKE_MIN_GAP_MS - 1)).toBe(false);
    for (let i = 1; i < POKE_PER_HOUR; i++) {
      t += POKE_MIN_GAP_MS;
      expect(p.canPoke(t)).toBe(true);
      p.notePoke(t);
    }
    expect(p.canPoke(t + POKE_MIN_GAP_MS)).toBe(false);
    expect(p.canPoke(60 * 60_000 + 1)).toBe(true);
  });
});

describe('seilink desktop line analytics (261105)', () => {
  it('says why the budget refused a line', () => {
    expect(budgetRefusal('idle', 'free', { plan: 'free', over_limit: false })).toBe('free_plan');
    expect(budgetRefusal('poke', 'free', { plan: 'free', over_limit: false })).toBeNull();
    expect(budgetRefusal('poke', 'none', { plan: 'free', over_limit: true })).toBe('free_cap');
    expect(budgetRefusal('idle', 'none', { plan: 'quest', over_limit: true })).toBe('over_limit');
    expect(budgetRefusal('poke', 'none', null)).toBe('no_plan');
    expect(budgetRefusal('idle', 'own', null)).toBeNull();
  });

  it('counts each idle skip reason once per due window', () => {
    const counts: Record<string, number> = {};
    const st = new IdleWindowStats((k) => (counts[k] = (counts[k] ?? 0) + 1));
    st.skip('covered'); // no window open: ignored
    st.due();
    st.due();
    st.skip('covered');
    st.skip('covered');
    st.skip('away');
    st.attempted('shown');
    st.due();
    st.skip('covered');
    st.attempted('silence');
    expect(counts).toEqual({
      idle_due: 2,
      idle_skip_covered: 2,
      idle_skip_away: 1,
      idle_attempted: 2,
      idle_shown: 1,
      idle_none_silence: 1,
    });
  });

  it('the pacer says when the hourly cap holds a line back', () => {
    const p = new LinePacer(() => 0); // every gap is exactly IDLE_MIN_GAP_MS (25 min)
    p.follow('sui', 0);
    expect(p.idleState(0)).toBe('not_due');
    const g = IDLE_MIN_GAP_MS;
    expect(p.idleState(g)).toBe('due');
    p.noteIdle(g, true);
    expect(p.idleState(2 * g)).toBe('due');
    p.noteIdle(2 * g, true);
    // 75 min: the gap passed, but both lines are inside the last hour.
    expect(IDLE_PER_HOUR).toBe(2);
    expect(p.idleState(3 * g)).toBe('cap');
    expect(p.idleState(g + 60 * 60_000)).toBe('due');
  });

  it('collapses repeated refused pokes, never a real one', () => {
    const last = new Map<string, number>();
    expect(pokeEventAllowed(last, 'limited', 0)).toBe(true);
    expect(pokeEventAllowed(last, 'limited', 1000)).toBe(false);
    expect(pokeEventAllowed(last, 'limited', POKE_REPEAT_QUIET_MS + 1)).toBe(true);
    expect(pokeEventAllowed(last, 'ok', 2)).toBe(true);
    expect(pokeEventAllowed(last, 'ok', 3)).toBe(true);
    expect(pokeEventAllowed(last, 'free_cap', 4)).toBe(true);
    expect(pokeEventAllowed(last, 'free_cap', 5)).toBe(true);
  });
});
