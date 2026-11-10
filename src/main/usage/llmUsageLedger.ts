/**
 * Playtime usage ledger, main half (261110, product call 261110).
 *
 * Off the Sei cloud, every completed LLM request (main's providers via
 * withUsageMeter, the bot's via its 'llm-usage' port message) adds its
 * tokens here: one small JSON file per profile, per-day per-model totals
 * (shared/llmUsage.ts owns the shape, pricing and summaries). The Playtime
 * page reads the summary: ChatGPT-plan replies this week, and for own keys
 * an estimated spend. Cloud (Sei plan) requests are never recorded, the
 * proxy's ledger is the truth there.
 *
 * Writes are serialized, resolve the profile when the request is RECORDED
 * (a write in flight across an account switch lands in the profile it began
 * in) and are registered with trackScopedWrite. After each record the
 * monthly spend alert is checked (config spend_alert_*): it only warns.
 */
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { getActiveScope, profileRootFor } from '../paths';
import { writeFileDurable } from '../durableWrite';
import { trackScopedWrite } from '../profile/scopeBarrier';
import {
  addUsage,
  monthKey,
  normalizeUsage,
  parseLedger,
  shouldFireSpendAlert,
  summarizeUsage,
  type UsageLedger,
  type UsageSummary,
} from '../../shared/llmUsage';
import type { LlmProvider } from '../llm/types';

export const LEDGER_FILE = 'llm-usage.json';

function ledgerPath(scope: string): string {
  return path.join(profileRootFor(scope), LEDGER_FILE);
}

/** Cached ledger per scope (the file is only written from this module). */
const cache = new Map<string, UsageLedger>();
let chain: Promise<unknown> = Promise.resolve();

async function readLedger(scope: string): Promise<UsageLedger> {
  const hit = cache.get(scope);
  if (hit) return hit;
  let ledger: UsageLedger;
  try {
    ledger = parseLedger(JSON.parse(await readFile(ledgerPath(scope), 'utf8')));
  } catch {
    ledger = { v: 1, days: {} };
  }
  cache.set(scope, ledger);
  return ledger;
}

export interface SpendAlertEvent {
  limitUsd: number;
  spendMonthUsd: number;
}

type AlertSink = (e: SpendAlertEvent) => void;
let alertSink: AlertSink | null = null;

/** Wire the renderer push for the spend alert (main/ipc.ts). */
export function onSpendAlert(fn: AlertSink | null): void {
  alertSink = fn;
}

/** Test seams. */
export function _resetUsageLedgerForTests(): void {
  cache.clear();
  chain = Promise.resolve();
  alertSink = null;
}

/**
 * Record one completed request. Never throws; a request with no usable
 * usage block is still counted as a call (tokens 0), so a ChatGPT reply
 * whose usage is missing still counts as a reply.
 */
export function recordLlmUsage(entry: { provider: string; model: string; usage: unknown }): Promise<void> {
  let scope: string;
  try {
    scope = getActiveScope();
  } catch {
    return Promise.resolve();
  }
  const tokens = normalizeUsage(entry.usage) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const provider = String(entry.provider || 'unknown');
  const model = String(entry.model || '');
  const run = async (): Promise<void> => {
    const now = new Date();
    const next = addUsage(await readLedger(scope), { provider, model, tokens }, now);
    cache.set(scope, next);
    const target = ledgerPath(scope);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFileDurable(target, JSON.stringify(next));
    if (provider !== 'chatgpt') await checkSpendAlert(scope, next, now);
  };
  const p = chain.then(run, run).catch((err) => {
    console.warn(`[sei/usage] ledger write failed: ${(err as Error).message}`);
  });
  chain = p;
  return trackScopedWrite(p);
}

async function checkSpendAlert(scope: string, ledger: UsageLedger, now: Date): Promise<void> {
  // Members are read where used, not destructured up front: updateConfig is
  // only needed once the alert fires.
  const configStore = await import('../configStore');
  if (getActiveScope() !== scope) return;
  const cfg = await configStore.loadConfig();
  const spend = summarizeUsage(ledger, now).spendMonthUsd;
  if (!shouldFireSpendAlert(cfg, spend, now)) return;
  const month = monthKey(now);
  await configStore.updateConfig((c) => ({ ...c, spend_alert_fired_month: month }), { scope });
  const limitUsd = cfg.spend_alert_usd ?? 0;
  try {
    alertSink?.({ limitUsd, spendMonthUsd: spend });
  } catch {
    /* a closed window must not break the ledger */
  }
  try {
    const { loadAnalytics } = await import('../lazyAnalytics');
    const { capture } = await loadAnalytics();
    capture('spend_alert_fired', { limit_usd: limitUsd, provider_kind: 'own_key' });
  } catch {
    /* analytics are best-effort */
  }
}

/** The Playtime summary for the active profile. */
export async function readUsageSummary(now: Date = new Date()): Promise<UsageSummary> {
  await chain.catch(() => undefined);
  return summarizeUsage(await readLedger(getActiveScope()), now);
}

/**
 * Wrap a main-process provider so each completed call is recorded. Used for
 * the local (own key / ChatGPT plan) branch only; cloud calls are the
 * proxy's to count.
 */
export function withUsageMeter(provider: LlmProvider): LlmProvider {
  const call = provider.call.bind(provider);
  return {
    ...provider,
    async call(params) {
      const result = await call(params);
      // Only the Anthropic adapter honors a per-call model (the Sonnet folds).
      const model = provider.kind === 'anthropic' && params.model ? params.model : provider.model;
      void recordLlmUsage({ provider: provider.kind, model, usage: result.usage });
      return result;
    },
  };
}
