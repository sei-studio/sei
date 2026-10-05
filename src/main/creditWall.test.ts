import { describe, expect, it, vi } from 'vitest';
import {
  CREDIT_WALL_QUIET_MS,
  CreditWallDeduper,
  createCreditWallReporter,
  creditWallProps,
  type CreditWallDeps,
} from './creditWall';
import type { CreditsStatus } from '../shared/ipc';

const HOUR = 3_600_000;

function snapshot(over: Partial<CreditsStatus> = {}): CreditsStatus {
  return {
    plan: 'free',
    usage_pct: 100,
    over_limit: true,
    resets_at: new Date(Date.UTC(2026, 9, 8, 0, 0, 0)).toISOString(),
    extra_credits_used: 0,
    extra_credits_total: 0,
    ...over,
  } as CreditsStatus;
}

describe('CreditWallDeduper', () => {
  it('ships the first occurrence and swallows a burst', () => {
    const d = new CreditWallDeduper(1000);
    expect(d.take('depleted', 0)).toEqual({ ship: true, repeatsBefore: 0 });
    expect(d.take('depleted', 500)).toEqual({ ship: false });
    expect(d.take('depleted', 1400)).toEqual({ ship: false });
  });

  it('uses a sliding gap: retries that keep coming stay one wall', () => {
    const d = new CreditWallDeduper(1000);
    d.take('depleted', 0);
    for (let t = 900; t <= 9000; t += 900) expect(d.take('depleted', t).ship).toBe(false);
    // Quiet for a full gap: a new occurrence, carrying the burst's repeat count.
    expect(d.take('depleted', 9000 + 1000)).toEqual({ ship: true, repeatsBefore: 10 });
  });

  it('keys are independent', () => {
    const d = new CreditWallDeduper(1000);
    expect(d.take('depleted', 0).ship).toBe(true);
    expect(d.take('rate_limited', 10).ship).toBe(true);
  });
});

describe('creditWallProps', () => {
  const now = Date.UTC(2026, 9, 5, 12, 0, 0);

  it('fills the brief fields from the snapshot and allowance', () => {
    const p = creditWallProps({
      info: { reason: 'depleted' },
      ctx: { surface: 'chat', trigger: 'llm' },
      now,
      installedAt: now - 2 * HOUR,
      snapshot: snapshot({ usage_pct: 100 }),
      allowanceMicro: 4_000_000,
      repeatsBefore: 0,
      wallSeq: 1,
    });
    expect(p).toMatchObject({
      reason: 'depleted',
      surface: 'chat',
      trigger: 'llm',
      ms_since_install: 2 * HOUR,
      allowance_used_micro: 4_000_000,
      usage_pct: 100,
      resets_in_h: 60,
      plan: 'free',
      extra_credits_left: 0,
      repeats_before: 0,
      wall_seq: 1,
    });
    expect(p).not.toHaveProperty('retry_after_s');
    expect(p).not.toHaveProperty('game');
  });

  it('nulls what it cannot know instead of guessing', () => {
    const p = creditWallProps({
      info: { reason: 'depleted' },
      ctx: { surface: 'voice', trigger: 'tts' },
      now,
      installedAt: null,
      snapshot: null,
      allowanceMicro: null,
      repeatsBefore: 3,
      wallSeq: 2,
    });
    expect(p.ms_since_install).toBeNull();
    expect(p.allowance_used_micro).toBeNull();
    expect(p.resets_in_h).toBeNull();
    expect(p.plan).toBeNull();
    expect(p.repeats_before).toBe(3);
  });

  it('a snapshot without a known allowance still reports usage_pct', () => {
    const p = creditWallProps({
      info: { reason: 'depleted' },
      ctx: { surface: 'chess' },
      now,
      installedAt: now,
      snapshot: snapshot({ usage_pct: 97 }),
      allowanceMicro: null,
      repeatsBefore: 0,
      wallSeq: 1,
    });
    expect(p.allowance_used_micro).toBeNull();
    expect(p.usage_pct).toBe(97);
    expect(p.ms_since_install).toBe(0);
  });

  it('carries game context and the rate-limit window', () => {
    const p = creditWallProps({
      info: { reason: 'rate_limited', retry_after_seconds: 120 },
      ctx: { surface: 'game', trigger: 'session', game: 'minecraft', inCall: true },
      now,
      installedAt: now - 1,
      snapshot: snapshot({ resets_at: new Date(now - HOUR).toISOString() }),
      allowanceMicro: 1,
      repeatsBefore: 0,
      wallSeq: 1,
    });
    expect(p).toMatchObject({ game: 'minecraft', in_call: true, retry_after_s: 120, resets_in_h: 0 });
  });

  it('only scalars, no identifying fields', () => {
    const p = creditWallProps({
      info: { reason: 'depleted' },
      ctx: { surface: 'backseat', trigger: 'llm' },
      now,
      installedAt: now - HOUR,
      snapshot: snapshot(),
      allowanceMicro: 10,
      repeatsBefore: 0,
      wallSeq: 1,
    });
    for (const [k, v] of Object.entries(p)) {
      expect(k).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(['string', 'number', 'boolean'].includes(typeof v) || v === null).toBe(true);
    }
    expect(Object.keys(p).join(',')).not.toMatch(/character|email|name|text|user/);
  });
});

describe('createCreditWallReporter', () => {
  function deps(over: Partial<CreditWallDeps> = {}) {
    let t = Date.UTC(2026, 9, 5, 12, 0, 0);
    const captured: Array<[string, Record<string, unknown>]> = [];
    const d: CreditWallDeps & { advance: (ms: number) => void; captured: typeof captured } = {
      now: () => t,
      installedAt: () => t - HOUR,
      readSnapshot: vi.fn(async () => snapshot()),
      allowanceMicroFor: vi.fn(async () => 2_000_000),
      capture: (event, props) => {
        captured.push([event, props]);
      },
      advance: (ms) => {
        t += ms;
      },
      captured,
      ...over,
    };
    return d;
  }

  it('one event for a burst across surfaces, a new one after the quiet gap', async () => {
    const d = deps();
    const r = createCreditWallReporter(d);
    await Promise.all([
      r.note({ reason: 'depleted' }, { surface: 'voice', trigger: 'llm' }),
      r.note({ reason: 'depleted' }, { surface: 'voice', trigger: 'tts' }),
      r.note({ reason: 'depleted' }, { surface: 'chat', trigger: 'llm' }),
    ]);
    expect(d.captured).toHaveLength(1);
    expect(d.captured[0][0]).toBe('credit_wall_hit');
    expect(d.captured[0][1]).toMatchObject({ surface: 'voice', trigger: 'llm', wall_seq: 1, allowance_used_micro: 2_000_000 });
    // Only the shipped occurrence reads the account.
    expect(d.readSnapshot).toHaveBeenCalledTimes(1);

    d.advance(CREDIT_WALL_QUIET_MS);
    await r.note({ reason: 'depleted' }, { surface: 'game', trigger: 'summon_gate', game: 'minecraft' });
    expect(d.captured).toHaveLength(2);
    expect(d.captured[1][1]).toMatchObject({ surface: 'game', repeats_before: 2, wall_seq: 2, game: 'minecraft' });
  });

  it('a failed account read still ships the event', async () => {
    const d = deps({
      readSnapshot: vi.fn(async () => {
        throw new Error('offline');
      }),
    });
    const r = createCreditWallReporter(d);
    await r.note({ reason: 'depleted' }, { surface: 'chat' });
    expect(d.captured).toHaveLength(1);
    expect(d.captured[0][1]).toMatchObject({ reason: 'depleted', usage_pct: null, allowance_used_micro: null });
    expect(d.allowanceMicroFor).not.toHaveBeenCalled();
  });

  it("treats creditsGet's signed-out placeholder as unknown", async () => {
    const d = deps({ readSnapshot: vi.fn(async () => snapshot({ usage_pct: 0, resets_at: '' })) });
    const r = createCreditWallReporter(d);
    await r.note({ reason: 'depleted' }, { surface: 'chat' });
    expect(d.captured[0][1]).toMatchObject({ usage_pct: null, plan: null, allowance_used_micro: null });
  });

  it('never throws when capture fails', async () => {
    const d = deps({
      capture: () => {
        throw new Error('posthog down');
      },
    });
    const r = createCreditWallReporter(d);
    await expect(r.note({ reason: 'depleted' }, { surface: 'chat' })).resolves.toBeUndefined();
  });
});
