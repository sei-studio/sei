/**
 * Voice reply clock (261106): utterance -> first audible clip, per call.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createVoiceReplyClock,
  VOICE_REPLY_GIVE_UP_MS,
  VOICE_SETTLE_GRACE_MS,
  type VoiceReplySample,
} from './replyClock';

let t = 0;
let timers: { at: number; fn: () => void; id: number }[] = [];
let nextId = 1;
let samples: VoiceReplySample[] = [];

function advance(ms: number): void {
  const until = t + ms;
  for (;;) {
    timers.sort((a, b) => a.at - b.at);
    const next = timers[0];
    if (!next || next.at > until) break;
    timers.shift();
    t = next.at;
    next.fn();
  }
  t = until;
}

function make() {
  return createVoiceReplyClock({
    now: () => t,
    report: (s) => samples.push(s),
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.push({ at: t + ms, fn, id });
      return id;
    },
    clearTimer: (h) => {
      timers = timers.filter((x) => x.id !== h);
    },
  });
}

beforeEach(() => {
  t = 1000;
  timers = [];
  samples = [];
});

describe('voice reply clock', () => {
  it('replied at the first audible clip, numbered within the call', () => {
    const c = make();
    c.reset();
    c.utterance(1, 'app');
    advance(1800);
    c.lineQueued();
    advance(600);
    c.audible();
    c.audible(); // a second clip of the same reply is not another turn
    c.utterance(2, 'app');
    advance(1000);
    c.audible();
    expect(samples).toEqual([
      { surface: 'voice', path: 'app', turn: 1, ms: 2400, outcome: 'replied' },
      { surface: 'voice', path: 'app', turn: 2, ms: 1000, outcome: 'replied' },
    ]);
    expect(timers).toHaveLength(0);
  });

  it('a barge-in utterance aborts the waiting turn', () => {
    const c = make();
    c.utterance(1, 'in_game');
    advance(700);
    c.utterance(2, 'in_game');
    expect(samples).toEqual([{ surface: 'voice', path: 'in_game', turn: 1, ms: 700, outcome: 'aborted' }]);
  });

  it('hanging up aborts; a new call restarts the turn count', () => {
    const c = make();
    c.utterance(1, 'app');
    c.audible();
    c.utterance(2, 'app');
    advance(300);
    c.end();
    expect(samples[1]).toMatchObject({ turn: 2, outcome: 'aborted', ms: 300 });
    c.reset();
    c.utterance(5, 'app');
    c.audible();
    expect(samples[2].turn).toBe(1);
  });

  it('settled with nothing queued is silent after the grace', () => {
    const c = make();
    c.utterance(1, 'app');
    advance(1200);
    c.settled(1);
    advance(VOICE_SETTLE_GRACE_MS - 1);
    expect(samples).toEqual([]);
    advance(1);
    expect(samples).toEqual([{ surface: 'voice', path: 'app', turn: 1, ms: 1200 + VOICE_SETTLE_GRACE_MS, outcome: 'silent' }]);
  });

  it('a straggler line inside the grace keeps the turn open for its audio', () => {
    const c = make();
    c.utterance(1, 'app');
    c.settled(1);
    advance(500);
    c.lineQueued();
    advance(VOICE_SETTLE_GRACE_MS);
    expect(samples).toEqual([]);
    advance(400);
    c.audible();
    expect(samples[0]).toMatchObject({ outcome: 'replied', ms: 900 + VOICE_SETTLE_GRACE_MS });
  });

  it('a settle or failure for a stale turn is ignored', () => {
    const c = make();
    c.utterance(1, 'app');
    c.utterance(2, 'app'); // turn 1 aborted
    c.failed(1);
    c.settled(1);
    advance(VOICE_SETTLE_GRACE_MS);
    expect(samples.map((s) => s.outcome)).toEqual(['aborted']);
    c.audible();
    expect(samples[1]).toMatchObject({ turn: 2, outcome: 'replied' });
  });

  it('the director giving up = error', () => {
    const c = make();
    c.utterance(1, 'app');
    c.failed(1);
    c.settled(1);
    advance(VOICE_SETTLE_GRACE_MS);
    expect(samples[0]).toMatchObject({ outcome: 'error' });
  });

  it('give-up timer: silent with nothing queued (in-game), error when a queued line never played', () => {
    const c = make();
    c.utterance(1, 'in_game');
    advance(VOICE_REPLY_GIVE_UP_MS);
    expect(samples[0]).toMatchObject({ outcome: 'silent', ms: VOICE_REPLY_GIVE_UP_MS });
    c.utterance(2, 'app');
    c.lineQueued();
    advance(VOICE_REPLY_GIVE_UP_MS);
    expect(samples[1]).toMatchObject({ outcome: 'error', turn: 2 });
  });

  it('audio with no pending turn (a greeting, a reaction) reports nothing', () => {
    const c = make();
    c.reset();
    c.lineQueued();
    c.audible();
    c.end();
    expect(samples).toEqual([]);
  });
});
