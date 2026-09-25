/**
 * FirstMomentCard (260926): the next-step tiles under the first greeting.
 *
 * Zustand v5 server-renders a store's INITIAL state (getServerSnapshot), so
 * the store hook is mocked with a plain state object the tests set directly.
 * Server rendering never runs the card's effects, so markShown is not called.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FirstMomentPlan } from '../lib/firstMoment';

(globalThis as unknown as { window: unknown }).window = {
  sei: {},
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};

interface FakeState {
  characterId: string | null;
  status: string | null;
  plan: FirstMomentPlan | null;
  markShown: () => void;
  act: () => void;
}
let state: FakeState;
function setState(patch: Partial<FakeState>): void {
  state = { ...state, ...patch };
}

vi.doMock('../lib/stores/useFirstMomentStore', () => ({
  useFirstMomentStore: Object.assign(<T,>(sel: (s: FakeState) => T): T => sel(state), {
    getState: () => state,
  }),
}));

const { FirstMomentCard } = await import('./FirstMomentCard');
const { ZH } = await import('../lib/i18n/zh');

function render(characterId = 'c1'): string {
  return renderToStaticMarkup(React.createElement(FirstMomentCard, { characterId }));
}

function actions(html: string): string[] {
  return [...html.matchAll(/data-action="([a-z]+)"/g)].map((m) => m[1]);
}

beforeEach(() => {
  state = { characterId: null, status: null, plan: null, markShown: () => {}, act: () => {} };
});

describe('FirstMomentCard', () => {
  it('renders nothing unless the moment is ready for this companion', () => {
    expect(render()).toBe('');
    setState({ characterId: 'c1', status: 'greeting', plan: { primary: 'chess', minecraft: false } });
    expect(render()).toBe('');
    setState({ status: 'ready' });
    expect(render('other')).toBe('');
    expect(render()).toContain('data-first-moment');
  });

  it('renders nothing after a click or a failed greeting', () => {
    setState({ characterId: 'c1', status: 'done', plan: { primary: 'chess', minecraft: false } });
    expect(render()).toBe('');
    setState({ status: 'failed' });
    expect(render()).toBe('');
  });

  it('chess only: chess tile (primary), call, then Not now', () => {
    setState({ characterId: 'c1', status: 'ready', plan: { primary: 'chess', minecraft: false } });
    const html = render();
    expect(actions(html)).toEqual(['chess', 'call', 'dismiss']);
    expect(html).toContain('Play chess now');
    expect(html).toContain('Call me');
    expect(html).toContain('Not now');
    expect(html).not.toContain('Minecraft');
    expect(html).toMatch(/data-action="chess" data-primary="true"/);
  });

  it('offers Minecraft second when installed', () => {
    setState({ characterId: 'c1', status: 'ready', plan: { primary: 'chess', minecraft: true } });
    const html = render();
    expect(actions(html)).toEqual(['chess', 'minecraft', 'call', 'dismiss']);
    expect(html).toContain('Summon me in Minecraft');
    expect(html).not.toMatch(/data-action="minecraft" data-primary/);
  });

  it('leads with Minecraft when a world is open', () => {
    setState({ characterId: 'c1', status: 'ready', plan: { primary: 'minecraft', minecraft: true } });
    const html = render();
    expect(actions(html)).toEqual(['minecraft', 'chess', 'call', 'dismiss']);
    expect(html).toMatch(/data-action="minecraft" data-primary="true"/);
  });

  it('every label has a zh translation and no em dash', () => {
    for (const s of ['Play chess now', 'Summon me in Minecraft', 'Call me', 'Not now']) {
      expect(ZH[s], s).toBeTruthy();
      expect(s).not.toContain('—');
      expect(ZH[s]).not.toContain('—');
    }
  });
});
