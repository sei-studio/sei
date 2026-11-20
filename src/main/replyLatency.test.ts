/**
 * reply_latency (261106): sampling, props shape, the trust-boundary parsers
 * for the renderer and bot samples, and the chat clock's outcomes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { captureSpy } = vi.hoisted(() => ({ captureSpy: vi.fn() }));
vi.mock('./analytics', () => ({ capture: captureSpy }));

import {
  REPLY_LATENCY_EVENT,
  REPLY_MS_MAX,
  parseBotReplyLatency,
  recordReplyLatency,
  replyLatencyProps,
  sampleRate,
  sanitizeRendererReplyLatency,
  startChatReplyClock,
  turnIndexBucket,
  type ReplyLatencySample,
} from './replyLatency';

beforeEach(() => captureSpy.mockClear());

describe('turnIndexBucket', () => {
  it('first / 2-5 / 6+', () => {
    expect(turnIndexBucket(1)).toBe('first');
    expect([2, 3, 4, 5].map(turnIndexBucket)).toEqual(['2-5', '2-5', '2-5', '2-5']);
    expect([6, 10, 99].map(turnIndexBucket)).toEqual(['6+', '6+', '6+']);
  });
});

describe('sampleRate', () => {
  it('sends every one of the first five turns, then every tenth', () => {
    const sent = Array.from({ length: 40 }, (_, i) => i + 1).filter((t) => sampleRate(t) > 0);
    expect(sent).toEqual([1, 2, 3, 4, 5, 10, 20, 30, 40]);
    expect(sampleRate(3)).toBe(1);
    expect(sampleRate(20)).toBe(10);
  });

  it('a bucket never mixes sample rates (per-bucket percentiles need no weights)', () => {
    const rates = (from: number, to: number): Set<number> => {
      const s = new Set<number>();
      for (let t = from; t <= to; t++) if (sampleRate(t) > 0) s.add(sampleRate(t));
      return s;
    };
    expect(rates(1, 5)).toEqual(new Set([1]));
    expect(rates(6, 500)).toEqual(new Set([10]));
  });

  it('rejects junk turn numbers', () => {
    expect(sampleRate(0)).toBe(0);
    expect(sampleRate(-1)).toBe(0);
    expect(sampleRate(1.5)).toBe(0);
    expect(sampleRate(Number.NaN)).toBe(0);
  });

  it('caps a long session at 5 + n/10 events', () => {
    const n = 200;
    let events = 0;
    for (let t = 1; t <= n; t++) if (sampleRate(t) > 0) events++;
    expect(events).toBe(5 + n / 10);
  });
});

describe('replyLatencyProps', () => {
  const base: ReplyLatencySample = { surface: 'chat', path: 'app', turn: 1, ms: 1234.6, outcome: 'replied' };

  it('shape only: closed enums, rounded raw ms, bucket and rate', () => {
    expect(replyLatencyProps(base)).toEqual({
      surface: 'chat',
      path: 'app',
      ms: 1235,
      outcome: 'replied',
      turn_index_bucket: 'first',
      sample_rate: 1,
    });
  });

  it('null for an unsampled turn', () => {
    expect(replyLatencyProps({ ...base, turn: 7 })).toBeNull();
  });

  it('clamps ms into [0, REPLY_MS_MAX]', () => {
    expect(replyLatencyProps({ ...base, ms: -5 })?.ms).toBe(0);
    expect(replyLatencyProps({ ...base, ms: 1e12 })?.ms).toBe(REPLY_MS_MAX);
    expect(replyLatencyProps({ ...base, ms: Number.NaN })?.ms).toBe(0);
  });

  it('via rides on minecraft only', () => {
    expect(replyLatencyProps({ ...base, surface: 'minecraft', path: 'in_game', via: 'action' })?.via).toBe('action');
    expect(replyLatencyProps({ ...base, via: 'say' })).not.toHaveProperty('via');
  });
});

describe('recordReplyLatency', () => {
  it('captures sampled turns through the lazy analytics import', async () => {
    recordReplyLatency({ surface: 'voice', path: 'app', turn: 2, ms: 900, outcome: 'replied' });
    await vi.waitFor(() => expect(captureSpy).toHaveBeenCalledTimes(1));
    expect(captureSpy).toHaveBeenCalledWith(REPLY_LATENCY_EVENT, {
      surface: 'voice',
      path: 'app',
      ms: 900,
      outcome: 'replied',
      turn_index_bucket: '2-5',
      sample_rate: 1,
    });
  });

  it('drops unsampled turns', () => {
    const capture = vi.fn();
    recordReplyLatency({ surface: 'voice', path: 'app', turn: 8, ms: 900, outcome: 'replied' }, capture);
    expect(capture).not.toHaveBeenCalled();
  });
});

describe('sanitizeRendererReplyLatency', () => {
  it('accepts the voice clock sample', () => {
    expect(
      sanitizeRendererReplyLatency({ surface: 'voice', path: 'in_game', turn: 3, ms: 2100, outcome: 'silent' }),
    ).toEqual({ surface: 'voice', path: 'in_game', turn: 3, ms: 2100, outcome: 'silent' });
  });

  it('drops other surfaces, unknown enums, extra free text and bad numbers', () => {
    expect(sanitizeRendererReplyLatency({ surface: 'chat', path: 'app', turn: 1, ms: 1, outcome: 'replied' })).toBeNull();
    expect(sanitizeRendererReplyLatency({ surface: 'voice', path: 'app', turn: 1, ms: 1, outcome: 'great' })).toBeNull();
    expect(sanitizeRendererReplyLatency({ surface: 'voice', path: 'app', turn: 0, ms: 1, outcome: 'replied' })).toBeNull();
    expect(sanitizeRendererReplyLatency({ surface: 'voice', path: 'app', turn: 1, ms: -1, outcome: 'replied' })).toBeNull();
    expect(sanitizeRendererReplyLatency(undefined)).toBeNull();
    const extra = sanitizeRendererReplyLatency({ surface: 'voice', path: 'app', turn: 1, ms: 5, outcome: 'replied', text: 'hi there' });
    expect(extra).not.toHaveProperty('text');
  });
});

describe('parseBotReplyLatency', () => {
  it('a game-chat line is the minecraft surface, with via', () => {
    expect(parseBotReplyLatency({ type: 'reply-latency', origin: 'game', turn: 1, ms: 1800, outcome: 'replied', via: 'say' })).toEqual({
      surface: 'minecraft',
      path: 'in_game',
      turn: 1,
      ms: 1800,
      outcome: 'replied',
      via: 'say',
    });
  });

  it('a Sei chat routed into the game is the chat surface on the in_game path', () => {
    expect(parseBotReplyLatency({ type: 'reply-latency', origin: 'app', turn: 2, ms: 3000, outcome: 'replied', via: 'say' })).toEqual({
      surface: 'chat',
      path: 'in_game',
      turn: 2,
      ms: 3000,
      outcome: 'replied',
    });
  });

  it('rejects anything malformed', () => {
    expect(parseBotReplyLatency({ type: 'reply-latency', origin: 'x', turn: 1, ms: 1, outcome: 'replied' })).toBeNull();
    expect(parseBotReplyLatency({ type: 'session-digest' })).toBeNull();
    expect(parseBotReplyLatency(null)).toBeNull();
  });
});

describe('startChatReplyClock', () => {
  function clock(turn = 1) {
    let t = 10_000;
    const samples: ReplyLatencySample[] = [];
    const c = startChatReplyClock({ turn, startedAt: t, now: () => t, record: (s) => samples.push(s) });
    return { c, samples, advance: (ms: number) => (t += ms) };
  }

  it('the returned reply stops the clock', () => {
    const { c, samples, advance } = clock(2);
    advance(2500);
    c.settle({ replies: [{}] });
    expect(samples).toEqual([{ surface: 'chat', path: 'app', turn: 2, ms: 2500, outcome: 'replied' }]);
  });

  it('an early pushed line (before a web lookup) stops it first; the settle is a no-op', () => {
    const { c, samples, advance } = clock();
    advance(900);
    c.replied();
    advance(4000);
    c.settle({ replies: [{}] });
    expect(samples).toEqual([{ surface: 'chat', path: 'app', turn: 1, ms: 900, outcome: 'replied' }]);
  });

  it('no replies = silent', () => {
    const { c, samples } = clock();
    c.settle({ replies: [] });
    expect(samples[0].outcome).toBe('silent');
  });

  it('a routed send records nothing (the bot times it)', () => {
    const { c, samples } = clock();
    c.settle({ replies: [], routed: true });
    c.replied();
    expect(samples).toEqual([]);
  });

  it('CHAT_ABORTED = aborted, any other rejection = error', () => {
    const a = clock();
    const e = new Error('CHAT_ABORTED');
    a.c.settle(null, e);
    expect(a.samples[0].outcome).toBe('aborted');
    const b = clock();
    b.c.settle(null, new Error('PROXY_HTTP_500'));
    expect(b.samples[0].outcome).toBe('error');
  });
});
