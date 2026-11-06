/**
 * The app's WorldLink progress source (261106 v6): Anima stages to link
 * milestones, failures, the host start, and the start stage for analytics.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnimaStatus } from '@shared/anima';

const h = vi.hoisted(() => ({
  listeners: [] as Array<(s: AnimaStatus) => void>,
  prepare: null as null | ((id: string, trigger: string) => Promise<AnimaStatus>),
}));
vi.mock('../ipcClient', () => ({
  sei: {
    onSeilinkAnima: (cb: (s: AnimaStatus) => void) => {
      h.listeners.push(cb);
      return () => h.listeners.splice(h.listeners.indexOf(cb), 1);
    },
    get seilinkAnimaPrepare() {
      return h.prepare ?? undefined;
    },
  },
}));

import { animaLinkSource, stageFailure, stageMilestones, statusEvents } from './animaLinkSource';
import { emptyLog, planLink, recordLink, type LinkEvent } from './worldLink';

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  h.listeners = [];
  h.prepare = null;
  const target = new EventTarget();
  // Resolved per call, so fake timers apply.
  vi.stubGlobal(
    'window',
    Object.assign(target, {
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimeout: (id: number) => clearTimeout(id),
    }),
  );
  vi.stubGlobal('navigator', { onLine: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('stage mapping', () => {
  it('each stage brings its milestones (a later one all before it)', () => {
    expect(stageMilestones('checking')).toEqual([]);
    expect(stageMilestones('requesting')).toEqual(['sent']);
    expect(stageMilestones('queued')).toEqual(['sent', 'answered']);
    expect(stageMilestones('running')).toEqual(['sent', 'answered', 'running']);
    expect(stageMilestones('downloading')).toEqual(['sent', 'answered', 'running', 'baked']);
    expect(stageMilestones('ready')).toEqual(['sent', 'answered', 'running', 'baked', 'installed']);
    // No pack will come: her fallback avatar is her look, the link still works.
    expect(stageMilestones('unavailable')).toEqual(stageMilestones('ready'));
    expect(stageMilestones(undefined)).toEqual(stageMilestones('ready'));
  });

  it('offline and failed end the link with their class', () => {
    expect(stageFailure('offline', undefined)).toBe('offline');
    expect(stageFailure('failed', 'timeout')).toBe('timeout');
    expect(stageFailure('failed', undefined)).toBe('error');
    expect(stageFailure('running', undefined)).toBeNull();
    expect(statusEvents({ stage: 'failed', failure: 'bake_failed' })).toEqual([{ kind: 'failed', failure: 'bake_failed' }]);
  });
});

describe('animaLinkSource', () => {
  it('follows the prepare answer, the pushes and the host start', async () => {
    let resolveHost!: (ok: boolean) => void;
    const host = new Promise<boolean>((r) => (resolveHost = r));
    h.prepare = vi.fn(async (id) => ({ characterId: id, state: 'preparing', stage: 'queued' }) as AnimaStatus);
    const src = animaLinkSource('c1', host);
    const events: LinkEvent[] = [];
    const off = src.subscribe!((e) => events.push(e));
    await flush();
    expect(h.prepare).toHaveBeenCalledWith('c1', 'host_start');
    expect(src.startStage!()).toBe('queued');
    expect(events).toEqual([
      { kind: 'milestone', milestone: 'sent' },
      { kind: 'milestone', milestone: 'answered' },
    ]);
    // Another companion's push is ignored; checking says nothing.
    h.listeners.forEach((l) => l({ characterId: 'c2', state: 'preparing', stage: 'downloading' }));
    h.listeners.forEach((l) => l({ characterId: 'c1', state: 'preparing', stage: 'checking' }));
    expect(events).toHaveLength(2);
    h.listeners.forEach((l) => l({ characterId: 'c1', state: 'ready', stage: 'ready' }));
    resolveHost(true);
    await flush();
    const log = emptyLog();
    events.forEach((e) => recordLink(log, e, 0));
    expect(planLink(log).lines).toHaveLength(9);
    expect(planLink(log).success).not.toBeNull();
    off();
    expect(h.listeners).toHaveLength(0);
  });

  it('the host failing fails the link', async () => {
    h.prepare = async (id) => ({ characterId: id, state: 'ready', stage: 'ready' }) as AnimaStatus;
    const events: LinkEvent[] = [];
    animaLinkSource('c1', Promise.resolve(false)).subscribe!((e) => events.push(e));
    await flush();
    expect(events).toContainEqual({ kind: 'failed', failure: 'host' });
  });

  it('no bridge: counts as unavailable (every milestone at once)', async () => {
    const events: LinkEvent[] = [];
    const src = animaLinkSource('c1', Promise.resolve(true));
    src.subscribe!((e) => events.push(e));
    await flush();
    expect(events.filter((e) => e.kind === 'milestone').map((e) => (e as { milestone: string }).milestone)).toEqual([
      'sent',
      'answered',
      'running',
      'baked',
      'installed',
      'host',
    ]);
    expect(src.startStage!()).toBe('none');
  });

  it('offline for 5 s fails it', async () => {
    vi.useFakeTimers();
    h.prepare = async (id) => ({ characterId: id, state: 'preparing', stage: 'running' }) as AnimaStatus;
    const events: LinkEvent[] = [];
    animaLinkSource('c1', new Promise(() => undefined)).subscribe!((e) => events.push(e));
    (navigator as { onLine: boolean }).onLine = false;
    window.dispatchEvent(new Event('offline'));
    await vi.advanceTimersByTimeAsync(4000);
    expect(events.some((e) => e.kind === 'failed')).toBe(false);
    await vi.advanceTimersByTimeAsync(1500);
    expect(events).toContainEqual({ kind: 'failed', failure: 'offline' });
  });
});
