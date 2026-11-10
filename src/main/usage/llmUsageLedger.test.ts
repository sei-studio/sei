/**
 * The Playtime usage ledger, main half (261110): recording, the summary the
 * page reads, the meter wrapper, and the once-a-month spend alert.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const h = vi.hoisted(() => ({
  cfg: {} as Record<string, unknown>,
  captured: [] as Array<{ event: string; props: unknown }>,
}));

vi.mock('../configStore', () => ({
  loadConfig: async () => ({ ...h.cfg }),
  updateConfig: async (fn: (c: Record<string, unknown>) => Record<string, unknown>) => {
    h.cfg = fn({ ...h.cfg });
    return h.cfg;
  },
}));
vi.mock('../lazyAnalytics', () => ({
  loadAnalytics: async () => ({ capture: (event: string, props: unknown) => h.captured.push({ event, props }) }),
}));

import { _setUserDataOverride, getActiveScope, profileRootFor } from '../paths';
import { drainScopedWrites } from '../profile/scopeBarrier';
import { priceFor } from '../../shared/llmUsage';
import {
  LEDGER_FILE,
  _resetUsageLedgerForTests,
  onSpendAlert,
  readUsageSummary,
  recordLlmUsage,
  withUsageMeter,
} from './llmUsageLedger';
import type { LlmProvider } from '../llm/types';

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'sei-usage-'));
  _setUserDataOverride(dir);
  _resetUsageLedgerForTests();
  h.cfg = {};
  h.captured = [];
});
afterEach(async () => {
  await drainScopedWrites();
  _setUserDataOverride(null);
  await rm(dir, { recursive: true, force: true });
});

describe('recordLlmUsage + readUsageSummary', () => {
  it('counts ChatGPT plan replies (a reply with no usage block still counts) and writes the profile file', async () => {
    await recordLlmUsage({ provider: 'chatgpt', model: 'gpt-5-mini', usage: { input_tokens: 10, output_tokens: 5 } });
    await recordLlmUsage({ provider: 'chatgpt', model: 'gpt-5-mini', usage: undefined });
    const s = await readUsageSummary();
    expect(s.chatgptRepliesWeek).toBe(2);
    expect(s.days[6].chatgptReplies).toBe(2);
    const onDisk = JSON.parse(await readFile(path.join(profileRootFor(getActiveScope()), LEDGER_FILE), 'utf8'));
    expect(Object.values(onDisk.days)).toHaveLength(1);
  });

  it('estimates own-key spend from tokens', async () => {
    const p = priceFor('anthropic', 'claude-sonnet-4-5')!;
    await recordLlmUsage({ provider: 'anthropic', model: 'claude-sonnet-4-5', usage: { input_tokens: 1_000_000, output_tokens: 0 } });
    const s = await readUsageSummary();
    expect(s.spendWeekUsd).toBeCloseTo(p.in, 6);
    expect(s.spendMonthUsd).toBeCloseTo(p.in, 6);
  });

  it('withUsageMeter records each completed call under the provider and model', async () => {
    const inner = {
      kind: 'openai',
      model: 'mystery-model',
      call: vi.fn(async () => ({ text: 'hi', usage: { prompt_tokens: 30, completion_tokens: 12 } })),
    } as unknown as LlmProvider;
    const metered = withUsageMeter(inner);
    await metered.call({} as never);
    await drainScopedWrites();
    const s = await readUsageSummary();
    expect(s.unpricedTokensWeek).toBe(42);
  });
});

describe('spend alert', () => {
  const big = { input_tokens: 10_000_000, output_tokens: 0 };

  it('fires once a month when on and over the amount: push + analytics + fired month saved', async () => {
    h.cfg = { spend_alert_enabled: true, spend_alert_usd: 5 };
    const pushes: unknown[] = [];
    onSpendAlert((e) => pushes.push(e));
    await recordLlmUsage({ provider: 'anthropic', model: 'claude-sonnet-4-5', usage: big });
    await recordLlmUsage({ provider: 'anthropic', model: 'claude-sonnet-4-5', usage: big });
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ limitUsd: 5 });
    expect(h.captured).toEqual([{ event: 'spend_alert_fired', props: { limit_usd: 5, provider_kind: 'own_key' } }]);
    expect(typeof h.cfg.spend_alert_fired_month).toBe('string');
  });

  it('off: never fires; ChatGPT plan replies never count as spend', async () => {
    const pushes: unknown[] = [];
    onSpendAlert((e) => pushes.push(e));
    await recordLlmUsage({ provider: 'anthropic', model: 'claude-sonnet-4-5', usage: big });
    h.cfg = { spend_alert_enabled: true, spend_alert_usd: 5 };
    await recordLlmUsage({ provider: 'chatgpt', model: 'gpt-5-mini', usage: big });
    expect(pushes).toEqual([]);
    expect(h.captured).toEqual([]);
  });
});
