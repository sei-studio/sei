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
/** Wall clock (Date.now stand-in), kept at a fixed offset from `t`. */
const WALL_OFFSET = 1_700_000_000_000;
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
    wallNow: () => t + WALL_OFFSET,
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
      { surface: 'voice', path: 'app', turn: 1, ms: 2400, outcome: 'replied', line_queued_ms: 1800 },
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

  // 261123 (O5): where the wait went.
  describe('phases', () => {
    it('stamps every phase of a cloud turn, from the same dispatch', () => {
      const c = make();
      const wall = (): number => t + WALL_OFFSET;
      const spokeUntil = wall() - 300; // the player stopped talking 300ms ago...
      advance(0);
      c.utterance(1, 'app', spokeUntil - 650); // ...plus the 650ms the mic + STT took
      const dispatched = wall();
      advance(1600);
      const firstAudio = c.lineQueued({ llmStartAt: dispatched + 12, firstTokenAt: dispatched + 1100 });
      expect(firstAudio).toBeTypeOf('function');
      advance(500);
      firstAudio!();
      advance(150);
      firstAudio!(); // once only
      c.audible();
      expect(samples).toEqual([
        {
          surface: 'voice',
          path: 'app',
          turn: 1,
          ms: 2250,
          outcome: 'replied',
          speech_end_to_final_ms: 950,
          llm_request_ms: 12,
          llm_first_token_ms: 1100,
          line_queued_ms: 1600,
          tts_first_chunk_ms: 2100,
        },
      ]);
    });

    it('only the first line of a turn is timed', () => {
      const c = make();
      c.utterance(1, 'app');
      advance(1000);
      expect(c.lineQueued()).toBeTypeOf('function');
      advance(200);
      expect(c.lineQueued({ llmStartAt: t + WALL_OFFSET, firstTokenAt: t + WALL_OFFSET })).toBeNull();
      c.audible();
      expect(samples[0]).toEqual({ surface: 'voice', path: 'app', turn: 1, ms: 1200, outcome: 'replied', line_queued_ms: 1000 });
    });

    it('stamps from before the dispatch (a stale line, a stepped clock) are dropped, not zeroed', () => {
      const c = make();
      const before = t + WALL_OFFSET - 50;
      c.utterance(1, 'app', t + WALL_OFFSET + 10); // "speech ended" after the dispatch: clock stepped
      advance(400);
      c.lineQueued({ llmStartAt: before, firstTokenAt: Number.NaN });
      c.audible();
      expect(samples[0]).toEqual({ surface: 'voice', path: 'app', turn: 1, ms: 400, outcome: 'replied', line_queued_ms: 400 });
    });

    it('an aborted turn keeps the phases it reached', () => {
      const c = make();
      c.utterance(1, 'app', t + WALL_OFFSET - 700);
      advance(1500);
      const firstAudio = c.lineQueued({ llmStartAt: t + WALL_OFFSET - 1490, firstTokenAt: t + WALL_OFFSET - 300 });
      advance(300);
      c.utterance(2, 'app'); // barge-in before anything played
      firstAudio!(); // the superseded line's bytes landing late stamp nothing
      expect(samples[0]).toEqual({
        surface: 'voice',
        path: 'app',
        turn: 1,
        ms: 1800,
        outcome: 'aborted',
        speech_end_to_final_ms: 700,
        llm_request_ms: 10,
        llm_first_token_ms: 1200,
        line_queued_ms: 1500,
      });
      c.audible();
      expect(samples[1]).toEqual({ surface: 'voice', path: 'app', turn: 2, ms: 0, outcome: 'replied' });
    });
  });
});
