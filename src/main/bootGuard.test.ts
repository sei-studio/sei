import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  FAILURE_THRESHOLD,
  NEVER_READY_QUIT_MS,
  beginBoot,
  bootStatePath,
  freshBootState,
  inProcessFailureAction,
  markFailure,
  markInProcessSafe,
  markNeutral,
  markSuccess,
  normalizeBootState,
  quitVerdict,
  readBootStateSync,
  requestNormalStart,
  safeModeForced,
  takeReport,
  writeBootStateSync,
  type BootState,
} from './bootGuard';

const V = '0.7.0';
const at = (n: number) => ({ appVersion: V, now: n });

/** One launch that crashes before success: begin, never finish. */
function crashLaunch(s: BootState, now: number, appVersion = V) {
  return beginBoot(s, { appVersion, now });
}

describe('beginBoot: counting failed starts', () => {
  it('a fresh install starts normal', () => {
    const r = beginBoot(freshBootState(), at(1));
    expect(r.mode).toBe('normal');
    expect(r.reason).toBeNull();
    expect(r.state.failures).toBe(0);
    expect(r.state.pending).toEqual({ at: 1, appVersion: V, mode: 'normal' });
  });

  it('two crashed starts in a row give a safe-mode third start', () => {
    let s = crashLaunch(freshBootState(), 1).state; // start 1 (crashes)
    const r2 = crashLaunch(s, 2); // start 2 counts start 1
    expect(r2.mode).toBe('normal');
    expect(r2.state.failures).toBe(1);
    s = r2.state; // start 2 crashes too
    const r3 = beginBoot(s, at(3));
    expect(r3.state.failures).toBe(FAILURE_THRESHOLD);
    expect(r3.mode).toBe('safe');
    expect(r3.reason).toBe('unclean_exit');
    expect(r3.state.report).toMatchObject({ reason: 'unclean_exit', failures: 2 });
  });

  it('a success in between resets the count', () => {
    let s = crashLaunch(freshBootState(), 1).state;
    s = beginBoot(s, at(2)).state; // failures 1, this one succeeds:
    s = markSuccess(s);
    expect(s.failures).toBe(0);
    const r = beginBoot(s, at(3));
    expect(r.mode).toBe('normal');
    expect(r.state.failures).toBe(0);
  });

  it('a clean neutral quit does not count', () => {
    let s = beginBoot(freshBootState(), at(1)).state;
    s = markNeutral(s);
    const r = beginBoot(s, at(2));
    expect(r.state.failures).toBe(0);
  });

  it('an in-process failure counts once (not again as unclean on the next start)', () => {
    let s = beginBoot(freshBootState(), at(1)).state;
    s = markFailure(s, 'bootstrap', at(1));
    expect(s.failures).toBe(1);
    expect(s.pending).toBeNull();
    const r = beginBoot(s, at(2));
    expect(r.state.failures).toBe(1);
    expect(r.state.lastFailure?.kind).toBe('bootstrap');
  });

  it('the safe-mode reason is the last failure kind', () => {
    let s = beginBoot(freshBootState(), at(1)).state;
    s = markFailure(s, 'renderer_gone', at(1));
    s = beginBoot(s, at(2)).state;
    s = markFailure(s, 'module_load', at(2));
    const r = beginBoot(s, at(3));
    expect(r.mode).toBe('safe');
    expect(r.reason).toBe('module_load');
  });

  it('a new app version resets the count and gets a normal start', () => {
    let s = crashLaunch(freshBootState(), 1).state;
    s = crashLaunch(s, 2).state;
    const r = beginBoot(s, { appVersion: '0.7.1', now: 3 });
    expect(r.mode).toBe('normal');
    expect(r.state.failures).toBe(0);
    expect(r.state.appVersion).toBe('0.7.1');
  });

  it('a crashed start on an OLD version does not count against the new one', () => {
    const s = crashLaunch(freshBootState(), 1, '0.6.0').state;
    const r = beginBoot(s, { appVersion: V, now: 2 });
    expect(r.state.failures).toBe(0);
  });

  it('an unfinished SAFE-mode run counts for nothing', () => {
    let s = crashLaunch(freshBootState(), 1).state;
    s = crashLaunch(s, 2).state;
    const safe = beginBoot(s, at(3));
    expect(safe.mode).toBe('safe');
    // Safe mode crashes / is killed: the next start is safe again, count unchanged.
    const again = beginBoot(safe.state, at(4));
    expect(again.mode).toBe('safe');
    expect(again.state.failures).toBe(2);
  });

  it('forceSafe wins over everything', () => {
    const r = beginBoot(freshBootState(), { appVersion: V, now: 1, forceSafe: true });
    expect(r.mode).toBe('safe');
    expect(r.reason).toBe('forced');
  });
});

describe('"Try normal start"', () => {
  it('gives exactly one normal start and keeps the count', () => {
    let s = crashLaunch(freshBootState(), 1).state;
    s = crashLaunch(s, 2).state;
    const safe = beginBoot(s, at(3));
    s = requestNormalStart(safe.state);
    const tryNormal = beginBoot(s, at(4));
    expect(tryNormal.mode).toBe('normal');
    expect(tryNormal.state.forceNormalOnce).toBe(false);
    expect(tryNormal.state.failures).toBe(2);
    // It crashes again: straight back to safe mode.
    const back = beginBoot(tryNormal.state, at(5));
    expect(back.mode).toBe('safe');
    expect(back.state.failures).toBe(3);
  });

  it('and if that start works, the count resets', () => {
    let s = crashLaunch(freshBootState(), 1).state;
    s = crashLaunch(s, 2).state;
    s = requestNormalStart(beginBoot(s, at(3)).state);
    s = markSuccess(beginBoot(s, at(4)).state);
    expect(beginBoot(s, at(5)).mode).toBe('normal');
    expect(s.failures).toBe(0);
  });
});

describe('in-process safe mode + report', () => {
  it('relaunches once, then shows safe mode in-process', () => {
    expect(inProcessFailureAction(1)).toBe('relaunch');
    expect(inProcessFailureAction(2)).toBe('safe');
  });

  it('markInProcessSafe leaves a safe pending + a report', () => {
    let s = beginBoot(freshBootState(), at(1)).state;
    s = markFailure(s, 'renderer_gone', at(1));
    s = markInProcessSafe(s, 'renderer_gone', at(1));
    expect(s.pending?.mode).toBe('safe');
    expect(s.report).toMatchObject({ reason: 'renderer_gone', failures: 1 });
    // A safe pending left behind is not a failure.
    expect(beginBoot(s, at(2)).state.failures).toBe(1);
  });

  it('takeReport consumes the report', () => {
    const s = { ...freshBootState(), report: { reason: 'forced' as const, failures: 0, at: 1 } };
    const r = takeReport(s);
    expect(r.report?.reason).toBe('forced');
    expect(r.state.report).toBeNull();
    expect(takeReport(r.state).report).toBeNull();
  });
});

describe('quitVerdict', () => {
  it('ready seen = success', () => {
    expect(quitVerdict({ succeeded: false, readyAt: 5, startedAt: 0, now: 99_999 })).toBe('success');
  });
  it('running long and never ready = failure', () => {
    expect(quitVerdict({ succeeded: false, readyAt: null, startedAt: 0, now: NEVER_READY_QUIT_MS })).toBe('failure');
  });
  it('a quick quit (during the splash) = neutral', () => {
    expect(quitVerdict({ succeeded: false, readyAt: null, startedAt: 0, now: NEVER_READY_QUIT_MS - 1 })).toBe('neutral');
  });
});

describe('normalizeBootState', () => {
  it('turns garbage into a fresh state', () => {
    for (const g of [null, 1, 'x', [], { failures: 'lots' }]) {
      expect(normalizeBootState(g)).toEqual(freshBootState());
    }
  });
  it('caps a huge count and drops malformed nested objects', () => {
    const s = normalizeBootState({ failures: 1e9, pending: { at: 'x' }, lastFailure: { at: 1, appVersion: V, kind: 'nope' } });
    expect(s.failures).toBe(1000);
    expect(s.pending).toBeNull();
    expect(s.lastFailure).toBeNull();
  });
  it('round-trips a real state', () => {
    const s = beginBoot(freshBootState(), at(1)).state;
    expect(normalizeBootState(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });
});

describe('safeModeForced', () => {
  it('reads env and argv', () => {
    expect(safeModeForced([], { SEI_SAFE_MODE: '1' })).toBe(true);
    expect(safeModeForced(['x', '--safe-mode'], {})).toBe(true);
    expect(safeModeForced(['x'], { SEI_SAFE_MODE: '0' })).toBe(false);
  });
});

describe('IO', () => {
  let tmp: string;
  beforeEach(async () => { tmp = await mkdtemp(path.join(tmpdir(), 'sei-boot-')); });
  afterEach(async () => { vi.restoreAllMocks(); await rm(tmp, { recursive: true, force: true }); });

  it('writes and reads back, leaving no temp files', async () => {
    const file = bootStatePath(tmp);
    const s = beginBoot(freshBootState(), at(1)).state;
    expect(writeBootStateSync(file, s)).toBe(true);
    expect(readBootStateSync(file)).toEqual(s);
    expect((await readdir(tmp)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('a missing, empty or corrupt file reads as fresh', async () => {
    const file = bootStatePath(tmp);
    expect(readBootStateSync(file)).toEqual(freshBootState());
    await writeFile(file, '');
    expect(readBootStateSync(file)).toEqual(freshBootState());
    await writeFile(file, '{"failures": 2, "pend');
    expect(readBootStateSync(file)).toEqual(freshBootState());
  });

  it('a write that cannot land returns false instead of throwing', async () => {
    // A plain file where the parent directory should be.
    await writeFile(path.join(tmp, 'blocker'), '');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(writeBootStateSync(path.join(tmp, 'blocker', 'boot-state.json'), freshBootState())).toBe(false);
  });

  it('the file holds no settings content', async () => {
    const file = bootStatePath(tmp);
    writeBootStateSync(file, beginBoot(freshBootState(), at(1)).state);
    const keys = Object.keys(JSON.parse(await readFile(file, 'utf8'))).sort();
    expect(keys).toEqual(['appVersion', 'failures', 'forceNormalOnce', 'lastFailure', 'pending', 'report', 'v']);
  });
});
