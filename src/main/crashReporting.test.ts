/**
 * 261031 (T278): crash reporting core. Unclean-exit detection across
 * launches (the session marker), crash payload scrubbing (log vs PostHog),
 * per-process caps, renderer / child process / hang events.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: {}, powerMonitor: {} }));

import {
  CRASH_EVENT_CAP,
  CRASH_LOG_REPEATS,
  ERROR_EVENT_CAP,
  cleanToken,
  createCrashReporter,
  pageName,
  serviceToken,
  type CrashReporterDeps,
} from './crashReporting';
import { CRASH_LOG_FILE, setCrashRedactNames } from './crashLog';
import { readPreviousSession, SESSION_MARKER_FILE } from './sessionMarker';

let dir: string;
let crashDir: string;
let markerFile: string;
let events: Array<{ event: string; props: Record<string, unknown> }>;

function launch(over: Partial<CrashReporterDeps> = {}) {
  return createCrashReporter({
    crashDir,
    markerFile,
    version: '0.7.0',
    channel: 'stable',
    packaged: true,
    sessionId: `s-${Math.random()}`,
    capture: (event, props) => events.push({ event, props }),
    surface: () => 'minecraft',
    ...over,
  });
}

function crashLog(): string {
  const f = path.join(crashDir, CRASH_LOG_FILE);
  return existsSync(f) ? readFileSync(f, 'utf8') : '';
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'sei-crash-'));
  crashDir = path.join(dir, 'logs', 'crash');
  markerFile = path.join(dir, SESSION_MARKER_FILE);
  events = [];
  setCrashRedactNames([]);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('unclean exit detection across launches', () => {
  it('first launch with this code reports prev_exit none and no unclean-exit event', () => {
    const r = launch();
    expect(r.appOpenedProps()).toEqual({ prev_exit: 'none', prev_version: null });
    expect(events).toEqual([]);
    // The marker is open while the session runs.
    expect(readPreviousSession(markerFile).prevExit).toBe('unclean');
  });

  it('a session that quit cleanly is clean on the next launch', () => {
    launch().close('closed');
    const next = launch({ version: '0.7.1' });
    expect(next.appOpenedProps()).toEqual({ prev_exit: 'clean', prev_version: '0.7.0' });
    expect(events.find((e) => e.event === 'app_unclean_exit')).toBeUndefined();
  });

  it('a session that died open is reported once by the next launch, with uptime and surface', () => {
    let t = 1_000_000;
    const first = launch({ now: () => t });
    t += 60_000;
    first.noteSurface('voice');
    t += 120_000;
    first.heartbeat();
    first.onUnresponsive(1, 'index');
    // ...killed here: no close().
    t += 3_600_000;
    const second = launch({ version: '0.7.1', now: () => t });
    expect(second.appOpenedProps()).toEqual({ prev_exit: 'unclean', prev_version: '0.7.0' });
    const ev = events.filter((e) => e.event === 'app_unclean_exit');
    expect(ev).toHaveLength(1);
    expect(ev[0].props).toMatchObject({
      prev_version: '0.7.0',
      prev_channel: 'stable',
      prev_packaged: true,
      prev_uptime_ms: 180_000,
      prev_surface: 'voice',
      prev_renderer_unresponsive: true,
    });
    expect(crashLog()).toContain('unclean_exit');
    // The second launch's own marker replaced the first: a third launch after
    // a clean quit is clean again.
    second.close('closed');
    events = [];
    expect(launch().appOpenedProps().prev_exit).toBe('clean');
    expect(events).toEqual([]);
  });

  it('an OS shutdown is not an unclean exit, and a later quit cannot reopen it', () => {
    const r = launch();
    r.close('os_shutdown');
    r.close('closed');
    r.heartbeat();
    expect(launch().appOpenedProps().prev_exit).toBe('os_shutdown');
    expect(events.find((e) => e.event === 'app_unclean_exit')).toBeUndefined();
  });

  it('a quit whose teardown hung is reported as quit_hang, a finished one as clean', () => {
    const r = launch();
    r.closing();
    r.heartbeat();
    // ...killed during the teardown: no close().
    const next = launch();
    expect(next.appOpenedProps().prev_exit).toBe('quit_hang');
    const ev = events.filter((e) => e.event === 'app_unclean_exit');
    expect(ev).toHaveLength(1);
    expect(ev[0].props.prev_exit).toBe('quit_hang');
    expect(crashLog()).toContain('quit_hang');
    next.closing();
    next.close('closed');
    events = [];
    expect(launch().appOpenedProps().prev_exit).toBe('clean');
    expect(events).toEqual([]);
  });

  it('a failed start is reported as start_failed, never as clean', () => {
    const r = launch();
    r.close('start_failed');
    // app.exit(1) then emits 'quit'; the first end state wins.
    r.close('closed');
    const next = launch();
    expect(next.appOpenedProps().prev_exit).toBe('start_failed');
    expect(events.filter((e) => e.event === 'app_unclean_exit').map((e) => e.props.prev_exit)).toEqual(['start_failed']);
  });

  it('a plain crash carries prev_exit unclean on app_unclean_exit', () => {
    launch();
    launch();
    expect(events.find((e) => e.event === 'app_unclean_exit')?.props.prev_exit).toBe('unclean');
  });

  it('a torn or foreign marker file reads as none, never as a crash', () => {
    writeFileSync(markerFile, '{"v":1,"state":"op');
    expect(launch().appOpenedProps().prev_exit).toBe('none');
    writeFileSync(markerFile, JSON.stringify({ hello: 'world' }));
    expect(launch().appOpenedProps().prev_exit).toBe('none');
    expect(events).toEqual([]);
  });

  it('the previous session crash kind rides on the unclean exit', () => {
    const r = launch();
    r.onRendererGone({ reason: 'crashed', exitCode: -1073741819, page: 'index' });
    events = [];
    launch();
    expect(events[0].props.prev_crash_kind).toBe('renderer_gone');
  });
});

describe('crash payload scrubbing', () => {
  const secretError = (): Error => {
    const e = new TypeError(
      "Cannot read 'x' of undefined for Steve at C:\\Users\\alice\\AppData\\sei key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA mail bob@example.com",
    );
    e.stack = `${e.name}: ${e.message}\n    at loadThing (C:\\Users\\alice\\AppData\\Local\\Programs\\Sei\\resources\\app.asar\\dist\\main\\index.js:120:17)\n    at next (/Users/alice/sei/dist/main/chunk.js:9:3)`;
    return e;
  };

  it('PostHog gets only shape: class name, fingerprint, top frame without a path', () => {
    setCrashRedactNames(['Steve']);
    const r = launch();
    r.onUncaught(secretError());
    const ev = events.find((e) => e.event === 'app_crash')!;
    expect(ev.props).toMatchObject({
      kind: 'main_uncaught',
      process_type: 'main',
      error_name: 'TypeError',
      top_frame: 'index.js:120:17',
      surface: 'minecraft',
    });
    expect(ev.props.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    const json = JSON.stringify(ev.props);
    for (const leak of ['alice', 'Steve', 'sk-ant', 'bob@', 'Cannot read', 'AppData']) {
      expect(json).not.toContain(leak);
    }
  });

  it('the crash log keeps the message and stack, scrubbed through redact()', () => {
    setCrashRedactNames(['Steve']);
    launch().onUncaught(secretError());
    const log = crashLog();
    expect(log).toContain('main_uncaught');
    expect(log).toContain('Cannot read');
    expect(log).toContain('index.js:120:17');
    expect(log).toContain('[player]');
    for (const leak of ['alice', 'Steve', 'sk-ant-api03-AAAA', 'bob@example.com']) {
      expect(log).not.toContain(leak);
    }
  });

  it('the same bug fingerprints the same on two machines', () => {
    setCrashRedactNames(['Steve']);
    const a = launch();
    a.onUncaught(secretError());
    setCrashRedactNames(['Alex']);
    const other = new TypeError(
      "Cannot read 'y' of undefined for Alex at D:\\Users\\zed\\AppData\\sei key sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBBBB mail z@example.org",
    );
    other.stack = `${other.name}: ${other.message}\n    at loadThing (D:\\Users\\zed\\Sei\\resources\\app.asar\\dist\\main\\index.js:120:17)\n    at next (/Users/zed/x/dist/main/chunk.js:9:3)`;
    const b = launch();
    b.onUncaught(other);
    const fps = events.filter((e) => e.event === 'app_crash').map((e) => e.props.fingerprint);
    expect(fps).toHaveLength(2);
    expect(fps[0]).toBe(fps[1]);
  });

  it('non-Error rejections are named, never stringified into the event', () => {
    const r = launch();
    r.onRejection({ token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijk' });
    r.onRejection('plain string with bob@example.com');
    const ev = events.filter((e) => e.event === 'app_error');
    expect(ev.map((e) => e.props.error_name)).toEqual(['NonError', 'StringError']);
    expect(JSON.stringify(ev)).not.toMatch(/eyJ|bob@/);
    expect(crashLog()).not.toMatch(/eyJhbGciOiJIUzI1NiJ9\.eyJ|bob@example\.com/);
  });
});

describe('caps and dedupe', () => {
  it('one event per fingerprint, the log stops after CRASH_LOG_REPEATS', () => {
    const r = launch();
    for (let i = 0; i < 20; i++) r.onRejection(new Error('same thing'));
    expect(events.filter((e) => e.event === 'app_error')).toHaveLength(1);
    const blocks = crashLog().split('main_unhandled_rejection').length - 1;
    expect(blocks).toBe(CRASH_LOG_REPEATS);
    expect(crashLog()).toContain('further_repeats=not_logged');
  });

  it('never more than ERROR_EVENT_CAP app_error and CRASH_EVENT_CAP events in a process', () => {
    const r = launch();
    for (let i = 0; i < 100; i++) {
      const e = new Error(`distinct ${'x'.repeat(i)}`);
      e.name = `E${i}`;
      r.onRejection(e);
      r.onUncaught(e);
    }
    expect(events.filter((e) => e.event === 'app_error')).toHaveLength(ERROR_EVENT_CAP);
    expect(events).toHaveLength(CRASH_EVENT_CAP);
  });
});

describe('renderer, child process and hang events', () => {
  it('renderer_gone carries page, reason and exit code; a clean exit is ignored', () => {
    const r = launch();
    r.onRendererGone({ reason: 'clean-exit', exitCode: 0, page: 'index' });
    r.onRendererGone({ reason: 'oom', exitCode: -536870904, page: 'overlay' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'app_crash',
      props: { kind: 'renderer_gone', process_type: 'renderer', page: 'overlay', reason: 'oom', exit_code: -536870904 },
    });
  });

  it('a GPU crash is reported; a companion bot exit only reaches the local log', () => {
    const r = launch();
    r.onChildGone({ type: 'GPU', reason: 'crashed', exitCode: 1, name: 'GPU' });
    r.onChildGone({ type: 'Utility', reason: 'crashed', exitCode: 1, serviceName: 'sei-bot-0f3c9a2e-1111' });
    r.onChildGone({ type: 'Utility', reason: 'killed', exitCode: 9, serviceName: 'sei-bot-abc' });
    expect(events).toHaveLength(1);
    expect(events[0].props).toMatchObject({ kind: 'child_gone', process_type: 'gpu', service: 'GPU', reason: 'crashed' });
    const log = crashLog();
    expect(log).toContain('bot_gone');
    expect(log).not.toContain('0f3c9a2e');
    expect(log.split('bot_gone').length - 1).toBe(1);
  });

  it('a hang is one app_hang when the window recovers, with its duration', () => {
    let t = 0;
    const r = launch({ now: () => t });
    r.onUnresponsive(7, 'index');
    r.onUnresponsive(7, 'index');
    t += 12_000;
    r.onResponsive(7);
    r.onResponsive(7);
    expect(events).toEqual([
      { event: 'app_hang', props: expect.objectContaining({ page: 'index', duration_ms: 12_000, recovered: true }) },
    ]);
    // Recovered: the marker no longer says unresponsive.
    r.heartbeat();
    expect(readPreviousSession(markerFile).marker?.renderer_unresponsive).toBe(false);
  });

  it('a window closed while hung reports recovered: false', () => {
    const r = launch();
    r.onUnresponsive(3, 'index');
    r.onWindowClosed(3);
    expect(events[0].props).toMatchObject({ recovered: false });
  });
});

describe('helpers', () => {
  it('pageName keeps only our html file name', () => {
    expect(pageName('file:///C:/Users/alice/AppData/Local/Programs/Sei/resources/app.asar/dist/renderer/index.html#/home')).toBe('index');
    expect(pageName('file:///x/overlay.html?y=1')).toBe('overlay');
    expect(pageName('http://localhost:5173/')).toBe('index');
    expect(pageName('about:blank')).toBe('blank');
    expect(pageName('not a url')).toBe('unknown');
  });

  it('serviceToken strips the bot id and rejects id-like names', () => {
    expect(serviceToken('sei-bot-1234', undefined)).toBe('sei_bot');
    expect(serviceToken('network.mojom.NetworkService', undefined)).toBe('network.mojom.NetworkService');
    expect(serviceToken('worker-0f3c9a2e77', undefined)).toBe('other');
    expect(serviceToken(undefined, undefined)).toBeNull();
  });

  it('cleanToken normalizes Electron reasons', () => {
    expect(cleanToken('abnormal-exit')).toBe('abnormal_exit');
    expect(cleanToken('launch-failed')).toBe('launch_failed');
    expect(cleanToken('<script>')).toBe('unknown');
    expect(cleanToken(undefined)).toBe('unknown');
  });
});
