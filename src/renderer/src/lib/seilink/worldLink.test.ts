/**
 * The WorldLink status lines (261106 v6): World N, the order and pacing of
 * the nine lines on the Anima milestones, early finishes, holds, failures and
 * the analytics report.
 */
import { describe, expect, it } from 'vitest';
import {
  EXPECTED_LINK_MS,
  FAILURE_LINE,
  FIRST_LINE_MS,
  LAST_LINE_MS,
  LINE_DWELL_MS,
  LINK_TIMEOUT_MS,
  STATUS_LINES,
  SUCCESS_LINE,
  emptyLog,
  instantLog,
  linkReport,
  planLink,
  recordLink,
  simulatedLog,
  worldNumber,
  type LinkLog,
} from './worldLink';

describe('worldNumber', () => {
  it('is six digits and the same for an id every time', () => {
    const ids = ['0b9c4e7a-1f2d-4c3b-9a8e-7d6c5b4a3f21', 'a', '', 'sui', '7f1fad2e-0000-4000-8000-000000000000'];
    for (const id of ids) {
      const n = worldNumber(id);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(100000);
      expect(n).toBeLessThanOrEqual(999999);
      expect(String(n)).toHaveLength(6);
      expect(worldNumber(id)).toBe(n);
    }
  });

  it('pins the hash (FNV-1a 32 over the id, mod 900000, plus 100000)', () => {
    // FNV-1a("") = 0x811c9dc5 = 2166136261; 2166136261 % 900000 = 736261.
    expect(worldNumber('')).toBe(836261);
    expect(worldNumber('a')).toBe(((0xe40c292c >>> 0) % 900000) + 100000);
  });

  it('spreads different ids over different worlds', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) seen.add(worldNumber(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`));
    expect(seen.size).toBeGreaterThan(495);
  });
});

describe('the copy', () => {
  it('is the approved text, with real ellipses and no em dashes', () => {
    expect(STATUS_LINES.map((l) => l.key)).toEqual([
      'Initializing WorldLink…',
      'Sending signal to World {world}…',
      'Waiting for a reply…',
      'Signal received.',
      'Syncing world clocks…',
      'Matching physics constants…',
      'Correcting for time dilation…',
      'Stabilizing the link…',
      'Inviting {name}…',
    ]);
    expect(SUCCESS_LINE).toBe('WorldLink established between World 0 and World {world}.');
    expect(FAILURE_LINE).toBe('WorldLink failed. Lost contact with World {world}. Come back later.');
    for (const s of [...STATUS_LINES.map((l) => l.key), SUCCESS_LINE, FAILURE_LINE]) {
      expect(s).not.toContain('—');
      expect(s).not.toContain('...');
      expect(s).not.toContain('#');
    }
  });
});

const gaps = (xs: number[]): number[] => xs.slice(1).map((x, i) => x - xs[i]);

describe('planLink', () => {
  it('everything ready at once: nine lines at the minimum dwell, then the success line', () => {
    const p = planLink(instantLog());
    expect(p.lines).toHaveLength(9);
    expect(p.lines[0]).toBe(FIRST_LINE_MS);
    for (const g of gaps(p.lines)) expect(g).toBe(LINE_DWELL_MS);
    expect(p.success).toBe(p.lines[8] + LAST_LINE_MS);
    expect(p.fail).toBeNull();
  });

  it('a 75 s bake: lines wait on their milestones and the curve, holding through the slow stage', () => {
    const log = simulatedLog({ doneMs: 75_000 });
    const p = planLink(log);
    expect(p.lines).toHaveLength(9);
    for (const g of gaps(p.lines)) expect(g).toBeGreaterThanOrEqual(LINE_DWELL_MS);
    // 5 to 7 spread over the expected time while the bake runs; 8 when it is done; 9 when it is installed.
    expect(p.lines[4]).toBeGreaterThanOrEqual(0.15 * EXPECTED_LINK_MS);
    expect(p.lines[5]).toBeGreaterThanOrEqual(0.35 * EXPECTED_LINK_MS);
    expect(p.lines[6]).toBeGreaterThanOrEqual(0.6 * EXPECTED_LINK_MS);
    expect(p.lines[7]).toBe(log.at.baked);
    expect(p.lines[8]).toBe(log.at.installed);
    expect(p.success).toBe(75_000 + LAST_LINE_MS);
  });

  it('a bake done in 20 s cuts the curve short: the rest play at the minimum dwell', () => {
    const log = simulatedLog({ doneMs: 20_000 });
    const p = planLink(log);
    expect(p.lines).toHaveLength(9);
    for (const g of gaps(p.lines)) expect(g).toBeGreaterThanOrEqual(LINE_DWELL_MS);
    // Nothing waits past the moment the bake was done plus the dwell chain.
    const doneAt = log.at.baked!;
    const firstAfter = p.lines.findIndex((s) => s >= doneAt);
    for (let i = firstAfter + 1; i < 9; i++) expect(p.lines[i] - p.lines[i - 1]).toBe(LINE_DWELL_MS);
    expect(p.success!).toBeLessThan(40_000);
  });

  it('a past start never moves when more of the log arrives', () => {
    const full = simulatedLog({ doneMs: 75_000 });
    const final = planLink(full);
    const log = emptyLog();
    const events = Object.entries(full.at).sort((a, b) => a[1] - b[1]);
    for (let now = 0; now <= 90_000; now += 250) {
      for (const [m, t] of events) if (t <= now) recordLink(log, { kind: 'milestone', milestone: m as never }, t);
      const p = planLink(log);
      p.lines.forEach((s, i) => {
        if (s <= now) expect(s).toBe(final.lines[i]);
      });
    }
  });

  it('holds the current line while a stage is slow, with no extra lines', () => {
    const log: LinkLog = { at: { sent: 200, answered: 900, host: 2000 }, failed: null };
    const p = planLink(log);
    // 1 to 5 can show (5 waits on the curve); 6 needs the bake to run.
    expect(p.lines).toHaveLength(5);
    expect(p.success).toBeNull();
    // Still holding: the timeout is ahead as the failure.
    expect(p.fail).toEqual({ at: LINK_TIMEOUT_MS, failure: 'timeout' });
  });

  it('a failure shows the failure line after the current line has had its dwell, and no more lines', () => {
    const p = planLink(simulatedLog({ doneMs: 75_000, failAtMs: 30_000, failure: 'bake_failed' }));
    expect(p.success).toBeNull();
    expect(p.fail!.failure).toBe('bake_failed');
    const last = p.lines[p.lines.length - 1];
    expect(last).toBeLessThanOrEqual(30_000);
    expect(p.fail!.at).toBe(Math.max(30_000, last + LINE_DWELL_MS));
    expect(p.lines.length).toBeLessThan(9);
  });

  it('offline at once: the first line, then the failure line', () => {
    const log = emptyLog();
    recordLink(log, { kind: 'failed', failure: 'offline' }, 0);
    const p = planLink(log);
    expect(p.lines).toEqual([FIRST_LINE_MS]);
    expect(p.fail).toEqual({ at: FIRST_LINE_MS + LINE_DWELL_MS, failure: 'offline' });
  });

  it('the host failing is a failure; a failure after everything arrived is ignored', () => {
    const log: LinkLog = { at: { sent: 0, answered: 0, baked: 0, installed: 0 }, failed: { at: 4000, failure: 'host' } };
    expect(planLink(log).fail?.failure).toBe('host');
    const ok: LinkLog = { at: { ...instantLog().at }, failed: { at: 4000, failure: 'network' } };
    expect(planLink(ok).fail).toBeNull();
    expect(planLink(ok).lines).toHaveLength(9);
  });

  it('no line 9 by the timeout fails it as timeout', () => {
    const log: LinkLog = { at: { sent: 100, answered: 800, running: 10_000, host: 2000 }, failed: null };
    const p = planLink(log);
    expect(p.fail).toEqual({ at: LINK_TIMEOUT_MS, failure: 'timeout' });
    expect(p.lines.length).toBe(7);
  });

  it('records only the first arrival, nothing after a failure', () => {
    const log = emptyLog();
    recordLink(log, { kind: 'milestone', milestone: 'sent' }, 100);
    recordLink(log, { kind: 'milestone', milestone: 'sent' }, 900);
    recordLink(log, { kind: 'failed', failure: 'network' }, 1000);
    recordLink(log, { kind: 'milestone', milestone: 'answered' }, 1100);
    expect(log).toEqual({ at: { sent: 100 }, failed: { at: 1000, failure: 'network' } });
  });
});

describe('linkReport', () => {
  it('per-line timing, the slowest milestone, the total and the outcome', () => {
    const log = simulatedLog({ doneMs: 75_000 });
    const p = planLink(log);
    const r = linkReport(log, p, p.success! + 9000, 'success');
    expect(r.outcome).toBe('success');
    expect(r.lines_shown).toBe(9);
    expect(r.line_1_ms).toBe(LINE_DWELL_MS);
    expect(r.line_9_ms).toBe(LAST_LINE_MS);
    expect(r.slowest).toBe('baked');
    expect(r.slowest_ms).toBe(log.at.baked! - log.at.running!);
    expect(r).not.toHaveProperty('failure');
  });

  it('a failed run carries the failure class; an abandoned one only what was shown', () => {
    const log = simulatedLog({ doneMs: 75_000, failAtMs: 30_000, failure: 'network' });
    const p = planLink(log);
    expect(linkReport(log, p, p.fail!.at + 4000, 'failed')).toMatchObject({ outcome: 'failed', failure: 'network' });
    const r = linkReport(log, p, 5000, 'abandoned');
    expect(r.lines_shown).toBe(2);
    expect(r.line_2_ms).toBe(5000 - p.lines[1]);
    expect(r).not.toHaveProperty('failure');
  });
});
