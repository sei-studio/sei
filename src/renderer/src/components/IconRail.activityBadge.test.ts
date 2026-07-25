/**
 * Tests for the IconRail avatar activity badge (v0.5 games).
 *
 * Follows the IconRail.test.tsx convention (no @testing-library/react):
 * source/CSS grep checks for the rendered contract, plus REAL unit tests of
 * the pure `avatarActivityBadge` helper via module import (window.sei is
 * shimmed before the dynamic import, mirroring IconRail.test.tsx).
 *
 * Invariants under test:
 *   1. avatarActivityBadge returns null when no activity is live.
 *   2. 'call' when the character is a participant on a live call, and on a
 *      connecting first dial; NOT for a non-participant, NOT when idle/error.
 *   3. 'game' for a not-ended chess game ('preparing' or 'active'), an
 *      active watch session, or an online MC bot session; ended/null
 *      snapshots and a merely-connecting summon do NOT count.
 *   4. Call wins over game when both are live for the same character.
 *   5. Source renders the badge span with PhoneIcon/GamepadIcon and the
 *      accessible label suffixes ", on a call" / ", playing a game".
 *   6. CSS module defines the 14px .activityBadge with the rail-colored ring.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TSX_PATH = resolve(__dirname, 'IconRail.tsx');
const CSS_PATH = resolve(__dirname, 'IconRail.module.css');

beforeEach(() => {
  (globalThis as unknown as { window: unknown }).window = {
    sei: {},
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
});

type BadgeFn = (
  characterId: string,
  s: {
    callStatus: string;
    callParticipants: readonly string[];
    chessGames: Readonly<Record<string, { status: string } | null | undefined>>;
    watchSessions: Readonly<Record<string, { status: string } | null | undefined>>;
    summons: Readonly<Record<string, { kind: string } | undefined>>;
  },
) => 'call' | 'game' | null;

async function loadBadgeFn(): Promise<BadgeFn> {
  const mod = await import('./IconRail');
  return mod.avatarActivityBadge as BadgeFn;
}

/** Baseline: nothing live anywhere. */
const quiet = {
  callStatus: 'idle',
  callParticipants: [] as string[],
  chessGames: {},
  watchSessions: {},
  summons: {},
};

describe('avatarActivityBadge (pure helper)', () => {
  it('Test 1: returns null when no activity is live', async () => {
    const badge = await loadBadgeFn();
    expect(badge('a', quiet)).toBe(null);
  });

  it('Test 2: call participant on a live or connecting call → call; others → not', async () => {
    const badge = await loadBadgeFn();
    const live = { ...quiet, callStatus: 'live', callParticipants: ['a', 'b'] };
    expect(badge('a', live)).toBe('call');
    expect(badge('b', live)).toBe('call');
    // Not on the call → no badge.
    expect(badge('c', live)).toBe(null);
    // First dial still connecting counts (the call surface is already open).
    expect(badge('a', { ...live, callStatus: 'connecting' })).toBe('call');
    // idle/error never badge, even with stale participants.
    expect(badge('a', { ...live, callStatus: 'idle' })).toBe(null);
    expect(badge('a', { ...live, callStatus: 'error' })).toBe(null);
  });

  it('Test 3: chess (not ended), active watch, or online summon → game', async () => {
    const badge = await loadBadgeFn();
    expect(badge('a', { ...quiet, chessGames: { a: { status: 'active' } } })).toBe('game');
    // Engine warm-up: the game session exists from the player's POV.
    expect(badge('a', { ...quiet, chessGames: { a: { status: 'preparing' } } })).toBe('game');
    expect(badge('a', { ...quiet, chessGames: { a: { status: 'ended' } } })).toBe(null);
    expect(badge('a', { ...quiet, chessGames: { a: null } })).toBe(null);

    expect(badge('a', { ...quiet, watchSessions: { a: { status: 'active' } } })).toBe('game');
    expect(badge('a', { ...quiet, watchSessions: { a: { status: 'preparing' } } })).toBe(null);
    expect(badge('a', { ...quiet, watchSessions: { a: { status: 'ended' } } })).toBe(null);

    expect(badge('a', { ...quiet, summons: { a: { kind: 'online' } } })).toBe('game');
    expect(badge('a', { ...quiet, summons: { a: { kind: 'connecting' } } })).toBe(null);

    // Activity is per-character: b's game never badges a.
    expect(badge('a', { ...quiet, chessGames: { b: { status: 'active' } } })).toBe(null);
  });

  it('Test 4: call wins over game for the same character', async () => {
    const badge = await loadBadgeFn();
    const both = {
      callStatus: 'live',
      callParticipants: ['a'],
      chessGames: { a: { status: 'active' } },
      watchSessions: { a: { status: 'active' } },
      summons: { a: { kind: 'online' } },
    };
    expect(badge('a', both)).toBe('call');
  });

  it('Test 5: source renders the badge span, glyphs, and aria-label suffixes', () => {
    const source = readFileSync(TSX_PATH, 'utf-8');
    expect(source.includes('activityBadge')).toBe(true);
    expect(source.includes('PhoneIcon')).toBe(true);
    expect(source.includes('GamepadIcon')).toBe(true);
    expect(source.includes(', on a call')).toBe(true);
    expect(source.includes(', playing a game')).toBe(true);
    // Badge state feeds from the voice, chess, watch, and summon slices.
    expect(source.includes('useVoiceStore')).toBe(true);
    expect(source.includes('useChessStore')).toBe(true);
    expect(source.includes('useWatchStore')).toBe(true);
  });

  it('Test 6: CSS module defines the 14px badge with the rail-colored ring', () => {
    const css = readFileSync(CSS_PATH, 'utf-8');
    expect(css.includes('.activityBadge')).toBe(true);
    expect(css.includes('width: 14px')).toBe(true);
    expect(css.includes('border: 2px solid var(--rail)')).toBe(true);
  });
});
