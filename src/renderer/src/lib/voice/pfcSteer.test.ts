/**
 * PFC steer decision tests (260706) — the "who speaks when" core of the multi-
 * companion voice director. Locks in: the companion chain always hands the
 * floor to a peer under the runaway cap (banter ends on a natural lull, not a
 * dice roll), name-addressed lines force that peer, and Whisper junk never
 * becomes a turn. Randomness is injected so the varied picks are deterministic
 * here. (pickResponder was retired 260708 — player utterances broadcast to
 * every participant now, see useVoiceStore.dispatchUserTurn.)
 */
import { describe, it, expect } from 'vitest';
import { decideReaction, isJunkTranscript, PFC_MAX_CHAIN, type Participant } from './pfcSteer';

const SUI = { id: 'sui', name: 'Sui' };
const MARV = { id: 'marv', name: 'Marv' };
const LYRA = { id: 'lyra', name: 'Lyra' };
const duo: Participant[] = [SUI, MARV];

/** Deterministic rnd stub: returns each value in turn, then holds the last. */
const seq = (...vals: number[]) => {
  let i = 0;
  return () => vals[Math.min(i++, vals.length - 1)];
};

describe('decideReaction', () => {
  it('never chains on a solo call', () => {
    expect(decideReaction({ speakerId: 'sui', participants: [SUI], depth: 0, lastReactorId: null })).toBeNull();
  });

  it('picks the other companion in a duo, never the speaker', () => {
    const d = decideReaction({ speakerId: 'sui', participants: duo, depth: 0, lastReactorId: null, rnd: seq(0) });
    expect(d?.reactorId).toBe('marv');
  });

  it('always hands the floor to a peer below the cap (no random stop)', () => {
    // No matter the roll, an under-cap duo turn continues to the other companion;
    // the banter ends only when a turn produces no line (handled by the director),
    // never by a dice roll here.
    for (const r of [0.01, 0.5, 0.99]) {
      const d = decideReaction({ speakerId: 'sui', participants: duo, depth: 0, lastReactorId: null, rnd: seq(r) });
      expect(d?.reactorId).toBe('marv');
    }
  });

  it('is hard-capped as a runaway guard', () => {
    // At the cap boundary the chain stops regardless of the roll.
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

  it('forces a name-addressed peer to react', () => {
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
    // the floor still passes to the other companion (Marv), never back to Sui.
    const d = decideReaction({
      speakerId: 'sui',
      participants: duo,
      depth: 0,
      lastReactorId: null,
      text: 'i am sui',
      rnd: seq(0.99),
    });
    expect(d?.reactorId).toBe('marv');
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
    // rnd=0.5 of total 1.35 (=0.675) skips Marv's 0.35 slice and lands on Lyra.
    const d = decideReaction({ speakerId: 'sui', participants: trio, depth: 0, lastReactorId: 'marv', rnd: seq(0.5) });
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
