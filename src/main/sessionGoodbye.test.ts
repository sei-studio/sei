import { describe, it, expect, beforeEach } from 'vitest';
import {
  noteCompanionGoodbye,
  consumeGoodbye,
  gameEndHookProps,
  callEndHookProps,
  NOTE_TTL_MS,
  _resetGoodbyeNotes,
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
    expect(callEndHookProps(consumeGoodbye('sui', 'call', 2_000))).toEqual({ next_step_hook: true, ended_by_companion: true });
    // Consumed: a later call of the same character starts clean.
    expect(callEndHookProps(consumeGoodbye('sui', 'call', 3_000))).toEqual({ next_step_hook: false, ended_by_companion: false });
  });

  it('keeps surfaces and characters apart', () => {
    noteCompanionGoodbye('sui', 'game', true, 0);
    noteCompanionGoodbye('marv', 'call', false, 0);
    expect(consumeGoodbye('sui', 'call', 1)).toEqual({ companionEnded: false, nextStepHook: false });
    expect(consumeGoodbye('marv', 'call', 1)).toEqual({ companionEnded: true, nextStepHook: false });
    expect(gameEndHookProps(consumeGoodbye('sui', 'game', 1))).toEqual({ next_step_hook: true });
  });

  it('drops a note whose end event never came', () => {
    noteCompanionGoodbye('sui', 'game', true, 0);
    expect(consumeGoodbye('sui', 'game', NOTE_TTL_MS + 1)).toEqual({ companionEnded: false, nextStepHook: false });
  });
});
