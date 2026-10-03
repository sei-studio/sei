/**
 * The Roblox pick step (261004 redesign) and its hand-off to the auto-share
 * watch. There is no DOM in this suite, so the step's decisions live in pure
 * helpers (resolveOutcome, moodLine) that are pinned here, the first render is
 * checked as markup, and the hand-off is driven against the real stores.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BackseatGameInfo } from '../../../../shared/backseatGames';

(globalThis as unknown as { window: unknown }).window = {
  sei: {
    backseatGamePopular: async () => [],
    backseatGameDetails: async () => null,
    backseatGameResolve: async () => ({ kind: 'results', results: [] }),
    backseatSources: async () => [],
    onBackseatState: () => () => {},
    onBackseatLine: () => () => {},
  },
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
};
(globalThis as unknown as { document: unknown }).document = {
  documentElement: { getAttribute: () => 'dark' },
};

const { PickStep, resolveOutcome, moodLine } = await import('./BackseatGameModal');
const { handOffAutoShare } = await import('./ShareScreenModal');
const { useBackseatStore } = await import('../../lib/stores/useBackseatStore');
const { useUiStore } = await import('../../lib/stores/useUiStore');
const { ZH } = await import('../../lib/i18n/zh');
const { backseatGame } = await import('../../../../shared/backseatGames');

const game = (id: number, name: string): BackseatGameInfo => ({ universeId: id, placeId: id * 10, name });
const en = (s: string, p?: Record<string, string | number>): string =>
  s.replace(/\{(\w+)\}/g, (_m, k: string) => String(p?.[k] ?? `{${k}}`));

describe('resolveOutcome', () => {
  it('a resolved link is a pick', () => {
    const g = game(1, 'Jailbreak');
    const out = resolveOutcome({ kind: 'game', game: g });
    expect(out.pick).toBe(g);
    expect(out.mood).toEqual({ kind: 'picked', name: 'Jailbreak' });
  });

  it('results replace the cards; a busy search says so', () => {
    const r = [game(1, 'A'), game(2, 'B')];
    expect(resolveOutcome({ kind: 'results', results: r })).toEqual({
      results: r,
      mood: { kind: 'results', fallback: false },
    });
    expect(resolveOutcome({ kind: 'results', results: r, fallback: true }).mood).toEqual({
      kind: 'results',
      fallback: true,
    });
  });

  it('no results keeps the popular games up instead of an empty grid', () => {
    expect(resolveOutcome({ kind: 'results', results: [] })).toEqual({
      results: null,
      mood: { kind: 'none' },
    });
  });

  it('an error leaves the cards as they are', () => {
    const out = resolveOutcome({ kind: 'error', code: 'bad_link' });
    expect(out.results).toBeUndefined();
    expect(out.mood).toEqual({ kind: 'error', code: 'bad_link' });
  });
});

describe('the companion lines', () => {
  const moods = [
    { kind: 'ask' },
    { kind: 'searching' },
    { kind: 'results', fallback: false },
    { kind: 'results', fallback: true },
    { kind: 'none' },
    { kind: 'error', code: 'bad_link' },
    { kind: 'error', code: 'not_found' },
    { kind: 'error', code: 'network' },
    { kind: 'offline' },
    { kind: 'picked', name: 'Jailbreak' },
  ] as const;

  it('every state has a short line, translated, with no em dashes', () => {
    for (const mood of moods) {
      let key = '';
      const line = moodLine(mood, (s, p) => ((key = s), en(s, p)), 'Roblox');
      expect(line.length).toBeLessThan(70);
      expect(line).not.toMatch(/[—–]/);
      expect(ZH[key], key).toBeTruthy();
      expect(ZH[key]).not.toMatch(/[—–]/);
    }
  });

  it('reacts to the pick by name', () => {
    expect(moodLine({ kind: 'picked', name: 'Adopt Me!' }, en, 'Roblox')).toBe("Ooh, Adopt Me!! Let's go.");
  });

  it('the waiting card lines are translated too', () => {
    for (const k of [
      "Hop in, I'll be watching!",
      "Hop back in, I'm still here.",
      "Hmm, I couldn't start watching.",
      'Waiting for {game}',
      'Share something else',
      'Search or paste a link',
      'Search {game} games or paste a link',
    ]) {
      expect(ZH[k], k).toBeTruthy();
    }
  });
});

describe('PickStep first render', () => {
  const html = renderToStaticMarkup(
    React.createElement(PickStep, {
      gameId: 'roblox',
      gameName: 'Roblox',
      character: { id: 'c1', name: 'Sui', portrait_image: null },
      companionName: 'Sui',
      onClose: () => undefined,
      onDone: () => undefined,
    }),
  );

  it('is the companion asking, a search pill, a loading grid and a quiet skip', () => {
    expect(html).toContain('What are we playing?');
    expect(html).toContain('role="search"');
    expect(html).toContain('placeholder="Search or paste a link"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('>Skip<');
  });

  it('has no Continue button and no description wall', () => {
    expect(html).not.toMatch(/Continue|Optional\.|Popular right now/);
  });
});

describe('handOffAutoShare', () => {
  const ROBLOX = { gameId: 'roblox', universeId: 1686885941 };

  it('Roblox is an auto-share game', () => {
    expect(backseatGame('roblox')?.autoShare).toBe(true);
  });

  it('with no call: arms the watch for the call and goes to it', () => {
    useUiStore.getState().openModal({ kind: 'share-screen', characterId: 'c1', game: ROBLOX });
    handOffAutoShare('c1', ROBLOX, false);
    const ui = useUiStore.getState();
    expect(ui.modal).toBeNull();
    expect(ui.view).toEqual({ kind: 'voice-call', characterId: 'c1' });
    const pending = useBackseatStore.getState().pendingShare;
    expect(pending?.source).toBeNull();
    expect(pending?.game).toEqual(ROBLOX);
    expect(useBackseatStore.getState().watch).toBeNull();
    useBackseatStore.getState().clearPendingShare();
  });

  it('on a call: starts watching right away', () => {
    vi.useFakeTimers();
    useUiStore.getState().navigate({ kind: 'chat', characterId: 'c1' });
    handOffAutoShare('c1', ROBLOX, true);
    expect(useBackseatStore.getState().watch).toMatchObject({ characterId: 'c1', game: ROBLOX });
    expect(useBackseatStore.getState().pendingShare).toBeNull();
    expect(useUiStore.getState().view).toEqual({ kind: 'voice-call', characterId: 'c1' });
    useBackseatStore.getState().stopWatch();
    vi.useRealTimers();
  });
});
