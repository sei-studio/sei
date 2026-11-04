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
  budgetAllows,
  idleBlock,
  lineBudgetFor,
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
