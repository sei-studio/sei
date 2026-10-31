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
  noteMainWindowClosed,
  noteNeutralExit,
  noteOsShutdown,
  noteQuitting,
  noteRendererGone,
  noteRendererReady,
  onBootSuccess,
  onStartFailed,
  setStartFailedFallback,
  reportStartupFailure,
  requestNormalStartNext,
  setRelaunch,
  setSafeModeEntry,
  takeSafeModeReport,
} from './bootContext';
import { KILLED_GRACE_MS, NEVER_READY_QUIT_MS, SUCCESS_HOLD_MS, readBootStateSync, bootStatePath } from './bootGuard';

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

describe('bootContext: OS shutdown, renderer exits, window close (T280)', () => {
  it('an OS shutdown before ready is neutral, and nothing after it counts', () => {
    vi.useFakeTimers();
    launch(0);
    const relaunch = vi.fn();
    setRelaunch(relaunch);
    noteOsShutdown();
    reportStartupFailure('renderer_gone');
    noteRendererGone('crashed');
    noteQuitting(NEVER_READY_QUIT_MS + 1);
    vi.advanceTimersByTime(KILLED_GRACE_MS * 2);
    expect(relaunch).not.toHaveBeenCalled();
    expect(onDisk().failures).toBe(0);
    expect(onDisk().pending).toBeNull();
    expect(launch(1).mode).toBe('normal');
  });

  it("a renderer 'clean-exit' before ready is not a failed start", () => {
    launch(0);
    const relaunch = vi.fn();
    setRelaunch(relaunch);
    noteRendererGone('clean-exit');
    expect(relaunch).not.toHaveBeenCalled();
    expect(onDisk().failures).toBe(0);
    expect(onDisk().pending?.mode).toBe('normal'); // still unjudged
  });

  it('a crashed renderer before ready counts at once', () => {
    launch(0);
    const relaunch = vi.fn();
    setRelaunch(relaunch);
    noteRendererGone('crashed');
    expect(relaunch).toHaveBeenCalledOnce();
    expect(onDisk().failures).toBe(1);
    expect(onDisk().lastFailure?.kind).toBe('renderer_gone');
  });

  it("a 'killed' renderer counts after the grace when no OS shutdown follows", () => {
    vi.useFakeTimers();
    launch(0);
    const relaunch = vi.fn();
    setRelaunch(relaunch);
    noteRendererGone('killed');
    vi.advanceTimersByTime(KILLED_GRACE_MS - 1);
    expect(relaunch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(relaunch).toHaveBeenCalledOnce();
    expect(onDisk().failures).toBe(1);
  });

  it("a 'killed' renderer followed by an OS shutdown is neutral", () => {
    vi.useFakeTimers();
    launch(0);
    const relaunch = vi.fn();
    setRelaunch(relaunch);
    noteRendererGone('killed');
    vi.advanceTimersByTime(KILLED_GRACE_MS / 2);
    noteOsShutdown();
    vi.advanceTimersByTime(KILLED_GRACE_MS * 2);
    expect(relaunch).not.toHaveBeenCalled();
    expect(onDisk().failures).toBe(0);
    expect(onDisk().pending).toBeNull();
  });

  it("a 'killed' renderer during an OS shutdown is neutral", () => {
    launch(0);
    noteOsShutdown();
    noteRendererGone('killed');
    expect(onDisk().failures).toBe(0);
  });

  it('macOS: closing the window during the start, then quitting hours later, is neutral', () => {
    launch(0);
    noteMainWindowClosed(5_000);
    noteQuitting(5 * 60 * 60 * 1000);
    expect(onDisk().failures).toBe(0);
    expect(onDisk().pending).toBeNull();
  });

  it('closing a window that never came up after 30 s counts once; session.json hears of it at the quit', () => {
    launch(0);
    const hook = vi.fn();
    onStartFailed(hook);
    noteMainWindowClosed(NEVER_READY_QUIT_MS + 1);
    expect(onDisk().failures).toBe(1);
    expect(onDisk().lastFailure?.kind).toBe('renderer_never_ready');
    expect(hook).not.toHaveBeenCalled(); // the process keeps running on macOS
    noteQuitting(NEVER_READY_QUIT_MS * 100);
    expect(hook).toHaveBeenCalledWith('renderer_never_ready');
    expect(onDisk().failures).toBe(1);
  });

  it('closing the window after ready is a success', () => {
    launch(0);
    noteRendererReady(1);
    noteMainWindowClosed(2);
    expect(onDisk().failures).toBe(0);
    expect(onDisk().pending).toBeNull();
  });
});

describe('bootContext: failed starts reach session.json (T280)', () => {
  it('runs the start-failed hook BEFORE relaunching, once', () => {
    launch(0);
    const order: string[] = [];
    onStartFailed((kind) => order.push(`hook:${kind}`));
    setRelaunch(() => order.push('relaunch'));
    reportStartupFailure('bootstrap');
    reportStartupFailure('bootstrap');
    noteQuitting(NEVER_READY_QUIT_MS + 1);
    expect(order).toEqual(['hook:bootstrap', 'relaunch']);
  });

  it('runs it before opening safe mode in this process', () => {
    launch(1);
    reportStartupFailure('bootstrap'); // no relaunch hook: stays in process
    _resetBootContextForTests();
    launch(2);
    const order: string[] = [];
    onStartFailed((kind) => order.push(`hook:${kind}`));
    setSafeModeEntry(() => order.push('safe'));
    reportStartupFailure('renderer_gone');
    expect(order).toEqual(['hook:renderer_gone', 'safe']);
  });

  it('runs it for a quit that never came up', () => {
    launch(0);
    const hook = vi.fn();
    onStartFailed(hook);
    noteQuitting(NEVER_READY_QUIT_MS + 1);
    expect(hook).toHaveBeenCalledWith('renderer_never_ready');
  });

  it('not for a success, a neutral quit, an update hand-over or an OS shutdown', () => {
    const hook = vi.fn();
    launch(0);
    onStartFailed(hook);
    noteQuitting(1);
    _resetBootContextForTests();
    launch(0);
    onStartFailed(hook);
    noteNeutralExit();
    _resetBootContextForTests();
    launch(0);
    onStartFailed(hook);
    noteOsShutdown();
    _resetBootContextForTests();
    launch(0);
    onStartFailed(hook);
    noteRendererReady(1);
    noteQuitting(2);
    expect(hook).not.toHaveBeenCalled();
  });

  it('uses the boot fallback only when crash reporting never registered', () => {
    launch(42);
    const fallback = vi.fn();
    setStartFailedFallback(fallback);
    setRelaunch(() => {});
    reportStartupFailure('module_load');
    expect(fallback).toHaveBeenCalledWith('module_load', 42);
    _resetBootContextForTests();
    launch(43);
    const fallback2 = vi.fn();
    const hook = vi.fn();
    setStartFailedFallback(fallback2);
    onStartFailed(hook);
    setRelaunch(() => {});
    reportStartupFailure('bootstrap');
    expect(hook).toHaveBeenCalledOnce();
    expect(fallback2).not.toHaveBeenCalled();
  });

  it('dev (non-persistent) records nothing', () => {
    initBootGuard({ userData: tmp, appVersion: '0.7.0', persistent: false, forceSafe: false, now: 0 });
    const hook = vi.fn();
    onStartFailed(hook);
    reportStartupFailure('bootstrap');
    noteQuitting(NEVER_READY_QUIT_MS + 1);
    expect(hook).not.toHaveBeenCalled();
  });

  it('initBootGuard reports the unfinished previous normal start', () => {
    expect(launch(10).unfinished).toBeNull();
    _resetBootContextForTests();
    // The first launch died without being judged.
    expect(launch(20).unfinished).toEqual({ at: 10, appVersion: '0.7.0' });
  });

  it('an unfinished safe-mode run is not reported as a failed start', () => {
    launch(10, true);
    _resetBootContextForTests();
    expect(launch(20).unfinished).toBeNull();
  });
});
