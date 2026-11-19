/**
 * ChatTopBar (261119): the Beta tags and the one-time WorldLink tip, rendered.
 *
 * Zustand v5 server-renders a store's INITIAL state, so the two stores the
 * tip's gating reads live (WorldLink and the tour) are mocked with plain
 * state objects the tests set directly. Server rendering never runs effects,
 * so no `shown` event is sent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

(globalThis as unknown as { window: unknown }).window = {
  sei: { track: () => undefined },
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};
(globalThis as unknown as { document: unknown }).document = {
  documentElement: { getAttribute: () => 'dark' },
};

interface SeilinkState {
  availability: { enabled: boolean } | null;
  status: { state: string; characterId?: string };
  flow: unknown;
  intro: unknown;
  liveHint: unknown;
  desktopHint: unknown;
  moveBusy: boolean;
}
let seilink: SeilinkState;
let tutorial: { active: boolean };

vi.doMock('../lib/stores/useSeilinkStore', () => ({
  useSeilinkStore: Object.assign(<T,>(sel: (s: SeilinkState) => T): T => sel(seilink), { getState: () => seilink }),
  movedInId: (s: { state: string; characterId?: string }) =>
    s.state === 'starting' || s.state === 'running' || s.state === 'restarting' ? (s.characterId ?? null) : null,
}));
vi.doMock('../lib/stores/useTutorialStore', () => ({
  useTutorialStore: Object.assign(<T,>(sel: (s: { active: boolean }) => T): T => sel(tutorial), { getState: () => tutorial }),
}));

const { ChatTopBar } = await import('./ChatTopBar');
const { markIntroSeen } = await import('../lib/seilink/introPref');
const { writeTourRecord, retired, afterOffered, EMPTY_TOUR_RECORD } = await import('../lib/seilink/tourPref');
const { dismissWorldlinkTip, __resetWorldlinkTipSessionForTest } = await import('../lib/worldlinkTipPref');

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

function render(): string {
  return renderToStaticMarkup(React.createElement(ChatTopBar, { characterId: 'c1' }));
}

const hasTip = (html: string): boolean => html.includes('role="note"');

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: fakeStorage(), configurable: true, writable: true });
  __resetWorldlinkTipSessionForTest();
  seilink = {
    availability: { enabled: true },
    status: { state: 'off' },
    flow: null,
    intro: null,
    liveHint: null,
    desktopHint: null,
    moveBusy: false,
  };
  tutorial = { active: false };
});

afterEach(() => {
  Reflect.deleteProperty(globalThis as unknown as Record<string, unknown>, 'localStorage');
});

describe('ChatTopBar beta tags', () => {
  it('tags WorldLink "(beta)" and no longer tags Backseat', () => {
    const html = render();
    expect(html).toContain('aria-label="WorldLink (beta)"');
    expect(html).toContain('data-tip="WorldLink (beta)"');
    expect(html).not.toContain('on your desktop"');
    expect(html).toContain('aria-label="Backseat"');
    expect(html).not.toContain('Backseat (beta)');
  });

  it('keeps the plain "WorldLink (beta)" tooltip once she lives on the desktop', () => {
    seilink.status = { state: 'running', characterId: 'c1' };
    const html = render();
    expect(html).toContain('data-tip="WorldLink (beta)"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).not.toContain('room"');
  });
});

describe('ChatTopBar WorldLink tip', () => {
  it('hangs under the WorldLink button for someone who has not met WorldLink', () => {
    const html = render();
    expect(hasTip(html)).toBe(true);
    // Inside the same wrapper as the WorldLink button, after it.
    const btn = html.indexOf('data-tutorial="seilink-btn"');
    const tip = html.indexOf('role="note"');
    expect(btn).toBeGreaterThan(-1);
    expect(tip).toBeGreaterThan(btn);
    expect(html.indexOf('data-tutorial="call-btn"')).toBeGreaterThan(tip);
    expect(html).not.toContain('New games added');
  });

  it('is gone while a tour runs (the WorldLink tour spotlights the same button)', () => {
    tutorial = { active: true };
    const html = render();
    expect(hasTip(html)).toBe(false);
    expect(html).toContain('data-tutorial="seilink-btn"');
  });

  it('never stacks on the move-in sheet, the intro or a move in progress', () => {
    seilink.flow = { kind: 'sheet', characterId: 'c1' };
    expect(hasTip(render())).toBe(false);
    seilink.flow = null;
    seilink.intro = { seq: 1 };
    expect(hasTip(render())).toBe(false);
    seilink.intro = null;
    seilink.moveBusy = true;
    expect(hasTip(render())).toBe(false);
  });

  it('does not nag someone who already used WorldLink or finished its tour', () => {
    markIntroSeen();
    expect(hasTip(render())).toBe(false);

    localStorage.clear();
    writeTourRecord(retired(afterOffered(EMPTY_TOUR_RECORD)));
    expect(hasTip(render())).toBe(false);

    localStorage.clear();
    seilink.status = { state: 'running', characterId: 'other' };
    expect(hasTip(render())).toBe(false);
  });

  it('stays retired once dismissed', () => {
    dismissWorldlinkTip();
    expect(hasTip(render())).toBe(false);
  });

  it('is absent with the button where WorldLink cannot run', () => {
    seilink.availability = { enabled: false };
    const html = render();
    expect(hasTip(html)).toBe(false);
    expect(html).not.toContain('seilink-btn');
  });
});
