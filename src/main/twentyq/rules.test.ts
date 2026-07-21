/**
 * 20 Questions round bookkeeping — the pure phase machine. Everything that
 * can corrupt a round (slot accounting, phase legality, winners) is exercised
 * here without any LLM; the service tests cover the turn runner on top.
 */
import { describe, it, expect } from 'vitest';
import { TQ_MAX_QUESTIONS } from '../../shared/twentyqIpc';
import {
  applyAnswer,
  applyAsk,
  applyForfeit,
  applyGuess,
  createRound,
  finishRound,
  noteReply,
  outOfQuestions,
  resolveGuesserExhaustion,
  resolveGuesserReveal,
  resolveKeeperExhaustion,
  resolveKeeperReveal,
  slotsLeft,
} from './rules';

describe('twentyq rules — guesser mode (the character guesses)', () => {
  it('asks consume slots and log in order', () => {
    const r = createRound('guesser', 1);
    expect(slotsLeft(r)).toBe(20);
    expect(applyAsk(r, 'Is it alive?').ok).toBe(true);
    noteReply(r);
    expect(applyAsk(r, 'Is it bigger than a toaster?').ok).toBe(true);
    expect(r.questionsUsed).toBe(2);
    expect(slotsLeft(r)).toBe(18);
    expect(r.log.map((e) => e.kind)).toEqual(['question', 'question']);
    expect(r.log[1].text).toBe('Is it bigger than a toaster?');
  });

  it('a guess costs a slot and sets the pending guess', () => {
    const r = createRound('guesser', 1);
    applyAsk(r, 'Is it alive?');
    noteReply(r);
    expect(applyGuess(r, 'a hedgehog').ok).toBe(true);
    expect(r.questionsUsed).toBe(2);
    expect(r.pendingGuess).toBe('a hedgehog');
    expect(r.log[1]).toMatchObject({ kind: 'guess', text: 'a hedgehog' });
  });

  it('a new ask supersedes an unresolved (denied) guess', () => {
    const r = createRound('guesser', 1);
    applyGuess(r, 'a hedgehog');
    noteReply(r); // player denied in chat
    applyAsk(r, 'Is it man-made?');
    expect(r.pendingGuess).toBeNull();
  });

  it('reveal claims the round only after the player replied to a guess', () => {
    const r = createRound('guesser', 1);
    // No guess at all → refuse.
    expect(resolveGuesserReveal(r, 'a hedgehog').ok).toBe(false);
    applyGuess(r, 'a hedgehog');
    // Guess still unanswered → refuse (no claiming before the confirm).
    expect(resolveGuesserReveal(r, 'a hedgehog').ok).toBe(false);
    noteReply(r);
    expect(resolveGuesserReveal(r, '').ok).toBe(true);
    expect(r.over).toBe(true);
    expect(r.result).toMatchObject({ winner: 'character', reason: 'guessed', secret: 'a hedgehog', round: 1 });
  });

  it('no asks or guesses once the slots are gone', () => {
    const r = createRound('guesser', 1);
    for (let i = 0; i < TQ_MAX_QUESTIONS; i++) {
      expect(applyAsk(r, `Q${i}?`).ok).toBe(true);
      noteReply(r);
    }
    expect(outOfQuestions(r)).toBe(true);
    expect(applyAsk(r, 'One more?').ok).toBe(false);
    expect(applyGuess(r, 'a thing').ok).toBe(false);
    expect(r.questionsUsed).toBe(TQ_MAX_QUESTIONS);
  });

  it('exhaustion ends the round for the player, but only after the last reply', () => {
    const r = createRound('guesser', 1);
    for (let i = 0; i < TQ_MAX_QUESTIONS; i++) {
      applyAsk(r, `Q${i}?`);
      if (i < TQ_MAX_QUESTIONS - 1) noteReply(r);
    }
    // The 20th question is still out — the player gets to answer it first.
    expect(resolveGuesserExhaustion(r).ok).toBe(false);
    noteReply(r);
    expect(resolveGuesserExhaustion(r).ok).toBe(true);
    expect(r.result).toMatchObject({ winner: 'player', reason: 'out-of-questions', secret: null });
  });

  it('exhaustion refuses while questions remain', () => {
    const r = createRound('guesser', 1);
    applyAsk(r, 'Q?');
    noteReply(r);
    expect(resolveGuesserExhaustion(r).ok).toBe(false);
  });

  it('keeper-mode tools are illegal in guesser mode', () => {
    const r = createRound('guesser', 1);
    expect(applyAnswer(r, 'Yes.', 'yes').ok).toBe(false);
    expect(resolveKeeperReveal(r, true).ok).toBe(false);
    expect(r.questionsUsed).toBe(0);
  });
});

describe('twentyq rules — keeper mode (the character hides the secret)', () => {
  it('answers consume the player slots and record verdicts', () => {
    const r = createRound('keeper', 1, 'a lighthouse');
    expect(applyAnswer(r, 'Huge.', 'yes').ok).toBe(true);
    expect(applyAnswer(r, 'Not even close.', 'no').ok).toBe(true);
    expect(applyAnswer(r, 'In a way.', 'sortof').ok).toBe(true);
    expect(r.questionsUsed).toBe(3);
    expect(r.log.map((e) => e.verdict)).toEqual(['yes', 'no', 'sortof']);
  });

  it('reveal with player_got_it true is a player win with the STORED secret', () => {
    const r = createRound('keeper', 1, 'a lighthouse');
    applyAnswer(r, 'Yes.', 'yes');
    expect(resolveKeeperReveal(r, true).ok).toBe(true);
    expect(r.result).toMatchObject({ winner: 'player', reason: 'guessed', secret: 'a lighthouse' });
  });

  it('reveal with player_got_it false (they gave up) is a character win', () => {
    const r = createRound('keeper', 1, 'a lighthouse');
    expect(resolveKeeperReveal(r, false).ok).toBe(true);
    expect(r.result).toMatchObject({ winner: 'character', reason: 'gave-up', secret: 'a lighthouse' });
  });

  it('the 20th answer opens the exhaustion path; the secret comes out', () => {
    const r = createRound('keeper', 1, 'a lighthouse');
    for (let i = 0; i < TQ_MAX_QUESTIONS; i++) {
      expect(applyAnswer(r, `A${i}.`, 'no').ok).toBe(true);
    }
    expect(applyAnswer(r, 'One more.', 'no').ok).toBe(false);
    expect(resolveKeeperExhaustion(r).ok).toBe(true);
    expect(r.result).toMatchObject({ winner: 'character', reason: 'out-of-questions', secret: 'a lighthouse' });
  });

  it('exhaustion refuses while the player still has questions', () => {
    const r = createRound('keeper', 1, 'a lighthouse');
    applyAnswer(r, 'No.', 'no');
    expect(resolveKeeperExhaustion(r).ok).toBe(false);
  });

  it('guesser-mode tools are illegal in keeper mode', () => {
    const r = createRound('keeper', 1, 'a lighthouse');
    expect(applyAsk(r, 'Is it alive?').ok).toBe(false);
    expect(applyGuess(r, 'a thing').ok).toBe(false);
    expect(resolveGuesserReveal(r, 'a thing').ok).toBe(false);
  });
});

describe('twentyq rules — shared', () => {
  it('forfeit hands the round to the player (secret revealed in keeper mode)', () => {
    const g = createRound('guesser', 2);
    expect(applyForfeit(g).ok).toBe(true);
    expect(g.result).toMatchObject({ winner: 'player', reason: 'gave-up', secret: null, round: 2 });

    const k = createRound('keeper', 3, 'a volcano');
    expect(applyForfeit(k).ok).toBe(true);
    expect(k.result).toMatchObject({ winner: 'player', reason: 'gave-up', secret: 'a volcano', round: 3 });
  });

  it('a finished round refuses every further mutation (no double results)', () => {
    const r = createRound('guesser', 1);
    applyGuess(r, 'a hedgehog');
    noteReply(r);
    resolveGuesserReveal(r, '');
    expect(applyAsk(r, 'Q?').ok).toBe(false);
    expect(applyGuess(r, 'x').ok).toBe(false);
    expect(applyForfeit(r).ok).toBe(false);
    expect(finishRound(r, 'player', 'gave-up', null).ok).toBe(false);
    expect(r.result).toMatchObject({ winner: 'character', reason: 'guessed' });
  });

  it('createRound only seeds a secret in keeper mode', () => {
    expect(createRound('guesser', 1, 'leak?').secret).toBeNull();
    expect(createRound('keeper', 1, 'a cactus').secret).toBe('a cactus');
  });
});
