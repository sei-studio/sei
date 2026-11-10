/**
 * The Playtime usage ledger, pure half (261110): provider usage shapes,
 * the spend estimate, the ChatGPT reply counter and the spend alert rule.
 */
import { describe, expect, it } from 'vitest';
import {
  EMPTY_LEDGER,
  addUsage,
  costUsd,
  dayKey,
  formatTokens,
  formatUsd,
  normalizeUsage,
  parseLedger,
  priceFor,
  shouldFireSpendAlert,
  summarizeUsage,
  type UsageLedger,
} from './llmUsage';

const T = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite });
const at = (iso: string) => new Date(`${iso}T12:00:00`);

function add(l: UsageLedger, provider: string, model: string, tokens: ReturnType<typeof T>, when: Date): UsageLedger {
  return addUsage(l, { provider, model, tokens }, when);
}

describe('normalizeUsage', () => {
  it('Anthropic: input already excludes cache', () => {
    expect(
      normalizeUsage({ input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 5 }),
    ).toEqual(T(100, 20, 50, 5));
  });
  it('OpenAI Responses: cached tokens come out of input', () => {
    expect(normalizeUsage({ input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 30 } })).toEqual(
      T(70, 20, 30, 0),
    );
  });
  it('chat completions: cached prompt tokens come out of the prompt (OpenAI and DeepSeek shapes)', () => {
    expect(normalizeUsage({ prompt_tokens: 100, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 40 } })).toEqual(
      T(60, 9, 40, 0),
    );
    expect(normalizeUsage({ prompt_tokens: 100, completion_tokens: 9, prompt_cache_hit_tokens: 25 })).toEqual(T(75, 9, 25, 0));
  });
  it('Gemini: thoughts count as output', () => {
    expect(
      normalizeUsage({ promptTokenCount: 100, candidatesTokenCount: 10, thoughtsTokenCount: 5, cachedContentTokenCount: 20 }),
    ).toEqual(T(80, 15, 20, 0));
  });
  it('junk is null, never NaN', () => {
    expect(normalizeUsage(null)).toBeNull();
    expect(normalizeUsage({})).toBeNull();
    expect(normalizeUsage({ input_tokens: 'x', output_tokens: -3 })).toEqual(T(0, 0, 0, 0));
  });
});

describe('priceFor / costUsd (the own-key spend estimate)', () => {
  it('matches the longest id prefix and drops a vendor/ prefix', () => {
    expect(priceFor('anthropic', 'claude-sonnet-4-5-20250929')).toEqual(priceFor('anthropic', 'claude-sonnet-4-5'));
    expect(priceFor('openrouter', 'anthropic/claude-sonnet-4-5')).toEqual(priceFor('anthropic', 'claude-sonnet-4-5'));
    expect(priceFor('openai', 'GPT-5-MINI')).toEqual(priceFor('openai', 'gpt-5-mini'));
  });
  it('Ollama is free, the ChatGPT plan and unknown models are not priced', () => {
    expect(priceFor('ollama', 'qwen3:8b')).toEqual({ in: 0, out: 0, cr: 0, cw: 0 });
    expect(priceFor('chatgpt', 'gpt-5-mini')).toBeNull();
    expect(priceFor('openai', 'some-model-nobody-has')).toBeNull();
  });
  it('prices per million tokens, cache reads at their own rate', () => {
    expect(costUsd(T(1_000_000, 1_000_000, 1_000_000, 0), { in: 3, out: 15, cr: 0.3 })).toBeCloseTo(18.3, 6);
    // cr/cw default to the input price.
    expect(costUsd(T(0, 0, 1_000_000, 1_000_000), { in: 2, out: 8 })).toBeCloseTo(4, 6);
  });
});

describe('summarizeUsage', () => {
  it('counts ChatGPT plan replies this week, per day, oldest first', () => {
    const now = at('2026-11-10');
    let l = EMPTY_LEDGER;
    l = add(l, 'chatgpt', 'gpt-5-mini', T(0, 0), at('2026-11-10'));
    l = add(l, 'chatgpt', 'gpt-5-mini', T(10, 10), at('2026-11-10'));
    l = add(l, 'chatgpt', 'gpt-5-mini', T(10, 10), at('2026-11-08'));
    l = add(l, 'chatgpt', 'gpt-5-mini', T(10, 10), at('2026-11-01')); // 9 days ago: outside the week
    const s = summarizeUsage(l, now);
    expect(s.chatgptRepliesWeek).toBe(3);
    expect(s.days).toHaveLength(7);
    expect(s.days[6].day).toBe('2026-11-10');
    expect(s.days[0].day).toBe('2026-11-04');
    expect(s.days.map((d) => d.chatgptReplies)).toEqual([0, 0, 0, 0, 1, 0, 2]);
    // Plan replies are never own-key spend.
    expect(s.spendWeekUsd).toBe(0);
    expect(s.tokensWeek).toBe(0);
  });

  it('estimates week and calendar-month spend; unknown models show tokens instead', () => {
    const now = at('2026-11-03');
    let l = EMPTY_LEDGER;
    const p = priceFor('anthropic', 'claude-sonnet-4-5');
    expect(p).not.toBeNull();
    l = add(l, 'anthropic', 'claude-sonnet-4-5', T(1_000_000, 0), at('2026-11-03'));
    l = add(l, 'anthropic', 'claude-sonnet-4-5', T(1_000_000, 0), at('2026-10-30')); // this week, last month
    l = add(l, 'openai', 'mystery-model', T(400, 100), at('2026-11-02'));
    const s = summarizeUsage(l, now);
    expect(s.spendWeekUsd).toBeCloseTo(2 * p!.in, 6);
    expect(s.spendMonthUsd).toBeCloseTo(p!.in, 6);
    expect(s.unpricedTokensWeek).toBe(500);
    expect(s.unpricedTokensMonth).toBe(500);
    expect(s.tokensWeek).toBe(2_000_500);
    expect(s.days.find((d) => d.day === '2026-11-02')?.unpricedTokens).toBe(500);
  });

  it('a ledger round-trips through JSON and prunes days past the keep window', () => {
    let l = add(EMPTY_LEDGER, 'anthropic', 'claude-sonnet-4-5', T(5, 5), at('2026-08-01'));
    l = add(l, 'anthropic', 'claude-sonnet-4-5', T(5, 5), at('2026-11-10'));
    expect(Object.keys(l.days)).toEqual(['2026-11-10']);
    expect(parseLedger(JSON.parse(JSON.stringify(l)))).toEqual(l);
    expect(parseLedger({ days: { nope: {}, '2026-11-10': { models: { 'a|b': { calls: 'x' } } } } })).toEqual({
      v: 1,
      days: { '2026-11-10': { models: { 'a|b': { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } } },
    });
  });
});

describe('shouldFireSpendAlert (warns once a month, never blocks)', () => {
  const now = at('2026-11-10');
  it('fires at or over the amount when on', () => {
    expect(shouldFireSpendAlert({ spend_alert_enabled: true, spend_alert_usd: 10 }, 10, now)).toBe(true);
    expect(shouldFireSpendAlert({ spend_alert_enabled: true, spend_alert_usd: 10 }, 9.99, now)).toBe(false);
  });
  it('off, no amount, or already fired this month: silent', () => {
    expect(shouldFireSpendAlert({ spend_alert_enabled: false, spend_alert_usd: 10 }, 50, now)).toBe(false);
    expect(shouldFireSpendAlert({ spend_alert_enabled: true }, 50, now)).toBe(false);
    expect(
      shouldFireSpendAlert({ spend_alert_enabled: true, spend_alert_usd: 10, spend_alert_fired_month: '2026-11' }, 50, now),
    ).toBe(false);
    // Fired last month: this month can fire again.
    expect(
      shouldFireSpendAlert({ spend_alert_enabled: true, spend_alert_usd: 10, spend_alert_fired_month: '2026-10' }, 50, now),
    ).toBe(true);
  });
});

describe('formatting', () => {
  it('USD and tokens', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.004)).toBe('<$0.01');
    expect(formatUsd(13.8)).toBe('$13.80');
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(1234)).toBe('1.2k');
    expect(formatTokens(45_000)).toBe('45k');
    expect(formatTokens(4_500_000)).toBe('4.5M');
  });
  it('dayKey is the local calendar day', () => {
    expect(dayKey(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });
});
