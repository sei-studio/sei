/**
 * The Roblox pick step (261004 redesign) and its hand-off to the auto-share
 * watch. There is no DOM in this suite, so the step's decisions live in pure
 * helpers (resolveOutcome, noticeLine, pickHandoffMs) that are pinned here,
 * the first render is checked as markup, and the hand-off is driven against
 * the real stores.
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

const { PickStep, resolveOutcome, noticeLine, pickHandoffMs } = await import('./BackseatGameModal');
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
    expect(out.notice).toBeNull();
  });

  it('results replace the cards with no line over them, busy fallback or not', () => {
    const r = [game(1, 'A'), game(2, 'B')];
    expect(resolveOutcome({ kind: 'results', results: r })).toEqual({ results: r, notice: null });
    expect(resolveOutcome({ kind: 'results', results: r, fallback: 'rate_limited' })).toEqual({
      results: r,
      notice: null,
    });
  });

  it('no results says so in the grid area', () => {
    expect(resolveOutcome({ kind: 'results', results: [] })).toEqual({
      results: null,
      notice: { kind: 'none' },
    });
  });

  it('an error says so in the grid area', () => {
    const out = resolveOutcome({ kind: 'error', code: 'bad_link' });
    expect(out.results).toBeUndefined();
    expect(out.notice).toEqual({ kind: 'error', code: 'bad_link' });
  });
});

describe('the grid-area lines', () => {
  const notices = [
    { kind: 'none' },
    { kind: 'error', code: 'bad_link' },
    { kind: 'error', code: 'not_found' },
    { kind: 'error', code: 'network' },
    { kind: 'offline' },
  ] as const;

  it('every state has a short plain line, translated, with no em dashes', () => {
    for (const notice of notices) {
      let key = '';
      const line = noticeLine(notice, (s, p) => ((key = s), en(s, p)), 'Roblox');
      expect(line.length).toBeLessThan(50);
      expect(line).not.toMatch(/[—–]/);
      expect(ZH[key], key).toBeTruthy();
      expect(ZH[key]).not.toMatch(/[—–]/);
    }
  });

  it('names the game where it matters', () => {
    expect(noticeLine({ kind: 'offline' }, en, 'Roblox')).toBe("Can't reach Roblox right now.");
    expect(noticeLine({ kind: 'error', code: 'bad_link' }, en, 'Roblox')).toBe("That's not a Roblox game link.");
    expect(noticeLine({ kind: 'none' }, en, 'Roblox')).toBe("No games found. Try pasting the game's link.");
  });

  it('the step and the waiting card are translated', () => {
    for (const k of [
      'Play {game}',
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
      onClose: () => undefined,
      onDone: () => undefined,
    }),
  );

  it('is a plain "Play Roblox" title, a search pill, a loading grid and a quiet skip', () => {
    expect(html).toMatch(/<h3[^>]*>Play Roblox<\/h3>/);
    expect(html).toContain('role="search"');
    expect(html).toContain('placeholder="Search or paste a link"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('>Skip<');
  });

  it('has no companion portrait or speech line, no Continue button, no description wall', () => {
    expect(html).not.toMatch(/What are we playing|role="status"|<canvas|<img/);
    expect(html).not.toMatch(/Continue|Optional\.|Popular right now/);
  });
});

describe('the pick hand-over', () => {
  it('holds the picked card up for a beat, then fades out', () => {
    const full = pickHandoffMs(false);
    expect(full.highlight).toBeGreaterThanOrEqual(350);
    expect(full.highlight).toBeLessThanOrEqual(450);
    expect(full.leave).toBeGreaterThan(0);
  });

  it('is shorter with reduced motion, with no fade', () => {
    const reduced = pickHandoffMs(true);
    expect(reduced.highlight).toBeLessThan(pickHandoffMs(false).highlight);
    expect(reduced.leave).toBe(0);
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
