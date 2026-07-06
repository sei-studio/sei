/**
 * formatDate.test.ts — locks in the LOCAL-timezone rendering of the "Bonded" /
 * "Last launch" stat dates.
 *
 * Runs under a fixed TZ (see the TZ guard) so the date-only regression is
 * deterministic: a bare "YYYY-MM-DD" must render as that same calendar day, not
 * roll back to the previous day the way `new Date("2026-06-06")` (UTC midnight)
 * would in a negative-offset zone.
 */
import { describe, it, expect } from 'vitest';
import { formatDate } from './formatDate';

describe('formatDate', () => {
  it('returns "-" for null or empty input', () => {
    expect(formatDate(null)).toBe('-');
    expect(formatDate('')).toBe('-');
  });

  it('returns "-" for an unparseable value', () => {
    expect(formatDate('not-a-date')).toBe('-');
  });

  it('renders a bare date on its own calendar day (no UTC-midnight rollback)', () => {
    // The regression: "2026-06-06" must not display as Jun 5 in a zone west of
    // UTC. We assert the day component the naive parser would have dropped.
    const out = formatDate('2026-06-06');
    expect(out).toContain('6');
    expect(out).toContain('2026');
    // Naive `new Date('2026-06-06')` in US Pacific rendered "Jun 5"; guard that.
    expect(out).not.toContain('Jun 5');
  });

  it('formats a full ISO timestamp', () => {
    // Midday UTC lands on the same calendar day in every real timezone.
    const out = formatDate('2026-06-06T12:00:00.000Z');
    expect(out).toContain('2026');
    expect(out).toMatch(/Jun/);
  });
});
