/**
 * PFC steer decision tests (260706) — the "who speaks when" core of the multi-
 * companion voice director. Locks in: a player utterance goes to exactly one
 * companion (addressed-by-name when named, else a varied but bounded pick), the
 * companion chain is probabilistic + capped (so it neither always dies at one
 * turn nor runs forever), and Whisper junk never becomes a turn. Randomness is
 * injected so the varied picks are deterministic here.
 */
import { describe, it, expect } from 'vitest';
import {
  pickResponder,
  decideReaction,
  isJunkTranscript,
  reactionChance,
  PFC_MAX_CHAIN,
  type Participant,
} from './pfcSteer';

const SUI = { id: 'sui', name: 'Sui' };
const MARV = { id: 'marv', name: 'Marv' };
const LYRA = { id: 'lyra', name: 'Lyra' };
const duo: Participant[] = [SUI, MARV];

/** Deterministic rnd stub: returns each value in turn, then holds the last. */
const seq = (...vals: number[]) => {
  let i = 0;
  return () => vals[Math.min(i++, vals.length - 1)];
};

describe('pickResponder', () => {
  it('returns the sole participant on a solo call', () => {
    expect(pickResponder('hey there', [SUI], null).id).toBe('sui');
  });

  it('addresses a companion named in the utterance', () => {
    expect(pickResponder('marv, are you okay?', duo, null, seq(0)).id).toBe('marv');
    expect(pickResponder('what do you think Sui', duo, null, seq(0.99)).id).toBe('sui');
  });

  it('is case-insensitive and ignores surrounding punctuation', () => {
    expect(pickResponder('MARV!!! help', duo, null, seq(0)).id).toBe('marv');
    expect(pickResponder('...sui?', duo, null, seq(0)).id).toBe('sui');
  });

  it('does not match a name embedded inside another word', () => {
    // "marvelous" must not address Marv: with no name match it falls to the
    // weighted pick. rnd=0 lands on the first candidate (Sui).
    expect(pickResponder('that plan is marvelous', duo, null, seq(0)).id).toBe('sui');
  });

  it('down-weights the last responder so the first speaker varies', () => {
    // With Sui down-weighted (weight 0.35) and Marv at 1.0, total = 1.35.
    // rnd just over Sui's slice (0.35/1.35 ≈ 0.26) must land on Marv.
    expect(pickResponder('go on', duo, 'sui', seq(0.5)).id).toBe('marv');
    // A repeat is still POSSIBLE (not banned): a tiny rnd lands back on Sui.
    expect(pickResponder('go on', duo, 'sui', seq(0.01)).id).toBe('sui');
  });
});

describe('decideReaction', () => {
  it('never chains on a solo call', () => {
    expect(decideReaction({ speakerId: 'sui', participants: [SUI], depth: 0, lastReactorId: null })).toBeNull();
  });

  it('picks the other companion in a duo, never the speaker', () => {
    const d = decideReaction({ speakerId: 'sui', participants: duo, depth: 0, lastReactorId: null, rnd: seq(0) });
    expect(d?.reactorId).toBe('marv');
  });

  it('sometimes stops after one turn (organic), sometimes continues', () => {
    // rnd above the depth-0 chance (0.6) → no reaction (only one AI spoke).
    expect(
      decideReaction({ speakerId: 'sui', participants: duo, depth: 0, lastReactorId: null, rnd: seq(0.99) }),
    ).toBeNull();
    // rnd below it → a reaction chains.
    expect(
      decideReaction({ speakerId: 'sui', participants: duo, depth: 0, lastReactorId: null, rnd: seq(0.1, 0) }),
    ).not.toBeNull();
  });

  it('is hard-capped no matter how the dice fall', () => {
    // At the cap boundary, even a certain-continue roll returns null.
    expect(
      decideReaction({
        speakerId: 'sui',
        participants: duo,
        depth: PFC_MAX_CHAIN - 1,
        lastReactorId: null,
        rnd: seq(0),
      }),
    ).toBeNull();
  });

  it('taper is monotonically non-increasing', () => {
    for (let d = 1; d < PFC_MAX_CHAIN + 2; d++) {
      expect(reactionChance(d)).toBeLessThanOrEqual(reactionChance(d - 1));
    }
    expect(reactionChance(PFC_MAX_CHAIN + 5)).toBe(0);
  });

  it('forces a name-addressed peer to react, bypassing the probabilistic stop', () => {
    // Sui just said "yo marv, explain that" — even a roll that would normally
    // stop the chain (0.99 >= 0.6) must still hand the floor to Marv.
    const d = decideReaction({
      speakerId: 'sui',
      participants: duo,
      depth: 0,
      lastReactorId: null,
      text: 'yo marv explain that one to me',
      rnd: seq(0.99),
    });
    expect(d?.reactorId).toBe('marv');
  });

  it('addresses the named peer in a trio even when someone else was up next', () => {
    const trio = [SUI, MARV, LYRA];
    // Speaker Sui names Lyra directly; Marv being the last reactor is irrelevant.
    const d = decideReaction({
      speakerId: 'sui',
      participants: trio,
      depth: 0,
      lastReactorId: 'marv',
      text: 'lyra what do you think',
      rnd: seq(0.99),
    });
    expect(d?.reactorId).toBe('lyra');
  });

  it('never forces the speaker to answer themselves via their own name', () => {
    // Sui says her own name — she is filtered out of `others`, so no self-turn;
    // falls through to the normal probabilistic path (0.99 stops it).
    expect(
      decideReaction({ speakerId: 'sui', participants: duo, depth: 0, lastReactorId: null, text: 'i am sui', rnd: seq(0.99) }),
    ).toBeNull();
  });

  it('still respects the hard cap for a name-addressed reaction', () => {
    expect(
      decideReaction({
        speakerId: 'sui',
        participants: duo,
        depth: PFC_MAX_CHAIN - 1,
        lastReactorId: null,
        text: 'marv back me up',
        rnd: seq(0),
      }),
    ).toBeNull();
  });

  it('spreads reactions across the others in a trio (down-weights last reactor)', () => {
    const trio = [SUI, MARV, LYRA];
    // Speaker Sui, others = [Marv, Lyra], Marv was the last reactor (weight 0.35).
    // rnd=0.5 of total 1.35 skips Marv's 0.35 slice and lands on Lyra.
    const d = decideReaction({ speakerId: 'sui', participants: trio, depth: 0, lastReactorId: 'marv', rnd: seq(0.1, 0.5) });
    expect(d?.reactorId).toBe('lyra');
  });
});

describe('isJunkTranscript', () => {
  it('drops repeated-letter hallucinations', () => {
    expect(isJunkTranscript('hhhhh')).toBe(true);
    expect(isJunkTranscript('mmmm')).toBe(true);
    expect(isJunkTranscript('AAAA')).toBe(true);
  });

  it('drops empty, punctuation-only, and bracketed non-speech tags', () => {
    expect(isJunkTranscript('   ')).toBe(true);
    expect(isJunkTranscript('...')).toBe(true);
    expect(isJunkTranscript('[BLANK_AUDIO]')).toBe(true);
    expect(isJunkTranscript('(music)')).toBe(true);
  });

  it('drops known stock hallucinations whole', () => {
    expect(isJunkTranscript('you')).toBe(true);
    expect(isJunkTranscript('Thank you.')).toBe(true);
    expect(isJunkTranscript('Thanks for watching')).toBe(true);
  });

  it('keeps genuine short answers', () => {
    for (const t of ['yes', 'no', 'hi', 'ok', 'sure', 'what job?', 'come here']) {
      expect(isJunkTranscript(t)).toBe(false);
    }
  });
});
