import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  _bootStateForTests,
  _resetBootContextForTests,
  getBootMode,
  initBootGuard,
  noteMainWindowLoaded,
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
    noteMainWindowLoaded();
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

  it('the second failure opens safe mode in this process', () => {
    launch(1);
    reportStartupFailure('bootstrap'); // no relaunch hook set: falls to safe
    _resetBootContextForTests();
    // Next launch, failure 1 already on disk.
    launch(2);
    const relaunch = vi.fn();
    const enter = vi.fn();
    setRelaunch(relaunch);
    setSafeModeEntry(enter);
    reportStartupFailure('bootstrap');
    expect(relaunch).not.toHaveBeenCalled();
    expect(enter).toHaveBeenCalledWith('bootstrap');
    expect(getBootMode()).toBe('safe');
    expect(onDisk().failures).toBe(2);
    expect(onDisk().report?.reason).toBe('bootstrap');
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
    launch();
    noteRendererReady();
    noteQuitting();
    expect(onDisk().failures).toBe(0);
    expect(onDisk().pending).toBeNull();
  });

  it('a quit long after load with no ready ping counts as a failure', () => {
    launch(0);
    noteMainWindowLoaded(0);
    noteQuitting(NEVER_READY_QUIT_MS + 1);
    expect(onDisk().failures).toBe(1);
    expect(onDisk().lastFailure?.kind).toBe('renderer_never_ready');
  });

  it('a quit during the splash is neutral', () => {
    launch();
    noteQuitting();
    expect(onDisk().failures).toBe(0);
    expect(onDisk().pending).toBeNull();
  });

  it('an update hand-over is neutral', () => {
    launch();
    noteNeutralExit();
    expect(onDisk().pending).toBeNull();
    expect(launch(2).mode).toBe('normal');
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

  it('non-persistent (dev) keeps state in memory only and never relaunches', () => {
    initBootGuard({ userData: tmp, appVersion: '0.7.0', persistent: false, forceSafe: false, now: 1 });
    const relaunch = vi.fn();
    const enter = vi.fn();
    setRelaunch(relaunch);
    setSafeModeEntry(enter);
    reportStartupFailure('module_load', new TypeError('secret path /home/x'));
    expect(relaunch).not.toHaveBeenCalled();
    expect(enter).toHaveBeenCalledWith('module_load');
    expect(onDisk().pending).toBeNull(); // nothing on disk
    expect(_bootStateForTests().failures).toBe(1);
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
