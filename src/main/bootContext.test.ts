import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  _bootStateForTests,
  _resetBootContextForTests,
  getBootMode,
  initBootGuard,
  noteNeutralExit,
  noteQuitting,
  noteRendererReady,
  onBootSuccess,
  reportStartupFailure,
  requestNormalStartNext,
  setRelaunch,
  setSafeModeEntry,
  takeSafeModeReport,
} from './bootContext';
import { NEVER_READY_QUIT_MS, SUCCESS_HOLD_MS, readBootStateSync, bootStatePath } from './bootGuard';

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'sei-bootctx-'));
  _resetBootContextForTests();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(async () => {
  _resetBootContextForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await rm(tmp, { recursive: true, force: true });
});

const launch = (now = 1, forceSafe = false) =>
  initBootGuard({ userData: tmp, appVersion: '0.7.0', persistent: true, forceSafe, now });
const onDisk = () => readBootStateSync(bootStatePath(tmp));

describe('bootContext', () => {
  it('records the attempt on disk before anything else runs', () => {
    expect(launch().mode).toBe('normal');
    expect(onDisk().pending?.mode).toBe('normal');
  });

  it('ready + the hold = success, persisted, hooks run', () => {
    vi.useFakeTimers();
    launch();
    const hook = vi.fn();
    onBootSuccess(hook);
    noteRendererReady();
    expect(hook).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SUCCESS_HOLD_MS);
    expect(hook).toHaveBeenCalledOnce();
    expect(onDisk().pending).toBeNull();
    expect(onDisk().failures).toBe(0);
  });

  it('a crash inside the hold counts and relaunches (first failure)', () => {
    vi.useFakeTimers();
    launch();
    const relaunch = vi.fn();
    const enter = vi.fn();
    setRelaunch(relaunch);
    setSafeModeEntry(enter);
    noteRendererReady();
    reportStartupFailure('renderer_gone');
    vi.advanceTimersByTime(SUCCESS_HOLD_MS * 2);
    expect(relaunch).toHaveBeenCalledOnce();
    expect(enter).not.toHaveBeenCalled();
    expect(onDisk().failures).toBe(1);
    expect(onDisk().pending).toBeNull();
  });

  it('the second failure relaunches into safe mode', () => {
    launch(1);
    setRelaunch(() => {});
    reportStartupFailure('bootstrap');
    _resetBootContextForTests();
    // Next launch, failure 1 already on disk.
    launch(2);
    const relaunch = vi.fn();
    const enter = vi.fn();
    setRelaunch(relaunch);
    setSafeModeEntry(enter);
    reportStartupFailure('bootstrap');
    expect(relaunch).toHaveBeenCalledOnce();
    expect(enter).not.toHaveBeenCalled();
    expect(onDisk().failures).toBe(2);
    _resetBootContextForTests();
    const third = launch(3);
    expect(third.mode).toBe('safe');
    expect(third.reason).toBe('bootstrap');
    expect(takeSafeModeReport()?.reason).toBe('bootstrap');
  });

  it('with no relaunch hook, the second failure opens safe mode in this process', () => {
    launch(1);
    reportStartupFailure('bootstrap');
    expect(getBootMode()).toBe('normal');
    _resetBootContextForTests();
    launch(2);
    const enter = vi.fn();
    setSafeModeEntry(enter);
    reportStartupFailure('renderer_gone');
    expect(enter).toHaveBeenCalledWith('renderer_gone');
    expect(getBootMode()).toBe('safe');
    expect(onDisk().failures).toBe(2);
    expect(onDisk().report?.reason).toBe('renderer_gone');
  });

  it('a relaunch after a failure is not judged again by the quit', () => {
    launch(0);
    setRelaunch(() => {});
    reportStartupFailure('bootstrap');
    noteQuitting(NEVER_READY_QUIT_MS + 1);
    expect(onDisk().failures).toBe(1);
  });

  it('failures after success are ignored', () => {
    vi.useFakeTimers();
    launch();
    noteRendererReady();
    vi.advanceTimersByTime(SUCCESS_HOLD_MS);
    const relaunch = vi.fn();
    setRelaunch(relaunch);
    reportStartupFailure('renderer_gone');
    expect(relaunch).not.toHaveBeenCalled();
    expect(onDisk().failures).toBe(0);
  });

  it('a quit right after ready counts as success', () => {
    launch(0);
    noteRendererReady(1);
    noteQuitting(2);
    expect(onDisk().failures).toBe(0);
    expect(onDisk().pending).toBeNull();
  });

  it('a quit long after the start with no ready ping counts as a failure', () => {
    launch(0);
    noteQuitting(NEVER_READY_QUIT_MS + 1);
    expect(onDisk().failures).toBe(1);
    expect(onDisk().lastFailure?.kind).toBe('renderer_never_ready');
  });

  it('a quit during the splash is neutral', () => {
    launch(0);
    noteQuitting(NEVER_READY_QUIT_MS - 1);
    expect(onDisk().failures).toBe(0);
    expect(onDisk().pending).toBeNull();
  });

  it('an update hand-over is neutral', () => {
    launch();
    noteNeutralExit();
    expect(onDisk().pending).toBeNull();
    expect(launch(2).mode).toBe('normal');
  });

  it('an update hand-over is not re-judged by the quit that follows', () => {
    launch(0);
    noteNeutralExit();
    noteQuitting(NEVER_READY_QUIT_MS + 1);
    expect(onDisk().failures).toBe(0);
    expect(onDisk().pending).toBeNull();
  });

  it('does not relaunch when the failure could not be written (no relaunch loop)', () => {
    launch(1);
    // Make the state file unwritable: a directory where the temp file goes
    // cannot be renamed over, so every later write fails.
    rmSync(bootStatePath(tmp), { force: true });
    mkdirSync(bootStatePath(tmp));
    const relaunch = vi.fn();
    setRelaunch(relaunch);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    reportStartupFailure('module_load', new Error('x'));
    expect(relaunch).not.toHaveBeenCalled();
    expect(getBootMode()).toBe('normal');
  });

  it('forced safe mode, then "Try normal start"', () => {
    expect(launch(1, true).mode).toBe('safe');
    expect(takeSafeModeReport()?.reason).toBe('forced');
    expect(takeSafeModeReport()).toBeNull();
    requestNormalStartNext();
    expect(onDisk().forceNormalOnce).toBe(true);
    _resetBootContextForTests();
    expect(launch(2).mode).toBe('normal');
  });

  it('non-persistent (dev) keeps state in memory and only logs failures', () => {
    initBootGuard({ userData: tmp, appVersion: '0.7.0', persistent: false, forceSafe: false, now: 1 });
    const relaunch = vi.fn();
    const enter = vi.fn();
    setRelaunch(relaunch);
    setSafeModeEntry(enter);
    reportStartupFailure('module_load', new TypeError('x'));
    reportStartupFailure('module_load', new TypeError('x'));
    expect(relaunch).not.toHaveBeenCalled();
    expect(enter).not.toHaveBeenCalled();
    expect(getBootMode()).toBe('normal');
    expect(onDisk().pending).toBeNull(); // nothing on disk
    expect(_bootStateForTests().failures).toBe(2);
  });

  it('non-persistent forced safe mode still opens safe mode', () => {
    const r = initBootGuard({ userData: tmp, appVersion: '0.7.0', persistent: false, forceSafe: true, now: 1 });
    expect(r.mode).toBe('safe');
  });

  it('logs only the error class', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    launch();
    setRelaunch(() => {});
    reportStartupFailure('bootstrap', new Error('token=abc /Users/someone/secret'));
    const text = log.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(text).toContain('Error');
    expect(text).not.toContain('token=abc');
    expect(text).not.toContain('/Users/someone');
  });
});
