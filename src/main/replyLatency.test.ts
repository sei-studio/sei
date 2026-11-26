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

  // 261123 (O5): where a voice turn's wait went.
  it('voice phases ride flat, rounded and clamped; voice only', () => {
    const phases = {
      speech_end_to_final_ms: 812.4,
      llm_request_ms: 14,
      llm_first_token_ms: 1190.5,
      line_queued_ms: 1620,
      tts_first_chunk_ms: 1e12,
    };
    expect(replyLatencyProps({ ...base, surface: 'voice', ms: 2400, phases })).toEqual({
      surface: 'voice',
      path: 'app',
      ms: 2400,
      outcome: 'replied',
      turn_index_bucket: 'first',
      sample_rate: 1,
      speech_end_to_final_ms: 812,
      llm_request_ms: 14,
      llm_first_token_ms: 1191,
      line_queued_ms: 1620,
      tts_first_chunk_ms: REPLY_MS_MAX,
    });
    // 261125: a chat sample carries only the chat keys (llm_* are shared).
    const chat = replyLatencyProps({ ...base, phases });
    expect(chat).not.toHaveProperty('speech_end_to_final_ms');
    expect(chat).not.toHaveProperty('line_queued_ms');
    expect(chat).not.toHaveProperty('tts_first_chunk_ms');
    expect(replyLatencyProps({ ...base, path: 'in_game', phases })).not.toHaveProperty('llm_first_token_ms');
  });

  it('a missing or junk phase is left out, never sent as 0', () => {
    const props = replyLatencyProps({
      ...base,
      surface: 'voice',
      phases: { line_queued_ms: Number.NaN, llm_request_ms: -3, tts_first_chunk_ms: 900 },
    });
    expect(props).not.toHaveProperty('line_queued_ms');
    expect(props).not.toHaveProperty('llm_request_ms');
    expect(props).not.toHaveProperty('llm_first_token_ms');
    expect(props?.tts_first_chunk_ms).toBe(900);
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

  it('keeps the voice phases; a bad phase drops only itself', () => {
    expect(
      sanitizeRendererReplyLatency({
        surface: 'voice',
        path: 'app',
        turn: 2,
        ms: 2600,
        outcome: 'replied',
        speech_end_to_final_ms: 900,
        llm_request_ms: 12,
        llm_first_token_ms: 1300,
        line_queued_ms: 1700,
        tts_first_chunk_ms: 'soon',
        llm_text: 'nope',
      }),
    ).toEqual({
      surface: 'voice',
      path: 'app',
      turn: 2,
      ms: 2600,
      outcome: 'replied',
      phases: { speech_end_to_final_ms: 900, llm_request_ms: 12, llm_first_token_ms: 1300, line_queued_ms: 1700 },
    });
    const neg = sanitizeRendererReplyLatency({ surface: 'voice', path: 'app', turn: 1, ms: 5, outcome: 'replied', line_queued_ms: -1 });
    expect(neg).toEqual({ surface: 'voice', path: 'app', turn: 1, ms: 5, outcome: 'replied' });
  });

  it('a sanitized sample with phases reaches capture flat', () => {
    const capture = vi.fn();
    const s = sanitizeRendererReplyLatency({ surface: 'voice', path: 'app', turn: 1, ms: 2000, outcome: 'replied', line_queued_ms: 1500 });
    recordReplyLatency(s!, capture);
    expect(capture).toHaveBeenCalledWith(REPLY_LATENCY_EVENT, expect.objectContaining({ ms: 2000, line_queued_ms: 1500 }));
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

describe('chat phases (261125, O5)', () => {
  function clock(turn = 1) {
    let t = 10_000;
    const samples: ReplyLatencySample[] = [];
    const c = startChatReplyClock({ turn, startedAt: t, now: () => t, record: (s) => samples.push(s) });
    return { c, samples, advance: (ms: number) => (t += ms), at: () => t };
  }

  it('phases are ms since the clock started; llm_calls is a count; a later mark overwrites', () => {
    const { c, samples, advance, at } = clock();
    advance(5);
    c.mark('prompt_start_ms');
    advance(20);
    c.mark('prompt_built_ms');
    c.mark('llm_request_ms', at() + 2);
    c.mark('llm_calls', 1);
    advance(900);
    c.mark('llm_response_ms');
    c.mark('llm_calls', 2);
    advance(700);
    c.mark('llm_response_ms');
    advance(10);
    c.settle({ replies: [{}] });
    expect(samples[0]).toEqual({
      surface: 'chat',
      path: 'app',
      turn: 1,
      ms: 1635,
      outcome: 'replied',
      phases: { prompt_start_ms: 5, prompt_built_ms: 25, llm_request_ms: 27, llm_calls: 2, llm_response_ms: 1625 },
    });
  });

  it('marks after the bubble reached the renderer are ignored', () => {
    const { c, samples, advance } = clock();
    c.mark('llm_request_ms');
    advance(800);
    c.replied();
    advance(3000);
    c.mark('llm_response_ms');
    c.mark('llm_calls', 3);
    expect(samples[0].phases).toEqual({ llm_request_ms: 0 });
  });

  it('no marks = no phases key (unchanged sample shape)', () => {
    const { c, samples } = clock();
    c.settle({ replies: [{}] });
    expect(samples[0]).not.toHaveProperty('phases');
  });

  it('a bad llm_calls value is dropped', () => {
    const { c, samples } = clock();
    c.mark('llm_calls', 1.5);
    c.settle({ replies: [{}] });
    expect(samples[0]).not.toHaveProperty('phases');
  });

  it('props carry the chat phases on the app path only, clamped like ms', () => {
    const base = { surface: 'chat' as const, turn: 1, ms: 2000, outcome: 'replied' as const };
    const phases = { prompt_start_ms: 4.4, llm_request_ms: 30, llm_response_ms: 1900, llm_calls: 1, llm_first_token_ms: -5 };
    const app = replyLatencyProps({ ...base, path: 'app', phases });
    expect(app).toMatchObject({ prompt_start_ms: 4, llm_request_ms: 30, llm_response_ms: 1900, llm_calls: 1 });
    expect(app).not.toHaveProperty('llm_first_token_ms');
    const inGame = replyLatencyProps({ ...base, path: 'in_game', phases });
    expect(inGame).not.toHaveProperty('llm_request_ms');
    // A voice-only key never rides a chat sample, nor a chat-only key a voice one.
    const chatWithVoiceKey = replyLatencyProps({ ...base, path: 'app', phases: { tts_first_chunk_ms: 100 } });
    expect(chatWithVoiceKey).not.toHaveProperty('tts_first_chunk_ms');
    const voice = replyLatencyProps({ surface: 'voice', path: 'app', turn: 1, ms: 2000, outcome: 'replied', phases: { prompt_built_ms: 9 } as never });
    expect(voice).not.toHaveProperty('prompt_built_ms');
  });
});
