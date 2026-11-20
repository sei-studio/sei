import { describe, expect, it } from 'vitest';
import { rolloutBucket } from './velopackFastApply';
import {
  DEFAULT_REPAIR_RULE,
  FAILURE_THRESHOLD,
  HANDOFF_IN_PROGRESS_MS,
  MAX_KNOWN_SETUPS,
  MAX_REPAIR_ATTEMPTS,
  MAX_REPORTS,
  emptyRepairState,
  evaluateLaunch,
  handoffResultClass,
  noteApplyLaunched,
  noteFailure,
  noteHealthy,
  parseRepairRule,
  parseRepairState,
  pickRepairTarget,
  pushReport,
  recordDecision,
  rememberSetup,
  repairAllowed,
  repairBucket,
  repairDecision,
  repairDue,
  type KnownSetup,
  type LaunchFacts,
  type RepairState,
} from './velopackRepairPolicy';

const sha = 'a'.repeat(64);
function setup(version: string, channel = 'win'): KnownSetup {
  return { version, tag: `v${version}`, file: 'Sei-win-Setup.exe', sha256: sha, size: 1000, channel };
}
function facts(over: Partial<LaunchFacts> = {}): LaunchFacts {
  return { launch: 'L1', version: '0.7.0', now: 1_000_000, broken: null, handoffResult: null, handoffRunnerAlive: false, ...over };
}
/** Fails `n` launches in a row (one count each). */
function failLaunches(s: RepairState, n: number, kind: 'check' | 'download' = 'download'): RepairState {
  for (let i = 0; i < n; i++) s = noteFailure(s, kind, { launch: `F${i}`, version: '0.7.0', now: 1000 + i }).state;
  return s;
}

describe('state persistence', () => {
  it('round-trips through JSON', () => {
    let s = failLaunches(emptyRepairState(), 2);
    s = noteApplyLaunched(s, '0.7.0', '0.7.1', 5);
    s = rememberSetup(s, setup('0.7.1'), 'win');
    s = pushReport(s, { phase: 'held', reason: 'disabled' });
    s.handoff = { attempt: 1, from: '0.7.0', target: '0.7.1', channel: 'win', at: 9, dir: 'C:\\t\\x', trigger: 'check', mode: 'normal' };
    s.betaId = 'beta-1';
    const back = parseRepairState(JSON.parse(JSON.stringify(s)));
    expect(back).toEqual(s);
  });

  it('reads junk as a fresh state', () => {
    expect(parseRepairState(null)).toEqual(emptyRepairState());
    expect(parseRepairState('x')).toEqual(emptyRepairState());
    expect(parseRepairState({ streak: -4, attempts: 'x', setups: [{ version: 'nope' }], lastFailure: { kind: 'bogus' } })).toEqual(
      emptyRepairState(),
    );
  });

  it('keeps reports bounded', () => {
    let s = emptyRepairState();
    for (let i = 0; i < MAX_REPORTS + 5; i++) s = pushReport(s, { phase: 'held', reason: `r${i}` });
    expect(s.reports).toHaveLength(MAX_REPORTS);
    expect(s.reports.at(-1)).toEqual({ phase: 'held', reason: `r${MAX_REPORTS + 4}` });
    expect(parseRepairState({ ...s, reports: [...s.reports, ...s.reports] }).reports).toHaveLength(MAX_REPORTS);
  });

  it('remembers the newest setups, one per channel and version', () => {
    let s = emptyRepairState();
    for (const v of ['0.7.0', '0.7.2', '0.7.1', '0.7.2', '0.6.9', '0.7.3']) s = rememberSetup(s, setup(v), 'win');
    expect(s.setups.map((x) => x.version)).toEqual(['0.7.3', '0.7.2', '0.7.1', '0.7.0']);
    expect(s.setups).toHaveLength(MAX_KNOWN_SETUPS);
  });
});

describe('signals and threshold', () => {
  it('counts at most one failure per launch', () => {
    let s = emptyRepairState();
    s = noteFailure(s, 'check', { launch: 'A', version: '0.7.0', now: 1 }).state;
    const again = noteFailure(s, 'download', { launch: 'A', version: '0.7.0', now: 2 });
    expect(again.counted).toBe(false);
    expect(again.state.streak).toBe(1);
    expect(again.state.lastFailure?.kind).toBe('download');
    expect(again.state.firstFailureAt).toBe(1);
  });

  it(`is due after ${FAILURE_THRESHOLD} failing launches, not before`, () => {
    expect(repairDue(failLaunches(emptyRepairState(), FAILURE_THRESHOLD - 1))).toBe(false);
    expect(repairDue(failLaunches(emptyRepairState(), FAILURE_THRESHOLD))).toBe(true);
  });

  it('a decisive signal is due at once', () => {
    const s = noteFailure(emptyRepairState(), 'update-exe-missing', { launch: 'A', version: '0.7.0', now: 1 }).state;
    expect(repairDue(s)).toBe(true);
  });

  it('a healthy check clears the streak but not the attempts', () => {
    const s = { ...failLaunches(emptyRepairState(), 2), attempts: 2 };
    const h = noteHealthy(s);
    expect(h.streak).toBe(0);
    expect(h.firstFailureAt).toBeUndefined();
    expect(h.attempts).toBe(2);
    expect(repairDue(failLaunches(h, FAILURE_THRESHOLD - 1))).toBe(false);
  });

  it('is never due while a hand-off is open', () => {
    const s = failLaunches(emptyRepairState(), 5);
    s.handoff = { attempt: 1, from: '0.7.0', target: '0.7.1', channel: 'win', at: 1, dir: 'd', trigger: 'check', mode: 'normal' };
    expect(repairDue(s)).toBe(false);
  });
});

describe('evaluateLaunch', () => {
  it('counts an apply that did not take', () => {
    const s = noteApplyLaunched(emptyRepairState(), '0.7.0', '0.7.1', 1);
    const o = evaluateLaunch({ ...s, lastVersion: '0.7.0' }, facts());
    expect(o.state.streak).toBe(1);
    expect(o.state.lastFailure).toMatchObject({ kind: 'apply-no-effect', target: '0.7.1' });
    expect(o.state.apply).toBeUndefined();
  });

  it('an apply that worked resets streak and attempts', () => {
    let s = failLaunches(emptyRepairState(), 2);
    s = { ...noteApplyLaunched(s, '0.7.0', '0.7.1', 1), attempts: 3, lastVersion: '0.7.0' };
    const o = evaluateLaunch(s, facts({ version: '0.7.1' }));
    expect(o.state).toMatchObject({ streak: 0, attempts: 0, lastVersion: '0.7.1' });
    expect(o.state.apply).toBeUndefined();
  });

  it('a broken layout counts once and makes the repair due', () => {
    const o = evaluateLaunch(emptyRepairState(), facts({ broken: 'update-exe-missing' }));
    expect(o.state.streak).toBe(1);
    expect(repairDue(o.state)).toBe(true);
  });

  it('an apply failure plus a broken layout in one launch count once', () => {
    const s = noteApplyLaunched(emptyRepairState(), '0.7.0', '0.7.1', 1);
    const o = evaluateLaunch(s, facts({ broken: 'not-installed' }));
    expect(o.state.streak).toBe(1);
    expect(o.state.lastFailure?.kind).toBe('not-installed');
    expect(repairDue(o.state)).toBe(true);
  });

  const handoff = { attempt: 1, from: '0.7.0', target: '0.7.1', channel: 'win', at: 900_000, dir: 'C:\\tmp\\r', trigger: 'download' as const, mode: 'normal' };

  it('leaves while the runner of a young hand-off is alive', () => {
    const s = { ...emptyRepairState(), handoff };
    const o = evaluateLaunch(s, facts({ handoffRunnerAlive: true }));
    expect(o.leave).toBe(true);
    expect(o.state.handoff).toEqual(handoff);
  });

  it('does not wait on an old or dead hand-off', () => {
    const s = { ...emptyRepairState(), handoff };
    const old = evaluateLaunch(s, facts({ handoffRunnerAlive: true, now: handoff.at + HANDOFF_IN_PROGRESS_MS + 1 }));
    expect(old.leave).toBe(false);
    expect(old.state.handoff).toBeUndefined();
    expect(old.state.reports.at(-1)).toMatchObject({ phase: 'failed', class: 'no-result', stage: 'setup' });
    expect(old.removeDir).toBe(handoff.dir);
  });

  it('reports a repair that reached the target, with the time to recover', () => {
    let s = failLaunches(emptyRepairState(), 3);
    s = { ...s, firstFailureAt: 100_000, handoff, attempts: 1, lastVersion: '0.7.0' };
    const o = evaluateLaunch(s, facts({ version: '0.7.1', handoffResult: 'setup-exit 0' }));
    expect(o.leave).toBe(false);
    expect(o.removeDir).toBe(handoff.dir);
    expect(o.state).toMatchObject({ streak: 0, attempts: 1, lastVersion: '0.7.1' });
    expect(o.state.handoff).toBeUndefined();
    expect(o.state.reports.at(-1)).toEqual({
      phase: 'repaired',
      attempt: 1,
      recover_ms: 900_000,
      trigger: 'download',
      mode: 'normal',
      same_version: false,
      from: '0.7.0',
      to: '0.7.1',
    });
  });

  it('a same-version reinstall counts when Setup exited 0 and the layout is whole', () => {
    const s = { ...emptyRepairState(), handoff: { ...handoff, target: '0.7.0' }, streak: 1, lastVersion: '0.7.0' };
    const ok = evaluateLaunch(s, facts({ handoffResult: 'setup-exit 0' }));
    expect(ok.state.reports.at(-1)).toMatchObject({ phase: 'repaired', same_version: true });
    const stillBroken = evaluateLaunch(s, facts({ handoffResult: 'setup-exit 0', broken: 'update-exe-missing' }));
    expect(stillBroken.state.reports.at(-1)).toMatchObject({ phase: 'failed', class: 'ok' });
    expect(repairDue(stillBroken.state)).toBe(true);
  });

  it('a failed Setup keeps the streak so the next launch may retry', () => {
    const s = { ...failLaunches(emptyRepairState(), 3), handoff, attempts: 1, lastVersion: '0.7.0' };
    const o = evaluateLaunch(s, facts({ handoffResult: 'setup-exit 5' }));
    expect(o.state.reports.at(-1)).toMatchObject({ phase: 'failed', class: 'setup-exit-5', attempt: 1 });
    expect(o.state.streak).toBe(3);
    expect(repairDue(o.state)).toBe(true);
  });

  it('classes runner results', () => {
    expect(handoffResultClass(null)).toBe('no-result');
    expect(handoffResultClass('setup-exit 0\r\n')).toBe('ok');
    expect(handoffResultClass('setup-exit -1')).toBe('setup-exit--1');
    expect(handoffResultClass('hash-mismatch')).toBe('hash-mismatch');
    expect(handoffResultClass('Setup Timeout!')).toBe('setup-timeout-');
  });
});

describe('remote rule', () => {
  it('parses and clamps', () => {
    expect(parseRepairRule({ percent: 140, epoch: 2.7 })).toEqual({ percent: 100, epoch: 2 });
    expect(parseRepairRule({ epoch: 1 })).toBeNull();
    expect(parseRepairRule('x')).toBeNull();
  });

  it('percent 0 is off, 100 is everyone, between follows the bucket', () => {
    expect(repairAllowed({ percent: 0, epoch: 0 }, 'id')).toBe(false);
    expect(repairAllowed(DEFAULT_REPAIR_RULE, 'id')).toBe(true);
    const b = repairBucket('id');
    expect(repairAllowed({ percent: b, epoch: 0 }, 'id')).toBe(false);
    expect(repairAllowed({ percent: b + 1, epoch: 0 }, 'id')).toBe(true);
  });
});

describe('target selection', () => {
  const id = 'install-1';
  it('never picks a version below the running one', () => {
    const r = pickRepairTarget([setup('0.6.9'), setup('0.6.10')], '0.7.0', id, { win: null });
    expect(r.target).toBeNull();
  });

  it('picks the newest allowed', () => {
    const r = pickRepairTarget([setup('0.7.0'), setup('0.7.2'), setup('0.7.1')], '0.7.0', id, { win: null });
    expect(r.target?.version).toBe('0.7.2');
  });

  it('skips a version the rollout holds from this install and falls back', () => {
    const r = pickRepairTarget([setup('0.7.2'), setup('0.7.1')], '0.7.0', id, { win: { version: '0.7.2', percent: 0 } });
    expect(r.target?.version).toBe('0.7.1');
    const bucket = rolloutBucket(id, '0.7.2');
    const edge = pickRepairTarget([setup('0.7.2')], '0.7.0', id, { win: { version: '0.7.2', percent: bucket } });
    expect(edge).toEqual({ target: null, reason: 'rollout-held' });
    const open = pickRepairTarget([setup('0.7.2')], '0.7.0', id, { win: { version: '0.7.2', percent: bucket + 1 } });
    expect(open.target?.version).toBe('0.7.2');
  });

  it('an unreadable rollout holds newer versions, but a same-version reinstall is fine', () => {
    expect(pickRepairTarget([setup('0.7.1')], '0.7.0', id, { win: 'unreadable' })).toEqual({ target: null, reason: 'rollout-unreadable' });
    expect(pickRepairTarget([setup('0.7.1'), setup('0.7.0')], '0.7.0', id, { win: 'unreadable' }).target?.version).toBe('0.7.0');
  });

  it('uses each channel its own rollout', () => {
    const r = pickRepairTarget([setup('0.7.1-beta.2', 'beta'), setup('0.7.0', 'win')], '0.7.1-beta.1', id, {
      beta: { version: '0.7.1-beta.2', percent: 100 },
      win: null,
    });
    expect(r.target).toMatchObject({ version: '0.7.1-beta.2', channel: 'beta' });
  });
});

describe('repairDecision', () => {
  const base = (s: RepairState) => ({
    state: s,
    rule: DEFAULT_REPAIR_RULE,
    installId: 'install-1',
    appVersion: '0.7.0',
    candidates: [setup('0.7.1')],
    rollouts: { win: null },
  });

  it('is not due below the threshold', () => {
    expect(repairDecision(base(failLaunches(emptyRepairState(), 2)))).toEqual({ ok: false, reason: 'not-due' });
  });

  it('goes once due', () => {
    const d = repairDecision(base(failLaunches(emptyRepairState(), 3)));
    expect(d).toMatchObject({ ok: true, attempt: 1, target: { version: '0.7.1' } });
  });

  it('holds when the rule cannot be read, and when switched off', () => {
    const s = failLaunches(emptyRepairState(), 3);
    expect(repairDecision({ ...base(s), rule: null })).toEqual({ ok: false, reason: 'rule-unreachable' });
    expect(repairDecision({ ...base(s), rule: { percent: 0, epoch: 0 } })).toMatchObject({ ok: false, reason: 'disabled' });
  });

  it(`caps attempts at ${MAX_REPAIR_ATTEMPTS} per epoch, and a new epoch gives fresh ones`, () => {
    let s = failLaunches(emptyRepairState(), 3);
    for (let i = 1; i <= MAX_REPAIR_ATTEMPTS; i++) {
      const d = repairDecision(base(s));
      expect(d).toMatchObject({ ok: true, attempt: i });
      s = recordDecision(s, d, 'normal');
    }
    const capped = repairDecision(base(s));
    expect(capped).toMatchObject({ ok: false, reason: 'cap' });
    s = recordDecision(s, capped, 'normal');
    expect(s.reports.at(-1)).toEqual({ phase: 'gave_up', attempts: MAX_REPAIR_ATTEMPTS });
    // reported once
    const again = recordDecision(s, capped, 'normal');
    expect(again.reports).toHaveLength(s.reports.length);
    const bumped = repairDecision({ ...base(s), rule: { percent: 100, epoch: 1 } });
    expect(bumped).toMatchObject({ ok: true, attempt: 1, epoch: 1 });
  });

  it('records a triggered report and the attempt', () => {
    const s = failLaunches(emptyRepairState(), 3, 'check');
    const d = repairDecision(base(s));
    const next = recordDecision(s, d, 'safe');
    expect(next.attempts).toBe(1);
    expect(next.reports.at(-1)).toEqual({ phase: 'triggered', attempt: 1, trigger: 'check', streak: 3, mode: 'safe', to: '0.7.1' });
  });

  it('respects the rollout and reports the hold once', () => {
    const s = failLaunches(emptyRepairState(), 3);
    const d = repairDecision({ ...base(s), rollouts: { win: { version: '0.7.1', percent: 0 } } });
    expect(d).toMatchObject({ ok: false, reason: 'rollout-held' });
    const r1 = recordDecision(s, d, 'normal');
    expect(r1.reports.at(-1)).toEqual({ phase: 'held', reason: 'rollout-held' });
    expect(recordDecision(r1, d, 'normal').reports).toHaveLength(r1.reports.length);
  });
});
