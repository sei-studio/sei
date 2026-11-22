import { describe, it, expect, beforeEach } from 'vitest';
import {
  noteCompanionGoodbye,
  consumeGoodbye,
  gameEndHookProps,
  callEndHookProps,
  NOTE_TTL_MS,
  _resetGoodbyeNotes,
  goodbyeGame,
  goodbyePlanPlace,
} from './sessionGoodbye';

beforeEach(() => _resetGoodbyeNotes());

describe('sessionGoodbye', () => {
  it('reports nothing when the companion did not end the session', () => {
    const note = consumeGoodbye('sui', 'game');
    expect(gameEndHookProps(note)).toEqual({ next_step_hook: false });
    expect(callEndHookProps(consumeGoodbye('sui', 'call'))).toEqual({ next_step_hook: false, ended_by_companion: false });
  });

  it('carries a companion goodbye with a hook to the end event, once', () => {
    noteCompanionGoodbye('sui', 'call', true, 1_000);
    expect(callEndHookProps(consumeGoodbye('sui', 'call', 2_000))).toEqual({ next_step_hook: true, ended_by_companion: true, next_step_source: 'companion' });
    // Consumed: a later call of the same character starts clean.
    expect(callEndHookProps(consumeGoodbye('sui', 'call', 3_000))).toEqual({ next_step_hook: false, ended_by_companion: false });
  });

  it('261014: carries the player line for the Home card, never into analytics', () => {
    noteCompanionGoodbye('sui', 'game', { hook: true, line: 'Finish the roof' }, 0);
    const note = consumeGoodbye('sui', 'game', 1);
    expect(note).toEqual({ companionEnded: true, nextStepHook: true, nextStepLine: 'Finish the roof' });
    expect(gameEndHookProps(note)).toEqual({ next_step_hook: true, next_step_source: 'companion' });
    // A line without a hook is dropped.
    noteCompanionGoodbye('sui', 'call', { hook: false, line: 'Finish the roof' }, 0);
    expect(consumeGoodbye('sui', 'call', 1)).toEqual({ companionEnded: true, nextStepHook: false });
  });

  it('keeps surfaces and characters apart', () => {
    noteCompanionGoodbye('sui', 'game', true, 0);
    noteCompanionGoodbye('marv', 'call', false, 0);
    expect(consumeGoodbye('sui', 'call', 1)).toEqual({ companionEnded: false, nextStepHook: false });
    expect(consumeGoodbye('marv', 'call', 1)).toEqual({ companionEnded: true, nextStepHook: false });
    expect(gameEndHookProps(consumeGoodbye('sui', 'game', 1))).toEqual({ next_step_hook: true, next_step_source: 'companion' });
  });

  it('drops a note whose end event never came', () => {
    noteCompanionGoodbye('sui', 'game', true, 0);
    expect(consumeGoodbye('sui', 'game', NOTE_TTL_MS + 1)).toEqual({ companionEnded: false, nextStepHook: false });
  });
});

// 261020 (review): the game a goodbye's plan is for.
describe('goodbye plan game (261020 review)', () => {
  it('the note carries a valid game only, and only with a hook', () => {
    noteCompanionGoodbye('a', 'call', { hook: true, line: null, game: 'minecraft' });
    expect(consumeGoodbye('a', 'call').nextStepGame).toBe('minecraft');
    noteCompanionGoodbye('a', 'call', { hook: true, line: null, game: 'none' });
    expect(consumeGoodbye('a', 'call').nextStepGame).toBe('none');
    noteCompanionGoodbye('a', 'call', { hook: false, line: null, game: 'minecraft' });
    expect(consumeGoodbye('a', 'call').nextStepGame).toBeUndefined();
    expect(goodbyeGame('roblox')).toBeUndefined();
    expect(goodbyeGame(null)).toBeUndefined();
  });

  it('places a plan: a named game wins, none drops the game, left out keeps the session', () => {
    const stardew = { surface: 'game' as const, game: 'stardew' };
    expect(goodbyePlanPlace(stardew, 'minecraft')).toEqual({ surface: 'game', game: 'minecraft' });
    expect(goodbyePlanPlace(stardew, 'none')).toEqual({ surface: 'game' });
    expect(goodbyePlanPlace(stardew, undefined)).toEqual({ surface: 'game', game: 'stardew' });
    expect(goodbyePlanPlace({ surface: 'call' }, 'minecraft')).toEqual({ surface: 'game', game: 'minecraft' });
    expect(goodbyePlanPlace({ surface: 'call' }, 'none')).toEqual({ surface: 'call' });
    expect(goodbyePlanPlace({ surface: 'call' }, undefined)).toEqual({ surface: 'call' });
  });
});




