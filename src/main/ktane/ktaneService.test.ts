/**
 * KTANE expert mode session (261115): lifecycle, analytics shape, play row,
 * idle end, and the account-switch guard. The turn wiring is pinned in
 * chat/chatService.ktane.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  captures: [] as Array<[string, Record<string, unknown> | undefined]>,
  rows: [] as Array<{ text: string; event?: unknown }>,
  folds: 0,
  onGetCharacter: null as null | (() => void),
}));

vi.mock('../analytics', () => ({
  capture: (e: string, p?: Record<string, unknown>) => h.captures.push([e, p]),
}));
vi.mock('../configStore', () => ({ loadConfig: async () => ({}) }));
vi.mock('../characterStore', () => ({
  getCharacter: async () => {
    const hook = h.onGetCharacter;
    h.onGetCharacter = null;
    hook?.();
    return { id: 'sui', name: 'Sui', persona: { expanded: 'Sui persona' }, metadata: {} };
  },
}));
vi.mock('../chat/continuity', () => ({
  foldIfDue: async () => {
    h.folds += 1;
  },
}));
vi.mock('../chat/chatStore', () => ({
  appendMessage: async (_id: string, row: { text: string; event?: unknown }) => {
    await new Promise((r) => setTimeout(r, 10));
    h.rows.push(row);
  },
}));

import {
  KTANE_IDLE_MS,
  __resetKtaneForTests,
  applyKtaneNotes,
  applyKtaneNotesFromContent,
  endAllKtane,
  endKtaneSession,
  getKtaneState,
  initKtaneService,
  isKtaneActive,
  ktaneLlmOptions,
  ktaneStableFor,
  ktaneToolFor,
  ktaneTurnNote,
  newKtaneBomb,
  noteKtaneTurn,
  startKtaneSession,
} from './ktaneService';
import { KTANE_CONTRACT, KTANE_TURN_CUE } from './ktanePrompts';
import type { KtaneState } from '../../shared/ktaneIpc';
import { ACCOUNT_SWITCHING, _resetScopeBarrierForTests, beginScopeSwitch, pendingScopedWrites } from '../profile/scopeBarrier';

const flush = () => new Promise((r) => setTimeout(r, 15));
const events = (name: string) => h.captures.filter(([e]) => e === name).map(([, p]) => p ?? {});
let pushed: KtaneState[] = [];

beforeEach(() => {
  h.captures.length = 0;
  h.rows.length = 0;
  h.folds = 0;
  pushed = [];
  _resetScopeBarrierForTests();
  __resetKtaneForTests();
  initKtaneService({ pushState: (s) => pushed.push(s), pushChatMessage: () => {} });
});
afterEach(() => {
  vi.useRealTimers();
  __resetKtaneForTests();
});

describe('ktane session', () => {
  it('nothing rides a turn without a session', () => {
    expect(isKtaneActive('sui')).toBe(false);
    expect(ktaneStableFor('sui')).toBeUndefined();
    expect(ktaneTurnNote('sui')).toBe('');
    expect(ktaneToolFor('sui')).toBeNull();
    expect(ktaneLlmOptions('sui', 'anthropic')).toBeNull();
    expect(applyKtaneNotes('sui', { serial: 'AB1CD2' })).toMatch(/no bomb session/);
  });

  it('a session adds the manual, the tool, the note, and thinking on Anthropic only', async () => {
    await startKtaneSession('sui', 'panel', { onCall: true });
    expect(ktaneStableFor('sui')).toContain('# BOMB DEFUSAL SESSION');
    expect(ktaneStableFor('sui')).toContain('# BOMB DEFUSAL MANUAL');
    expect(ktaneToolFor('sui')?.name).toBe('bomb_notes');
    expect(ktaneTurnNote('sui')).toContain('[your bomb notes, bomb 1]');
    // The character leads (product call 261115): the voice cue rides last in
    // the turn note, and the contract sits after the manual in the cache.
    expect(ktaneTurnNote('sui').endsWith(KTANE_TURN_CUE)).toBe(true);
    const stable = ktaneStableFor('sui')!;
    expect(stable.indexOf('# BOMB DEFUSAL SESSION')).toBeGreaterThan(stable.indexOf('# BOMB DEFUSAL MANUAL'));
    expect(`${KTANE_CONTRACT}\n${KTANE_TURN_CUE}`).not.toMatch(/[\u2013\u2014]/);
    expect(ktaneLlmOptions('sui', 'anthropic')).toEqual({ maxTokens: 3000, anthropicExtra: { thinking: { type: 'adaptive' } } });
    expect(ktaneLlmOptions('sui', 'openai')).toBeNull();
    expect(ktaneToolFor('lyra')).toBeNull();
    await flush();
    expect(events('ktane_session_started')).toEqual([{ character_id: 'sui', source: 'panel', on_call: true }]);
    expect(pushed.at(-1)?.active).toBe(true);
  });

  it('a second start returns the live session', async () => {
    const a = await startKtaneSession('sui', 'panel');
    applyKtaneNotes('sui', { serial: 'AB1CD2' });
    const b = await startKtaneSession('sui', 'picker');
    expect(b.startedAt).toBe(a.startedAt);
    expect(b.sheet.serial).toBe('AB1CD2');
    await flush();
    expect(events('ktane_session_started')).toHaveLength(1);
  });

  it('notes update the sheet and the totals, and a finished bomb is captured', async () => {
    await startKtaneSession('sui', 'panel');
    applyKtaneNotes('sui', { serial: 'AB1CD2', module: 'wires' });
    applyKtaneNotes('sui', { solved: true, strikes: 1 });
    applyKtaneNotesFromContent('sui', [
      { type: 'text' },
      { type: 'tool_use', name: 'remember', input: { serial: 'ZZ' } },
      { type: 'tool_use', name: 'bomb_notes', input: { bomb: 'defused' } },
    ]);
    const st = getKtaneState('sui')!;
    expect(st.sheet.serial).toBe('AB1CD2');
    expect(st.sheet.solved).toEqual(['wires']);
    expect(st.totals).toMatchObject({ bombs: 1, defused: 1, modulesSolved: 1, strikes: 1 });
    expect(pushed.at(-1)?.totals.defused).toBe(1);

    const next = newKtaneBomb('sui')!;
    expect(next.sheet.bomb).toBe(2);
    expect(next.sheet.serial).toBeNull();
    expect(next.totals.bombs).toBe(2);
    await flush();
    const [bomb] = events('ktane_bomb_ended');
    expect(bomb).toMatchObject({ character_id: 'sui', outcome: 'defused', bomb: 1, modules_solved: 1, strikes: 1 });
    expect(typeof bomb.bomb_ms).toBe('number');
  });

  it('the end event carries duration and shape only; a played session writes one play row', async () => {
    await startKtaneSession('sui', 'picker');
    applyKtaneNotes('sui', { serial: 'AB1CD2' });
    noteKtaneTurn('sui', { voice: true, firstLineMs: 1800, thinking: true });
    noteKtaneTurn('sui', { voice: true, firstLineMs: 2600, thinking: true });
    noteKtaneTurn('sui', { voice: false, firstLineMs: null, thinking: true });
    noteKtaneTurn('sui', { voice: true, firstLineMs: null, thinking: true, errorClass: 'timeout' });
    const ending = endKtaneSession('sui', 'user_end');
    expect(pendingScopedWrites()).toBe(1);
    await ending;
    await flush();
    expect(isKtaneActive('sui')).toBe(false);
    expect(pushed.at(-1)?.active).toBe(false);
    const [ended] = events('ktane_session_ended');
    expect(ended).toMatchObject({
      character_id: 'sui',
      reason: 'user_end',
      source: 'picker',
      bombs: 1,
      turns: 4,
      voice_turns: 3,
      thinking_turns: 4,
      notes_calls: 1,
      silent_turns: 1,
      failed_turns: 1,
      last_error_class: 'timeout',
      first_line_p50_ms: 2600,
      first_line_p90_ms: 2600,
    });
    expect(typeof ended.duration_ms).toBe('number');
    // Shape only: nothing the player or the companion said.
    expect(JSON.stringify(ended)).not.toContain('AB1CD2');
    expect(events('ktane_first_reply')).toEqual([{ character_id: 'sui', first_line_ms: 1800, voice: true }]);
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0].event).toMatchObject({ kind: 'play', game: 'Keep Talking and Nobody Explodes' });
    expect(h.folds).toBe(1);

    // Idempotent: the renderer's late end finds nothing.
    await endKtaneSession('sui', 'user_end');
    await flush();
    expect(events('ktane_session_ended')).toHaveLength(1);
  });

  it('a session with no turns writes no play row', async () => {
    await startKtaneSession('sui', 'panel');
    await endKtaneSession('sui', 'user_end');
    await flush();
    expect(events('ktane_session_ended')).toHaveLength(1);
    expect(h.rows).toHaveLength(0);
  });

  it('ends itself after the idle window, timed to the last turn', async () => {
    vi.useFakeTimers();
    await startKtaneSession('sui', 'panel');
    vi.advanceTimersByTime(60_000);
    noteKtaneTurn('sui', { voice: true, firstLineMs: 2000, thinking: true });
    vi.advanceTimersByTime(KTANE_IDLE_MS - 1);
    expect(isKtaneActive('sui')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(isKtaneActive('sui')).toBe(false);
    vi.useRealTimers();
    await flush();
    const [ended] = events('ktane_session_ended');
    expect(ended).toMatchObject({ reason: 'idle', duration_ms: 60_000 });
  });
});

describe('ktane across an account switch', () => {
  it('endAllKtane ends every session with the reason and tracks the rows', async () => {
    await startKtaneSession('sui', 'panel');
    await startKtaneSession('lyra', 'panel');
    noteKtaneTurn('sui', { voice: true, firstLineMs: 1000, thinking: true });
    noteKtaneTurn('lyra', { voice: true, firstLineMs: 1000, thinking: true });
    const ending = endAllKtane('account_switch');
    expect(pendingScopedWrites()).toBe(2);
    await ending;
    await flush();
    expect(h.rows).toHaveLength(2);
    expect(events('ktane_session_ended').map((p) => p.reason)).toEqual(['account_switch', 'account_switch']);
  });

  it('refuses a start while a switch runs, and unwinds one that straddles it', async () => {
    const release = beginScopeSwitch();
    await expect(startKtaneSession('sui', 'panel')).rejects.toMatchObject({ code: ACCOUNT_SWITCHING });
    release();

    let late: (() => void) | null = null;
    h.onGetCharacter = () => {
      late = beginScopeSwitch();
    };
    await expect(startKtaneSession('sui', 'panel')).rejects.toMatchObject({ code: ACCOUNT_SWITCHING });
    (late as (() => void) | null)?.();
    expect(isKtaneActive('sui')).toBe(false);
  });
});
