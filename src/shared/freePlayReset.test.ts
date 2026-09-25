import { describe, it, expect } from 'vitest';
import {
  resetCountdown,
  formatResetLine,
  quietCompanionNotice,
  decideFreePlayBanner,
} from './freePlayReset';

// Local-time constructors keep these independent of the machine's time zone:
// every helper reads calendar days in local time too.
const at = (y: number, m: number, d: number, h = 0, min = 0): number => new Date(y, m - 1, d, h, min).getTime();
const iso = (ms: number): string => new Date(ms).toISOString();

// Friday 2026-09-26, 10:00 local.
const NOW = at(2026, 9, 26, 10);

describe('resetCountdown', () => {
  it('counts calendar days, not 24h blocks', () => {
    // 15 hours away but past midnight: that is tomorrow.
    expect(resetCountdown(iso(at(2026, 9, 27, 1)), NOW)?.days).toBe(1);
    // Later today.
    expect(resetCountdown(iso(at(2026, 9, 26, 23, 59)), NOW)?.days).toBe(0);
    expect(resetCountdown(iso(at(2026, 9, 30, 9)), NOW)?.days).toBe(4);
  });

  it('returns null for missing, bad, or past stamps', () => {
    expect(resetCountdown('', NOW)).toBeNull();
    expect(resetCountdown(null, NOW)).toBeNull();
    expect(resetCountdown(undefined, NOW)).toBeNull();
    expect(resetCountdown('not a date', NOW)).toBeNull();
    expect(resetCountdown(iso(NOW - 1000), NOW)).toBeNull();
    expect(resetCountdown(iso(NOW), NOW)).toBeNull();
  });
});

describe('formatResetLine', () => {
  it('free plan, days away, with weekday and date', () => {
    expect(formatResetLine(iso(at(2026, 9, 30, 9)), NOW, { lang: 'en' })).toBe(
      'Free play resets in 4 days (Wednesday, Sep 30).',
    );
  });

  it('tomorrow and today', () => {
    expect(formatResetLine(iso(at(2026, 9, 27, 8)), NOW, { lang: 'en', plan: 'free' })).toBe(
      'Free play resets tomorrow (Sunday, Sep 27).',
    );
    expect(formatResetLine(iso(at(2026, 9, 26, 21, 30)), NOW, { lang: 'en' })).toBe(
      'Free play resets today at 9:30 PM.',
    );
  });

  it('subscribers read their weekly allowance, not free play', () => {
    expect(formatResetLine(iso(at(2026, 9, 30, 9)), NOW, { lang: 'en', plan: 'quest' })).toBe(
      'Your weekly allowance resets in 4 days (Wednesday, Sep 30).',
    );
  });

  it('Chinese copy', () => {
    expect(formatResetLine(iso(at(2026, 9, 30, 9)), NOW, { lang: 'zh' })).toBe(
      '免费游玩将在4天后重置（9月30日星期三）。',
    );
    expect(formatResetLine(iso(at(2026, 9, 27, 9)), NOW, { lang: 'zh' })).toBe(
      '免费游玩将在明天重置（9月27日星期日）。',
    );
    expect(formatResetLine(iso(at(2026, 9, 26, 21, 30)), NOW, { lang: 'zh', plan: 'party' })).toBe(
      '每周额度将在今天21:30重置。',
    );
  });

  it('degrades to null when the proxy sent no reset time', () => {
    expect(formatResetLine('', NOW, { lang: 'en' })).toBeNull();
  });

  it('never uses an em dash', () => {
    for (const lang of ['en', 'zh'] as const) {
      for (const plan of ['free', 'quest'] as const) {
        for (const ms of [at(2026, 9, 26, 22), at(2026, 9, 27, 9), at(2026, 10, 2, 9)]) {
          expect(formatResetLine(iso(ms), NOW, { lang, plan })).not.toContain('—');
        }
      }
    }
  });
});

describe('quietCompanionNotice', () => {
  it('names the character and carries the reset date', () => {
    const line = quietCompanionNotice({
      name: 'Marv',
      lang: 'en',
      resetsAt: iso(at(2026, 9, 30, 9)),
      nowMs: NOW,
    });
    expect(line).toBe(
      "You're out of free play for now, so Marv will keep playing quietly, with no chat. " +
        'Free play resets in 4 days (Wednesday, Sep 30). Top up or upgrade to bring them back sooner.',
    );
  });

  it('reads cleanly without a reset time', () => {
    const line = quietCompanionNotice({ name: 'Marv', lang: 'en', resetsAt: '', nowMs: NOW });
    expect(line).toBe(
      "You're out of free play for now, so Marv will keep playing quietly, with no chat. " +
        'Top up or upgrade to bring them back sooner.',
    );
    expect(line).not.toMatch(/ {2}/);
  });

  it('Party is the top plan, so it only offers a top up', () => {
    const line = quietCompanionNotice({ name: 'Marv', lang: 'en', plan: 'party', resetsAt: '', nowMs: NOW });
    expect(line).toContain('Top up to bring them back sooner.');
    expect(line).not.toMatch(/upgrade/i);
    expect(quietCompanionNotice({ name: 'Marv', lang: 'en', plan: 'quest', resetsAt: '', nowMs: NOW })).toContain(
      'Top up or upgrade',
    );
    const zh = quietCompanionNotice({ name: '小马', lang: 'zh', plan: 'party', resetsAt: '', nowMs: NOW });
    expect(zh).not.toContain('升级');
  });

  it('Chinese', () => {
    const line = quietCompanionNotice({ name: '小马', lang: 'zh', resetsAt: iso(at(2026, 9, 30, 9)), nowMs: NOW });
    expect(line).toContain('小马');
    expect(line).toContain('4天后重置');
    expect(line).not.toContain('—');
  });
});

describe('decideFreePlayBanner', () => {
  const base = { cloud: true, snapshotFailed: false, over_limit: false, resets_at: '' };
  const reset = iso(at(2026, 9, 30, 9));
  const ME = 'user-a';
  const mine = { user_id: ME, resets_at: reset };

  it('remembers the reset time, keyed by account, while at the wall', () => {
    expect(decideFreePlayBanner(null, ME, { ...base, over_limit: true, resets_at: reset }, NOW)).toEqual({
      show: false,
      store: mine,
    });
    // Already remembered: no write.
    expect(decideFreePlayBanner(mine, ME, { ...base, over_limit: true, resets_at: reset }, NOW)).toEqual({
      show: false,
      store: undefined,
    });
    // At the wall with no reset time in the snapshot keeps what we had.
    expect(decideFreePlayBanner(mine, ME, { ...base, over_limit: true }, NOW).store).toBeUndefined();
  });

  it('shows once after the remembered reset has passed and the wall is gone', () => {
    const later = at(2026, 9, 30, 12);
    expect(decideFreePlayBanner(mine, ME, { ...base, resets_at: iso(at(2026, 10, 7, 9)) }, later)).toEqual({
      show: true,
      store: null,
    });
    // Nothing remembered: nothing to show.
    expect(decideFreePlayBanner(null, ME, base, later)).toEqual({ show: false, store: undefined });
  });

  it('a top up before the reset clears the memory without a banner', () => {
    expect(decideFreePlayBanner(mine, ME, base, NOW)).toEqual({ show: false, store: null });
  });

  it("another account's memory is never acted on (config is per profile, not per account)", () => {
    const later = at(2026, 9, 30, 12);
    // Account B signs in on the same profile after A hit the wall: no banner,
    // and A's entry is left alone.
    expect(decideFreePlayBanner(mine, 'user-b', base, later)).toEqual({ show: false, store: undefined });
    // B reaching the wall itself replaces the entry with its own.
    expect(
      decideFreePlayBanner(mine, 'user-b', { ...base, over_limit: true, resets_at: iso(at(2026, 10, 2, 9)) }, NOW),
    ).toEqual({ show: false, store: { user_id: 'user-b', resets_at: iso(at(2026, 10, 2, 9)) } });
    // No signed-in user: nothing at all.
    expect(decideFreePlayBanner(mine, null, base, later)).toEqual({ show: false, store: undefined });
  });

  it('unknown snapshots change nothing', () => {
    const later = at(2026, 9, 30, 12);
    expect(decideFreePlayBanner(mine, ME, { ...base, snapshotFailed: true }, later)).toEqual({
      show: false,
      store: undefined,
    });
    expect(decideFreePlayBanner(mine, ME, { ...base, cloud: false }, later)).toEqual({
      show: false,
      store: undefined,
    });
  });
});
