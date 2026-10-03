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

const { PickStep, resolveOutcome, moodLine, createPickHandoff, PICK_READ_MS, PICK_HANDOFF_MAX_MS } =
  await import('./BackseatGameModal');
const { LineTyper, HOLD_MS, typingMs } = await import('./lineTyper');
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
    expect(resolveOutcome({ kind: 'results', results: r, fallback: 'rate_limited' }).mood).toEqual({
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
    { kind: 'picked', name: '[🎃] Adopt Me!' },
    { kind: 'picked', name: 'An Extremely Long Roblox Game Title With No Subtitle Anywhere' },
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

  it('reacts to the pick by name, said the way a person would', () => {
    const said = (name: string): string => moodLine({ kind: 'picked', name }, en, 'Roblox');
    expect(said('Jailbreak')).toBe("Ooh, Jailbreak! Let's go.");
    // No store tags or emoji, and never a second "!".
    expect(said('[🎃] Adopt Me!')).toBe("Ooh, Adopt Me! Let's go.");
    expect(said('Brookhaven 🏡RP')).toBe("Ooh, Brookhaven RP! Let's go.");
    expect(said('[SKY ASSASSIN] Jujutsu Shenanigans')).toBe("Ooh, Jujutsu Shenanigans! Let's go.");
    expect(said("🎃 Dandy's World [ALPHA]")).toBe("Ooh, Dandy's World! Let's go.");
    expect(said('Who Is It?')).toBe("Ooh, Who Is It? Let's go.");
    // Too long to say: the line skips the name rather than reading out a paragraph.
    expect(said('An Extremely Long Roblox Game Title With No Subtitle Anywhere')).toBe("Ooh, nice pick! Let's go.");
  });

  it('zh never doubles the punctuation either', () => {
    const zh = (s: string, p?: Record<string, string | number>): string => en(ZH[s] ?? s, p);
    expect(moodLine({ kind: 'picked', name: 'Jailbreak' }, zh, 'Roblox')).toBe('哦，Jailbreak！出发吧。');
    expect(moodLine({ kind: 'picked', name: '[🎃] Adopt Me!' }, zh, 'Roblox')).toBe('哦，Adopt Me! 出发吧。');
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

describe('the pick hand-over never cuts the line off', () => {
  /** The pick step's wiring: CompanionLine's typer reports typed lines to the
   *  hand-over, exactly as PickStep does. Returns when the step left and what
   *  was on screen at that moment. */
  function run(opts: { reduced: boolean; before?: string; beforeMs?: number; name: string }) {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let shown = { line: '', n: 0 };
    let typedAt = -1;
    let left: { at: number; shown: { line: string; n: number } } | null = null;
    const picked = moodLine({ kind: 'picked', name: opts.name }, en, 'Roblox');
    const handoff = createPickHandoff(picked, () => {
      left = { at: Date.now(), shown: { ...shown } };
    });
    const typer = new LineTyper({
      reduced: opts.reduced,
      onFrame: (f) => (shown = f),
      onTyped: (l) => {
        if (l === picked) typedAt = Date.now();
        handoff.typed(l);
      },
    });
    if (opts.before) {
      typer.say(opts.before);
      vi.advanceTimersByTime(opts.beforeMs ?? 0);
    }
    const pickedAt = Date.now();
    typer.say(picked);
    // Step a millisecond at a time so the exact leave moment is caught.
    for (let i = 0; i < PICK_HANDOFF_MAX_MS + 100 && !left; i++) vi.advanceTimersByTime(1);
    typer.dispose();
    vi.useRealTimers();
    return { picked, pickedAt, typedAt, left: left as { at: number; shown: { line: string; n: number } } | null };
  }

  for (const name of ['Brookhaven 🏡RP', '[SKY ASSASSIN] Jujutsu Shenanigans', '[🎃] Adopt Me!', 'x'.repeat(300)]) {
    it(`leaves only after "${name.slice(0, 40)}" is fully typed and read`, () => {
      const r = run({ reduced: false, name });
      expect(r.left).not.toBeNull();
      expect(r.left!.shown).toEqual({ line: r.picked, n: Array.from(r.picked).length });
      expect(r.typedAt).toBeGreaterThanOrEqual(r.pickedAt + typingMs(r.picked));
      expect(r.left!.at - r.typedAt).toBeGreaterThanOrEqual(PICK_READ_MS);
      // Left on the line, not on the backstop.
      expect(r.left!.at).toBeLessThan(PICK_HANDOFF_MAX_MS);
    });
  }

  it('waits out a line that was still typing when the card was tapped', () => {
    const before = "Can't find that one. Try pasting the game's link?";
    const r = run({ reduced: false, before, beforeMs: 50, name: 'Brookhaven 🏡RP' });
    expect(r.left!.shown).toEqual({ line: r.picked, n: Array.from(r.picked).length });
    expect(r.typedAt).toBeGreaterThanOrEqual(typingMs(before) + HOLD_MS + typingMs(r.picked));
    expect(r.left!.at - r.typedAt).toBeGreaterThanOrEqual(PICK_READ_MS);
  });

  it('reduced motion: the line is whole at once, then a short read beat', () => {
    const r = run({ reduced: true, name: 'Brookhaven 🏡RP' });
    expect(r.left!.shown.n).toBe(Array.from(r.picked).length);
    expect(r.left!.at - r.typedAt).toBe(PICK_READ_MS);
  });

  it('the backstop sits above the slowest possible pick line', () => {
    // Worst case: the longest pick line, queued behind the longest other line.
    const lines = [
      'What are we playing?',
      'Hmm, let me look...',
      'Roblox search is busy. Any of these?',
      "Can't find that one. Try pasting the game's link?",
      "I can't reach Roblox right now. We can just skip this!",
      "I can't load games right now. Paste a link or just skip!",
    ];
    const longestOther = Math.max(...lines.map(typingMs));
    const longestPick = typingMs(moodLine({ kind: 'picked', name: 'W'.repeat(32) }, en, 'Roblox'));
    expect(longestOther + HOLD_MS + longestPick + PICK_READ_MS).toBeLessThan(PICK_HANDOFF_MAX_MS);
  });
});
