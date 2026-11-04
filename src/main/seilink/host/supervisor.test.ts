import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HostSupervisor, hostBackoffMs, type HostChild } from './supervisor';

interface FakeChild extends HostChild {
  exit(code?: number | null, signal?: string | null): void;
}

function harness(opts?: { maxRestarts?: number; restartWindowMs?: number }) {
  let nextPid = 100;
  const children: FakeChild[] = [];
  const killed: number[] = [];
  const spawned: number[] = [];
  const sup = new HostSupervisor({
    spawn: () => {
      const pid = nextPid++;
      let cb: ((c: number | null, s: string | null) => void) | null = null;
      const child: FakeChild = {
        pid,
        onExit: (f) => {
          cb = f;
        },
        exit: (code = 1, signal = null) => cb?.(code, signal),
      };
      children.push(child);
      spawned.push(Date.now());
      return child;
    },
    kill: (pid) => {
      killed.push(pid);
      // A kill makes the process exit a moment later.
      const c = children.find((x) => x.pid === pid);
      setTimeout(() => c?.exit(null, 'SIGKILL'), 10);
    },
    ...(opts?.maxRestarts ? { maxRestarts: opts.maxRestarts } : {}),
    ...(opts?.restartWindowMs ? { restartWindowMs: opts.restartWindowMs } : {}),
  });
  const live = (): FakeChild => children[children.length - 1];
  const hello = (): void => {
    expect(sup.acceptHello(live().pid)).toBe(true);
  };
  const attach = (): void => sup.onHostMessage(live().pid, { type: 'attached', reattach: false, reason: 'initial', layout: 'raised', attachMs: 5 });
  const beat = (): void =>
    sup.onHostMessage(live().pid, { type: 'heartbeat', fps: 30, frames: 1, effectiveFps: 30, covered: false, paused: false, attached: true, cpu: 0, ramMB: 0 });
  return { sup, children, killed, spawned, live, hello, attach, beat };
}

describe('seilink host supervisor', () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
  afterEach(() => vi.useRealTimers());

  it('backs off 0, 0.5, 1, 2, 4, 8, then 10 s', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 20].map(hostBackoffMs)).toEqual([0, 500, 1000, 2000, 4000, 8000, 10000, 10000, 10000]);
  });

  it('restarts a crashed host at once, then with backoff', () => {
    const h = harness();
    const delays: number[] = [];
    h.sup.on('restart', (e: { delay: number }) => delays.push(e.delay));
    h.sup.start();
    for (let i = 0; i < 4; i++) {
      h.hello();
      h.attach();
      h.live().exit(1);
      vi.advanceTimersByTime(10_000);
    }
    expect(delays).toEqual([0, 500, 1000, 2000]);
    expect(h.children).toHaveLength(5);
  });

  it('resets the streak once a host stayed up', () => {
    const h = harness();
    const delays: number[] = [];
    h.sup.on('restart', (e: { delay: number }) => delays.push(e.delay));
    h.sup.start();
    h.hello();
    h.attach();
    h.live().exit(1);
    vi.advanceTimersByTime(0);
    h.hello();
    h.attach();
    for (let i = 0; i < 25; i++) {
      vi.advanceTimersByTime(1000);
      h.beat();
    }
    h.live().exit(1);
    expect(delays).toEqual([0, 0]);
  });

  it('kills a host that stops beating (hung) after about 3 s and brings a new one', () => {
    const h = harness();
    const hung = vi.fn();
    h.sup.on('hung', hung);
    h.sup.start();
    h.hello();
    h.attach();
    const first = h.live().pid;
    h.beat();
    vi.advanceTimersByTime(2500);
    expect(hung).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(hung).toHaveBeenCalledTimes(1);
    expect(h.killed).toEqual([first]);
    vi.advanceTimersByTime(100);
    expect(h.live().pid).not.toBe(first);
  });

  it('kills a host that never says hello', () => {
    const h = harness();
    h.sup.start();
    vi.advanceTimersByTime(19_000);
    expect(h.killed).toEqual([]);
    vi.advanceTimersByTime(2000);
    expect(h.killed).toEqual([h.children[0].pid]);
  });

  it('ignores messages and hellos from anything but the live host', () => {
    const h = harness();
    const msgs = vi.fn();
    h.sup.on('message', msgs);
    h.sup.start();
    expect(h.sup.acceptHello(9999)).toBe(false);
    h.sup.onHostMessage(9999, { type: 'click', kind: 'click' });
    expect(msgs).not.toHaveBeenCalled();
    h.hello();
    h.sup.onHostMessage(h.live().pid, { type: 'click', kind: 'click' });
    expect(msgs).toHaveBeenCalledTimes(1);
  });

  it('gives up after 5 restarts within 10 min of starts that never attach', () => {
    const h = harness();
    const gaveUp = vi.fn();
    h.sup.on('gave-up', gaveUp);
    h.sup.start();
    for (let i = 0; i < 6; i++) {
      h.hello();
      h.live().exit(3);
      vi.advanceTimersByTime(10_000);
    }
    expect(gaveUp).toHaveBeenCalledTimes(1);
    expect(gaveUp.mock.calls[0][0]).toMatchObject({ restarts: 5, everAttached: false });
    expect(h.sup.running).toBe(false);
    // The first host plus 5 restarts, then nothing more.
    expect(h.children).toHaveLength(6);
    vi.advanceTimersByTime(60 * 60_000);
    expect(h.children).toHaveLength(6);
  });

  it('gives up on a host that attaches and then crashes every time (no endless restarts)', () => {
    const h = harness();
    const gaveUp = vi.fn();
    h.sup.on('gave-up', gaveUp);
    h.sup.start();
    // Each host attaches, beats for a while past the stable time, then crashes.
    for (let i = 0; i < 10 && h.sup.running; i++) {
      h.hello();
      h.attach();
      for (let k = 0; k < 25; k++) {
        vi.advanceTimersByTime(1000);
        h.beat();
      }
      h.live().exit(1);
      vi.advanceTimersByTime(10_000);
    }
    expect(gaveUp).toHaveBeenCalledTimes(1);
    expect(gaveUp.mock.calls[0][0]).toMatchObject({ restarts: 5, everAttached: true });
    expect(h.sup.running).toBe(false);
    expect(h.children).toHaveLength(6);
  });

  it('only counts restarts inside the window', () => {
    const h = harness({ maxRestarts: 2, restartWindowMs: 60_000 });
    const gaveUp = vi.fn();
    h.sup.on('gave-up', gaveUp);
    h.sup.start();
    for (let i = 0; i < 6; i++) {
      h.hello();
      h.attach();
      // Crashes 40 s apart: never more than 2 restarts inside any 60 s.
      for (let k = 0; k < 40; k++) {
        vi.advanceTimersByTime(1000);
        h.beat();
      }
      h.live().exit(1);
      vi.advanceTimersByTime(0);
    }
    expect(gaveUp).not.toHaveBeenCalled();
    expect(h.children).toHaveLength(7);
  });

  it('a new start() begins a new count', () => {
    const h = harness({ maxRestarts: 1 });
    const gaveUp = vi.fn();
    h.sup.on('gave-up', gaveUp);
    h.sup.start();
    h.live().exit(1);
    vi.advanceTimersByTime(10_000);
    h.live().exit(1);
    expect(gaveUp).toHaveBeenCalledTimes(1);
    expect(h.sup.running).toBe(false);
    h.sup.start();
    h.live().exit(1);
    vi.advanceTimersByTime(10_000);
    expect(gaveUp).toHaveBeenCalledTimes(1);
    expect(h.sup.running).toBe(true);
  });

  it('stop without kill leaves the host to quit by itself and never restarts it', () => {
    const h = harness();
    h.sup.start();
    h.hello();
    h.attach();
    const pid = h.live().pid;
    expect(h.sup.stop({ kill: false })).toBe(pid);
    expect(h.killed).toEqual([]);
    h.live().exit(0);
    vi.advanceTimersByTime(30_000);
    expect(h.children).toHaveLength(1);
    expect(h.sup.pid).toBeNull();
  });

  it('stop kills by default; recycle kills and restarts', () => {
    const h = harness();
    h.sup.start();
    h.hello();
    h.attach();
    h.sup.recycle('attach-failed');
    vi.advanceTimersByTime(100);
    expect(h.children).toHaveLength(2);
    h.sup.stop();
    expect(h.killed).toEqual([h.children[0].pid, h.children[1].pid]);
    vi.advanceTimersByTime(30_000);
    expect(h.children).toHaveLength(2);
  });
});
