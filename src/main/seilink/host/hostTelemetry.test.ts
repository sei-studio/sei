import { describe, expect, it } from 'vitest';
import {
  Counters,
  HealthSampler,
  SHOWN_DEADLINE_MS,
  ShownWatchdog,
  attachMode,
  gpuState,
  histPercentile,
  memoryBucket,
  reattachCause,
  resolutionBucket,
  scaleBucket,
  verifyReasonList,
  type HeartbeatSample,
} from './hostTelemetry';

const visible: HeartbeatSample = { fps: 30, effectiveFps: 30, covered: false, paused: false, attached: true, cpu: 2, ramMB: 240 };
const frameOk = { verified: true, hidden: false, covered: false, paused: false, reasons: [] };

describe('shapes', () => {
  it('maps the attach layout to a mode', () => {
    expect(attachMode('raised')).toBe('progman');
    expect(attachMode('classic')).toBe('workerw');
    expect(attachMode('mac 15.4')).toBe('mac_desktop_level');
    expect(attachMode('fake')).toBe('fake');
    expect(attachMode('C:\\Users\\x')).toBe('other');
  });

  it('buckets resolution, scale, memory and gpu', () => {
    expect(resolutionBucket(1920, 1080)).toBe('1080p');
    expect(resolutionBucket(2560, 1440)).toBe('1440p');
    expect(resolutionBucket(3840, 2160)).toBe('4k');
    expect(resolutionBucket(1080, 1920)).toBe('1080p');
    expect(resolutionBucket(1366, 768)).toBe('lt_900p');
    expect(resolutionBucket(0, 0)).toBe('unknown');
    expect(scaleBucket(1.3333)).toBe(1.25);
    expect(scaleBucket('x')).toBeNull();
    expect(memoryBucket(120)).toBe('lt_150');
    expect(memoryBucket(450)).toBe('300_500');
    expect(memoryBucket(5000)).toBe('gt_1200');
    expect(gpuState('enabled_on')).toBe('on');
    expect(gpuState('disabled_software')).toBe('off');
    expect(gpuState(undefined)).toBe('unknown');
  });

  it('keeps verify reasons to the closed set', () => {
    expect(verifyReasonList(['no-workerw', 'hidden', 'no-workerw', 'C:\\secret'])).toEqual(['hidden', 'no_workerw', 'other']);
    expect(verifyReasonList('no')).toEqual([]);
  });
});

describe('reattachCause', () => {
  it('reads the trigger and what was wrong', () => {
    expect(reattachCause('validate:taskbarCreated:no-workerw')).toEqual({ cause: 'explorer_restart', detail: 'workerw_lost' });
    expect(reattachCause('validate:taskbarCreated+1500:parent-not-progman+no-workerw')).toEqual({ cause: 'explorer_restart', detail: 'workerw_lost' });
    expect(reattachCause('validate:displayChange:size-mismatch')).toEqual({ cause: 'display_change', detail: 'size_mismatch' });
    expect(reattachCause('validate:display+1500:size-mismatch')).toEqual({ cause: 'display_change', detail: 'size_mismatch' });
    expect(reattachCause('validate:timer:parent-not-progman')).toEqual({ cause: 'periodic_check', detail: 'parent_lost' });
    expect(reattachCause('validate:timer:level')).toEqual({ cause: 'periodic_check', detail: 'level_drift' });
    expect(reattachCause('validate:resume:not-directly-below-defview')).toEqual({ cause: 'resume', detail: 'z_order' });
    expect(reattachCause('validate:session:x')).toEqual({ cause: 'session_change', detail: 'other' });
    expect(reattachCause('own-window-gone')).toEqual({ cause: 'window_lost', detail: 'window_gone' });
    expect(reattachCause('window-closed')).toEqual({ cause: 'window_lost', detail: 'window_gone' });
    expect(reattachCause('initial')).toEqual({ cause: 'other', detail: 'other' });
  });
});

describe('ShownWatchdog', () => {
  it('fires seilink_shown at the first verified, visible frame', () => {
    const w = new ShownWatchdog(1000);
    w.hello(1500);
    w.attached(2000, 'raised', 120.4);
    const e = w.onFrame(2400, frameOk);
    expect(e?.event).toBe('seilink_shown');
    expect(e?.props).toMatchObject({ first_frame_ms: 1400, attach_ms: 120, attach_mode: 'progman', late: false, covered_at_start: false });
    expect(w.shown).toBe(true);
    expect(w.onFrame(3000, frameOk)).toBeNull();
    expect(w.tick(1000 + SHOWN_DEADLINE_MS + 1)).toBeNull();
  });

  it('waits for an uncover when the room was covered at start, and says so at the deadline', () => {
    const w = new ShownWatchdog(0);
    w.hello(100);
    w.attached(200, 'classic', 50);
    expect(w.onFrame(300, { ...frameOk, covered: true })).toBeNull();
    const ns = w.tick(SHOWN_DEADLINE_MS);
    expect(ns?.event).toBe('seilink_not_shown');
    expect(ns?.props).toMatchObject({ reason: 'wallpaper_occluded_at_start', attach_mode: 'workerw' });
    expect(w.tick(SHOWN_DEADLINE_MS + 5000)).toBeNull();
    const shown = w.onActivity(60_000, { covered: false, paused: false });
    expect(shown?.event).toBe('seilink_shown');
    expect(shown?.props).toMatchObject({ late: true, covered_at_start: true, first_frame_ms: 60_000 });
  });

  it('names the stage it got stuck at', () => {
    const at = (fn: (w: ShownWatchdog) => void): string => {
      const w = new ShownWatchdog(0);
      fn(w);
      return String(w.tick(SHOWN_DEADLINE_MS)?.props.reason);
    };
    expect(at(() => {})).toBe('no_hello');
    expect(at((w) => w.hello(10))).toBe('no_attach');
    expect(
      at((w) => {
        w.hello(10);
        w.attachFailed('no_workerw');
      }),
    ).toBe('attach_failed');
    expect(
      at((w) => {
        w.hello(10);
        w.attached(20, 'raised', 1);
      }),
    ).toBe('no_frame');
    expect(
      at((w) => {
        w.attached(20, 'raised', 1);
        w.onFrame(30, { ...frameOk, hidden: true });
      }),
    ).toBe('window_hidden');
    expect(
      at((w) => {
        w.attached(20, 'raised', 1);
        w.onFrame(30, { ...frameOk, verified: false, reasons: ['parent_not_progman'] });
      }),
    ).toBe('not_verified');
    expect(
      at((w) => {
        w.attached(20, 'mac 15', 1);
        w.onFrame(30, { ...frameOk, paused: true });
      }),
    ).toBe('paused_at_start');
  });

  it('carries the failure class, and forgets a frame from a lost attach', () => {
    const w = new ShownWatchdog(0);
    w.hello(1);
    w.attachFailed('set_parent_failed');
    const e = w.tick(SHOWN_DEADLINE_MS);
    expect(e?.props).toMatchObject({ reason: 'attach_failed', failure_class: 'set_parent_failed' });
    const w2 = new ShownWatchdog(0);
    w2.hello(1);
    w2.attached(5, 'raised', 1);
    w2.onFrame(6, { ...frameOk, covered: true });
    w2.detached();
    expect(w2.onActivity(7, { covered: false, paused: false })).toBeNull();
    expect(w2.reason()).toBe('no_attach');
  });

  it('does nothing before the deadline', () => {
    const w = new ShownWatchdog(0);
    expect(w.tick(SHOWN_DEADLINE_MS - 1)).toBeNull();
  });
});

describe('HealthSampler', () => {
  it('computes fps percentiles while visible and time shares', () => {
    const h = new HealthSampler(0);
    let t = 0;
    // 10 s visible: fps 30 x8, 20 x1, 10 x1 (the first beat only anchors).
    const fps = [30, 30, 30, 30, 20, 30, 30, 30, 10, 30, 30];
    for (const f of fps) h.heartbeat((t += 1000), { ...visible, effectiveFps: f });
    // 5 s covered, 5 s paused.
    for (let i = 0; i < 5; i++) h.heartbeat((t += 1000), { ...visible, covered: true, fps: 0, effectiveFps: 0 });
    for (let i = 0; i < 5; i++) h.heartbeat((t += 1000), { ...visible, paused: true, fps: 0, effectiveFps: 0 });
    const p = h.sessionProps(t);
    expect(p.fps_p50).toBe(30);
    expect(p.fps_p5).toBe(10);
    expect(p.fps_samples).toBe(10);
    expect(p.visible_pct).toBeCloseTo(55, 0);
    expect(p.covered_pct).toBeCloseTo(25, 0);
    expect(p.paused_pct).toBeCloseTo(20, 0);
    expect(p.heartbeat_misses).toBe(0);
    expect(p.dropped_frames_est).toBe(30);
    expect(p.mem_bucket).toBe('150_300');
  });

  it('counts heartbeat gaps but not a sleep or a host restart', () => {
    const h = new HealthSampler(0);
    h.heartbeat(1000, visible);
    h.heartbeat(5000, visible); // 4 s gap: a miss
    h.suspend();
    h.heartbeat(60_000, visible);
    h.resume();
    h.heartbeat(120_000, visible);
    h.heartbeat(121_000, visible);
    h.hostGone();
    h.heartbeat(140_000, visible);
    h.heartbeat(141_000, visible);
    expect(h.sessionProps(141_000).heartbeat_misses).toBe(1);
  });

  it('starts a new window after takeWindow, the session keeps everything', () => {
    const h = new HealthSampler(0);
    for (let t = 1000; t <= 5000; t += 1000) h.heartbeat(t, visible);
    const w1 = h.takeWindow(5000);
    expect(w1.fps_samples).toBe(4);
    expect(w1.window_ms).toBe(5000);
    h.heartbeat(6000, { ...visible, ramMB: 900 });
    const w2 = h.takeWindow(6000);
    expect(w2.fps_samples).toBe(1);
    expect(w2.mem_bucket).toBe('800_1200');
    expect(h.sessionProps(6000).fps_samples).toBe(5);
  });

  it('histPercentile', () => {
    expect(histPercentile([0, 0, 0], 50)).toBeNull();
    const bins = new Array(61).fill(0);
    bins[30] = 95;
    bins[5] = 5;
    expect(histPercentile(bins, 5)).toBe(5);
    expect(histPercentile(bins, 6)).toBe(30);
    expect(histPercentile(bins, 95)).toBe(30);
  });
});

describe('Counters', () => {
  it('counts, drops bad keys, and diffs a window', () => {
    const c = new Counters();
    c.add('clicks');
    c.add('clicks');
    c.add('Bad Key');
    const snap = c.snapshot();
    c.add('clicks');
    c.add('pokes', 2);
    expect(c.props()).toEqual({ clicks: 3, pokes: 2 });
    expect(c.diff(snap)).toEqual({ clicks: 1, pokes: 2 });
  });
});
