/**
 * 261107: a launch by "Open Sei when I log in" (loginLaunch.ts): telling it
 * apart, the hidden state, the quiet quit, deferred start work, and Windows
 * staying resident for her room.
 */
import { describe, expect, it, vi } from 'vitest';
import { isLoginLaunch, isLoginLaunchArgv, keepRunningWithoutWindows, LoginLaunch } from './loginLaunch';
import { LOGIN_ARG } from './openAtLogin';
import { LOGIN_LAUNCH_EVENT, LOGIN_LAUNCH_OPENED_EVENT } from '../../shared/openAtLogin';

const exe = 'C:\\Users\\robin\\AppData\\Local\\Sei\\current\\Sei.exe';

describe('isLoginLaunch', () => {
  it('Windows: only the marker arg the Run value passes', () => {
    const wasOpened = vi.fn(() => true);
    expect(isLoginLaunch({ platform: 'win32', argv: [exe, LOGIN_ARG], wanted: false, macWasOpenedAtLogin: wasOpened })).toBe(true);
    expect(isLoginLaunch({ platform: 'win32', argv: [exe], wanted: true, macWasOpenedAtLogin: wasOpened })).toBe(false);
    // The retired tray item's --hidden is not a login launch any more.
    expect(isLoginLaunch({ platform: 'win32', argv: [exe, '--hidden'], wanted: true, macWasOpenedAtLogin: wasOpened })).toBe(false);
    expect(wasOpened).not.toHaveBeenCalled();
  });

  it('macOS: wasOpenedAtLogin, and only while Sei\'s own setting is on', () => {
    const argv = ['/Applications/Sei.app/Contents/MacOS/Sei'];
    expect(isLoginLaunch({ platform: 'darwin', argv, wanted: true, macWasOpenedAtLogin: () => true })).toBe(true);
    expect(isLoginLaunch({ platform: 'darwin', argv, wanted: true, macWasOpenedAtLogin: () => false })).toBe(false);
    // A login item the user added by hand keeps opening the window.
    const read = vi.fn(() => true);
    expect(isLoginLaunch({ platform: 'darwin', argv, wanted: false, macWasOpenedAtLogin: read })).toBe(false);
    expect(read).not.toHaveBeenCalled();
    expect(
      isLoginLaunch({
        platform: 'darwin',
        argv,
        wanted: true,
        macWasOpenedAtLogin: () => {
          throw new Error('x');
        },
      }),
    ).toBe(false);
  });

  it('never on Linux, and a second launch with the marker is recognised', () => {
    expect(isLoginLaunch({ platform: 'linux', argv: [LOGIN_ARG], wanted: true, macWasOpenedAtLogin: () => true })).toBe(false);
    expect(isLoginLaunchArgv([exe, LOGIN_ARG])).toBe(true);
    expect(isLoginLaunchArgv([exe, '--seilink-host'])).toBe(false);
  });
});

function make(login: boolean) {
  let t = 1000;
  const quit = vi.fn();
  const events: Array<[string, Record<string, unknown>]> = [];
  const l = new LoginLaunch(login, {
    quit,
    capture: (e, p) => events.push([e, p]),
    log: () => {},
    now: () => t,
  });
  return { l, quit, events, advance: (ms: number) => (t += ms) };
}

describe('LoginLaunch', () => {
  it('a normal launch is never hidden, runs start work at once and sends nothing', () => {
    const { l, quit, events } = make(false);
    const fn = vi.fn();
    l.afterReveal(fn);
    expect(fn).toHaveBeenCalledTimes(1);
    l.startupSettled(false);
    l.roomEnded();
    expect(l.isHidden()).toBe(false);
    expect(quit).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('defers start work (the LLM check, the Velopack migration) until the window is first shown', () => {
    const { l, events, advance } = make(true);
    const nextSteps = vi.fn();
    const migration = vi.fn(() => {
      throw new Error('boom');
    });
    const after = vi.fn();
    l.afterReveal(nextSteps);
    l.afterReveal(migration);
    l.afterReveal(after);
    l.startupSettled(true);
    expect(nextSteps).not.toHaveBeenCalled();
    advance(42_000);
    l.revealed('room');
    expect(nextSteps).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1); // one throwing task does not stop the rest
    expect(l.isHidden()).toBe(false);
    expect(events).toEqual([
      [LOGIN_LAUNCH_EVENT, { outcome: 'room', opened: false }],
      [LOGIN_LAUNCH_OPENED_EVENT, { via: 'room', after_ms: 42_000 }],
    ]);
    // Only the first show counts.
    l.revealed('dock');
    expect(events).toHaveLength(2);
    expect(nextSteps).toHaveBeenCalledTimes(1);
  });

  it('nothing to show = quits quietly and drops the deferred work', () => {
    const { l, quit, events } = make(true);
    const fn = vi.fn();
    l.afterReveal(fn);
    l.startupSettled(false);
    expect(quit).toHaveBeenCalledWith('nothing_to_show');
    expect(events).toEqual([[LOGIN_LAUNCH_EVENT, { outcome: 'nothing_to_show', opened: false }]]);
    l.revealed('dock');
    l.afterReveal(fn);
    expect(fn).not.toHaveBeenCalled();
    l.startupSettled(false);
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('opened before the restore finished: no quit even with no room', () => {
    const { l, quit, events } = make(true);
    l.revealed('second_launch');
    l.startupSettled(false);
    expect(quit).not.toHaveBeenCalled();
    expect(events[1]).toEqual([LOGIN_LAUNCH_EVENT, { outcome: 'nothing_to_show', opened: true }]);
  });

  it('her room ending while still hidden quits; after a show it does not', () => {
    const a = make(true);
    a.l.roomEnded(); // before the startup restore settled: a restart in progress, not an end
    expect(a.quit).not.toHaveBeenCalled();
    a.l.startupSettled(true);
    a.l.roomEnded();
    expect(a.quit).toHaveBeenCalledWith('room_ended');
    const b = make(true);
    b.l.startupSettled(true);
    b.l.revealed('room');
    b.l.roomEnded();
    expect(b.quit).not.toHaveBeenCalled();
  });
});

describe('keepRunningWithoutWindows', () => {
  it('Windows stays for her room only when the user asked for Sei at login', () => {
    expect(keepRunningWithoutWindows({ platform: 'win32', roomUp: true, wanted: true, loginLaunch: false })).toBe(true);
    expect(keepRunningWithoutWindows({ platform: 'win32', roomUp: true, wanted: false, loginLaunch: true })).toBe(true);
    expect(keepRunningWithoutWindows({ platform: 'win32', roomUp: true, wanted: false, loginLaunch: false })).toBe(false);
    expect(keepRunningWithoutWindows({ platform: 'win32', roomUp: false, wanted: true, loginLaunch: true })).toBe(false);
    // macOS stays anyway (window-all-closed never quits there); Linux unchanged.
    expect(keepRunningWithoutWindows({ platform: 'darwin', roomUp: true, wanted: true, loginLaunch: true })).toBe(false);
    expect(keepRunningWithoutWindows({ platform: 'linux', roomUp: true, wanted: true, loginLaunch: true })).toBe(false);
  });
});
