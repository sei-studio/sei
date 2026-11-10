/**
 * Playtime usage ledger, pure half (261110, product call 261110).
 *
 * Off the Sei cloud, the app keeps its OWN count of what the brain used so
 * the Playtime page can show it: ChatGPT-plan replies this week (the plan's
 * real meter lives at chatgpt.com, we never guess its percent or reset), and
 * for "My keys" an ESTIMATED spend from per-request tokens times the public
 * list price of the model. Unknown models are never priced as free: they
 * show tokens only.
 *
 * Main keeps one small file per profile (main/usage/llmUsageLedger.ts) of
 * per-day, per-model token totals; this module normalizes every provider's
 * usage shape, prices it and summarizes it. Node and DOM free so the
 * renderer, main and tests share it.
 */

/** Tokens of one request. `input` EXCLUDES cached tokens. */
export interface UsageTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** One day's totals for one provider/model. */
export interface UsageBucket extends UsageTokens {
  calls: number;
}

/** Ledger day: `models` is keyed `${provider}|${model}`. */
export interface UsageDay {
  models: Record<string, UsageBucket>;
}

export interface UsageLedger {
  v: 1;
  /** Local calendar day `YYYY-MM-DD` -> totals. */
  days: Record<string, UsageDay>;
}

export const EMPTY_LEDGER: UsageLedger = { v: 1, days: {} };

/** Days the ledger keeps (covers this month plus the month before). */
export const LEDGER_KEEP_DAYS = 62;

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * Normalize any provider's usage block. Shapes seen in the app:
 * - Anthropic (and main's LlmUsage, and the bot's ChatGPT adapter):
 *   input_tokens / output_tokens / cache_read_input_tokens /
 *   cache_creation_input_tokens, input already EXCLUDES cache.
 * - OpenAI Responses raw: input_tokens + input_tokens_details.cached_tokens
 *   (input INCLUDES cached).
 * - OpenAI chat completions (OpenAI, DeepSeek, Qwen, Grok, OpenRouter,
 *   Ollama compat): prompt_tokens / completion_tokens /
 *   prompt_tokens_details.cached_tokens or prompt_cache_hit_tokens (prompt
 *   INCLUDES cached).
 * - Gemini: promptTokenCount / candidatesTokenCount (+ thoughtsTokenCount) /
 *   cachedContentTokenCount (prompt INCLUDES cached).
 * Returns null when nothing usable is there.
 */
export function normalizeUsage(raw: unknown): UsageTokens | null {
  if (!raw || typeof raw !== 'object') return null;
  const u = raw as Record<string, unknown>;
  const details = (k: string): Record<string, unknown> =>
    u[k] && typeof u[k] === 'object' ? (u[k] as Record<string, unknown>) : {};

  if ('promptTokenCount' in u || 'candidatesTokenCount' in u) {
    const cached = n(u.cachedContentTokenCount);
    return {
      input: Math.max(0, n(u.promptTokenCount) - cached),
      output: n(u.candidatesTokenCount) + n(u.thoughtsTokenCount),
      cacheRead: cached,
      cacheWrite: 0,
    };
  }
  if ('prompt_tokens' in u || 'completion_tokens' in u) {
    const cached = n(details('prompt_tokens_details').cached_tokens) || n(u.prompt_cache_hit_tokens);
    return {
      input: Math.max(0, n(u.prompt_tokens) - cached),
      output: n(u.completion_tokens),
      cacheRead: cached,
      cacheWrite: 0,
    };
  }
  if ('input_tokens' in u || 'output_tokens' in u) {
    const rawCached = n(details('input_tokens_details').cached_tokens);
    if (rawCached > 0 && !('cache_read_input_tokens' in u)) {
      return {
        input: Math.max(0, n(u.input_tokens) - rawCached),
        output: n(u.output_tokens),
        cacheRead: rawCached,
        cacheWrite: 0,
      };
    }
    return {
      input: n(u.input_tokens),
      output: n(u.output_tokens),
      cacheRead: n(u.cache_read_input_tokens),
      cacheWrite: n(u.cache_creation_input_tokens),
    };
  }
  return null;
}

/** USD per million tokens. `cr`/`cw` default to `in` when absent. */
export interface ModelPrice {
  in: number;
  out: number;
  cr?: number;
  cw?: number;
}

/**
 * Public list prices (USD per 1M tokens) of the models people most often
 * pick, matched by the longest id prefix after dropping any `vendor/`
 * prefix (OpenRouter ids). Vendor list prices only: this is an estimate of
 * what the user's own key is billed, never anything Sei charges. A model
 * missing here shows tokens only. Ollama runs on the user's computer and is
 * always free.
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  // Anthropic
  'claude-haiku-5-5': { in: 0.1, out: 0.5, cr: 0.01, cw: 0.125 },
  'claude-opus-5-5': { in: 4, out: 20, cr: 0.2, cw: 5 },
  'claude-sonnet-5': { in: 2, out: 10, cr: 0.2, cw: 2.5 },
  'claude-haiku-4-5': { in: 1, out: 5, cr: 0.1, cw: 1.25 },
  'claude-haiku-4.5': { in: 1, out: 5, cr: 0.1, cw: 1.25 },
  'claude-sonnet-4-5': { in: 3, out: 15, cr: 0.3, cw: 3.75 },
  'claude-sonnet-4.5': { in: 3, out: 15, cr: 0.3, cw: 3.75 },
  'claude-sonnet-4': { in: 3, out: 15, cr: 0.3, cw: 3.75 },
  'claude-opus-4-5': { in: 5, out: 25, cr: 0.5, cw: 6.25 },
  'claude-opus-4.5': { in: 5, out: 25, cr: 0.5, cw: 6.25 },
  // OpenAI
  'gpt-6-luna': { in: 0.1, out: 0.5, cr: 0.01 },
  'gpt-5.6-luna': { in: 0.2, out: 1.2, cr: 0.02 },
  'gpt-6.1-sol': { in: 2, out: 10, cr: 0.1 },
  'gpt-6-sol': { in: 2, out: 10, cr: 0.2 },
  'gpt-5-nano': { in: 0.05, out: 0.4, cr: 0.005 },
  'gpt-5-mini': { in: 0.25, out: 2, cr: 0.025 },
  'gpt-5': { in: 1.25, out: 10, cr: 0.125 },
  'gpt-4.1-nano': { in: 0.1, out: 0.4, cr: 0.025 },
  'gpt-4.1-mini': { in: 0.4, out: 1.6, cr: 0.1 },
  'gpt-4.1': { in: 2, out: 8, cr: 0.5 },
  'gpt-4o-mini': { in: 0.15, out: 0.6, cr: 0.075 },
  'gpt-4o': { in: 2.5, out: 10, cr: 1.25 },
  // Google
  'gemini-2.5-flash-lite': { in: 0.1, out: 0.4, cr: 0.025 },
  'gemini-2.5-flash': { in: 0.3, out: 2.5, cr: 0.075 },
  'gemini-2.5-pro': { in: 1.25, out: 10, cr: 0.31 },
  // xAI
  'grok-4-fast': { in: 0.2, out: 0.5, cr: 0.05 },
  'grok-4': { in: 3, out: 15, cr: 0.75 },
  // DeepSeek
  'deepseek-chat': { in: 0.28, out: 0.42, cr: 0.028 },
  'deepseek-reasoner': { in: 0.28, out: 0.42, cr: 0.028 },
  // Qwen (international list price)
  'qwen-turbo': { in: 0.05, out: 0.2 },
  'qwen-plus': { in: 0.4, out: 1.2 },
  'qwen-max': { in: 1.6, out: 6.4 },
};

/** Price for a provider/model, `{in:0,out:0}` for Ollama, null when unknown. */
export function priceFor(provider: string, model: string): ModelPrice | null {
  if (provider === 'ollama') return { in: 0, out: 0, cr: 0, cw: 0 };
  // The ChatGPT plan is a subscription: per-request cost is not ours to show.
  if (provider === 'chatgpt') return null;
  const id = (model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model).toLowerCase();
  let best: string | null = null;
  for (const key of Object.keys(MODEL_PRICES)) {
    if (id === key || id.startsWith(`${key}-`) || id.startsWith(`${key}:`) || id.startsWith(`${key}.`)) {
      if (!best || key.length > best.length) best = key;
    }
  }
  return best ? MODEL_PRICES[best] : null;
}

/** USD cost of some tokens at a price. */
export function costUsd(t: UsageTokens, p: ModelPrice): number {
  return (
    (t.input * p.in + t.output * p.out + t.cacheRead * (p.cr ?? p.in) + t.cacheWrite * (p.cw ?? p.in)) / 1e6
  );
}

/** Local calendar day key `YYYY-MM-DD`. */
export function dayKey(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** Local month key `YYYY-MM`. */
export function monthKey(d: Date): string {
  return dayKey(d).slice(0, 7);
}

/** Add one request to the ledger (returns a new ledger; prunes old days). */
export function addUsage(
  ledger: UsageLedger,
  entry: { provider: string; model: string; tokens: UsageTokens },
  now: Date,
): UsageLedger {
  const key = dayKey(now);
  const days: Record<string, UsageDay> = { ...ledger.days };
  const day: UsageDay = { models: { ...(days[key]?.models ?? {}) } };
  const mk = `${entry.provider}|${entry.model}`;
  const prev = day.models[mk] ?? { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  day.models[mk] = {
    calls: prev.calls + 1,
    input: prev.input + entry.tokens.input,
    output: prev.output + entry.tokens.output,
    cacheRead: prev.cacheRead + entry.tokens.cacheRead,
    cacheWrite: prev.cacheWrite + entry.tokens.cacheWrite,
  };
  days[key] = day;
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - LEDGER_KEEP_DAYS);
  const cutKey = dayKey(cutoff);
  for (const k of Object.keys(days)) if (k < cutKey) delete days[k];
  return { v: 1, days };
}

/** Parse a ledger file body, tolerating junk (returns an empty ledger). */
export function parseLedger(raw: unknown): UsageLedger {
  if (!raw || typeof raw !== 'object') return { v: 1, days: {} };
  const days = (raw as { days?: unknown }).days;
  if (!days || typeof days !== 'object') return { v: 1, days: {} };
  const out: Record<string, UsageDay> = {};
  for (const [k, d] of Object.entries(days as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || !d || typeof d !== 'object') continue;
    const models = (d as { models?: unknown }).models;
    if (!models || typeof models !== 'object') continue;
    const m: Record<string, UsageBucket> = {};
    for (const [mk, b] of Object.entries(models as Record<string, unknown>)) {
      if (!b || typeof b !== 'object') continue;
      const r = b as Record<string, unknown>;
      m[mk] = { calls: n(r.calls), input: n(r.input), output: n(r.output), cacheRead: n(r.cacheRead), cacheWrite: n(r.cacheWrite) };
    }
    out[k] = { models: m };
  }
  return { v: 1, days: out };
}

/** One day in the 7-day chart. */
export interface UsageDayPoint {
  /** `YYYY-MM-DD` */
  day: string;
  /** 0 = Sunday ... 6 = Saturday (local). */
  weekday: number;
  chatgptReplies: number;
  /** Estimated spend for priced models (USD). */
  spendUsd: number;
  /** Tokens of models we have no price for. */
  unpricedTokens: number;
}

export interface UsageSummary {
  /** The last 7 days, oldest first; the last entry is today. */
  days: UsageDayPoint[];
  chatgptRepliesWeek: number;
  spendWeekUsd: number;
  spendMonthUsd: number;
  /** Tokens this week/month from models with no known price. */
  unpricedTokensWeek: number;
  unpricedTokensMonth: number;
  /** Tokens this week/month from every own-key model (priced or not). */
  tokensWeek: number;
  tokensMonth: number;
}

export const EMPTY_SUMMARY: UsageSummary = {
  days: [],
  chatgptRepliesWeek: 0,
  spendWeekUsd: 0,
  spendMonthUsd: 0,
  unpricedTokensWeek: 0,
  unpricedTokensMonth: 0,
  tokensWeek: 0,
  tokensMonth: 0,
};

function tally(day: UsageDay | undefined): { replies: number; spend: number; unpriced: number; tokens: number } {
  let replies = 0;
  let spend = 0;
  let unpriced = 0;
  let tokens = 0;
  for (const [mk, b] of Object.entries(day?.models ?? {})) {
    const cut = mk.indexOf('|');
    const provider = cut < 0 ? mk : mk.slice(0, cut);
    const model = cut < 0 ? '' : mk.slice(cut + 1);
    if (provider === 'chatgpt') {
      replies += b.calls;
      continue;
    }
    const all = b.input + b.output + b.cacheRead + b.cacheWrite;
    tokens += all;
    const p = priceFor(provider, model);
    if (p) spend += costUsd(b, p);
    else unpriced += all;
  }
  return { replies, spend, unpriced, tokens };
}

/** Summaries for the Playtime page: rolling 7 days and the calendar month. */
export function summarizeUsage(ledger: UsageLedger, now: Date): UsageSummary {
  const days: UsageDayPoint[] = [];
  let repliesWeek = 0;
  let spendWeek = 0;
  let unpricedWeek = 0;
  let tokensWeek = 0;
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = dayKey(d);
    const t = tally(ledger.days[key]);
    days.push({ day: key, weekday: d.getDay(), chatgptReplies: t.replies, spendUsd: t.spend, unpricedTokens: t.unpriced });
    repliesWeek += t.replies;
    spendWeek += t.spend;
    unpricedWeek += t.unpriced;
    tokensWeek += t.tokens;
  }
  const month = monthKey(now);
  let spendMonth = 0;
  let unpricedMonth = 0;
  let tokensMonth = 0;
  for (const [k, d] of Object.entries(ledger.days)) {
    if (!k.startsWith(month)) continue;
    const t = tally(d);
    spendMonth += t.spend;
    unpricedMonth += t.unpriced;
    tokensMonth += t.tokens;
  }
  return {
    days,
    chatgptRepliesWeek: repliesWeek,
    spendWeekUsd: spendWeek,
    spendMonthUsd: spendMonth,
    unpricedTokensWeek: unpricedWeek,
    unpricedTokensMonth: unpricedMonth,
    tokensWeek,
    tokensMonth,
  };
}

/** Amounts the "Alert me at $N a month" picker offers. */
export const SPEND_ALERT_AMOUNTS = [5, 10, 20, 50, 100] as const;
export const DEFAULT_SPEND_ALERT_USD = 10;

/**
 * Whether the monthly spend alert should fire now: on, a positive amount,
 * this month's estimate at or over it, and not already fired this month.
 * The alert only warns; nothing is ever blocked.
 */
export function shouldFireSpendAlert(
  cfg: { spend_alert_enabled?: unknown; spend_alert_usd?: unknown; spend_alert_fired_month?: unknown },
  spendMonthUsd: number,
  now: Date,
): boolean {
  if (cfg.spend_alert_enabled !== true) return false;
  const limit = typeof cfg.spend_alert_usd === 'number' && cfg.spend_alert_usd > 0 ? cfg.spend_alert_usd : 0;
  if (limit <= 0) return false;
  if (cfg.spend_alert_fired_month === monthKey(now)) return false;
  return spendMonthUsd >= limit;
}

/** Spend as `$1.23` (two decimals, `<$0.01` for tiny non-zero amounts). */
export function formatUsd(v: number): string {
  if (v > 0 && v < 0.01) return '<$0.01';
  return `$${v.toFixed(2)}`;
}

/** Token counts as `950`, `12.3k`, `4.5M`. */
export function formatTokens(v: number): string {
  if (v < 1000) return String(Math.round(v));
  if (v < 1e6) return `${(v / 1000).toFixed(v < 1e4 ? 1 : 0)}k`;
  return `${(v / 1e6).toFixed(1)}M`;
}
